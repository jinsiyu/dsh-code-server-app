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
import { randomBytes } from 'node:crypto';
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
import {
  BRIDGE_BASE,
  BRIDGE_DIRNAME,
  bodyWithinLimit,
  bridgeGuard,
  createContextCache,
  createEventRing,
  mintBridgeToken,
  readBridgeConfig,
  removeBridgeConfig,
  writeBridgeConfig,
} from './bridge.mjs';
import { bridgeEndpointPath, startBridgeListener } from './bridge-ipc.mjs';
import { registerEditorPrompt, registerEditorTools, setPromptLiveProbe } from './bridge-tools.mjs';
import { deliverEditorPrompt } from './bridge-session.mjs';
import { registerBridgeObserver } from './bridge-observe.mjs';

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
  /** editorBridge=true(默认):启用「编辑器桥」(0.3.0)—— 树内扩展 dshcs-editor-bridge 与
   *  host 之间建立**只读**通道,给 agent 提供 only-the-editor-knows 的上下文(未保存缓冲区、
   *  诊断、活动选区),并让编辑器里的动作能驱动 DSH。关闭后不写 bridge.json、不注册编辑器工具,
   *  扩展会休眠(它读不到配置就不做任何事)。安全模型见 lib/bridge.mjs 顶部。 */
  editorBridge: z.boolean().default(true),
});

const DEFAULT_CONFIG = {
  bin: '',
  host: '127.0.0.1',
  /** 0(默认)= 每次启动由系统分配空闲端口(launcher 把实际端口写进 endpoint 文件,host 读回);
   *  显式给端口则照用(用于需要固定地址的场景)。 */
  port: 0,
  auth: 'none',
  serve: 'loopback',
  userDataDir: '',
  extensionsDir: '',
  locale: '',
  readyTimeoutMs: 60000,
  /** 编辑器桥(0.3.0):见 Config.editorBridge。行配置与设置文档都可关;设置卡片暂不提供行。 */
  editorBridge: true,
};

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const LOG_TAIL_MAX = 6000;
/** 路径令牌格式(与 launcher 的一致;字符集同时满足 VS Code 自己的 token 校验)。 */
const TOKEN_RE = /^[0-9A-Za-z_-]{16,128}$/;

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function dataRoot(config) {
  return path.join(dshHome(), 'code-server');
}

function pidFile(config) {
  return path.join(dataRoot(config), 'pid.json');
}

/** 路径令牌文件(0600 语义:位于用户 profile 下,默认 ACL 仅本人可读)。 */
function tokenFile(config) {
  return path.join(dataRoot(config), 'path-token');
}

/** launcher 回写实际监听地址的文件(端口 0 时 host 只能从这里知道端口)。 */
function endpointFile(config) {
  return path.join(dataRoot(config), 'endpoint.json');
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

/** 扩展安装目标:`placement: 'builtin'` 时优先 VS Code「内置扩展」目录 = <树>/lib/vscode/extensions
 *  (位于程序内置目录的扩展被 VS Code 视为内置——用户视图显示为"内置",**不能卸载**);
 *  `placement: 'user'` 时只用 --extensions-dir(用户级扩展,可被用户禁用/卸载)。
 *  返回 { dst, builtin }——builtin=true 时是核心路径;找不到树时回退用户级。
 *  `treeRoot` 可注入(测试用):默认 `vsRoot()`,注入后测试不会碰真实树。 */
function extensionTarget(extensionsDir, name, placement = 'builtin', treeRoot = vsRoot()) {
  if (placement === 'builtin') {
    try {
      if (treeRoot !== null) {
        const vscodeExt = path.join(treeRoot, 'lib', 'vscode', 'extensions');
        if (fs.existsSync(vscodeExt)) {
          return { dst: path.join(vscodeExt, name), builtin: true };
        }
      }
    } catch { /* fall through */ }
  }
  return { dst: path.join(extensionsDir, name), builtin: false };
}

/** 树内自带扩展清单。
 *  - dshcs-open-file:host 信号文件 → VS Code 打开文件(可带行号)。**内置**(用户不需要看到它)。
 *  - dshcs-editor-bridge(0.3.0):编辑器桥的扩展侧。**必须内置**(0.3.12 修正;0.3.0–0.3.11 是用户级)。
 *    为什么"直接往 <extensions-dir> 拷目录"装不进用户级:VS Code 服务端启动时
 *    `ExtensionsWatcher.initialize()` → `deleteExtensionsNotInProfiles()` 会把
 *    「在用户扩展目录里、但不在任何 profile 的 extensions.json 里」的扩展写进 `<extensions-dir>/.obsolete`
 *    (服务端日志 `Marked extension as removed dsh-code-server-app.dshcs-editor-bridge-0.1.0`),
 *    扫描器从此不再看它;下一轮它自然又不在 profile 里 ⇒ **每启动一次就再标一次,自锁**。
 *    实测(本机 profile,10 次启动 10 条标记)与源码位置:`out/server-main.js` 的
 *    `ExtensionsWatcher#initialize` / `ExtensionsScannerService#setExtensionsForRemoval`。
 *    内置目录(<树>/lib/vscode/extensions,与 dshcs-open-file 同处)不参与 profile 机制。
 *    用户的"关掉它"由插件设置 `editorBridge=false`(不挂桥、不注册工具)承担,不再依赖 VS Code 的卸载。 */
const BUNDLED_EXTENSIONS = [
  { name: 'dshcs-open-file', placement: 'builtin' },
  { name: 'dshcs-editor-bridge', placement: 'builtin' },
];

/** 递归列出扩展源目录里的文件(相对路径,posix 分隔)。
 *  为什么必须递归:编辑器桥(0.3.7 起)把纯逻辑放在 `lib/*.js` 里(便于单测,不 require('vscode')),
 *  只拷 `extension.js` 会让扩展加载即 `Cannot find module './lib/bridge-client.js'` —— 而 VS Code
 *  只会把这种失败记成一条 `Marked extension as removed`,界面上什么都没发生。
 *  跳过开发期杂物;`.dshcs-bridge` 是运行期元数据目录,不属于扩展本体。
 *  导出供 scripts/test-bridge-routes.mjs 直接验(它不启动 IDE,而安装发生在 start 里)。 */
export function listExtensionFiles(srcDir) {
  const skip = new Set(['node_modules', '.git', '.dshcs-bridge', 'test', 'tests']);
  const out = [];
  const walk = (rel) => {
    const abs = rel === '' ? srcDir : path.join(srcDir, rel);
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      if (skip.has(ent.name)) continue;
      const next = rel === '' ? ent.name : `${rel}/${ent.name}`;
      if (ent.isDirectory()) walk(next);
      else if (ent.isFile()) out.push(next);
    }
  };
  walk('');
  return out;
}

