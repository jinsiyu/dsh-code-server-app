// lib/vendor.js — 内置 code-server 产物的路径工具(host 与脚本共用)。
//
// 模型(0.1.37 起):
//   - code-server 本体 + 它自己的运行时依赖(约 232MB 解包)打成**平台专属子包**发布:
//       @<scope>/dshcs-code-server-<platform>-<arch>@<code-server 版本>
//     (os/cpu 限定,挂在插件 optionalDependencies 上 → pnpm 按架构自动选中);
//     子包内布局:<pkg>/code-server/{out,lib/vscode,node_modules,…};
//   - VS Code 内部依赖(约 1GB)与需编译的原生模块仍由包管理器安装:
//       纯 JS 部分写在插件 package.json 的 dependencies;
//       pnpm 拒绝安装的原生包由 scripts/vendor-repacks.mjs 重打包成 @<scope>/dshcs-*,
//       再由平台聚合包 @<scope>/dsh-code-server-runtime-<platform>-<arch> 用 npm: 别名装回原名字;
//   - 插件包内 `vendor/code-server/` 只作为**开发期/兼容**回退(0.1.37 起不再随包发布)。
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // <pkg>/lib
const require_ = createRequire(import.meta.url);
export const PACKAGE_ROOT = resolve(here, '..');
/** 包内 code-server 树(0.1.36 及更早随包发布;现在仅开发期/兼容回退)。 */
export const VENDOR_TREE = join(PACKAGE_ROOT, 'vendor', 'code-server');
const VENDOR_META = join(PACKAGE_ROOT, 'vendor', 'VENDOR.json');
/** 旧版安装根目录名(0.1.35 及更早);仅用于迁移提示。 */
export const APP_DIR_NAME = '.code-server-app';

/** <profile> 根;插件不在 profile 布局(开发期独立目录)时返回 null。 */
export function profileRootOf() {
  const profileRoot = resolve(PACKAGE_ROOT, '..', '..');
  const isProfile = existsSync(join(profileRoot, 'node_modules')) && existsSync(join(profileRoot, 'package.json'));
  return isProfile ? profileRoot : null;
}

/** 旧版安装根(<profile>\.code-server-app);存在时提示可删除。 */
export function legacyInstallRoot() {
  const profileRoot = profileRootOf();
  return profileRoot !== null ? join(profileRoot, APP_DIR_NAME) : null;
}

/** 本平台 code-server 子包名:优先取插件 optionalDependencies 里匹配 <平台>-<架构> 的声明。 */
export function codeServerPackageName(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  try {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
    const declared = { ...(manifest.optionalDependencies ?? {}), ...(manifest.dependencies ?? {}) };
    const hit = Object.keys(declared).find((name) => /dshcs-code-server-/.test(name) && name.endsWith(`-${key}`));
    if (hit !== undefined) return hit;
  } catch { /* 回退默认 scope */ }
  return `@jinsiyu/dshcs-code-server-${key}`;
}

/** code-server 运行根(优先依赖安装的平台子包,其次包内 vendor)。
 *  @returns {string|null} 绝对路径,如 <profile>\node_modules\@jinsiyu\dshcs-code-server-win32-arm64\code-server */
export function codeServerRoot() {
  const name = codeServerPackageName();
  try {
    const manifest = require_.resolve(`${name}/package.json`);
    const root = join(dirname(manifest), 'code-server');
    if (existsSync(join(root, 'out', 'node', 'entry.js'))) return root;
  } catch { /* 子包未安装 */ }
  if (existsSync(join(VENDOR_TREE, 'out', 'node', 'entry.js'))) return VENDOR_TREE;
  return null;
}

/** code-server 入口脚本(out/node/entry.js);不可用时返回 null。 */
export function codeServerEntry() {
  const root = codeServerRoot();
  return root !== null ? join(root, 'out', 'node', 'entry.js') : null;
}

/** code-server 运行根(旧名,脚本/调用方沿用)。 */
export function codeServerTarget() {
  return codeServerRoot();
}

export function readTreeVersion(dir) {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
}

/** 内置产物元数据(vendor/VENDOR.json;打包期写入,随包发布)。 */
export function readVendorMeta() {
  try {
    const meta = JSON.parse(readFileSync(VENDOR_META, 'utf8'));
    return meta !== null && typeof meta === 'object' ? meta : null;
  } catch {
    return null;
  }
}

/** 内置 code-server 版本(VENDOR.json 优先,回退树内 package.json)。 */
export function vendoredVersion() {
  const meta = readVendorMeta();
  if (meta !== null && typeof meta.codeServerVersion === 'string' && meta.codeServerVersion !== '') {
    return meta.codeServerVersion;
  }
  return readTreeVersion(VENDOR_TREE);
}

/** code-server 是否可用(平台子包已安装或包内 vendor 在位)。 */
export function vendorReady() {
  return codeServerRoot() !== null;
}
