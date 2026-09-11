// scripts/test-plugin-apply.mjs —— host 插件的 apply 冒烟测试(桩 ctx)
//
// 为什么要有:lib/index.js 是 cordis 插件,`node --check` 只验语法,模块级 import 也照常通过 ——
// 漏了一个 import(或 start() 串行化包装写错)时,只有真跑一遍 apply 才会炸(0.3.x 线上就漏过
// `createAssetMirror is not defined`,整棵插件树加载失败)。
//
// 用法:node scripts/test-plugin-apply.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await Promise.race([fn(), new Promise((_r, rej) => setTimeout(() => rej(new Error('timeout 20s')), 20000))]);
    pass += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`FAIL ${name}: ${error && error.message ? error.message : error}`);
  }
}

/** 桩 ctx:只实现 apply 真正会用到的部分(connection.fetch.register / settings),其余返回 undefined。 */
function makeStubCtx({ routes, logs }) {
  const settingsValue = { keepResident: true, fileOpenScope: 'session', serve: 'loopback', port: 0, host: '127.0.0.1' };
  return {
    get: (name) => {
      if (name === 'connection') {
        return { fetch: { register: (route) => { routes.set(route.path, route); return () => {}; } } };
      }
      if (name === 'settings') {
        return { resolve: () => settingsValue, get: () => settingsValue, onDidChange: () => ({ dispose() {} }) };
      }
      return undefined;
    },
    inject: (deps) => { logs.push(`inject(${JSON.stringify(deps)})`); return () => {}; },
    effect: () => () => {},
    provide: () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    log: () => {},
    on: () => () => {},
    emit: () => {},
    get config() { return undefined; },
    use: () => {},
  };
}

await test('apply():桩 ctx 下能跑通(回归:apply 期的 ReferenceError / 语法包装错误)', async () => {
  const plugin = await import('../lib/index.js');
  assert.equal(typeof plugin.apply, 'function', 'index.js 必须导出 apply');
  assert.match(String(plugin.Config ?? ''), /.+/, 'Config schema 应存在');

  const routes = new Map();
  const logs = [];
  const userDataDir = mkdtempSync(join(tmpdir(), 'dshcs-apply-'));
  await plugin.apply(makeStubCtx({ routes, logs }), {
    keepResident: true, fileOpenScope: 'session', serve: 'loopback', port: 0, host: '127.0.0.1', userDataDir,
  });

  assert.ok(routes.size > 0, `apply 应注册至少一条路由(实际 ${routes.size})`);
  assert.ok(routes.has('/api/code-server/status'), 'status 路由必须注册');
  assert.ok(routes.has('/api/code-server/start'), 'start 路由必须注册');
  assert.ok(routes.has('/api/code-server/stop'), 'stop 路由必须注册');
  // 0.2.9「打开即全屏」:设置默认值必须在 schema 里,且必须出现在 status 快照里
  // (客户端读 status.fullscreenOnOpen 决定打开标签时是否切全屏)。
  const resolved = plugin.Config({});
  assert.equal(resolved.fullscreenOnOpen, true, 'fullscreenOnOpen 默认应为 true');
  const statusPayload = await (await routes.get('/api/code-server/status').fetch()).json();
  assert.equal(statusPayload.fullscreenOnOpen, true, 'status 快照必须带 fullscreenOnOpen');
  console.log(`     (注册路由 ${routes.size} 条)`);
  rmSync(userDataDir, { recursive: true, force: true });
});

await test('apply() 幂等性冒烟:再跑一次不抛错', async () => {
  const plugin = await import('../lib/index.js');
  const routes = new Map();
  const userDataDir = mkdtempSync(join(tmpdir(), 'dshcs-apply2-'));
  await plugin.apply(makeStubCtx({ routes, logs: [] }), {
    keepResident: false, fileOpenScope: 'all', serve: 'loopback', port: 0, host: '127.0.0.1', userDataDir,
  });
  assert.ok(routes.size > 0);
  rmSync(userDataDir, { recursive: true, force: true });
});

console.log(`SUMMARY pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
