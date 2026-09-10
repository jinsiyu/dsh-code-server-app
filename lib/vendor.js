// lib/vendor.js — 内置 VS Code 产物的路径工具(host 与脚本共用)。
//
// 模型(重构后,0.2.0 起):
//   - VS Code 树 + 少量浏览器静态资源打成**平台无关子包**发布:
//       @<scope>/dshcs-vscode-server@<code-server 版本>
//     子包内布局:<pkg>/vscode/{lib/vscode,out/browser,src/browser,…};
//     旧的全量树 @<scope>/dshcs-code-server@<版本> 仍然可作回退(0.1.43 及更早)。
//   - code-server 的 Node 服务层(out/node/** + 136 个依赖)不再随包发布:
//     由插件自带的 lib/launcher.mjs 取代(见 docs/analysis-code-server-as-dsh-plugin.md)。
//   - VS Code 内部依赖(约 1GB)与需编译的原生模块仍由包管理器安装:
//     纯 JS 部分写在插件 package.json 的 dependencies;
//     pnpm 拒绝安装的原生包由 scripts/vendor-repacks.mjs 重打包成 @<scope>/dshcs-*,
//     再由平台聚合包 @<scope>/dsh-code-server-runtime-<platform>-<arch> 用 npm: 别名装回原名字;
//   - 插件包内 `vendor/vscode/` 只作为**开发期/兼容**回退(发布包不含 vendor)。
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // <pkg>/lib
const require_ = createRequire(import.meta.url);
export const PACKAGE_ROOT = resolve(here, '..');
/** 包内 VS Code 树(新模型;发布包不含,仅开发期/兼容回退)。 */
export const VENDOR_TREE = join(PACKAGE_ROOT, 'vendor', 'vscode');
/** 包内旧全量 code-server 树(0.1.43 及更早;仅兼容回退)。 */
export const LEGACY_VENDOR_TREE = join(PACKAGE_ROOT, 'vendor', 'code-server');
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

function declaredDependencyNames() {
  try {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
    return {
      ...(manifest.dependencies ?? {}),
      ...(manifest.optionalDependencies ?? {}),
    };
  } catch {
    return {};
  }
}

/** VS Code 树包名(0.2.0+ 平台无关):取插件 dependencies 里的 @<scope>/dshcs-vscode-server。 */
export function vscodeServerPackageName() {
  const declared = declaredDependencyNames();
  const hit = Object.keys(declared).find((name) => /^@[^/]+\/dshcs-vscode-server$/.test(name));
  if (hit !== undefined) return hit;
  return '@jinsiyu/dshcs-vscode-server';
}

/** 旧 code-server 全量树包名(0.1.43 及更早):@<scope>/dshcs-code-server。 */
export function codeServerPackageName() {
  const declared = declaredDependencyNames();
  const hit = Object.keys(declared).find((name) => /^@[^/]+\/dshcs-code-server$/.test(name));
  if (hit !== undefined) return hit;
  return '@jinsiyu/dshcs-code-server';
}

/** 旧版(0.1.37)平台专属 code-server 子包名,仅作兼容回退。 */
export function legacyCodeServerPackageName(platform = process.platform, arch = process.arch) {
  return `@jinsiyu/dshcs-code-server-${platform}-${arch}`;
}

/** 解析某个包目录下的 VS Code 树根。
 *  新布局:<pkg>/vscode/lib/vscode/out/server-main.js;旧布局:<pkg>/code-server/out/node/entry.js。 */
function rootOfPackage(name) {
  try {
    const manifest = require_.resolve(`${name}/package.json`);
    const base = dirname(manifest);
    const slim = join(base, 'vscode');
    if (existsSync(join(slim, 'lib', 'vscode', 'out', 'server-main.js'))) return slim;
    const legacy = join(base, 'code-server');
    if (existsSync(join(legacy, 'out', 'node', 'entry.js'))) return legacy;
  } catch { /* 未安装 */ }
  return null;
}

/** VS Code 树根(新包 > 旧包 > 旧平台子包 > 包内 vendor/vscode > 包内 vendor/code-server)。
 *  @returns {string|null} 绝对路径,如 <profile>\node_modules\@jinsiyu\dshcs-vscode-server\vscode */
export function vsRoot() {
  const root = rootOfPackage(vscodeServerPackageName())
    ?? rootOfPackage(codeServerPackageName())
    ?? rootOfPackage(legacyCodeServerPackageName());
  if (root !== null) return root;
  if (existsSync(join(VENDOR_TREE, 'lib', 'vscode', 'out', 'server-main.js'))) return VENDOR_TREE;
  if (existsSync(join(LEGACY_VENDOR_TREE, 'out', 'node', 'entry.js'))) return LEGACY_VENDOR_TREE;
  return null;
}

/** VS Code server 入口(<树根>/lib/vscode/out/server-main.js);不可用时返回 null。 */
export function vsServerEntry() {
  const root = vsRoot();
  if (root === null) return null;
  const entry = join(root, 'lib', 'vscode', 'out', 'server-main.js');
  return existsSync(entry) ? entry : null;
}

/** VS Code 树根(兼容别名:0.1.43 及更早的调用点用这个名字)。 */
export function codeServerRoot() {
  return vsRoot();
}

/** VS Code 客户端约定的产品路径(quality-commit);从 product.json 现算,禁止硬编码。 */
export function productPath(root = vsRoot()) {
  if (root !== null) {
    try {
      const product = JSON.parse(readFileSync(join(root, 'lib', 'vscode', 'product.json'), 'utf8'));
      return `${product.quality ?? 'oss'}-${product.commit ?? 'dev'}`;
    } catch { /* 回退 VENDOR.json */ }
  }
  const meta = readVendorMeta();
  return typeof meta?.productPath === 'string' && meta.productPath !== '' ? meta.productPath : null;
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
  return readTreeVersion(VENDOR_TREE) ?? readTreeVersion(LEGACY_VENDOR_TREE);
}

/** VS Code 树是否可用(包已安装或包内 vendor 在位)。 */
export function vendorReady() {
  return vsRoot() !== null;
}

