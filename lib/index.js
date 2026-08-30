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
import { createRequire } from 'node:module';

// schemastery 由 DSH 部署自带(官方核心依赖),仿 auto-open-web 的解析策略:
// 常规 import 优先,不可用时回退到全局 npm 布局的 DSH 部署副本。
let z = null;
try {
  z = (await import('@deepseek-ai/schemastery')).default;
} catch {
  try {
    const globalRoot = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'node_modules') : '';
    const dshEntry = path.join(globalRoot, '@deepseek-ai', 'dsh', 'package.json');
    if (fs.existsSync(dshEntry)) z = createRequire(dshEntry)('@deepseek-ai/schemastery');
  } catch {
    /* 两次解析均失败 → 下方抛错 */
  }
}
if (z === null || z === undefined) {
  throw new Error(
    '[code-server] schemastery not found (neither local nor DSH deployment); ' +
      'this plugin cannot build its settings schema. Check the DSH deployment.',
  );
}

export const name = 'code-server';
export const inject = ['webServer', 'settings'];

/** 设置命名空间:卡片经官方 settings 域读写,持久化到官方 settings 文档。 */
export const SETTINGS_NS = 'code-server';

/** 设置卡片 schema(参照 auto-open-web 的 Config 形态)。 */
export const Config = z.object({
  /** reserveComposer=true(默认)窗口不盖输入框(初始/缩放/最大化止于输入栏上方);
   *  false 时允许盖住输入框(最大化到视口底)。 */
  reserveComposer: z.boolean().default(true),
  /** windowedOpen=false(默认)点击悬浮球打开内部浮动窗口;
   *  true 时改为在浏览器新标签页打开 code-server(自动启动并跟随工作区)。 */
  windowedOpen: z.boolean().default(false),
  /** installGuideDismissed=false(默认)环境未就绪时弹出安装指引;
   *  true = 用户已永久关闭安装指引(不再弹出;设置卡可重新打开)。 */
  installGuideDismissed: z.boolean().default(false),
});

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

/** 插件自带 code-server 入口探测,兼容两种依赖布局:
 *   1. profile 专用目录:profileRoot/.code-server-app/node_modules/code-server/...
 *      (方案 D 默认安装位,独立项目、避开 profile 依赖树冲突);
 *   2. 包内:插件目录/node_modules/code-server/...(开发期 link:/独立 npm install 布局)。
 *  不存在 → 回退配置/PATH。 */
function bundledRuntimeEntry() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url)); // .../dsh-code-server-app/lib 或 .../dsh-code-server/lib
    const candidates = [
      // profile 专用目录:here=.../dsh-code-server/lib → ../..=node_modules → ../../..=profile根
      path.join(here, '..', '..', '..', '.code-server-app', 'node_modules', 'code-server', 'out', 'node', 'entry.js'),
      // 包内(dev link / 独立目录):here=.../lib → ../node_modules
      path.join(here, '..', 'node_modules', 'code-server', 'out', 'node', 'entry.js'),
    ];
    for (const entry of candidates) {
      if (fs.existsSync(entry)) return entry;
    }
    return null;
  } catch {
    return null;
  }
}

/** 扩展安装目标:VS Code "内置扩展"目录 = code-server 程序根的 lib/vscode/extensions。
 *  (位于程序内置目录的扩展被 VS Code 视为内置——用户视图显示为"内置",不可卸载;
 *   --extensions-dir 的是用户级扩展,可被用户禁用/卸载。)
 *  返回 { dst, builtin }——builtin=true 时为核心路径;找不到 code-server 根则回退用户级。 */
function extensionTarget(extensionsDir) {
  try {
    const entry = bundledRuntimeEntry();
    if (entry !== null) {
      const csRoot = path.dirname(path.dirname(path.dirname(entry))); // .../code-server
      const vscodeExt = path.join(csRoot, 'lib', 'vscode', 'extensions');
      if (fs.existsSync(vscodeExt)) {
        return { dst: path.join(vscodeExt, 'dshcs-open-file'), builtin: true };
      }
    }
  } catch { /* fall through */ }
  return { dst: path.join(extensionsDir, 'dshcs-open-file'), builtin: false };
}

/** 内置扩展安装:dshcs-open-file(host 信号文件 → VS Code 打开文件)。
 *  优先装进 code-server 内置扩展目录(不可卸载);同时清理用户级旧副本。
 *  每次启动调用:缺失即拷(自愈,code-server 升级后自动找回)。 */
