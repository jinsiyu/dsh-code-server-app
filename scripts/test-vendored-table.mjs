// scripts/test-vendored-table.mjs —— 「重打包表 ↔ 插件依赖表」一致性测试(0.3.45 起的原生包模型)
//
// 为什么要有:0.3.45 弃用了「平台聚合包 + npm: 别名」—— 那套依赖 pnpm 在**可选子树**里正确处理别名,
// 而 `pnpm add` 的增量 hoisted 安装会漏链其中 9 个,dsh-desktop 安装后立刻校验 ⇒ 首次安装必报
// requires missing(见 docs/desktop-first-install-root-cause.md)。新模型要求:
//   · 平台无关的重打包包 → 插件 dependencies(真名);
//   · 平台专属的重打包包 → 插件 optionalDependencies(真名 + 包自带 os/cpu,每目标一份);
//   · 平台专属包**自己的注册表依赖**(bindings / fs-extra / uuid / mkdirp…)→ 也必须写进插件
//     dependencies:它们在 optional 子树 depth≥2 处,pnpm 的增量 hoisted 安装会把整支丢进
//     `skipped`(0.3.45 的残留下沉,见 docs/desktop-first-install-root-cause.md 第 5 节);
//   · 依赖表里**不允许出现任何 npm: 别名**,也不允许再引用平台聚合包;
//   · 原始名字(调用方 import 的名字)只由 lib/vendored.json + 运行时 junction 提供。
// 这一层错了不会立刻报错(装得上、跑不起来),所以钉死。
//
// 用法:node scripts/test-vendored-table.mjs
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readVendoredTable, vendoredEntries, vendoredPackageName } from '../lib/native.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** 上游包名 → 重打包目录名(与 scripts/vendor-repacks.mjs 的 flat() 同一规则)。 */
const flat = (name) => name.replace(/^@/u, '').replaceAll('/', '-');
/** 读 JSON;**读不到/读坏都返回 null,不抛**。
 *  为什么必须容错:`vendor/`(`vendor/VENDOR.json`、`vendor/vscode/package.json`)与 `repack/build`
 *  都是 .gitignore 的**打包期产物** —— 全新 clone(CI 的 runner)上它们一律不存在。
 *  那些断言本来就写成"能拿到基准值才比,拿不到就跳过",但 `JSON.parse(readFileSync(...))` 在文件
 *  不存在时是 **ENOENT 抛出**而不是返回 undefined ⇒ 0.3.46 首次跑 CI 时 test-vendored-table 直接挂
 *  (本机因为打过包,`vendor/VENDOR.json` 一直在 ⇒ 本地永远绿,这类"只在干净克隆上炸"的问题只有 CI 能抓)。 */
const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};
const pluginPkg = readJson(join(root, 'package.json'));
const table = readJson(join(root, 'lib', 'vendored.json'));

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`FAIL ${name}: ${error && error.message ? error.message : error}`);
  }
}

const deps = pluginPkg.dependencies ?? {};
const optional = pluginPkg.optionalDependencies ?? {};
const specific = table.modules.filter((m) => m.platform === true);
const independent = table.modules.filter((m) => m.platform !== true);

await test('lib/vendored.json 结构完整(schemaVersion / scope / targets / modules)', async () => {
  assert.equal(table.schemaVersion, 1);
  assert.equal(typeof table.scope, 'string');
  assert.ok(table.scope.startsWith('@'), `scope 应为作用域名:${table.scope}`);
  assert.ok(Array.isArray(table.targets) && table.targets.length > 0, 'targets 不能为空');
  assert.ok(Array.isArray(table.modules) && table.modules.length > 0, 'modules 不能为空');
  for (const m of table.modules) {
    assert.equal(typeof m.alias, 'string', `alias 必须是字符串:${JSON.stringify(m)}`);
    assert.equal(typeof m.package, 'string', `package 必须是字符串:${JSON.stringify(m)}`);
    assert.ok(m.package.startsWith(`${table.scope}/`), `package 应带 scope:${m.package}`);
    assert.equal(typeof m.version, 'string', `version 必须是字符串:${JSON.stringify(m)}`);
    // 平台专属条目存**基名**,运行时才拼 -<平台>-<架构>;不能残留平台后缀
    if (m.platform === true) {
      assert.doesNotMatch(m.package, /-(win32|darwin|linux)-(arm64|x64)$/u, `平台专属条目应存基名:${m.package}`);
    }
  }
});

