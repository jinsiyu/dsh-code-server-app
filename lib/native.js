// lib/native.js — 预编译原生模块(重打包子包)的定位、校验与目录链还原。
//
// 模型(0.3.45 起,取代 0.1.36 的「平台聚合包 + npm: 别名」):
//   VS Code 内部依赖里那批「pnpm 拒绝安装」的原生包(node-pty / @vscode/sqlite3 / kerberos /
//   koffi / ssh2 / cpu-features / @parcel/watcher / @vscode/windows-* …)在打包期由
//   scripts/vendor-repacks.mjs 重打包成 @<scope>/dshcs-<名字>[-<平台>-<架构>],并**直接挂在插件
//   依赖上**:
//     · 平台无关的重打包包 → 插件 `dependencies`(真名,如 @<scope>/dshcs-node-pty);
//     · 平台专属的重打包包 → 插件 `optionalDependencies`(真名 + 包自带 os/cpu,每平台一份,
//       包管理器按架构自动选中,不匹配的在 lockfile 里是 optional ⇒ 缺失是允许的)。
//
//   为什么不沿用聚合包:聚合包把 16 个包挂在**可选子树**里,靠 `npm:` 别名还原原始名字;
//   而 dsh-desktop 的依赖图校验器在 `pnpm add` 之后立刻校验,偏偏 pnpm 的增量 hoisted 安装会
//   漏链这类「可选子树里的别名包」(实测 16 个漏 9 个,报 requires missing @microsoft/mxc-sdk)。
//   直接依赖(真名)在同一套设置下 100% 装上 ⇒ 改用直接依赖 + 运行时补 junction。
//   实测证据与复现命令见 docs/desktop-first-install-root-cause.md。
//
//   「原名 → 真包」的表由打包期写进 lib/vendored.json(随包发布),本模块运行时只读它。
//
// 本模块只做四件事:
//   1. 读 lib/vendored.json → 本平台期望可解析的「原名 → 真包」表;
//   2. 从 code-server 运行位置出发校验这些原名是否真的能 require/import 到;
//   3. 解析不到的在树里补 junction(ESM 不认 NODE_PATH,只认目录链);
//   4. 给环境检测卡片一份状态汇总。
import { createRequire } from 'node:module';
import { existsSync, readFileSync, mkdirSync, symlinkSync, lstatSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PACKAGE_ROOT, codeServerRoot } from './vendor.js';

const require_ = createRequire(import.meta.url);
/** 打包期由 scripts/vendor-repacks.mjs 写出的重打包表。 */
const VENDORED_FILE = join(PACKAGE_ROOT, 'lib', 'vendored.json');

/** 平台目录名,如 win32-arm64。 */
export function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

/** 某个条目是否适用于给定平台。
 *  平台无关的模块哪儿都适用;平台专属的看它的每模块 `targets` 白名单
 *  ——例如 `@vscode/windows-registry` 只在 win32-* 里有子包,在 Linux 上压根不该去找
 *  `@jinsiyu/dshcs-vscode-windows-registry-linux-x64`(那名字永远不会存在)。
 *  `targets` 缺席 = 全部目标(兼容 0.3.47 及更早写出的旧表)。 */
export function vendoredAppliesTo(entry, platform = process.platform, arch = process.arch) {
  if (entry.platform !== true) return true;
  const targets = Array.isArray(entry.targets) ? entry.targets : null;
  return targets === null || targets.includes(platformKey(platform, arch));
}

/** 读重打包表。
 *  @returns {{scope:string, targets:string[], modules:{alias:string,package:string,version?:string,platform?:boolean}[]}} */
export function readVendoredTable() {
  try {
    const doc = JSON.parse(readFileSync(VENDORED_FILE, 'utf8'));
    const modules = Array.isArray(doc?.modules)
      ? doc.modules.filter((m) => m !== null && typeof m === 'object'
        && typeof m.alias === 'string' && m.alias !== ''
        && typeof m.package === 'string' && m.package !== '')
      : [];
    return {
      scope: typeof doc?.scope === 'string' && doc.scope !== '' ? doc.scope : '@jinsiyu',
      targets: Array.isArray(doc?.targets) ? doc.targets.filter((t) => typeof t === 'string') : [],
      modules,
    };
  } catch {
    return { scope: '@jinsiyu', targets: [], modules: [] };
  }
}

/** 某个条目在指定平台的**真包名**(平台专属的按 `-<平台>-<架构>` 拼后缀)。 */
export function vendoredPackageName(entry, platform = process.platform, arch = process.arch) {
  return entry.platform === true ? `${entry.package}-${platformKey(platform, arch)}` : entry.package;
}

/** 本平台期望装在依赖图里的重打包子包(原名 + 真名),按原名排序。
 *  **不含**只属于其它平台的模块(见 vendoredAppliesTo):它们的子包永远不会存在,
 *  报成「缺包」只会误导环境检测卡片。
 *  @returns {{alias:string, packageName:string, version:string|null, platform:boolean}[]} */
