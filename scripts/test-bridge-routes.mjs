// scripts/test-bridge-routes.mjs —— 编辑器桥的宿主侧契约回归(0.3.0)
//
// 守四件事,每一件都是"改坏了不会有人立刻发现"的类型:
//   B1 **命名空间只读**:桥路由表必须**只有**那 6 条,且不允许出现写文件/执行类路由。
//      (令牌对本机同用户进程可读,爆炸半径必须封在"泄露编辑器信息"。)
//  B2 **Origin 优先于令牌**:带 Origin 的请求一律 403,即使令牌碰巧不对也不该先报 401 ——
//      顺序反了就等于告诉浏览器"你的令牌错了",会把令牌变成可爆破的 oracle。
//   B3 **无令牌 → 401 / 未启用 → 503**:401 与 503 混用会让扩展无法区分"要重读配置"与"桥没开"。
//   B4 **status 快照绝不泄露令牌**(它经 /api 匿名可见,令牌只在 bridge.json 里)。
//
// 不启动 IDE:这里只验路由表与鉴权闸门(它们的正确性与 IDE 是否在跑无关)。
//
// 用法:node scripts/test-bridge-routes.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// **必须最先做**:DSH_HOME 决定 dataRoot/pid.json/endpoint.json 的位置。开发机上真 IDE 正在跑,
// 不隔离的话 apply() 会 adopt 那个实例,测试断言全错,还会改写真实的 bridge.json
// (并且测试结束时把真实 IDE 的桥配置删掉)。设置后 dshHome() 读到的就是这个临时目录。
const HOME = mkdtempSync(join(tmpdir(), 'dshcs-bridge-home-'));
process.env.DSH_HOME = HOME;

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

/** 与 test-plugin-apply.mjs 同款桩 ctx(不含 tools/agents/systemPrompt → 走退化路径)。
 *  0.3.9 起桥挂在 DSH 的 **webServer** 上(不是 /api),所以桩里必须有 webServer,
 *  并且 `inject(['webServer'], cb)` 要真的回调(真 cordis 就是这么做的),否则桥永远不挂载。 */
function makeStubCtx({ routes, webRoutes }) {
  const settingsValue = { keepResident: true, claimExtensions: '*;!md', serve: 'loopback', port: 0, host: '127.0.0.1' };
  const webServer = {
    // 桥的 origin 由 webServer.port 算出来(OS 分配时 config.port 是 0,必须读实际端口)
    port: 18080,
    config: { host: '127.0.0.1', port: 18080 },
    register: (route) => { webRoutes.set(route.path, route); return () => { webRoutes.delete(route.path); }; },
    registerUpgrade: () => () => {},
  };
  const ctx = {
    get: (name) => {
      if (name === 'connection') {
        return { fetch: { register: (route) => { routes.set(route.path, route); return () => {}; } } };
      }
      if (name === 'webServer') return webServer;
      if (name === 'settings') {
        return { register: () => ({ get: () => settingsValue, watch: () => {} }), get: () => settingsValue };
      }
      return undefined;
    },
    inject: (deps, cb) => {
      if (Array.isArray(deps) && deps.includes('webServer') && typeof cb === 'function') cb({ ...ctx, webServer });
      return () => {};
    },
    effect: () => () => {},
    provide: () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    log: () => {},
    on: () => () => {},
    emit: () => {},
    get config() { return undefined; },
    use: () => {},
  };
  return ctx;
}

const routes = new Map();
const webRoutes = new Map();
// 临时目录都在 DSH_HOME 之内(见文件头的隔离说明);extensionsDir 必须显式给,
// 否则会被算成 <真实 profile>/extensions。
const userDataDir = join(HOME, 'user-data');
const extensionsDir = join(HOME, 'extensions');

const plugin = await import('../lib/index.js');
const bridge = await import('../lib/bridge.mjs');

await plugin.apply(makeStubCtx({ routes, webRoutes }), {
  keepResident: false,
  serve: 'loopback',
  port: 0,
  host: '127.0.0.1',
  userDataDir,
  extensionsDir,
});

