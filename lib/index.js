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
import { ensureRuntimeLayout, nativeRuntimeStatus } from './native.js';
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
// FIM(幽灵)补全(实验性):**注册一个自己的 LLM 适配器**而不是直连 —— 见 lib/fim-adapter.mjs 顶部。
import {
  clampDebounce,
  compileGlobList,
  createApiKeyResolver,
  createFimAdapterClass,
  createFimBudget,
  createFimStats,
  encodeFimRequest,
  FIM_MAX_TOKENS,
  FIM_MODEL,
  FIM_PROVIDER,
  loadFimBase,
  matchDisabledGlob,
  toSingleLine,
} from './fim-adapter.mjs';
import { registerEditorPrompt, registerEditorTools, setPromptLiveProbe } from './bridge-tools.mjs';
import { deliverEditorPrompt } from './bridge-session.mjs';
import { dshEntry, dshRequire } from './dsh-resolve.mjs';
import { childNodeEnv, resolveChildNode } from './child-node.mjs';
import { registerBridgeObserver } from './bridge-observe.mjs';
import { createSnapshotStore, snapshotResponse } from './edit-snapshot.mjs';
import { createThreadRegistry } from './bridge-thread.mjs';
import { createApprovalBoard, createApprovalInterceptor, DEFAULT_HOLD_MS, PANEL_OUTCOMES } from './bridge-approval.mjs';

