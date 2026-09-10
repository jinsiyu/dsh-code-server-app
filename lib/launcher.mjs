/**
 * lib/launcher.mjs — VS Code server 的最小启动器(取代 code-server 的 out/node/** 服务层)。
 *
 * 它在**子进程**里加载 <tree>/lib/vscode/out/server-main.js,自建 node:http 把请求交给
 * VS Code 的 handleRequest/handleUpgrade,并补齐 code-server 原先负责的少量 HTTP 面:
 *   /healthz           就绪探针(host 轮询;也回传最近一次 upgrade 路径,便于排障)
 *   /manifest.json     PWA manifest(VS Code server 不提供)
 *   /_static/*         浏览器静态资源(favicon / PWA 图标 / serviceWorker.js)
 *   /proxy/:port/…     转发端口 HTTP 代理(Ports 面板;WS 版仅在 loopback 模式可用)
 *
 * 为什么是独立进程:VS Code 的 server 会改进程全局(win32 下 import 即 chdir、覆盖
 * Error.stackTraceLimit、注册 SIGPIPE、patch Module._resolveLookupPaths、多处 process.exit),
 * 且 node-pty/sqlite 崩溃时必须只带走 IDE,不能带走 DSH host。
 *
 * 用法(由 lib/index.js 调用,不面向用户):
 *   node lib/launcher.mjs --tree <VS Code 树根> --user-data-dir <dir> --extensions-dir <dir> \
 *        (--port <n> [--host 127.0.0.1] | --pipe <\\.\pipe\name|unix socket>) \
 *        [--parent-pid <pid>] [--locale zh-cn]
 *
 * 就绪信号:stdout 打印 `dshcs-ready <productPath> <mode> <addr>`。
 */

import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { connect } from 'node:net';
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
    parentPid: null,
    locale: null,
    disableProxy: false,
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

// ---------------------------------------------------------------- HTTP / WS 分发

const server = createHttpServer((req, res) => {
  const url = req.url ?? '/';
  if (url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({
      ok: true,
      productPath,
      pid: process.pid,
      mode: args.pipe === null ? 'tcp' : 'pipe',
      recentUpgrades: recentUpgrades.slice(-3),
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
