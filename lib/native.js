// lib/native.js — 平台聚合包(预编译原生模块)的定位与校验。
//
// 模型(0.1.36 起):VS Code 内部依赖里那批「pnpm 拒绝安装」的原生包(node-pty /
// @vscode/sqlite3 / kerberos / koffi / ssh2 / cpu-features / @parcel/watcher /
// @vscode/windows-* …)在打包期由 scripts/vendor-repacks.mjs 重打包成
// @<scope>/dshcs-<名字>[-<平台>-<架构>],再由平台聚合包
//   @<scope>/dsh-code-server-runtime-<平台>-<架构>
// 用 npm: 别名把它们装回**原始名字**。聚合包挂在插件 package.json 的
// optionalDependencies 上(os/cpu 限定)→ pnpm 一条命令按架构自动选中。
//
// 本模块只做两件事:
//   1. 找到本平台聚合包(以及它的依赖清单 = 期望可解析的原生模块名);
//   2. 从 code-server 运行位置出发校验这些模块是否真的能 require 到;
//   3. 必要时在 code-server 树里补齐别名 junction(ESM import 不认 NODE_PATH,只能靠目录链)。
import { createRequire } from 'node:module';
import { existsSync, readFileSync, mkdirSync, symlinkSync, lstatSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PACKAGE_ROOT, codeServerRoot, profileRootOf } from './vendor.js';

const require_ = createRequire(import.meta.url);

/** 平台目录名,如 win32-arm64。 */
export function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

/** 本平台聚合包名(取插件 optionalDependencies 中匹配 <平台>-<架构> 的那个)。 */
export function runtimePackageName(platform = process.platform, arch = process.arch) {
  const key = platformKey(platform, arch);
  try {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
    const declared = { ...(pkg.optionalDependencies ?? {}), ...(pkg.dependencies ?? {}) };
    const hit = Object.keys(declared).find((name) => /^@[^/]+\/dsh-code-server-runtime-/.test(name) && name.endsWith(`-${key}`));
    if (hit !== undefined) return hit;
  } catch { /* 回退默认 scope */ }
  return `@jinsiyu/dsh-code-server-runtime-${key}`;
}

/** 定位已安装的平台聚合包。
 *  @returns {{name:string, version:string|null, root:string, modules:string[]}|null} */
export function resolveRuntime() {
  const name = runtimePackageName();
  const candidates = [];
  try {
    candidates.push(dirname(require_.resolve(`${name}/package.json`)));
  } catch { /* 未安装 */ }
  const profileRoot = profileRootOf();
  for (const root of [join(PACKAGE_ROOT, 'node_modules'), profileRoot !== null ? join(profileRoot, 'node_modules') : null, PACKAGE_ROOT]) {
    if (root !== null) candidates.push(join(root, name));
  }
  for (const root of candidates) {
    const manifestPath = join(root, 'package.json');
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const modules = Object.keys({ ...(manifest.dependencies ?? {}), ...(manifest.optionalDependencies ?? {}) });
      return { name, version: typeof manifest.version === 'string' ? manifest.version : null, root, modules };
    } catch { /* 尝试下一个 */ }
  }
  return null;
}

/** 解析原生/别名模块时的锚点目录:
 *   ① code-server 运行根(树自带 node_modules);
 *   ② 平台聚合包目录 —— pnpm 会把带 os/cpu 限定的包**嵌套装在聚合包下**
 *      (`<profile>/node_modules/@<scope>/dsh-code-server-runtime-<平台>-<架构>/node_modules/<别名>`),
 *      既不在 profile 根也不在 code-server 树里,所以要单独作为锚点(运行时用 NODE_PATH 覆盖同一批目录)。
 *  @returns {string[]} */
export function nativeSearchRoots() {
  const roots = [];
  const cs = codeServerRoot();
  if (cs !== null) roots.push(cs);
  const runtime = resolveRuntime();
  if (runtime !== null) roots.push(runtime.root);
  return roots;
}

/** 运行时需要加进 NODE_PATH 的目录(平台聚合包下嵌套的别名包)。
 *  @returns {string[]} */
export function aliasNodePathDirs() {
  const runtime = resolveRuntime();
  if (runtime === null) return [];
  const dir = join(runtime.root, 'node_modules');
  return existsSync(dir) ? [dir] : [];
}

/** 解析某个模块的包目录(依次尝试各锚点;先 `<name>/package.json`,再模块入口)。
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

/** 从 code-server 运行位置(与聚合包目录)校验原生模块能否解析。
 *  先试 `<name>/package.json`(ESM-only 包没有 require 入口,如 @microsoft/mxc-sdk),
 *  再退回 `<name>` 本身。
 *  @param {string[]} modules 期望的原生模块名(通常来自聚合包依赖清单)
 *  @returns {{resolved:string[], missing:string[]}} */
export function verifyNatives(modules) {
  const resolved = [];
  const missing = [];
  for (const name of modules) {
    if (resolveNativeDir(name) !== null) resolved.push(name);
    else missing.push(name);
  }
  return { resolved, missing };
}

/** 某个模块能否**只靠 code-server 运行根**(含其祖先 node_modules)解析。 */
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

/** 确保聚合包带回的别名模块能被 **code-server 树**解析。
 *
 *  为什么必须做:pnpm 会把带 `os`/`cpu` 限定的包**嵌套装在聚合包自己的 node_modules 下**
 *  (如 `<profile>/node_modules/@<scope>/dsh-code-server-runtime-win32-arm64/node_modules/@vscode/windows-registry`),
 *  而 VS Code 的 `lib/vscode/out/server-main.js` 用 **ESM `import`** 加载这些包 —— ESM 不认
 *  `NODE_PATH`(那是 CJS 的兜底),只认目录链。所以这里在 `<codeServerRoot>/node_modules` 下
 *  为每个「从树里解析不到」的别名补一个 junction,指向聚合包内的真实目录。
 *  幂等、可重复调用;插件重装后由下次激活/启动自愈。
 *  @returns {{created:string[], failed:string[]}} */
export function ensureAliasLinks() {
  const runtime = resolveRuntime();
  const csRoot = codeServerRoot();
  if (runtime === null || csRoot === null) return { created: [], failed: [] };
  const linkRoot = join(csRoot, 'node_modules');
  const created = [];
  const failed = [];
  for (const alias of runtime.modules) {
    if (resolvesFromRoot(csRoot, alias)) continue; // 目录链已能看到(profile 根或树内),无需补
    const target = resolveNativeDir(alias);
    if (target === null) continue; // 该平台包没装上 → 交给 envCheck 报缺
    const link = join(linkRoot, alias);
    try {
      if (existsSync(link)) continue;
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
      created.push(alias);
    } catch (error) {
      failed.push(`${alias}: ${error && error.message ? error.message : String(error)}`);
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

/** 一次性补齐两类链接:VS Code 内部依赖目录 + 聚合包别名。 */
export function ensureRuntimeLayout() {
  const inner = ensureInnerModuleLinks();
  const aliases = ensureAliasLinks();
  return {
    created: [...inner.created, ...aliases.created],
    failed: [...inner.failed, ...aliases.failed],
  };
}
