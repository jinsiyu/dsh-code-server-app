/**
 * dsh-code-server — host 半部:code-server 进程的启动/停止/状态管理 + /code-server JSON API。
 *
 * 零外部依赖:只用 Node 内置模块(child_process / http / fs / path / os)。
 * 静态 profile 插件,与 dsh-webproxy-router-plugin 同形态:
 *   - exports.name    = 插件名(与 cordis.patch.yml 行 id 一致)
 *   - exports.inject  = ['webServer'](硬依赖:等待 webserver 服务就绪)
 *   - apply(ctx, config) 注册 3 条 exact JSON 路由:status / start / stop
 *
 * 设计要点:
 *   - 进程生命周期归本插件:启动写 pid.json,停止用树级终止(taskkill /T 或
 *     进程组 SIGTERM→SIGKILL),退出监听更新状态。
 *   - host 重启后 adopt:pid.json 中的进程仍存活且 /healthz 响应 → 接管为
 *     running(不重复启动);否则清理 pid.json 视为 stopped。绝不误杀别的进程。
 *   - 就绪探测轮询 /healthz;失败时 status 携带启动日志尾部与错误信息。
 *   - auth=none 仅允许回环 host;非回环强制 password(未配置 token 则拒绝启动)。
 *   - 挂载于 ctx.effect:插件销毁(host 关闭/卸载)时回收自己启动的进程。
 *
 * API(同源 fetch,与 webproxy-plugin 的 webServer JSON API 同机制):
 *   GET  /code-server/status → { ok, running, status, port, pid, cwd, url,
 *                                version, error, logTail[, adopted] }
 *   POST /code-server/start  { cwd? } → 幂等启动(换 cwd 则先停后启) → status
 *   POST /code-server/stop   → 停止 → status
 */

import { spawn, execFile, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import { fileURLToPath } from 'node:url';

export const name = 'code-server';
export const inject = ['webServer'];

const DEFAULT_CONFIG = {
  bin: 'code-server',
  host: '127.0.0.1',
  port: 8090,
  auth: 'none',
  passwordToken: '',
  userDataDir: '',
  extensionsDir: '',
  readyTimeoutMs: 60000,
};

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const LOG_TAIL_MAX = 6000;

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function dataRoot(config) {
  return path.join(dshHome(), 'code-server');
}

function pidFile(config) {
  return path.join(dataRoot(config), 'pid.json');
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function win32() {
  return process.platform === 'win32';
}

/** 插件自带运行时入口:lib/../runtime/node_modules/code-server/out/node/entry.js。
 * 已安装(README 的 runtime 恢复命令)时优先用它,否则回退配置/PATH。 */
function bundledRuntimeEntry() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url)); // .../dsh-code-server-app/lib
    const entry = path.join(here, '..', 'runtime', 'node_modules', 'code-server', 'out', 'node', 'entry.js');
    return fs.existsSync(entry) ? entry : null;
  } catch {
    return null;
  }
}

/** 解析 code-server 启动方式:返回 { launched, command, script } | { command, args }。
 *  - `bin` 为可执行文件(裸名/绝对路径 .exe/.cmd):直接 spawn;
 *  - `bin` 为 JS 入口(如 runtime 安装的 out/node/entry.js):自动用 node 运行;
 *  - 未配置 `bin` 时:先探测插件自带 runtime,再回退 PATH 裸名 code-server。 */