await test('别名唯一,包名唯一', async () => {
  const aliases = table.modules.map((m) => m.alias);
  assert.equal(new Set(aliases).size, aliases.length, `alias 有重复:${aliases.join(', ')}`);
  const names = table.modules.map((m) => m.package);
  assert.equal(new Set(names).size, names.length, `包名有重复:${names.join(', ')}`);
});

await test('平台无关的重打包包都写在 dependencies(精确版本)', async () => {
  assert.ok(independent.length > 0, '应至少有一个平台无关重打包包');
  for (const m of independent) {
    assert.equal(deps[m.package], m.version, `${m.package} 应在 dependencies 且为 ${m.version},实际 ${deps[m.package]}`);
  }
});

await test('平台专属的重打包包按「每模块目标白名单 ∩ 已发布目标」写在 optionalDependencies', async () => {
  assert.ok(specific.length > 0, '应至少有一个平台专属重打包包');
  const policy = readJson(join(root, 'scripts', 'repack-platforms.json'));
  const published = Array.isArray(policy?.publishedTargets) ? policy.publishedTargets : null;
  assert.ok(published !== null && published.length > 0,
    'scripts/repack-platforms.json 应有 publishedTargets —— 否则看不出哪些目标已经能写进插件依赖');
  const targetsOf = (m) => (Array.isArray(m.targets) ? m.targets : table.targets);
  const allowed = new Set();
  for (const target of published) {
    for (const m of specific) {
      const name = `${m.package}-${target}`;
      if (!targetsOf(m).includes(target)) {
        assert.ok(!(name in optional), `${name} 不在 ${m.alias} 的目标白名单里,不该写进 optionalDependencies`);
        continue;
      }
      allowed.add(name);
      assert.equal(optional[name], m.version, `${name} 应在 optionalDependencies 且为 ${m.version},实际 ${optional[name]}`);
    }
  }
  // 反向:未发布的目标(例如还没首次发布的 linux 子包)一个都不许出现 ——
  // 写进去 pnpm install 就会去解析一个不存在的包。
  const extra = Object.keys(optional).filter((name) => !allowed.has(name));
  assert.equal(extra.length, 0,
    `optionalDependencies 里有「未发布目标 / 白名单外」的条目:${extra.join(', ')}`
    + `(已发布目标:${published.join(', ')})`);
  assert.equal(Object.keys(optional).length, allowed.size, 'optionalDependencies 应恰好等于「白名单 ∩ 已发布目标」的笛卡尔积');
});

await test('平台专属重打包包的注册表依赖已提为插件直接依赖(optional 子树会被 pnpm 丢包)', async () => {
  const buildRoot = join(root, 'repack', 'build');
  if (!existsSync(buildRoot)) return; // 没编过原生包(全新克隆)→ 跳过
  const platformDirs = readdirSync(buildRoot).filter((name) => /-(?:win32|darwin|linux)-(?:arm64|x64)$/u.test(name));
  assert.ok(platformDirs.length > 0, `repack/build 里应有平台专属重打包目录:${readdirSync(buildRoot).join(', ')}`);
  const missing = [];
  for (const dir of platformDirs) {
    const manifest = readJson(join(buildRoot, dir, 'package.json'));
    for (const field of ['dependencies', 'optionalDependencies']) {
      for (const [name, spec] of Object.entries(manifest?.[field] ?? {})) {
        if (String(spec).startsWith('npm:')) continue; // 已重打包的真名子包
        if (!(name in deps)) missing.push(`${manifest.name}.${field}.${name}@${spec}`);
      }
    }
  }
  assert.equal(missing.length, 0,
    `这些依赖在 optional 子树里(depth≥2),pnpm 增量 hoisted 安装会整支丢进 skipped,`
    + ` dsh-desktop 装完立刻校验 ⇒ 必须写进插件 dependencies:${missing.join(', ')}`);
});

await test('依赖表里没有任何 npm: 别名(本次改造的核心不变式)', async () => {
  for (const [field, map] of [['dependencies', deps], ['optionalDependencies', optional]]) {
    for (const [name, spec] of Object.entries(map)) {
      assert.doesNotMatch(String(spec), /^npm:/u, `${field}.${name} 仍是 npm: 别名:${spec}`);
    }
  }
});

