/**
 * src/pipe-relay.js —— 客户端隧道中继(阶段 1,见 docs/plan-noport-desktop-ide.md §4)。
 *
 * 为什么需要它:阶段 1 的工作台文档仍来自 loopback(独立回环端口),而实测证明
 * **自定义 scheme ↔ loopback 之间双向 fetch 都被拒**(2026-09-11:两个方向都 Failed to fetch)。
 * 工作台文档里的 shim(src/pipe-ws.js,由 B2 补丁内联进 workbench bundle)因此不能自己
 * POST 隧道,只能把字节 postMessage 给父窗口(DSH 前端,同源 dsh-app://app),
 * 由父窗口开 `POST /api/code-server/tunnel`(requestBody: streaming)承载整条 WS 连接。
 *
 * 协议(postMessage,父 ↔ 子):
 *   子 → 父  { __dshcs:1, kind:'open',  id, path, key, version }
 *            { __dshcs:1, kind:'frame', id, buf:ArrayBuffer }
 *            { __dshcs:1, kind:'close', id }
 *   父 → 子  { __dshcs:1, kind:'data',  id, buf:ArrayBuffer }
 *            { __dshcs:1, kind:'error', id, message }
 *            { __dshcs:1, kind:'closed',id }
 */

const MARK = 1;
const STATUS_PATH = '/api/code-server/status';
const DIAG_PATH = '/api/code-server/diag';

/** 隧道是否可用(host 是否下发了 token/path)。 */
let tunnelInfo = null;

/** 诊断上报(阶段 1 排查用):任何一步出问题都能在 host 侧文件里看到。 */
export function diag(entry) {
  try {
    void fetch(DIAG_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ at: Date.now(), ...entry }),
      keepalive: true,
    }).catch(() => {});
  } catch { /* 日志失败不影响功能 */ }
}

/** 已建立的隧道:id → { source, controller, closed }。 */
const tunnels = new Map();

let installed = false;

function post(source, message, transfer) {
  try {
    source.postMessage({ __dshcs: MARK, ...message }, '*', transfer ?? []);
  } catch (error) {
    console.warn('[code-server] tunnel postMessage failed:', error && error.message ? error.message : error);
  }
}

/** 取隧道元数据(带缓存;失败返回 null,由调用方上报错误)。 */
async function loadTunnelInfo() {
  if (tunnelInfo !== null && typeof tunnelInfo.token === 'string' && tunnelInfo.token !== '') return tunnelInfo;
  try {
    const response = await fetch(STATUS_PATH, { headers: { accept: 'application/json' } });
    if (!response.ok) return null;
    const body = await response.json();
    const tunnel = body && body.tunnel;
    if (tunnel === undefined || tunnel === null || typeof tunnel.token !== 'string' || tunnel.token === '') return null;
    tunnelInfo = tunnel;
    return tunnelInfo;
  } catch {
    return null;
  }
}

/** 把 Uint8Array 变成可转移的独立 ArrayBuffer(worker/iframe 之间只能转移整块)。 */
function transferable(chunk) {
  if (chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength) return chunk.buffer;
  return chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
}

async function openTunnel(source, message) {
  diag({ kind: 'open-requested', id: message.id, path: String(message.path ?? '') });
  const info = await loadTunnelInfo();
  if (info === null) {
    diag({ kind: 'no-tunnel-info' });
    post(source, { kind: 'error', id: message.id, message: 'tunnel unavailable' });
    return;
  }
  diag({ kind: 'tunnel-info', path: String(info.path ?? ''), hasToken: typeof info.token === 'string' });
  let controller = null;
  const body = new ReadableStream({
    start(next) { controller = next; },
    cancel() { tunnels.delete(message.id); },
  });
  const entry = { source, controller, closed: false, info, delivered: false };
  tunnels.set(message.id, entry);

  // IDE 可能正在启动/重启(实测:工作台加载比 IDE 就绪快,首次隧道会撞上 502/503)。
  // 只要还没把任何字节交给 shim(shim 自己会缓存 pre-open 数据),就可以安全重建请求重试。
  let response = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (entry.closed) { tunnels.delete(message.id); return; }
    const stream = attempt === 0 ? body : new ReadableStream({ start(next) { entry.controller = next; } });
    try {
      // eslint-disable-next-line no-await-in-loop
      const candidate = await fetch(info.path, {
        method: 'POST',
        duplex: 'half',
        body: stream,
        headers: {
          'content-type': 'application/octet-stream',
          [info.header]: info.token,
          'x-dshcs-ws-path': String(message.path ?? '/'),
          'x-dshcs-ws-key': String(message.key ?? ''),
          'x-dshcs-ws-version': String(message.version ?? '13'),
        },
      });
      if (candidate.ok && candidate.body !== null) { response = candidate; break; }
      if (candidate.status !== 502 && candidate.status !== 503) {
        tunnels.delete(message.id);
        let detail = '';
        try { detail = (await candidate.text()).slice(0, 300); } catch { /* 无体 */ }
        diag({ kind: 'http-error', status: candidate.status, attempt, detail });
        post(source, { kind: 'error', id: message.id, message: `tunnel HTTP ${candidate.status}` });
        return;
      }
      let detail = '';
      try { detail = (await candidate.text()).slice(0, 300); } catch { /* 无体 */ }
      diag({ kind: 'retry', attempt, status: candidate.status, detail });
    } catch (error) {
      diag({ kind: 'retry', attempt, message: String(error && error.message ? error.message : error) });
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 400 + attempt * 400));
  }
  if (response === null) {
    tunnels.delete(message.id);
    diag({ kind: 'giving-up' });
    post(source, { kind: 'error', id: message.id, message: 'tunnel unavailable after retries' });
    return;
  }
  diag({ kind: 'tunnel-open', status: response.status });

  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (entry.closed) break;
      if (value !== undefined) {
        entry.delivered = true;
        post(source, { kind: 'data', id: message.id, buf: transferable(value) }, [transferable(value)]);
      }
    }
  } catch (error) {
    if (!entry.closed) post(source, { kind: 'error', id: message.id, message: String(error && error.message ? error.message : error) });
  } finally {
    entry.closed = true;
    tunnels.delete(message.id);
    post(source, { kind: 'closed', id: message.id });
  }
}

function closeTunnel(id) {
  const entry = tunnels.get(id);
  if (entry === undefined) return;
  entry.closed = true;
  tunnels.delete(id);
  try { entry.controller?.close(); } catch { /* 已关闭 */ }
}

function onMessage(event) {
  const data = event.data;
  if (data === null || typeof data !== 'object' || data.__dshcs !== MARK) return;
  const source = event.source;
  if (source === null || typeof source.postMessage !== 'function') return;
  if (data.kind === 'open') {
    console.log('[code-server] tunnel open requested:', String(data.path ?? ''));
    void openTunnel(source, data);
    return;
  }
  const entry = tunnels.get(data.id);
  if (entry === undefined) return;
  if (data.kind === 'frame') {
    if (entry.closed) return;
    try { entry.controller.enqueue(new Uint8Array(data.buf)); } catch { /* 流已关闭 */ }
    return;
  }
  if (data.kind === 'close') closeTunnel(data.id);
}

/** 安装中继(幂等)。由客户端插件的 apply() 调用。 */
export function installPipeRelay() {
  if (installed) return;
  installed = true;
  window.addEventListener('message', onMessage);
  console.log('[code-server] pipe tunnel relay installed');
}

/** 诊断:当前隧道数(登录/排查用)。 */
export function pipeRelayStats() {
  return { installed, active: tunnels.size, hasInfo: tunnelInfo !== null };
}