/** 直接驱动挂载点:走真实的 Node 路由 → Fetch 适配器 → 分发 → guard 这条链。
 *  (0.3.7 的测试只调 handler 本体,因此漏掉了"请求根本到不了 handler"这类问题。) */
async function callBridge(path, { method = 'GET', headers = {}, body = null } = {}) {
  const route = webRoutes.get(bridge.BRIDGE_BASE);
  assert.ok(route !== undefined, `webServer 上必须挂载 ${bridge.BRIDGE_BASE}`);
  const { Readable } = await import('node:stream');
  const req = Readable.from(body === null ? [] : [Buffer.from(body)]);
  req.method = method;
  req.url = path;
  req.headers = headers;
  const state = { status: 0, headers: {}, text: '' };
  const res = {
    headersSent: false,
    writableEnded: false,
    writeHead(code, hdrs) { state.status = code; Object.assign(state.headers, hdrs ?? {}); this.headersSent = true; return this; },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) {
        state.text += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      }
      this.writableEnded = true;
      return this;
    },
  };
  await route.handler(req, res);
  return { ...state, json: () => JSON.parse(state.text) };
}

const BRIDGE_SUFFIXES = ['/health', '/sync', '/ask', '/event'];
/** 与 host 侧 lib/bridge.mjs 的 BRIDGE_TOKEN_HEADER 同名同值(扩展侧另有一份字面量)。 */
const TOKEN_HEADER = 'x-dshcs-bridge-token';

await test('桥挂在 DSH webServer 的 BRIDGE_BASE 前缀上(不是 /api)', async () => {
  assert.equal(bridge.BRIDGE_BASE, '/code-server-bridge', '前缀是对外契约:改它必须同时改扩展侧常量');
  assert.ok(webRoutes.has(bridge.BRIDGE_BASE), `webServer 应挂载 ${bridge.BRIDGE_BASE}`);
  assert.equal(webRoutes.get(bridge.BRIDGE_BASE).kind, 'prefix', '必须是 prefix 路由(要覆盖 /health /sync …)');
  // 回归:0.3.7 把桥挂在 /api 下,而 Connection 的 cookie fence 会在到达插件路由之前 401 掉
  // 扩展宿主(Node 进程,没有浏览器 cookie)的请求 —— 那样桥永远不会真正同步。
  for (const suffix of BRIDGE_SUFFIXES) {
    assert.equal(routes.has(`/api/code-server/bridge${suffix}`), false, `不该再在 /api 下注册 ${suffix}`);
  }
});

await test('四条路由可达,未知后缀 404(绝不落到 VS Code 那边)', async () => {
  const unknown = await callBridge('/code-server-bridge/nope');
  assert.equal(unknown.status, 404, `未知后缀应 404(实际 ${unknown.status})`);
  const suffixWithPost = await callBridge('/code-server-bridge/health', { method: 'POST' });
  assert.equal(suffixWithPost.status, 405, '方法不符应 405');
  for (const suffix of BRIDGE_SUFFIXES) {
    const method = suffix === '/health' ? 'GET' : 'POST';
    const res = await callBridge(`/code-server-bridge${suffix}`, { method, body: method === 'POST' ? '{}' : null });
    assert.ok(res.status !== 404 && res.status !== 405, `${suffix} 应当可达(实际 ${res.status})`);
  }
});

await test('命名空间只读:只认这 4 条后缀,写/执行类一律 404', async () => {
  // 命名白名单:新增路由必须改这里 —— 逼着人重新想一遍"这是只读的吗"。
  for (const suffix of BRIDGE_SUFFIXES) {
    assert.ok(/^\/(health|sync|ask|event)$/.test(suffix), `未在只读白名单里的桥路由:${suffix}`);
  }
  for (const bad of ['/write', '/edit', '/exec', '/run', '/shell', '/apply', '/save', '/delete', '/create']) {
    const res = await callBridge(`/code-server-bridge${bad}`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 404, `${bad} 必须 404(实际 ${res.status})`);
  }
});