export function vendoredEntries(platform = process.platform, arch = process.arch) {
  return readVendoredTable().modules
    .filter((m) => vendoredAppliesTo(m, platform, arch))
    .map((m) => ({
      alias: m.alias,
      packageName: vendoredPackageName(m, platform, arch),
      version: typeof m.version === 'string' ? m.version : null,
      platform: m.platform === true,
    }))
    .sort((a, b) => a.alias.localeCompare(b.alias));
}

/** 本平台不适用的重打包模块(别名),给环境检测卡片用一句话解释「为什么这些不在清单里」。 */
export function vendoredNotApplicable(platform = process.platform, arch = process.arch) {
  return readVendoredTable().modules
    .filter((m) => !vendoredAppliesTo(m, platform, arch))
    .map((m) => m.alias)
    .sort((a, b) => a.localeCompare(b));
}

/** 解析原生模块时的锚点目录:
 *   ① code-server 运行根(树自带 node_modules);
 *   ② 插件包根 —— 重打包子包挂在插件依赖上(profile 根或插件自己的 node_modules),
 *      从插件清单出发的解析链才看得到它们。 */
export function nativeSearchRoots() {
  const roots = [];
  const cs = codeServerRoot();
  if (cs !== null) roots.push(cs);
  roots.push(PACKAGE_ROOT);
  return roots;
}

/** 解析某个模块的包目录(依次尝试各锚点;先 `<name>/package.json`,再模块入口)。
 *  @param {string} name 真包名(重打包子包名),如 `@jinsiyu/dshcs-node-pty`
 *  @returns {string|null} */
export function resolveNativeDir(name) {
  for (const root of nativeSearchRoots()) {
    let from;
    try {
      from = createRequire(join(root, 'package.json'));
    } catch { continue; }
    for (const spec of [`${name}/package.json`, name]) {
      try {
        return dirname(from.resolve(spec));
      } catch { /* 试下一个 */ }
    }
  }
  return null;
}

/** 从 code-server 运行位置校验原生模块能否解析(名字用「原名」,即 VS Code 实际 import 的名字)。
 *  先试 `<name>/package.json`(ESM-only 包没有 require 入口,如 @microsoft/mxc-sdk),再退回 `<name>` 本身。
 *  @param {string[]} modules 期望的原生模块名(别名)
 *  @returns {{resolved:string[], missing:string[]}} */
export function verifyNatives(modules) {
  const csRoot = codeServerRoot();
  const resolved = [];
  const missing = [];
  for (const name of modules) {
    const ok = csRoot !== null && resolvesFromRoot(csRoot, name);
    if (ok) resolved.push(name);
    else missing.push(name);
  }
  return { resolved, missing };
}

/** 某个名字能否**只靠 code-server 运行根**(含其祖先 node_modules)解析。 */
function resolvesFromRoot(root, name) {
  try {
    const from = createRequire(join(root, 'package.json'));
    for (const spec of [`${name}/package.json`, name]) {
      try {
        from.resolve(spec);
        return true;
      } catch { /* 试下一个 */ }
    }
  } catch { /* 忽略 */ }
  return false;
}

/** 确保重打包子包能被 **code-server 树**按**原始名字**解析。
 *
 *  为什么必须做:重打包子包的真名是 `@<scope>/dshcs-<名字>`,而 VS Code 的
 *  `lib/vscode/out/server-main.js` 用 **ESM `import`** 加载 `node-pty` / `@vscode/sqlite3` 这类原名 ——
 *  ESM 不认 `NODE_PATH`(那是 CJS 的兜底),只认目录链。所以这里在 `<树根>/node_modules` 下为每个
 *  「从树里解析不到」的原名补一个 junction,指向插件依赖图里的真实目录。
 *  幂等、可重复调用;插件重装后由下次激活/启动自愈。
 *  @returns {{created:string[], failed:string[]}} */
export function ensureAliasLinks() {
  const csRoot = codeServerRoot();
  if (csRoot === null) return { created: [], failed: [] };
  const linkRoot = join(csRoot, 'node_modules');
  const created = [];
  const failed = [];
  for (const entry of vendoredEntries()) {
    if (resolvesFromRoot(csRoot, entry.alias)) continue; // 目录链已能看到(profile 根或树内),无需补
    const target = resolveNativeDir(entry.packageName);
    if (target === null) continue; // 该平台子包没装上 → 交给 envCheck 报缺
    const link = join(linkRoot, entry.alias);
    try {
      if (existsSync(join(link, 'package.json'))) continue; // 链接有效(真实目录或有效 junction)
      if (pathEntryExists(link)) rmSync(link, { recursive: true, force: true }); // 断链(树被重装过)→ 清掉重建
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
      created.push(entry.alias);
    } catch (error) {
      failed.push(`${entry.alias}: ${error && error.message ? error.message : String(error)}`);
    }
  }
  return { created, failed };
}

/** 从**插件依赖图**解析(插件 node_modules → <profile>/node_modules),返回**真正的包根目录**
 *  (有些包 `exports` 不暴露 `./package.json`,只能从入口文件往上找 name 匹配的目录)。
 *  与 `resolveNativeDir` 的区别:不走 code-server 树(树里可能有别的同名版本,例如 code-server 自带的
 *  typescript 5.9.3,而 VS Code 要的是 inner deps 里那份)。 */