await test('依赖表里不再引用平台聚合包', async () => {
  for (const name of [...Object.keys(deps), ...Object.keys(optional)]) {
    assert.doesNotMatch(name, /dsh-code-server-runtime/u, `仍在引用平台聚合包:${name}`);
  }
});

await test('VS Code 树包仍按 dependencies 精确钉版本', async () => {
  const tree = Object.keys(deps).filter((name) => /\/dshcs-vscode-server$/u.test(name));
  assert.equal(tree.length, 1, `树包应恰好一个:dependencies 里是 ${tree.join(', ') || '(无)'}`);
  const pinned = readJson(join(root, 'vendor', 'VENDOR.json'))?.codeServerVersion
    ?? readJson(join(root, 'vendor', 'vscode', 'package.json'))?.version;
  if (typeof pinned !== 'string') {
    // 不静默:明确说清"这一条这次没验",以及为什么(全新 clone 没有打包期产物)。
    console.log('     (vendor/ 不在(全新 clone / 没跑过 vendor:vscode)⇒ 跳过基准比对;'
      + '发布流程里 pnpm pack 之前一定已经生成,那条路上这条断言是真跑的)');
    return;
  }
  assert.equal(deps[tree[0]], pinned, `${tree[0]} 应钉 ${pinned}`);
});

await test('发布清单 files 带上 lib/vendored.json(否则装完读不到表)', async () => {
  assert.ok(Array.isArray(pluginPkg.files) && pluginPkg.files.includes('lib/vendored.json'),
    `files 里缺 lib/vendored.json:${JSON.stringify(pluginPkg.files)}`);
  assert.ok(pluginPkg.files.includes('lib/native.js'), 'files 里缺 lib/native.js');
});

await test('运行时表:vendoredEntries() 只含本平台适用的模块,并按该平台拼后缀', async () => {
  const hostKey = `${process.platform}-${process.arch}`;
  const applies = (m, key) => m.platform !== true || !Array.isArray(m.targets) || m.targets.includes(key);
  const host = vendoredEntries();
  const applicable = table.modules.filter((m) => applies(m, hostKey));
  assert.equal(host.length, applicable.length,
    `宿主适用条目数应为 ${applicable.length}(表里 ${table.modules.length} 个,其余只属于别的平台),实际 ${host.length}`);
  for (const m of applicable) {
    const hit = host.find((e) => e.alias === m.alias);
    assert.ok(hit !== undefined, `运行时表缺 ${m.alias}`);
    assert.equal(hit.packageName, m.platform === true ? `${m.package}-${hostKey}` : m.package,
      `${m.alias} 的真包名不对:${hit.packageName}`);
  }
  // 跨平台:适用性按白名单判定,真名只换后缀;Windows-only 的模块在 Linux 上必须消失
  // (否则运行时会去找 @jinsiyu/dshcs-vscode-windows-registry-linux-x64 这种永远不存在的包)
  for (const key of ['linux-x64', 'win32-x64', 'linux-arm64', 'win32-arm64']) {
    const aliases = new Set(vendoredEntries(...key.split('-')).map((e) => e.alias));
    for (const m of table.modules) {
      assert.equal(aliases.has(m.alias), applies(m, key),
        `${m.alias} 在 ${key} 上的适用性判定与白名单不符(targets=${JSON.stringify(m.targets ?? null)})`);
    }
  }
  const linuxCapable = specific.find((m) => Array.isArray(m.targets) && m.targets.includes('linux-x64'));
  if (linuxCapable !== undefined) {
    const hit = vendoredEntries('linux', 'x64').find((e) => e.alias === linuxCapable.alias);
    assert.equal(hit.packageName, `${linuxCapable.package}-linux-x64`, `跨平台拼名不对:${hit.packageName}`);
  }
});

