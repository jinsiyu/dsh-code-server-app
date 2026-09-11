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

import { createServer as createHttpServer, IncomingMessage, request as httpRequest } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { appendFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { connect, createServer as createNetServer } from 'node:net';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
    exthostIpc: process.env.DSHCS_EXTHOST_IPC ?? null,
    parentPid: null,
    locale: null,
    disableProxy: false,
    tunnelToken: process.env.DSHCS_TUNNEL_TOKEN ?? null,
    pageLog: process.env.DSHCS_PAGE_LOG ?? null,
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
    else if (a === '--exthost-ipc') out.exthostIpc = argv[++i];
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
  // 扩展宿主连接方式(默认:句柄传递)。上游 `!isWindows || !args['socket-path']` 决定
  // _canSendSocket:Windows 上一旦给了 socket-path,服务端就**不再**把客户端 socket 句柄
  // 传给扩展宿主(child.send 只认真 TCP socket 句柄,管道句柄会 ENOTSUP),改为自己开一个
  // 内部命名管道、让扩展宿主连进来,再由服务端双向泵字节(_listenOnPipe/_pipeSockets)。
  // 我们不监听 socket-path(VS Code 侧 address=null),只借这个开关换掉交接方式 ——
  // 于是 launcher 自己的监听器可以是命名管道,Windows 上不再需要任何 TCP 端口。
  if (args.exthostIpc !== null) codeArgs['socket-path'] = args.exthostIpc;
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

// ---------------------------------------------------------------- WS 字节隧道(阶段 1)

/** 隧道端点的握手元数据头(与 lib/pipe-tunnel.mjs 保持一致)。 */
const TUNNEL_TOKEN_HEADER = 'x-dshcs-tunnel-token';
const TUNNEL_ROUTE = '/__dshcs/tunnel';
/** 页面诊断上报端点(HTML 里注入的脚本用)。 */
const PAGE_REPORT_ROUTE = '/__dshcs/report';
const TUNNEL_WS_PATH = 'x-dshcs-ws-path';
const TUNNEL_WS_KEY = 'x-dshcs-ws-key';
const TUNNEL_WS_VERSION = 'x-dshcs-ws-version';
const TUNNEL_WS_ORIGIN = 'x-dshcs-ws-origin';
/** 每条隧道一个唯一管道名(避免并发隧道撞名)。 */
let tunnelSeq = 0;

/** 把 HTTP 请求体内的字节当作 WebSocket 字节流喂给 vsServer。
 *  实现在 lib/tunnel-socket.mjs(独立文件便于测试背压语义)。 */

/** 页面侧诊断(阶段 1 排查用):工作台 HTML 里注入的错误上报落这个文件。 */
function pageLog(entry) {
  const file = args.pageLog;
  if (file === null || file === '') return;
  try { appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`); } catch { /* 日志失败不影响功能 */ }
}

/** 注入页面的诊断脚本(与 HTML 现有脚本共用 nonce,否则会被 CSP 拦掉)。 */
function diagnosticsScript(nonce) {
  const attr = nonce === null ? '' : ` nonce="${nonce}"`;
  return `<script${attr}>
(function(){
  function send(entry){
    try{
      var body = JSON.stringify(entry);
      if (navigator.sendBeacon) { navigator.sendBeacon('/__dshcs/report', body); return; }
      fetch('/__dshcs/report', { method: 'POST', body: body, keepalive: true });
    }catch(e){}
  }
  window.addEventListener('error', function(e){
    send({ kind:'error', message:String(e.message||''), source:String(e.filename||''), line:e.lineno||0, col:e.colno||0,
      stack:String(e.error && e.error.stack || ''), href:location.href });
  });
  window.addEventListener('unhandledrejection', function(e){
    var r = e.reason;
    send({ kind:'rejection', message:String(r && r.message || r || ''), stack:String(r && r.stack || ''), href:location.href });
  });
  send({ kind:'boot', message:'workbench html loaded', factory: typeof globalThis.__DSH_WS_FACTORY__,
    href:location.href, ua:navigator.userAgent });
})();
</script>`;
}

/**
 * 改写工作台 HTML:
 *  1. 注入诊断脚本(抓页面内错误 → /__dshcs/report);
 *  2. 给 workbench.js / workbench.css / nls 资源加 `?v=<tag>` 缓存击穿 —— 这些资源是
 *     `cache-control: public, max-age=31536000`,打过 B2 补丁后浏览器永远拿旧的。
 */
function rewriteWorkbenchHtml(html) {
  const nonceMatch = /nonce="([^"]+)"/.exec(html);
  const nonce = nonceMatch === null ? null : nonceMatch[1];
  const tag = args.htmlTag !== null && args.htmlTag !== '' ? args.htmlTag : `t${Date.now()}`;
  let out = html.replace(/([^"'=]*\/workbench\.(?:js|css))"/g, `$1?v=${tag}"`);
  out = out.replace(/([^"'=]*\/nls\.messages\.js)"/g, `$1?v=${tag}"`);
  const headIdx = out.indexOf('<head>');
  const script = diagnosticsScript(nonce);
  out = headIdx >= 0 ? `${out.slice(0, headIdx + 6)}\n${script}${out.slice(headIdx + 6)}` : `${script}${out}`;
  return out;
}

/** GET / 的响应缓冲改写:
 *  - html:注入诊断脚本 + 资源 `?v=` 缓存击穿(HTML 很小,缓冲不心疼);
 *  - js:serve 时给工作台 bundle 注入 webSocketFactory(B2 补丁的替代,见 README)。
 *  两种都会去掉 content-length/content-encoding 并改成 no-store。 */
function interceptResponse(res, kind) {
  const chunks = [];
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);
  const originalWriteHead = res.writeHead.bind(res);
  let status = 200;
  let headers = {};
  res.writeHead = (code, reason, hdrs) => {
    status = code;
    const extra = typeof reason === 'object' && reason !== null ? reason : hdrs;
    if (typeof reason === 'string') headers = hdrs ?? {};
    else headers = extra ?? {};
    return res;
  };
  res.write = (chunk, encoding, callback) => {
    if (chunk !== undefined && chunk !== null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8'));
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
    // 不再压缩:我们要就地改字节(请求侧已删掉 accept-encoding,正常不会走到这里)
    const encodingHeader = String(clean['content-encoding'] ?? clean['Content-Encoding'] ?? '').toLowerCase();
    if (encodingHeader.includes('gzip')) {
      try { body = gunzipSync(body); } catch { /* 原样透传 */ }
    }
    const text = body.toString('utf8');
    if (kind === 'html') {
      body = Buffer.from(rewriteWorkbenchHtml(text), 'utf8');
    } else {
      const injected = injectWebSocketFactory(text);
      if (injected !== null) body = Buffer.from(injected, 'utf8');
    }
    delete clean['content-length'];
    delete clean['Content-Length'];
    delete clean['content-encoding'];
    delete clean['Content-Encoding'];
    clean['content-length'] = String(body.length);
    // 工作台 HTML 必须每次现取(它的资源引用带 ?v=);JS 也一并 no-store,避免注入版被缓存住
    clean['cache-control'] = 'no-store';
    clean['Cache-Control'] = 'no-store';
    originalWriteHead(status, clean);
    return originalEnd(body);
  };
  return originalWrite;
}

/** B2 补丁的 serve 时版本:包首插入裸字节 shim + 给入口 options 补 webSocketFactory。
 *  返回 null 表示不需要/不能注入(已打过磁盘补丁、缺 shim、标记命中数不是 1)。 */
function injectWebSocketFactory(text) {
  if (text.includes(PATCH_SENTINEL) || text.includes(INJECTED)) return null; // 磁盘上已打过补丁
  if (PIPE_SHIM === null) {
    warnOnce('shim-missing', 'lib/pipe-ws.js 不存在:跳过 webSocketFactory 注入(隧道将不可用)');
    return null;
  }
  const hits = text.split(INJECT_MARKER).length - 1;
  if (hits !== 1) {
    warnOnce('marker', `工作台 bundle 的注入标记命中 ${hits} 次(期望 1):跳过注入,IDE 将回退 loopback WS`);
    return null;
  }
  shimInjections += 1;
  return `${PATCH_SENTINEL}\n${PIPE_SHIM}\n${text.split(INJECT_MARKER).join(INJECTED)}`;
}


const TUNNEL_LOG = process.env.DSHCS_TUNNEL_LOG ?? null;
function tunnelLog(line) {
  if (TUNNEL_LOG === null || TUNNEL_LOG === '') return;
  try { appendFileSync(TUNNEL_LOG, `${new Date().toISOString()} ${line}\n`); } catch { /* 日志失败不影响功能 */ }
}

// ------------------------------------------------ 工作台 bundle 的 serve 时注入(B2 的替代)

/** 注入口的标记:入口 IIFE 里构造 options 的那一处。 */
const INJECT_MARKER = 'remoteAuthority:location.host}';
const INJECTED = 'remoteAuthority:location.host,webSocketFactory:globalThis.__DSH_WS_FACTORY__}';
/** 已注入的哨兵(磁盘补丁与 serve 时注入共用)。 */
const PATCH_SENTINEL = '/*__DSHCS_PIPE_WS__*/';
/** 裸字节 shim 源:随包发布为 lib/pipe-ws.js;开发树里回退到 ../src/pipe-ws.js。 */
const PIPE_SHIM = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, 'pipe-ws.js'), join(here, '..', 'src', 'pipe-ws.js')]) {
    try {
      return readFileSync(candidate, 'utf8');
    } catch { /* 试下一个 */ }
  }
  return null;
})();
/** 只有"客户端走 DSH 隧道"那一侧才注入裸字节 shim(host 用 DSHCS_TUNNEL_MODE 告知)。
 *  web 侧客户端是普通浏览器页面,必须保留原生 WebSocket —— 注入 shim 会让它去找不存在的父窗口中继。 */
