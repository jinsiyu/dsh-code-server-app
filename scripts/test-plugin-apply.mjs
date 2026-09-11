// scripts/test-plugin-apply.mjs —— host 插件的 apply 冒烟测试(桩 ctx)
//
// 为什么必须有:lib/index.js 是 cordis 插件,`node --check` 只验语法;模块级 import 也照常通过。
// 2026-09-11 就是这样漏的 —— 用了 createAssetMirror 却忘了 import,apply 一跑就
// ReferenceError,桌面端直接起不来(整棵插件树加载失败)。本测试用桩 ctx 真跑一遍 apply,
// 这类错误会被立刻抓住。
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

/** 桩 ctx:只实现 apply 真正会用到的部分,其余属性返回 undefined(并记录以便诊断)。 */
function makeStubCtx({ routes, registered, effects, logs }) {
  const settingsValue = {
    keepResident: true,
    fileOpenScope: 'session',
    serve: 'loopback',
    port: 0,
  };
  const context = {
    get: (name) => {
      if (name === 'connection') return { fetch: { register: (route) => { registered.push(route); if (routes !== undefined) routes.set(route.path, route); return () => {}; } } };
      if (name === 'settings') {
        return {
          resolve: () => settingsValue,
          get: () => settingsValue,
          onDidChange: () => ({ dispose() {} }),
        };
      }
      return undefined;
    },
    inject: (deps, callback) => {
      logs.push(`inject(${JSON.stringify(deps)})`);
      void callback; // webserver 之类可选依赖在桩里就是"不存在"
      return () => {};
    },
    effect: (fn) => { effects.push(fn); return () => {}; },
    provide: () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    log: () => {},
    on: () => () => {},
    emit: () => {},
    get config() { return undefined; },
    use: () => {},
  };
  return context;
}

await test('apply():桩 ctx 下能跑通(回归:apply 期的 ReferenceError)', async () => {
  const plugin = await import('../lib/index.js');
  assert.equal(typeof plugin.apply, 'function', 'index.js 必须导出 apply');
  assert.match(String(plugin.Config ?? ''), /.+/, 'Config schema 应存在');

  const registered = [];
  const effects = [];
  const logs = [];
  const ctx = makeStubCtx({ registered, effects, logs });

  // 桩环境里没有真的 DSH home / VS Code 树:这里只要求 apply 不抛 ReferenceError,
  // 真实的启动/环境检查失败会走插件自己的 try/catch(记录日志而不中断)。
  const config = {
    keepResident: true,
    fileOpenScope: 'session',
    serve: 'loopback',
    port: 0,
    host: '127.0.0.1',
    userDataDir: mkdtempSync(join(tmpdir(), 'dshcs-apply-')),
  };
  await plugin.apply(ctx, config);

  assert.ok(registered.length > 0, `apply 应注册至少一条路由(实际 ${registered.length})`);
  const paths = registered.map((r) => r.path);
  assert.ok(paths.includes('/api/code-server/status'), 'status 路由必须注册');
  assert.ok(paths.includes('/api/code-server/tunnel'), '阶段 1 隧道路由必须注册');
  assert.ok(paths.some((p) => p.startsWith('/api/code-server/asset/')), '阶段 2 资产镜像路由必须注册');
  const tunnel = registered.find((r) => r.path === '/api/code-server/tunnel');
  assert.equal(tunnel.requestBody, 'streaming', '隧道路由必须是 streaming 体');
  console.log(`     (注册路由 ${registered.length} 条,effect ${effects.length} 个)`);
  rmSync(config.userDataDir, { recursive: true, force: true });
});

await test('apply() 幂等性冒烟:再跑一次不抛错', async () => {
  const plugin = await import('../lib/index.js');
  const registered = [];
  const effects = [];
  const logs = [];
  const ctx = makeStubCtx({ registered, effects, logs });
  const config = {
    keepResident: false,
    fileOpenScope: 'all',
    serve: 'loopback',
    port: 0,
    host: '127.0.0.1',
    userDataDir: mkdtempSync(join(tmpdir(), 'dshcs-apply2-')),
  };
  await plugin.apply(ctx, config);
  assert.ok(registered.length > 0);
  rmSync(config.userDataDir, { recursive: true, force: true });
});

await test('launcherFlags()/resolveTransport():管道模式必须同时给 --exthost-ipc(§15 的假成功陷阱)', async () => {
  const plugin = await import('../lib/index.js');
  assert.equal(typeof plugin.launcherFlags, 'function', 'launcherFlags 必须导出(纯函数,便于测试)');
  assert.equal(plugin.resolveTransport('dsh'), 'pipe', 'dsh 模式固定走管道(launcher 挂 webServer)');

  const pipe = '\\\\.\\pipe\\dshcs-vscode-1234';
  assert.deepEqual(
    plugin.launcherFlags({ transport: 'pipe', pipe, host: '127.0.0.1', port: 8090 }),
    ['--pipe', pipe, '--exthost-ipc', `${pipe}-exthost`],
    'pipe 必须配对 --exthost-ipc:只给 pipe 会得到"IDE 起得来但扩展宿主连不上"的假成功',
  );
  assert.deepEqual(
    plugin.launcherFlags({ transport: 'tcp', pipe: null, host: '127.0.0.1', port: 8090, locale: 'zh-cn' }),
    ['--port', '8090', '--host', '127.0.0.1', '--locale', 'zh-cn'],
    'tcp 回退只给端口参数,不带 --exthost-ipc',
  );

  const before = process.env.DSHCS_TRANSPORT;
  process.env.DSHCS_TRANSPORT = 'tcp';
  assert.equal(plugin.resolveTransport('loopback'), 'tcp', 'DSHCS_TRANSPORT=tcp 是强制回退开关');
  if (before === undefined) delete process.env.DSHCS_TRANSPORT;
  else process.env.DSHCS_TRANSPORT = before;
});

console.log(`SUMMARY pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