await test('平台政策(scripts/repack-platforms.json)与重打包表一致', async () => {
  const policy = readJson(join(root, 'scripts', 'repack-platforms.json'));
  assert.ok(policy !== null, 'scripts/repack-platforms.json 必须存在:它是「每模块平台白名单」的唯一来源,'
    + '生成器据此决定构建/依赖/运行时过滤(上游不写 os/cpu,analyze() 的结论随宿主漂移)');
  assert.deepEqual(table.targets, policy.targets,
    `vendored.json 的 targets 应与政策一致:${JSON.stringify(table.targets)} vs ${JSON.stringify(policy.targets)}`);
  const known = new Map(Object.entries(policy.modules ?? {}));
  const unknown = table.modules.map((m) => m.alias).filter((alias) => !known.has(alias));
  assert.equal(unknown.length, 0, `表里的模块没在政策里登记:${unknown.join(', ')}(换宿主平台时分类会漂移)`);
  const missing = [...known.keys()].filter((alias) => !table.modules.some((m) => m.alias === alias));
  assert.equal(missing.length, 0, `政策里登记了但表里没有的模块:${missing.join(', ')}`);
  for (const m of table.modules) {
    const decl = known.get(m.alias);
    assert.equal(m.platform === true, decl.platform === true, `${m.alias}: platform 标记与政策不一致`);
    if (m.platform !== true) {
      assert.equal(m.targets, undefined, `${m.alias} 是平台无关模块,不该有 targets`);
      continue;
    }
    const want = Array.isArray(decl.targets) ? table.targets.filter((t) => decl.targets.includes(t)) : [...table.targets];
    assert.deepEqual(m.targets, want,
      `${m.alias}: 目标白名单与政策不一致(${JSON.stringify(m.targets)} vs ${JSON.stringify(want)})`);
    assert.ok(m.targets.length > 0, `${m.alias} 是平台专属模块,却没有任何目标`);
  }
  for (const m of table.modules) {
    if (!/windows-/u.test(m.alias)) continue;
    const linuxHit = (m.targets ?? []).filter((t) => t.startsWith('linux-'));
    assert.equal(linuxHit.length, 0, `${m.alias} 是 Windows-only 模块,不该有 ${linuxHit.join(', ')} 目标`);
  }
});

await test('readVendoredTable() 读得到 scope 与 targets', async () => {
  const live = readVendoredTable();
  assert.equal(live.scope, table.scope);
  assert.deepEqual(live.targets, table.targets);
  assert.equal(live.modules.length, table.modules.length);
  assert.equal(vendoredPackageName({ package: '@x/y', platform: false }), '@x/y');
  assert.equal(vendoredPackageName({ package: '@x/y', platform: true }, 'win32', 'arm64'), '@x/y-win32-arm64');
});

await test('repack/build 与 pack-plan.json 一致,且不出现白名单外的目录(构建产物存在时)', async () => {
  const buildRoot = join(root, 'repack', 'build');
  if (!existsSync(buildRoot)) return; // 没编过原生包(全新克隆)→ 跳过
  const dirs = new Set(readdirSync(buildRoot));
  const legal = new Set();
  for (const m of independent) legal.add(flat(m.alias));
  for (const m of specific) for (const t of m.targets ?? table.targets) legal.add(`${flat(m.alias)}-${t}`);
  const plan = readJson(join(root, 'repack', 'pack-plan.json'));
  if (!Array.isArray(plan)) {
    // 没有计划文件(旧构建残留)⇒ 只对宿主目标做实检查,并把检查范围说清楚
    const hostKey = `${process.platform}-${process.arch}`;
    const expected = new Set();
    for (const m of independent) expected.add(flat(m.alias));
    for (const m of specific) if ((m.targets ?? table.targets).includes(hostKey)) expected.add(`${flat(m.alias)}-${hostKey}`);
    const missing = [...expected].filter((d) => !dirs.has(d));
    assert.equal(missing.length, 0, `repack/build 缺宿主目标的目录:${missing.join(', ')}(无 pack-plan.json,只查 ${hostKey})`);
    return;
  }
  const planned = new Set(plan.map((item) => basename(item.dir)));
  const missing = [...planned].filter((d) => !dirs.has(d));
  assert.equal(missing.length, 0, `pack-plan 里的目录在 repack/build 里不存在:${missing.join(', ')}`);
  const illegal = [...planned].filter((d) => d !== 'vscode' && !legal.has(d));
  assert.equal(illegal.length, 0,
    `pack-plan 里出现「模块×白名单目标」之外的目录:${illegal.join(', ')}(多半是白名单没更新或有旧构建残留)`);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