// schemastery 由 DSH 部署自带(官方核心依赖),仿 auto-open-web 的解析策略:
// 常规 import 优先,不可用时回退到 DSH 部署里的那一份。
//
// 回退走 lib/dsh-resolve.mjs 的 dshRequire() —— 部署位置表就一份(0.3.49 起按平台铺开):
// 正在跑的部署(argv[1]/execPath 向上解析)、Windows `%APPDATA%\npm`、`npm --prefix`
// (`~/.npm-global`)、pnpm global、nvm、系统 `/usr/local|/usr`、以及 `$DSH_HOME` 的 profile 层。
// 这些布局**都得在**:0.3.47 的 Windows 冒烟只证明过 `%APPDATA%\npm` 那条,0.3.48 的 Linux 冒烟
// (CLI 装到 `~/.npm-global`)就把"表太窄"当场打出来了 —— 解析不到 schemastery 时整个插件不可用。
// 全都拿不到时才抛错(不是静默降级:设置 schema 建不出来,插件没有意义)。
let z = null;
try {
  z = (await import('@deepseek-ai/schemastery')).default;
} catch {
  try {
    const req = dshRequire();
    if (req !== null) z = req('@deepseek-ai/schemastery');
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
  /** fim=false(默认):**实验性**的 FIM(幽灵)补全。开启后宿主的编辑器桥多一条**有界的模型调用**
   *  路由(`POST /complete`),编辑器里的内联补全(灰字)由它供给;宿主为此注册一个自己的 LLM
   *  适配器路由 `dshcs-fim`(走 Completions API 的 `/beta/completions`)。
   *
   *  为什么默认关、为什么叫实验性:①它会把**光标附近的代码**发给模型(桥的其余部分是只读状态,
   *  不外发内容);②模型在"不该补的位置"会硬凑(实测 2/2 复现),需要编辑器侧判据兜;
   *  ③这条调用**不进 DSH 的 token 计量**(一次性调用不是 loop 请求,不写会话日志),
   *  用量只在扩展状态栏与设置卡里可见。安全模型见 lib/fim-adapter.mjs 顶部。 */
  fim: z.boolean().default(false),
  /** 停顿多久才发一次补全请求(毫秒)。太小 ⇒ 打字过程中反复触发;太大 ⇒ 失去"补全"的意义。
   *  取值在消费处夹到 [100, 3000](clampDebounce),设置里填什么都不至于打到链路上。 */
  fimDebounceMs: z.number().default(250),
  /** 是否允许多行补全(true 默认)。false ⇒ 宿主只回第一行(空首行 = 这次不补)。
   *  关掉它是最省心的安全阀:实测模型在"不该补的位置"会硬凑,多行会把这种噪声放大。 */
  fimMultiline: z.boolean().default(true),
  /** 按 glob 禁用补全的文件(分号 / 逗号 / 空白 / 换行分隔;空 = 不禁用)。
   *  语义:`*` 不跨目录、`**` 跨目录、不含 `/` 的模式只匹配文件名、`/` 结尾视作 `/**`。
   *  两侧都会判:扩展侧先判(不发请求),宿主侧再判(防线在服务端)。 */
  fimDisableGlobs: z.string().default(''),
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
  /** FIM 补全(实验性,0.3.61):见 Config.fim。默认关。 */
  fim: false,
  /** FIM 的三个子项(0.3.62):停顿毫秒数 / 是否多行 / 按 glob 禁用。见 Config 里的说明。 */
  fimDebounceMs: 250,
  fimMultiline: true,
  fimDisableGlobs: '',
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
        // 文件删完还要**收掉空目录**:0.3.59 删掉了整个 webview/ 子目录,只删文件的话会在用户的
        // VS Code 树里留下一串空目录(实测:webview/、webview/src、webview/fonts 各 0 字节)。
        // 自底向上收,只收"确实空了"的目录(非空的目录说明里面有别的东西,不动)。
        const pruneEmptyDirs = (rel) => {
          const abs = rel === '' ? dst : path.join(dst, rel);
          let entries;
          try {
            entries = fs.readdirSync(abs, { withFileTypes: true });
          } catch {
            return;
          }
          for (const ent of entries) {
            if (ent.isDirectory()) pruneEmptyDirs(rel === '' ? ent.name : `${rel}/${ent.name}`);
          }
          if (rel === '') return;
          try {
            if (fs.readdirSync(abs).length === 0) {
              fs.rmdirSync(abs);
              removed.push(`${rel}/`);
            }
          } catch {
            // 竞态(别的东西刚写进来)或权限问题:保持原样,不影响主流程
          }
        };
        pruneEmptyDirs('');
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

/** 已安装的内置扩展里最新的文件 mtime(ms);取不到返回 null。
 *
 *  用途:**adopt(接管正在运行的 IDE)时判断"里面跑的是不是升级前的旧代码"**。
 *  扩展代码只在扩展宿主进程启动时被加载一次 —— 文件是新的不代表跑着的进程里是新的。
 *  `mtime > IDE 进程启动时间` 说明这些文件是在该进程起来之后写的,那个进程不可能加载过它们。
 *  (可能偏保守:之后重载过窗口就没事了 —— 所以提示写成"可能/重载即可"。) */
export function newestBundledExtensionMtime(extensionsDir, options = {}) {
  const treeRoot = options.treeRoot === undefined ? vsRoot() : options.treeRoot;
  let newest = null;
  for (const ext of BUNDLED_EXTENSIONS) {
    const target = extensionTarget(extensionsDir, ext.name, ext.placement, treeRoot);
    if (!fs.existsSync(target.dst)) continue;
    let files;
    try {
      files = listExtensionFiles(target.dst);
    } catch {
      continue;
    }
    for (const rel of files) {
      try {
        const at = fs.statSync(path.join(target.dst, rel)).mtimeMs;
        if (newest === null || at > newest) newest = at;
      } catch {
        // 单个文件 stat 失败不影响结论
      }
    }
  }
  return newest;
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
  const natives = nativeRuntimeStatus();
  const installed = root !== null ? readTreeVersion(root) : null;
  const vendored = vendoredVersion();
  return {
    ok: entry !== null && inner.missing.length === 0
      && natives.resolved > 0 && natives.missing.length === 0,
    tree: root !== null ? root.replace(/\\/g, '/') : null,
    entry: entry !== null ? entry.replace(/\\/g, '/') : null,
    productPath: productPath(root),
    vscodeInner: inner.missing.length === 0,
    innerDeps: { declared: inner.declared, resolved: inner.resolved, missing: inner.missing },
    treeVersion: installed,
    vendored,
    upToDate: installed !== null && vendored !== null && installed === vendored,
    // 本平台预编译原生产物(重打包子包按真名装进依赖图,运行时按原名补 junction)
    nativeRuntime: {
      name: natives.name,
      source: natives.source,
      version: natives.version,
      packages: natives.resolved,
      missing: natives.missing,
    },
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

/** 仅测试用:最近一次 apply() 装好的桥分发器(消费方是文件末尾的 bridgeRequestForTests)。
 *  运行时代码**不读它** —— 它存在的唯一目的是让回归不必经过命名管道,原因见那个函数的注释。 */
let activeBridgeDispatch = null;

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
  /** FIM 补全开关(实验性,0.3.61):行配置 cfg.fim 是种子,设置文档里可改并实时生效。默认关。 */
  let fimSetting = cfg.fim === true;
  /** FIM 的三个子项(0.3.62):停顿毫秒数 / 是否多行 / 按 glob 禁用(原始文本,消费时解析)。 */
  let fimDebounceMs = clampDebounce(cfg.fimDebounceMs);
  let fimMultiline = cfg.fimMultiline !== false;
  let fimDisableGlobs = typeof cfg.fimDisableGlobs === 'string' ? cfg.fimDisableGlobs : '';
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
        fimSetting = resolved && typeof resolved.fim === 'boolean' ? resolved.fim : fimSetting;
        fimDebounceMs = clampDebounce(resolved && resolved.fimDebounceMs !== undefined ? resolved.fimDebounceMs : fimDebounceMs);
        fimMultiline = resolved && typeof resolved.fimMultiline === 'boolean' ? resolved.fimMultiline : fimMultiline;
        fimDisableGlobs = resolved && typeof resolved.fimDisableGlobs === 'string' ? resolved.fimDisableGlobs : fimDisableGlobs;
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
        // FIM(实验性):开 → 注册我们自己的 LLM 适配器路由(编辑器补全要靠它);
        // 关 → 注销。翻转立刻生效,不需要重启宿主(扩展侧下一趟 /sync 就会看到 enabled 变了)。
        if (next != null && typeof next.fim === 'boolean') {
          if (next.fim !== fimSetting) {
            fimSetting = next.fim;
            console.log(`[code-server] fim updated: ${fimSetting}(实验性 FIM 补全)`);
            void ensureFimAdapter();
          }
        }
        // FIM 的三个子项(0.3.62):都**即时生效**,不需要重启宿主 —— 扩展每趟 /sync 都会拿到新值
        // (停顿与 glob 是扩展侧行为,多行由宿主在返回前裁)。改动只打一行日志,便于事后对齐现场。
        if (next != null && next.fimDebounceMs !== undefined) {
          const clamped = clampDebounce(next.fimDebounceMs);
          if (clamped !== fimDebounceMs) {
            fimDebounceMs = clamped;
            console.log(`[code-server] fimDebounceMs updated: ${fimDebounceMs}ms`);
          }
        }
        if (next != null && typeof next.fimMultiline === 'boolean') {
          if (next.fimMultiline !== fimMultiline) {
            fimMultiline = next.fimMultiline;
            console.log(`[code-server] fimMultiline updated: ${fimMultiline}`);
          }
        }
        if (next != null && typeof next.fimDisableGlobs === 'string') {
          if (next.fimDisableGlobs !== fimDisableGlobs) {
            fimDisableGlobs = next.fimDisableGlobs;
            console.log(`[code-server] fimDisableGlobs updated: ${compileGlobList(fimDisableGlobs).length} 条`);
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
  /** 会话流订阅 / 授权拦截的 disposer。 */
  let bridgeAnswerDispose = null;
  /** 推给编辑器的事件环形缓冲(tools/result → 扩展轮询)。 */
  const bridgeEvents = createEventRing();
  /** 写前原文快照缓存(0.3.55):事件里带不透明 key,扩展走 GET /old 取文本。
   *  有界(条数/字节/存活时长),所以"host 侧不持有文件内容"这条不变量仍然成立 ——
   *  它持有的是最近几次 agent 写操作的写前副本,且随时会被淘汰。 */
  const bridgeSnapshots = createSnapshotStore();
  /** 编辑器状态缓存:扩展在每次 /sync 里推上来,agent 的工具调用来读它。 */
  const bridgeContext = createContextCache();
  /** 被面板观看的会话 → 对话条目流(只渲染新内容;见 lib/bridge-thread.mjs)。 */
  const bridgeThread = createThreadRegistry({
    resolveController: () => {
      try {
        return ctx.get('sessionController');
      } catch {
        return undefined;
      }
    },
    log: (message) => console.warn(`[code-server] 编辑器桥会话流:${message}`),
  });
  /** 面板的授权决策登记表 + agent 作用域拦截器(见 lib/bridge-approval.mjs)。 */
  const bridgeApprovalBoard = createApprovalBoard();
  /**
   * 谁在"看着这个会话" —— 授权拦截据此决定要不要抢答(没人看就直接交给官方链路):
   *   - `dialogIds`:DSH 页面里的对话框(0.3.24)声明要看的会话;
   *   - `at`:最近一次声明的时间(诊断用)。
   *
   * 0.3.59:编辑器扩展的 webview 面板退役后只剩对话框一路 —— 以前还有 `ids`(扩展每趟 /sync 上报的
   * 观看列表),两个来源求并集、还要按心跳新鲜度区分,现在都不需要了。
   */
  const bridgeWatch = { dialogIds: [], at: 0 };
  /** 上次记录过的"有没有人在看"(0.3.30:状态翻转才写诊断日志)。 */
  let bridgeWatchLogged = false;
  /** 首帧是否已写过诊断(0.3.31:"一直没人看"也要留下证据)。 */
  let bridgeWatchWroteFirst = false;
  /** 上次写过的 hasPanel 判据原文(变了才写,避免每 600ms 刷屏)。 */
  let bridgeHasPanelLine = '';

  /**
   * 授权/看护状态的**诊断日志**(0.3.30):写到 <home>/.dsh/code-server/bridge-approval.log。
   * "卡片为什么不出现"只有三个问题:有没有人在看 / 请求到没到 / 谁答的 —— 三件事都在宿主进程里,
   * 用户看不到、我也读不到;落成有界文件后一次复现就能定论。
   */
  function bridgeDiag(message) {
    try {
      const dir = path.join(os.homedir(), '.dsh', 'code-server');
      fs.mkdirSync(dir, { recursive: true });
      const file2 = path.join(dir, 'bridge-approval.log');
      try {
        if (fs.statSync(file2).size > 256 * 1024) fs.writeFileSync(file2, '');
      } catch {
        // 首次写入:文件不存在
      }
      fs.appendFileSync(file2, new Date().toISOString() + ' ' + message + '\n');
    } catch {
      // 诊断失败绝不影响主流程
    }
  }

  /** 当前所有"在看"的会话(去重)。 */
  function watchedSessions() {
    return [...new Set(bridgeWatch.dialogIds.filter((id) => typeof id === 'string' && id !== ''))].slice(0, 4);
  }
  /** 现在有没有人在看(授权拦截的唯一判据)。 */
  function hasWatcher() {
    // 0.3.59 起只有对话框一路。**对话框是宿主侧状态**(只在 /ask/close 时消失),所以不拿轮询新鲜度
    // 去判它 —— 浏览器把后台标签的定时器节流到分钟级时,900ms 的心跳一断、5 秒窗口就过期,
    // 我们会误判"没人看"而放弃拦截(用户实测:授权卡片因此跑到 DSH 界面)。
    return watchedSessions().length > 0;
  }

  const bridgeApproval = createApprovalInterceptor({
    board: bridgeApprovalBoard,
    holdMs: DEFAULT_HOLD_MS,
    // **只在对话框真的能显示卡片时才抢答**(0.3.30 / 0.3.59 收紧)。
    // 反例(用户实测):面板处于"宿主没有对话流能力"的坏状态时我们仍然抢答 ⇒ 官方卡片不出现、
    // 面板也不画 ⇒ 用户看到的是"没弹出授权",请求在宿主里干等 5 分钟。
    // 0.3.59 起编辑器面板退役,"能显示卡片"只剩**对话框开着 + 有人看 + 客户端半部在轮询**一条路
    // (客户端自己声明 approvalsUi 那条也随面板一起删了 —— 声明者已经不存在)。
    hasPanel: () => {
      const watcher = hasWatcher();
      const dialogCapable = askDialogLive();
      const verdict = watcher && dialogCapable;
      // 判据的**原始值**一起落日志(0.3.35):只记结论的话,出问题还是只能猜。
      const line = 'hasPanel -> ' + verdict + ' (hasWatcher=' + watcher
        + ' dialogLive=' + dialogCapable + ' polls=' + askDialog.polls + ' open=' + askDialog.open
        + ' session=' + String(askDialog.sessionId) + ')';
      if (line !== bridgeHasPanelLine) { bridgeHasPanelLine = line; bridgeDiag(line); }
      return verdict;
    },
    log: (message) => {
      console.warn(`[code-server] 编辑器桥授权:${message}`);
      bridgeDiag(`approval: ${message}`);
    },
  });

  /**
   * 「问 DSH」对话框的宿主侧状态(0.3.24)。
   *
   * 对话只有一个宿主:**DSH 页面里的浮动对话框**(client 半部,见 lib/client.js)。host 这边只负责:
   *   - 打开/关闭状态(编辑器扩展右键 → 桥 `/event` 上报 `ask-open`);
   *   - 状态与动作的 HTTP 面(`/api/code-server/ask/*`,与 DSH 同源、吃它的 cookie/Origin 校验);
   *   - 把"被看的会话"投影成有界条目流(见 lib/bridge-thread.mjs)与待决授权快照。
   *
   * **0.3.59 起不再往页面里送产物,也不再服务编辑器面板**:面板就在 `lib/client.js` 里,渲染器走
   * DSH 页面的模块表(`react-dom/client` + `@deepseek-ai/dsh-client-ui-primitives`);
   * `/ask/bundle` 路由、`askBundle()` 与编辑器里的 webview 面板在同一版里一起删掉
   * (thread.js / thread.css / build-webview.mjs / esbuild 那一整套)。
   */
  const askDialog = { open: false, armed: false, mode: 'selection', at: 0, sessionId: null, polls: 0, lastPollAt: 0 };

  /**
   * 对话框"活着吗" —— **能力位必须以此为准**(0.3.25)。
   *
   * 0.3.24 的教训:宿主无条件报 `askDialog: true`,扩展于是不再开编辑器面板;而客户端半部只要没跑起来
   * (浏览器还缓存着旧 bundle / 没硬刷新),就**没有任何一方在看这个会话** ⇒ 授权悄悄落到 DSH 界面的
   * 官方卡片,用户在编辑器里什么都看不到。现在只有**真的收到过 `/ask/state` 轮询**(10 分钟内)才算有
   * 这个能力;0.3.59 起不满足时扩展也不再退编辑器面板(那一半已退役),而是明确提示用户刷新/打开页面。
   */
  function askDialogLive() {
    // 对话框每 900ms 问一次 /ask/state —— 那就是"活跃心跳"。心跳一旦建立,在 TTL 内
    // **整个 DSH 侧都把授权拦截到编辑器侧**(用户的要求:对话框开着就持续发活跃通知)。
    // TTL 取 10 分钟:浏览器后台节流会把 900ms 拖到分钟级,短 TTL 会让"人就在编辑器旁边"
    // 被误判成"没人看"(实测连续踩了两轮)。
    const TTL_MS = 10 * 60 * 1000;
    // **必须在"武装"状态下**才算有能力显示卡片(0.3.40):
    // 只认"最近轮询过"会让**已经关掉的对话框**在 10 分钟内继续被当成能显示卡片的 UI ——
    // 那时我们仍会接住请求,而卡片无处显示(就是用户说的"没弹出授权")。
    // armed 在 /ask/state 轮询时置位,在 /ask/close 时立刻清除 ⇒ 关掉之后下一次判据复查(≤500ms)
    // 就会把正在等待的请求交回官方卡片。
    if (askDialog.armed === true && askDialog.polls > 0 && Date.now() - askDialog.lastPollAt < TTL_MS) return true;
    // 心跳还没建立(刚重启)时:对话框开着且有会话也算。
    return askDialog.open && askDialog.sessionId !== null;
  }

  /** 缓存里的活动编辑器 → 提问上下文(mode 决定带不带行号/选区,与扩展侧 0.3.21 的语义一致)。 */
  function askContextFromCache(mode) {
    const cached = bridgeContext.get();
    const active = cached === null ? null : cached.context?.active ?? null;
    if (active === null || active === undefined) return null;
    const selection = active.selection ?? null;
    const selectedText = typeof active.selectedText === 'string' ? active.selectedText : '';
    const hasSelection = mode === 'selection' && selection !== null && selectedText !== '';
    return {
      file: typeof active.path === 'string' && active.path !== '' ? active.path : null,
      lineStart: hasSelection ? selection.startLine ?? null : null,
      lineEnd: hasSelection ? selection.endLine ?? null : null,
      selection: hasSelection ? selectedText : null,
      languageId: typeof active.language === 'string' && active.language !== '' ? active.language : null,
    };
  }

  /** 对话框那一行上下文描述(标题栏用)。 */
  function askContextLine(mode) {
    const context = askContextFromCache(mode);
    if (context === null || context.file === null) return '来自编辑器';
    const base = context.file.replace(/^.*[\\/]/, '');
    const where = Number.isSafeInteger(context.lineStart)
      ? `${base}:${context.lineStart}${Number.isSafeInteger(context.lineEnd) && context.lineEnd !== context.lineStart ? `-${context.lineEnd}` : ''}`
      : base;
    return mode === 'file' ? `来自编辑器:${where} · 针对当前文件` : `来自编辑器:${where} · 针对选中内容`;
  }

  /**
   * 对话框要的状态 —— **形状必须与面板载荷一致**(`lib/ask-panel.js` 的 `applyPayload`:
   * 扁平的 entries / approvals / …),因为对话框里跑的就是同一个面板应用。
   */
  function askState() {
    const watch = watchedSessions();
    const snapshot = bridgeThread.supported()
      ? bridgeThread.snapshot(watch)
      : { available: false, sessionId: null, cursor: null, rev: 0, entries: [], error: '宿主没有 sessionController.follow(DSH 版本过旧)' };
    return {
      ok: true,
      open: askDialog.open,
      mode: askDialog.mode,
      contextText: askContextLine(askDialog.mode),
      entries: Array.isArray(snapshot.entries) ? snapshot.entries : [],
      available: snapshot.available === true,
      threadError: typeof snapshot.error === 'string' && snapshot.error !== '' ? snapshot.error : null,
      approvals: bridgeApprovalBoard.snapshot(),
      approvalHoldMs: DEFAULT_HOLD_MS,
      status: 'idle',
      statusText: '',
      error: null,
      sessionId: snapshot.sessionId ?? askDialog.sessionId ?? null,
      // 0.3.59:`uiVersion` 只服务过"面板内置渲染器与界面版本比对"那行告警 —— 面板退役后删掉。
      // `dshVersion` 留着:诊断时一眼看出这套宿主跑在哪个 DSH 上。
      dshVersion: dshVersion(),
    };
  }

  /** 修订号:对话条目 / 待决授权 / 开关状态任何一处变了就变。 */
  function askRevision() {
    return bridgeThread.rev(watchedSessions()) * 8 + bridgeApprovalBoard.rev() * 8 + (askDialog.open ? 1 : 0) + (askDialog.mode === 'file' ? 2 : 0);
  }

  /** 对话框刷新它的"我在看"时间戳(每趟 /state 都算一次)。
   *  0.3.59 起这里也负责对齐会话流订阅:以前是扩展每 600ms 的 `/sync` 顺带做的。 */
  function refreshDialogWatch() {
    bridgeWatch.dialogIds = askDialog.open && askDialog.sessionId !== null ? [askDialog.sessionId] : [];
    bridgeWatch.at = Date.now();
    bridgeThread.sync(watchedSessions());
  }

  /**
   * 回答一条待决授权 —— 桥的路由与对话框的路由共用同一套校验(见 lib/bridge-approval.mjs 的安全约束)。
   * @returns {{status: number, body: object}}
   */
  function answerApproval(id, outcome) {
    if (typeof id !== 'string' || id === '') return { status: 400, body: { ok: false, error: '需要 id 字段' } };
    if (!PANEL_OUTCOMES.includes(outcome)) {
      return { status: 400, body: { ok: false, error: `outcome 只能取 ${PANEL_OUTCOMES.join(' | ')}` } };
    }
    if (bridgeApprovalBoard.get(id) === null) return { status: 409, body: { ok: false, error: '未知或已处理的授权请求' } };
    const ok = bridgeApprovalBoard.answer(id, outcome);
    return { status: ok ? 200 : 409, body: { ok, outcome: ok ? outcome : null } };
  }


  /** 本部署的 DSH 版本(诊断用;面板要的是下面那个"界面版本")。 */
  function dshVersion() {
    try {
      const entry = dshEntry();
      if (entry === undefined || entry === null) return null;
      const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(entry), 'package.json'), 'utf8'));
      return typeof manifest.version === 'string' ? manifest.version : null;
    } catch {
      return null;
    }
  }

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
    // **POSIX 上 socket 文件必须落在已存在的目录里**(Windows 命名管道由内核管理,不需要目录 ——
    // 所以这个洞只在 Linux/macOS 上暴露)。之前没人建 <DSH_HOME>/code-server:它通常是别的东西
    // (pid.json / endpoint.json)顺手建的,桥起得比它们早就没有目录 ⇒ listen() 失败 ⇒ 桥静默不可用。
    // 2026-09-16 ubuntu runner 实测:报告 EACCES(端点目录不可写/不存在),而 windows 那条腿全绿。
    if (process.platform !== 'win32') {
      try {
        fs.mkdirSync(path.dirname(socketPath), { recursive: true });
      } catch (error) {
        console.warn(`[code-server] 编辑器桥:建不了端点目录 ${path.dirname(socketPath)}`
          + `(${error && error.code ? error.code : error})`);
      }
    }
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
          + `(端点 ${socketPath};目录存在=${fs.existsSync(path.dirname(socketPath))}`
          + ')(文件打开走信号文件,不受影响)');
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

  /** 桥的路由(后缀 → Fetch 风格 handler)。做成函数而非常量:handler 声明在文件后段,
   *  函数声明会提升,而常量在挂载时可能还在 TDZ。
   *
   *  **四条只读路由 + 一条有界的模型调用**(0.3.61 起):/health 探活、/sync 上报状态+取事件、
   *  /old 取写前原文、/event 上报意图;/complete 是**唯一的例外** —— 它把光标前后的两段文本
   *  交给模型换回一段补全文本(实验性 FIM,设置里默认关;安全不变量见 handleBridgeComplete)。
   *  (请宿主打开对话框等)。提问与授权**不在这里** —— 它们走 DSH 同源的
   *  `/api/code-server/ask/{send,approve}`,调用方是 DSH 页面里的插件客户端(client 半部),
   *  吃 DSH 自己的 cookie/Origin 校验。 */
  function bridgeRouteTable() {
    return [
      { suffix: '/health', methods: ['GET'], fetch: handleBridgeHealth },
      { suffix: '/sync', methods: ['POST'], fetch: handleBridgeSync },
      { suffix: '/old', methods: ['GET'], fetch: handleBridgeOld },
      { suffix: '/event', methods: ['POST'], fetch: handleBridgeEvent },
      { suffix: '/complete', methods: ['POST'], fetch: handleBridgeComplete },
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

  // 仅测试用:把分发器交给模块级钩子(见 bridgeRequestForTests)。沙箱里**连接**命名管道 EPERM
  // ⇒ 走 IPC 的用例会全体 SKIP,"本地全绿"里就没有桥的状态码断言了(0.3.63 的 /complete 403
  // 就是这么假绿到 runner 才红的)。有了它,断言在任何机器上都能真跑。
  activeBridgeDispatch = dispatchBridge;

  /** 桥是否启用(行配置为种子,设置文档里可实时改)。 */
  function bridgeEnabled() {
    return bridgeSetting !== false;
  }

  /** 提示词段落在插件激活时注册一次:文本按"桥是否存活"渲染(桥停时为空串 → DSH 丢弃该段),
   *  所以在 IDE 从未启动的部署里它也只是一段空注册,不产生任何提示词开销。 */
  setPromptLiveProbe(() => bridgeMeta !== null);
  bridgePromptDispose = registerEditorPrompt(ctx);
  // FIM(实验性)的适配器注册**不在这里**:它的状态声明(fimStats/fimAdapterDispose…)在文件后段,
  // 这里调用会撞 `Cannot access 'fimAdapterDispose' before initialization`(TDZ)——
  // async 函数声明会提升,但它读的 `let` 还没初始化,异常会直接把整个插件加载打挂
  // (与 0.3.6 的 `ctx.systemPrompt` 事故同一类)。真正的调用点在 FIM 运行时声明之后。
  if (bridgePromptDispose === null && bridgeEnabled()) {
    console.warn('[code-server] 编辑器桥:systemPrompt 服务不可用,提示词段落未注册(工具仍可用)');
  }

  // 观察 agent 的写操作(→ 编辑器 diff 提示)并在写脏文件前附一条提醒。
  // 与 IDE 是否在跑无关:桥没起来时 isLive() 为 false,dirty 检查直接跳过。
  bridgeObserveDispose = registerBridgeObserver(ctx, {
    emit: (kind, fields) => bridgeEvents.push(kind, fields),
    context: () => bridgeContext.get(),
    isLive: () => bridgeMeta !== null && !bridgeContext.isStale(),
    snapshots: bridgeSnapshots,
  });

  // 会话流与授权拦截都是**按会话**建立的(在 /ask 成功时 watch + intercept),
  // 这里只登记卸载钩子:对话框关掉 / IDE 停掉时把订阅与 pending 授权一起收干净。
  bridgeAnswerDispose = () => {
    bridgeThread.dispose();
    bridgeApproval.dispose();
    bridgeApprovalBoard.clear();
    bridgeWatch.dialogIds = [];
    bridgeWatch.at = 0;
  };

  /** 桥配置要写的目录(可能有**两个**):
   *
   *  ① `<extensionsDir>/.dshcs-bridge/` —— 权威位置;host 侧 /status 与诊断都指向它,
   *     扩展在有 `DSHCS_EXTENSIONS_DIR` 时也读它;
   *  ② `<树>/lib/vscode/extensions/.dshcs-bridge/` —— **内置扩展自己会去找的位置**。
   *     为什么需要 ②:`bridge-client` 的兜底是"从自身位置反推"(`<ext>/lib/` 上溯两级),
   *     对内置扩展就是 `<树>/lib/vscode/extensions`。而环境变量只在 host **spawn** IDE 时才注入 ——
   *     **adopt(接管正在运行的 IDE)拿不到**:那个进程是上一次启动的,env 早已定死。
   *     没有 ② 的话,被接管的 IDE 即使重载窗口也读不到配置,桥只能等 IDE 重启。
   *  两份内容完全一致(同一个 write/remove 一起写),不存在优先级问题。 */
  function bridgeConfigDirs() {
    const dirs = [bridgeExtensionsDir];
    try {
      const target = extensionTarget(bridgeExtensionsDir, 'dshcs-editor-bridge', 'builtin');
      if (target.builtin) {
        const sibling = path.join(path.dirname(target.dst), BRIDGE_DIRNAME);
        if (!dirs.includes(sibling)) dirs.push(sibling);
      }
    } catch {
      // 树不可用 → 只有权威位置
    }
    return dirs;
  }

  /** 同步桥运行时:写入/更新 bridge.json(端点 = 本机 IPC 路径 + 令牌 + pid)。
   *  端点、令牌、pid 三者任一变化都重写 —— 扩展每 5s 重读,故不需要任何推送。
   *  监听口起不来时**不写配置**(宁可休眠,不可指向死端点),并说明一次。 */
  function syncBridgeRuntime({ pid, startedAt }) {
    if (!bridgeEnabled()) return;
    const handle = bridgeListener;
    if (handle === null) {
      if (bridgeMeta !== null) {
        bridgeMeta = null;
        for (const dir of bridgeConfigDirs()) {
          try { removeBridgeConfig(dir); } catch { /* 删不掉也不影响:扩展会因端点在而连不上 */ }
        }
      }
      return;
    }
    bridgeToken ??= mintBridgeToken();
    const changed = bridgeMeta === null || bridgeMeta.pipe !== handle.path || bridgeMeta.token !== bridgeToken || bridgeMeta.pid !== pid;
    bridgeMeta = { pipe: handle.path, token: bridgeToken, pid, startedAt: startedAt ?? null };
    const value = { pipe: handle.path, token: bridgeToken, pid, startedAt: startedAt ?? null };
    for (const dir of bridgeConfigDirs()) {
      try {
        writeBridgeConfig(dir, value);
      } catch (err) {
        console.warn(`[code-server] 编辑器桥配置写入失败(${dir}):${err && err.message ? err.message : err}`);
      }
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
    bridgeSnapshots.clear();
    if (bridgeMeta === null) return;
    bridgeMeta = null;
    for (const dir of bridgeConfigDirs()) {
      try {
        removeBridgeConfig(dir);
      } catch {
        // 配置删不掉不影响正确性(扩展会因 IDE 不可达而休眠)
      }
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
   *  为什么够用:工作区目录由客户端 URL 的 `&folder=<绝对路径>` 决定(见 lib/client.js 的
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
          const newest = newestBundledExtensionMtime(extensionsDir);
          const staleCode = synced.updated.length > 0
            || (newest !== null && record.startedAt !== null && newest > record.startedAt);
          if (staleCode) {
            console.warn('[code-server] 内置扩展文件比当前 IDE 进程新'
              + `${synced.updated.length > 0 ? `(本次更新:${synced.updated.join(',')})` : ''}:`
              + '被接管的 IDE 不会重新加载扩展,里面跑的**可能仍是旧代码**。'
              + '若编辑器桥没有状态(editor_context 报"编辑器还没有上报状态"),'
              + '请在 Code Server 标签里重载一次窗口(或重启 IDE)让扩展宿主读到新代码');
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
    // 0.3.45 起不再需要给子进程加 NODE_PATH:重打包原生包按**真名**挂在插件依赖上,而它们要的
    // **原始名字**(node-pty / @vscode/sqlite3 …)由 ensureRuntimeLayout() 在树里补 junction ——
    // 目录链同时满足 ESM import 与 CJS require,NODE_PATH 只对 CJS 生效且属兜底。

    let proc;
    try {
      // 启动前再自愈一次依赖布局(插件重装/树被替换后可能丢失;幂等且只做存在性检查)
      ensureRuntimeLayout();
      const isCmd = launch.kind === 'bin' && win32() && /\.cmd$/i.test(launch.command);
      // 解释器:显式 bin 用它的;其余(node 脚本 / 自带 launcher)默认 process.execPath —— 但**宿主是
      // Electron(Node 模式)时必须换成真 Node**(0.3.53):VS Code 的 server-main 会注册一段只在
      // Electron/ELECTRON_RUN_AS_NODE 下生效的 asar 解析钩子,它拒绝一切落在"应用根"之外的包,而
      // 本插件的原生包都在树外的 pnpm 目录里 ⇒ 桌面版必然 `Cannot find package '@vscode/spdlog' …`
      // ⇒ 面板显示「code-server 意外退出(exit 2)」。详见 lib/child-node.mjs。
      const childNode = launch.kind === 'bin' ? null : resolveChildNode();
      const command = launch.kind === 'bin' ? launch.command : childNode.command;
      const spawnArgs = launch.kind === 'bin' ? args : [launch.script, ...args];
      if (childNode !== null && childNode.electronHost) {
        if (childNode.swapped) {
          console.log(`[code-server] 宿主是 Electron(Node 模式):改用真 Node 跑 IDE 子进程`
            + `(${childNode.source}: ${childNode.command});已从子进程环境剥离 ELECTRON_RUN_AS_NODE`);
        } else {
          console.warn('[code-server] 宿主是 Electron(Node 模式),但没找到可用的真 Node —— VS Code 的 asar 解析钩子'
            + '会拒绝树外的原生包(@vscode/spdlog / @vscode/deviceid / @vscode/windows-registry 等),'
            + 'IDE 很可能以 exit 2 退出。修法:让应用自带的 resources/runtime/primary-runtime/dependencies/node/bin/'
            + '或 PATH 上有一个真的 node。');
        }
      }
      // shell 仅对 .cmd shim(Windows npm 全局包)必要:它必须经 cmd.exe 解析。
      // 含空格路径由 spawn 数组传参,不再经 shell 拼接,避免 'C:\Program' 拆分。
      proc = spawn(isCmd ? `"${command}"` : command, spawnArgs, {
        cwd: cwd ?? process.cwd(),
        env: childNode === null ? env : childNodeEnv(childNode, env),
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
      parts.push(`预编译原生模块未安装(${env.nativeRuntime.name})`);
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

  // ---------------------------------------------------------------- FIM(幽灵)补全(实验性,0.3.61)

  /** 用量与调用计数:这是**唯一**的可见处(状态栏 + 设置卡)。一次性插件调用不是 loop 请求、
   *  不写会话日志 ⇒ DSH 的 token-meter 看不到它(见 lib/fim-adapter.mjs 顶部"计量会落在哪")。 */
  const fimStats = createFimStats();
  /** 速率/并发闸:这条链路由击键触发,任何一处无界都会变成"打字时把宿主/账号打满"。 */
  const fimBudget = createFimBudget();
  /** 已注册的适配器句柄(null = 未注册)。 */
  let fimAdapterDispose = null;
  /** 消息构造器(从 DSH 解析;拿不到就不启用 —— 手搓 message 对象容易缺字段,不值得赌)。 */
  let fimCreateUserMessage = null;
  /** 不可用的原因(状态栏与设置卡要能说清"为什么没反应")。 */
  let fimUnavailable = '未启用';

  /**
   * 按设置注册/注销适配器路由。
   *
   * 为什么是**适配器**而不是直连 fetch:这样这条调用仍然走 DSH 的 LLM 服务 —— 取消、超时、
   * 终态 chunk、稳定错误码都按服务契约走(见 lib/fim-adapter.mjs 顶部)。解析不到 llm 服务或
   * LlmAdapter 时**不报错、只是不可用**:FIM 是可选能力,不该让插件在缺服务的部署里出问题。
   */
  async function ensureFimAdapter() {
    if (fimAdapterDispose !== null) {
      try { fimAdapterDispose(); } catch { /* 已被 fiber 回收 */ }
      fimAdapterDispose = null;
    }
    if (!fimSetting) {
      fimUnavailable = '设置里未开启';
      return false;
    }
    const llm = (() => { try { return ctx.get('llm'); } catch { return undefined; } })();
    if (llm === undefined || llm === null || typeof llm.registerAdapter !== 'function') {
      fimUnavailable = '这个 DSH 没有 llm 服务';
      console.warn('[code-server] FIM 补全:ctx.llm 不可用,补全保持关闭');
      return false;
    }
    const base = await loadFimBase();
    if (base === null || base.createUserMessage === null) {
      fimUnavailable = '解析不到 @deepseek-ai/dsh-llm 的 LlmAdapter/createUserMessage';
      console.warn(`[code-server] FIM 补全:${fimUnavailable};补全保持关闭`);
      return false;
    }
    try {
      const Adapter = createFimAdapterClass(base.Base, {
        resolveApiKey: createApiKeyResolver(ctx),
        attributionHeaders: base.attributionHeaders,
        assertUsableApiKey: base.assertUsableApiKey,
        log: (message) => console.log(`[code-server] FIM:${message}`),
      });
      const handle = llm.registerAdapter([FIM_PROVIDER], new Adapter());
      fimAdapterDispose = typeof handle === 'function' ? handle : () => {};
      fimCreateUserMessage = base.createUserMessage;
      fimUnavailable = null;
      console.log(`[code-server] FIM 补全(实验性)已注册适配器路由:${FIM_PROVIDER}/${FIM_MODEL}`);
      return true;
    } catch (error) {
      fimUnavailable = error && error.message ? error.message : String(error);
      console.warn(`[code-server] FIM 补全:注册适配器失败(${fimUnavailable})`);
      return false;
    }
  }

  /** 给客户端(/sync)看的快照:开关状态 + 可用性 + 用量。 */
  function fimSnapshot() {
    const stats = fimStats.snapshot();
    const budget = fimBudget.snapshot();
    return {
      enabled: fimSetting,
      available: fimSetting && fimAdapterDispose !== null,
      reason: fimUnavailable,
      provider: FIM_PROVIDER,
      model: FIM_MODEL,
      inflight: budget.inflight,
      callsLastMinute: budget.callsLastMinute,
      // 三个子项(0.3.62):扩展侧靠这些值决定"等多久、要不要接受多行、这个文件要不要跳过"。
      debounceMs: fimDebounceMs,
      multiline: fimMultiline,
      disableGlobs: compileGlobList(fimDisableGlobs),
      ...stats,
    };
  }

  /**
   * `POST /complete` —— 桥的**第五条路由**,也是唯一一条**会发起模型调用**的路由。
   *
   * 安全不变量(比前四条多三条,别放宽):
   *   (a) **只有设置里开了 FIM 才存在** —— 没开一律 403,且不会发出任何网络请求;
   *   (b) **不写文件、不执行命令** —— 输入是两个字符串,输出是一段文本 + 用量;
   *   (c) **有界** —— body 上限、前后缀窗口(适配器侧再裁一遍)、速率/并发闸、单次 4s 超时。
   * 即:桥令牌泄露时,攻击面是"替用户花一点补全的 token 并读到一段补全文本",
   * 而不是任意文件写 / 任意命令执行 —— 与前四条保持同一量级。
   */
  async function handleBridgeComplete(request) {
    const denied = bridgeRejection(request);
    if (denied !== null) return denied;
    if (!fimSetting) return jsonResponse({ ok: false, error: 'fim-disabled' }, 403);
    if (fimAdapterDispose === null || fimCreateUserMessage === null) {
      return jsonResponse({ ok: false, error: 'fim-unavailable', reason: fimUnavailable }, 503);
    }
    let body;
    try {
      body = await readJsonBody(request);
    } catch {
      return jsonResponse({ ok: false, error: '请求体不是合法 JSON' }, 400);
    }
    if (!bodyWithinLimit(body)) return jsonResponse({ ok: false, error: '请求体过大' }, 413);
    const prompt = typeof body.prompt === 'string' ? body.prompt : null;
    const suffix = typeof body.suffix === 'string' ? body.suffix : null;
    if (prompt === null || suffix === null) return jsonResponse({ ok: false, error: '缺少 prompt/suffix' }, 400);
    // 按 glob 禁用(0.3.62):扩展侧先判过一遍,这里是**服务端那道**——令牌泄露也只能换来"被拒",
    // 不会替用户在已禁用的大文件/无关目录上烧 token。
    const blocked = matchDisabledGlob(typeof body.path === 'string' ? body.path : '', compileGlobList(fimDisableGlobs));
    if (blocked !== null) return jsonResponse({ ok: false, error: 'disabled-by-glob', glob: blocked }, 403);
    const gate = fimBudget.acquire();
    if (gate !== 'ok') return jsonResponse({ ok: false, error: gate }, gate === 'busy' ? 409 : 429);
    const started = Date.now();
    try {
      const llm = ctx.get('llm');
      const message = fimCreateUserMessage({
        content: [{ type: 'text', text: encodeFimRequest({ prompt, suffix, language: body.language, path: body.path }) }],
      });
      let text = '';
      let usage = null;
      let failure = null;
      for await (const chunk of llm.stream({
        provider: FIM_PROVIDER,
        model: FIM_MODEL,
        messages: [message],
        maxTokens: FIM_MAX_TOKENS,
        temperature: 0,
      })) {
        if (chunk === null || typeof chunk !== 'object') continue;
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
        else if (chunk.type === 'usage') usage = chunk.usage ?? usage;
        else if (chunk.type === 'finish') {
          const kind = chunk.reason?.kind;
          if (kind !== 'stop' && kind !== 'max-tokens') {
            failure = chunk.reason?.failure ?? { code: String(kind ?? 'error'), message: '补全未正常结束' };
          }
        }
      }
      const ms = Date.now() - started;
      if (failure !== null) {
        fimStats.recordFailure(failure.code, ms);
        return jsonResponse({ ok: false, error: failure.code, reason: failure.message, ms }, 502);
      }
      // "允许多行"关掉时**在返回前裁**(0.3.62):扩展侧拿到的就是最终形态,缓存里也不会存多行;
      // 首行是空白 ⇒ 返回空串,扩展据此当作"这次不补"(与"模型没给出东西"同一处理)。
      const finalText = fimMultiline ? text : toSingleLine(text);
      fimStats.recordOk(usage, ms);
      return jsonResponse({ ok: true, text: finalText, usage, ms });
    } catch (error) {
      const ms = Date.now() - started;
      const message = error && error.message ? error.message : String(error);
      fimStats.recordFailure(error && error.code ? error.code : 'ERROR', ms);
      console.warn(`[code-server] FIM 补全失败:${message}`);
      return jsonResponse({ ok: false, error: error && error.code ? error.code : 'ERROR', reason: message, ms }, 502);
    } finally {
      fimBudget.release();
    }
  }

  // FIM 运行时的声明都已执行到这里 ⇒ 现在才能安全调用(见前面那段 TDZ 说明)。
  // **不阻塞启动**(void):它是可选能力,解析不到就只是"补全不可用",不该拖慢插件激活。
  void ensureFimAdapter();

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

  /**
   * 取一份"写前原文"快照(0.3.55)。
   *
   * 为什么单独一条路由:事件里塞不下全文 —— `/sync` 的响应还驮着对话流与待决授权,
   * 0.3.27 就是因为每趟塞 ~1MB 被拖成超时,而超时会把 approvals 一起丢掉(授权卡片再也不出现)。
   * 所以事件只带不透明 key,文本按需取。
   *
   * 只读且**不消费**:扩展可能重复轮询同一条事件,取两次必须拿到同一份。
   * key 是随机串,不是路径 —— 即使令牌泄露也只能读到这份有界缓存里的内容,取不到任意文件。
   */
  async function handleBridgeOld(request) {
    const denied = bridgeRejection(request);
    if (denied !== null) return denied;
    let key = null;
    try {
      key = new URL(request.url).searchParams.get('key');
    } catch {
      key = null;
    }
    const { status, body } = snapshotResponse(bridgeSnapshots, key);
    return jsonResponse(body, status);
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
    // 取完就清空(事件是提示,取过不必留着 —— 否则客户端重新对齐时会把陈旧提示重放成一片 diff 窗口)。
    // **注意 `reset()` 不再回退 seq**(0.3.56 修):以前它把 seq 归零,而这里每趟都调 ⇒ 扩展的游标
    // (单调递增)从此永远大于新 seq,`seq > since` 全被过滤 ⇒ 每个 IDE 会话只送达第一条事件。
    bridgeEvents.reset();
    // 把当前最大 seq 一并回去:客户端据此自查"我的游标是不是跑到宿主前面去了"(跨版本升级、
    // 接管了别的宿主留下的游标文件等),发现后退回 since=0 重新对齐,免得永久失聪。
    const lastSeq = bridgeEvents.lastSeq();
    bridgeWatch.at = Date.now();
    // 看护状态变化就写一行;并且**首帧必写**(0.3.31:只记"翻转"会让"一直没人看"这种情况在日志里
    // 完全空白,事后无从判断 —— 上一轮就是这样被拖了一整轮)。
    const watchingNow = hasWatcher();
    if (watchingNow !== bridgeWatchLogged || bridgeWatchWroteFirst !== true) {
      bridgeWatchLogged = watchingNow;
      bridgeWatchWroteFirst = true;
      bridgeDiag('hasWatcher → ' + watchingNow
        + ' (对话框=[' + bridgeWatch.dialogIds.join(',') + '])');
    }
    // 请求过对话框、客户端半部却从没来问过 → 说清楚原因(多半是浏览器还缓存着旧的客户端 bundle)。
    if (askDialog.open && !askDialogLive() && askDialog.warned !== true) {
      askDialog.warned = true;
      console.warn('[code-server] 请求了「问 DSH」对话框,但客户端半部没有轮询 /ask/state:'
        + '浏览器可能还在用旧的客户端 bundle(硬刷新 / 清 Code Cache)。');
    }
    // **对话流不再经这里**(0.3.59):那是编辑器 webview 面板时代的分工 —— 面板退役后这条
    // 每 600ms 一趟的通道上驮着 ≤1MB 的快照(0.3.27 还专门为它做过"没变化就不重传"的省流量),
    // 现在全归 `/api/code-server/ask/state`:对话框每 900ms 只问修订号,没变化只回一个数字。
    return jsonResponse({
      ok: true,
      events,
      // 事件序号的高水位:扩展用它自查游标是否超前(超前 ⇒ 退回 since=0 重新对齐,避免永久失聪)。
      lastSeq,
      // 能力探测(0.3.24;0.3.25 起以"客户端半部真的在轮询 /ask/state"为准):
      // 只有对话框活着的时候才让扩展走 ask-open;0.3.59 起不满足时扩展给一条提示(不再退编辑器面板)。
      askDialog: askDialogLive(),
      // 诊断用:请求过对话框但客户端没响应(浏览器缓存旧 bundle?)。
      askDialogRequested: askDialog.open,
      // FIM(实验性)状态与用量:扩展据此决定要不要注册内联补全 provider,并把用量显示在状态栏。
      // **必须每趟都带**(它是唯一能让用户看到"补全花了多少"的地方 —— 这条调用不进 DSH 的计量)。
      fim: fimSnapshot(),
    });
  }

  // ---------------------------------------------------------------- 「问 DSH」对话框(client 半部)

  /** 对话框每 900ms 问一次:给修订号,没变就只回一个数字(不重传几十 KB 的对话流)。 */
  async function handleAskState(request) {
    // 这一条就是"客户端半部活着"的证据(能力位 askDialog 以它为准,见 askDialogLive)。
    askDialog.polls += 1;
    // 有轮询 = 对话框活着 ⇒ 武装(关掉时 /ask/close 会立刻解除)。
    askDialog.armed = true;
    askDialog.lastPollAt = Date.now();
    // 心跳证据(0.3.35):首次 + 每 40 次写一行,证明"对话框在持续发活跃通知"。
    if (askDialog.polls % 40 === 1) {
      bridgeDiag('dialog heartbeat #' + askDialog.polls + ' (open=' + askDialog.open + ' session=' + String(askDialog.sessionId) + ')');
    }
    if (askDialog.polls === 1) {
      console.log('[code-server] 「问 DSH」对话框已连上客户端半部:/ask/state 开始轮询');
    }
    refreshDialogWatch();
    const current = askRevision();
    let rev = null;
    try {
      const raw = new URL(request.url).searchParams.get('rev');
      const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
      if (Number.isSafeInteger(parsed) && parsed >= 0) rev = parsed;
    } catch {
      rev = null;
    }
    if (rev !== null && rev === current) return jsonResponse({ ok: true, changed: false, rev: current });
    return jsonResponse({ ...askState(), changed: true, rev: current });
  }

  /** 对话框发一条提问:上下文取宿主缓存里的编辑器状态(扩展每 600ms 上报)。 */
  async function handleAskSend(request) {
    let body;
    try {
      body = await readJsonBody(request);
    } catch {
      return jsonResponse({ ok: false, error: '请求体不是合法 JSON' }, 400);
    }
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (text === '') return jsonResponse({ ok: false, error: '需要 text 字段(要问 DSH 的话)' }, 400);
    const mode = body.mode === 'file' ? 'file' : askDialog.mode;
    const context = askContextFromCache(mode);
    // 投递方式(0.3.59):默认跟着 DSH 自己的设置 `ui-conversation.busyEnter` 走(见
    // lib/bridge-session.mjs 的 pickBusyEnter)—— 面板按 Enter 与主界面按 Enter 是同一个手势,
    // 行为必须一致。显式传 `delivery: 'queue'|'steer'` 可覆盖(测试用,或将来在面板上做"插队"按钮)。
    const result = await deliverEditorPrompt(ctx, {
      text,
      file: context === null ? null : context.file,
      lineStart: context === null ? null : context.lineStart,
      lineEnd: context === null ? null : context.lineEnd,
      selection: context === null ? null : context.selection,
      languageId: context === null ? null : context.languageId,
    }, { delivery: typeof body.delivery === 'string' ? body.delivery : undefined });
    if (result.ok === true && typeof result.sessionId === 'string' && result.sessionId !== '') {
      askDialog.sessionId = result.sessionId;
      askDialog.mode = mode;
      refreshDialogWatch();
      bridgeThread.watch(result.sessionId);
      bridgeApproval.intercept(result.agent, result.sessionId);
    }
    const { agent: _agent, ...payload } = result;
    void _agent;
    return jsonResponse(payload, result.ok === true ? 200 : (result.code === 'NO_AGENT' ? 409 : 200));
  }

  /** 对话框回答授权(与宿主内部 answerApproval 同一套校验:白名单 outcome + 只认仍未决的 id)。 */
  async function handleAskApprove(request) {
    let body;
    try {
      body = await readJsonBody(request);
    } catch {
      return jsonResponse({ ok: false, error: '请求体不是合法 JSON' }, 400);
    }
    const verdict = answerApproval(
      typeof body.id === 'string' ? body.id : '',
      typeof body.outcome === 'string' ? body.outcome : '',
    );
    return jsonResponse(verdict.body, verdict.status);
  }

  /** 对话框关掉:不再看会话 ⇒ 待决授权按"没人看"交回官方链路(拦截器的轮询会立刻放行)。 */
  async function handleAskClose() {
    askDialog.open = false;
    // **关闭即解除武装**(0.3.40):否则 10 分钟 TTL 内我们还会继续拦截,而卡片已经没地方显示。
    askDialog.armed = false;
    askDialog.lastPollAt = 0;
    askDialog.sessionId = null;
    refreshDialogWatch();
    return jsonResponse({ ok: true });
  }

  async function handleBridgeEvent(request) {
    const denied = bridgeRejection(request);
    if (denied !== null) return denied;
    const body = await readJsonBody(request);
    const kind = typeof body.kind === 'string' ? body.kind : '';
    if (kind === '') return jsonResponse({ ok: false, error: '需要 kind 字段' }, 400);
    // 右键「问 DSH」→ 扩展上报 ask-open:host 打开 DSH 页面里的对话框(client 半部轮询到就拿去显示)。
    if (kind === 'ask-open') {
      askDialog.open = true;
      askDialog.mode = body.mode === 'file' ? 'file' : 'selection';
      askDialog.at = Date.now();
      refreshDialogWatch();
      appendLog(`[bridge] ask-open mode=${askDialog.mode}\n`);
      return jsonResponse({ ok: true, mode: askDialog.mode, contextText: askContextLine(askDialog.mode) });
    }
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
    // ---- 「问 DSH」对话框(0.3.24):DSH 页面里的 client 半部调这几条 ----
    // 这里**在 /api 下**是对的:调用方是 DSH 页面自己(同源 + cookie),与扩展宿主(必须走本机 IPC)不同。
    { path: `${API_BASE}/ask/state`, methods: ['GET'], fetch: handleAskState },
    { path: `${API_BASE}/ask/send`, methods: ['POST'], fetch: handleAskSend },
    { path: `${API_BASE}/ask/approve`, methods: ['POST'], fetch: handleAskApprove },
    { path: `${API_BASE}/ask/close`, methods: ['POST'], fetch: handleAskClose },
    // 0.3.59 删掉了 `/ask/bundle`(面板产物不再存在:面板本体在 lib/client.js 里,渲染器走页面模块表)。
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
      bridgeAnswerDispose = disposeSafely(bridgeAnswerDispose);
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

/**
 * 仅测试用:把一次桥请求交给**当前实例**的桥分发器,不经过命名管道 / unix socket。
 *
 * 为什么需要这条钩子(2026-09-22,0.3.63 CI 红 #2 的根治):本机沙箱里**连接**命名管道会 EPERM
 * (监听允许、连接不允许),于是 scripts/test-bridge-routes.mjs 里所有走 IPC 的用例在本机一律
 * SKIP —— "本地 pass=30" 里**不含**桥的状态码断言,`/complete` 的 403 就是这么在本地假绿、
 * 推到 runner 才红的。传输可以是本机的,断言不能是本机的:有了它,那些断言在任何机器上都真跑。
 *
 * 与真实传输**同构**(逐字段对照 nodeRouteFromFetch):同一个 dispatchBridge、body 同样收成
 * Buffer、Response 同样摊平成 {status, headers, text}。缺的只有 socket 本身 —— 所以它**不能**
 * 替代"监听口能起来"这条验证,那一条仍由真实运行的 IPC 覆盖(test-bridge-routes 里那条
 * 「桥走本机 IPC」的用例走的还是真端点)。
 */
export async function bridgeRequestForTests({ path, method = 'GET', headers = {}, body = '' } = {}) {
  if (activeBridgeDispatch === null) throw new Error('bridgeRequestForTests: 还没有 apply() 过,拿不到桥分发器');
  const response = await activeBridgeDispatch(
    new URL(path, 'http://127.0.0.1'),
    String(method).toUpperCase(),
    // 与 Node 的 IncomingMessage.headers 同形(键全小写):guard 读 origin 与令牌头就靠它。
    Object.fromEntries(Object.entries(headers).map(([k, v]) => [String(k).toLowerCase(), v])),
    Buffer.from(body ?? '', 'utf8'),
  );
  const flat = {};
  response.headers.forEach((value, key) => { flat[key] = value; });
  return { status: response.status, headers: flat, text: await response.text() };
}
