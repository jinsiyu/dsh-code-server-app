// scripts/test-plugin-apply.mjs —— host 插件的 apply 冒烟测试(桩 ctx)
//
// 为什么要有:lib/index.js 是 cordis 插件,`node --check` 只验语法,模块级 import 也照常通过 ——
// 漏了一个 import(或 start() 串行化包装写错)时,只有真跑一遍 apply 才会炸(0.3.x 线上就漏过
// `createAssetMirror is not defined`,整棵插件树加载失败)。
//
// 0.3.66 起还钉**设置数据面的两条线**(客户端半部的座位回归在 scripts/test-client-settings-seat.mjs):
//   · 旧线(rc 0.1.5-rc.x;**也含 0.1.6-alpha.2** —— 那一版座位已搬到插件页、数据面还是旧的):
//     `settings.register(ns, schema)` + `scope.get()/watch()`,注册的 schema **不能带 volatile**;
//   · 新线(alpha ≥ 0.1.7-alpha.1):`register/get/watch` 已删除,配置就是**本条目自己的 Config**
//     (可编辑字段必须 `.volatile()` = 解析期的活引用 `{get()}`),读值走 `config.<field>.get()`,
//     随动挂 `settings/document-updated`,并额外用可选的 `ctx.inject(['settings'])` 子级声明
//     `configure({ auto: false }, ctx.fiber)`(自带配置页的插件不让宿主按 schema 再生成一份表单)。
// 两条线的选择**按能力探测**,不比较版本号 —— 所以两条都要有用例。
//
// 用法:node scripts/test-plugin-apply.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CLAIM_EXTENSIONS } from '../lib/claim-types.js';

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

/** 解一份 schema 成**普通值**:alpha 线的 Config 字段是 volatile 活引用(`{get()}`),rc 线的
 *  schemastery 3.18.2 没有 volatile、字段就是普通值 —— 两种形状都要能被断言到。 */
function resolveSchema(schema, data) {
  const out = schema(data ?? {});
  const plain = {};
  for (const [key, value] of Object.entries(out)) {
    plain[key] = value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value;
  }
  return plain;
}

/** 桩 ctx:只实现 apply 真正会用到的部分(connection.fetch.register / settings),其余返回 undefined。
 *  settings 桩是 **rc 线(旧线)的形状**:有 register ⇒ apply 走"注册命名空间 + scope.watch"那条路。
 *  新线(没有 register、只有 volatile Config)由下面 `makeDualLineCtx` 的两个用例覆盖。 */