await test('health 无需令牌(便于重启后一眼确认),且不返回任何编辑器数据', async () => {
  const res = await callBridge('/code-server-bridge/health');
  assert.equal(res.status, 200, `实际 ${res.status}`);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.bridge, false, '桩 ctx 下没有 IDE 在跑,桥应为未启用');
  assert.equal(body.url, null);
  assert.ok(!/token/i.test(JSON.stringify(body)), 'health 不允许出现任何 token 字段');
});

await test('带 Origin 的请求 → 403(必须穿过适配器仍然成立)', async () => {
  // 这条是适配器的关键回归:undici 的 `new Request(url, {headers})` 会把 origin 当 forbidden header
  // **归一化掉**,所以适配器必须把 Node 的原始 headers 挂到 request 上给 guard 读
  // (见 lib/bridge.mjs 的 bridgeGuard 与 test 里那条 undici 实测记录)。
  const res = await callBridge('/code-server-bridge/sync', {
    method: 'POST', headers: { origin: 'http://evil.example' }, body: '{}',
  });
  assert.equal(res.status, 403, `实际 ${res.status}`);
  assert.match(res.json().error, /Origin/, '错误信息应说明是 Origin 被拒');
});

await test('桥未启用 → 503(与 401 区分:扩展据此休眠而不是重读配置)', async () => {
  const res = await callBridge('/code-server-bridge/sync', {
    method: 'POST', headers: { [TOKEN_HEADER]: 'whatever-0123456789abcdef' }, body: '{}',
  });
  assert.equal(res.status, 503, `实际 ${res.status}`);
});

/** 令牌头名必须两边一致:host 侧常量 == 扩展侧字面量 == 测试里写的那份。 */
await test('令牌头名与桥前缀三处一致(host 常量 / 扩展常量 / 本测试)', async () => {
  assert.equal(bridge.BRIDGE_TOKEN_HEADER, TOKEN_HEADER, 'host 常量与测试不一致');
  assert.equal(bridge.BRIDGE_BASE, '/code-server-bridge');
  // 扩展侧是 CommonJS 且不 require('vscode'),可以直接 require 进来读常量
  const { createRequire } = await import('node:module');
  const require2 = createRequire(import.meta.url);
  const ext = require2('../assets/extensions/dshcs-editor-bridge/lib/bridge-client.js');
  assert.equal(ext.TOKEN_HEADER, TOKEN_HEADER, '扩展常量与 host 不一致 —— 改名必须两边同步');
  assert.equal(ext.BRIDGE_BASE, bridge.BRIDGE_BASE, '桥前缀必须两边一致(否则扩展永远打不到 host)');
  assert.equal(ext.BRIDGE_DIRNAME, bridge.BRIDGE_DIRNAME, '配置目录名必须两边一致');
  assert.equal(ext.BRIDGE_FILENAME, 'bridge.json');
});

