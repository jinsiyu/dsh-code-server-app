/**
 * lib/serve-dsh.mjs — 把 VS Code server 挂到 DSH 自身 HTTP 端口上的两段式注册(serve=dsh)。
 *
 *   ctx.webServer.register({ kind: 'prefix', path: '/code-server', handler })     ← HTTP
 *   ctx.webServer.registerUpgrade({ path: '/code-server/<productPath>', handler }) ← WebSocket(精确匹配)
 *
 * 两条路径都必须先过 ctx.connection.requestRejection():DSH 的 webServer 本身不做任何校验,
 * 防护是逐路由的(Host/Origin fence + 浏览器 cookie 认证),缺了它 IDE 会成为源站上唯一的无认证面。
 *
 * 转发策略(Phase 0 实测):**剥掉挂载前缀**后转给 launcher 的命名管道 —— VS Code 侧保持根挂载,
 * 与今天已验证的配置完全一致;客户端渲染出的资源引用全是相对路径,浏览器按 /code-server/ 解析,
 * 因此同一套 prefix 路由就能覆盖 HTML、静态资源、vscode-remote-resource 与 /_static/*。
 *
 * 已知退化:转发端口(/proxy/:port)的 WebSocket 无法用精确升级路由覆盖(端口号在路径里),
 * 需要 DSH 上游提供 prefix upgrade;HTTP 转发端口不受影响。
 */

import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';

export const MOUNT_PATH = '/code-server';

/** 前缀匹配(与 DSH webServer 的 prefix 语义一致:命中 p 与 p/<anything>)。 */
function matchesPrefix(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** 把 /code-server/xxx 转成上游要的 /xxx(空则 '/'),保留 query。 */
function stripPrefix(url, prefix) {
  const rest = url.slice(prefix.length);
  return rest === '' ? '/' : rest;
}

function rejectionOf(connection, req) {
  try {
    return connection.requestRejection({ headers: req.headers }) ?? undefined;
  } catch (error) {
    return { error };
  }
}

/** 转发目标的两种形态:命名管道(kind:'pipe')或回环 TCP(kind:'tcp')。
 *  注意 http.request 用 socketPath、net.connect 用 path —— 两者键名不同,必须在这里翻译。 */
function httpOptions(target, extra) {
  return target.kind === 'pipe'
    ? { socketPath: target.pipe, ...extra }
    : { host: target.host, port: target.port, ...extra };
}

function connectTo(target, onConnect) {
  return target.kind === 'pipe'
    ? connect({ path: target.pipe }, onConnect)
    : connect({ host: target.host, port: target.port }, onConnect);
}

/**
 * 注册 IDE 的同源挂载点。
 * @param {object} options
 * @param {object} options.webServer - DSH webServer 服务(register / registerUpgrade)
 * @param {object} options.connection - DSH connection 服务(requestRejection)
 * @param {() => ({socketPath: string} | {host: string, port: number} | null)} options.getTarget
 *   当前 launcher 的转发目标(0.3.3 起只有命名管道;host/port 形态仅由测试桩使用)
 * @param {string} options.productPath - VS Code 客户端路径(quality-commit)
 * @param {string} [options.mount] - 挂载前缀,默认 /code-server
 * @param {(msg: string) => void} [options.log]
 * @returns {{ disposers: (() => void)[], upgradePath: string }}
 */
export function mountOnWebServer({ webServer, connection, getTarget, productPath, mount = MOUNT_PATH, log = () => {} }) {
  const upgradePath = `${mount}/${productPath}`;
  const disposers = [];

  /** 请求被 fence 拒绝时按 DSH 的约定回 401/403(upgrade 走裸 socket)。 */
  function fence(req) {
    const rejection = rejectionOf(connection, req);
    if (rejection === undefined) return null;
    if (typeof rejection === 'object' && rejection.error !== undefined) {
      log(`requestRejection 抛错,按 403 处理: ${rejection.error?.message ?? rejection.error}`);
      return 403;
    }
    return rejection;
  }

  disposers.push(webServer.register({
    kind: 'prefix',
    path: mount,
    handler: (req, res) => {
      try {
        const pathname = new URL(req.url ?? '/', 'http://x').pathname;
        if (!matchesPrefix(pathname, mount)) { res.writeHead(404); res.end(); return; }
        const status = fence(req);
        if (status !== null) {
          res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(status === 401 ? 'unauthorized\n' : 'forbidden\n');
          return;
        }
        const target = getTarget();
        if (target === null) {
          res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('code-server 未启动\n');
          return;
        }
        const upstream = httpRequest(httpOptions(target, {
          method: req.method,
          path: stripPrefix(req.url ?? '/', mount),
          headers: req.headers,
        }), (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(res);
        });
        upstream.on('error', (error) => {
          log(`HTTP 转发失败(${req.method} ${req.url}): ${error.message}`);
          if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
          if (!res.writableEnded) res.end('code-server 不可达\n');
        });
        req.on('aborted', () => upstream.destroy());
        req.pipe(upstream);
      } catch (error) {
        // 路由回调里的异常绝不能冒泡到 DSH 的 webServer(会变成未捕获异常)
        log(`HTTP 挂载点异常(${req.method} ${req.url}): ${error && error.stack ? error.stack : error}`);
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        if (!res.writableEnded) res.end('code-server 挂载点异常\n');
      }
    },
  }));

  disposers.push(webServer.registerUpgrade({
    path: upgradePath,
    handler: (req, socket, head) => {
      try {
        const status = fence(req);
        if (status !== null) {
          socket.end(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Forbidden'}\r\nConnection: close\r\n\r\n`);
          return;
        }
        const target = getTarget();
        if (target === null) { socket.destroy(); return; }
        const upstream = connectTo(target, () => {
          const lines = [`GET ${stripPrefix(req.url ?? '/', mount)} HTTP/1.1`];
          for (let i = 0; i < req.rawHeaders.length; i += 2) {
            lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
          }
          upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
          if (head !== undefined && head.length > 0) upstream.write(head);
          upstream.pipe(socket);
          socket.pipe(upstream);
        });
        upstream.on('error', (error) => { log(`WS 转发失败(${req.url}): ${error.message}`); socket.destroy(); });
        socket.on('error', () => upstream.destroy());
        socket.on('close', () => upstream.destroy());
      } catch (error) {
        log(`WS 挂载点异常(${req.url}): ${error && error.stack ? error.stack : error}`);
        socket.destroy();
      }
    },
  }));

  log(`已挂载 ${mount}/ (HTTP prefix)+ ${upgradePath} (WS exact)`);
  return {
    upgradePath,
    disposers,
  };
}