function resolveLaunch(config) {
  const preferred = config.bin || bundledRuntimeEntry() || DEFAULT_CONFIG.bin;
  if (/\.(js|mjs|cjs)$/i.test(preferred)) {
    // JS 入口:node <entry> ...(code-server 的 out/node/entry.js 是官方发布形态)
    if (!fs.existsSync(preferred)) {
      throw new Error(`code-server 入口不存在: ${preferred}`);
    }
    return { kind: 'node', script: preferred };
  }
  if (path.isAbsolute(preferred)) return { kind: 'bin', command: preferred };
  try {
    if (win32()) {
      const out = execFileSync('where.exe', [preferred], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      return { kind: 'bin', command: lines.find((l) => /\.cmd$/i.test(l)) ?? lines.find((l) => /\.exe$/i.test(l)) ?? lines[0] };
    }
    const out = execFileSync('which', [preferred], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return { kind: 'bin', command: out.split('\n')[0].trim() };
  } catch {
    throw new Error(
      `code-server 未找到("${preferred}" 不在 PATH)。请安装最新版并确保可执行: ` +
      `npm install -g code-server@latest(Windows 原生需配套最新版 node-gyp 与 VS Spectre 缓解库),` +
      `或在 cordis.patch.yml 的 code-server config 中把 bin 指向已安装的 code-server 可执行文件 / out/node/entry.js。`,
    );
  }
}

function healthCheck(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/healthz', timeout: timeoutMs, method: 'GET' }, (res) => {
      res.resume();
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 500, statusCode: res.statusCode });
    });
    req.on('error', () => resolve({ ok: false }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false });
    });
  });
}

function readPidFile(config) {
  try {
    const raw = JSON.parse(fs.readFileSync(pidFile(config), 'utf8'));
    return raw && typeof raw.pid === 'number' ? raw : null;
  } catch {
    return null;
  }
}

function writePidFile(config, record) {
  fs.mkdirSync(path.dirname(pidFile(config)), { recursive: true });
  fs.writeFileSync(pidFile(config), JSON.stringify(record, null, 2), 'utf8');
}

function removePidFile(config) {
  try {
    fs.rmSync(pidFile(config), { force: true });
  } catch {
    // ignore
  }
}

