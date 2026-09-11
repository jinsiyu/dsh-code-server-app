/**
 * lib/pipe-tunnel.mjs —— IDE WebSocket 的字节隧道(host 半部)。
 *
 * 背景:桌面端工作台文档来自 loopback(阶段 1),而自定义 scheme 与 loopback 之间
 * **双向 fetch 都被 Chromium 拒**(实测 2026-09-11:两个方向都 Failed to fetch),
 * 所以工作台文档不能直接 POST 本路由;实际调用者是 DSH 客户端插件(同源
 * dsh-app://app),它用 postMessage 与 iframe 互转字节。见 docs/plan-noport-desktop-ide.md §4。
 *
 * 本模块只做一件事:把一条 POST 的双向字节流转发给 launcher 子进程的
 * `/__dshcs/tunnel` 端点(loopback TCP 或命名管道),子进程再把字节喂给
 * `vsServer.handleUpgrade` 的合成 socket。WS 握手与帧语义完全由两端各自的
 * WebSocket 实现负责,隧道只搬字节。
 */
import { request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';

/** 隧道路由(host 侧;必须落在 /api 下,桌面载体只把 /api/* 交给 Connection)。 */
export const TUNNEL_PATH = '/api/code-server/tunnel';

/** 令牌头:每次插件激活随机生成,只有同源客户端能拿到(经 status 路由下发)。 */
export const TUNNEL_TOKEN_HEADER = 'x-dshcs-tunnel-token';

/** 子进程隧道端点(仅 host 与子进程之间使用)。 */
export const CHILD_TUNNEL_PATH = '/__dshcs/tunnel';

/** 握手元数据头:WS 握手请求由子进程侧的 ws 服务端合成,这里只传参数。 */
const WS_PATH = 'x-dshcs-ws-path';
const WS_KEY = 'x-dshcs-ws-key';
const WS_VERSION = 'x-dshcs-ws-version';
const WS_ORIGIN = 'x-dshcs-ws-origin';

function jsonResponse(value, status) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * 建隧道转发器。
 * @param {object} options
 * @param {() => ({kind:'loopback',port:number}|{kind:'pipe',pipe:string}|null)} options.getTarget - 取当前 IDE 目标
 * @param {string} options.token - 隧道令牌
 * @param {(message:string)=>void} [options.log] - 诊断日志
 * @returns {{ fetch: (request: Request) => Promise<Response>, snapshot: () => object, path: string }}
 */
export function createPipeTunnel({ getTarget, token, log = () => {} }) {
  const stats = {
    active: 0,
    opened: 0,
    closed: 0,
    rejected: 0,
    failed: 0,
    bytesIn: 0,
    bytesOut: 0,
    lastError: null,
    lastAt: null,
  };

  function snapshot() {
    return { ...stats };
  }

  /** 按目标类型组装 http.request 的连接参数。 */
  function connectionOptions(target) {
    if (target === null) return null;
    if (target.kind === 'pipe') {
      return { socketPath: target.pipe, headers: { host: 'localhost' } };
    }
    return { host: '127.0.0.1', port: target.port, headers: {} };
  }

  async function fetch(request) {
    const presented = request.headers.get(TUNNEL_TOKEN_HEADER);
    if (typeof presented !== 'string' || presented !== token) {
      stats.rejected += 1;
      return jsonResponse({ ok: false, error: 'tunnel token rejected' }, 403);
    }
    const wsPath = request.headers.get(WS_PATH);
    const wsKey = request.headers.get(WS_KEY);
    if (typeof wsPath !== 'string' || wsPath === '' || typeof wsKey !== 'string' || wsKey === '') {
      stats.rejected += 1;
      return jsonResponse({ ok: false, error: 'missing websocket handshake parameters' }, 400);
    }
    const target = getTarget();
    const options = connectionOptions(target);
    if (options === null) {
      return jsonResponse({ ok: false, error: 'code-server is not running' }, 503);
    }

    const headers = {
      ...options.headers,
      'content-type': 'application/octet-stream',
      'cache-control': 'no-store',
      [TUNNEL_TOKEN_HEADER]: token,
      [WS_PATH]: wsPath,
      [WS_KEY]: wsKey,
      [WS_VERSION]: request.headers.get(WS_VERSION) ?? '13',
    };
    const origin = request.headers.get(WS_ORIGIN);
    if (typeof origin === 'string' && origin !== '') headers[WS_ORIGIN] = origin;

    /** @type {import('node:stream').Readable | undefined} */
    let upstreamBody;
    if (request.body !== null) {
      upstreamBody = Readable.fromWeb(request.body);
      upstreamBody.on('data', (chunk) => { stats.bytesOut += chunk.length; });
    }

    stats.opened += 1;
    stats.active += 1;
    stats.lastAt = Date.now();

    try {
      const response = await new Promise((resolve, reject) => {
        const upstream = httpRequest({
          method: 'POST',
          path: CHILD_TUNNEL_PATH,
          ...options,
          headers,
        }, (res) => { resolve({ upstream, res }); });
        upstream.on('error', reject);
        request.signal?.addEventListener('abort', () => { upstream.destroy(new Error('client aborted')); }, { once: true });
        if (upstreamBody === undefined) upstream.end();
        else {
          upstreamBody.on('error', (error) => upstream.destroy(error));
          upstreamBody.pipe(upstream);
        }
      });

      const { upstream, res } = response;
      const body = Readable.toWeb(res);
      const counted = new ReadableStream({
        async start(controller) {
          const reader = body.getReader();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              stats.bytesIn += value.byteLength;
              controller.enqueue(value);
            }
            controller.close();
          } catch (error) {
            controller.error(error);
          } finally {
            stats.active = Math.max(0, stats.active - 1);
            stats.closed += 1;
          }
        },
        cancel(reason) {
          upstream.destroy(reason instanceof Error ? reason : undefined);
        },
      });

      if ((res.statusCode ?? 500) >= 400) {
        stats.failed += 1;
        stats.lastError = `child tunnel HTTP ${res.statusCode}`;
        stats.active = Math.max(0, stats.active - 1);
      }
      return new Response(counted, {
        status: res.statusCode ?? 502,
        headers: {
          'content-type': res.headers['content-type'] ?? 'application/octet-stream',
          'cache-control': 'no-store',
        },
      });
    } catch (error) {
      stats.failed += 1;
      stats.active = Math.max(0, stats.active - 1);
      stats.lastError = error && error.message ? error.message : String(error);
      log(`tunnel failed: ${stats.lastError}`);
      return jsonResponse({ ok: false, error: stats.lastError }, 502);
    }
  }

  return { fetch, snapshot, path: TUNNEL_PATH };
}
