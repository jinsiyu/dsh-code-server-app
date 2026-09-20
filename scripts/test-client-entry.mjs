// scripts/test-client-entry.mjs —— 客户端**手写入口**的守卫(0.3.58:客户端不再构建)
//
// 为什么需要它:以前 lib/client.js 是 esbuild 的产物,格式错误(用了 ESM 语法、require 了不存在
// 的模块、忘了包 wrapper)会被构建器当场拦下。现在它是**手写源码**,没有构建器兜底 —— 这三类
// 错误的后果都很重且很晚才暴露:
//   · 顶层 import/export/await → 经典脚本直接语法错误 ⇒ 整个客户端半部不加载(界面全空);
//   · require('./xxx.js') → DSH 模块表里没有它 ⇒ 运行时抛"未知模块";
//   · 与 host 共用的认领类型逻辑漂移 → 设置卡显示的规则和 host 实际执行的规则不一致(静默)。
//
// 守三件事:
//   E1 **结构**:wrapper 首尾、无顶层 ESM 语法、require 实参白名单、src/ 已消失、仓库里不再有
//      "构建 client" 的残留引用(历史 docs/ 除外)。
//   E2 **与 lib/claim-types.js 的一致性**:入口里内联了同一份逻辑(客户端拿不到 host 模块),
//      两份必须逐字等价 —— 用样例表比对 normalize / parse / claimsAddress / describe。
//   E3 **入口可用**:真加载一次(无钩子 ⇒ 没有 __internals;有钩子 ⇒ 有),apply/inject/name 形状正确。
//
// 用法:node scripts/test-client-entry.mjs
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CLIENT_ENTRY, loadClientBundle, pkgRoot } from './client-bundle-harness.mjs';
import {
  DEFAULT_CLAIM_EXTENSIONS,
  EXECUTABLE_EXTENSIONS,
  OFFICE_EXTENSIONS,
  PREVIEW_FRIENDLY_EXTENSIONS,
  claimsAddress,
  describeClaimPolicy,
  normalizeClaimExtensions,
  parseClaimPolicy,
} from '../lib/claim-types.js';

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

const source = readFileSync(CLIENT_ENTRY, 'utf8');
/**
 * 只保留"代码行":整行注释(//、*、/* 开头)剔掉。
 *
 * 为什么不用正则一次剥掉块注释:这个文件里有 96 个 `/*` 却只有 91 个 `*/` ——
 * 字符串字面量里也有 `/*`(CSS/正则样式的内容),粗糙的非贪婪替换会吞掉成片代码(实测过)。
 * 逐行过滤不会有这个问题,而且足够:注释里出现的 require('react') 都在整行注释里。
 */
function codeLines(text) {
  return text.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
}

// ---------------------------------------------------------------- E1 结构

await test('E1:入口是经典脚本 + loader 工厂包装(格式错了整个客户端半部都不加载)', () => {
  // 入口以一大段文档注释开头(手写源码,注释是给人看的),所以先剔掉整行注释再看代码首尾。
  const code = codeLines(source).join('\n').trim();
  assert.ok(
    code.startsWith("window.__ModuleLoader__.load({id:'dsh-code-server-app',factory:function(require){"),
    `入口代码必须以 loader 工厂包装开头,实际开头:${code.slice(0, 80)}`,
  );
  assert.ok(code.endsWith('return module.exports;}});'), `入口代码结尾应是 return module.exports;}});,实际:${code.slice(-40)}`);
  assert.equal(/^\s*(?:import|export)\s/m.test(code), false, '顶层不许出现 import/export(经典脚本里是语法错误)');
  assert.equal(/^await\s/m.test(code), false, '顶层不许出现 await(经典脚本里是语法错误)');
});

