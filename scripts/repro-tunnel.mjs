// .spike/phase1/repro-tunnel.mjs —— 本地复现:直接跑**已部署的** launcher + 我们自己的 shim,
// 不经过桌面应用、不需要重启。用来定位"101 出去了、客户端握手也发了、服务端却不回"的问题。
//
// 结构:
//   [本脚本] --spawn--> launcher(profile 里那份,真 VS Code 树,真 ws 服务端)
//      |  POST /__dshcs/tunnel(token + 握手元数据)  ← 相当于 host 的 lib/pipe-tunnel.mjs
//      |  请求体 = 客户端 → 服务端字节;响应体 = 服务端 → 客户端字节
//   [src/pipe-ws.js 在 vm 里] --postMessage 桩--> 上面那条 POST
//
// 用法:node .spike/phase1/repro-tunnel.mjs [--keep]
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

const PROFILE = join(homedir(), '.dsh', 'profiles', 'desktop');
const PLUGIN = join(PROFILE, 'node_modules', 'dsh-code-server-app');
const TREE = join(PROFILE, 'node_modules', '@jinsiyu', 'dshcs-vscode-server', 'vscode');
const TOKEN = 'REPRO-' + randomBytes(8).toString('hex');
const PORT = 18090 + Math.floor(Math.random() * 200);
const TMP = join(process.env.TEMP ?? '.', 'dshcs-repro-' + randomBytes(4).toString('hex'));
const TUNNEL_LOG = join(TMP, 'tunnel.log');
const PAGE_LOG = join(TMP, 'page.log');
const KEEP = process.argv.includes('--keep');
// 默认跑 profile 里部署的那份;DSHCS_REPRO_PLUGIN=<插件目录> 可直接跑工作区副本(快速迭代)
const REPRO_PLUGIN = process.env.DSHCS_REPRO_PLUGIN ?? null;

const l = (...a) => console.log('[repro]', ...a);
function readLog() {
  try { return readFileSync(TUNNEL_LOG, 'utf8').trim().split('\n'); } catch { return []; }
}

if (!existsSync(TREE)) { console.error('找不到 VS Code 树:', TREE); process.exit(1); }
mkdirSync(TMP, { recursive: true });
const product = JSON.parse(readFileSync(join(TREE, 'lib', 'vscode', 'product.json'), 'utf8'));
const productPath = `${product.quality ?? 'oss'}-${product.commit ?? 'dev'}`;

// ---------- 1) 起 launcher ----------
const child = spawn(process.execPath, [
  join(REPRO_PLUGIN ?? PLUGIN, 'lib', 'launcher.mjs'),
  '--tree', TREE,
  '--user-data-dir', join(TMP, 'user-data'),
  '--extensions-dir', join(TMP, 'extensions'),
  '--port', String(PORT),
  '--parent-pid', String(process.pid),
  '--locale', 'en',
], {
  // 沙箱下管道 spawn 会 EPERM,所以输出直接重定向到文件(不是管道)
  stdio: ['ignore', openSync(join(TMP, 'launcher.out.log'), 'a'), openSync(join(TMP, 'launcher.err.log'), 'a')],
  env: { ...process.env, DSHCS_TUNNEL_TOKEN: TOKEN, DSHCS_TUNNEL_LOG: TUNNEL_LOG, DSHCS_PAGE_LOG: PAGE_LOG, DSHCS_HTML_TAG: 'repro' },
});
l('launcher pid=', child.pid, 'port=', PORT, 'productPath=', productPath);
function tail(name, lines = 20) {
  try { return readFileSync(join(TMP, name), 'utf8').trim().split('\n').slice(-lines); } catch { return []; }
}

function stop() {
  try { child.kill('SIGKILL'); } catch { /* ignore */ }
  if (!KEEP) { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } }
  else l('保留临时目录:', TMP);
}