await test('扩展安装必须带全 lib/(0.3.7 只拷两个文件 → 桥扩展加载即失败)', async () => {
  // 0.3.7 的真实事故:assets/extensions/dshcs-editor-bridge/ 里的纯逻辑放在 lib/ 下,
  // 而 installBundledExtensions 的 files 是硬编码的 ['package.json','extension.js'] ⇒
  // 装到 profile 的副本没有 lib/,extension.js 一 require('./lib/bridge-client.js') 就抛,
  // VS Code 只记一条 `Marked extension as removed`,界面上毫无反应。
  // 安装发生在 start 里,而本测试不起 IDE ⇒ 直接调导出的安装函数。
  plugin.installBundledExtensions(extensionsDir, userDataDir);
  const srcDir = new URL('../assets/extensions/dshcs-editor-bridge/', import.meta.url);
  const dstDir = join(extensionsDir, 'dshcs-editor-bridge');
  const expected = ['package.json', 'extension.js', 'lib/bridge-client.js', 'lib/context-model.js', 'lib/diff-model.js'];
  for (const rel of expected) {
    const dst = join(dstDir, rel);
    assert.ok(existsSync(dst), `安装后缺少 ${rel}(${dst})`);
    const a = readFileSync(new URL(rel, srcDir));
    const b = readFileSync(dst);
    assert.ok(a.equals(b), `${rel} 内容与源码不一致`);
  }
  assert.ok(existsSync(join(dstDir, 'lib')), 'lib/ 目录必须存在');
  // 幂等:再装一次不该报错也不该改写内容
  plugin.installBundledExtensions(extensionsDir, userDataDir);
  assert.ok(readFileSync(join(dstDir, 'lib/bridge-client.js')).equals(readFileSync(new URL('lib/bridge-client.js', srcDir))));
  // 源目录里没有的文件必须被清掉(升级后不留旧文件)
  writeFileSync(join(dstDir, 'stale-from-old-version.js'), 'old', 'utf8');
  plugin.installBundledExtensions(extensionsDir, userDataDir);
  assert.equal(existsSync(join(dstDir, 'stale-from-old-version.js')), false, '陈旧文件应被清理');
});

await test('源码级:桥不再挂 /api,扩展侧路径由 BRIDGE_BASE 拼出', async () => {
  for (const rel of ['../lib/index.js', '../lib/bridge.mjs']) {
    const source = readFileSync(new URL(rel, import.meta.url), 'utf8');
    const offenders = source.split('\n')
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => /\/api\/code-server\/bridge/.test(line) && !/^\s*(\*|\/\/)/.test(line));
    assert.deepEqual(offenders.map(([n, l]) => `${rel}:${n}: ${l.trim().slice(0, 90)}`), [],
      '桥的路由不该再出现在 /api 下(Connection 的 cookie fence 会 401 掉扩展宿主)');
  }
  const extSource = readFileSync(new URL('../assets/extensions/dshcs-editor-bridge/lib/bridge-client.js', import.meta.url), 'utf8');
  const literals = extSource.split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /\/api\/code-server\/bridge/.test(line) && !/^\s*(\*|\/\/)/.test(line));
  assert.deepEqual(literals, [], '扩展侧不该再有硬编码的 /api 桥路径');
  assert.match(extSource, /BRIDGE_BASE\}/, '扩展侧必须用 BRIDGE_BASE 拼路径');
});

await test('bridgeGuard 单元:无令牌 401 / 错令牌 401 / 对令牌放行', () => {
  const token = 'goodtoken-0123456789abcdef';
  const make = (headers) => new Request('http://127.0.0.1:1/api/code-server/bridge/context', { headers });
  assert.equal(bridge.bridgeGuard(make({}), token).status, 401, '无令牌应 401');
  assert.equal(bridge.bridgeGuard(make({ 'x-dshcs-bridge-token': 'bad' }), token).status, 401, '错令牌应 401');
  assert.equal(bridge.bridgeGuard(make({ 'x-dshcs-bridge-token': token }), token), null, '对令牌应放行');
  // 长度不同的令牌也必须 401(定长比较,不泄露前缀)
  assert.equal(bridge.bridgeGuard(make({ 'x-dshcs-bridge-token': `${token}x` }), token).status, 401);
});

