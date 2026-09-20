// scripts/test-installed.mjs —— 对**已装进 profile 的产物**做安装冒烟断言(装在真 DSH 里能不能用)。
//
// 为什么要单独一个脚本(npm 包发出去之后才发现的那类问题):
//   · files 白名单漏了产物(lib/client.js 曾是构建产物,vendor/VENDOR.json 由 prepack 生成);
//   · 可选子树的依赖被 pnpm 丢掉(0.3.45 的 requires missing bindings —— desktop 装完立刻校验);
//   · profile 的 hoisted 布局与仓库 dev 布局不同,运行时依赖解析不到(仓库里跑得再绿也看不出来)。
// 这几类都**不会**在仓库自己的回归里暴露,所以发布门禁要拿**发出去的那个 tarball**、走官方安装路径
// 装进一个真 profile,再回来断言。release.yml 里的「安装冒烟」就是这一步。
//
// 用法:
//   node scripts/test-installed.mjs [profile 目录] [--version <期望版本>]
//   不给目录时默认 <DSH_HOME|~/.dsh>/profiles/web(本机验证:装完 web profile 直接跑一遍)
// 例:
//   node scripts/test-installed.mjs "$DSH_HOME/profiles/web" --version 0.3.47
//   pnpm test:installed
//
// 断言(任一条挂 ⇒ exit 1):
//   ① profile 把插件登记进 dsh.profile.bundles(装了但没激活 = 用户看不到入口)
//   ② 已安装副本的版本 = 期望版本(npm 发的是哪一版,装上的就是哪一版)
//   ③ package.json 的 files 白名单**每一条**在已安装副本里都存在(漏产物最常见)
//   ④ 已安装的 lib/index.js 能被 import(profile 里解析得到 schemastery 等运行时依赖)
//   ⑤ lib/vendored.json 里每个重打包包在当前平台的真名都能在 profile 里找到
//   ⑥ 已安装的 lib/native.js:ensureRuntimeLayout() 补 junction 后没有缺失的原生模块
//   ⑦ VS Code 树本体在位(dshcs-vscode-server/vscode/lib/vscode/out/server-main.js)
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readVendoredTable, vendoredAppliesTo, vendoredPackageName } from '../lib/native.js';

const argv = process.argv.slice(2);
const profileArg = argv.find((a) => !a.startsWith('--')) ?? null;
const wantVersion = (() => {
  const i = argv.indexOf('--version');
  return i >= 0 ? argv[i + 1] ?? null : null;
})();

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const profile = resolve(profileArg ?? join(dshHome, 'profiles', 'web'));
const pluginDir = join(profile, 'node_modules', 'dsh-code-server-app');
const checks = [];
const skipped = [];
/** 在 GitHub Actions 里,失败的判据同时打成 `::error::` annotation —— 原始日志要鉴权才能拉
 *  (公开仓库的 jobs/logs 也返回 403),而 annotation 走 check-runs API **不需要 token**。
 *  这条通道在本仓库的 CI 里已经反复证明是唯一能读回 runner-only 失败的路径。 */