/** 清掉 VS Code 写给本插件扩展的"已移除"标记(`<extensions-dir>/.obsolete`)。
 *  机制:`ExtensionsWatcher.initialize()` 把"在用户扩展目录里、不在任何 profile 里"的扩展标成 removed,
 *  扫描器随后永远跳过它 ⇒ **自锁**(见 BUNDLED_EXTENSIONS 的注释)。0.3.0–0.3.11 的桥扩展就卡在这里:
 *  文件装全了、路由通了,扩展却一次都没被加载(`editor_context` 永远报"扩展还没有上报状态")。
 *  别的扩展的条目原样保留;清空后直接删掉文件(VS Code 需要时会自己重建)。
 *  导出供测试直接验。 */
export function clearObsoleteMarkers(extensionsDir, ids) {
  const file = path.join(extensionsDir, '.obsolete');
  if (ids.length === 0 || !fs.existsSync(file)) return [];
  let map;
  try {
    map = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  if (map === null || typeof map !== 'object' || Array.isArray(map)) return [];
  const cleared = [];
  for (const key of Object.keys(map)) {
    if (ids.some((id) => key === id || key.startsWith(`${id}-`))) {
      delete map[key];
      cleared.push(key);
    }
  }
  if (cleared.length === 0) return [];
  try {
    if (Object.keys(map).length === 0) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, JSON.stringify(map), 'utf8');
  } catch {
    // 清标记失败不该拦住安装:扩展仍会被扫描器跳过,但文件是新的(下次启动还会再试)
  }
  return cleared;
}

/** 内置扩展安装:每次启动调用 —— 缺失**或内容有变化**即同步(自愈,且插件升级后能更新已装的旧副本)。
 *  源目录里已不存在的文件会从目标里删掉(否则旧版本的 `lib/` 会一直留着)。
 *  同时清理"放错位置"的旧副本(用户级/内置两份同时存在会让 VS Code 打架),并清掉 `.obsolete` 自锁标记。
 *  导出供测试直接调(apply 期不装扩展,只有 start 才装);`options.treeRoot` 供测试注入假树。
 *  @returns {{updated: string[], cleared: string[]}} `updated` = 本次真的写了文件/删了文件的扩展名
 *    (adopt 路径据此判断"运行中的 IDE 里是旧代码");`cleared` = 本次清掉的 `.obsolete` 键。 */
export function installBundledExtensions(extensionsDir, userDataDir, options = {}) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const treeRoot = options.treeRoot === undefined ? vsRoot() : options.treeRoot;
  const managedIds = [];
  const updated = [];
  for (const ext of BUNDLED_EXTENSIONS) {
    try {
      const src = path.join(here, '..', 'assets', 'extensions', ext.name);
      const manifest = path.join(src, 'package.json');
      if (!fs.existsSync(manifest)) continue;
      const manifestJson = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      managedIds.push(`${manifestJson.publisher ?? 'dsh-code-server-app'}.${manifestJson.name ?? ext.name}`);
      const files = listExtensionFiles(src);
      const target = extensionTarget(extensionsDir, ext.name, ext.placement, treeRoot);
      const dst = target.dst;
      const stale = files.filter((name) => {
        const to = path.join(dst, name);
        if (!fs.existsSync(to)) return true;
        try {
          return !fs.readFileSync(path.join(src, name)).equals(fs.readFileSync(to));
        } catch {
          return true;
        }
      });
      if (stale.length > 0) {
        for (const name of stale) {
          const to = path.join(dst, name);
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.copyFileSync(path.join(src, name), to);
        }
      }
      // 删除目标里多出来的文件(相对源目录):升级后旧文件不该留在扩展目录里
      const removed = [];
      if (fs.existsSync(dst)) {
        const wanted = new Set(files);
        const walkDst = (rel) => {
          const abs = rel === '' ? dst : path.join(dst, rel);
          for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
            const next = rel === '' ? ent.name : `${rel}/${ent.name}`;
            if (ent.isDirectory()) walkDst(next);
            else if (ent.isFile() && !wanted.has(next)) {
              fs.rmSync(path.join(dst, next), { force: true });
              removed.push(next);
            }
          }
        };
        walkDst('');
      }
      // 清理放错位置的副本:编辑器桥的旧用户级副本(0.3.11 及更早)/ dshcs-open-file 的旧用户级副本。
      const wrong = extensionTarget(extensionsDir, ext.name, ext.placement === 'builtin' ? 'user' : 'builtin', treeRoot);
      if (wrong.dst !== dst && fs.existsSync(wrong.dst)) {
        fs.rmSync(wrong.dst, { recursive: true, force: true });
        console.log(`[code-server] 清理放错位置的扩展副本 ${wrong.dst}(${ext.name} 应装在${target.builtin ? '内置' : '用户级'}目录)`);
      }
      console.log(`[code-server] bundled extension ${ext.name} -> ${dst}${target.builtin ? ' (内置,不可卸载)' : ' (用户级,可禁用)'}`
        + `${stale.length > 0 ? ` [更新 ${stale.join(',')}]` : ''}${removed.length > 0 ? ` [清理 ${removed.join(',')}]` : ''}`);
      if (stale.length > 0 || removed.length > 0) updated.push(ext.name);
    } catch (err) {
      console.warn(`[code-server] bundled extension ${ext.name} install failed:`, err && err.message ? err.message : String(err));
    }
  }
  const cleared = clearObsoleteMarkers(extensionsDir, managedIds);
  if (cleared.length > 0) {
    console.log(`[code-server] 清掉 VS Code 的"已移除"标记(.obsolete):${cleared.join(',')}`
      + '(留着的话扫描器会永远跳过这些扩展,编辑器桥就永远没有状态)');
  }
  void userDataDir;
  return { updated, cleared };
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