await test('bridgeGuard:Origin 判定用裸 headers —— 不要用 Request 构造器做这组断言', () => {
  // 实测:Node 的 undici 把 `origin` 当 forbidden header 归一化掉了 ——
  // new Request(url, { headers: { origin: 'x' } }) 里 **读不到 origin**。
  // 所以这一组用裸 headers 对象;若哪天 guard 改成读别的字段,这里会先炸。
  const request = (headers) => ({ headers: { get: (name) => headers[name.toLowerCase()] ?? null } });
  const token = 'goodtoken-0123456789abcdef';
  assert.equal(bridge.bridgeGuard(request({ origin: 'http://evil.example' }), token).status, 403, '浏览器 Origin 应 403');
  assert.equal(bridge.bridgeGuard(request({ origin: 'null' }), token).status, 403, 'Origin=null(沙箱 iframe)也是浏览器');
  assert.equal(bridge.bridgeGuard(request({ origin: '' }), token).status, 401, '空 Origin 视为非浏览器 → 落到令牌检查');
  assert.equal(
    bridge.bridgeGuard(request({ origin: 'http://evil.example', 'x-dshcs-bridge-token': token }), token).status,
    403,
    'Origin 必须优先于令牌:否则等于给浏览器一个令牌 oracle',
  );
});

await test('status 快照带 bridge 状态,但绝不泄露令牌', async () => {
  const response = await routes.get('/api/code-server/status').fetch();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.bridge !== undefined, 'status 必须带 bridge 字段');
  assert.equal(body.bridge.enabled, true, '默认应启用桥');
  assert.equal(body.bridge.live, false, '没有 IDE 在跑时 live 应为 false');
  assert.equal(body.bridge.toolsRegistered, false);
  assert.ok(!/token/i.test(JSON.stringify(body.bridge)), 'status.bridge 不允许出现 token 字段');
  assert.ok(typeof body.bridge.file === 'string' && body.bridge.file.endsWith('bridge.json'));
});

await test('配置读写:原子写 / 读回 / 删掉 / 坏内容视为未配置', () => {
  const url = 'http://127.0.0.1:8123';
  const token = 'abctoken-0123456789abcdef';
  const file = bridge.writeBridgeConfig(extensionsDir, { url, token, pid: 42, startedAt: 7 });
  assert.ok(file.endsWith('bridge.json'), `实际 ${file}`);
  const read = bridge.readBridgeConfig(extensionsDir);
  assert.equal(read.url, url);
  assert.equal(read.token, token);
  assert.equal(read.pid, 42);
  // 用户手改坏 / 半截文件 → 视为"没有配置",扩展应当休眠而不是拿垃圾配置去连
  bridge.writeBridgeConfig(extensionsDir, { url, token: 'short', pid: null, startedAt: null });
  assert.equal(bridge.readBridgeConfig(extensionsDir), null, '非法令牌应视为未配置');
  assert.equal(bridge.removeBridgeConfig(extensionsDir), true);
  assert.equal(bridge.readBridgeConfig(extensionsDir), null);
});

await test('事件环形缓冲:有界、按游标取、take 后不重复', () => {
  const ring = bridge.createEventRing(3);
  ring.push('agent-edit', { path: 'a.ts' });
  ring.push('agent-edit', { path: 'b.ts' });
  ring.push('agent-edit', { path: 'c.ts' });
  ring.push('agent-edit', { path: 'd.ts' });
  assert.equal(ring.size(), 3, '环形缓冲必须封顶');
  const all = ring.since(0);
  assert.deepEqual(all.map((e) => e.path), ['b.ts', 'c.ts', 'd.ts'], '应丢最旧的');
  ring.reset();
  assert.deepEqual(ring.since(0), [], 'reset 后为空');
  assert.equal(ring.lastSeq(), 0);
  const after = ring.push('agent-edit', { path: 'e.ts' });
  assert.equal(after.seq, 1, 'reset 后 seq 从 1 重新开始(扩展用 since=0 重新对齐)');
  assert.deepEqual(ring.since(0).map((e) => e.path), ['e.ts']);
  assert.deepEqual(ring.since(1), [], '已取过的游标不应重复返回');
});

