// scripts/test-client-resident-face.mjs —— 常驻面的四条新契约(2026-10-01;起因:desktop 上"常驻不起作用")
//
// 事故现场(用户机器上的实测):
//   · `__dshcsSurface.snapshot()` 显示面是好的(ready/preloaded/supportsMoveBefore 都对、docked 也建得起来),
//     但 iframe 里那条到 IDE 的 WebSocket **22.8 小时零收包、1952 条消息无 ack** —— 停放在离屏 park 的
//     iframe 被宿主挂起,`nudgeRepaint()` 只能修合成、救不回半死连接;
//   · 面里跑的还是**升级前**的页面(`?v=0.3.68-stable-59c988c7…`),因为 `?s=<pid>` 只在 IDE **进程**重启时变,
//     而升级插件/换树时进程常被 adopt(pid 不变)。
//
// 四条契约(每条都对应上面一个具体事实,不是"顺手加的"):
//   R1 标签**类型**必须声明 `keepMounted: true` —— DSH 0.2 的 `TabSlot` 只认这个字段来 `retainTab`,
//      声明后正文在切 tab / 切 Session / 收起 / 停靠切换期间由宿主保留,不必再靠离屏 park 硬扛;
//   R2 iframe URL 必须带宿主给的 `&v=<htmlTag>`(插件版本 + VS Code 树)⇒ 真升级时自动换页;
//   R3 停放超过阈值后回归 ⇒ **重新加载同一 URL**(只有这条能救回被挂起的连接);未超阈值仍只补重绘,
//      保持"来回切一眼不重载"的既有承诺;
//   R4 桌面载体不在离屏预热 —— 预热等于提前造一个"出生即冻死"的会话。
//
// 用法:node scripts/test-client-resident-face.mjs
import assert from 'node:assert/strict';
import { loadClientBundle } from './client-bundle-harness.mjs';

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`FAIL ${name}:${error && error.message ? error.message : error}`);
  }
}

const TAG = '0.3.70-stable-abc123';
const SESSIONS = { ids: ['s'], byId: { s: { id: 's', cwd: 'C:/work/repo' } }, phase: 'ready' };
const NO_WS = { items: [], state: 'idle', phase: 'ready', error: null };

