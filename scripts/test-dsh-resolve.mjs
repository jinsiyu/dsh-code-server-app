// scripts/test-dsh-resolve.mjs —— 部署位置表(lib/dsh-resolve.mjs)的单元测试
//
// 为什么要有:这张表决定"插件能不能拿到 DSH 自己那份 schemastery"(拿不到就直接抛错、插件没有
// 设置 schema)。它按**布局**铺开而不是按"本机碰巧有什么"写死 —— 0.3.48 的实测就是反例:
// release.yml 新加的 Linux 安装冒烟腿把 CLI 装到 `~/.npm-global`,而表里只有 `%APPDATA%\npm`
// 与 `$DSH_HOME/profiles/node_modules` ⇒ 整条链落空 ⇒ 冒烟 ④ 抛 "schemastery not found"。
// 本机永远不会碰到那种布局,所以只能靠"造一整套临时布局"来钉住每一种。
//
// 做法:把 HOME / APPDATA / DSH_HOME / NVM_DIR / PNPM_HOME 指到临时目录,按布局摆出假的
// `@deepseek-ai/dsh/package.json`(以及 cjs require 要用的 schemastery),逐个断言 dshEntry()
// 找到的是它;最后断言"一个都没有 → null"(不猜)与"多个都有 → 按表里的优先级取"。
//
// 用法:node scripts/test-dsh-resolve.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dshEntry, dshEntryCandidates, dshRequire } from '../lib/dsh-resolve.mjs';

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

const root = mkdtempSync(join(tmpdir(), 'dshcs-resolve-'));
const ENV_KEYS = ['HOME', 'USERPROFILE', 'APPDATA', 'DSH_HOME', 'NVM_DIR', 'PNPM_HOME'];
const savedEnv = {};
for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

/** 造一份"某个 node_modules 下有 DSH 部署"的假树,返回入口 package.json 的路径。 */
function plant(nodeModulesDir, version = '0.0.0-test') {
  const pkgDir = join(nodeModulesDir, '@deepseek-ai', 'dsh');
  mkdirSync(pkgDir, { recursive: true });
  const entry = join(pkgDir, 'package.json');
  writeFileSync(entry, JSON.stringify({ name: '@deepseek-ai/dsh', version, exports: { './package.json': './package.json' } }), 'utf8');
  return entry;
}

/** 只在指定的布局下跑一段断言(其余布局全部指向空临时目录,保证"没有别的副本在捣乱")。 */
function withLayout(layout, fn) {
  const empty = join(root, `empty-${Math.random().toString(36).slice(2)}`);
  mkdirSync(empty, { recursive: true });
  process.env.HOME = empty;
  process.env.USERPROFILE = empty;
  process.env.APPDATA = empty;
  process.env.DSH_HOME = empty;
  process.env.NVM_DIR = join(empty, 'nvm-none');
  process.env.PNPM_HOME = '';
  Object.assign(process.env, layout);
  try {
    return fn();
  } finally {
    for (const key of ENV_KEYS) if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
  }
}

await test('npm --prefix 用户级布局(~/.npm-global):Linux 冒烟腿的布局,0.3.48 就是缺它', async () => {
  const home = join(root, 'home-npm-global');
  const entry = plant(join(home, '.npm-global', 'lib', 'node_modules'));
  withLayout({ HOME: home, USERPROFILE: home, APPDATA: join(home, 'no-appdata') }, () => {
    assert.equal(dshEntry(), entry);
  });
});

await test('Windows 用户级 npm 全局布局(%APPDATA%\\npm)', async () => {
  const appData = join(root, 'appdata');
  const entry = plant(join(appData, 'npm', 'node_modules'));
  withLayout({ HOME: join(root, 'home-win'), USERPROFILE: join(root, 'home-win'), APPDATA: appData }, () => {
    assert.equal(dshEntry(), entry);
  });
});

await test('nvm 布局($NVM_DIR/versions/node/<ver>/lib/node_modules)', async () => {
  const nvm = join(root, 'nvm');
  const entry = plant(join(nvm, 'versions', 'node', 'v24.21.0', 'lib', 'node_modules'));
  withLayout({ NVM_DIR: nvm }, () => {
    assert.equal(dshEntry(), entry);
  });
});

await test('pnpm global 布局($PNPM_HOME/global/<大版本>/node_modules)', async () => {
  const pnpmHome = join(root, 'pnpm-home');
  const entry = plant(join(pnpmHome, 'global', '5', 'node_modules'));
  withLayout({ PNPM_HOME: pnpmHome }, () => {
    assert.equal(dshEntry(), entry);
  });
});

await test('$DSH_HOME 的 profile 层(profiles/node_modules 与 profiles/<名字>/node_modules)', async () => {
  const dshHomeA = join(root, 'dshhome-a');
  const entryA = plant(join(dshHomeA, 'profiles', 'node_modules'));
  withLayout({ DSH_HOME: dshHomeA }, () => assert.equal(dshEntry(), entryA));

  const dshHomeB = join(root, 'dshhome-b');
  const entryB = plant(join(dshHomeB, 'profiles', 'web', 'node_modules'));
  withLayout({ DSH_HOME: dshHomeB }, () => assert.equal(dshEntry(), entryB));
});

await test('优先级:Windows 用户级 npm 在 profile 层之前(本机行为不变)', async () => {
  const appData = join(root, 'appdata-order');
  const entryAppData = plant(join(appData, 'npm', 'node_modules'));
  const dshHome = join(root, 'dshhome-order');
  plant(join(dshHome, 'profiles', 'node_modules'));
  withLayout({ APPDATA: appData, DSH_HOME: dshHome }, () => {
    assert.equal(dshEntry(), entryAppData);
    const list = dshEntryCandidates();
    assert.ok(list.indexOf(entryAppData) < list.indexOf(join(dshHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')),
      '位置表的顺序才是语义:先找到谁用谁');
  });
});

await test('一个布局都没有 → null(不猜:宁可抛错也不指向半个部署)', async () => {
  withLayout({}, () => assert.equal(dshEntry(), null));
});

await test('dshRequire():从部署入口能 require 到它自己的依赖(schemastery 的真实用法)', async () => {
  const home = join(root, 'home-require');
  const nodeModules = join(home, '.npm-global', 'lib', 'node_modules');
  plant(nodeModules);
  const zDir = join(nodeModules, '@deepseek-ai', 'schemastery');
  mkdirSync(zDir, { recursive: true });
  writeFileSync(join(zDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/schemastery', version: '0.0.0-test', main: 'index.js' }), 'utf8');
  writeFileSync(join(zDir, 'index.js'), 'module.exports = { marker: "from-deployment" };\n', 'utf8');
  withLayout({ HOME: home, USERPROFILE: home }, () => {
    const req = dshRequire();
    assert.equal(typeof req, 'function', 'dshRequire() 应给出 require');
    assert.equal(req('@deepseek-ai/schemastery').marker, 'from-deployment');
  });
});

rmSync(root, { recursive: true, force: true });
console.log(`SUMMARY pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