export async function apply(ctx, config) {
  const cfg = { ...DEFAULT_CONFIG, ...(config ?? {}) };

  const state = {
    status: 'stopped', // stopped | starting | running | stopping | error
    pid: null,
    port: cfg.port,
    cwd: null,
    version: null,
    error: null,
    logTail: '',
    startedAt: null,
    adopted: false,
  };

  let child = null;
  let pollTimer = null;
  let disposeKilled = false;

  function snapshot() {
    const running = state.status === 'running' && state.pid !== null;
    return {
      ok: state.status !== 'error' || running,
      running,
      status: state.status,
      port: state.port,
      host: cfg.host,
      pid: state.pid,
      cwd: state.cwd,
      url: running ? `http://${cfg.host}:${state.port}/` : null,
      version: state.version,
      error: state.error,
      logTail: state.logTail.slice(-LOG_TAIL_MAX),
      adopted: state.adopted,
    };
  }

  function appendLog(chunk) {
    try {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      state.logTail = (state.logTail + text).slice(-LOG_TAIL_MAX * 2);
    } catch {
      // ignore
    }
  }

  function stopPolling() {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function killTree(pid) {
    return new Promise((resolve) => {
      if (!isAlive(pid)) return resolve(false);
      if (win32()) {
        execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], (err) => resolve(!err));
      } else {
        try {
          process.kill(-pid, 'SIGTERM');
        } catch {
          try {
            process.kill(pid, 'SIGTERM');
          } catch {
            return resolve(false);
          }
        }
        const timer = setTimeout(() => {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            try {
              process.kill(pid, 'SIGKILL');
            } catch {
              // gone
            }
          }
          resolve(true);
        }, 3000);
        timer.unref?.();
      }
    });
  }

  async function stop(reason) {
    stopPolling();
    const wasRunning = state.status === 'running' || state.status === 'starting';
    const pid = state.pid;
    if (child !== null) {
      child.stdout?.removeAllListeners?.('data');
      child.stderr?.removeAllListeners?.('data');
      try {
        child.removeAllListeners?.('exit');
        child.removeAllListeners?.('error');
      } catch {
        // ignore
      }
    }
    child = null;
    if (pid) {
      await killTree(pid);
    }
    removePidFile(cfg);
    state.status = 'stopped';
    state.pid = null;
    state.cwd = null;
    state.startedAt = null;
    state.adopted = false;
    if (reason) state.error = null;
  }

  function beginPollingReady() {
    stopPolling();
    const deadline = Date.now() + (Number(cfg.readyTimeoutMs) || DEFAULT_CONFIG.readyTimeoutMs);
    pollTimer = setInterval(async () => {
      const probe = await healthCheck(cfg.host, state.port);
      if (probe.ok) {
        stopPolling();
        state.status = 'running';
        return;
      }
      if (Date.now() > deadline) {
        stopPolling();
        state.status = 'error';
        state.error = `启动超时(${cfg.readyTimeoutMs}ms 内 /healthz 未就绪);code-server 启动日志尾部:\n${state.logTail.slice(-2000)}`;
      }
    }, 1500);
  }

  async function start(cwdArg) {
    const cwd = typeof cwdArg === 'string' && cwdArg.trim() !== '' ? cwdArg : undefined;
    if (state.status === 'running' && state.pid !== null) {
      if (cwd === undefined || cwd === state.cwd) return snapshot();
      await stop('restart');
    }
    if (state.status === 'starting' || state.status === 'stopping') {
      return snapshot();
    }

    const launch = resolveLaunch(cfg); // throws with install guidance when missing

    // 认证:非回环 host 必须 password;显式 password 必须带 token
    const auth = cfg.auth || 'none';
    if (auth === 'none' && !LOOPBACK_HOSTS.has(cfg.host)) {
      state.status = 'error';
      state.error = `auth=none 仅允许回环绑定(当前 host="${cfg.host}");请改用 auth=password 并配置 passwordToken`;
      return snapshot();
    }
    if (auth === 'password' && !cfg.passwordToken) {
      state.status = 'error';
      state.error = 'auth=password 需要配置 passwordToken(cordis.patch.yml 的 config.passwordToken)';
      return snapshot();
    }

    // 端口占用则尝试 adopt(pid.json 有效 + /healthz 响应),否则报错
    const probe = await healthCheck(cfg.host, cfg.port, 800);
    if (probe.ok) {
      const record = readPidFile(cfg);
      if (record && isAlive(record.pid)) {
        state.status = 'running';
        state.pid = record.pid;
        state.cwd = cwd ?? record.cwd ?? null;
        state.startedAt = record.startedAt ?? null;
        state.adopted = true;
        return snapshot();
      }
      state.status = 'error';
      state.error = `端口 ${cfg.port} 已被占用且没有有效的 pid.json 记录(拒绝误杀);请释放端口或修改 port 配置`;
      return snapshot();
    }

    // 重建数据目录
    const root = dataRoot(cfg);
    const userDataDir = cfg.userDataDir || path.join(root, 'user-data');
    const extensionsDir = cfg.extensionsDir || path.join(root, 'extensions');
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(extensionsDir, { recursive: true });

    const args = [
      '--bind-addr', `${cfg.host}:${cfg.port}`,
      '--auth', auth === 'password' ? 'password' : 'none',
      '--user-data-dir', userDataDir,
      '--extensions-dir', extensionsDir,
      '--disable-telemetry',
      '--disable-update-check',
    ];
    if (cwd !== undefined) args.push(cwd);

    state.error = null;
    state.logTail = '';
    state.status = 'starting';
    state.cwd = cwd ?? null;
    state.startedAt = Date.now();
    state.adopted = false;

    const env = { ...process.env };
    if (auth === 'password') env.PASSWORD = cfg.passwordToken;

    let proc;
    try {
      const isCmd = launch.kind === 'bin' && win32() && /\.cmd$/i.test(launch.command);
      const command = launch.kind === 'node' ? process.execPath : launch.command;
      const spawnArgs = launch.kind === 'node' ? [launch.script, ...args] : args;
      // shell 仅对 .cmd shim(Windows npm 全局包)必要:它必须经 cmd.exe 解析。
      // 含空格路径由 spawn 数组传参,不再经 shell 拼接,避免 'C:\Program' 拆分。
      proc = spawn(isCmd ? `"${command}"` : command, spawnArgs, {
        cwd: cwd ?? process.cwd(),
        env,
        shell: isCmd,
        windowsHide: true,
        detached: !win32() && !isCmd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      state.status = 'error';
      state.error = `spawn 失败: ${err && err.message ? err.message : String(err)}`;
      return snapshot();
    }
    child = proc;
    state.pid = proc.pid ?? null;
    writePidFile(cfg, {
      pid: proc.pid,
      startedAt: state.startedAt,
      cwd: cwd ?? null,
      host: cfg.host,
      port: cfg.port,
      launchKind: launch.kind,
      launchCommand: launch.kind === 'node' ? launch.script : launch.command,
    });

    proc.stdout?.on?.('data', appendLog);
    proc.stderr?.on?.('data', appendLog);

    proc.on('error', (err) => {
      if (child !== proc) return;
      child = null;
      removePidFile(cfg);
      state.status = 'error';
      state.error = `code-server 启动失败: ${err && err.message ? err.message : String(err)}\n${state.logTail.slice(-1000)}`;
    });

    proc.on('exit', (code, signal) => {
      if (child !== proc) return; // 已被 stop/dispose 接管
      child = null;
      removePidFile(cfg);
      if (disposeKilled) return;
      state.status = 'error';
      state.error = `code-server 意外退出${code !== null ? `(exit ${code})` : signal ? `(signal ${signal})` : ''}:\n${state.logTail.slice(-1500)}`;
    });

    beginPollingReady();
    return snapshot();
  }

  async function handleApi(req, res) {
    const method = (req.method || 'GET').toUpperCase();
    const payload = { ok: false, error: 'unknown route' };
    try {
      if (req.url === '/code-server/status' && method === 'GET') {
        Object.assign(payload, snapshot());
      } else if (req.url === '/code-server/start' && method === 'POST') {
        let body = {};
        for await (const chunk of req) {
          const text = chunk.toString('utf8');
          if (text) {
            try {
              body = { ...body, ...JSON.parse(text) };
            } catch {
              // ignore malformed fragments; keep best-effort
            }
          }
        }
        const cwd = body && typeof body.cwd === 'string' ? body.cwd : undefined;
        Object.assign(payload, await start(cwd));
      } else if (req.url === '/code-server/stop' && method === 'POST') {
        await stop('user');
        Object.assign(payload, snapshot());
      } else {
        payload.error = 'unknown route';
        payload.status = 404;
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
    } catch (err) {
      payload.ok = false;
      payload.error = err && err.message ? err.message : String(err);
      payload.runner = 'code-server';
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
    }
  }

  const webServer = ctx.get('webServer');
  if (webServer === undefined) {
    console.error('[code-server] webServer service unavailable; plugin registered but idle');
    return;
  }

  const disposers = [
    webServer.register({ kind: 'exact', path: '/code-server/status', handler: handleApi }),
    webServer.register({ kind: 'exact', path: '/code-server/start', handler: handleApi }),
    webServer.register({ kind: 'exact', path: '/code-server/stop', handler: handleApi }),
  ];

  ctx.effect(() => {
    return () => {
      disposeKilled = true;
      stopPolling();
      for (const d of disposers) {
        try {
          d();
        } catch {
          // ignore
        }
      }
      if (child !== null || (state.pid !== null && isAlive(state.pid))) {
        const pid = state.pid;
        child = null;
        if (pid) {
          killTree(pid).then(() => removePidFile(cfg));
        }
      }
    };
  }, 'code-server: lifecycle');

  // DSH host 重启后 adopt:pid.json 有效且进程存活且 /healthz 响应 → 接管
  const record = readPidFile(cfg);
  if (record && isAlive(record.pid)) {
    const probe = await healthCheck(cfg.host, cfg.port, 800);
    if (probe.ok) {
      state.status = 'running';
      state.pid = record.pid;
      state.cwd = record.cwd ?? null;
      state.startedAt = record.startedAt ?? null;
      state.adopted = true;
      console.log(`[code-server] adopted running instance pid=${record.pid} port=${cfg.port}`);
    } else {
      removePidFile(cfg);
    }
  }

  console.log(`[code-server] static plugin loaded (host=${cfg.host} port=${cfg.port} auth=${cfg.auth})`);
}