function makeStubCtx({ routes, logs }) {
  // 故意**不放** claimExtensions:用来验"设置文档里没有覆盖时,status 回落到 schema 默认值"。
  const settingsValue = { keepResident: true, serve: 'loopback', port: 0, host: '127.0.0.1' };
  return {
    get: (name) => {
      if (name === 'connection') {
        return { fetch: { register: (route) => { routes.set(route.path, route); return () => {}; } } };
      }
      if (name === 'settings') {
        return {
          register: (ns, schema) => ({
            get: () => resolveSchema(schema, settingsValue),
            watch: () => () => {},
          }),
          get: () => settingsValue,
        };
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

/**
 * 双线桩 ctx:`settings` 的形状决定 apply 走哪条线(有 register ⇒ 旧线,否则新线)。
 * @param options.settings settings 服务桩(新旧两种形状各由下面的工厂造)
 * @param options.config apply 的第二参数(新线里是 config.<field> = volatile 活引用)
 * @param options.events 记录 `ctx.on(事件, 处理函数)`(新线的随动挂在这里)
 * @param options.fiber ctx.fiber(configure 的 owner 参数要能对上)
 * @param options.injectedSettings 是否真的把 inject 回调跑起来(旧线没有 configure,跑起来也不该炸)
 */
function makeDualLineCtx({ routes, settings, config, events, fiber, injectedSettings = true }) {
  const logs = [];
  const child = {
    get: (name) => (name === 'settings' ? settings : undefined),
    effect: (fn) => { const out = fn(); return typeof out === 'function' ? out : () => {}; },
  };
  const ctx = {
    get: (name) => {
      if (name === 'connection') {
        return { fetch: { register: (route) => { routes.set(route.path, route); return () => {}; } } };
      }
      if (name === 'settings') return settings;
      return undefined;
    },
    inject: (deps, cb) => {
      logs.push(`inject(${JSON.stringify(deps)})`);
      if (injectedSettings && typeof cb === 'function' && deps.includes('settings')) cb(child);
      return () => {};
    },
    // 只真跑"配置页策略"那一条 effect:其余 effect 会去起桥监听口/预启动 IDE,冒烟里不需要。
    effect: (fn, label) => {
      if (typeof label === 'string' && label.includes('settings presentation')) {
        const out = fn();
        return typeof out === 'function' ? out : () => {};
      }
      return () => {};
    },
    provide: () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    log: () => {},
    on: (event, fn) => { events[event] = fn; return () => {}; },
    emit: () => {},
    fiber,
    get config() { return undefined; },
    use: () => {},
  };
  return { ctx, logs };
}

/** 复刻 loader 在新线给插件的 volatile 叶子:活引用,保存会**就地**换掉当前值(不重挂插件)。 */
function volatileLeaves(values) {
  const leaves = {};
  for (const [field, value] of Object.entries(values)) {
    let current = value;
    leaves[field] = { get: () => current, set: (next) => { current = next; } };
  }
  return leaves;
}

/** 一条临时数据目录(冒烟不该写用户真实的 <DSH_HOME>/code-server)。 */
function tempDirs() {
  const userDataDir = mkdtempSync(join(tmpdir(), 'dshcs-apply-'));
  return { userDataDir, extensionsDir: join(userDataDir, 'extensions') };
}

// ---------------------------------------------------------------- 冒烟(基线)

await test('apply():桩 ctx 下能跑通(回归:apply 期的 ReferenceError / 语法包装错误)', async () => {
  const plugin = await import('../lib/index.js');
  assert.equal(typeof plugin.apply, 'function', 'index.js 必须导出 apply');
  assert.match(String(plugin.Config ?? ''), /.+/, 'Config schema 应存在');

  const routes = new Map();
  const logs = [];
  const { userDataDir, extensionsDir } = tempDirs();
  await plugin.apply(makeStubCtx({ routes, logs }), {
    keepResident: true, claimExtensions: '*;!md', serve: 'loopback', port: 0, host: '127.0.0.1', userDataDir, extensionsDir,
  });

  assert.ok(routes.size > 0, `apply 应注册至少一条路由(实际 ${routes.size})`);
  assert.ok(routes.has('/api/code-server/status'), 'status 路由必须注册');
  assert.ok(routes.has('/api/code-server/start'), 'start 路由必须注册');
  assert.ok(routes.has('/api/code-server/stop'), 'stop 路由必须注册');
  // 0.2.9「打开即全屏」/ 0.2.11「认领类型」:默认值必须在 schema 里,且必须出现在 status 快照里
  // (客户端读 status.fullscreenOnOpen 决定是否切全屏,读 status.claimExtensions 决定认领哪些文件)。
  const resolved = resolveSchema(plugin.Config, {});
  assert.equal(resolved.fullscreenOnOpen, true, 'fullscreenOnOpen 默认应为 true');
  assert.equal(resolved.claimExtensions, DEFAULT_CLAIM_EXTENSIONS, 'claimExtensions 默认应为 claim-types 的默认清单');
  assert.equal(resolved.fileOpenScope, undefined, 'fileOpenScope(0.2.5~0.2.10 的认领范围)应已从 schema 移除');
  const statusPayload = await (await routes.get('/api/code-server/status').fetch()).json();
  assert.equal(statusPayload.fullscreenOnOpen, true, 'status 快照必须带 fullscreenOnOpen');
  assert.equal(statusPayload.claimExtensions, DEFAULT_CLAIM_EXTENSIONS, 'status 快照必须带 claimExtensions');
  assert.equal(statusPayload.fileOpenScope, undefined, 'status 快照不应再有 fileOpenScope');
  console.log(`     (注册路由 ${routes.size} 条)`);
  rmSync(userDataDir, { recursive: true, force: true });
});

await test('apply() 幂等性冒烟:再跑一次不抛错', async () => {
  const plugin = await import('../lib/index.js');
  const routes = new Map();
  const { userDataDir, extensionsDir } = tempDirs();
  await plugin.apply(makeStubCtx({ routes, logs: [] }), {
    keepResident: false, claimExtensions: 'py;ts', serve: 'loopback', port: 0, host: '127.0.0.1', userDataDir, extensionsDir,
  });
  assert.ok(routes.size > 0);
  rmSync(userDataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 两份 schema(字段表唯一真源 + volatile 分叉)

await test('两份 schema 字段一致;Config 按能力 volatile,SettingsSchema 永远不是活引用', async () => {
  const plugin = await import('../lib/index.js');
  // 与宿主的 SETTING_FIELDS 一一对应:少一个字段就等于"设置里少一项",多一个等于"宿主暴露了没人画的字段"。
  const FIELDS = ['serve', 'keepResident', 'claimExtensions', 'fullscreenOnOpen', 'editorBridge',
    'fim', 'fimDebounceMs', 'fimMultiline', 'fimDisableGlobs'];

  const entry = plugin.Config({});
  const legacy = plugin.SettingsSchema({});
  assert.deepEqual(Object.keys(entry).sort(), [...FIELDS].sort(), 'Config 的字段集必须与字段表一致');
  assert.deepEqual(Object.keys(legacy).sort(), [...FIELDS].sort(), 'SettingsSchema 必须与 Config 同字段');

  // 本机 schemastery 有没有 .volatile() 决定 Config 字段是活引用还是普通值;两种形状都要成立。
  // (装在特殊布局里解析不到时 hasVolatile 保持 null:只按"形状一致"断言,不猜能力。)
  let hasVolatile = null;
  try {
    const z = (await import('@deepseek-ai/schemastery')).default;
    hasVolatile = typeof z.boolean().volatile === 'function';
  } catch { /* 解析不到 ⇒ 留在 null 分支 */ }
  const isRef = (value) => value !== null && typeof value === 'object' && typeof value.get === 'function';
  const shapes = FIELDS.map((field) => (isRef(entry[field]) ? 'ref' : 'value'));
  assert.equal(new Set(shapes).size, 1,
    'Config 的字段形状必须一致:要么全是 volatile 活引用(schemastery 有 .volatile()),要么全是普通值');
  if (hasVolatile === true) assert.equal(shapes[0], 'ref', 'schemastery 支持 .volatile() 时 Config 字段必须是活引用');
  if (hasVolatile === false) assert.equal(shapes[0], 'value', 'schemastery 没有 .volatile() 时字段只能是普通值');
  for (const field of FIELDS) {
    assert.equal(isRef(legacy[field]), false,
      `SettingsSchema.${field} 不许是 volatile 活引用:旧的 settings 域会把它 JSON 成空对象,卡片读到空值`);
  }
  // 默认值两条线必须一致(旧线注册的是同一份字段定义)。
  assert.deepEqual(resolveSchema(plugin.Config, {}), resolveSchema(plugin.SettingsSchema, {}));
  const how = hasVolatile === null ? '能力未知(解析不到)' : hasVolatile ? '支持' : '不支持';
  console.log(`     (本机 schemastery ${how} volatile ⇒ Config 字段是${shapes[0] === 'ref' ? '活引用' : '普通值'})`);
});

// ---------------------------------------------------------------- 新线:volatile Config + document-updated

await test('新线(≥ 0.1.7-alpha.1):没有 register ⇒ 按 volatile 活叶子读值,随动挂 settings/document-updated', async () => {
  const plugin = await import('../lib/index.js');
  const routes = new Map();
  const events = {};
  const configureCalls = [];
  const fiber = { name: 'code-server-fiber' };
  const { userDataDir, extensionsDir } = tempDirs();
  const config = Object.assign(volatileLeaves({
    serve: 'loopback', keepResident: false, claimExtensions: 'py;ts', fullscreenOnOpen: false,
    editorBridge: true, fim: false, fimDebounceMs: 500, fimMultiline: false, fimDisableGlobs: '*.md',
  }), { userDataDir, extensionsDir });

  const { ctx, logs } = makeDualLineCtx({
    routes, config, events, fiber,
    settings: { configure: (presentation, owner) => { configureCalls.push({ presentation, owner }); return () => {}; } },
  });
  await plugin.apply(ctx, config);

  const read = async () => (await routes.get('/api/code-server/status').fetch()).json();
  const status = await read();
  assert.equal(status.claimExtensions, 'py;ts', '新线必须读 config.claimExtensions.get(),而不是 spread 后的活引用对象');
  assert.equal(status.keepResident, false, 'keepResident 也要走活叶子');
  assert.equal(status.fullscreenOnOpen, false, 'fullscreenOnOpen 也要走活叶子');
  assert.equal(status.bridge.enabled, true, 'editorBridge=true 的活叶子读出来应是 true');

  // 随动:保存(表单 mutate → profile patch → loader)只**就地**换叶子,不重挂插件
  // ⇒ 变更必须由 settings/document-updated 带进来。
  assert.equal(typeof events['settings/document-updated'], 'function',
    '新线必须订阅 settings/document-updated(没有 watch 可用)');
  config.claimExtensions.set('md');
  config.keepResident.set(true);
  config.editorBridge.set(false);
  events['settings/document-updated']();
  const after = await read();
  assert.equal(after.claimExtensions, 'md', '文档事件后应读到新的认领类型');
  assert.equal(after.keepResident, true, '文档事件后应读到新的常驻开关');
  assert.equal(after.bridge.enabled, false, 'editorBridge 翻成 false 后桥应立刻下线(与旧线 watch 的随动一致)');

  // 自带配置页的声明:让我们自己的表单成为唯一入口(策略不移除配置读写)。
  assert.equal(configureCalls.length, 1, '应恰好注册一次 configure({ auto: false })');
  assert.deepEqual(configureCalls[0].presentation, { auto: false }, '必须是 auto: false');
  assert.equal(configureCalls[0].owner, fiber, '策略要挂在本插件 fiber 上(迟加载/被替换的 Settings 服务也采用)');
  assert.ok(logs.some((line) => line === 'inject(["settings"])'), '声明必须走可选的 ctx.inject([...]) 子级');
  rmSync(userDataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 旧线:register + watch

await test('旧线(rc 0.1.5-rc.x / 0.1.6-alpha.2):有 register ⇒ 注册普通 schema,并订阅 scope.watch', async () => {
  const plugin = await import('../lib/index.js');
  const routes = new Map();
  const events = {};
  const registered = [];
  const watchers = [];
  const configureCalls = [];
  const { userDataDir, extensionsDir } = tempDirs();
  const doc = {
    serve: 'loopback', keepResident: true, claimExtensions: 'py;ts', fullscreenOnOpen: true,
    editorBridge: true, fim: false, fimDebounceMs: 250, fimMultiline: true, fimDisableGlobs: '',
  };
  const settings = {
    register: (ns, schema) => {
      registered.push({ ns, schema });
      return { get: () => resolveSchema(schema, doc), watch: (cb) => { watchers.push(cb); return () => {}; } };
    },
    get: () => doc,
    // 旧线没有 configure(它属于 0.1.7 起的 SettingsForms);故意不放,验证"没有也不炸"。
  };
  const ctx = makeDualLineCtx({ routes, events, settings, config: doc }).ctx;
  await plugin.apply(ctx, Object.assign({ userDataDir, extensionsDir }, doc));

  assert.equal(registered.length, 1, '旧线必须调 settings.register');
  assert.equal(registered[0].ns, 'code-server', '命名空间就是条目 id');
  const plain = registered[0].schema({});
  assert.equal(typeof plain.fim, 'boolean', '旧线注册的 schema 必须解出普通值(带 volatile 会 JSON 成空对象)');
  assert.equal(watchers.length, 1, '旧线必须订阅 scope.watch(设置改了要实时生效)');
  assert.deepEqual(configureCalls, [], '旧线没有 configure 能力,不该被调用');

  const read = async () => (await routes.get('/api/code-server/status').fetch()).json();
  const status = await read();
  assert.equal(status.claimExtensions, 'py;ts', '旧线应从 scope.get() 读到设置文档里的值(而不是行配置种子)');
  assert.equal(status.keepResident, true);

  watchers[0](Object.assign({}, doc, { claimExtensions: 'md', fullscreenOnOpen: false }));
  const after = await read();
  assert.equal(after.claimExtensions, 'md', 'watch 推来的新值要立刻生效');
  assert.equal(after.fullscreenOnOpen, false, 'watch 推来的其它字段同样生效');
  rmSync(userDataDir, { recursive: true, force: true });
});

console.log(`SUMMARY pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
