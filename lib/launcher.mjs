/**
 * lib/launcher.mjs — VS Code server 的最小启动器(取代 code-server 的 out/node/** 服务层)。
 *
 * 在**子进程**里加载 <tree>/lib/vscode/out/server-main.js,自建 node:http 把请求交给 VS Code 的
 * handleRequest/handleUpgrade,并补齐 code-server 原先负责的少量 HTTP 面:/healthz(就绪探针)、
 * /manifest.json(PWA)、/_static/*(favicon/PWA/serviceWorker)、/proxy/:port/…(端口转发)。
 *
 * 为什么独立进程:VS Code server 会改进程全局(win32 下 import 即 chdir、注册 SIGPIPE、patch
 * Module 解析、多处 process.exit),且 node-pty/sqlite 崩溃时必须只带走 IDE、不能带走 DSH host。
 *
 * 用法(由 lib/index.js 调用):node lib/launcher.mjs --tree <树根> --user-data-dir <dir>
 *   --extensions-dir <dir> (--port <n> [--host 127.0.0.1] | --pipe <name>) [--parent-pid <pid>] [--locale zh-cn]
 * 就绪信号:stdout 打印 `dshcs-ready <productPath> <mode> <addr>`。
 */

import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..');

// ---------------------------------------------------------------- 参数

