/**
 * dsh-code-server — host 半部:VS Code server 子进程(lib/launcher.mjs)的生命周期/状态 + /api/code-server JSON API。
 *
 * 模型:不运行 code-server 的 Node 服务层,直接由 lib/launcher.mjs 驱动树里的
 * <树>/lib/vscode/out/server-main.js(树 = @<scope>/dshcs-vscode-server 的 vscode/ 子目录);
 * 依据与实测见 docs/analysis-code-server-as-dsh-plugin.md。零外部依赖(只用 Node 内置模块)。
 * 静态 profile 插件:exports.name 与 cordis.patch.yml 行 id 一致;inject = ['connection','settings']。
 *
 * 路由经 ctx.connection.fetch.register 挂在 Connection 的共享 /api 通道上(**不依赖 webServer**):
 *   web profile 由 Connection 把 /api 挂到 webServer;desktop 由 apps/desktop-host 交给同一个
 *   createSharedFetchHandler('/api')(IPC 帧管道)→ 客户端只需同源 fetch('/api/code-server/<op>')。
 *   GET  status | POST start{cwd?} | stop | setup(兼容空操作) | open-file{file,line?} | ui-mode{sidebar}
 *
 * 不变量:进程生命周期归本插件(启动写 pid.json,停止树级终止);host 重启后按 pid.json + /healthz
 * adopt 存活实例(不重复启动、不误杀);auth 固定 none(0.2.0 起不再支持口令);插件销毁时回收进程与路由。
 * 旧版 DSH(客户端上报 {sidebar:false})会在此回收"自动预启动"的实例并停止预启动。
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
import { DEFAULT_CLAIM_EXTENSIONS, describeClaimPolicy, normalizeClaimExtensions } from './claim-types.js';

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

/** 设置卡片 schema(只留三个可改设置:claimExtensions / fullscreenOnOpen / keepResident)。
 *  旧设置文档里残留的 reserveComposer / windowedOpen / fileOpenScope 不再出现在 schema 里 ——
 *  schemastery 的 object 非 strict 会把未知键原样 merge 进解析结果,既不报错也不影响取值,故无需迁移。 */
export const Config = z.object({
  /** 服务方式:loopback(默认)独立回环端口;dsh 挂到 DSH webServer 的 /code-server
   *  (同源、无额外端口、复用 DSH 的 Host/Origin + cookie 防护;需要 DSH 提供 webServer 服务,
   *  缺失或注册失败时自动回退 loopback)。没有卡片行:改 cordis.patch.yml 的 config.serve
   *  或设置文档里的 code-server.serve。 */
  serve: z.union([z.const('loopback'), z.const('dsh')]).default('loopback'),
  /** keepResident=true(默认)客户端在宿主 running 后把 IDE 预先加载到"停放区",
   *  切标签/收起侧栏不再重载;false 则只在打开面板时才加载(省内存)。 */
  keepResident: z.boolean().default(true),
  /** 认领类型(0.2.11):按扩展名决定哪些文件交给 VS Code 打开(分号分隔,`*` = 其余类型也认领,
   *  `!ext` = 不认领,排除优先)。**不再区分 session/absolute 作用域** —— 所有
   *  `dsh-resource://file/**` 地址一视同仁。语法、默认值与解析见 lib/claim-types.js。 */
  claimExtensions: z.string().default(DEFAULT_CLAIM_EXTENSIONS),
  /** fullscreenOnOpen=true(默认):打开 Code Server 标签(含点开产物/交付文件)时,
   *  客户端把右侧栏切到全屏(铺满窗口);false 则保持 DSH 默认的 push(与对话并排)。
   *  只影响"打开那一刻":之后用户点「退出全屏」不会被抢回去。 */
  fullscreenOnOpen: z.boolean().default(true),
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

/** 本插件的 package.json 版本(?v= 缓存击穿标记用;读不到就退回 'dev')。 */
function pluginVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version ?? 'dev';
  } catch {
    return 'dev';
  }
}

