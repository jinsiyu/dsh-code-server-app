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

import { spawn, execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import { randomBytes } from 'node:crypto';
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
import { TUNNEL_PATH, TUNNEL_TOKEN_HEADER, createPipeTunnel } from './pipe-tunnel.mjs';
import { ASSET_BASE, ASSET_DOCUMENT, createAssetMirror } from './asset-mirror.mjs';

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

/** 设置卡片 schema(只留两个可改设置:keepResident / fileOpenScope)。
 *  旧设置文档里残留的 reserveComposer / windowedOpen 不再出现在 schema 里 —— schemastery 的
 *  object 非 strict 会把未知键原样 merge 进解析结果,既不报错也不影响取值,故无需迁移。 */
export const Config = z.object({
  /** 服务方式:loopback(默认)IDE 接到命名管道、客户端走同源资产镜像 + 隧道;dsh 挂到 DSH webServer
   *  的 /code-server(同源、无额外端口、复用 DSH 的 Host/Origin + cookie 防护;需要 DSH 提供 webServer
   *  服务)。没有卡片行:改 cordis.patch.yml 的 config.serve 或设置文档里的 code-server.serve。 */
  serve: z.union([z.const('loopback'), z.const('dsh')]).default('loopback'),
  /** keepResident=true(默认)客户端在宿主 running 后把 IDE 预先加载到"停放区",
   *  切标签/收起侧栏不再重载;false 则只在打开面板时才加载(省内存)。 */
  keepResident: z.boolean().default(true),
  /** 客户端认领哪些文件地址(哪些文件的点击交给 Code Server 打开):
   *  'session'(默认)= 只认领会话作用域的 `dsh-resource://file/session/…`(产物、交付、
   *  正文提及、工具视图都走这条);'all' = 连不带会话的 `dsh-resource://file/absolute/…` 也认领。
   *  未认领的地址由 DSH 自带预览兜底。 */
  fileOpenScope: z.union([z.const('session'), z.const('all')]).default('session'),
});

const DEFAULT_CONFIG = {
  auth: 'none',
  serve: 'loopback',
  userDataDir: '',
  extensionsDir: '',
  locale: '',
  readyTimeoutMs: 60000,
};

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
/** 解析启动方式:只有一条路 —— 插件自带 launcher(node lib/launcher.mjs)+ 内置 VS Code 树。
 *  (0.3.3 起移除 `bin` 逃生舱:没有"退回外部 code-server 二进制/旧模型"的分支。) */
function resolveLaunch() {
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

/** 命名管道名(仅 dsh 模式使用):按 profile/pid 稳定,避免撞名。 */
function pipeName() {
  const key = `${process.pid}`;
  return win32() ? `\\\\.\\pipe\\dshcs-vscode-${key}` : path.join(os.tmpdir(), `dshcs-vscode-${key}.sock`);
}

/** 扩展宿主传输开关(0.3.2):Windows 上只要给 VS Code server 传了 socket-path,它就不再向扩展宿主
 *  传 socket 句柄(child.send 只认真 TCP socket 句柄,管道句柄会 ENOTSUP),改为自建内部命名管道 +
 *  `_pipeSockets()` 双向泵字节(见 docs/plan-noport-desktop-ide.md §15)。我们只借这个开关换交接方式,
 *  不真的监听这个路径。非 Windows 上该开关无副作用(那里句柄传递本来就是通的)。 */
function exthostIpcFlag(pipe) {
  return `${pipe}-exthost`;
}

/** launcher 的传输参数(纯函数,便于测试)。**pipe 必须同时给 --exthost-ipc**:
 *  前者让 launcher 监听命名管道,后者让 VS Code server 改用内部管道把连接交给扩展宿主;
 *  只给其中一个都会得到"起得来但扩展宿主连不上"的假成功(§15)。
 *  0.3.3 起这是**唯一**路径:管道不就绪就是错误,不存在回退到回环端口的岔路。 */
export function launcherFlags({ pipe, locale }) {
  const list = ['--pipe', pipe, '--exthost-ipc', exthostIpcFlag(pipe)];
  if (typeof locale === 'string' && locale !== '') list.push('--locale', locale);
  return list;
}

/** 命名管道上的 /healthz 探针(唯一传输;管道由 launcher 监听)。 */
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
  let fileOpenScope = 'session'; // 客户端认领的文件地址范围(0.2.5)
  if (settingsSvc !== undefined && typeof settingsSvc.register === 'function') {
    try {
      const scope = settingsSvc.register(SETTINGS_NS, Config);
      const rawDoc = settingsSvc.get(SETTINGS_NS);
      if (rawDoc !== undefined && rawDoc !== null) {
        const resolved = scope.get();
        serveSetting = resolved && resolved.serve === 'dsh' ? 'dsh' : 'loopback';
        keepResident = resolved && typeof resolved.keepResident === 'boolean' ? resolved.keepResident : true;
        fileOpenScope = resolved && resolved.fileOpenScope === 'all' ? 'all' : 'session';
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
        if (next != null && (next.fileOpenScope === 'all' || next.fileOpenScope === 'session')) {
          if (next.fileOpenScope !== fileOpenScope) {
            fileOpenScope = next.fileOpenScope;
            console.log(`[code-server] fileOpenScope updated: ${fileOpenScope}`);
          }
        }
      });
    } catch (error) {
      console.error(`[code-server] settings unavailable; using defaults (keepResident=true, fileOpenScope=session): ${error.message}`);
    }
  }

  // 依赖布局自愈必须发生在任何解析之前:精简树不含 lib/vscode/node_modules,
  // 由这里按插件依赖图补 junction(幂等;重装后自愈)。
  const layout = ensureRuntimeLayout();

  // ---- 服务方式:settings/行配置请求 dsh,但只有本 deployment 真的提供 webServer 时才用 ----
  let webServerSvc = ctx.get('webServer');
  let dshMount = null; // { disposers, upgradePath } —— 由下面的 ctx.inject 填充

  /** 生效的服务方式:loopback(默认,IDE 在命名管道上、客户端走镜像 + 隧道)| dsh(DSH 同源挂载)。
   *  0.3.3 起**没有回退**:配了 dsh 而组合里没有 webServer(或挂载失败)就是错误,不再静默改成 loopback。 */
  function requestedServe() {
    return serveSetting === 'dsh' || cfg.serve === 'dsh' ? 'dsh' : 'loopback';
  }

  /** serve=dsh 的前置条件检查(启动前调用):不满足就带着可执行的建议报错。 */
  function dshServeProblem() {
    if (webServerSvc === undefined) {
      return 'serve=dsh 需要 DSH 提供 webServer 服务,当前组合没有(desktop profile 请用 serve: loopback;'
        + 'web profile 请确认 webServer 插件已启用)';
    }
    if (dshMount === null) {
      return 'serve=dsh 的 /code-server 挂载未建立(见上文挂载失败日志);'
        + '请改用 serve: loopback,或修掉挂载失败的原因后重启';
    }
    return null;
  }

  const state = {
    status: 'stopped', // stopped | starting | running | stopping | error
    pid: null,
    cwd: null,
    version: null,
    error: null,
    logTail: '',
    startedAt: null,
    adopted: false,
    serve: 'loopback', // 实际生效的服务方式(loopback | dsh)
    transport: 'pipe', // 传输只有命名管道(0.3.3 起没有端口这条路)
    pipe: null, // 命名管道名
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

  // ---- WS 字节隧道(阶段 1,见 docs/plan-noport-desktop-ide.md §4)----
  // IDE 的 WebSocket 改由客户端 shim 产出字节、经一条 POST 双向流送到这里,
  // 再转发给子进程的 /__dshcs/tunnel 端点数(合成 upgrade)。token 每次激活随机,
  // 经 GET status 下发给同源客户端;真实客户端拿到它才谈得上开隧道。
  const tunnelToken = randomBytes(16).toString('hex');

  // ---- 工作台资产镜像(阶段 2,见 docs/plan-noport-desktop-ide.md §5)----
  // 把 IDE 的 URL 空间按精确路由镜像到 /api/code-server/asset/**:客户端可以让 iframe 的
  // 文档也来自 dsh-app://(子资源全部同源),于是彻底不再碰 loopback 端口。
  const assetMirror = createAssetMirror({
    getTarget: () => {
      if (state.status !== 'running' || state.pid === null || state.pipe === null) return null;
      return { kind: 'pipe', pipe: state.pipe };
    },
    tree: vsRoot() ?? '',
    productPath: state.env?.productPath ?? productPath() ?? 'stable',
    log: (message) => console.log(`[code-server] ${message}`),
  });
  let disposeAssetMirror = null;
  /** 客户端中继诊断(阶段 1 排查):客户端把每一步 POST 到这里,host 落文件。 */
  const diagLogPath = path.join(cfg.userDataDir || path.join(dataRoot(cfg), 'user-data'), 'client-diag.log');
  async function handleDiag(request) {
    let body = '';
    try { body = await request.text(); } catch { /* 空体 */ }
    try { fs.appendFileSync(diagLogPath, `${JSON.stringify({ at: new Date().toISOString(), from: 'client', body: body.slice(0, 2000) })}\n`); } catch { /* 日志失败不影响功能 */ }
    return jsonResponse({ ok: true });
  }
  const tunnel = createPipeTunnel({
    getTarget: () => {
      if (state.status !== 'running' || state.pid === null || state.pipe === null) return null;
      return { kind: 'pipe', pipe: state.pipe };
    },
    token: tunnelToken,
    log: (message) => {
      console.log(`[code-server] ${message}`);
      // host 侧诊断落文件(阶段 1 排查:host 的 stdout 在 Electron 里看不到)
      try {
        fs.appendFileSync(
          path.join(cfg.userDataDir || path.join(dataRoot(cfg), 'user-data'), 'host-diag.log'),
          `${new Date().toISOString()} ${message}\n`,
        );
      } catch { /* 日志失败不影响功能 */ }
    },
  });

  // ---- DSH 同源挂载(serve=dsh):把 /code-server 注册到 DSH 自己的 webServer ----
  // webServer 只在 web profile 存在(desktop 显式禁用该行)→ 用 ctx.inject 特性检测:
  // 配了 serve=dsh 却没有它(或挂载失败)= 启动报错,不再静默改成 loopback(0.3.3)。
  ctx.inject(['webServer'], (wsCtx) => {
    webServerSvc = wsCtx.webServer;
    try {
      dshMount = mountOnWebServer({
        webServer: wsCtx.webServer,
        connection,
        // 目标随时可变:launcher 重启会换管道,未运行时返回 null(路由回 503)
        getTarget: () => (state.serve === 'dsh' && state.pipe !== null ? { kind: 'pipe', pipe: state.pipe } : null),
        productPath: state.env?.productPath ?? productPath() ?? 'stable',
      });
      console.log(`[code-server] serve=dsh 挂载就绪:${MOUNT_PATH}/ (HTTP)+ ${dshMount.upgradePath} (WS)`);
    } catch (error) {
      dshMount = null;
      console.error(`[code-server] serve=dsh 挂载失败(该模式下没有回退,启动会直接报错):${error && error.message ? error.message : error}`);
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
    // 客户端文档:dsh 走同源挂载,loopback 走同源资产镜像(IDE 不监听端口,没有别的来源)。
    const pageUrl = dshMode ? '/code-server/' : ASSET_DOCUMENT;
    return {
      ok: state.status !== 'error' || running,
      running,
      status: state.status,
      serve: state.serve,
      transport: state.transport,
      pipe: state.pipe,
      pid: state.pid,
      cwd: state.cwd,
      url: running ? pageUrl : null,
      productPath: state.env?.productPath ?? null,
      version: state.version,
      error: state.error,
      logTail: state.logTail.slice(-LOG_TAIL_MAX),
      adopted: state.adopted,
      keepResident,
      fileOpenScope, // 客户端据此决定认领哪些文件地址(0.2.5)
      sidebarUi: state.sidebarUi,
      // 阶段 1:WS 字节隧道(客户端 shim 用它把 WS 字节经 /api 送来,不再开 ws://)
      tunnel: { path: TUNNEL_PATH, header: TUNNEL_TOKEN_HEADER, token: tunnelToken, ...tunnel.snapshot() },
      // 阶段 2:工作台资产镜像(客户端据此把 iframe 文档也搬到 dsh-app://)
      assetMirror: assetMirror.snapshot(),
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
    state.startedAt = null;
    state.adopted = false;
    if (reason) state.error = null;
  }

  /** 就绪探针:只有命名管道一条路。 */
  function probeReady(timeoutMs = 1500) {
    if (state.pipe === null) return Promise.resolve({ ok: false });
    return healthCheckPipe(state.pipe, timeoutMs);
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

  /** 启动串行化:apply 期的**预启动**与界面点击的启动可能并发,而两者写的是同一份 pid.json
   *  与同一个管道名 —— 并发进入会双开 launcher(第二个直接 EADDRINUSE)。串成一条链后,
   *  第二个调用会看到 running/starting 并按既有逻辑复用。 */
  let startChain = Promise.resolve();
  function start(cwdArg) {
    const run = startChain.then(() => startInner(cwdArg), () => startInner(cwdArg));
    startChain = run.then(() => {}, () => {});
    return run;
  }

  async function startInner(cwdArg) {
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

    const serve = requestedServe(); // loopback | dsh(serve=dsh 必须真的挂得上,没有回退)
    if (serve === 'dsh') {
      const problem = dshServeProblem();
      if (problem !== null) {
        state.serve = 'dsh';
        state.status = 'error';
        state.error = problem;
        return snapshot();
      }
    }
    const launch = resolveLaunch(); // throws with install guidance when missing

    if (cfg.auth === 'password') {
      console.warn('[code-server] 0.2.0 起不再支持口令认证(argon2 已移除),按 auth=none 运行');
    }

    // 进程还在(pid.json 有效 + 管道上 /healthz 响应)则 adopt,否则启动。
    // 管道名里带 host pid,因此只有同一次 host 运行内才会命中(例如插件重载)。
    if (serve === 'loopback') {
      const record = readPidFile(cfg);
      const adoptPipe = record !== null && typeof record.pipe === 'string' && record.pipe !== '' ? record.pipe : null;
      if (adoptPipe !== null && (await healthCheckPipe(adoptPipe, 800)).ok) {
        if (record && isAlive(record.pid)) {
          state.serve = 'loopback';
          state.pipe = adoptPipe;
          state.status = 'running';
          state.pid = record.pid;
          state.cwd = cwd ?? record.cwd ?? null;
          state.startedAt = record.startedAt ?? null;
          state.adopted = true;
          return snapshot();
        }
        state.status = 'error';
        state.error = `命名管道 ${adoptPipe} 已被占用且没有有效的 pid.json 记录(拒绝误杀);请删除该进程后重试`;
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

    state.serve = serve;

    /** 组装启动参数:命名管道是唯一传输(`--pipe` 必须配 `--exthost-ipc`,见 launcherFlags)。 */
    const buildArgs = () => {
      state.pipe = pipeName();
      return [
        launch.script,
        '--tree', launch.tree,
        '--user-data-dir', userDataDir,
        '--extensions-dir', extensionsDir,
        '--parent-pid', String(process.pid),
        ...launcherFlags({ pipe: state.pipe, locale: cfg.locale }),
      ];
    };

    const env = { ...process.env };
    // 内置扩展信号文件路径(host → 扩展 打开文件)
    env.DSHCS_OPEN_FILE_SIGNAL = openFileSignalPath(userDataDir);
    // 隧道端点令牌:子进程据此只接受来自 host 的隧道请求(阶段 1)
    env.DSHCS_TUNNEL_TOKEN = tunnelToken;
    // 隧道事件日志(阶段 1 验收:host 侧读该文件即可确认 WS 走了隧道)
    env.DSHCS_TUNNEL_LOG = path.join(userDataDir, 'tunnel.log');
    // 页面侧诊断(工作台 HTML 注入的错误上报)+ 资源缓存击穿标记
    env.DSHCS_PAGE_LOG = path.join(userDataDir, 'page-errors.log');
    // HTTP 请求日志(方法/路径/状态,launcher 侧 2MB 上限):
    // "颜色/图标/语法不对"这类问题多半是扩展资源(vscode-remote-resource)没读到,先看这里。
    env.DSHCS_REQUEST_LOG = path.join(userDataDir, 'request.log');
    env.DSHCS_HTML_TAG = tunnelToken.slice(0, 8);
    // 有隧道(没有 webServer)时才让 launcher 在 serve 时注入裸字节 shim:
    // web 侧的客户端是普通浏览器页面,必须保留原生 WebSocket。
    if (!webServerPresent) env.DSHCS_TUNNEL_MODE = '1';
    // pnpm 会把带 os/cpu 限定的原生包嵌套装在平台聚合包下(如 <profile>/node_modules/@<scope>/
    // dsh-code-server-runtime-<平台>-<架构>/node_modules/@vscode/spdlog),那些目录不在 VS Code
    // 树的向上查找链里 → 用 NODE_PATH 让子进程的 require 找得到(CJS;ESM 由 ensureAliasLinks 的 junction 负责)。
    const nodePathDirs = aliasNodePathDirs();
    if (nodePathDirs.length > 0) {
      const existing = typeof env.NODE_PATH === 'string' && env.NODE_PATH !== '' ? env.NODE_PATH.split(path.delimiter) : [];
      env.NODE_PATH = [...new Set([...nodePathDirs, ...existing])].join(path.delimiter);
    }

    let proc;
    /** 启动(参数、pid.json、事件挂载);spawn 抛错时置 error 并返回 false。 */
    const spawnOnce = () => {
      const spawnArgs = buildArgs();
      state.error = null;
      state.status = 'starting';
      state.cwd = cwd ?? null;
      state.startedAt = Date.now();
      state.adopted = false;
      let launched;
      try {
        // 启动前再自愈一次依赖布局(插件重装/树被替换后可能丢失;幂等且只做存在性检查)
        ensureRuntimeLayout();
        launched = spawn(process.execPath, [launch.script, ...spawnArgs], {
          cwd: cwd ?? process.cwd(),
          env,
          windowsHide: true,
          detached: !win32(),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        state.status = 'error';
        state.error = `spawn 失败: ${err && err.message ? err.message : String(err)}`;
        return false;
      }
      const proc = launched;
      child = proc;
      state.pid = proc.pid ?? null;
      writePidFile(cfg, {
        pid: proc.pid,
        startedAt: state.startedAt,
        cwd: cwd ?? null,
        transport: 'pipe',
        serve,
        pipe: state.pipe,
        launchCommand: launch.script,
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
      return true;
    };

    // 传输只有一条:launcher 监听命名管道(IDE 侧不占 TCP 端口,§15)。
    // 管道不就绪不会退到端口 —— 状态机直接报 error,把日志摆给人看。
    state.logTail = '';
    if (!spawnOnce()) return snapshot();
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
    // 阶段 1:WS 字节隧道。必须声明 streaming —— 一条 POST 承载两个方向的整条 WS 连接,
    // 缓冲模式会在 64 KiB 上限处截断(streaming 模式带背压、无总量上限)。
    { path: TUNNEL_PATH, methods: ['POST'], requestBody: 'streaming', fetch: tunnel.fetch },
    { path: `${API_BASE}/diag`, methods: ['POST'], fetch: handleDiag },
  ].map(route => connection.fetch.register({
    path: route.path,
    methods: route.methods,
    requestBody: route.requestBody ?? 'buffered',
    fetch: route.fetch,
  }));

  // 阶段 2:资产镜像(枚举 IDE 的 URL 空间 → 一文件一路由 + 文档路由)。
  // **只在没有 webServer 的组合(desktop / 独立部署)启用**:web(serve: dsh)本来就有
  // webServer 同源挂载,走镜像等于改掉既有行为。同理,serve 时注入的裸字节 shim 也只能在
  // 有隧道的一侧生效(web 上它会把浏览器原生 WebSocket 换掉,而 web 没有父窗口中继)——
  // 用 DSHCS_TUNNEL_MODE 把这件事告诉 launcher。
  let webServerPresent = ctx.get('webServer') !== undefined;
  if (!webServerPresent) {
    try {
      const t0 = Date.now();
      disposeAssetMirror = assetMirror.register(connection);
      console.info(`[code-server] 资产镜像就绪:${assetMirror.snapshot().registered} 条路由,文档 ${assetMirror.document}(${Date.now() - t0} ms)`);
    } catch (error) {
      // 没有回退:desktop 的客户端文档只能来自镜像(0.3.2 起 IDE 不监听端口)——这里失败就是真的不可用。
      console.error(`[code-server] 资产镜像注册失败 —— 客户端没有可用文档来源(无回退路径):${error && error.message ? error.message : error}`);
    }
  } else {
    assetMirror.disable(null);
    console.info('[code-server] 检测到 webServer:走 serve=dsh 同源挂载,不启用资产镜像');
  }

  ctx.inject(['webServer'], () => {
    // webServer 晚到(web 组合):关掉镜像并释放路由,避免与 dsh 挂载重复
    if (!webServerPresent) {
      webServerPresent = true;
      assetMirror.disable(disposeAssetMirror);
      disposeAssetMirror = null;
      console.info('[code-server] webServer 就绪:关闭资产镜像(改用 serve=dsh 挂载)');
    }
  });

  ctx.effect(() => {
    return () => {
      disposeKilled = true;
      stopPolling();
      try { disposeAssetMirror?.(); } catch { /* ignore */ }
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

  // 同一次 host 运行内的重复激活(如插件重载):pid.json 有效 + 进程存活 + 管道上 /healthz 响应 → 接管。
  // launcher 带 --parent-pid 看门狗(host 一退出它就自行退出),所以不存在可接管的孤儿。
  if (liveInstance && (record.serve !== 'dsh')) {
    const recordPipe = typeof record.pipe === 'string' && record.pipe !== '' ? record.pipe : null;
    const probe = recordPipe !== null ? await healthCheckPipe(recordPipe, 800) : { ok: false };
    if (probe.ok) {
      state.serve = 'loopback';
      state.pipe = recordPipe;
      state.status = 'running';
      state.pid = record.pid;
      state.cwd = record.cwd ?? null;
      state.startedAt = record.startedAt ?? null;
      state.adopted = true;
      console.log(`[code-server] adopted running instance pid=${record.pid} pipe=${recordPipe}`);
    } else {
      removePidFile(cfg);
    }
  } else if (liveInstance) {
    removePidFile(cfg); // 上次是 dsh 模式(管道随进程消失)→ 清理陈旧记录
  }

  maybePrestart();

  const serveWanted = requestedServe();
  console.log(`[code-server] static plugin loaded (serve=${serveWanted} transport=pipe${serveWanted === 'dsh' ? ` ${dshServeProblem() ?? 'mounted'}` : ''})`);
}
