/**
 * dsh-code-server — host 半部:VS Code server 子进程(lib/launcher.mjs)的启动/停止/状态管理
 * + /api/code-server JSON API。
 *
 * 模型(0.2.0 起):不再运行 code-server 的 Node 服务层 —— 直接由 lib/launcher.mjs 驱动
 * <树>/lib/vscode/out/server-main.js(树 = @<scope>/dshcs-vscode-server 的 vscode/ 子目录)。
 * 依据与实测见 docs/analysis-code-server-as-dsh-plugin.md。
 *
 * 零外部依赖:只用 Node 内置模块(child_process / http / fs / path / os)。
 * 静态 profile 插件,与 dsh-webproxy-router-plugin 同形态:
 *   - exports.name    = 插件名(与 cordis.patch.yml 行 id 一致)
 *   - exports.inject  = ['connection', 'settings'](connection 承载 client↔host 通道)
 *   - apply(ctx, config) 在共享 /api 通道注册 5 条 exact Fetch 路由:
 *     status / start / stop / setup(兼容空操作) / open-file
 *
 * 通道选择(重要):**不依赖 webServer**。路由经 ctx.connection.fetch.register
 * 挂在 Connection 服务的共享 /api 通道上:
 *   - web profile:Connection 自己把 /api 前缀挂到 webServer(带 Host/Origin + 浏览器鉴权);
 *   - desktop profile:apps/desktop-host 把 /api/* 交给同一个 createSharedFetchHandler('/api')
 *     (IPC 帧管道,无 HTTP 服务器)→ 插件在 desktop 下同样可用。
 * 客户端因此只需同源 fetch('/api/code-server/<op>')(见 src/factory.js 的 api())。
 *
 * 设计要点:
 *   - 进程生命周期归本插件:启动写 pid.json,停止用树级终止(taskkill /T 或
 *     进程组 SIGTERM→SIGKILL),退出监听更新状态。
 *   - host 重启后 adopt:pid.json 中的进程仍存活且 /healthz 响应 → 接管为
 *     running(不重复启动);否则清理 pid.json 视为 stopped。绝不误杀别的进程。
 *   - 就绪探测轮询 /healthz;失败时 status 携带启动日志尾部与错误信息。
 *   - auth=none 仅允许回环 host;非回环强制 password(未配置 token 则拒绝启动)。
 *   - 挂载于 ctx.effect:插件销毁(host 关闭/卸载)时回收自己启动的进程与路由。
 *
 * API(同源 fetch;web 与 desktop 同一套路径):
 *   GET  /api/code-server/status → { ok, running, status, port, pid, cwd, url,
 *                                    version, error, logTail[, adopted] }
 *   POST /api/code-server/start  { cwd? } → 幂等启动(换 cwd 则先停后启) → status
 *   POST /api/code-server/stop   → 停止 → status
 */

import { spawn, execFile, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  PACKAGE_ROOT,
  codeServerEntry,
  codeServerPackageName,
  legacyInstallRoot,
  productPath,
  readTreeVersion,
  vendoredVersion,
  vendorReady,
  vsRoot,
  vsServerEntry,
} from './vendor.js';
import { aliasNodePathDirs, ensureRuntimeLayout, resolveRuntime, runtimePackageName, verifyNatives } from './native.js';
import { MOUNT_PATH, mountOnWebServer } from './serve-dsh.mjs';

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
// connection:client↔host 通道(web 走 webServer 的 /api,desktop 走 IPC 帧管道);
// settings:设置卡片的数据域。两者在 web 与 desktop profile 下都存在。
export const inject = ['connection', 'settings'];

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
  /** 服务方式:loopback(默认)独立回环端口;dsh 挂到 DSH webServer 的 /code-server
   *  (同源、无额外端口、复用 DSH 的 Host/Origin + cookie 防护;需要 DSH 提供 webServer 服务,
   *  缺失或注册失败时自动回退 loopback)。 */
  serve: z.union([z.const('loopback'), z.const('dsh')]).default('loopback'),
  /** keepResident=true(默认)客户端在宿主 running 后把 IDE 预先加载到"停放区",
   *  切标签/收起侧栏不再重载;false 则只在打开面板时才加载(省内存)。 */
  keepResident: z.boolean().default(true),
});