const TUNNEL_MODE = process.env.DSHCS_TUNNEL_MODE === '1';
/** 需要 serve 时注入:隧道模式 且 磁盘 bundle 还没打过补丁(避免每次加载都改 19 MB)。 */
const WORKBENCH_BUNDLE_SUFFIX = '/out/vs/code/browser/workbench/workbench.js';
const WORKBENCH_BUNDLE_FILE = join(tree, 'lib', 'vscode', 'out', 'vs', 'code', 'browser', 'workbench', 'workbench.js');
const NEEDS_SERVE_INJECTION = TUNNEL_MODE && (() => {
  try {
    return !readFileSync(WORKBENCH_BUNDLE_FILE, 'utf8').includes(PATCH_SENTINEL);
  } catch {
    return true; // 读不到就按需要注入处理(注入函数自己会做标记断言)
  }
})();
let shimInjections = 0;
const warned = new Set();
function warnOnce(key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[dshcs-launcher] ${message}`);
}

/** `POST /__dshcs/tunnel`:一条 POST 承载一条 IDE 连接的两个方向。
 *
 *  实现方式:把隧道字节**代理到 IDE 自己的监听 socket**(loopback TCP,端口只有本机知道)。
 *  为什么不自己造 socket:VS Code 会把连接的 socket 句柄通过 IPC `child.send(msg, handle)`
 *  交给扩展宿主进程,而 Windows 上**只有 TCP socket 句柄可发**:
 *    - 自造 Duplex           → ERR_INVALID_HANDLE_TYPE
 *    - 命名管道真实 socket   → write ENOTSUP(uv_write2 不支持管道句柄)
 *    - 监听器 accept 的 TCP socket → 正常(这也是 VS Code 原生 loopback 模式的形态)
 *  症状都是"扩展宿主反复终止、所有扩展不激活"(远程主机在 5 分钟内意外终止).
 *
 *  于是这里只做两件事:把 HTTP upgrade 请求写进上游连接,然后双向搬字节。
 *  客户端那一侧完全看不到这个端口 —— 它只面对 DSH 的 /api 隧道。
 */
function handleTunnel(req, res, url) {
  const token = args.tunnelToken;
  const presented = req.headers[TUNNEL_TOKEN_HEADER];
  if (typeof token !== 'string' || token === '' || presented !== token) {
    log('拒绝隧道请求:token 不匹配');
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('forbidden');
    return;
  }
  const wsPath = req.headers[TUNNEL_WS_PATH];
  const wsKey = req.headers[TUNNEL_WS_KEY];
  if (typeof wsPath !== 'string' || wsPath === '' || typeof wsKey !== 'string' || wsKey === '') {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('missing websocket handshake parameters');
    return;
  }

  // 隧道里唯一的客户端是我们自己的裸字节 shim(不做 VS Code 的 deflate 帧层),
  // 所以强制 skipWebSocketFrames=true(服务端据此把连接当纯字节流)。
  // 另外:阶段 2 起文档来自镜像(index.html),而工作台用 `location.pathname + '/' + productPath`
  // 拼 WS 地址,于是路径里被塞进了镜像前缀(实测 /api/code-server/asset/index.html/stable-…)。
  // IDE 目前按后缀容忍,但这里把它剥回 `/stable-…`,让上游看到它期望的形状。
  const stripped = String(wsPath).replace(/^\/api\/code-server\/asset\/[^?]*?(?=\/stable-)/, '');
  const normalizedWsPath = /[?&]skipWebSocketFrames=/.test(stripped)
    ? stripped.replace(/skipWebSocketFrames=(?:true|false)/, 'skipWebSocketFrames=true')
    : `${stripped}${stripped.includes('?') ? '&' : '?'}skipWebSocketFrames=true`;

  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'cache-control': 'no-store',
    'x-dshcs-tunnel': 'open',
  });
  res.flushHeaders?.();

  let closed = false;
  let bodyBytes = 0;
  let sentBytes = 0;
  let outWrites = 0;
  let inChunks = 0;

  const upstream = args.pipe === null
    ? connect({ host: args.host, port: args.port })
    : connect(args.pipe);

  const finish = (reason) => {
    if (closed) return;
    closed = true;
    tunnelLog(`close reason=${reason} in=${bodyBytes} out=${sentBytes}`);
    log(`隧道结束(${reason})`);
    try { if (!res.writableEnded) res.end(); } catch { /* ignore */ }
    try { upstream.destroy(); } catch { /* ignore */ }
  };

  upstream.on('error', (error) => {
    log(`隧道上游出错:${error && error.message ? error.message : error}`);
    finish('upstream error');
  });
  upstream.on('end', () => finish('upstream ended'));
  upstream.on('connect', () => {
    // 自建 upgrade 请求(与浏览器 WebSocket 客户端发出的等价),交给 IDE 的监听器解析。
    // exthost=socket 时它 accept 出来的是真 TCP socket(句柄可传给扩展宿主);
    // exthost=pipe 时句柄交接已被 socket-path 关掉,服务端改用内部管道泵字节,任意监听器都行。
    upstream.write([
      `GET ${normalizedWsPath} HTTP/1.1`,
      `Host: ${args.pipe === null ? `${args.host}:${args.port}` : 'localhost'}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      `Sec-WebSocket-Key: ${String(wsKey)}`,
      `Sec-WebSocket-Version: ${String(req.headers[TUNNEL_WS_VERSION] ?? '13')}`,
      '', '',
    ].join('\r\n'));
    tunnelLog(`open path=${String(wsPath)} key=${String(wsKey).slice(0, 8)}…`);
  });

  // 上游(IDE 监听器)→ 隧道响应体(带背压)
  upstream.on('data', (chunk) => {
    if (sentBytes === 0) tunnelLog(`first-bytes-out n=${chunk.length}`);
    if (outWrites < 12) { outWrites += 1; tunnelLog(`out#${outWrites} n=${chunk.length} head=${chunk.subarray(0, 4).toString('hex')}`); }
    sentBytes += chunk.length;
    if (!res.write(chunk)) {
      upstream.pause();
      res.once('drain', () => upstream.resume());
    }
  });

  // 隧道请求体 → 上游
  req.on('data', (chunk) => {
    if (bodyBytes === 0) tunnelLog(`first-bytes-in n=${chunk.length}`);
    if (inChunks < 12) { inChunks += 1; tunnelLog(`in#${inChunks} n=${chunk.length} head=${chunk.subarray(0, 4).toString('hex')}`); }
    bodyBytes += chunk.length;
    upstream.write(chunk);
  });
  req.on('end', () => { try { upstream.end(); } catch { /* ignore */ } });
  req.on('aborted', () => finish('request aborted'));
  res.on('close', () => finish('response closed'));
  res.on('error', () => finish('response error'));

  log(`隧道升级:${url} → ${String(wsPath)}`);
}

