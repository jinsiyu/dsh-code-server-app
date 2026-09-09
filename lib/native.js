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
//   2. 从 code-server 运行位置出发校验这些模块是否真的能 require 到。
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
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

/** 从 code-server 运行位置校验原生模块能否解析(与运行时同一套向上查找规则)。
 *  先试 `<name>/package.json`(ESM-only 包没有 require 入口,如 @microsoft/mxc-sdk),
 *  再退回 `<name>` 本身。
 *  @param {string[]} modules 期望的原生模块名(通常来自聚合包依赖清单)
 *  @returns {{resolved:string[], missing:string[]}} */
export function verifyNatives(modules) {
  // 锚点 = code-server 运行根(平台子包内的 code-server/ 或包内 vendor);
  // 从它向上:自带 node_modules → 插件 node_modules → <profile>/node_modules。
  const from = createRequire(join(codeServerRoot() ?? PACKAGE_ROOT, 'package.json'));
  const resolved = [];
  const missing = [];
  for (const name of modules) {
    let ok = false;
    for (const spec of [`${name}/package.json`, name]) {
      try {
        from.resolve(spec);
        ok = true;
        break;
      } catch { /* 试下一个 */ }
    }
    if (ok) resolved.push(name);
    else missing.push(name);
  }
  return { resolved, missing };
}