/** 插件自带 launcher(<pkg>/lib/launcher.mjs);它直接驱动 VS Code server(0.2.0 模型)。 */
function launcherPath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'launcher.mjs');
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

/** 内置扩展安装:dshcs-open-file(host 信号文件 → VS Code 打开文件,可带行号)。
 *  优先装进 code-server 内置扩展目录(不可卸载);同时清理用户级旧副本。
 *  每次启动调用:缺失**或内容有变化**即同步(自愈,且插件升级后能更新已装的旧副本)。 */
function installBundledExtension(extensionsDir, userDataDir) {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = path.join(here, '..', 'assets', 'extensions', 'dshcs-open-file');
    if (!fs.existsSync(path.join(src, 'package.json'))) return;
    const target = extensionTarget(extensionsDir);
    const dst = target.dst;
    const files = ['package.json', 'extension.js'];
    const stale = files.filter((name) => {
      const to = path.join(dst, name);
      if (!fs.existsSync(to)) return true;
      try {
        return fs.readFileSync(path.join(src, name), 'utf8') !== fs.readFileSync(to, 'utf8');
      } catch {
        return true;
      }
    });
    if (stale.length > 0) {
      fs.mkdirSync(dst, { recursive: true });
      for (const name of stale) fs.copyFileSync(path.join(src, name), path.join(dst, name));
    }
    // 清理用户级旧副本(避免重复/可卸载副本)
    const legacy = path.join(extensionsDir, 'dshcs-open-file');
    if (legacy !== dst && fs.existsSync(legacy)) {
      fs.rmSync(legacy, { recursive: true, force: true });
    }
    console.log(`[code-server] bundled extension dshcs-open-file -> ${dst}${target.builtin ? ' (内置,不可卸载)' : ' (用户级回退)'}${stale.length > 0 ? ` [更新 ${stale.join(',')}]` : ''}`);
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
  let serveSetting = 'loopback';
  let keepResident = true; // 客户端常驻预热(0.2.2)
  let claimExtensions = DEFAULT_CLAIM_EXTENSIONS; // 认领类型清单(0.2.11,取代 fileOpenScope)
  let fullscreenOnOpen = true; // 客户端"打开标签即全屏右侧栏"(0.2.9)
  if (settingsSvc !== undefined && typeof settingsSvc.register === 'function') {
    try {
      const scope = settingsSvc.register(SETTINGS_NS, Config);
      const rawDoc = settingsSvc.get(SETTINGS_NS);
      if (rawDoc !== undefined && rawDoc !== null) {
        const resolved = scope.get();
        serveSetting = resolved && resolved.serve === 'dsh' ? 'dsh' : 'loopback';
        keepResident = resolved && typeof resolved.keepResident === 'boolean' ? resolved.keepResident : true;
        claimExtensions = resolved && typeof resolved.claimExtensions === 'string'
          ? normalizeClaimExtensions(resolved.claimExtensions)
          : DEFAULT_CLAIM_EXTENSIONS;
        fullscreenOnOpen = resolved && typeof resolved.fullscreenOnOpen === 'boolean' ? resolved.fullscreenOnOpen : true;
      }
      scope.watch((next) => {
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
        if (next != null && typeof next.claimExtensions === 'string') {
          const normalized = normalizeClaimExtensions(next.claimExtensions);
          if (normalized !== claimExtensions) {
            claimExtensions = normalized;
            console.log(`[code-server] claimExtensions updated: ${claimExtensions} (${describeClaimPolicy(claimExtensions)})`);
          }
        }
        if (next != null && typeof next.fullscreenOnOpen === 'boolean') {
          if (next.fullscreenOnOpen !== fullscreenOnOpen) {
            fullscreenOnOpen = next.fullscreenOnOpen;
            console.log(`[code-server] fullscreenOnOpen updated: ${fullscreenOnOpen}`);
          }
        }
      });
    } catch (error) {
      console.error(`[code-server] settings unavailable; using defaults (claimExtensions=${DEFAULT_CLAIM_EXTENSIONS}, fullscreenOnOpen=true, keepResident=true): ${error.message}`);
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
    /** 进程**启动时**的工作目录(诊断用):运行时切工作区只改 cwd,进程 cwd 保持这里不变。 */
    launchCwd: null,
    version: null,
    error: null,
    logTail: '',
    startedAt: null,
    adopted: false,
    serve: 'loopback', // 实际生效的服务方式(loopback | dsh)
    pipe: null, // dsh 模式下的命名管道
    /** 客户端上报的 UI 载体能力:null=未上报 | true=带右侧栏(受支持) | false=旧版 DSH(只提示,不预启动) */
    sidebarUi: null,
    /** 本实例是否由插件的自动预启动拉起(旧版 DSH 上报后据此回收,不动用户/被 adopt 的实例) */
    prestarted: false,
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
      launchCwd: state.launchCwd,
      // dsh 模式:同源相对地址(由 DSH webServer 的 prefix 路由提供服务)
      url: running ? (dshMode ? '/code-server/' : `http://${cfg.host}:${state.port}/`) : null,
      productPath: state.env?.productPath ?? null,
      version: state.version,
      error: state.error,
      logTail: state.logTail.slice(-LOG_TAIL_MAX),
      adopted: state.adopted,
      keepResident,
      claimExtensions, // 客户端据此按扩展名决定认领哪些文件(0.2.11,取代 fileOpenScope)
      fullscreenOnOpen, // 客户端据此决定"打开标签即全屏右侧栏"(0.2.9)
      sidebarUi: state.sidebarUi,
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
    state.launchCwd = null;
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

  /** 启动串行化:apply 期的**预启动**与界面点击的启动可能并发,而两者写同一份 pid.json、
   *  抢同一个端口 —— 并发进入会双开 launcher(第二个绑不上端口 ⇒ 状态被顶成 error,
   *  表现为"点一下启动就报端口被占用")。串成一条链后,第二个调用会看到 running/starting
   *  并按既有逻辑复用。 */
  let startChain = Promise.resolve();
  function start(cwdArg) {
    const run = startChain.then(() => startInner(cwdArg), () => startInner(cwdArg));
    startChain = run.then(() => {}, () => {});
    return run;
  }

  /** 已运行实例切换工作区:**只改"当前 workbench 目录",不重启进程**。
   *
   *  为什么够用:工作区目录由客户端 URL 的 `&folder=<绝对路径>` 决定(见 src/factory.js 的
   *  buildPageUrl),服务进程自己的 cwd 只影响它 spawn 时对相对路径的解析;真正"换目录"是
   *  workbench 拿新 folder 重新导航(客户端导航 iframe)。
   *  旧行为(0.2.11 及以前)在这里 stop('restart') + 重新 launch:切一次工作区就整进程重启,
   *  编辑缓冲、终端、扩展宿主状态全丢,而且侧栏收起时是在后台悄悄发生。
   *  进程 cwd 保持在 launchCwd 里,诊断时能看出"这个实例是哪个目录拉起来的"。 */
  function adoptWorkspace(cwd) {
    const previous = state.cwd;
    state.cwd = cwd;
    console.log(`[code-server] workspace switch: ${previous ?? '(none)'} -> ${cwd}`
      + `(不重启进程,进程 cwd 仍是 ${state.launchCwd ?? '(none)'};workbench 用新的 folder 重新导航)`);
    return snapshot();
  }

  async function startInner(cwdArg) {
    const cwd = typeof cwdArg === 'string' && cwdArg.trim() !== '' ? cwdArg : undefined;
    if (state.status === 'running' && state.pid !== null) {
      if (cwd === undefined || cwd === state.cwd) return snapshot();
      return adoptWorkspace(cwd);
    }
    // 上一次启动仍在进行:等待它结算后再决定(运行中则同上面一样只换目录,不重启)
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
        return adoptWorkspace(cwd);
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
          state.launchCwd = record.launchCwd ?? record.cwd ?? null;
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
    state.launchCwd = cwd ?? null;
    state.startedAt = Date.now();
    state.adopted = false;

    const env = { ...process.env };
    // 内置扩展信号文件路径(host → 扩展 打开文件)
    env.DSHCS_OPEN_FILE_SIGNAL = openFileSignalPath(userDataDir);
    // ?v= 缓存击穿标记:按"插件版本 + VS Code 树"生成 —— 只在真升级时让渲染器丢掉旧 bundle,
    // 平时正常命中缓存(workbench.js 有 18MB,每次启动都重拉不划算)。
    env.DSHCS_HTML_TAG = `${pluginVersion()}-${productPath() ?? 'dev'}`.replace(/[^A-Za-z0-9._-]/g, '');
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
      launchCwd: cwd ?? null,
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
      // 打开文件:host 写信号文件,内置扩展(dshcs-open-file)在 VS Code 中打开它。
      // 0.2.5 起客户端只在"认领到文件地址"时调用本路由(address → 绝对路径);line 可选(1 基)。
      const body = await readJsonBody(request);
      const file = typeof body.file === 'string' ? body.file : null;
      if (file === null || file === '') {
        return jsonResponse({ ok: false, error: '需要 file 字段(要打开的绝对路径)' }, 400);
      }
      const line = Number.isSafeInteger(body.line) && body.line > 0 ? body.line : null;
      const root = dataRoot(cfg);
      const userDataDir = cfg.userDataDir || path.join(root, 'user-data');
      const signal = openFileSignalPath(userDataDir);
      fs.mkdirSync(path.dirname(signal), { recursive: true });
      fs.writeFileSync(signal, JSON.stringify(line === null ? { file, ts: Date.now() } : { file, line, ts: Date.now() }), 'utf8');
      return jsonResponse({ ok: true, signal });
    } catch (err) {
      return failureResponse(err);
    }
  }

  /**
   * 客户端上报 UI 载体能力(0.2.3):{ sidebar: false } = 旧版 DSH(没有右侧栏服务)。
   * 旧版 DSH 上本插件不提供任何入口 → 这里回收「由本插件自动预启动」的实例,避免留下用不上的 IDE 进程;
   * 用户手动启动的实例(adopted)不动,后续也不再有 UI 触发启动。
   */
  async function handleUiMode(request) {
    try {
      const body = await readJsonBody(request);
      if (body !== null && typeof body.sidebar === 'boolean') {
        const next = body.sidebar;
        if (state.sidebarUi !== next) {
          state.sidebarUi = next;
          console.log(`[code-server] 客户端 UI 载体:${next ? '右侧栏(受支持)' : '无右侧栏(旧版 DSH,只给设置页提示)'}`);
        }
        if (next === false && state.prestarted === true && state.adopted !== true) {
          state.prestarted = false;
          if (state.status === 'running' || state.status === 'starting') {
            console.warn('[code-server] 旧版 DSH:回收自动预启动的实例(旧版已不受支持)');
            await stop('legacy-ui').catch(err => {
              console.error(`[code-server] 回收失败:${err && err.message ? err.message : err}`);
            });
          }
        }
      }
      return jsonResponse({ ok: true, sidebarUi: state.sidebarUi });
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
    { path: `${API_BASE}/ui-mode`, methods: ['POST'], fetch: handleUiMode },
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
    // 环境就绪且未运行 → 后台自动拉起(不等待),首次打开侧栏标签时 iframe 立即加载。
    // 旧版 DSH(客户端上报 sidebarUi=false)没有可用入口 → 不预启动,也不占端口。
    if (state.sidebarUi === false) return;
    if (state.env.ok && state.status !== 'running' && state.status !== 'starting') {
      state.prestarted = true;
      start().catch((err) => {
        state.prestarted = false;
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
      state.launchCwd = record.launchCwd ?? record.cwd ?? null;
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