function installBundledExtension(extensionsDir, userDataDir) {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = path.join(here, '..', 'assets', 'extensions', 'dshcs-open-file');
    if (!fs.existsSync(path.join(src, 'package.json'))) return;
    const target = extensionTarget(extensionsDir);
    const dst = target.dst;
    if (!fs.existsSync(path.join(dst, 'extension.js'))) {
      fs.mkdirSync(dst, { recursive: true });
      fs.copyFileSync(path.join(src, 'package.json'), path.join(dst, 'package.json'));
      fs.copyFileSync(path.join(src, 'extension.js'), path.join(dst, 'extension.js'));
    }
    // 清理用户级旧副本(避免重复/可卸载副本)
    const legacy = path.join(extensionsDir, 'dshcs-open-file');
    if (legacy !== dst && fs.existsSync(legacy)) {
      fs.rmSync(legacy, { recursive: true, force: true });
    }
    console.log(`[code-server] bundled extension dshcs-open-file -> ${dst}${target.builtin ? ' (内置,不可卸载)' : ' (用户级回退)'}`);
  } catch (err) {
    console.warn('[code-server] bundled extension install failed:', err && err.message ? err.message : String(err));
  }
}

/** 打开文件信号文件:<user-data>/User/dshcs-open.json(扩展轮询此文件)。 */
function openFileSignalPath(userDataDir) {
  return path.join(userDataDir, 'User', 'dshcs-open.json');
}

/** 环境检测:code-server 入口 + 原生模块 + VS Code 内部依赖 是否就绪。
 * 返回 { ok, entry, native, vscodeInner, node, platform, arch, pathToSetup }。 */
function envCheck() {
  const entry = bundledRuntimeEntry();
  const csRoot = entry ? path.dirname(path.dirname(path.dirname(entry))) : null; // .../code-server
  const nativeOk = csRoot !== null && (
    fs.existsSync(path.join(csRoot, 'node_modules', 'argon2', 'build', 'Release', 'argon2.node')) ||
    fs.existsSync(path.join(csRoot, 'node_modules', 'argon2', 'prebuilds'))
  );
  const innerOk = csRoot !== null &&
    fs.existsSync(path.join(csRoot, 'lib', 'vscode', 'node_modules'));
  return {
    ok: entry !== null && nativeOk && innerOk,
    entry: entry !== null ? entry.replace(/\\/g, '/') : null,
    native: nativeOk,
    vscodeInner: innerOk,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    pathToSetup: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'setup-code-server.mjs').replace(/\\/g, '/'),
  };
}

/** 解析 code-server 启动方式:返回 { launched, command, script } | { command, args }。
 *  - `bin` 为可执行文件(裸名/绝对路径 .exe/.cmd):直接 spawn;
 *  - `bin` 为 JS 入口(依赖安装的 out/node/entry.js):自动用 node 运行;
 *  - 未配置 `bin` 时:先探测插件依赖安装的 code-server,再回退 PATH 裸名 code-server。 */