// ---------------------------------------------------------------- HTTP / WS 分发

const server = createHttpServer((req, res) => {
  const url = req.url ?? '/';
  if (url === TUNNEL_ROUTE || url.startsWith(`${TUNNEL_ROUTE}?`)) {
    handleTunnel(req, res, url);
    return;
  }
  if (url === PAGE_REPORT_ROUTE) {
    let body = '';
    req.on('data', (chunk) => { if (body.length < 65536) body += chunk.toString('utf8'); });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch { parsed = { kind: 'unparsable', raw: body.slice(0, 500) }; }
      pageLog(typeof parsed === 'object' && parsed !== null ? parsed : { kind: 'unparsable', raw: body.slice(0, 500) });
      res.writeHead(204, { 'cache-control': 'no-store' });
      res.end();
    });
    return;
  }
  if (url === '/' || url === '/index.html') {
    // 工作台 HTML:缓冲改写(注入诊断脚本 + 资源缓存击穿)
    delete req.headers['accept-encoding']; // 要就地改字节,让上游发未压缩的
    interceptResponse(res, 'html');
    Promise.resolve(vsServer.handleRequest(req, res)).catch((error) => {
      log(`handleRequest(html) failed: ${error && error.stack ? error.stack : error}`);
      try { res.end(); } catch { /* ignore */ }
    });
    return;
  }
  if (NEEDS_SERVE_INJECTION && url.split('?')[0].endsWith(WORKBENCH_BUNDLE_SUFFIX)) {
    // 工作台 bundle:磁盘上没打过补丁时,serve 时注入 webSocketFactory(不再动 pnpm 硬链接树)
    delete req.headers['accept-encoding'];
    interceptResponse(res, 'js');
    Promise.resolve(vsServer.handleRequest(req, res)).catch((error) => {
      log(`handleRequest(workbench.js) failed: ${error && error.stack ? error.stack : error}`);
      try { res.end(); } catch { /* ignore */ }
    });
    return;
  }
  if (url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({
      ok: true,
      productPath,
      pid: process.pid,
      mode: args.pipe === null ? 'tcp' : 'pipe',
      exthost: args.exthostIpc === null ? 'socket' : 'pipe',
      listen: typeof server.address() === 'string' ? server.address() : null,
      recentUpgrades: recentUpgrades.slice(-3),
      tunnelMode: TUNNEL_MODE,
      serveInjection: NEEDS_SERVE_INJECTION,
      shimInjections,
      shimBytes: PIPE_SHIM === null ? 0 : Buffer.byteLength(PIPE_SHIM, 'utf8'),
    }));
    return;
  }
  if (url === '/manifest.json') {
    res.writeHead(200, { 'content-type': 'application/manifest+json; charset=utf-8' });
    res.end(manifestBody());
    return;
  }
  if (url.startsWith('/_static/')) { serveTreeStatic(url, res); return; }
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
