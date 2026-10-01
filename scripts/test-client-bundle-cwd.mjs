// scripts/test-client-bundle-cwd.mjs —— 直接对**客户端入口** lib/client.js 验"工作区跟随"这条链
//
// 为什么不能只测那个纯函数:0.3.46 的坑不在解析函数里,而在**入口怎么拿输入** ——
// 它从 `useSessions(s => s).current` 里读"当前会话",而 DSH 0.1.6-alpha.2(alpha 线)把这个字段从
// SessionListState 移除了 ⇒ 客户端不再发 cwd ⇒ IDE 以空工作区启动(实测 pid.json 里 cwd 双空)。
// 纯函数测试对"喂什么形状"是无感的,只有真跑一遍注册出来的 React 组件、喂进 DSH 的标准 prop
// 形状,才能钉住这条契约。
//
// 做法:用 scripts/client-bundle-harness.mjs 的"最小 DSH"把入口加载起来(它负责 window/document/
// fetch/react/slots 桩与渲染),拿到注册到 `sidebar.right.pane.tab` 的 body 与 `shell.overlay` 的
// 预热面,然后看两件事:① 它以什么 cwd 打 `POST /api/code-server/start`(0.3.46 漏掉的那一步);
// ② 它交给常驻 iframe 的 pageUrl(决定 workbench 用哪个 `?folder=` 打开)。
//
// **0.2 起只有一代**(rc 线的 `current` 兜底已从入口删除),场景收敛成:
// sessionId 标准 prop、换会话、文件 tab(地址里的会话)、没有任何信源(不得猜目录)、根作用域预热面;
// 外加一条**反断言**:会话快照上即使带着 rc 旧字段 `current` 也不许影响结果。
//
// 0.3.58 起 lib/client.js 就是**手写源码**(客户端不再构建),所以这里没有"产物缺失/过期就 SKIP"
// 那条退路:入口加载不了、渲染不出来,就是真失败。
//
// 用法:node scripts/test-client-bundle-cwd.mjs
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
    console.log(`FAIL ${name}: ${error && error.message ? error.message : error}`);
  }
}

// 只声明这两个座位就够:本文件测的是"工作区跟随",设置座位另有 test-client-settings-seat.mjs
const bundle = loadClientBundle({ declaredSlots: ['sidebar.right.pane.tab', 'shell.overlay'] });
const bodyReg = bundle.registrations.find((r) => r.desc.name === 'sidebar.right.pane.tab');
const residentReg = bundle.registrations.find((r) => r.desc.name === 'shell.overlay');

const tabProps = ({ sessionId, sessions, workspaces, address }) => ({
  sessionId,
  useSessions: (selector) => selector(sessions),
  useWorkspaces: (selector) => selector(workspaces),
  useTabInfo: () => ({
    tab: { id: 'tab-1', navigation: { address: address !== undefined ? address : 'sidebar://code-server', revision: 0 }, visible: true },
    sidebar: { fullscreen: true },
  }),
});

/** 0.2 形状的会话列表快照:**没有** `current`(上游把它移出了列表 store)。 */
const SESSIONS_SNAPSHOT = { ids: ['b'], byId: { b: { id: 'b', cwd: 'C:/work/beta' } }, phase: 'ready', subagentsByParent: {}, jobsBySession: {} };
const NO_WS = { items: [], state: 'idle', phase: 'ready', error: null };
const folderOf = (cwd) => '&folder=' + encodeURIComponent('/' + cwd.replace(/\\/g, '/'));

// 先等一次 apply 期的 /status 预取落地(store 里要有 status,否则 body 渲染的是"未运行"空态)
await new Promise((resolve) => setTimeout(resolve, 0));

await test('注册面:body 挂在 sidebar.right.pane.tab,预热面挂在 shell.overlay', async () => {
  assert.ok(bodyReg, '应注册 sidebar.right.pane.tab 的 body');
  assert.equal(bodyReg.desc.key, 'dsh-code-server-app');
  assert.ok(residentReg, '应注册 shell.overlay 的常驻预热面');
  assert.ok(bundle.calls.some((c) => c.url.includes('/api/code-server/status')), 'apply 期应先拉一次 status');
});