function healthCheck(host, port, token, timeoutMs = 1500) {
  const requestPath = token === null || token === undefined ? '/healthz' : `/${token}/healthz`;
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: requestPath, timeout: timeoutMs, method: 'GET' }, (res) => {
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

/** 读路径令牌;文件缺失或格式不对返回 null(不抛:调用方据此判定"没有可接管的实例")。 */
function readToken(config) {
  try {
    const raw = fs.readFileSync(tokenFile(config), 'utf8').trim();
    return TOKEN_RE.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** 生成并写入新的路径令牌(每次**新启动**都换;原子写,0600)。 */
function rotateToken(config) {
  const token = randomBytes(24).toString('base64url'); // [A-Za-z0-9_-] 共 32 位
  const file = tokenFile(config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, token, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  return token;
}

/** 读 launcher 回写的监听端点(端口 0 时唯一可信来源);缺失/不可用返回 null。 */
function readEndpoint(config) {
  try {
    const raw = JSON.parse(fs.readFileSync(endpointFile(config), 'utf8'));
    return raw && Number.isInteger(raw.pid) && Number.isInteger(raw.port) && raw.port > 0 ? raw : null;
  } catch {
    return null;
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
  /** 编辑器桥开关(0.3.0):行配置 cfg.editorBridge 是种子,设置文档里可改并实时生效。 */
  let bridgeSetting = cfg.editorBridge !== false;
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
        bridgeSetting = resolved && typeof resolved.editorBridge === 'boolean' ? resolved.editorBridge : bridgeSetting;
      }
      scope.watch((next) => {
        if (next != null && (next.serve === 'dsh' || next.serve === 'loopback')) {
          if (next.serve !== serveSetting) {
            serveSetting = next.serve;
            console.log(`[code-server] serve updated: ${serveSetting}(下次启动生效)`);
          }
        }
        if (next != null && typeof next.editorBridge === 'boolean') {
          if (next.editorBridge !== bridgeSetting) {
            bridgeSetting = next.editorBridge;
            console.log(`[code-server] editorBridge updated: ${bridgeSetting}`);
            // 关掉 → 立刻下线(关监听口 + 删配置 + 注销工具);开启 → 起监听口,IDE 在跑就补一份配置。
            if (bridgeSetting === false) {
              clearBridgeRuntime();
              void stopBridgeListener();
            } else {
              void ensureBridgeListener().then(() => {
                if (state.status === 'running' && state.pid !== null) {
                  bridgeToken ??= mintBridgeToken();
                  syncBridgeRuntime({ pid: state.pid, startedAt: state.startedAt });
                }
              });
            }
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
    /** 本实例的路径令牌(回环模式;不写日志、不进 argv)。 */
    token: null,
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

  // ---- 编辑器桥(0.3.0):配置/凭据写在 <extensionsDir>/.dshcs-bridge/bridge.json ----
  // 这里只算路径;是否启用还要看 cfg.editorBridge 与 setting 值。详见 lib/bridge.mjs 顶部。
  const bridgeRoot = dataRoot(cfg);
  const bridgeUserDataDir = cfg.userDataDir || path.join(bridgeRoot, 'user-data');
  const bridgeExtensionsDir = cfg.extensionsDir || path.join(bridgeRoot, 'extensions');
  const bridgeMetaDir = path.join(bridgeExtensionsDir, BRIDGE_DIRNAME);
  /** 已写入的桥配置(供桥路由与 /status 读回);null = 未启用/未就绪。 */
  let bridgeMeta = null;
  /** 桥工具(editor_context / editor_diagnostics)的 disposer;null = 未注册。 */
  let bridgeToolDispose = null;
  /** 提示词段落的 disposer(只注册一次;文本按桥是否存活渲染)。 */
  let bridgePromptDispose = null;
  /** agent 写操作观察器的 disposer。 */
  let bridgeObserveDispose = null;
  /** 推给编辑器的事件环形缓冲(tools/result → 扩展轮询)。 */
  const bridgeEvents = createEventRing();
  /** 编辑器状态缓存:扩展在每次 /sync 里推上来,agent 的工具调用来读它。 */
  const bridgeContext = createContextCache();

  /** 本次启动生成的新桥令牌;null = 本实例没有令牌(adopt 旧实例时会回读 bridge.json)。 */
  let bridgeToken = null;
  /** 桥的本机 IPC 监听口(0.3.13)。null = 未起(未启用/起失败)。*/
  let bridgeListener = null;
  /** 监听口启动中的 promise(避免并发起两次)。 */
  let bridgeListenerStarting = null;
  /** "桥监听起不来"只提示一次,避免每次起停都刷屏。 */
  let bridgeUnavailableLogged = false;

  /** 桥的传输是**本机 IPC**(Windows 命名管道 / 其它平台 unix socket),不是 HTTP。
   *
   *  为什么不走 HTTP(0.3.13 定论,三条都实测过):
   *   ① launcher 的 host:port 只服务 workbench,没有任何桥路由(0.3.7 的实测:405);
   *   ② `/api` 有 Connection 的浏览器 cookie fence,扩展宿主是 Node 进程、拿不到 cookie(0.3.7–0.3.9);
   *   ③ 挂 DSH 的 `webServer` 前缀(0.3.9–0.3.12)只有 **web profile** 有 —— desktop 的渲染进程
   *      经 Electron IPC 调 `host.fetch()`(`apps/desktop-host/src/index.ts:308`),**根本没有 HTTP 面**。
   *  桥的双方本来就是同一台机器上的两个进程,本机 IPC 让 web 与 desktop 走**同一条**路。
   *  详见 lib/bridge-ipc.mjs 顶部。 */
  function ensureBridgeListener() {
    if (bridgeListener !== null) return Promise.resolve(bridgeListener);
    if (bridgeListenerStarting !== null) return bridgeListenerStarting;
    const socketPath = bridgeEndpointPath(bridgeRoot, process.pid);
    bridgeListenerStarting = startBridgeListener({
      socketPath,
      handler: nodeRouteFromFetch((url, method, headers, body) => dispatchBridge(url, method, headers, body)),
      log: (message) => console.warn(`[code-server] ${message}`),
    }).then((handle) => {
      bridgeListener = handle;
      bridgeListenerStarting = null;
      console.log(`[code-server] 编辑器桥监听就绪:${handle.path}(本机 IPC,桥令牌鉴权)`);
      return handle;
    }).catch((error) => {
      bridgeListenerStarting = null;
      if (!bridgeUnavailableLogged) {
        bridgeUnavailableLogged = true;
        console.warn(`[code-server] 编辑器桥监听失败,桥不启用:${error && error.code ? error.code : error && error.message ? error.message : error}`
          + '(文件打开走信号文件,不受影响)');
      }
      return null;
    });
    return bridgeListenerStarting;
  }

  /** 关掉本机 IPC 监听口(禁用桥 / 插件卸载)。 */
  function stopBridgeListener() {
    const handle = bridgeListener;
    bridgeListener = null;
    if (handle === null) return Promise.resolve();
    return handle.close().catch(() => {});
  }

  /** 桥的四条路由(后缀 → Fetch 风格 handler)。做成函数而非常量:handler 声明在文件后段,
   *  函数声明会提升,而常量在挂载时可能还在 TDZ。 */
  function bridgeRouteTable() {
    return [
      { suffix: '/health', methods: ['GET'], fetch: handleBridgeHealth },
      { suffix: '/sync', methods: ['POST'], fetch: handleBridgeSync },
      { suffix: '/ask', methods: ['POST'], fetch: handleBridgeAsk },
      { suffix: '/event', methods: ['POST'], fetch: handleBridgeEvent },
    ];
  }

  /** 把 Fetch 风格 handler 适配成本机 IPC 监听口的 Node 路由(req/res ⇄ Request/Response)。 */
  function nodeRouteFromFetch(dispatch) {
    return async (req, res) => {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
        const method = (req.method ?? 'GET').toUpperCase();
        const response = await dispatch(url, method, req.headers, body);
        const buffer = Buffer.from(await response.arrayBuffer());
        const headers = {};
        response.headers.forEach((value, key) => { headers[key] = value; });
        res.writeHead(response.status, headers);
        res.end(buffer);
      } catch (error) {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        if (!res.writableEnded) res.end('bridge route error');
        console.warn(`[code-server] 编辑器桥路由异常:${error && error.message ? error.message : error}`);
      }
    };
  }

  /** 桥挂载点的分发:按后缀查表,方法不符 405,未知路径 404(绝不落到 VS Code 那边)。 */
  async function dispatchBridge(url, method, headers, body) {
    const suffix = url.pathname.slice(BRIDGE_BASE.length) || '/';
    const route = bridgeRouteTable().find((item) => item.suffix === suffix);
    if (route === undefined) return jsonResponse({ ok: false, error: 'unknown bridge route' }, 404);
    if (!route.methods.includes(method)) return jsonResponse({ ok: false, error: 'method not allowed' }, 405);
    const request = new Request(url, {
      method,
      headers,
      ...(method === 'GET' || method === 'HEAD' ? {} : { body }),
    });
    // Origin 必须从 Node 的原始 headers 读:undici 的 Request 构造器把 `origin` 当 forbidden header
    // 归一化掉了,再读 request.headers 会得到 null,bridgeGuard 那道 403 就静默失效。
    request.dshcsRawHeaders = { get: (name) => headers[String(name).toLowerCase()] ?? null };
    return route.fetch(request);
  }

  /** 桥是否启用(行配置为种子,设置文档里可实时改)。 */
  function bridgeEnabled() {
    return bridgeSetting !== false;
  }

  /** 提示词段落在插件激活时注册一次:文本按"桥是否存活"渲染(桥停时为空串 → DSH 丢弃该段),
   *  所以在 IDE 从未启动的部署里它也只是一段空注册,不产生任何提示词开销。 */
  setPromptLiveProbe(() => bridgeMeta !== null);
  bridgePromptDispose = registerEditorPrompt(ctx);
  if (bridgePromptDispose === null && bridgeEnabled()) {
    console.warn('[code-server] 编辑器桥:systemPrompt 服务不可用,提示词段落未注册(工具仍可用)');
  }

  // 观察 agent 的写操作(→ 编辑器 diff 提示)并在写脏文件前附一条提醒。
  // 与 IDE 是否在跑无关:桥没起来时 isLive() 为 false,dirty 检查直接跳过。
  bridgeObserveDispose = registerBridgeObserver(ctx, {
    emit: (kind, fields) => bridgeEvents.push(kind, fields),
    context: () => bridgeContext.get(),
    isLive: () => bridgeMeta !== null && !bridgeContext.isStale(),
  });

  /** 同步桥运行时:写入/更新 bridge.json(端点 = 本机 IPC 路径 + 令牌 + pid)。
   *  端点、令牌、pid 三者任一变化都重写 —— 扩展每 5s 重读,故不需要任何推送。
   *  监听口起不来时**不写配置**(宁可休眠,不可指向死端点),并说明一次。 */
  function syncBridgeRuntime({ pid, startedAt }) {
    if (!bridgeEnabled()) return;
    const handle = bridgeListener;
    if (handle === null) {
      if (bridgeMeta !== null) {
        bridgeMeta = null;
        try { removeBridgeConfig(bridgeExtensionsDir); } catch { /* 删不掉也不影响:扩展会因端点在而连不上 */ }
      }
      return;
    }
    bridgeToken ??= mintBridgeToken();
    const changed = bridgeMeta === null || bridgeMeta.pipe !== handle.path || bridgeMeta.token !== bridgeToken || bridgeMeta.pid !== pid;
    bridgeMeta = { pipe: handle.path, token: bridgeToken, pid, startedAt: startedAt ?? null };
    try {
      writeBridgeConfig(bridgeExtensionsDir, { pipe: handle.path, token: bridgeToken, pid, startedAt: startedAt ?? null });
    } catch (err) {
      console.warn(`[code-server] 编辑器桥配置写入失败(${bridgeExtensionsDir}):${err && err.message ? err.message : err}`);
      return;
    }
    if (changed) {
      // 只打印端点与配置文件位置,不打印令牌本身(与 path-token 同一决策)。
      console.log(`[code-server] 编辑器桥:已启用(${handle.path}${BRIDGE_BASE}/*,令牌文件 ${path.join(bridgeMetaDir, 'bridge.json')})`);
    }
    ensureBridgeTools();
  }

  /**
   * 接管实例时对齐桥令牌:磁盘上已有配置、端点一致且是本机 IPC → 沿用(避免无谓轮换打乱正在运行的扩展);
   * 否则 mint 新的(扩展下次轮询就会读到新的 bridge.json,一次请求的失败无所谓)。
   */
  function adoptBridgeRuntime(pid, startedAt) {
    if (!bridgeEnabled()) return;
    const existing = readBridgeConfig(bridgeExtensionsDir);
    const endpoint = bridgeListener === null ? null : bridgeListener.path;
    bridgeToken = existing !== null && endpoint !== null && existing.pipe === endpoint && TOKEN_RE.test(String(existing.token))
      ? String(existing.token)
      : mintBridgeToken();
    syncBridgeRuntime({ pid, startedAt });
  }

  /** 注销桥运行时(停止 IDE / 插件卸载):删配置 + 注销工具 + 清缓存,扩展随即休眠。 */
  function clearBridgeRuntime() {
    bridgeToolDispose = disposeSafely(bridgeToolDispose);
    bridgeContext.clear();
    bridgeEvents.reset();
    if (bridgeMeta === null) return;
    bridgeMeta = null;
    try {
      removeBridgeConfig(bridgeExtensionsDir);
    } catch {
      // 配置删不掉不影响正确性(扩展会因 IDE 不可达而休眠)
    }
  }

  function disposeSafely(dispose) {
    if (typeof dispose !== 'function') return null;
    try {
      dispose();
    } catch (err) {
      console.warn(`[code-server] 桥工具注销失败:${err && err.message ? err.message : err}`);
    }
    return null;
  }

  /** 桥就绪时注册编辑器工具;`tools` / `defineTool` 缺失时静默退化为"只有本机 IPC 面"。 */
  function ensureBridgeTools() {
    if (bridgeMeta === null || bridgeToolDispose !== null) return;
    Promise.resolve(registerEditorTools(ctx, {
      target: () => bridgeMeta,
      cache: () => bridgeContext,
    }))
      .then((dispose) => {
        if (dispose === null) {
          console.log('[code-server] 编辑器桥:工具服务不可用,仅提供本机 IPC 面(editor_context/editor_diagnostics 未注册)');
          return;
        }
        // 期间桥可能已经被停掉(IDE 退出):立刻回滚,避免留下永远不可用的工具。
        if (bridgeMeta === null) {
          disposeSafely(dispose);
          return;
        }
        bridgeToolDispose = dispose;
        console.log('[code-server] 编辑器桥:已注册 editor_context / editor_diagnostics');
      })
      .catch((err) => {
        console.warn(`[code-server] 编辑器桥工具注册失败:${err && err.message ? err.message : err}`);
      });
  }

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

  // 编辑器桥的本机 IPC 监听口(web 与 desktop 同一套;不依赖 webServer,见 ensureBridgeListener)。
  ctx.effect(() => {
    if (bridgeEnabled()) void ensureBridgeListener();
    return () => { void stopBridgeListener(); };
  }, 'code-server: bridge ipc listener');

  /** 回环模式的客户端 URL:随机端口 + 路径令牌(令牌是 URL 路径的一段,浏览器会把子请求与 WS
   *  一并带过去 —— 这正是不走 VS Code 自带 cookie 令牌的原因,见 launcher 文件头"安全模型")。 */
  function loopbackUrl() {
    const token = typeof state.token === 'string' && state.token !== '' ? `${state.token}/` : '';
    return `http://${cfg.host}:${state.port}/${token}`;
  }

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
      // dsh 模式:同源相对地址(由 DSH webServer 的 prefix 路由提供服务);
      // loopback:随机端口 + 路径令牌(令牌只出现在这个 URL 里,客户端据此加载 iframe)
      url: running ? (dshMode ? '/code-server/' : loopbackUrl()) : null,
      productPath: state.env?.productPath ?? null,
      version: state.version,
      error: state.error,
      logTail: state.logTail.slice(-LOG_TAIL_MAX),
      adopted: state.adopted,
      keepResident,
      claimExtensions, // 客户端据此按扩展名决定认领哪些文件(0.2.11,取代 fileOpenScope)
      fullscreenOnOpen, // 客户端据此决定"打开标签即全屏右侧栏"(0.2.9)
      sidebarUi: state.sidebarUi,
      /** 编辑器桥状态(0.3.0,只读诊断面;**不含令牌** —— 令牌只在 bridge.json 里)。 */
      bridge: {
        enabled: bridgeEnabled(),
        live: bridgeMeta !== null,
        toolsRegistered: bridgeToolDispose !== null,
        /** 端点已就绪(本机 IPC 监听口在)。0.3.13 起 web 与 desktop 都是 true(不再依赖 webServer)。 */
        supported: bridgeListener !== null,
        /** 本机 IPC 端点(命名管道 / unix socket);null = 监听口没起来。 */
        endpoint: bridgeListener === null ? null : bridgeListener.path,
        file: path.join(bridgeMetaDir, 'bridge.json'),
      },
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
    clearBridgeRuntime(); // 桥在 IDE 停止时同步下线:配置删除,扩展随即休眠
    state.status = 'stopped';
    state.pid = null;
    state.cwd = null;
    state.launchCwd = null;
    state.token = null;
    state.port = cfg.port;
    state.startedAt = null;
    state.adopted = false;
    if (reason) state.error = null;
  }

  /** 就绪探针:loopback 走 TCP(带路径令牌),dsh 模式走命名管道。 */
  function probeReady(timeoutMs = 1500) {
    if (state.pipe !== null) return healthCheckPipe(state.pipe, timeoutMs);
    return healthCheck(cfg.host, state.port, state.token, timeoutMs);
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

    // 数据目录(adopt 路径也要用:被接管的 IDE 同样需要最新的内置扩展文件)
    const root = dataRoot(cfg);
    const userDataDir = cfg.userDataDir || path.join(root, 'user-data');
    const extensionsDir = cfg.extensionsDir || path.join(root, 'extensions');
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(extensionsDir, { recursive: true });

    // 端口占用则尝试 adopt(仅"显式指定端口"时;默认 port=0 由系统分配,不存在占用问题)。
    // 探针必须带路径令牌(被接管的实例是我们自己拉的,令牌在令牌文件里)——
    // 没有令牌文件说明那个实例不是本插件当前这代拉起来的,不接管。
    if (serve === 'loopback' && cfg.port !== 0) {
      const existingToken = readToken(cfg);
      const probe = await healthCheck(cfg.host, cfg.port, existingToken, 800);
      if (probe.ok) {
        const record = readPidFile(cfg);
        if (record && isAlive(record.pid)) {
          state.serve = 'loopback';
          state.status = 'running';
          state.pid = record.pid;
          state.port = cfg.port;
          state.token = existingToken;
          state.cwd = cwd ?? record.cwd ?? null;
          state.launchCwd = record.launchCwd ?? record.cwd ?? null;
          state.startedAt = record.startedAt ?? null;
          state.adopted = true;
          // 被接管的 IDE **不会**重新加载扩展:文件可以同步,但扩展宿主里跑的仍是上次启动时那份代码。
          // 桥的传输/协议变更(0.3.13 的 url → pipe)会让旧代码读到 v2 配置后休眠 —— 必须明说,否则
          // 表现又是那句无法自查的"编辑器还没有上报状态"。
          const synced = installBundledExtensions(extensionsDir, userDataDir);
          if (synced.updated.length > 0) {
            console.warn(`[code-server] 内置扩展文件已更新(${synced.updated.join(',')}),`
              + '但正在运行的 IDE 里跑的是旧代码:请在 Code Server 标签里重载一次窗口(或重启 IDE),'
              + '否则编辑器桥不会连上');
          }
          adoptBridgeRuntime(record.pid, state.startedAt);
          return snapshot();
        }
        state.status = 'error';
        state.error = `端口 ${cfg.port} 已被占用且没有有效的 pid.json 记录(拒绝误杀);请释放端口或把 port 改回 0(随机端口)`;
        return snapshot();
      }
    }

    // 安装树内自带扩展(dshcs-open-file:host 信号文件 → VS Code 打开文件;
    // dshcs-editor-bridge:编辑器桥的扩展侧,0.3.0)
    installBundledExtensions(extensionsDir, userDataDir);

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
        // 随机端口(port=0)+ 路径令牌:令牌**不进程 argv**(本机任意进程都能读命令行),
        // 走文件传递;实际端口由 launcher 写 endpoint 文件回报。
        fs.rmSync(endpointFile(cfg), { force: true }); // 清掉上一实例的记录,避免读到旧端口
        state.token = rotateToken(cfg);
        args.push('--port', String(cfg.port), '--host', cfg.host,
          '--token-file', tokenFile(cfg), '--endpoint-file', endpointFile(cfg));
      }
      if (typeof cfg.locale === 'string' && cfg.locale !== '') args.push('--locale', cfg.locale);
    }
    if (cwd !== undefined && launch.kind !== 'launcher') args.push(cwd);

    state.serve = serve;
    state.error = null;
    state.logTail = '';
    state.status = 'starting';
    state.port = serve === 'dsh' ? null : cfg.port;
    state.cwd = cwd ?? null;
    state.launchCwd = cwd ?? null;
    state.startedAt = Date.now();
    state.adopted = false;

    const env = { ...process.env };
    // 内置扩展信号文件路径(host → 扩展 打开文件)
    env.DSHCS_OPEN_FILE_SIGNAL = openFileSignalPath(userDataDir);
    // 扩展目录(host → 扩展 找桥配置 `/.dshcs-bridge/bridge.json`)。
    // **必须注入**:0.3.12 起桥扩展装在**内置**目录(树里),与 <extensionsDir> 不同级,
    // 扩展再也不能靠"自己的路径上溯两级"找到配置(0.3.0–0.3.11 那个上溯是错的,多上溯了一级,
    // 就算装在用户级也读不到配置 ⇒ 桥一直是休眠态)。
    env.DSHCS_EXTENSIONS_DIR = extensionsDir;
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
    /** 实例记录:pid 一到手就先写(崩溃/回收要靠它);端口 0 时在拿到实际端口后再补写一次。 */
    const writeInstanceRecord = () => writePidFile(cfg, {
      pid: proc.pid,
      startedAt: state.startedAt,
      cwd: cwd ?? null,
      launchCwd: cwd ?? null,
      host: serve === 'dsh' ? null : cfg.host,
      port: serve === 'dsh' ? null : state.port,
      serve,
      pipe: state.pipe,
      launchKind: launch.kind,
      launchCommand: launch.kind === 'bin' ? launch.command : launch.script,
      tokenized: state.token !== null,
    });
    writeInstanceRecord();

    proc.stdout?.on?.('data', appendLog);
    proc.stderr?.on?.('data', appendLog);

    // 端口 0(默认)时 host 只能从 endpoint 文件知道实际端口:等 launcher 写完再开始就绪轮询。
    if (launch.kind === 'launcher' && serve === 'loopback' && cfg.port === 0) {
      const deadline = Date.now() + 10000;
      let endpoint = null;
      while (endpoint === null && Date.now() < deadline) {
        endpoint = readEndpoint(cfg);
        if (endpoint !== null && endpoint.pid !== (proc.pid ?? -1)) endpoint = null; // 旧进程的残留记录
        if (endpoint === null) await new Promise((r) => setTimeout(r, 100));
      }
      if (endpoint === null) {
        state.status = 'error';
        state.error = 'launcher 未回报监听端口(endpoint 文件缺失);请查看启动日志';
        return snapshot();
      }
      state.port = endpoint.port;
      writeInstanceRecord();
      console.log(`[code-server] 随机端口: ${state.port}(host=${endpoint.host}, pid=${endpoint.pid})`);
    }
    // 编辑器桥:端口已定(loopback + 已知端口)时写入配置,扩展随即能连上来。
    // 新启动会轮换桥令牌 —— 与路径令牌同一时机(每次新启动都换)。
    // dsh 模式(无独立端口)不启用:桥的 Host 白名单假设是 127.0.0.1:<实际端口>,管道模式没有端口。
    // 桥与 serve 模式无关:只要求"扩展宿主能到达 DSH 的 HTTP 面"(web 有 webServer;
    // desktop 没有 → syncBridgeRuntime 会自己判定并保持休眠)。
    bridgeToken = mintBridgeToken();
    syncBridgeRuntime({
      pid: proc.pid ?? null,
      startedAt: state.startedAt,
    });

    proc.on('error', (err) => {
      if (child !== proc) return;
      child = null;
      removePidFile(cfg);
      clearBridgeRuntime();
      state.status = 'error';
      state.error = `code-server 启动失败: ${err && err.message ? err.message : String(err)}\n${state.logTail.slice(-1000)}`;
    });

    proc.on('exit', (code, signal) => {
      if (child !== proc) return; // 已被 stop/dispose 接管
      child = null;
      removePidFile(cfg);
      clearBridgeRuntime();
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

  // ---- 编辑器桥路由(0.3.0)----
  // 这些路由**不依赖** DSH 的 cookie 认证:扩展宿主是 Node 进程,拿不到浏览器 cookie,
  // 所以自带独立令牌(见 lib/bridge.mjs 顶部的安全不变量)。命名空间永久只读。

  /** 每个桥路由都先过 guard;返回 Response 表示拒绝,调用方直接返回它。 */
  function bridgeRejection(request) {
    return bridgeGuard(request, bridgeMeta === null ? null : bridgeMeta.token);
  }

  /** 桥不可达时的统一 503(扩展侧没跑 / IDE 刚起还没加载扩展)。 */
  function bridgeDown(reason) {
    return jsonResponse({ ok: false, error: reason }, 503);
  }

  async function handleBridgeHealth() {
    // 无鉴权:只回一句"桥活着吗",不含任何编辑器数据(便于重启后一眼确认)。
    // 注意:bridge=true 只表示"配置已就绪",**不代表扩展在跑**(见 README 已知限制)。
    return jsonResponse({
      ok: true,
      bridge: bridgeMeta !== null,
      pid: state.pid,
      transport: 'ipc',
      endpoint: bridgeMeta === null ? null : bridgeMeta.pipe,
    });
  }

  async function handleBridgeSync(request) {
    const denied = bridgeRejection(request);
    if (denied !== null) return denied;
    let body;
    try {
      body = await readJsonBody(request);
    } catch {
      return jsonResponse({ ok: false, error: '请求体不是合法 JSON' }, 400);
    }
    if (!bodyWithinLimit(body)) return jsonResponse({ ok: false, error: '上报内容过大' }, 413);
    bridgeContext.update(body);
    // 取事件 + 推进游标:与上报同一趟来回,扩展不需要第二个定时器。
    let since = 0;
    try {
      const raw = new URL(request.url).searchParams.get('since');
      const parsed = raw === null ? 0 : Number.parseInt(raw, 10);
      if (Number.isSafeInteger(parsed) && parsed > 0) since = parsed;
    } catch {
      since = 0;
    }
    const events = bridgeEvents.since(since);
    bridgeEvents.reset();
    return jsonResponse({ ok: true, events });
  }

  async function handleBridgeAsk(request) {
    const denied = bridgeRejection(request);
    if (denied !== null) return denied;
    let body;
    try {
      body = await readJsonBody(request);
    } catch {
      return jsonResponse({ ok: false, error: '请求体不是合法 JSON' }, 400);
    }
    const text = typeof body.text === 'string' ? body.text : '';
    if (text === '') return jsonResponse({ ok: false, error: '需要 text 字段(要问 DSH 的话)' }, 400);
    const file = typeof body.file === 'string' && body.file !== '' ? body.file : null;
    const lineStart = Number.isSafeInteger(body.lineStart) ? body.lineStart : null;
    const lineEnd = Number.isSafeInteger(body.lineEnd) ? body.lineEnd : null;
    const selection = typeof body.selection === 'string' && body.selection !== '' ? body.selection : null;
    // 交给 bridge-session.mjs(agent 投递);它内部特性探测 agents,缺失时返回
    // {ok:false, code:'NO_AGENT'} —— 这里原样透传,并把 NO_AGENT 映射成 409。
    const result = await deliverEditorPrompt(ctx, {
      text,
      file,
      lineStart,
      lineEnd,
      selection,
      languageId: typeof body.languageId === 'string' ? body.languageId : null,
    });
    return jsonResponse(result, result.ok === true ? 200 : (result.code === 'NO_AGENT' ? 409 : 200));
  }

  async function handleBridgeEvent(request) {
    const denied = bridgeRejection(request);
    if (denied !== null) return denied;
    const body = await readJsonBody(request);
    const kind = typeof body.kind === 'string' ? body.kind : '';
    if (kind === '') return jsonResponse({ ok: false, error: '需要 kind 字段' }, 400);
    // 扩展上报的编辑器侧事件(打开/关闭文件等):目前只进日志尾,供诊断时回看。
    appendLog(`[bridge] ${kind}${typeof body.path === 'string' ? ` ${body.path}` : ''}\n`);
    return jsonResponse({ ok: true });
  }


  // 每条操作一条 exact Fetch 路由。desktop 的 assetHandler 只把 /api/* 交给
  // createSharedFetchHandler('/api'),所以路径必须落在 /api 下。
  const disposers = [    { path: `${API_BASE}/status`, methods: ['GET'], fetch: handleStatus },
    { path: `${API_BASE}/start`, methods: ['POST'], fetch: handleStart },
    { path: `${API_BASE}/stop`, methods: ['POST'], fetch: handleStop },
    { path: `${API_BASE}/setup`, methods: ['POST'], fetch: handleSetup },
    { path: `${API_BASE}/open-file`, methods: ['POST'], fetch: handleOpenFile },
    { path: `${API_BASE}/ui-mode`, methods: ['POST'], fetch: handleUiMode },
    // ---- 编辑器桥的 4 条路由**不在 /api 下**(0.3.9 修正)----
    // 原因:Connection 给 `/api` 装了 cookie fence(无 cookie → 401),而扩展宿主是 Node 进程、
    // 永远拿不到浏览器 cookie ⇒ 挂在这里的路由根本到不了(实测:带令牌也被 401/405 挡回)。
    // 现在挂到 DSH webServer 的 `${BRIDGE_BASE}/*`,自带桥令牌鉴权(见该处注释与 lib/bridge.mjs 的安全不变量)。
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
      bridgeObserveDispose = disposeSafely(bridgeObserveDispose);
      bridgePromptDispose = disposeSafely(bridgePromptDispose);
      clearBridgeRuntime();
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

  // DSH host 重启后 adopt(仅 loopback 模式):pid.json 有效、进程存活、令牌文件在、endpoint 记录的端口
  // 上 /healthz(带令牌)响应 → 接管。端口 0 时不能拿 cfg.port 去探(那是个占位值),必须用 endpoint 文件。
  // dsh 模式的 launcher 带 --parent-pid 看门狗:host 一退出它就自行退出,不存在可接管的孤儿。
  if (liveInstance && (record.serve !== 'dsh')) {
    const adoptedToken = readToken(cfg);
    const endpoint = readEndpoint(cfg);
    const adoptPort = endpoint !== null && endpoint.pid === record.pid ? endpoint.port : (cfg.port !== 0 ? cfg.port : null);
    const probe = adoptPort === null || adoptedToken === null
      ? { ok: false }
      : await healthCheck(cfg.host, adoptPort, adoptedToken, 800);
    if (probe.ok) {
      state.serve = 'loopback';
      state.status = 'running';
      state.pid = record.pid;
      state.port = adoptPort;
      state.token = adoptedToken;
      state.cwd = record.cwd ?? null;
      state.launchCwd = record.launchCwd ?? record.cwd ?? null;
      state.startedAt = record.startedAt ?? null;
      state.adopted = true;
      console.log(`[code-server] adopted running instance pid=${record.pid} port=${adoptPort}(令牌已启用)`);
      adoptBridgeRuntime(record.pid, state.startedAt);
    } else {
      removePidFile(cfg);
    }
  } else if (liveInstance) {
    removePidFile(cfg); // 上次是 dsh 模式(管道随进程消失)→ 清理陈旧记录
  }

  maybePrestart();

  console.log(`[code-server] static plugin loaded (serve=${requestedServe()} host=${cfg.host} port=${cfg.port === 0 ? '0=随机' : cfg.port})`);
}