function parseArgs(argv) {
  const out = {
    tree: process.env.DSHCS_VS_ROOT ?? null,
    userDataDir: null,
    extensionsDir: null,
    host: '127.0.0.1',
    port: null,
    pipe: null,
    parentPid: null,
    locale: null,
    disableProxy: false,
    /** ?v= 缓存击穿标记(host 传 DSHCS_HTML_TAG;为空则每次启动生成一个)。 */
    htmlTag: process.env.DSHCS_HTML_TAG ?? null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--tree') out.tree = argv[++i];
    else if (a === '--user-data-dir') out.userDataDir = argv[++i];
    else if (a === '--extensions-dir') out.extensionsDir = argv[++i];
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--pipe') out.pipe = argv[++i];
    else if (a === '--parent-pid') out.parentPid = Number(argv[++i]);
    else if (a === '--locale') out.locale = argv[++i];
    else if (a === '--disable-proxy') out.disableProxy = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const log = (...parts) => console.log('[dshcs-launcher]', ...parts);
const fail = (message) => { console.error('[dshcs-launcher] FATAL', message); process.exit(2); };

if (args.tree === null) fail('缺少 --tree(或环境变量 DSHCS_VS_ROOT)');
const tree = resolve(args.tree);
const serverMain = join(tree, 'lib', 'vscode', 'out', 'server-main.js');
if (!existsSync(serverMain)) fail(`不是一棵 VS Code 树(缺少 ${serverMain})`);
if (args.pipe === null && !Number.isFinite(args.port)) fail('必须给 --port 或 --pipe');

const userDataDir = resolve(args.userDataDir ?? join(PACKAGE_ROOT, '.dshcs-data', 'user-data'));
const extensionsDir = resolve(args.extensionsDir ?? join(userDataDir, '..', 'extensions'));
mkdirSync(userDataDir, { recursive: true });
mkdirSync(extensionsDir, { recursive: true });

const product = (() => {
  try { return JSON.parse(readFileSync(join(tree, 'lib', 'vscode', 'product.json'), 'utf8')); } catch { return {}; }
})();
const productPath = `${product.quality ?? 'oss'}-${product.commit ?? 'dev'}`;

// ---------------------------------------------------------------- 进程护栏(必须 import 前)

process.env.CODE_SERVER_PARENT_PID ??= String(process.pid);
process.env.VSCODE_HANDLES_SIGPIPE ??= '1';
process.env.VSCODE_CWD ??= process.cwd();

let vsServer = null;
const recentUpgrades = [];

async function loadVscodeServer() {
  const cwdBefore = process.cwd();
  const mod = await import(pathToFileURL(serverMain).href);
  // win32 下 server-main 顶层 DB() 会 chdir 到 dirname(process.execPath),立即复位
  try { if (process.cwd() !== cwdBefore) process.chdir(cwdBefore); } catch { /* ignore */ }
  const serverModule = await mod.loadCodeWithNls();
  const codeArgs = {
    auth: 'none',
    'user-data-dir': userDataDir,
    'extensions-dir': extensionsDir,
    'accept-server-license-terms': true,
    compatibility: '1.64',
    'without-connection-token': true,
    'disable-telemetry': true,
    'disable-update-check': true,
    _: [],
  };
  if (args.locale !== null) codeArgs.locale = args.locale;
  return serverModule.createServer(null, codeArgs);
}

// ---------------------------------------------------------------- 静态资源(/_static/*)

const MIME = {
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function serveTreeStatic(urlPath, res) {
  const rel = decodeURIComponent(urlPath.replace(/^\/_static\/?/, ''));
  const full = normalize(join(tree, rel));
  if (full !== tree && !full.startsWith(tree + sep)) { res.writeHead(403); res.end('forbidden'); return; }
  let stat;
  try { stat = statSync(full); } catch { res.writeHead(404); res.end(); return; }
  if (!stat.isFile()) { res.writeHead(404); res.end(); return; }
  const headers = {
    'content-type': MIME[extname(full).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': 'public, max-age=3600',
  };
  if (full.endsWith('serviceWorker.js')) headers['service-worker-allowed'] = '/';
  res.writeHead(200, headers);
  createReadStream(full).pipe(res);
}

function manifestBody() {
  return JSON.stringify({
    name: product.nameShort ?? 'code-server',
    short_name: product.nameShort ?? 'code-server',
    start_url: '.',
    display: 'fullscreen',
    display_override: ['window-controls-overlay'],
    description: 'Run Code on a remote server.',
    icons: [192, 512].flatMap((size) => ([
      { src: `./_static/src/browser/media/pwa-icon-${size}.png`, type: 'image/png', sizes: `${size}x${size}`, purpose: 'any' },
      { src: `./_static/src/browser/media/pwa-icon-maskable-${size}.png`, type: 'image/png', sizes: `${size}x${size}`, purpose: 'maskable' },
    ])),
  }, null, 2);
}

// ---------------------------------------------------------------- 转发端口代理(/proxy/:port、/absproxy/:port)

const PROXY_RE = /^\/(abs)?proxy\/(\d{1,5})(\/.*)?$/;

function proxyTarget(url) {
  const m = PROXY_RE.exec(new URL(url, 'http://x').pathname);
  if (m === null) return null;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const rest = m[3] ?? '/';
  const search = new URL(url, 'http://x').search;
  return { port, path: m[1] === 'abs' ? `${rest}${search}` : `${rest}${search}` };
}

function handleProxy(req, res, target) {
  const upstream = httpRequest({
    host: '127.0.0.1',
    port: target.port,
    method: req.method,
    path: target.path,
    headers: stripHopHeaders(req.headers),
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  upstream.on('error', (error) => {
    log(`proxy ${target.port} failed: ${error.message}`);
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`proxy error: ${error.message}`);
  });
  req.pipe(upstream);
}

function stripHopHeaders(headers) {
  const out = { ...headers };
  delete out.connection;
  delete out['proxy-connection'];
  return out;
}

function handleProxyUpgrade(req, socket, head, target) {
  const upstream = connect({ host: '127.0.0.1', port: target.port }, () => {
    const lines = [`GET ${target.path} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', (error) => { log(`proxy ws ${target.port} failed: ${error.message}`); socket.destroy(); });
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
}

// ---------------------------------------------------------------- 跨源防护(等价 code-server 的 ensureOrigin)

/** 取请求 Host:优先 `Forwarded: host=`、其次 `X-Forwarded-Host`(取第一个)、最后 `Host`。
 *  trim + 小写,与 code-server 的 getHost() 同语义(反向代理未透传 Host 时返回 undefined)。 */
function getHostHeader(req) {
  const first = (name) => {
    const value = req.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const forwarded = first('forwarded');
  if (forwarded !== undefined && forwarded !== '') {
    for (const part of forwarded.split(/[;,]/)) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      const key = part.slice(0, eq).trim().toLowerCase();
      const value = part.slice(eq + 1).trim();
      if (key === 'host' && value !== '') return value.toLowerCase();
    }
  }
  const xHost = first('x-forwarded-host');
  if (xHost !== undefined && xHost !== '') {
    const head = xHost.split(',')[0];
    if (head !== undefined && head.trim() !== '') return head.trim().toLowerCase();
  }
  const host = first('host');
  return host !== undefined && host !== '' ? host.trim().toLowerCase() : undefined;
}

/** code-server `authenticateOrigin()` 的等价物:带 Origin 的请求(浏览器)其 host 必须等于 Host;
 *  缺 Origin(非浏览器,如本地工具/测试)放行。code-server 另外支持 `--trusted-origins` /
 *  `--proxy-domain` 通配,本插件没有这两个概念,故不实现。
 *  为什么必须有:VS Code 的 handleUpgrade 不校验来源,而 IDE 是 auth=none —— 缺了这道检查,
 *  本机任意浏览器页面都能开 ws://127.0.0.1:<port>/stable-<commit> 直接驱动 IDE。
 *  (dsh 模式下请求来自 DSH 自己的路由并已过 requestRejection,Origin/Host 天然一致。) */
function originAllowed(req) {
  const raw = req.headers.origin;
  const originRaw = Array.isArray(raw) ? raw[0] : raw;
  if (originRaw === undefined || originRaw === '') return true;
  let origin;
  try {
    origin = new URL(originRaw).host.trim().toLowerCase();
  } catch {
    return false;
  }
  if (origin === '') return false;
  const host = getHostHeader(req);
  if (host === undefined) return false;
  return host === origin;
}

// ---------------------------------------------------------------- HTTP / WS 分发

/** 工作台 HTML 的响应改写:给 workbench.js / workbench.css / nls 资源加 `?v=<tag>` 缓存击穿。
 *
 *  为什么必须有:这些资源带 `cache-control: public, max-age=31536000`,而**渲染器的缓存按 URL 走** ——
 *  插件或 VS Code 树升级后沿用同一个 URL,渲染器会继续跑**旧 bundle**(表现为界面/配色行为诡异,
 *  与服务器不一致)。README 里那条"清 Cache/Code Cache/GPUCache"就是它的手工绕法。 */
function rewriteWorkbenchHtml(html) {
  const tag = args.htmlTag !== null && args.htmlTag !== '' ? args.htmlTag : `t${Date.now()}`;
  let out = html.replace(/([^"'=]*\/workbench\.(?:js|css))"/g, `$1?v=${tag}"`);
  out = out.replace(/([^"'=]*\/nls\.messages\.js)"/g, `$1?v=${tag}"`);
  return out;
}

/** 缓冲响应体后改写(GET / 用):去掉 content-length/content-encoding,并改成 no-store。 */
function interceptHtmlResponse(res) {
  const chunks = [];
  const originalEnd = res.end.bind(res);
  const originalWriteHead = res.writeHead.bind(res);
  let status = 200;
  let headers = {};
  res.writeHead = (code, reason, hdrs) => {
    status = code;
    const extra = typeof reason === 'object' && reason !== null ? reason : hdrs;
    headers = typeof reason === 'string' ? (hdrs ?? {}) : (extra ?? {});
    return res;
  };
  res.write = (chunk, encoding, callback) => {
    if (chunk !== undefined && chunk !== null) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8'));
    }
    if (typeof encoding === 'function') encoding();
    else if (typeof callback === 'function') callback();
    return true;
  };
  res.end = (chunk, encoding, callback) => {
    if (chunk !== undefined && chunk !== null && typeof chunk !== 'function') {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8'));
    }
    const clean = { ...(typeof res.getHeaders === 'function' ? res.getHeaders() : {}), ...headers };
    let body = Buffer.concat(chunks);
    // 要就地改字节(请求侧已删掉 accept-encoding,正常不会压缩;压缩了也兜一层)
    const encodingHeader = String(clean['content-encoding'] ?? clean['Content-Encoding'] ?? '').toLowerCase();
    if (encodingHeader.includes('gzip')) {
      try { body = gunzipSync(body); } catch { /* 原样透传 */ }
    }
    if (status === 200) body = Buffer.from(rewriteWorkbenchHtml(body.toString('utf8')), 'utf8');
    for (const name of ['content-length', 'Content-Length', 'content-encoding', 'Content-Encoding']) delete clean[name];
    clean['content-length'] = String(body.length);
    clean['cache-control'] = 'no-store';
    originalWriteHead(status, clean);
    return originalEnd(body);
  };
}

const server = createHttpServer((req, res) => {
  const url = req.url ?? '/';
  // **按路径匹配,别拿整串比**:客户端加载文档时永远带查询串(`?folder=<cwd>`),
  // 用 `url === '/'` 判断会让改写整条失效(0.3.x 就踩过这个坑);`/healthz`、`/manifest.json`
  // 同理要用路径匹配,否则带查询串的探针会掉到 VS Code 那边变成 404。
  const urlPath = url.split('?')[0];
  if (urlPath === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({
      ok: true,
      productPath,
      pid: process.pid,
      mode: args.pipe === null ? 'tcp' : 'pipe',
      htmlTag: args.htmlTag,
      recentUpgrades: recentUpgrades.slice(-3),
    }));
    return;
  }
  if (urlPath === '/manifest.json') {
    res.writeHead(200, { 'content-type': 'application/manifest+json; charset=utf-8' });
    res.end(manifestBody());
    return;
  }
  if (urlPath.startsWith('/_static/')) { serveTreeStatic(urlPath, res); return; }
  if (urlPath === '/' || urlPath === '/index.html') {
    // 工作台 HTML:缓冲改写(只加 ?v= 缓存击穿;不做任何注入)
    delete req.headers['accept-encoding']; // 要就地改字节,让上游发未压缩的
    interceptHtmlResponse(res);
    Promise.resolve(vsServer.handleRequest(req, res)).catch((error) => {
      log(`handleRequest(html) failed: ${error && error.stack ? error.stack : error}`);
      try { res.end(); } catch { /* ignore */ }
    });
    return;
  }
  if (!args.disableProxy) {
    const target = proxyTarget(url);
    if (target !== null) { handleProxy(req, res, target); return; }
  }
  Promise.resolve(vsServer.handleRequest(req, res)).catch((error) => {
    log(`handleRequest failed: ${error && error.stack ? error.stack : error}`);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    if (!res.writableEnded) res.end('internal error');
  });
});

server.on('upgrade', (req, socket, head) => {
  const url = req.url ?? '/';
  recentUpgrades.push(url);
  if (recentUpgrades.length > 10) recentUpgrades.shift();
  // 跨源防护(与 code-server 一致:只卡 upgrade,HTTP 侧 VS Code 仅接受 GET 且状态变更都走 WS)
  if (!originAllowed(req)) {
    log(`拒绝跨源 WebSocket:origin=${req.headers.origin} host=${req.headers.host ?? '-'} url=${url}`);
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  if (!args.disableProxy) {
    const target = proxyTarget(url);
    if (target !== null) { handleProxyUpgrade(req, socket, head, target); return; }
  }
  socket.pause();
  req.ws = socket;
  req.head = head;
  try {
    vsServer.handleUpgrade(req, socket);
  } catch (error) {
    log(`handleUpgrade threw: ${error && error.message ? error.message : error}`);
    socket.destroy();
  }
  socket.resume();
});

// ---------------------------------------------------------------- 生命周期

let shuttingDown = false;
async function shutdown(reason, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutting down (${reason})`);
  try { await vsServer?.dispose?.(); } catch (error) { log(`dispose failed: ${error && error.message}`); }
  const done = () => process.exit(code);
  try { server.close(done); } catch { done(); }
  setTimeout(() => process.exit(code), 3000).unref();
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { void shutdown(sig); });

// 父进程(DSH host)消失 → 自行退出,避免留下孤儿 IDE 进程
if (Number.isFinite(args.parentPid) && args.parentPid > 0) {
  const parentPid = args.parentPid;
  const timer = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch (error) {
      if (error && error.code === 'ESRCH') void shutdown(`parent ${parentPid} gone`);
    }
  }, 5000);
  timer.unref();
}

// ---------------------------------------------------------------- 启动

try {
  vsServer = await loadVscodeServer();
} catch (error) {
  fail(`加载 VS Code server 失败: ${error && error.stack ? error.stack : error}`);
}

const listenTarget = args.pipe === null ? { host: args.host, port: args.port } : args.pipe;
server.on('error', (error) => { fail(`监听失败(${JSON.stringify(listenTarget)}): ${error.message}`); });

server.listen(listenTarget, () => {
  const addr = server.address();
  const shown = typeof addr === 'string' ? addr : `${addr.address}:${addr.port}`;
  log(`listening on ${shown} (tree=${tree})`);
  log(`user-data-dir=${userDataDir} extensions-dir=${extensionsDir}`);
  console.log(`dshcs-ready ${productPath} ${args.pipe === null ? 'tcp' : 'pipe'} ${shown}`);
});

// 兜底:未捕获异常不应静默留下半死进程
process.on('uncaughtException', (error) => {
  console.error('[dshcs-launcher] uncaughtException', error && error.stack ? error.stack : error);
  void shutdown('uncaughtException', 1);
});