await test('E1:require 的实参只允许 react / react/jsx-runtime(DSH 冻结模块表)', () => {
  const code = codeLines(source).join('\n');
  const specifiers = [...code.matchAll(/\brequire\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
  assert.ok(specifiers.includes('react'), `入口必须 require('react')(实际:${JSON.stringify([...new Set(specifiers)])})`);
  const outside = [...new Set(specifiers)].filter((s) => s !== 'react' && s !== 'react/jsx-runtime');
  assert.deepEqual(outside, [], `这些 require 实参在 DSH 里解析不到(会抛"未知模块"):${outside.join(', ')}`);
  assert.equal(/require\.async\(/.test(code), false, '本插件不使用包内分块(client.*.js)');
});

await test('E1:src/ 已消失,仓库里不再有"构建 client"的残留引用(历史 docs/ 除外)', () => {
  assert.equal(existsSync(join(pkgRoot, 'src')), false, 'src/ 应当已被删除(入口就是唯一真源)');
  const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.exports['./client'], './lib/client.js', 'package.json 的 exports["./client"] 必须指向入口');
  assert.ok(pkg.files.includes('lib/client.js'), '入口必须随包发布');
  const buildRefs = /build:client|build-client\.mjs|src\/factory\.js|client\.banner|client\.footer/;
  const offenders = [];
  const check = (label, text) => {
    for (const [i, line] of text.split('\n').entries()) {
      if (buildRefs.test(line) && !/^\s*(\/\/|\*)/.test(line)) offenders.push(`${label}:${i + 1} ${line.trim().slice(0, 90)}`);
    }
  };
  check('package.json', JSON.stringify(pkg, null, 2));
  check('ci.yml', readFileSync(join(pkgRoot, '.github', 'workflows', 'ci.yml'), 'utf8'));
  check('release.yml', readFileSync(join(pkgRoot, '.github', 'workflows', 'release.yml'), 'utf8'));
  for (const name of readdirSync(join(pkgRoot, 'scripts'))) {
    if (!name.endsWith('.mjs') || name === 'test-client-entry.mjs') continue; // 守卫自己会提到这些字样
    check(`scripts/${name}`, readFileSync(join(pkgRoot, 'scripts', name), 'utf8'));
  }
  assert.deepEqual(offenders, [], `还有文件在引用已删除的构建步骤:\n  ${offenders.join('\n  ')}`);
});

// ---------------------------------------------------------------- E2 与 host 共享逻辑的一致性

await test('E2:内联的认领类型逻辑与 lib/claim-types.js 逐字等价(两份必须同步)', () => {
  const client = loadClientBundle({ testHooks: true }).internals;
  assert.ok(client !== null, '入口应当导出 __internals(测试钩子)');
  const samples = [
    '', '*', 'py;ts', 'py,ts  md', '.py .ts', '*.py;*.ts', 'abc;!md', '*;!md;!markdown',
    '  Py ;TS ', DEFAULT_CLAIM_EXTENSIONS, '!md', ';;;', 'a;b;c;!b', '!', 'UPPER', 'no-dot.ext',
  ];
  for (const sample of samples) {
    assert.equal(client.normalizeClaimExtensions(sample), normalizeClaimExtensions(sample), `normalize 不一致:${JSON.stringify(sample)}`);
    assert.equal(
      JSON.stringify(client.parseClaimPolicy(sample)),
      JSON.stringify(parseClaimPolicy(sample)),
      `parseClaimPolicy 不一致:${JSON.stringify(sample)}`,
    );
    assert.equal(client.describeClaimPolicy(sample), describeClaimPolicy(sample), `describeClaimPolicy 不一致:${JSON.stringify(sample)}`);
  }
  const addresses = [
    'dsh-resource://file/session/s/C:/work/repo/src/a.ts',
    'dsh-resource://file/session/s/C:/work/repo/notes.md',
    'dsh-resource://file/absolute/C:/work/repo/run.exe',
    'dsh-resource://file/session/s/C:/work/repo/Makefile',
  ];
  for (const address of addresses) {
    for (const policy of ['*', 'abc;!md', 'py;ts', '!ts']) {
      const parsed = client.parseFileAddress(address);
      assert.equal(
        client.claimsAddress(parsed, client.parseClaimPolicy(policy)),
        claimsAddress(parseFileAddressReference(address), parseClaimPolicy(policy)),
        `claimsAddress 不一致:${policy} × ${address}`,
      );
    }
  }
  assert.deepEqual(client.DEFAULT_CLAIM_EXTENSIONS, DEFAULT_CLAIM_EXTENSIONS, '默认默认值必须一致');
  assert.deepEqual(client.PREVIEW_FRIENDLY_EXTENSIONS, PREVIEW_FRIENDLY_EXTENSIONS);
  assert.deepEqual(client.EXECUTABLE_EXTENSIONS, EXECUTABLE_EXTENSIONS);
  assert.deepEqual(client.OFFICE_EXTENSIONS, OFFICE_EXTENSIONS);
});

/** host 侧的地址解析参照实现(仅本测试用):地址里 `session/<id>/<path>` 或 `absolute/<path>`。 */
function parseFileAddressReference(address) {
  const prefix = 'dsh-resource://file/';
  if (!address.startsWith(prefix)) return null;
  const rest = address.slice(prefix.length);
  if (rest.startsWith('session/')) {
    const tail = rest.slice('session/'.length);
    const slash = tail.indexOf('/');
    if (slash < 0) return null;
    return { sessionId: tail.slice(0, slash), path: tail.slice(slash + 1) };
  }
  if (rest.startsWith('absolute/')) return { sessionId: undefined, path: rest.slice('absolute/'.length) };
  return null;
}

// ---------------------------------------------------------------- E3 入口可用

await test('E3:入口可加载,导出 apply/inject/name;未开钩子时没有 __internals', () => {
  const plain = loadClientBundle({ declaredSlots: ['sidebar.right.pane.tab'] });
  assert.equal(typeof plain.exports.apply, 'function', 'apply 必须是函数');
  assert.equal(plain.exports.name, 'code-server');
  assert.deepEqual(plain.exports.inject, ['slots', 'settingsScope']);
  assert.equal(plain.internals, null, '没设 window.__dshcsTestHooks 时不许导出内部函数(生产路径零影响)');
  assert.equal(Object.prototype.hasOwnProperty.call(plain.exports, '__internals'), false);

  const hooked = loadClientBundle({ testHooks: true });
  assert.ok(hooked.internals !== null, '设了钩子才给内部函数');
  for (const name of ['pickWorkspaceCwd', 'requestFullscreenPanel', 'parseFileAddress', 'claimsAddress']) {
    assert.equal(typeof hooked.internals[name], 'function', `__internals.${name} 应当是函数`);
  }
});

console.log(`SUMMARY pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
