/**
 * lib/bridge-ipc.mjs — 编辑器桥的传输层:本机 IPC(Windows 命名管道 / 其它平台 unix socket)。
 *
 * 为什么不走 HTTP(0.3.13 定论,三条都实测过):
 *  1. **desktop 根本没有 HTTP 面**:渲染进程经 Electron IPC 调 `host.fetch()`
 *     (`apps/desktop-host/src/index.ts:308` 的 `createSharedFetchHandler('/api')`),
 *     那是**进程内函数调用**,进程外不可达;插件能挂 HTTP 的只有 web profile 的 `webServer`。
 *  2. **`/api` 那条路即使有 webServer 也不行**:Connection 给 `/api` 装了浏览器 cookie fence
 *     (`packages/client/connection/src/index.ts:128-134` 的 `requestRejection` → 401),
 *     而桥的客户端是扩展宿主里的 **Node 进程**,永远拿不到浏览器 cookie。
 *  3. 桥的双方本来就是**同一台机器上的两个进程**(扩展宿主 ← 插件 spawn 的 IDE ← 插件),
 *     本机 IPC 比开端口更小:没有网络面、没有 Host/Origin 混淆代理问题。
 *
 * 与 `serve: dsh` 的 IDE 挂载同源:`net`/`http` 的 `listen(path)` + `http.request({socketPath})`
 * 在本机已被验证可用(见 lib/launcher.mjs 的 `--pipe` 与 lib/index.js 的 `healthCheckPipe`)。
 *
 * 安全:令牌校验仍然保留(见 lib/bridge.mjs 的 `bridgeGuard`)。Windows 命名管道用随机后缀
 * (不可猜),POSIX 上 socket 文件 `chmod 0600` 并在关闭时删除。
 */

import { chmodSync, readdirSync, rmSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';

/** 命名管道的统一前缀(Windows;`\\.\pipe\` 是本机命名空间,不经过网络栈)。 */
const WIN_PIPE_PREFIX = '\\\\.\\pipe\\';

/** 本机 IPC 端点路径。Windows = 命名管道名;其它平台 = <dataRoot>/bridge-<pid>-<rand>.sock。 */
export function bridgeEndpointPath(root, pid = process.pid, platform = process.platform) {
  const rand = randomBytes(6).toString('hex');
  if (platform === 'win32') return `${WIN_PIPE_PREFIX}dshcs-bridge-${pid}-${rand}`;
  return join(root, `bridge-${pid}-${rand}.sock`);
}

/** 端点是不是本机 IPC(扩展侧与测试共用同一条判定)。 */
export function isBridgeEndpoint(value, platform = process.platform) {
  if (typeof value !== 'string' || value === '') return false;
  if (platform === 'win32') return value.startsWith(WIN_PIPE_PREFIX);
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
}

/** POSIX 上清掉上一次崩溃留下的 socket 文件(24h 以前的;不碰别人正在用的)。
 *  Windows 命名管道由内核回收,不需要清理。 */
function sweepStaleSockets(root, log) {
  let names;
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const name of names) {
    if (!/^bridge-\d+-[0-9a-f]{12}\.sock$/.test(name)) continue;
    const file = join(root, name);
    try {
      if (statSync(file).mtimeMs < cutoff) rmSync(file, { force: true });
    } catch {
      // 清理失败无关正确性(端点带随机后缀,不会撞名)
    }
  }
}

/**
 * 起一个只服务桥路由的本机 IPC 监听口。
 *
 * @param {{socketPath: string, handler: (req: import('node:http').IncomingMessage,
 *          res: import('node:http').ServerResponse) => unknown, log?: (message: string) => void}} options
 * @returns {Promise<{path: string, close: () => Promise<void>}>} 监听成功后的句柄(失败则 reject)
 */
export function startBridgeListener({ socketPath, handler, log = () => {} }) {
  const isWinPipe = socketPath.startsWith(WIN_PIPE_PREFIX);
  if (!isBridgeEndpoint(socketPath)) {
    return Promise.reject(new Error(`非法的桥端点路径:${socketPath}`));
  }
  if (!isWinPipe) {
    sweepStaleSockets(dirname(socketPath), log);
    // unix socket 文件必须先不存在,否则 listen 直接 EADDRINUSE(端点带随机后缀,撞名不可能)
    try { rmSync(socketPath, { force: true }); } catch { /* ignore */ }
  }
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      server.on('error', (error) => log(`桥监听异常:${error && error.code ? error.code : error && error.message ? error.message : error}`));
      if (!isWinPipe) {
        try { chmodSync(socketPath, 0o600); } catch { /* 权限收紧失败不影响可用性 */ }
      }
      resolve({
        path: socketPath,
        close: () => new Promise((done) => {
          server.close(() => {
            if (!isWinPipe) {
              try { rmSync(socketPath, { force: true }); } catch { /* ignore */ }
            }
            done();
          });
        }),
      });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    try {
      server.listen(socketPath);
    } catch (error) {
      onError(error);
    }
  });
}
