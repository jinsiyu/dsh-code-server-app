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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

// **必须最先做**:DSH_HOME 决定 dataRoot/pid.json/endpoint.json 的位置。开发机上真 IDE 正在跑,
// 不隔离的话 apply() 会 adopt 那个实例,测试断言全错,还会改写真实的 bridge.json
// (并且测试结束时把真实 IDE 的桥配置删掉)。设置后 dshHome() 读到的就是这个临时目录。
const HOME = mkdtempSync(join(tmpdir(), 'dshcs-bridge-home-'));
process.env.DSH_HOME = HOME;

let pass = 0;
let fail = 0;
/** 每条用例都得有超时:挂住时的症状是"什么都没输出 + exit 13(unsettled top-level await)",
 *  连哪条用例挂都看不出来 —— 本机沙箱把 IPC 相关用例全 EPERM-SKIP 掉了,所以这种形态只在
 *  真实机器上暴露(2026-09-16 ubuntu runner 上就是这个 exit 13)。与 test-plugin-apply.mjs 同款。 */
const TEST_TIMEOUT_MS = 20_000;
async function test(name, fn) {
  let timer = null;
  try {
    await Promise.race([
      fn(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timeout ${TEST_TIMEOUT_MS / 1000}s(用例挂住:看它内部哪一步没返回)`)),
          TEST_TIMEOUT_MS,
        );
      }),
    ]);
    pass += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`FAIL ${name}: ${error && error.message ? error.message : error}`);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** 与 test-plugin-apply.mjs 同款桩 ctx(不含 tools/agents/systemPrompt → 走退化路径)。
 *  0.3.13 起桥**不再依赖 webServer**:传输是本机 IPC(命名管道 / unix socket),
 *  由 apply() 里的 `ctx.effect` 起监听口 —— 所以桩的 `effect` 必须真的执行回调
 *  (真 cordis 就是这么做的),否则桥端点在测试里永远不会起来。 */
function makeStubCtx({ routes, webRoutes }) {
  const settingsValue = { keepResident: true, claimExtensions: '*;!md', serve: 'loopback', port: 0, host: '127.0.0.1' };
  const effects = [];
  const webServer = {
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
    effect: (fn) => {
      const dispose = fn();
      effects.push(typeof dispose === 'function' ? dispose : () => {});
      return () => {};
    },
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
const bridgeIpc = await import('../lib/bridge-ipc.mjs');

const stubCtx = makeStubCtx({ routes, webRoutes });
await plugin.apply(stubCtx, {
  keepResident: false,
  serve: 'loopback',
  port: 0,
  host: '127.0.0.1',
  userDataDir,
  extensionsDir,
});

/** 驱动 /status 这条普通 /api 路由,拿到桥的真实状态(端点、是否 supported)。
 *  用真 handler:顺便验证 status 不再泄露令牌。 */
async function bridgeStatus() {
  const route = routes.get('/api/code-server/status');
  assert.ok(route !== undefined, '/api/code-server/status 必须注册');
  const response = await route.fetch(new Request('http://127.0.0.1/api/code-server/status'));
  return (await response.json()).bridge;
}

/** 等桥的本机 IPC 监听口起来(apply 里是异步起的)。 */
async function waitForEndpoint(timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await bridgeStatus();
    if (status.endpoint !== null && status.supported === true) return status;
    if (Date.now() > deadline) return status;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** 驱动桥请求。**两条路,任一条通就真跑**(0.3.64):
 *  ① 真实传输:本机 IPC(命名管道 / unix socket)→ 真实 Node 路由 → Fetch 适配器 → 分发 → guard,
 *     0.3.13 起这就是扩展走的那条路;
 *  ② 进程内分发:host 侧钩子 lib/index.js 的 `bridgeRequestForTests` —— 同一条 dispatchBridge、
 *     同样把 body 收成 Buffer、同样把 Response 摊平,**缺的只有 socket 本身**。
 *
 *  为什么必须有②(2026-09-22 的教训):沙箱下**连接**命名管道会 EPERM(监听是允许的,这是本机
 *  沙箱边界,不是代码问题),于是本文件所有走 IPC 的用例在本机一律 SKIP —— "本地 pass=30" 里
 *  **不含**桥的状态码断言,0.3.63 的 `/complete` 403 就是这么在本地假绿、推到 runner 才红的。
 *  传输可以是本机的,断言不能是本机的。 */
let ipcUnreachable = null;
/** 实际用到的那条传输(打给 SUMMARY 上面那行看,避免"到底验没验"再靠猜)。 */
let transport = null;

/** 进程内分发(钩子缺失时返回 unreachable,由调用方判失败 —— 本文件不再接受"跳过")。 */
async function inprocRequest(path, method, headers, payload) {
  const hook = plugin.bridgeRequestForTests;
  if (typeof hook !== 'function') {
    return { status: 0, headers: {}, text: '', json: () => null, unreachable: 'host 没有 bridgeRequestForTests 钩子' };
  }
  const res = await hook({ path, method, headers, body: payload === null ? '' : payload });
  return { status: res.status, headers: res.headers, text: res.text, json: () => JSON.parse(res.text), unreachable: null };
}

/** ① 真实 IPC 传输。EPERM 时返回 unreachable(由 callBridge 回落到②)。 */
async function ipcRequest(endpoint, path, method, headers, payload) {
  try {
    return await new Promise((resolve, reject) => {
      const req = http.request({
        socketPath: endpoint,
        path,
        method,
        headers: payload === null ? headers : Object.assign({ 'content-length': String(payload.length) }, headers),
        timeout: 3000,
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text), unreachable: null });
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      if (payload !== null) req.write(payload);
      req.end();
    });
  } catch (error) {
    if (error && error.code === 'EPERM') {
      ipcUnreachable = 'EPERM(沙箱不允许连接命名管道)';
      return { status: 0, headers: {}, text: '', json: () => null, unreachable: ipcUnreachable };
    }
    throw error;
  }
}

async function callBridge(path, { method = 'GET', headers = {}, body = null } = {}) {
  const endpoint = (await waitForEndpoint()).endpoint;
  const payload = body === null ? null : Buffer.from(body, 'utf8');
  if (endpoint !== null && ipcUnreachable === null) {
    const res = await ipcRequest(endpoint, path, method, headers, payload);
    if (res.unreachable === null) {
      transport ??= 'ipc';
      return { ...res, via: 'ipc' };
    }
    console.log(`提示:本机 IPC 不可达(${res.unreachable})⇒ 桥请求改走**进程内分发**`
      + '(同一条 dispatchBridge,缺的只有 socket);下面的断言照跑,不再 SKIP');
  }
  const res = await inprocRequest(path, method, headers, payload);
  if (res.unreachable === null) transport ??= 'inproc';
  return { ...res, via: res.unreachable === null ? 'inproc' : null };
}

/** 传输类用例的统一入口。**这里不再有"跳过"**:两条传输都拿不到 = 断言根本没跑,不算绿 ——
 *  这正是 0.3.63 "本地假绿"的根治点(以前这里返回 true 让整条用例 SKIP,本机 7 条全被跳掉)。 */
function requireReachable(result, name) {
  const reason = result !== undefined && result.unreachable !== null && result.unreachable !== undefined
    ? result.unreachable
    : null;
  assert.equal(reason, null,
    `${name}:桥请求没有任何可用传输(${reason})—— 断言没跑,不算通过`
    + '(真实 IPC 与进程内分发都不可用时才会走到这里,见 callBridge)');
}

const BRIDGE_SUFFIXES = ['/health', '/sync', '/old', '/event', '/complete'];
/** 每个后缀的方法(GET 的必须是纯读;/old 只是读快照缓存,不消费、不写)。
 *  `/complete`(0.3.61)是**唯一的例外**:它会发起一次模型调用(实验性 FIM 补全),
 *  但仍然不写文件、不执行命令 —— 它的额外约束在下面的专项测试里钉住。 */
const BRIDGE_METHODS = { '/health': 'GET', '/sync': 'POST', '/old': 'GET', '/event': 'POST', '/complete': 'POST' };
/** 与 host 侧 lib/bridge.mjs 的 BRIDGE_TOKEN_HEADER 同名同值(扩展侧另有一份字面量)。 */
const TOKEN_HEADER = 'x-dshcs-bridge-token';

await test('桥走本机 IPC(命名管道 / unix socket),既不在 /api 下、也不依赖 webServer', async () => {
  assert.equal(bridge.BRIDGE_BASE, '/code-server-bridge', '前缀是对外契约:改它必须同时改扩展侧常量');
  const status = await waitForEndpoint();
  assert.equal(status.supported, true, '桥端点应就绪(desktop 与 web 同一套传输)');
  assert.ok(bridgeIpc.isBridgeEndpoint(status.endpoint), `端点必须是本机 IPC 路径:${status.endpoint}`);
  // 回归一:0.3.7 把桥挂在 /api 下,Connection 的 cookie fence 会在到达插件路由之前 401 掉
  // 扩展宿主(Node 进程,没有浏览器 cookie)的请求 —— 那样桥永远不会真正同步。
  for (const suffix of BRIDGE_SUFFIXES) {
    assert.equal(routes.has(`/api/code-server/bridge${suffix}`), false, `不该再在 /api 下注册 ${suffix}`);
  }
  // 回归二:0.3.9–0.3.12 挂在 DSH 的 webServer 前缀上,而 desktop 没有 webServer ⇒ 桥在桌面端永远休眠。
  assert.equal(webRoutes.has(bridge.BRIDGE_BASE), false, '桥不该再挂到 webServer 上(desktop 没有它)');
});

await test('所有桥路由都可达,未知后缀 404(绝不落到 VS Code 那边)', async () => {
  const unknown = await callBridge('/code-server-bridge/nope');
  requireReachable(unknown, '路由可达');
  assert.equal(unknown.status, 404, `未知后缀应 404(实际 ${unknown.status})`);
  const suffixWithPost = await callBridge('/code-server-bridge/health', { method: 'POST' });
  assert.equal(suffixWithPost.status, 405, '方法不符应 405');
  const readOnlyWithPost = await callBridge('/code-server-bridge/old', { method: 'POST' });
  assert.equal(readOnlyWithPost.status, 405, '/old 是 GET(方法不符应 405)');
  for (const suffix of BRIDGE_SUFFIXES) {
    const method = BRIDGE_METHODS[suffix];
    const res = await callBridge(`/code-server-bridge${suffix}`, { method, body: method === 'POST' ? '{}' : null });
    assert.ok(res.status !== 404 && res.status !== 405, `${suffix} 应当可达(实际 ${res.status})`);
  }
});

await test('/old:只读、不消费、key 缺失 400、未启用 503(与 /sync 同口径)', async () => {
  // 0.3.55:事件里只带不透明 key,写前原文走这条路由取。它是纯读的 —— 取不到(过期/淘汰/重启)
  // 返回 404,扩展据此回退到缓冲区,不重试。
  const noKey = await callBridge('/code-server-bridge/old');
  requireReachable(noKey, '/old');
  assert.equal(noKey.status, 503, '桩 ctx 下桥未启用 ⇒ 503(与 /sync 同口径,不是 404)');
  const withKey = await callBridge('/code-server-bridge/old?key=whatever');
  assert.equal(withKey.status, 503, '鉴权/启用判定先于 key 解析');
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  assert.match(source, /snapshotResponse\(bridgeSnapshots, key\)/, '/old 只能读快照缓存(纯逻辑在 lib/edit-snapshot.mjs)');
  assert.equal(/bridgeSnapshots\.(take|delete|reset)\(/.test(source), false, '快照不能被这条路消费掉(重复轮询要拿到同一份)');
  // 响应语义(400/404/200)由 lib/edit-snapshot.mjs 的 snapshotResponse 承担,单测在 test-edit-snapshot.mjs
});

await test('命名空间白名单:四条只读 + 一条有界的模型调用(/complete);写/执行类一律 404', async () => {
  // 命名白名单:新增路由必须改这里 —— 逼着人重新想一遍"这是只读的吗"。
  // 0.3.61 起白名单多了 /complete:它是唯一会**发起模型调用**的路由(实验性 FIM 补全),
  // 但它不写文件、不执行命令,且默认关(没开一律 403)。
  for (const suffix of BRIDGE_SUFFIXES) {
    assert.ok(/^\/(health|sync|old|event|complete)$/.test(suffix), `未在白名单里的桥路由:${suffix}`);
  }
  for (const bad of ['/write', '/edit', '/exec', '/run', '/shell', '/apply', '/save', '/delete', '/create',
    // 0.3.59:提问与授权答复搬去 DSH 同源的 /api/code-server/ask/*(调用方是 DSH 页面里的客户端),
    // 桥这边**不再有**这两条 —— 它们必须 404,否则"桥完全只读"这条不变量就不成立。
    '/ask', '/approve']) {
    const res = await callBridge(`/code-server-bridge${bad}`, { method: 'POST', body: '{}' });
    requireReachable(res, '命名空间只读');
    assert.equal(res.status, 404, `${bad} 必须 404(实际 ${res.status})`);
  }
});

await test('/complete(0.3.61):默认关 ⇒ 拒绝且不外发(桥未启用时守卫先 503);只接受 POST', async () => {
  // 桩 ctx 的 settingsValue 里没有 fim 键 ⇒ 走默认 false。这条路由必须**拒绝**而不是
  // "可用但补全为空":拒绝才是"没开就不发请求"的证据(扩展侧也据此不注册 provider)。
  const disabled = await callBridge('/code-server-bridge/complete', {
    method: 'POST', body: JSON.stringify({ prompt: 'const a =', suffix: '' }),
  });
  requireReachable(disabled, '/complete');
  // 把**实际观测到**的那一支打出来(本机进程内分发 / runner 上真实 IPC 都会打):CI 的注解里
  // 会原样带上这一行,以后再有人改守卫顺序,从日志就能看出本地与 runner 是不是同一支。
  console.log(`     /complete(未开启)= ${disabled.status} via=${disabled.via} body=${disabled.text}`);
  // 状态码取决于**桥守卫**这一步(2026-09-22 ubuntu/windows runner 上实测抓到的坑):
  //   每条桥路由的**第一句**都是 bridgeRejection(request),而守卫用的令牌来自"接管一个正在跑的
  //   实例"(adoptBridgeRuntime)。本测试**不启动 IDE** ⇒ 桩里 bridgeMeta 为 null ⇒ 守卫先给
  //   503「编辑器桥未启用」,FIM 那道 403 在**这个环境里根本不可达**(同文件里 /old 期望 503
  //   也是同一个原因)。
  // 两种都接受 —— 守卫在 handler 之前,所以两条路都是"拒绝且一个字节都不外发";但**必须**是我们
  // 认得的拒绝理由:401(令牌不对)/404/405/200 一律不许出现。
  // 注意本机看不到这段:沙箱连命名管道 EPERM ⇒ 这条用例在本机一直 SKIP,本地 pass 从不代表它绿。
  if (disabled.status === 503) {
    assert.match(disabled.text, /编辑器桥未启用/u,
      `503 只能来自桥守卫(lib/bridge.mjs 的 bridgeGuard),实际:${disabled.text}`);
  } else {
    assert.equal(disabled.status, 403, `未开启 FIM 时必须 403(实际 ${disabled.status}:${disabled.text})`);
    assert.match(disabled.text, /fim-disabled/u, `403 必须是 fim-disabled(不是被 glob 拦下),实际:${disabled.text}`);
  }
  const wrongMethod = await callBridge('/code-server-bridge/complete');
  assert.equal(wrongMethod.status, 405, 'GET 应 405(只接受 POST)');
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  assert.match(source, /if \(!fimSetting\) return jsonResponse\(\{ ok: false, error: 'fim-disabled' \}, 403\)/,
    '启用判定必须在读请求体/发请求之前');
  // 上面那个 403 分支只在"桥正在跑"时才执行得到 ⇒ 把**顺序**在这里钉死,否则这条测试在
  // "桥没起来"的环境里等于什么都没验:守卫 → FIM 开关(403)→ 适配器可用性(503)→ 读 body → 发请求。
  assert.match(source,
    /async function handleBridgeComplete\(request\) \{[\s\S]*?bridgeRejection\(request\)[\s\S]*?error: 'fim-disabled'[\s\S]*?\n  \}/u,
    '/complete 必须**先过守卫**再判 FIM 开关(顺序反了就是在鉴权前泄露功能状态),且 FIM 判定在发请求之前');
  assert.match(source, /fimBudget\.acquire\(\)/, '必须有速率与并发闸(这条链路由击键触发)');
  assert.match(source, /provider: FIM_PROVIDER/, '取数必须走 ctx.llm(注册我们自己的适配器路由),不是裸 fetch');
});

await test('写口令只在 /api/code-server/ask/approve 上,约束写死在实现里', async () => {
  // 桥(本机 IPC,令牌对本机同用户进程可读)不再有任何写路由;唯一能改状态的是 DSH 同源那条,
  // 它吃 DSH 自己的 cookie/Origin 校验。约束:
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  assert.match(source, /PANEL_OUTCOMES\.includes\(outcome\)/, 'outcome 必须走白名单');
  assert.match(source, /bridgeApprovalBoard\.get\(id\) === null/, '未知 / 已处理的 id 必须被拒(409)');
  assert.match(source, /\{ path: `\$\{API_BASE\}\/ask\/approve`, methods: \['POST'\]/, '写口令挂在 /api/code-server/ask/approve 上');
  assert.equal(source.includes('handleBridgeApprove'), false, '桥的 /approve 必须删除(没有调用方了)');
  assert.equal(/suffix: '\/ask'/.test(source), false, '桥的 /ask 必须删除(扩展只上报 ask-open 意图)');
});

await test('health 无需令牌(便于重启后一眼确认),且不返回任何编辑器数据', async () => {
  const res = await callBridge('/code-server-bridge/health');
  requireReachable(res, 'health 探活');
  assert.equal(res.status, 200, `实际 ${res.status}`);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.bridge, false, '桩 ctx 下没有 IDE 在跑,桥应为未启用');
  assert.equal(body.transport, 'ipc');
  assert.equal(body.endpoint, null);
  assert.ok(!/token/i.test(JSON.stringify(body)), 'health 不允许出现任何 token 字段');
});

await test('带 Origin 的请求 → 403(必须穿过适配器仍然成立)', async () => {
  // 这条是适配器的关键回归:undici 的 `new Request(url, {headers})` 会把 origin 当 forbidden header
  // **归一化掉**,所以适配器必须把 Node 的原始 headers 挂到 request 上给 guard 读
  // (见 lib/bridge.mjs 的 bridgeGuard 与 test 里那条 undici 实测记录)。
  // 本机 IPC 上浏览器根本连不上,这条检查是纵深防御(端点被别的本机进程代理时仍然有效)。
  const res = await callBridge('/code-server-bridge/sync', {
    method: 'POST', headers: { origin: 'http://evil.example' }, body: '{}',
  });
  requireReachable(res, 'Origin 403');
  assert.equal(res.status, 403, `实际 ${res.status}`);
  assert.match(res.json().error, /Origin/, '错误信息应说明是 Origin 被拒');
});

await test('桥未启用 → 503(与 401 区分:扩展据此休眠而不是重读配置)', async () => {
  const res = await callBridge('/code-server-bridge/sync', {
    method: 'POST', headers: { [TOKEN_HEADER]: 'whatever-0123456789abcdef' }, body: '{}',
  });
  requireReachable(res, '桥未启用 503');
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

await test('扩展安装必须带全 lib/,并且装进**内置**目录(用户级会被 VS Code 标成 removed)', async () => {
  // 两次真实事故:
  // ① 0.3.7:assets/extensions/dshcs-editor-bridge/ 里的纯逻辑放在 lib/ 下,而 installBundledExtensions
  //    硬编码 files=['package.json','extension.js'] ⇒ 装出来的副本没有 lib/,extension.js 一
  //    require('./lib/bridge-client.js') 就抛。
  // ② 0.3.0–0.3.11:桥装在**用户级**目录。VS Code 服务端启动时 ExtensionsWatcher.initialize() →
  //    deleteExtensionsNotInProfiles() 会把"在用户扩展目录里、不在任何 profile 的 extensions.json 里"
  //    的扩展写进 <extensions-dir>/.obsolete(日志 `Marked extension as removed`),扫描器从此跳过它,
  //    下一轮它又不在 profile 里 ⇒ 自锁,扩展永远不加载 ⇒ editor_context 永远报"还没有上报状态"。
  //    所以现在两个扩展都装内置目录(<树>/lib/vscode/extensions),这里注入假树以免碰真实树。
  // 安装发生在 start 里,而本测试不起 IDE ⇒ 直接调导出的安装函数。
  const treeRoot = join(HOME, 'fake-tree');
  const builtinDir = join(treeRoot, 'lib', 'vscode', 'extensions');
  const legacyUserDir = join(extensionsDir, 'dshcs-editor-bridge');
  // 树里本来就有 extensions/ 目录(真实树必然有);没有它 extensionTarget 会退回用户级
  mkdirSync(builtinDir, { recursive: true });
  // 造出 0.3.11 的现场:用户级目录里已有一份(差一个 lib/),.obsolete 里已有自锁标记
  mkdirSync(legacyUserDir, { recursive: true });
  writeFileSync(join(legacyUserDir, 'extension.js'), 'old', 'utf8');
  writeFileSync(join(extensionsDir, '.obsolete'),
    JSON.stringify({ 'dsh-code-server-app.dshcs-editor-bridge-0.1.0': true, 'other.publisher-ext-1.0.0': true }), 'utf8');

  const first = plugin.installBundledExtensions(extensionsDir, userDataDir, { treeRoot });
  // 返回值供 adopt 路径判断"运行中的 IDE 里是旧代码"(updated 为空 ⇒ 接管是安全的)
  assert.ok(first.updated.includes('dshcs-editor-bridge'), `首次安装应报告已更新: ${JSON.stringify(first)}`);
  assert.ok(first.updated.includes('dshcs-open-file'), '两个内置扩展都该装进去');
  assert.deepEqual(first.cleared, ['dsh-code-server-app.dshcs-editor-bridge-0.1.0'], '只清本插件的标记');

  const srcDir = new URL('../assets/extensions/dshcs-editor-bridge/', import.meta.url);
  const dstDir = join(builtinDir, 'dshcs-editor-bridge');
  const expected = ['package.json', 'extension.js', 'lib/bridge-client.js', 'lib/context-model.js', 'lib/diff-model.js'];
  for (const rel of expected) {
    const dst = join(dstDir, rel);
    assert.ok(existsSync(dst), `安装后缺少 ${rel}(${dst})`);
    const a = readFileSync(new URL(rel, srcDir));
    const b = readFileSync(dst);
    assert.ok(a.equals(b), `${rel} 内容与源码不一致`);
  }
  assert.ok(existsSync(join(dstDir, 'lib')), 'lib/ 目录必须存在');
  assert.equal(existsSync(legacyUserDir), false, '用户级的旧副本必须被清掉(否则两份打架、且会被标 removed)');
  const obsolete = JSON.parse(readFileSync(join(extensionsDir, '.obsolete'), 'utf8'));
  assert.equal(obsolete['dsh-code-server-app.dshcs-editor-bridge-0.1.0'], undefined, '自锁标记必须被清掉');
  assert.equal(obsolete['other.publisher-ext-1.0.0'], true, '别的扩展的标记不能动');
  // 幂等:再装一次不该报错也不该改写内容,而且 **updated 必须为空** ——
  // adopt(接管正在运行的 IDE)路径就靠这个判断"里面跑的是不是旧代码"。
  const second = plugin.installBundledExtensions(extensionsDir, userDataDir, { treeRoot });
  assert.deepEqual(second.updated, [], `内容一致时不该报更新: ${JSON.stringify(second)}`);
  assert.ok(readFileSync(join(dstDir, 'lib/bridge-client.js')).equals(readFileSync(new URL('lib/bridge-client.js', srcDir))));
  // 源目录里没有的文件必须被清掉(升级后不留旧文件),这算一次更新
  writeFileSync(join(dstDir, 'stale-from-old-version.js'), 'old', 'utf8');
  const third = plugin.installBundledExtensions(extensionsDir, userDataDir, { treeRoot });
  assert.equal(existsSync(join(dstDir, 'stale-from-old-version.js')), false, '陈旧文件应被清理');
  assert.ok(third.updated.includes('dshcs-editor-bridge'), '清掉陈旧文件也算"扩展被动过"');
  // .obsolete 只剩别的扩展 → 文件保留;只有本插件的标记时 → 文件删掉
  writeFileSync(join(extensionsDir, '.obsolete'), JSON.stringify({ 'dsh-code-server-app.dshcs-open-file-0.0.2': true }), 'utf8');
  plugin.installBundledExtensions(extensionsDir, userDataDir, { treeRoot });
  assert.equal(existsSync(join(extensionsDir, '.obsolete')), false, '只剩本插件的标记时应删掉整个文件');
});

await test('adopt 判据:内容一致时 updated 为空,且能算出"扩展文件比 IDE 进程新"', async () => {
  // adopt(接管固定端口上正在运行的 IDE)不会重新加载扩展 ⇒ host 必须能自己判断
  // "跑着的扩展宿主里是不是升级前的旧代码":updated 非空,或扩展文件 mtime > IDE 进程启动时间。
  const dir = mkdtempSync(join(tmpdir(), 'dshcs-stale-'));
  const treeRoot = join(dir, 'tree');
  const builtin = join(treeRoot, 'lib', 'vscode', 'extensions');
  mkdirSync(builtin, { recursive: true });
  const extensionsDir = join(dir, 'extensions');
  mkdirSync(extensionsDir, { recursive: true });
  const userData = join(dir, 'user-data');

  const first = plugin.installBundledExtensions(extensionsDir, userData, { treeRoot });
  assert.ok(first.updated.length > 0, '首次安装必然有更新');
  const second = plugin.installBundledExtensions(extensionsDir, userData, { treeRoot });
  assert.deepEqual(second.updated, [], '内容一致时不该报更新(⇒ adopt 是安全的)');

  const newestReal = plugin.newestBundledExtensionMtime(extensionsDir, { treeRoot });
  assert.ok(Number.isFinite(newestReal), `应能取到 mtime: ${newestReal}`);
  assert.ok(newestReal >= statSync(join(builtin, 'dshcs-editor-bridge', 'extension.js')).mtimeMs,
    '取的是安装后文件里最新的那个');

  // 把所有已装文件的时间统一改老 → 判据必须跟着变(说明它 stat 的是**安装目录**里的文件)
  const old = Date.now() - 3600_000;
  for (const name of ['dshcs-open-file', 'dshcs-editor-bridge']) {
    for (const rel of plugin.listExtensionFiles(join(builtin, name))) {
      utimesSync(join(builtin, name, rel), new Date(old), new Date(old));
    }
  }
  const newestOld = plugin.newestBundledExtensionMtime(extensionsDir, { treeRoot });
  assert.ok(Math.abs(newestOld - old) < 2000, `改老后应读到老时间: ${newestOld} vs ${old}`);
  assert.equal(newestOld > Date.now() - 1800_000, false, '一小时前写的文件不该被当成"比刚启动的 IDE 新"');
  rmSync(dir, { recursive: true, force: true });
});

await test('会话流:follow 帧投影成对话条目(只新内容、工具配对、流式替换、有界)', async () => {
  // 面板要像 DSH 对话那样显示**新内容** ⇒ host 用 sessionController.follow 的帧投影
  // (见 lib/bridge-thread.mjs)。这里直接驱动帧,验六件事:
  //   ① 开帧(snapshot)按"只渲染新内容"丢弃历史;② 用户/助手文本;③ 工具 call→result 配对;
  //   ④ 助手流累积、耐久消息落地后替换流式条目;⑤ 授权审计行;⑥ 条目上限丢最旧。
  const thread = await import('../lib/bridge-thread.mjs');
  const state = thread.createThreadState('session-a');

  // ① 开帧:带历史的 records,但我们只取 cursor
  assert.equal(thread.consumeFrame(state, {
    type: 'snapshot',
    cursor: 42,
    records: [{ type: 'event', event: { type: 'user/message', data: { content: [{ type: 'text', text: '远古历史' }] } } }],
  }), false);
  assert.equal(state.entries.length, 0, '历史不渲染(只渲染新内容)');
  assert.equal(thread.threadSnapshot(state).cursor, 42, '开帧的 cursor 要留下(诊断/分页切点)');

  // ② 用户 / 助手文本 + 思考块(0.3.23:reasoning 进 thinking 字段,不再丢)
  thread.consumeFrame(state, { type: 'event', event: { type: 'user/message', data: { content: [{ type: 'text', text: '这段逻辑对吗?' }] } } });
  thread.consumeFrame(state, { type: 'event', event: { type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: '内心戏' }, { type: 'text', text: '有问题。' }] } } } });
  assert.deepEqual(state.entries.map((e) => [e.role, e.text]), [['user', '这段逻辑对吗?'], ['assistant', '有问题。']]);
  assert.equal(state.entries[1].thinking, '内心戏', '思考过程要进条目(面板渲染成默认折叠的「思考」行)');
  assert.equal(thread.threadSnapshot(state).entries[1].thinking, '内心戏', '快照要把 thinking 带出去');

  // ③ 工具 call → result 配对(ok / error)
  thread.consumeFrame(state, { type: 'event', event: { type: 'tool/call', data: { callId: 'c1', name: 'pwsh', arguments: JSON.stringify({ command: 'npm test\n--watch' }) } } });
  thread.consumeFrame(state, { type: 'event', event: { type: 'tool/call', data: { callId: 'c2', name: 'edit', arguments: JSON.stringify({ file_path: 'C:\\repo\\a.ts' }) } } });
  const tools = state.entries.filter((e) => e.role === 'tool');
  assert.deepEqual(tools.map((t) => [t.name, t.summary, t.status]), [['pwsh', 'npm test', 'running'], ['edit', 'C:\\repo\\a.ts', 'running']],
    '摘要取命令首行 / 文件路径');
  thread.consumeFrame(state, { type: 'event', event: { type: 'tool/result', data: { message: { source: { callId: 'c1' }, content: [{ isError: false }] } } } });
  thread.consumeFrame(state, { type: 'event', event: { type: 'tool/result', data: { message: { source: { callId: 'c2' }, content: [{ isError: true }] } } } });
  assert.deepEqual(tools.map((t) => t.status), ['ok', 'error'], 'result 回填状态');
  // 未知 callId 的 result 不该凭空造条目
  const before = state.entries.length;
  thread.consumeFrame(state, { type: 'event', event: { type: 'tool/result', data: { message: { source: { callId: 'nope' }, content: [{}] } } } });
  assert.equal(state.entries.length, before);

  // ④ 助手流:同轮累积正文与思考;其它块忽略;耐久消息落地后流式条目被替换
  thread.consumeFrame(state, { type: 'assistant-stream', frame: { type: 'start', turn: 9, step: 1 } });
  thread.consumeFrame(state, { type: 'assistant-stream', frame: { type: 'chunk', turn: 9, chunk: { type: 'text-delta', text: '正在' } } });
  thread.consumeFrame(state, { type: 'assistant-stream', frame: { type: 'chunk', turn: 9, chunk: { type: 'reasoning-delta', text: '先想一下' } } });
  thread.consumeFrame(state, { type: 'assistant-stream', frame: { type: 'chunk', turn: 9, chunk: { type: 'text-delta', text: '回答' } } });
  const streaming = state.entries.filter((e) => e.streaming === true);
  assert.equal(streaming.length, 1, '同一轮只有一条流式条目');
  assert.equal(streaming[0].text, '正在回答');
  assert.equal(streaming[0].thinking, '先想一下', 'reasoning-delta 要累积到同一条的 thinking(面板先显示"思考中")');
  thread.consumeFrame(state, { type: 'event', event: { type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: '想完了' }, { type: 'text', text: '正在回答(完整)' }] } } } });
  assert.equal(state.entries.filter((e) => e.streaming === true).length, 0, '耐久消息落地后不该再保留流式条目');
  assert.equal(state.entries.at(-1).text, '正在回答(完整)');
  assert.equal(state.entries.at(-1).thinking, '想完了', '耐久消息里的思考要覆盖流式临时值');

  // ⑤ 授权审计行:asked → decided 回填 outcome
  thread.consumeFrame(state, { type: 'event', event: { type: 'approval/asked', data: { id: 'ap1', toolName: 'pwsh', reason: '命令需要授权' } } });
  const asked = state.entries.at(-1);
  assert.deepEqual([asked.role, asked.toolName, asked.status, asked.summary], ['approval', 'pwsh', 'asked', '命令需要授权']);
  thread.consumeFrame(state, { type: 'event', event: { type: 'approval/decided', data: { id: 'ap1', outcome: 'allowed-once' } } });
  assert.equal(asked.status, 'allowed-once');

  // ⑥ 上限:塞满后只保留最近 MAX_ENTRIES 条
  for (let i = 0; i < thread.MAX_ENTRIES + 10; i += 1) {
    thread.consumeFrame(state, { type: 'event', event: { type: 'user/message', data: { content: [{ type: 'text', text: `#${i}` }] } } });
  }
  assert.equal(state.entries.length, thread.MAX_ENTRIES, `条目数必须封顶在 ${thread.MAX_ENTRIES}`);
  assert.equal(state.entries.at(-1).text, `#${thread.MAX_ENTRIES + 9}`);
});

await test('会话流注册表:watch 幂等、超出上限丢最旧、abort 真被调用、dispose 收干净', async () => {
  const thread = await import('../lib/bridge-thread.mjs');
  const aborted = [];
  /** 队列式假流:push() 进来的帧真的会被 await 中的消费者取到(模拟长连接)。 */
  function makeService() {
    const queue = [];
    let notify = null;
    return {
      push(frame) {
        queue.push(frame);
        if (notify !== null) { const resume = notify; notify = null; resume(); }
      },
      follow(_request, signal) {
        aborted.push(signal);
        return {
          async *[Symbol.asyncIterator]() {
            for (;;) {
              if (queue.length > 0) { yield queue.shift(); continue; }
              if (signal.aborted) return;
              await new Promise((resolve) => {
                notify = resolve;
                signal.addEventListener('abort', () => { notify = null; resolve(); }, { once: true });
              });
              if (signal.aborted) return;
            }
          },
        };
      },
    };
  }
  const service = makeService();
  const registry = thread.createThreadRegistry({ resolveController: () => service, log: () => {}, maxWatched: 2 });

  assert.equal(registry.watch('s1'), true);
  assert.equal(registry.watch('s1'), true, '幂等:重复 watch 不该再开一个订阅');
  assert.equal(aborted.length, 1);
  service.push({ type: 'event', event: { type: 'user/message', data: { content: [{ type: 'text', text: '你好' }] } } });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(registry.snapshot(['s1']).entries.length, 1, '帧要投影进快照');
  assert.equal(registry.snapshot(['s1']).entries[0].text, '你好');

  registry.watch('s2');
  registry.watch('s3');
  assert.equal(aborted.length, 3);
  assert.equal(aborted[0].aborted, true, '被淘汰的会话订阅必须 abort');
  assert.equal(registry.snapshot(['s1']).sessionId, null, 's1 已被淘汰');

  registry.sync(['s3', 's4']);
  assert.equal(registry.isWatched('s2'), false);
  assert.equal(registry.isWatched('s3'), true);
  assert.equal(registry.isWatched('s4'), true);

  registry.dispose();
  assert.equal(registry.isWatched('s3'), false);
  assert.equal(aborted.every((signal) => signal.aborted), true, 'dispose 必须 abort 全部订阅');
});

await test('授权拦截:面板先答则返回该 outcome;没人答 / 面板没开则交给官方链路(next)', async () => {
  // 见 lib/bridge-approval.mjs:从编辑器提问后,工作区外写入 / 命令执行的授权先在面板问一句,
  // 窗口内没人答 → next()(官方 GUI 照旧弹卡);缺答案者 fail closed 的语义完全不变。
  // 0.3.23 起窗口是 5 分钟(8 秒对人来说太短 ⇒ 实测"授权框失效"),而且**面板一关就立刻交回**。
  const approval = await import('../lib/bridge-approval.mjs');
  const board = approval.createApprovalBoard({ holdMs: 40 });
  const interceptor = approval.createApprovalInterceptor({ board, holdMs: 40, pollMs: 10, hasPanel: () => panelOpen, log: () => {} });
  let panelOpen = true;
  const handlers = new Map();
  const agent = { ctx: { on: (event, handler) => { handlers.set(event, handler); return () => handlers.delete(event); } } };
  const dispose = interceptor.intercept(agent, 'session-a');
  assert.equal(typeof handlers.get('approval/request'), 'function', '必须在 agent.ctx 上注册 approval/request');
  const handle = handlers.get('approval/request');

  // ① 面板作答 → 返回该 outcome,且**不**调用 next
  let nextCalls = 0;
  const answered = handle({ id: 'ap-1', toolName: 'pwsh', reason: '需要授权' }, async () => { nextCalls += 1; return 'rejected'; });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(board.snapshot().map((a) => [a.id, a.toolName, a.reason]), [['ap-1', 'pwsh', '需要授权']],
    '面板要能看到待决授权(工具名 + 原因)');
  assert.equal(board.answer('ap-1', 'allowed-once'), true);
  assert.equal(await answered, 'allowed-once');
  assert.equal(nextCalls, 0, '面板先答 ⇒ 不该再问官方');

  // ② 白名单:非 allowed-once/rejected 一律拒
  assert.equal(board.answer('ap-1', 'yolo'), false, '非白名单 outcome 必须被拒');
  assert.equal(board.answer('missing', 'allowed-once'), false, '未知 id 必须被拒');

  // ③ 没人答(超时)→ 交给官方链路
  const timedOut = handle({ id: 'ap-2', toolName: 'edit' }, async () => { nextCalls += 1; return 'rejected'; });
  assert.equal(await timedOut, 'rejected');
  assert.equal(nextCalls, 1, '面板没答 ⇒ 必须 next() 交给官方');
  assert.equal(board.size(), 0, '超时后待决列表要清空');

  // ③b 面板关掉 → **立刻**交回官方链路(不用干等满窗口;0.3.23)
  const longWindow = approval.createApprovalInterceptor({
    board,
    holdMs: 60_000,
    pollMs: 10,
    hasPanel: () => false,
    log: () => {},
  });
  const longHandlers = new Map();
  longWindow.intercept({ ctx: { on: (event, handler) => { longHandlers.set(event, handler); return () => {}; } } }, 'session-b');
  const started = Date.now();
  let closedNext = 0;
  const closed = await longHandlers.get('approval/request')(
    { id: 'ap-closed', toolName: 'write' },
    async () => { closedNext += 1; return 'unavailable'; },
  );
  assert.equal(closed, 'unavailable', '面板关掉要交回官方链路');
  assert.equal(closedNext, 1);
  assert.ok(Date.now() - started < 2000, `面板关掉必须立刻返回(实测 ${Date.now() - started}ms)`);

  // ④ 面板没开 → 完全不拦截
  panelOpen = false;
  const noPanel = handle({ id: 'ap-3', toolName: 'pwsh' }, async () => { nextCalls += 1; return 'unavailable'; });
  assert.equal(await noPanel, 'unavailable');
  assert.equal(nextCalls, 2);

  // ⑤ 并发上限:满了就不抢答(交给官方)
  panelOpen = true;
  const slow = [];
  for (const id of ['b-1', 'b-2', 'b-3', 'b-4']) slow.push(handle({ id, toolName: 't' }, async () => 'rejected'));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(board.size(), approval.MAX_PENDING);
  const overflow = handle({ id: 'b-5', toolName: 't' }, async () => { nextCalls += 1; return 'unavailable'; });
  assert.equal(await overflow, 'unavailable', '超过上限必须交给官方');
  await Promise.all(slow);

  dispose();
  assert.equal(interceptor.size(), 0);
});

await test('源码级:/sync 只回事件与能力位;ask 建立会话流与授权拦截、提问以用户输入投递', () => {
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  // 0.3.59:对话流/待决授权**不再经 /sync**(那是编辑器 webview 面板时代的分工,面板已退役);
  // 现在由对话框自己每 900ms 问 `/api/code-server/ask/state`。这里钉住"别再把它们塞回 /sync"。
  const syncBody = source.split('async function handleBridgeSync')[1].split('async function handleBridgeAsk')[0];
  for (const gone of ['thread:', 'threadRev', 'approvals:', 'approvalHoldMs', 'uiVersion']) {
    assert.equal(syncBody.includes(gone), false, `/sync 不该再带 ${gone}(0.3.59 起面板走 /ask/state)`);
  }
  assert.match(syncBody, /askDialog: askDialogLive\(\)/, '/sync 仍要给"对话框活着"的能力位');
  assert.match(source, /bridgeThread\.watch\(result\.sessionId\)/, 'ask 成功后必须开始会话流');
  assert.match(source, /bridgeApproval\.intercept\(result\.agent, result\.sessionId\)/, 'ask 成功后必须启用授权拦截');
  assert.equal(/snapshotEvents\(|eventAt\(|ownEvents\(/.test(source), false,
    '禁止同步读会话历史(DSH 已弃用;面板只渲染新内容)');
  const session = readFileSync(new URL('../lib/bridge-session.mjs', import.meta.url), 'utf8');
  assert.match(session, /source: \{ kind: 'user' \}/,
    '提问必须以用户输入进对话(plugin source 会被 DSH 渲染成"上下文更新")');
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
  // 这条用例守的是**快照的形状**:带 bridge 字段、enabled 是文档默认值、file 指向 bridge.json、
  // 以及"绝不出现 token"。
  //
  // 曾经这里断言 `live === false`("没有 IDE 在跑时 live 应为 false"),那是错的:live 的语义是
  // 「桥配置存在」(lib/index.js: live = bridgeMeta !== null),而本测试的 apply() **真的会把监听口
  // 起来**(stub 的 effect 会执行回调 —— 见本文件 makeStubCtx 的注释),端点就绪后插件会写下
  // bridge.json 并把 bridgeMeta 缓存进内存 ⇒ live 与"IDE 有没有在跑"无关,且真假取决于监听是否
  // 已经完成(2026-09-16 windows runner 上 live=true 且 file 存在,ubuntu 上同一时刻是 false)。
  // 所以只钉类型与不变量,不钉那个跟时序赛跑的取值;顺带:清文件是没用的 —— 缓存改不掉。
  const response = await routes.get('/api/code-server/status').fetch();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.bridge !== undefined, 'status 必须带 bridge 字段');
  assert.equal(body.bridge.enabled, true, '默认应启用桥');
  assert.equal(typeof body.bridge.live, 'boolean', `live 必须是布尔(实际 ${typeof body.bridge.live})`);
  assert.equal(typeof body.bridge.toolsRegistered, 'boolean');
  assert.ok(!/token/i.test(JSON.stringify(body.bridge)), 'status.bridge 不允许出现 token 字段');
  assert.ok(typeof body.bridge.file === 'string' && body.bridge.file.endsWith('bridge.json'));
});

await test('配置读写:原子写 / 读回 / 删掉 / 坏内容视为未配置(0.3.13 起是 pipe,不是 url)', () => {
  // 端点按平台构造:isBridgeEndpoint() 在非 win32 上要求**绝对路径**(见 lib/bridge-ipc.mjs)。
  // 以前这里写死 `\\.\pipe\…`,于是 Linux 上 writeBridgeConfig 写进去、readBridgeConfig 读不回来
  // (端点被判非法 ⇒ null)⇒ 下一行读 `.pipe` 直接 TypeError(2026-09-16 ubuntu runner 实测)。
  const pipe = bridgeIpc.bridgeEndpointPath(extensionsDir);
  const token = 'abctoken-0123456789abcdef';
  const file = bridge.writeBridgeConfig(extensionsDir, { pipe, token, pid: 42, startedAt: 7 });
  assert.ok(file.endsWith('bridge.json'), `实际 ${file}`);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.version, 2, '传输换了 → 版本号必须跟着走(旧扩展读到 v2 会自己休眠)');
  assert.equal(raw.pipe, pipe);
  assert.equal(raw.url, undefined, 'url 字段必须消失(否则旧客户端会拿它去发 HTTP)');
  const read = bridge.readBridgeConfig(extensionsDir);
  assert.equal(read.pipe, pipe);
  assert.equal(read.token, token);
  assert.equal(read.pid, 42);
  // 用户手改坏 / 半截文件 → 视为"没有配置",扩展应当休眠而不是拿垃圾配置去连
  bridge.writeBridgeConfig(extensionsDir, { pipe, token: 'short', pid: null, startedAt: null });
  assert.equal(bridge.readBridgeConfig(extensionsDir), null, '非法令牌应视为未配置');
  bridge.writeBridgeConfig(extensionsDir, { pipe: 'not-a-pipe', token, pid: null, startedAt: null });
  assert.equal(bridge.readBridgeConfig(extensionsDir), null, '非本机 IPC 端点应视为未配置');
  assert.equal(bridge.removeBridgeConfig(extensionsDir), true);
  assert.equal(bridge.readBridgeConfig(extensionsDir), null);
});

await test('事件环形缓冲:有界、按游标取、取过不重复、reset 不回退 seq', () => {
  const ring = bridge.createEventRing(3);
  ring.push('agent-edit', { path: 'a.ts' });
  ring.push('agent-edit', { path: 'b.ts' });
  ring.push('agent-edit', { path: 'c.ts' });
  ring.push('agent-edit', { path: 'd.ts' });
  assert.equal(ring.size(), 3, '环形缓冲必须封顶');
  const all = ring.since(0);
  assert.deepEqual(all.map((e) => e.path), ['b.ts', 'c.ts', 'd.ts'], '应丢最旧的');
  assert.equal(ring.lastSeq(), 4, 'seq 是"已分配过的最大序号",封顶不影响它');
  ring.reset();
  assert.deepEqual(ring.since(0), [], 'reset 后缓冲为空');
  // **0.3.56 的回归点**:reset() 不许把 seq 归零。以前它归零,而 /sync 每趟都调用它 ⇒ 扩展的游标
  // (单调递增)从此永远大于新 seq,`seq > since` 全被过滤 ⇒ 每个 IDE 会话只送达第一条事件。
  assert.equal(ring.lastSeq(), 4, 'reset 不许回退 seq(回退 = 客户端游标永久超前 = 永久失聪)');
  const after = ring.push('agent-edit', { path: 'e.ts' });
  assert.equal(after.seq, 5, 'seq 必须继续往前编号');
  assert.deepEqual(ring.since(0).map((e) => e.path), ['e.ts']);
  assert.deepEqual(ring.since(4).map((e) => e.path), ['e.ts'], '游标 4 能收到 seq 5');
  assert.deepEqual(ring.since(5), [], '已取过的游标不应重复返回');
});

await test('事件投递协议回归:连续两次"推送→取→清空"必须两次都送达(0.3.9–0.3.55 只送达第一条)', () => {
  // 这就是用户实测到的现象:每个 IDE 会话只看到一条 diff,而那条还是空 old(文件没打开时
  // 唯一的 old 侧来源缺失)。用真实调用顺序复刻:/sync 每趟 since() 取完立刻 reset()。
  const ring = bridge.createEventRing();
  let cursor = 0;
  ring.push('agent-edit', { path: 'first.txt' });
  let got = ring.since(cursor);
  for (const e of got) if (e.seq > cursor) cursor = e.seq;
  ring.reset();
  assert.deepEqual(got.map((e) => e.path), ['first.txt'], '第一条必须送达');
  assert.equal(cursor, 1);
  // 第二次(用户改第二个文件):旧实现里这条又是 seq=1 ⇒ since(1) 过滤掉 ⇒ 永远看不到
  ring.push('agent-edit', { path: 'second.txt' });
  got = ring.since(cursor);
  for (const e of got) if (e.seq > cursor) cursor = e.seq;
  ring.reset();
  assert.deepEqual(got.map((e) => e.path), ['second.txt'], '第二条也必须送达(旧的归零语义会把它吞掉)');
  // 第三次、第四次同样
  for (const name of ['third.txt', 'fourth.txt']) {
    ring.push('agent-edit', { path: name });
    got = ring.since(cursor);
    for (const e of got) if (e.seq > cursor) cursor = e.seq;
    ring.reset();
    assert.deepEqual(got.map((e) => e.path), [name], `${name} 也必须送达`);
  }
  assert.equal(cursor, 4, '游标随送达单调前进');
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

// 收尾清理不判失败:Windows 上刚写完的目录可能还被 Defender/索引扫着(EPERM/EBUSY)。
// 重试几次后降级成警告 —— 临时目录由 mkdtemp 每次新建,清理失败不影响任何结论
// (2026-09-16 windows runner 上就是这行 rmSync 报 EPERM 把整条回归判红的)。
for (let attempt = 0; attempt < 5; attempt += 1) {
  try {
    rmSync(HOME, { recursive: true, force: true });
    break;
  } catch (error) {
    if (attempt === 4) {
      console.warn(`     (临时目录清理失败:${error && error.code ? error.code : error} —— 不影响结论,忽略)`);
    } else {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}
// 传输打在 SUMMARY 之前(harness 只把 SUMMARY 当诊断行读;顺序保持 SUMMARY 在最后)。
console.log(`传输:${transport === 'ipc'
  ? '本机 IPC(命名管道 / unix socket,与扩展同一条路)'
  : '进程内分发(本机 IPC EPERM;同一条 dispatchBridge,缺的只有 socket)'}`);
console.log(`SUMMARY pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
