// scripts/test-vendored-table.mjs —— 「重打包表 ↔ 插件依赖表」一致性测试(0.3.45 起的原生包模型)
//
// 为什么要有:0.3.45 弃用了「平台聚合包 + npm: 别名」—— 那套依赖 pnpm 在**可选子树**里正确处理别名,
// 而 `pnpm add` 的增量 hoisted 安装会漏链其中 9 个,dsh-desktop 安装后立刻校验 ⇒ 首次安装必报
// requires missing(见 docs/desktop-first-install-root-cause.md)。新模型要求:
//   · 平台无关的重打包包 → 插件 dependencies(真名);
//   · 平台专属的重打包包 → 插件 optionalDependencies(真名 + 包自带 os/cpu,每目标一份);
//   · 依赖表里**不允许出现任何 npm: 别名**,也不允许再引用平台聚合包;
//   · 原始名字(调用方 import 的名字)只由 lib/vendored.json + 运行时 junction 提供。
// 这一层错了不会立刻报错(装得上、跑不起来),所以钉死。
//
// 用法:node scripts/test-vendored-table.mjs
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readVendoredTable, vendoredEntries, vendoredPackageName } from '../lib/native.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
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

await test('平台专属的重打包包按目标写在 optionalDependencies(精确版本)', async () => {
  assert.ok(specific.length > 0, '应至少有一个平台专属重打包包');
  for (const target of table.targets) {
    for (const m of specific) {
      const name = `${m.package}-${target}`;
      assert.equal(optional[name], m.version, `${name} 应在 optionalDependencies 且为 ${m.version},实际 ${optional[name]}`);
    }
  }
  assert.equal(Object.keys(optional).length, specific.length * table.targets.length,
    'optionalDependencies 应恰好是「平台专属包 × 目标数」,不允许多余项');
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
  if (typeof pinned === 'string') assert.equal(deps[tree[0]], pinned, `${tree[0]} 应钉 ${pinned}`);
});

await test('发布清单 files 带上 lib/vendored.json(否则装完读不到表)', async () => {
  assert.ok(Array.isArray(pluginPkg.files) && pluginPkg.files.includes('lib/vendored.json'),
    `files 里缺 lib/vendored.json:${JSON.stringify(pluginPkg.files)}`);
  assert.ok(pluginPkg.files.includes('lib/native.js'), 'files 里缺 lib/native.js');
});

await test('运行时表:vendoredEntries() 与 vendored.json 一致且按平台拼后缀', async () => {
  const host = vendoredEntries();
  assert.equal(host.length, table.modules.length, '条目数应与表一致');
  for (const m of table.modules) {
    const hit = host.find((e) => e.alias === m.alias);
    assert.ok(hit !== undefined, `运行时表缺 ${m.alias}`);
    assert.equal(hit.packageName, m.platform === true ? `${m.package}-${process.platform}-${process.arch}` : m.package,
      `${m.alias} 的真包名不对:${hit.packageName}`);
  }
  // 换平台只改后缀,基名不动
  const foreign = vendoredEntries('linux', 'x64').find((e) => e.alias === specific[0].alias);
  assert.equal(foreign.packageName, `${specific[0].package}-linux-x64`, '跨平台拼名不对');
});

await test('readVendoredTable() 读得到 scope 与 targets', async () => {
  const live = readVendoredTable();
  assert.equal(live.scope, table.scope);
  assert.deepEqual(live.targets, table.targets);
  assert.equal(live.modules.length, table.modules.length);
  assert.equal(vendoredPackageName({ package: '@x/y', platform: false }), '@x/y');
  assert.equal(vendoredPackageName({ package: '@x/y', platform: true }, 'win32', 'arm64'), '@x/y-win32-arm64');
});

await test('repack/build 里的重打包目录与表一一对应(构建产物存在时)', async () => {
  const buildRoot = join(root, 'repack', 'build');
  if (!existsSync(buildRoot)) return; // 没编过原生包(全新克隆)→ 跳过
  const flat = (name) => name.replace(/^@/u, '').replaceAll('/', '-');
  const dirs = new Set(readdirSync(buildRoot));
  const expected = new Set();
  for (const m of independent) expected.add(flat(m.alias));
  for (const target of table.targets) for (const m of specific) expected.add(`${flat(m.alias)}-${target}`);
  const missing = [...expected].filter((d) => !dirs.has(d));
  assert.equal(missing.length, 0, `repack/build 缺目录:${missing.join(', ')}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