function packageRootFromPlugin(name) {
  let from;
  try {
    from = createRequire(join(PACKAGE_ROOT, 'package.json'));
  } catch { return null; }
  try {
    return dirname(from.resolve(`${name}/package.json`));
  } catch { /* exports 未暴露 package.json → 退回入口文件 */ }
  try {
    let dir = dirname(from.resolve(name));
    for (let i = 0; i < 8; i += 1) {
      try {
        const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
        if (manifest.name === name) return dir;
      } catch { /* 继续往上 */ }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch { /* 解析不了 */ }
  return null;
}

/** 路径上是否已有东西(**包括断链的 junction**:code-server 树被 pnpm 重装后旧链接会变成断链,
 *  `existsSync` 对断链返回 false,直接再建会 EPERM)。 */
function pathEntryExists(target) {
  try {
    lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

/** 把 VS Code 的「内部依赖目录」用 junction 补回老布局。
 *
 *  为什么需要:老模型里 `lib/vscode/node_modules` 与 `lib/vscode/extensions/node_modules` 是 npm 在树里
 *  装出来的**真实目录**;新模型把同一批依赖拍平装在 `<profile>/node_modules`,靠模块解析往上层找没问题,
 *  但**用显式路径拼依赖的代码会失效** —— 例如内置 TypeScript 扩展(1.136.1 实测):
 *    `path.join(extensionPath, '..', 'node_modules', 'typescript', 'lib', 'tsserver.js')`
 *  找不到就弹 "VS Code's tsserver was deleted by another application …"。
 *  这里按两个 package.json 的 dependencies 逐个补 junction(指向插件依赖图里的真实包),幂等、可自愈。
 *  @returns {{created:string[], failed:string[]}} */
export function ensureInnerModuleLinks() {
  const csRoot = codeServerRoot();
  if (csRoot === null) return { created: [], failed: [] };
  const vscode = join(csRoot, 'lib', 'vscode');
  const targets = [
    { manifest: join(vscode, 'package.json'), dir: join(vscode, 'node_modules') },
    { manifest: join(vscode, 'extensions', 'package.json'), dir: join(vscode, 'extensions', 'node_modules') },
  ];
  const created = [];
  const failed = [];
  for (const { manifest, dir } of targets) {
    let deps;
    try {
      deps = JSON.parse(readFileSync(manifest, 'utf8')).dependencies ?? {};
    } catch { continue; }
    for (const name of Object.keys(deps)) {
      const link = join(dir, name);
      if (existsSync(join(link, 'package.json'))) continue; // 链接有效(真实目录或有效 junction)
      if (pathEntryExists(link)) {
        // 断链(树被重装过)→ 清掉重建
        try {
          rmSync(link, { recursive: true, force: true });
        } catch (error) {
          failed.push(`${name}: 旧链接清理失败 ${error && error.code ? error.code : error}`);
          continue;
        }
      }
      const target = packageRootFromPlugin(name);
      if (target === null) continue; // 该依赖没装(envCheck 会另行报告)
      try {
        mkdirSync(dirname(link), { recursive: true });
        symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
        created.push(name);
      } catch (error) {
        failed.push(`${name}: ${error && error.code ? error.code : error}`);
      }
    }
  }
  return { created, failed };
}

/** 一次性补齐两类链接:VS Code 内部依赖目录 + 重打包子包的原始名字。 */
export function ensureRuntimeLayout() {
  const inner = ensureInnerModuleLinks();
  const aliases = ensureAliasLinks();
  return {
    created: [...inner.created, ...aliases.created],
    failed: [...inner.failed, ...aliases.failed],
  };
}

/** 本平台预编译原生包的状态汇总(环境检测卡片用)。
 *  @returns {{name:string, source:'package'|null, version:string|null, modules:number, packages:number,
 *             resolved:number, missing:string[], missingPackages:string[], notApplicable:string[]}} */
export function nativeRuntimeStatus(platform = process.platform, arch = process.arch) {
  const table = readVendoredTable();
  const entries = vendoredEntries(platform, arch);
  const installed = [];
  const missingPackages = [];
  for (const entry of entries) {
    if (resolveNativeDir(entry.packageName) !== null) installed.push(entry);
    else missingPackages.push(entry);
  }
  const { resolved, missing } = verifyNatives(entries.map((entry) => entry.alias));
  return {
    name: `${table.scope}/dshcs-*-${platformKey(platform, arch)}`,
    source: installed.length > 0 ? 'package' : null,
    version: null,
    modules: entries.length,
    packages: installed.length,
    resolved: resolved.length,
    missing,
    missingPackages: missingPackages.map((entry) => entry.packageName),
    // 只属于其它平台的模块(如 Linux 上的 windows-*):不计入 modules/missing,单独列出来解释
    notApplicable: vendoredNotApplicable(platform, arch),
  };
}