function resolveLaunch(config) {
  const probe = bundledRuntimeEntry();
  let preferred = config.bin || DEFAULT_CONFIG.bin;
  // 依赖安装的 code-server 优先,除非用户显式配置了非默认 bin
  if (preferred === DEFAULT_CONFIG.bin && probe !== null) preferred = probe;
  console.log(`[code-server] resolveLaunch: configuredBin=${config.bin ?? '(none)'} probe=${probe ?? '(none)'} -> ${preferred}`);
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

  // ---- 设置:行配置为种子;settings 命名空间持久化(设置卡片写入) ----
  const settingsSvc = ctx.get('settings');
  let reserveComposer = true;
  let windowedOpen = false;
  let installGuideDismissed = false;
  if (settingsSvc !== undefined && typeof settingsSvc.register === 'function') {
    try {
      const scope = settingsSvc.register(SETTINGS_NS, Config);
      const rawDoc = settingsSvc.get(SETTINGS_NS);
      if (rawDoc !== undefined && rawDoc !== null) {
        const resolved = scope.get();
        reserveComposer = resolved && typeof resolved.reserveComposer === 'boolean' ? resolved.reserveComposer : true;
        windowedOpen = resolved && typeof resolved.windowedOpen === 'boolean' ? resolved.windowedOpen : false;
        installGuideDismissed = resolved && typeof resolved.installGuideDismissed === 'boolean' ? resolved.installGuideDismissed : false;
      }
      scope.watch((next) => {
        if (next != null && typeof next.reserveComposer === 'boolean') {
          reserveComposer = next.reserveComposer;
          console.log(`[code-server] reserveComposer updated: ${reserveComposer}`);
        }
        if (next != null && typeof next.windowedOpen === 'boolean') {
          windowedOpen = next.windowedOpen;
          console.log(`[code-server] windowedOpen updated: ${windowedOpen}`);
        }
        if (next != null && typeof next.installGuideDismissed === 'boolean') {
          installGuideDismissed = next.installGuideDismissed;
          console.log(`[code-server] installGuideDismissed updated: ${installGuideDismissed}`);
        }
      });
    } catch (error) {
      console.error(`[code-server] settings unavailable; using defaults (reserveComposer=true, windowedOpen=false): ${error.message}`);
    }
  }

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
    env: envCheck(), // 环境检测(code-server 入口/native/内部依赖)
    setup: { running: false, done: false, ok: false, logTail: '', startedAt: null, finishedAt: null }, // 环境安装任务
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
      reserveComposer,
      windowedOpen,
      installGuideDismissed,
      env: state.env,
      setup: {
        running: state.setup.running,
        done: state.setup.done,
        ok: state.setup.ok,
        logTail: state.setup.logTail.slice(-LOG_TAIL_MAX),
      },
      lastSetupError: readLastSetupError(),
    };
  }

  /** 读 setup 失败标记文件(postinstall 失败时写入;成功则不存在)→ 用户可查看。
   *  标记在安装根:<profile>\.code-server-app\last-setup-error.json。 */
  function readLastSetupError() {
    try {
      const here = path.dirname(fileURLToPath(import.meta.url));
      // 插件目录 <profile>\node_modules\<name> 向上两级 = <profile> 根
      const profileRoot = path.join(here, '..', '..');
      const marker = path.join(profileRoot, '.code-server-app', 'last-setup-error.json');
      if (!fs.existsSync(marker)) return null;
      const raw = fs.readFileSync(marker, 'utf8');
      const j = JSON.parse(raw);
      return {
        at: j && typeof j.at === 'string' ? j.at : null,
        error: j && typeof j.error === 'string' ? j.error : '安装脚本失败(无详情)',
      };
    } catch {
      return null;
    }
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
    // 首探延迟 800ms(spawn 后进程初始化),之后每 500ms 一次——缩短"已就绪但 UI 在转"的窗口
    let first = true;
    pollTimer = setInterval(async () => {
      if (first) {
        first = false;
        return; // 等 800ms 才首次探测(给 Node 启动留时间)
      }
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
    }, 500);
  }

  async function start(cwdArg) {
    const cwd = typeof cwdArg === 'string' && cwdArg.trim() !== '' ? cwdArg : undefined;
    if (state.status === 'running' && state.pid !== null) {
      if (cwd === undefined || cwd === state.cwd) return snapshot();
      await stop('restart');
    }
    // 上一次启动仍在进行:等待它结算后再按本次 cwd 启动,避免 cwd 切换被吞
    if (state.status === 'starting') {
      const deadline = Date.now() + 10000;
      while (state.status === 'starting' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
      }
      if (state.status === 'starting') {
        state.status = 'error';
        state.error = '启动长时间未结算(10s),请查看启动日志;后可重试';
        stopPolling();
        return snapshot();
      }
      if (state.status === 'running') {
        if (cwd === undefined || cwd === state.cwd) return snapshot();
        await stop('restart');
      }
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

    // 安装内置扩展(dshcs-open-file:host 信号文件 → VS Code 打开文件)
    installBundledExtension(extensionsDir, userDataDir);

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
    // 内置扩展信号文件路径(host → 扩展 打开文件)
    env.DSHCS_OPEN_FILE_SIGNAL = openFileSignalPath(userDataDir);

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

  /** 后台启动环境安装(setup 脚本):npm 自装 code-server + native + vscode 内部依赖。
   * 异步运行,进度经 status.setup 轮询返回;完成后刷新 envCheck。 */
  function startSetup() {
    if (state.setup.running) return;
    const script = envCheck().pathToSetup;
    state.setup = { running: true, done: false, ok: false, logTail: '', startedAt: Date.now(), finishedAt: null };
    let proc;
    try {
      proc = spawn(process.execPath, [script], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      state.setup = { running: false, done: true, ok: false, logTail: `spawn 失败: ${err.message}`, startedAt: Date.now(), finishedAt: Date.now() };
      return;
    }
    const onChunk = (chunk) => {
      try {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        state.setup.logTail = (state.setup.logTail + text).slice(-LOG_TAIL_MAX * 2);
      } catch { /* ignore */ }
    };
    proc.stdout?.on?.('data', onChunk);
    proc.stderr?.on?.('data', onChunk);
    proc.on('error', (err) => {
      state.setup = { ...state.setup, running: false, done: true, ok: false, logTail: state.setup.logTail + `\nspawn 错误: ${err.message}`, finishedAt: Date.now() };
      state.env = envCheck();
    });
    proc.on('exit', (code) => {
      state.setup = { ...state.setup, running: false, done: true, ok: code === 0, finishedAt: Date.now() };
      state.env = envCheck();
      console.log(`[code-server] setup finished code=${code} env.ok=${state.env.ok}`);
    });
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
      } else if (req.url === '/code-server/setup' && method === 'POST') {
        // 环境安装:后台执行 setup 脚本(npm 自装 code-server + native + vscode 内部依赖)
        if (state.setup.running) {
          // 已在安装中:同样视为"已发起"(客户端会轮询 setup 状态直至结束)
          payload.ok = true;
          payload.message = '环境安装已在进行中,请等待完成';
          payload.error = null;
        } else {
          startSetup();
          Object.assign(payload, snapshot());
          payload.ok = true; // 安装任务已启动;服务态 error(如未安装)不掩盖安装态
        }
      } else if (req.url === '/code-server/open-file' && method === 'POST') {
        // 打开文件:host 写信号文件,内置扩展(dshcs-open-file)在 VS Code 中打开它
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
        const file = body && typeof body.file === 'string' ? body.file : null;
        if (file === null || file === '') {
          payload.error = '需要 file 字段(要打开的绝对路径)';
          payload.status = 400;
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(payload));
          return;
        }
        const root = dataRoot(cfg);
        const userDataDir = cfg.userDataDir || path.join(root, 'user-data');
        const signal = openFileSignalPath(userDataDir);
        try {
          fs.mkdirSync(path.dirname(signal), { recursive: true });
          fs.writeFileSync(signal, JSON.stringify({ file, ts: Date.now() }), 'utf8');
          // 同时确保 code-server 运行(信号由扩展消费)
          payload.ok = true;
          payload.signal = signal;
        } catch (err) {
          payload.error = err && err.message ? err.message : String(err);
        }
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

  /** 固化图标服务:返回插件携带的 code-server 官方图标(不依赖运行时安装)。
   *  - /code-server/icon.ico → assets/favicon.ico(标签页/桌面图标)
   *  - /code-server/icon.svg  → assets/favicon.svg(PWA/深色模式) */
  function handleIcon(req, res) {
    const isSvg = req.url === '/code-server/icon.svg';
    const file = isSvg ? 'favicon.svg' : 'favicon.ico';
    const p = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', file);
    try {
      if (!fs.existsSync(p)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('icon not found');
        return;
      }
      const data = fs.readFileSync(p);
      res.writeHead(200, {
        'content-type': isSvg ? 'image/svg+xml' : 'image/x-icon',
        'cache-control': 'public, max-age=86400',
      });
      res.end(data);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: err && err.message ? err.message : String(err) }));
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
    webServer.register({ kind: 'exact', path: '/code-server/setup', handler: handleApi }),
    webServer.register({ kind: 'exact', path: '/code-server/open-file', handler: handleApi }),
    webServer.register({ kind: 'exact', path: '/code-server/icon.ico', handler: handleIcon }),
    webServer.register({ kind: 'exact', path: '/code-server/icon.svg', handler: handleIcon }),
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

  // ---- 预启动:环境就绪且未运行 → 后台自动拉起(不等待) ----
  // 悬浮球打开时若已 running,iframe 立即加载(消除冷启动等待)。
  if (state.env.ok && state.status !== 'running' && state.status !== 'starting') {
    start().catch((err) => {
      console.error('[code-server] prestart failed:', err && err.message ? err.message : String(err));
    });
  }

  console.log(`[code-server] static plugin loaded (host=${cfg.host} port=${cfg.port} auth=${cfg.auth})`);
}