await test('0.2 形状:sessionId 标准 prop → /start 带 cwd 且 pageUrl 带 ?folder=', async () => {
  bundle.render(bodyReg.component, tabProps({ sessionId: 'b', sessions: SESSIONS_SNAPSHOT, workspaces: NO_WS }));
  assert.equal(bundle.lastStartCwd(), 'C:/work/beta', '必须把该会话的工作区交给宿主(0.3.46 在这里漏了)');
  const src = bundle.surfaceSrc();
  assert.match(src, /\?s=9600/, '实例标记要在');
  assert.ok(src.includes(folderOf('C:/work/beta')), `folder 应是 /C:/work/beta,实际:${src}`);
});

await test('反断言:快照带着 rc 旧字段 current 也不再被认(没有 sessionId ⇒ 不猜目录、不发 cwd)', async () => {
  // rc 线(≤ 0.1.5-rc.3)的形状:列表快照上是"当前会话" current。旧入口读它 ⇒ 这里会挑出 alpha。
  const legacy = { ids: ['a'], byId: { a: { id: 'a', cwd: 'C:/work/alpha' } }, current: 'a', phase: 'ready' };
  const before = bundle.calls.length;
  bundle.render(bodyReg.component, tabProps({ sessionId: undefined, sessions: legacy, workspaces: NO_WS }));
  const started = bundle.calls.slice(before).filter((c) => c.url.endsWith('/api/code-server/start'));
  assert.equal(started.length, 0, 'current 不再参与解析 ⇒ 没有信源就不该发 /start');
  assert.ok(!bundle.surfaceSrc().includes('folder='), `不许带上旧线挑出来的目录,实际:${bundle.surfaceSrc()}`);
});

await test('切换会话(sessionId 变化)会把工作区换到新目录', async () => {
  const sessions = { ids: ['a', 'b'], byId: { a: { id: 'a', cwd: 'C:/work/alpha' }, b: { id: 'b', cwd: 'C:/work/beta' } }, phase: 'ready' };
  bundle.render(bodyReg.component, tabProps({ sessionId: 'a', sessions, workspaces: NO_WS }));
  assert.equal(bundle.lastStartCwd(), 'C:/work/alpha');
  bundle.render(bodyReg.component, tabProps({ sessionId: 'b', sessions, workspaces: NO_WS }));
  assert.equal(bundle.lastStartCwd(), 'C:/work/beta');
  assert.ok(bundle.surfaceSrc().includes(folderOf('C:/work/beta')));
});

await test('文件 tab:地址里的会话决定工作区(看别的会话的文件不串目录)', async () => {
  const sessions = { ids: ['b'], byId: { other: { id: 'other', cwd: 'D:/repo/other' } }, phase: 'ready' };
  bundle.render(bodyReg.component, tabProps({
    sessionId: 'b', sessions, workspaces: NO_WS,
    address: 'dsh-resource://file/session/other/src/a.ts',
  }));
  assert.equal(bundle.lastStartCwd(), 'D:/repo/other', '文件 tab 用地址里的会话');
  assert.ok(bundle.surfaceSrc().includes(folderOf('D:/repo/other')), `实际:${bundle.surfaceSrc()}`);
});

await test('没有任何信源 → 不猜目录(不发 cwd,pageUrl 不带 folder)', async () => {
  const before = bundle.calls.length;
  bundle.render(bodyReg.component, tabProps({ sessionId: undefined, sessions: { ids: [], byId: {}, phase: 'ready' }, workspaces: NO_WS }));
  const started = bundle.calls.slice(before).filter((c) => c.url.endsWith('/api/code-server/start'));
  assert.equal(started.length, 0, '没有工作区时不应发 /start(免得把实例的目录改成空)');
  const src = bundle.surfaceSrc();
  assert.ok(typeof src === 'string' && src !== '');
  assert.ok(!src.includes('folder='), `没有信源时不应带 folder,实际:${src}`);
});

await test('根作用域预热面:无 sessionId 也能退到"最近活跃会话所属工作区"', async () => {
  const sessions = { ids: ['recent'], byId: { recent: { id: 'recent' } }, phase: 'ready' };
  const workspaces = { items: [{ workspaceId: 'w', path: 'C:/work/team', sessionIds: ['recent'] }], state: 'idle', phase: 'ready', error: null };
  bundle.render(residentReg.component, {
    useSessions: (selector) => selector(sessions),
    useWorkspaces: (selector) => selector(workspaces),
  });
  assert.ok(bundle.surfaceSrc().includes(folderOf('C:/work/team')), `预热 src 应带 team 工作区,实际:${bundle.surfaceSrc()}`);
});

console.log(`SUMMARY pass=${pass} fail=${fail} skip=0`);
process.exit(fail === 0 ? 0 : 1);