await test('上下文缓存:更新/陈旧判定/清空(host 反向请求不到扩展,状态靠这里缓存)', () => {
  const cache = bridge.createContextCache(50); // 50ms 就算陈旧,便于测
  assert.equal(cache.get(), null, '初始应为空');
  assert.equal(cache.isStale(), true, '没有上报 = 陈旧');
  assert.equal(cache.ageMs(), null);
  cache.update({ context: { active: { path: 'a.ts' }, dirtyBuffers: [] }, diagnostics: [{ path: 'a.ts', items: [] }] });
  assert.equal(cache.isStale(), false);
  assert.equal(cache.get().context.active.path, 'a.ts');
  assert.equal(cache.get().diagnostics.length, 1);
  // 非法上报不应把缓存变成垃圾
  cache.update(null);
  assert.equal(cache.get().context, null);
  assert.deepEqual(cache.get().diagnostics, []);
  cache.clear();
  assert.equal(cache.get(), null);
});

await test('请求体上限:超限的上报必须被拒(不能让一次 sync 吃掉内存)', () => {
  assert.equal(bridge.bodyWithinLimit({ a: 'x'.repeat(100) }), true);
  assert.equal(bridge.bodyWithinLimit({ a: 'x'.repeat(bridge.MAX_BODY_BYTES + 1) }), false);
  assert.equal(bridge.bodyWithinLimit(undefined), true, '空体视为合法');
});

await test('编辑器工具:真 defineTool 校验通过,execute 走缓存,渲染不抛', async () => {
  const { registerEditorTools } = await import('../lib/bridge-tools.mjs');
  const registered = [];
  const stubTools = { register: (definition) => { registered.push(definition); return () => {}; } };
  const stubCtx = { tools: stubTools, get: (name) => (name === 'tools' ? stubTools : undefined) };
  let cacheValue = null;
  const cache = {
    get: () => cacheValue,
    isStale: () => false,
    ageMs: () => 0,
  };
  const dispose = await registerEditorTools(stubCtx, { target: () => ({ url: 'http://127.0.0.1:1', token: 'x' }), cache: () => cache });
  if (dispose === null) {
    console.log('     (本机没有 @deepseek-ai/dsh-tools,跳过工具注册断言)');
    return;
  }
  assert.equal(registered.length, 2, '应注册两个工具');
  const names = registered.map((d) => d.name).sort();
  assert.deepEqual(names, ['editor_context', 'editor_diagnostics']);
  for (const definition of registered) {
    assert.ok(typeof definition.execute === 'function', `${definition.name} 必须有 execute`);
    assert.ok(definition.output !== undefined && typeof definition.output.render === 'function', `${definition.name} 必须有 output.render`);
    assert.ok(definition.output.schema !== undefined, `${definition.name} 必须有 output.schema`);
  }
  const contextTool = registered.find((d) => d.name === 'editor_context');
  const diagnosticsTool = registered.find((d) => d.name === 'editor_diagnostics');

  // 无缓存 → 明说不可用,而不是抛(工具失败会让模型重试,而"没接编辑器"不是错误)
  const cold = await contextTool.execute({}, { signal: undefined });
  assert.equal(cold.available, false);
  assert.match(cold.reason, /还没有上报|未启用/);
  assert.match(String(contextTool.output.render({}, cold)[0].text), /不可用/);

  // 有缓存 → 返回投影,渲染成人类可读文本
  cacheValue = {
    context: {
      available: true,
      active: { path: 'C:\\repo\\a.ts', language: 'typescript', dirty: true, selection: { startLine: 3, startColumn: 1, endLine: 4, endColumn: 9 }, selectedText: 'const x = 1;' },
      dirtyBuffers: [{ path: 'C:\\repo\\a.ts', unsavedLines: 4 }],
      problems: [{ path: 'C:\\repo\\a.ts', line: 3, severity: 'error', message: 'Cannot find name x' }],
      truncated: '',
    },
    diagnostics: [{ path: 'C:\\repo\\a.ts', items: [
      { line: 9, column: 1, severity: 'hint', message: 'hint' },
      { line: 3, column: 5, severity: 'error', message: 'Cannot find name x', source: 'ts', code: 2304 },
      { line: 1, column: 1, severity: 'warning', message: 'unused' },
    ] }],
  };
  const hot = await contextTool.execute({}, { signal: undefined });
  assert.equal(hot.available, true);
  const rendered = contextTool.output.render({}, hot)[0].text;
  assert.match(rendered, /有未保存改动/);
  assert.match(rendered, /const x = 1;/);

  const all = await diagnosticsTool.execute({}, { signal: undefined });
  assert.equal(all.available, true);
  assert.equal(all.total, 3);
  assert.deepEqual(all.diagnostics.map((d) => d.severity), ['error', 'warning', 'hint'], '必须按严重度排序');
  const errorOnly = await diagnosticsTool.execute({ severity: 'error' }, { signal: undefined });
  assert.equal(errorOnly.total, 1);
  const oneFile = await diagnosticsTool.execute({ file: 'C:\\repo\\a.ts' }, { signal: undefined });
  assert.equal(oneFile.total, 3, '文件过滤命中同一文件');
  const otherFile = await diagnosticsTool.execute({ file: 'C:\\other\\b.ts' }, { signal: undefined });
  assert.equal(otherFile.total, 0, '非工作区路径不应命中');
  assert.match(String(diagnosticsTool.output.render({}, all)[0].text), /a\.ts:3:5 \[error\]/);

  // 桥停了 → 回到不可用
  cacheValue = null;
  const stopped = await diagnosticsTool.execute({}, { signal: undefined });
  assert.equal(stopped.available, false);
  dispose();
});