const IN_ACTIONS = process.env.GITHUB_ACTIONS === 'true';
const check = (name, ok, detail = '') => {
  checks.push([name, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok && IN_ACTIONS) console.log(`::error::${name}${detail ? ` — ${detail}` : ''}`);
};
const skip = (name, reason) => {
  skipped.push(name);
  console.log(`SKIP ${name} — ${reason}`);
};

/** 失败时把"profile 里到底有什么"打出来 —— 装完断言挂掉时,第一件要看的就是这个。 */
function dumpProfile() {
  try {
    const scoped = join(profile, 'node_modules', '@jinsiyu');
    const names = existsSync(scoped) ? readdirSync(scoped) : [];
    const line = `profile 里 @jinsiyu 下的包(${names.length}):${names.slice(0, 20).join(', ')}${names.length > 20 ? ' …' : ''}`;
    console.log(`[verify] ${line}`);
    if (IN_ACTIONS) console.log(`::error::${line}`);
  } catch (error) {
    console.log(`[verify] 列 @jinsiyu 失败:${error && error.message ? error.message : error}`);
  }
  try {
    const pkg = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'));
    const line = `profile:dependencies=${Object.keys(pkg.dependencies ?? {}).length} 项,`
      + `bundles=${JSON.stringify(pkg?.dsh?.profile?.bundles ?? [])}`;
    console.log(`[verify] ${line}`);
    if (IN_ACTIONS) console.log(`::error::${line}`);
  } catch (error) {
    console.log(`[verify] 读 profile package.json 失败:${error && error.message ? error.message : error}`);
  }
}

/** 这个平台有没有预编译原生子包:看**已安装插件自己**的 optionalDependencies 里有没有本平台后缀的
 *  条目(win32-* 一直是;linux-* 在首次发布并把它们写进依赖表之后自动生效 —— 这里不必改代码)。
 *  非支持平台:包管理器按包自带 os/cpu 跳过它们,profile 里当然没有 ⇒「重打包包齐全 / 原生模块
 *  无缺失」这两条在那里是**无意义**的断言,必须 SKIP 并说明原因,而不是判失败(2026-09-16 release
 *  门禁在 ubuntu 上就是这么被拦住的 —— 拦得对:那次等于暴露了"在错误的平台上做安装冒烟"这件事)。
 *  Linux 目标发布后,这两条在 Linux 上会自动变成真检查。 */
const pluginPkgFile = join(pluginDir, 'package.json');
const platformSuffix = `-${process.platform}-${process.arch}`;
const SHIPS_NATIVE = existsSync(pluginPkgFile)
  && Object.keys(JSON.parse(readFileSync(pluginPkgFile, 'utf8')).optionalDependencies ?? {})
    .some((name) => name.endsWith(platformSuffix));

console.log(`[verify] profile   : ${profile}`);
console.log(`[verify] 已安装插件: ${pluginDir}`);
console.log(`[verify] 主机平台  : ${process.platform}/${process.arch}`
  + `${SHIPS_NATIVE ? '' : `(该插件副本没有 ${platformSuffix} 的原生子包 ⇒ 原生相关断言会 SKIP)`}`);

// ① 激活登记
const profilePkgFile = join(profile, 'package.json');
if (!existsSync(profilePkgFile)) {
  check('profile 的 package.json 存在', false, profilePkgFile);
} else {
  const profilePkg = JSON.parse(readFileSync(profilePkgFile, 'utf8'));
  const bundles = profilePkg?.dsh?.profile?.bundles ?? [];
  check('插件已登记进 profile 的 dsh.profile.bundles', bundles.includes('dsh-code-server-app'),
    `bundles=${bundles.length} 项`);
}

// ② 版本
const installedPkgFile = join(pluginDir, 'package.json');
if (!existsSync(installedPkgFile)) {
  check('已安装的插件目录存在', false, pluginDir);
  console.log(`\n[verify] ${checks.length} 项,失败 ${checks.filter(([, ok]) => !ok).length} 项`);
  process.exit(1);
}
const installedPkg = JSON.parse(readFileSync(installedPkgFile, 'utf8'));
check('已安装版本正确', wantVersion === null || installedPkg.version === wantVersion,
  `已安装 ${installedPkg.version}${wantVersion === null ? '' : `,期望 ${wantVersion}`}`);

// ③ files 白名单(漏产物最常见:vendor/VENDOR.json 是 prepack 生成物)
const files = Array.isArray(installedPkg.files) ? installedPkg.files : [];
const missingFiles = files.filter((entry) => !existsSync(join(pluginDir, entry)));
check(`files 白名单的每一条都在已安装副本里(${files.length} 条)`, missingFiles.length === 0,
  missingFiles.length > 0 ? `缺:${missingFiles.join(', ')}` : '');
// 发布物里必须有的几个"容易漏"的产物单独点名(缺了就是装上却跑不起来)
for (const must of ['lib/index.js', 'lib/client.js', 'lib/vendored.json', 'vendor/VENDOR.json', 'cordis.patch.yml']) {
  check(`发布物含 ${must}`, existsSync(join(pluginDir, must)));
}

// ④ 已安装副本能 import(profile 里解析得到运行时依赖)
try {
  const mod = await import(pathToFileURL(join(pluginDir, 'lib', 'index.js')).href);
  check('已安装的 lib/index.js 可加载', typeof mod.apply === 'function' && mod.name === 'code-server',
    `name=${mod.name} inject=${JSON.stringify(mod.inject ?? [])}`);
} catch (error) {
  check('已安装的 lib/index.js 可加载', false, error && error.message ? error.message : String(error));
}

// ⑤ 重打包表 ↔ profile 里真实存在的包(0.3.45 那类"optional 子树被丢包"的探针)
const profileModules = join(profile, 'node_modules');
const table = readVendoredTable();
// 只看**本平台适用**的条目:只属于其它平台的模块(如 Linux 上的 @vscode/windows-registry)
// 它们的子包永远不会存在,拿它们判"缺包"没有意义。
const applicable = table.modules.filter((m) => vendoredAppliesTo(m));
const foreignCount = table.modules.length - applicable.length;
const tableCheckName = `重打包表里 ${applicable.length} 个适用包在当前平台都能在 profile 里找到`
  + `${foreignCount > 0 ? `(另有 ${foreignCount} 个只属于其它平台,不计)` : ''}`;
if (!SHIPS_NATIVE) {
  skip(tableCheckName, `已安装的插件副本没有 ${platformSuffix} 的原生子包 ⇒ 该平台还没发布原生产物`);
} else {
  const unresolved = [];
  for (const entry of applicable) {
    const name = vendoredPackageName(entry, process.platform, process.arch);
    if (existsSync(join(profileModules, name)) || existsSync(join(pluginDir, 'node_modules', name))) continue;
    unresolved.push(name);
  }
  check(tableCheckName, unresolved.length === 0,
    unresolved.length > 0 ? `缺:${unresolved.slice(0, 6).join(', ')}${unresolved.length > 6 ? ' …' : ''}` : '');
}

// ⑥ 原生运行时:补 junction 后不应有缺失(已安装副本自己的 lib/native.js)
try {
  const native = await import(pathToFileURL(join(pluginDir, 'lib', 'native.js')).href);
  const layout = native.ensureRuntimeLayout();
  check('ensureRuntimeLayout() 无失败项', layout.failed.length === 0,
    `created=${layout.created.length} failed=${layout.failed.length}`);
  const status = native.nativeRuntimeStatus();
  if (!SHIPS_NATIVE) {
    skip('原生模块全部可解析', `同上:该插件副本没有 ${platformSuffix} 的原生子包(缺 ${status.missing.length} 个)`);
  } else {
    check('原生模块全部可解析', status.missing.length === 0,
      `resolved=${status.resolved} missing=${status.missing.length}${status.missing.length ? `:${status.missing.slice(0, 6).join(',')}` : ''}`);
  }
} catch (error) {
  check('已安装的 lib/native.js 可用', false, error && error.message ? error.message : String(error));
}

// ⑦ VS Code 树本体
const treeEntry = join(profileModules, '@jinsiyu', 'dshcs-vscode-server', 'vscode', 'lib', 'vscode', 'out', 'server-main.js');
check('VS Code 树本体在位(server-main.js)', existsSync(treeEntry), treeEntry);

const failed = checks.filter(([, ok]) => !ok);
if (failed.length > 0) dumpProfile();
console.log(`\n[verify] ${checks.length} 项,失败 ${failed.length} 项`
  + `${skipped.length > 0 ? `,跳过 ${skipped.length} 项(见上面 SKIP 行)` : ''}`
  + `${failed.length > 0 ? `:${failed.map(([name]) => name).join(' / ')}` : ''}`);
process.exit(failed.length === 0 ? 0 : 1);