const DEFAULT_CONFIG = {
  bin: '',
  host: '127.0.0.1',
  port: 8090,
  auth: 'none',
  serve: 'loopback',
  userDataDir: '',
  extensionsDir: '',
  locale: '',
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

/** 插件自带 launcher(<pkg>/lib/launcher.mjs);它直接驱动 VS Code server(0.2.0 模型)。 */
function launcherPath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'launcher.mjs');
}

/** code-server 兼容入口(旧全量树才有 out/node/entry.js);新树返回 null。 */
function bundledRuntimeEntry() {
  try {
    return codeServerEntry();
  } catch {
    return null;
  }
}

/** 扩展安装目标:VS Code「内置扩展」目录 = <树>/lib/vscode/extensions。
 *  (位于程序内置目录的扩展被 VS Code 视为内置——用户视图显示为"内置",不可卸载;
 *   --extensions-dir 的是用户级扩展,可被用户禁用/卸载。)
 *  返回 { dst, builtin }——builtin=true 时为核心路径;找不到树则回退用户级。 */
function extensionTarget(extensionsDir) {
  try {
    const root = vsRoot();
    if (root !== null) {
      const vscodeExt = path.join(root, 'lib', 'vscode', 'extensions');
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

/** 插件 package.json 里声明的内部依赖(纯 JS 直装集;排除 VS Code 树包本身)。 */
function declaredInnerDeps() {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
    return Object.keys(manifest.dependencies ?? {})
      .filter((name) => !/^@[^/]+\/dshcs-(vscode-server|code-server)$/.test(name));
  } catch {
    return [];
  }
}

/** 从 VS Code 树位置解析内部依赖(与运行时同一套向上查找规则)。
 *  先试 `<name>/package.json`(ESM-only 包没有 require 入口),再退回 `<name>` 本身。 */
function checkInnerDeps() {
  const declared = declaredInnerDeps();
  const root = vsRoot();
  const from = createRequire(path.join(root ?? PACKAGE_ROOT, 'package.json'));
  const missing = [];
  let resolved = 0;
  for (const name of declared) {
    let ok = false;
    for (const spec of [`${name}/package.json`, name]) {
      try {
        from.resolve(spec);
        ok = true;
        break;
      } catch { /* 试下一个 */ }
    }
    if (ok) resolved += 1;
    else missing.push(name);
  }
  return { declared: declared.length, resolved, missing };
}

/** 环境检测:VS Code 树 + server 入口 + 内部依赖 + 预编译原生包。
 * 返回 { ok, tree, entry, productPath, vscodeInner, innerDeps, treeVersion, vendored, upToDate, nativeRuntime, node, platform, arch }。 */
function envCheck() {
  const root = vsRoot();
  const entry = vsServerEntry();
  const inner = checkInnerDeps();
  const runtime = resolveRuntime();
  const natives = verifyNatives(runtime !== null ? runtime.modules : []);
  const installed = root !== null ? readTreeVersion(root) : null;
  const vendored = vendoredVersion();
  return {
    ok: entry !== null && inner.missing.length === 0
      && runtime !== null && natives.missing.length === 0,
    tree: root !== null ? root.replace(/\\/g, '/') : null,
    entry: entry !== null ? entry.replace(/\\/g, '/') : null,
    productPath: productPath(root),
    vscodeInner: inner.missing.length === 0,
    innerDeps: { declared: inner.declared, resolved: inner.resolved, missing: inner.missing },
    treeVersion: installed,
    vendored,
    upToDate: installed !== null && vendored !== null && installed === vendored,
    // 本平台预编译原生产物(平台聚合包 + 它带回原始名字的原生模块)
    nativeRuntime: runtime !== null
      ? {
        name: runtime.name,
        source: 'package',
        version: runtime.version,
        packages: natives.resolved.length,
        missing: natives.missing,
      }
      : { name: runtimePackageName(), source: null, version: null, packages: 0, missing: [] },
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  };
}

/** 解析启动方式:
 *  - 默认:插件自带 launcher(node lib/launcher.mjs)+ 内置 VS Code 树;
 *  - `bin` 显式配置时按旧模型当逃生舱:可执行文件 / code-server 的 out/node/entry.js。 */
function resolveLaunch(config, serve) {
  const configured = typeof config.bin === 'string' && config.bin !== '' && config.bin !== DEFAULT_CONFIG.bin
    ? config.bin
    : null;
  if (configured === null) {
    const root = vsRoot();
    if (root === null || vsServerEntry() === null) {
      throw new Error(
        '找不到 VS Code 树(缺 lib/vscode/out/server-main.js)。请重新安装插件'
        + '(`dsh plugin --profile web add dsh-code-server-app`),'
        + '开发期先用 `node scripts/vendor-vscode-server.mjs --dev-links` 生成 vendor/vscode。',
      );
    }
    return { kind: 'launcher', script: launcherPath(), tree: root };
  }
  console.log(`[code-server] resolveLaunch: 使用显式配置的 bin=${configured}(launcher 旁路)`);
  if (/\.(js|mjs|cjs)$/i.test(configured)) {
    if (!fs.existsSync(configured)) throw new Error(`配置的入口不存在: ${configured}`);
    return { kind: 'node', script: configured };
  }
  if (path.isAbsolute(configured)) return { kind: 'bin', command: configured };
  try {
    if (win32()) {
      const out = execFileSync('where.exe', [configured], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      return { kind: 'bin', command: lines.find((l) => /\.cmd$/i.test(l)) ?? lines.find((l) => /\.exe$/i.test(l)) ?? lines[0] };
    }
    const out = execFileSync('which', [configured], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return { kind: 'bin', command: out.split('\n')[0].trim() };
  } catch {
    throw new Error(`配置的 bin 未找到("${configured}" 不在 PATH)`);
  }
}

/** 命名管道名(仅 dsh 模式使用):按 profile/pid 稳定,避免撞名。 */
function pipeName() {
  const key = `${process.pid}`;
  return win32() ? `\\\\.\\pipe\\dshcs-vscode-${key}` : path.join(os.tmpdir(), `dshcs-vscode-${key}.sock`);
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

/** 命名管道上的 /healthz 探针(dsh 模式;管道由 launcher 监听)。 */
function healthCheckPipe(pipe, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.request({ socketPath: pipe, path: '/healthz', method: 'GET', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 500, statusCode: res.statusCode });
    });
    req.on('error', () => resolve({ ok: false }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false });
    });
    req.end();
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
  // connection 是 host↔client 通道(必需);提前取出,供 DSH 同源挂载的 fence 使用。
  const connection = ctx.get('connection');
  if (connection === undefined || connection.fetch === undefined) {
    console.error('[code-server] connection service unavailable; plugin registered but idle');
    return;
  }
  let reserveComposer = true;
  let windowedOpen = false;
  let serveSetting = 'loopback';
  let keepResident = true; // 客户端常驻预热(0.2.2)
  if (settingsSvc !== undefined && typeof settingsSvc.register === 'function') {
    try {
      const scope = settingsSvc.register(SETTINGS_NS, Config);
      const rawDoc = settingsSvc.get(SETTINGS_NS);
      if (rawDoc !== undefined && rawDoc !== null) {
        const resolved = scope.get();
        reserveComposer = resolved && typeof resolved.reserveComposer === 'boolean' ? resolved.reserveComposer : true;
        windowedOpen = resolved && typeof resolved.windowedOpen === 'boolean' ? resolved.windowedOpen : false;
        serveSetting = resolved && resolved.serve === 'dsh' ? 'dsh' : 'loopback';
        keepResident = resolved && typeof resolved.keepResident === 'boolean' ? resolved.keepResident : true;
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
        if (next != null && (next.serve === 'dsh' || next.serve === 'loopback')) {
          if (next.serve !== serveSetting) {
            serveSetting = next.serve;
            console.log(`[code-server] serve updated: ${serveSetting}(下次启动生效)`);
          }
        }
        if (next != null && typeof next.keepResident === 'boolean') {
          keepResident = next.keepResident;
          console.log(`[code-server] keepResident updated: ${keepResident}`);
        }
      });
    } catch (error) {
      console.error(`[code-server] settings unavailable; using defaults (reserveComposer=true, windowedOpen=false): ${error.message}`);
    }
  }

  // 依赖布局自愈必须发生在任何解析之前:精简树不含 lib/vscode/node_modules,
  // 由这里按插件依赖图补 junction(幂等;重装后自愈)。
  const layout = ensureRuntimeLayout();

  // ---- 服务方式:settings/行配置请求 dsh,但只有本 deployment 真的提供 webServer 时才用 ----
  let webServerSvc = ctx.get('webServer');
  let dshMount = null; // { disposers, upgradePath } —— 由下面的 ctx.inject 填充

  /** 生效的服务方式:loopback(默认,独立回环端口)| dsh(DSH 同源挂载)。 */
  function requestedServe() {
    const want = serveSetting === 'dsh' || cfg.serve === 'dsh' ? 'dsh' : 'loopback';
    if (want === 'loopback') return 'loopback';
    if (webServerSvc === undefined || dshMount === null) {
      console.warn('[code-server] serve=dsh 但 webServer 不可用/挂载失败 → 回退 loopback');
      return 'loopback';
    }
    return 'dsh';
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
    serve: 'loopback', // 实际生效的服务方式(loopback | dsh)
    pipe: null, // dsh 模式下的命名管道
    env: envCheck(), // 环境检测(VS Code 树 / server 入口 / 内部依赖 / 预编译原生包)
    setup: { running: false, done: true, ok: true, logTail: '0.1.36 起由包管理器安装依赖,无需「安装环境」步骤', startedAt: null, finishedAt: null }, // 兼容旧客户端
  };

  let child = null;
  let pollTimer = null;
  let disposeKilled = false;

  // ---- DSH 同源挂载(serve=dsh):把 /code-server 注册到 DSH 自己的 webServer ----
  // webServer 只在 web profile 存在(desktop 显式禁用该行)→ 用 ctx.inject 特性检测,
  // 缺失时 requestedServe() 自动回退 loopback。
  ctx.inject(['webServer'], (wsCtx) => {
    webServerSvc = wsCtx.webServer;
    try {
      dshMount = mountOnWebServer({
        webServer: wsCtx.webServer,
        connection,
        // 目标随时可变:launcher 重启会换管道/端口,未运行时返回 null(路由回 503)
        getTarget: () => (state.serve === 'dsh' && state.pipe !== null ? { kind: 'pipe', pipe: state.pipe } : null),
        productPath: state.env?.productPath ?? productPath() ?? 'stable',
      });
      console.log(`[code-server] serve=dsh 挂载就绪:${MOUNT_PATH}/ (HTTP)+ ${dshMount.upgradePath} (WS)`);
    } catch (error) {
      dshMount = null;
      console.error(`[code-server] serve=dsh 挂载失败(将回退 loopback):${error && error.message ? error.message : error}`);
    }
  });

  ctx.effect(() => () => {
    if (dshMount === null) return;
    for (const dispose of dshMount.disposers) {
      try { dispose(); } catch { /* ignore */ }
    }
  }, 'code-server: dsh mount');

  function snapshot() {
    const running = state.status === 'running' && state.pid !== null;
    const dshMode = state.serve === 'dsh';
    return {
      ok: state.status !== 'error' || running,
      running,
      status: state.status,
      serve: state.serve,
      port: dshMode ? null : state.port,
      host: dshMode ? null : cfg.host,
      pid: state.pid,
      cwd: state.cwd,
      // dsh 模式:同源相对地址(由 DSH webServer 的 prefix 路由提供服务)
      url: running ? (dshMode ? '/code-server/' : `http://${cfg.host}:${state.port}/`) : null,
      productPath: state.env?.productPath ?? null,
      version: state.version,
      error: state.error,
      logTail: state.logTail.slice(-LOG_TAIL_MAX),
      adopted: state.adopted,
      reserveComposer,
      windowedOpen,
      keepResident,
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

  /** 读旧版(≤0.1.35)环境安装失败标记文件;新版不再有安装步骤 → 通常为 null。
   *  标记在旧安装根:<profile>\.code-server-app\last-setup-error.json。 */
  function readLastSetupError() {
    try {
      const root = legacyInstallRoot();
      if (root === null) return null;
      const marker = path.join(root, 'last-setup-error.json');
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

  /** 就绪探针:loopback 走 TCP,dsh 模式走命名管道。 */
  function probeReady(timeoutMs = 1500) {
    if (state.pipe !== null) return healthCheckPipe(state.pipe, timeoutMs);
    return healthCheck(cfg.host, state.port, timeoutMs);
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
      const probe = await probeReady();
      if (probe.ok) {
        stopPolling();
        state.status = 'running';
        return;
      }
      if (Date.now() > deadline) {
        stopPolling();
        state.status = 'error';
        state.error = `启动超时(${cfg.readyTimeoutMs}ms 内 /healthz 未就绪);启动日志尾部:\n${state.logTail.slice(-2000)}`;
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

    const serve = requestedServe(); // loopback | dsh(按 DSH 是否提供 webServer 定)
    const launch = resolveLaunch(cfg, serve); // throws with install guidance when missing

    if (serve === 'loopback' && !LOOPBACK_HOSTS.has(cfg.host)) {
      state.status = 'error';
      state.error = `serve=loopback 仅允许回环绑定(当前 host="${cfg.host}");`
        + '如需对外提供服务,请改用 serve=dsh(挂到 DSH 同源路径,由 DSH 统一防护)';
      return snapshot();
    }
    if (cfg.auth === 'password') {
      console.warn('[code-server] 0.2.0 起不再支持口令认证(argon2 已移除),按 auth=none 运行');
    }

    // 端口占用则尝试 adopt(仅 loopback 模式;pid.json 有效 + /healthz 响应),否则报错
    if (serve === 'loopback') {
      const probe = await healthCheck(cfg.host, cfg.port, 800);
      if (probe.ok) {
        const record = readPidFile(cfg);
        if (record && isAlive(record.pid)) {
          state.serve = 'loopback';
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
    }

    // 重建数据目录
    const root = dataRoot(cfg);
    const userDataDir = cfg.userDataDir || path.join(root, 'user-data');
    const extensionsDir = cfg.extensionsDir || path.join(root, 'extensions');
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(extensionsDir, { recursive: true });

    // 安装内置扩展(dshcs-open-file:host 信号文件 → VS Code 打开文件)
    installBundledExtension(extensionsDir, userDataDir);

    const args = launch.kind === 'launcher'
      ? [
        launch.script,
        '--tree', launch.tree,
        '--user-data-dir', userDataDir,
        '--extensions-dir', extensionsDir,
        '--parent-pid', String(process.pid),
      ]
      : [
        '--bind-addr', `${cfg.host}:${cfg.port}`,
        '--auth', 'none',
        '--user-data-dir', userDataDir,
        '--extensions-dir', extensionsDir,
        '--disable-telemetry',
        '--disable-update-check',
      ];
    if (launch.kind === 'launcher') {
      if (serve === 'dsh') {
        state.pipe = pipeName();
        args.push('--pipe', state.pipe);
      } else {
        state.pipe = null;
        args.push('--port', String(cfg.port), '--host', cfg.host);
      }
      if (typeof cfg.locale === 'string' && cfg.locale !== '') args.push('--locale', cfg.locale);
    }
    if (cwd !== undefined && launch.kind !== 'launcher') args.push(cwd);

    state.serve = serve;
    state.error = null;
    state.logTail = '';
    state.status = 'starting';
    state.cwd = cwd ?? null;
    state.startedAt = Date.now();
    state.adopted = false;

    const env = { ...process.env };
    // 内置扩展信号文件路径(host → 扩展 打开文件)
    env.DSHCS_OPEN_FILE_SIGNAL = openFileSignalPath(userDataDir);
    // pnpm 会把带 os/cpu 限定的原生包嵌套装在平台聚合包下(如 <profile>/node_modules/@<scope>/
    // dsh-code-server-runtime-<平台>-<架构>/node_modules/@vscode/spdlog),那些目录不在 VS Code
    // 树的向上查找链里 → 用 NODE_PATH 让子进程的 require 找得到(CJS;ESM 由 ensureAliasLinks 的 junction 负责)。
    const nodePathDirs = aliasNodePathDirs();
    if (nodePathDirs.length > 0) {
      const existing = typeof env.NODE_PATH === 'string' && env.NODE_PATH !== '' ? env.NODE_PATH.split(path.delimiter) : [];
      env.NODE_PATH = [...new Set([...nodePathDirs, ...existing])].join(path.delimiter);
    }

    let proc;
    try {
      // 启动前再自愈一次依赖布局(插件重装/树被替换后可能丢失;幂等且只做存在性检查)
      ensureRuntimeLayout();
      const isCmd = launch.kind === 'bin' && win32() && /\.cmd$/i.test(launch.command);
      const command = launch.kind === 'bin' ? launch.command : process.execPath;
      const spawnArgs = launch.kind === 'bin' ? args : [launch.script, ...args];
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
      host: serve === 'dsh' ? null : cfg.host,
      port: serve === 'dsh' ? null : cfg.port,
      serve,
      pipe: state.pipe,
      launchKind: launch.kind,
      launchCommand: launch.kind === 'bin' ? launch.command : launch.script,
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

  /** 0.1.36 起没有「安装环境」步骤:code-server 随插件包发布,内部依赖与预编译原生模块
   *  都由包管理器在 `dsh plugin add` 时装好。这里只做一次重新自检(兼容旧客户端的按钮)。 */
  function refreshEnv() {
    state.env = envCheck();
    state.setup = {
      running: false,
      done: true,
      ok: state.env.ok,
      logTail: state.env.ok
        ? '环境已就绪(依赖由包管理器安装,无需安装步骤)'
        : `环境未就绪:${describeEnvProblem(state.env)}`,
      startedAt: null,
      finishedAt: Date.now(),
    };
    return state.setup;
  }

  /** 环境问题的一句话描述(状态卡/日志共用)。 */
  function describeEnvProblem(env) {
    const parts = [];
    if (env.tree === null) parts.push(`缺少 VS Code 树(包内 vendor/vscode 或 dshcs-vscode-server 未安装)`);
    else if (env.entry === null) parts.push('树里缺少 lib/vscode/out/server-main.js');
    if (env.vscodeInner !== true) {
      const missing = Array.isArray(env.innerDeps?.missing) ? env.innerDeps.missing : [];
      parts.push(`内部依赖未装全(缺 ${missing.length} 个:${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ' …' : ''})`);
    }
    if (env.nativeRuntime !== null && env.nativeRuntime.source === null) {
      parts.push(`平台预编译包未安装(${env.nativeRuntime.name})`);
    } else if (Array.isArray(env.nativeRuntime?.missing) && env.nativeRuntime.missing.length > 0) {
      parts.push(`原生模块解析失败:${env.nativeRuntime.missing.slice(0, 5).join(', ')}`);
    }
    return parts.length > 0 ? parts.join('; ') : '未知问题';
  }

  // ---- /api/code-server 路由(Connection 共享通道;web 与 desktop 通用) ----
  const API_BASE = '/api/code-server';

  /** JSON 响应(与旧 webServer JSON API 相同的载荷形状)。 */
  function jsonResponse(value, status = 200) {
    return new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  /** 读取 JSON 请求体;空体 / 非法 JSON 回退为 {}(旧实现是逐块 best-effort 合并)。 */
  async function readJsonBody(request) {
    try {
      const value = await request.json();
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  }

  /** 统一的失败载荷(HTTP 200 + ok:false,客户端按 ok 判定)。 */
  function failureResponse(err) {
    return jsonResponse({
      ok: false,
      error: err && err.message ? err.message : String(err),
      runner: 'code-server',
    });
  }

  async function handleStatus() {
    return jsonResponse(snapshot());
  }

  async function handleStart(request) {
    try {
      const body = await readJsonBody(request);
      const cwd = typeof body.cwd === 'string' ? body.cwd : undefined;
      return jsonResponse(await start(cwd));
    } catch (err) {
      return failureResponse(err);
    }
  }

  async function handleStop() {
    try {
      await stop('user');
      return jsonResponse(snapshot());
    } catch (err) {
      return failureResponse(err);
    }
  }

  async function handleSetup() {
    try {
      // 兼容旧客户端:0.1.36 起没有安装步骤,这里只重新自检并返回结果。
      const setup = refreshEnv();
      return jsonResponse({
        ...snapshot(),
        ok: true,
        message: setup.ok ? '环境已就绪,无需安装' : `环境未就绪:${setup.logTail}`,
        error: null,
      });
    } catch (err) {
      return failureResponse(err);
    }
  }

  async function handleOpenFile(request) {
    try {
      // 打开文件:host 写信号文件,内置扩展(dshcs-open-file)在 VS Code 中打开它
      const body = await readJsonBody(request);
      const file = typeof body.file === 'string' ? body.file : null;
      if (file === null || file === '') {
        return jsonResponse({ ok: false, error: '需要 file 字段(要打开的绝对路径)' }, 400);
      }
      const root = dataRoot(cfg);
      const userDataDir = cfg.userDataDir || path.join(root, 'user-data');
      const signal = openFileSignalPath(userDataDir);
      fs.mkdirSync(path.dirname(signal), { recursive: true });
      fs.writeFileSync(signal, JSON.stringify({ file, ts: Date.now() }), 'utf8');
      return jsonResponse({ ok: true, signal });
    } catch (err) {
      return failureResponse(err);
    }
  }

  // 每条操作一条 exact Fetch 路由。desktop 的 assetHandler 只把 /api/* 交给
  // createSharedFetchHandler('/api'),所以路径必须落在 /api 下。
  const disposers = [    { path: `${API_BASE}/status`, methods: ['GET'], fetch: handleStatus },
    { path: `${API_BASE}/start`, methods: ['POST'], fetch: handleStart },
    { path: `${API_BASE}/stop`, methods: ['POST'], fetch: handleStop },
    { path: `${API_BASE}/setup`, methods: ['POST'], fetch: handleSetup },
    { path: `${API_BASE}/open-file`, methods: ['POST'], fetch: handleOpenFile },
  ].map(route => connection.fetch.register({
    path: route.path,
    methods: route.methods,
    requestBody: 'buffered',
    fetch: route.fetch,
  }));

  ctx.effect(() => {
    return () => {
      disposeKilled = true;
      stopPolling();
      for (const d of disposers) {
        try {
          // connection.fetch.register 的 disposer 是异步的(返回 Promise);
          // 注册本身也挂在当前 fiber 上,这里显式回收只是双保险。
          Promise.resolve(d()).catch(() => {});
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

  // ---- 环境自检:code-server 就在插件目录里就地运行,依赖由包管理器装好,无任何安装步骤 ----
  const record = readPidFile(cfg);
  const liveInstance = record !== undefined && record !== null && isAlive(record.pid);

  function maybePrestart() {
    // 环境就绪且未运行 → 后台自动拉起(不等待),悬浮球打开时 iframe 立即加载。
    if (state.env.ok && state.status !== 'running' && state.status !== 'starting') {
      start().catch((err) => {
        console.error('[code-server] prestart failed:', err && err.message ? err.message : String(err));
      });
    }
  }

  state.env = envCheck();
  // layout 已在本函数开头算过(envCheck 之前):这里只报告结果。
  if (layout.created.length > 0) {
    console.log(`[code-server] 已补齐 ${layout.created.length} 个依赖链接: ${layout.created.join(', ')}`);
  }
  if (layout.failed.length > 0) {
    console.warn(`[code-server] 依赖链接创建失败: ${layout.failed.join('; ')}`);
  }
  if (!vendorReady()) {
    console.warn(`[code-server] 找不到 VS Code 树:平台无关包 ${codeServerPackageName()} 未安装,`
      + '且包内 vendor/vscode 不存在(开发期请先 `node scripts/vendor-vscode-server.mjs --dev-links`)');
  } else {
    console.log(`[code-server] VS Code 树: ${vsRoot()}(productPath=${state.env.productPath ?? '?'})`);
  }
  if (!state.env.ok) {
    console.warn(`[code-server] 环境未就绪: ${describeEnvProblem(state.env)}`);
  }
  const legacyRoot = legacyInstallRoot();
  if (legacyRoot !== null && fs.existsSync(legacyRoot)) {
    console.log(`[code-server] 检测到旧版安装根 ${legacyRoot}(0.1.35 及更早遗留,已不再使用,可安全删除)`);
  }

  // DSH host 重启后 adopt(仅 loopback 模式):pid.json 有效且进程存活且 /healthz 响应 → 接管。
  // dsh 模式的 launcher 带 --parent-pid 看门狗:host 一退出它就自行退出,不存在可接管的孤儿。
  if (liveInstance && (record.serve !== 'dsh')) {
    const probe = await healthCheck(cfg.host, cfg.port, 800);
    if (probe.ok) {
      state.serve = 'loopback';
      state.status = 'running';
      state.pid = record.pid;
      state.cwd = record.cwd ?? null;
      state.startedAt = record.startedAt ?? null;
      state.adopted = true;
      console.log(`[code-server] adopted running instance pid=${record.pid} port=${cfg.port}`);
    } else {
      removePidFile(cfg);
    }
  } else if (liveInstance) {
    removePidFile(cfg); // 上次是 dsh 模式(管道随进程消失)→ 清理陈旧记录
  }

  maybePrestart();

  console.log(`[code-server] static plugin loaded (serve=${requestedServe()} host=${cfg.host} port=${cfg.port})`);
}