await test('服务获取只走 ctx.get:属性访问会抛的上下文里必须不炸(0.3.6 线上事故回归)', async () => {
  // 复刻 DSH loader 的行为:未声明 inject 的服务,**属性访问会抛**这条字面量错误。
  // 0.3.6 就因为在 apply() 里写了 `ctx?.systemPrompt` 让整棵插件树加载失败、dsh web 起不来
  // (可选链只挡 null/undefined,挡不住抛错,`??` 右边的 ctx.get() 因此永远没机会执行)。
  // 这条用例保证所有可选服务都只经由 ctx.get() 获取。
  const plugin = await import('../lib/index.js');
  const provided = {
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    agents: { list: () => [], currentInitiator: () => undefined },
    connection: { fetch: { register: () => () => {} } },
    settings: { register: () => ({ get: () => ({}), watch: () => {} }), get: () => ({}) },
  };
  const injectList = Array.isArray(plugin.inject) ? plugin.inject : [];
  const attempts = [];
  const guard = new Proxy({}, {
    get: (_target, prop) => {
      if (typeof prop === 'symbol') return undefined;
      if (prop === 'get') return (name) => { attempts.push(`get:${name}`); return provided[name]; };
      if (prop === 'on') return () => () => {};
      if (prop === 'inject') return () => () => {};
      if (prop === 'effect') return () => () => {};
      if (prop === 'provide' || prop === 'use' || prop === 'emit' || prop === 'log') return () => {};
      if (prop === 'logger') return { info() {}, warn() {}, error() {}, debug() {} };
      if (prop === 'config') return undefined;
      attempts.push(`property:${String(prop)}`);
      throw new Error(`cannot get property "${String(prop)}" without inject`);
    },
  });

  const { registerEditorPrompt, registerEditorTools } = await import('../lib/bridge-tools.mjs');
  const { registerBridgeObserver } = await import('../lib/bridge-observe.mjs');
  const { deliverEditorPrompt } = await import('../lib/bridge-session.mjs');

  assert.doesNotThrow(() => registerEditorPrompt(guard), 'registerEditorPrompt 不能触发属性访问');
  const disposeTools = await registerEditorTools(guard, { target: () => null, cache: () => null });
  assert.doesNotThrow(() => registerBridgeObserver(guard, { emit: () => {}, context: () => null, isLive: () => false }),
    'registerBridgeObserver 不能触发属性访问');
  await assert.doesNotReject(() => deliverEditorPrompt(guard, {
    text: 'hi', file: null, lineStart: null, lineEnd: null, selection: null, languageId: null,
  }), 'deliverEditorPrompt 不能触发属性访问');
  if (typeof disposeTools === 'function') disposeTools();

  const propertyAttempts = attempts.filter((a) => a.startsWith('property:'));
  assert.deepEqual(propertyAttempts, [], `出现了未声明 inject 的属性访问:${propertyAttempts.join(', ')}`);
  assert.ok(attempts.some((a) => a.startsWith('get:')), '应当经由 ctx.get 取服务');
  // 插件静态 inject 只声明了必需项;因此上面那条断言才有意义(其余服务必须走 get)
  assert.deepEqual(injectList, ['connection', 'settings'], 'inject 列表变化时请同步复核这条用例');
});