function statusOf(extra = {}) {
  return {
    ok: true, running: true, status: 'running', pid: 9600, startedAt: 1789657770119,
    url: 'http://127.0.0.1:8090/tok/', serve: 'loopback',
    keepResident: true, fullscreenOnOpen: true, claimExtensions: '*',
    htmlTag: TAG,
    ...extra,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const surface = () => globalThis.window.__dshcsSurface;

/** 面里的 iframe(createSurface 把 park 挂在 body 上,park 的第一个孩子就是 iframe)。 */
function frameElement() {
  const park = globalThis.document.body.children.find((c) => c.attributes['data-dshcs-park'] !== undefined);
  return park === undefined ? null : park.children[0];
}

/** 把 `src` 变成可计数的属性:重新加载 = 对同一个值再赋一次,只有 setter 看得到。 */
function countSrcWrites(frame) {
  const writes = [];
  let current = frame.src;
  Object.defineProperty(frame, 'src', {
    configurable: true,
    get: () => current,
    set: (value) => { writes.push(value); current = value; },
  });
  return writes;
}

/** 起一份产物、等 /status 落地、让 body 建面(URL 由状态驱动,不依赖真的停靠)。 */
async function withSurface(options = {}) {
  const bundle = loadClientBundle({ declaredSlots: ['sidebar.right.pane.tab', 'shell.overlay'], ...options });
  await settle();
  const body = bundle.registrations.find((r) => r.desc.name === 'sidebar.right.pane.tab');
  assert.ok(body !== undefined, '应注册 sidebar.right.pane.tab 的 body');
  bundle.render(body.component, {
    sessionId: 's',
    useSessions: (selector) => selector(SESSIONS),
    useWorkspaces: (selector) => selector(NO_WS),
    useTabInfo: () => ({
      tab: { id: 'tab-code', visible: true, navigation: { address: 'sidebar://code-server', revision: 0 }, actions: { close: () => {} } },
      panel: { id: 'p1' },
      sidebar: { fullscreen: true },
    }),
  });
  await settle();
  return { bundle, frame: frameElement() };
}

await test('R1:标签类型声明 keepMounted(0.2 的宿主只认这个字段来保留正文)', async () => {
  const bundle = loadClientBundle({ declaredSlots: ['sidebar.right.pane.tab'] });
  const type = bundle.typeRegistrations.find((d) => d.kind === 'code-server');
  assert.ok(type !== undefined, '应登记 kind=code-server 的标签类型');
  assert.equal(type.id, 'dsh-code-server-app', '类型的 id 必须与 body 的 key 一致');
  assert.equal(type.keepMounted, true, 'keepMounted 必须声明为 true —— 否则切 tab/切 Session 时正文被卸载,只能靠离屏 park 硬扛');
});

await test('R2:宿主给了 htmlTag ⇒ iframe URL 带 &v=(插件/树变了就换页)', async () => {
  const { bundle } = await withSurface({ status: statusOf() });
  const src = bundle.surfaceSrc();
  assert.match(src, /\?s=9600/, `URL 仍要有实例标记:${src}`);
  assert.ok(src.includes(`&v=${TAG}`), `URL 必须带版本标记:${src}`);
});

await test('R2b:宿主没给 htmlTag(旧宿主)⇒ 不添 v=,也不报错', async () => {
  const { bundle } = await withSurface({ status: statusOf({ htmlTag: undefined }) });
  const src = bundle.surfaceSrc();
  assert.match(src, /\?s=9600/, `URL 仍要有实例标记:${src}`);
  assert.equal(src.includes('v='), false, `没有 htmlTag 时不许编一个出来:${src}`);
});

await test('R3:停放超过阈值后回归 ⇒ 重新加载同一 URL(救回被挂起的连接)', async () => {
  const { bundle, frame } = await withSurface({ status: statusOf() });
  assert.ok(frame !== null, '面必须已经建出来');
  const writes = countSrcWrites(frame);
  const before = surface().snapshot().nudgeCount;
  const realNow = Date.now;
  try {
    Date.now = () => 1_000_000_000;
    surface().park();
    Date.now = () => 1_000_000_000 + 11 * 60 * 1000; // 超过 PARKED_RELOAD_MS(10 分钟)
    surface().dock(globalThis.document.createElement('div'), 'tab:tab-code');
  } finally {
    Date.now = realNow;
  }
  assert.equal(writes.length, 1, '停放超时回归必须重新导航一次(否则会沿用那条半死的连接)');
  assert.equal(writes[0], bundle.surfaceSrc(), '重新加载的必须是同一 URL(URL 代表工作区,不能换错)');
  assert.equal(surface().snapshot().docked, true, '回归后必须处于停靠态');
  assert.equal(surface().snapshot().nudgeCount, before, '走重载这条路时不再额外补重绘');
  assert.equal(surface().snapshot().parkedAt, null, '回归后要清掉停放时刻');
});

await test('R3b:短停放(阈值内)仍然只补重绘,不重载 —— 保住"切一眼不重载"的承诺', async () => {
  const { bundle, frame } = await withSurface({ status: statusOf() });
  // harness 的假元素没有 isConnected:而 nudgeRepaint() 只在"面还在文档里"时才补重绘(真实环境恒为真),
  // 这里按真实情况标上,否则测的是 harness 的短板而不是产品行为。
  frame.isConnected = true;
  const writes = countSrcWrites(frame);
  const before = surface().snapshot().nudgeCount;
  const realNow = Date.now;
  try {
    Date.now = () => 2_000_000_000;
    surface().park();
    Date.now = () => 2_000_000_000 + 30 * 1000; // 30 秒,远低于阈值
    surface().dock(globalThis.document.createElement('div'), 'tab:tab-code');
  } finally {
    Date.now = realNow;
  }
  assert.equal(writes.length, 0, '阈值内不许重载');
  assert.equal(surface().snapshot().nudgeCount, before + 1, '阈值内应补一次重绘唤醒');
});

await test('R4:桌面载体不在离屏预热(预热会得到一个"出生即冻死"的会话)', async () => {
  globalThis.dshDesktop = { protocolVersion: 1 };
  try {
    const bundle = loadClientBundle({ declaredSlots: ['shell.overlay'], status: statusOf() });
    await settle();
    const overlay = bundle.registrations.find((r) => r.desc.name === 'shell.overlay');
    assert.ok(overlay !== undefined, '应注册 shell.overlay(常驻预热)');
    bundle.render(overlay.component, {});
    await settle();
    assert.equal(surface().snapshot().preloaded, false, 'desktop 上不许把面预热到离屏 park');
  } finally {
    delete globalThis.dshDesktop;
  }
});

await test('R4b:非桌面载体照旧预热(web 上"首次点开免等待"这个特性不能丢)', async () => {
  const bundle = loadClientBundle({ declaredSlots: ['shell.overlay'], status: statusOf() });
  await settle();
  const overlay = bundle.registrations.find((r) => r.desc.name === 'shell.overlay');
  bundle.render(overlay.component, {});
  await settle();
  assert.equal(surface().snapshot().preloaded, true, 'web 上必须仍然预热');
});

console.log(`SUMMARY pass=${pass} fail=${fail} skip=0`);
process.exit(fail === 0 ? 0 : 1);