async function waitHealth(timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    const ok = await new Promise((resolve) => {
      const req = request({ host: '127.0.0.1', port: PORT, path: '/healthz', method: 'GET', timeout: 1500 }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve(body.includes('"ok":true') ? body : false));
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    });
    if (ok !== false) return ok;
    if (Date.now() - t0 > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
}

function httpGet(path, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: PORT, path, method: 'GET', timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout ' + path)); });
    req.end();
  });
}
const health = await waitHealth(60000);
if (health === false) {
  console.error('launcher 未就绪(60s)');
  l('--- launcher stdout ---');
  for (const line of tail('launcher.out.log')) l('  ' + line);
  l('--- launcher stderr ---');
  for (const line of tail('launcher.err.log')) l('  ' + line);
  l('tunnel.log:', readLog());
  stop();
  process.exit(1);
}
l('healthz ok');
// ---------- 0) serve 时注入是否生效(磁盘补丁撤掉后应仍能看到注入)===
const healthRaw = await httpGet('/healthz');
l('healthz: ' + healthRaw.body.toString('utf8').trim());
const htmlRes = await httpGet('/');
const htmlText = htmlRes.body.toString('utf8');
l('HTML: status=' + htmlRes.status + ' 诊断脚本=' + htmlText.includes('__dshcs/report') + ' ?v=' + htmlText.includes('?v='));
const scriptMatch = /src="([^"]*workbench\.js[^"]*)"/.exec(htmlText);
let jsPath = scriptMatch === null ? `/${productPath}/static/out/vs/code/browser/workbench/workbench.js` : scriptMatch[1];
if (!jsPath.startsWith('/')) jsPath = '/' + jsPath; // HTML 里是相对路径,http.request 需要绝对路径
const jsRes = await httpGet(jsPath);
const jsText = jsRes.body.toString('utf8');
l('workbench.js: status=' + jsRes.status + ' bytes=' + jsRes.body.length + ' 注入=' + jsText.includes('webSocketFactory:globalThis.__DSH_WS_FACTORY__}') + ' 哨兵=' + jsText.includes('__DSHCS_PIPE_WS__'));
l(jsText.includes('webSocketFactory:globalThis.__DSH_WS_FACTORY__}') ? '✓ serve 时注入生效' : '✗ serve 时注入未生效');


// ---------- 2) 把 src/pipe-ws.js 当作客户端跑起来,parent 侧桥接到隧道 POST ----------
const shimSource = readFileSync(new URL('../src/pipe-ws.js', import.meta.url), 'utf8');
const listenersA = new Set(); // iframe(shim)
const listenersB = new Set(); // parent(本脚本)
const iframeWindow = {
  addEventListener: (t, fn) => { if (t === 'message') listenersA.add(fn); },
  removeEventListener: (t, fn) => { if (t === 'message') listenersA.delete(fn); },
  postMessage: (m) => { for (const fn of listenersA) fn({ data: m }); },
};
const parentWindow = {
  addEventListener: (t, fn) => { if (t === 'message') listenersB.add(fn); },
  removeEventListener: (t, fn) => { if (t === 'message') listenersB.delete(fn); },
  postMessage: (m) => { for (const fn of listenersB) fn({ data: m }); },
};
iframeWindow.parent = parentWindow;
const context = vm.createContext({
  window: iframeWindow, parent: parentWindow,
  crypto: globalThis.crypto,
  URL, URLSearchParams, atob: globalThis.atob, btoa: globalThis.btoa,
  location: { href: 'http://127.0.0.1:' + PORT + '/?repro=1', host: '127.0.0.1', origin: 'http://127.0.0.1:' + PORT, protocol: 'http:' },
  performance: globalThis.performance,
  TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, DataView, Promise, console, setTimeout, clearTimeout,
  queueMicrotask, structuredClone,
});
vm.runInContext(shimSource, context);

const stats = { in: 0, out: 0, chunks: [], error: null, opened: false, closed: null, tunnelStatus: null };
let upstream = null;
let responseBytes = 0;

parentWindow.addEventListener('message', (event) => {
  const data = event.data;
  if (data === null || typeof data !== 'object' || data.__dshcs !== 1) return;
  if (data.kind === 'open') {
    l('shim → open:', data.path);
    upstream = request({
      host: '127.0.0.1', port: PORT, path: '/__dshcs/tunnel', method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-dshcs-tunnel-token': TOKEN,
        'x-dshcs-ws-path': data.path,
        'x-dshcs-ws-key': data.key,
        'x-dshcs-ws-version': data.version ?? '13',
      },
    }, (res) => {
      stats.tunnelStatus = res.statusCode;
      l('tunnel response status=', res.statusCode);
      res.on('data', (chunk) => {
        responseBytes += chunk.length;
        if (stats.chunks.length < 6) {
          stats.chunks.push({ n: chunk.length, head: chunk.subarray(0, 8).toString('hex') });
          l(`server→client #${stats.chunks.length} n=${chunk.length} full=${chunk.subarray(0, 64).toString('hex')}`);
        }
        const buf = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
        iframeWindow.postMessage({ __dshcs: 1, kind: 'data', id: data.id, buf });
      });
      res.on('end', () => { l('tunnel response ended, total bytes=', responseBytes); iframeWindow.postMessage({ __dshcs: 1, kind: 'closed', id: data.id }); });
    });
    upstream.on('error', (e) => { stats.error = e.message; l('upstream error:', e.message); });
    upstream.flushHeaders(); // 与 pipe-tunnel 一致
    return;
  }
  if (data.kind === 'frame' && upstream !== null) { stats.out += data.buf.byteLength; upstream.write(Buffer.from(data.buf)); return; }
  if (data.kind === 'close') { l('shim → close'); upstream?.end(); }
});

const socket = context.__DSH_WS_FACTORY__.create(`ws://127.0.0.1:${PORT}/${productPath}?reconnectionToken=repro&reconnection=false&skipWebSocketFrames=false`, 'repro');
socket.onData((buf) => { stats.in += buf.byteLength; });
socket.onOpen(() => { stats.opened = true; l('shim onOpen ✓'); });
socket.onError((e) => { stats.error = String(e && e.message ? e.message : e); l('shim onError:', stats.error); });
socket.onClose((e) => { stats.closed = e; l('shim onClose:', JSON.stringify(e)); });

await new Promise((r) => setTimeout(r, 2500));
l('--- 握手后状态:', JSON.stringify({ opened: stats.opened, tunnelStatus: stats.tunnelStatus, inBytes: stats.in, outBytes: stats.out, responseBytes, error: stats.error }));

// ---------- 3) 发一条二进制消息,看服务端是否处理入方向 ----------
if (stats.opened) {
  l('发送 110 字节二进制帧(模拟客户端协议握手)…');
  const before = responseBytes;
  socket.send(new Uint8Array(110).fill(7).buffer);
  await new Promise((r) => setTimeout(r, 3000));
  l('--- 发送后:服务端新增字节 =', responseBytes - before, '/ 累计 =', responseBytes);
  l('--- 入方向字节 =', stats.in, '(含 101)');
}

l('=== tunnel.log ===');
for (const line of readLog()) l('  ' + line);
l('=== 结论 ===');
l(stats.opened ? '✓ 握手成功(onOpen)' : '✗ 握手失败');
l(responseBytes > 130 ? '✓ 服务端在握手后有回应(入方向被处理)' : '✗ 服务端在握手后一言不发(入方向未被处理)');

stop();
process.exit(stats.opened && responseBytes > 130 ? 0 : 2);