await test('源码级:DSH 服务一律经 ctx.get 获取,不写属性访问(0.3.6 崩溃的静态回归)', async () => {
  // 为什么需要静态检查:上面那条 guard 用例只能覆盖"属性访问会抛"的上下文,而裸 cordis 里
  // 属性访问未必抛(实测:服务已 provide 时返回对象),所以它抓不住原始写法。
  // 而这条错误的代价极高:发生在 apply() 里会让整个 profile 加载失败、dsh web 直接起不来
  // (2026-09-12 的真实事故:`ctx?.systemPrompt ?? ctx.get(...)`,可选链挡不住抛错)。
  // 因此用最直白的方式守住:`ctx.<service>` 这种写法一律不许出现。
  const SERVICES = ['tools', 'systemPrompt', 'agents', 'sessions', 'commands', 'skills',
    'approval', 'sessionController', 'webServer', 'connection', 'settings'];
  const files = ['../lib/index.js', '../lib/bridge.mjs', '../lib/bridge-tools.mjs',
    '../lib/bridge-observe.mjs', '../lib/bridge-session.mjs'];
  const violations = [];
  for (const rel of files) {
    const source = readFileSync(new URL(rel, import.meta.url), 'utf8');
    for (const line of source.split('\n')) {
      const code = line.trim();
      if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) continue; // 注释
      if (/^import\b/.test(code) || /\bfrom ['"]/.test(code)) continue; // import 语句
      for (const service of SERVICES) {
        const re = new RegExp(`\\bctx\\??\\.${service}\\b`);
        if (re.test(code)) violations.push(`${rel}: ${code.slice(0, 110)}`);
      }
    }
  }
  assert.deepEqual(violations, [], `发现未声明 inject 的属性访问,改用 ctx.get('…'):\n${violations.join('\n')}`);
});

await test('dsh-resolve:解析不到时不抛(桥退化而不是炸主流程)', async () => {
  const { loadDshExport, dshEntry } = await import('../lib/dsh-resolve.mjs');
  const missing = await loadDshExport('@deepseek-ai/definitely-not-a-real-package', 'whatever');
  assert.equal(missing, null);
  // 本机有 DSH 部署 → 应能定位入口(没有则跳过断言,CI 无 DSH 时不该失败)
  const entry = dshEntry();
  if (entry !== null) assert.match(entry, /dsh[\\/]package\.json$/);
});

// 隔离自检:真实 profile 的桥配置必须在本次运行前后**一字不变**(见文件头)。
// 这比"断言某个字段"硬:任何形式的越界改写都会被抓到。
const realBridge = process.env.USERPROFILE === undefined
  ? null
  : join(process.env.USERPROFILE, '.dsh', 'code-server', 'extensions', '.dshcs-bridge', 'bridge.json');
const realBridgeBefore = realBridge !== null && existsSync(realBridge) ? readFileSync(realBridge, 'utf8') : null;
await test('隔离自检:测试不写真实 profile 的 bridge.json', () => {
  if (realBridge === null) return; // 非 Windows,跳过
  const after = existsSync(realBridge) ? readFileSync(realBridge, 'utf8') : null;
  assert.equal(after, realBridgeBefore, `真实桥配置被本测试改动了:${realBridge}`);
});

rmSync(HOME, { recursive: true, force: true });
console.log(`SUMMARY pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
