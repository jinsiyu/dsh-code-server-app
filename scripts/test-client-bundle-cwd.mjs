// scripts/test-client-bundle-cwd.mjs —— 直接对**构建产物** lib/client.js 验"工作区跟随"这条链
//
// 为什么不能只测 src/workspace.js:0.3.46 的坑不在解析函数里,而在**产物怎么拿输入** ——
// 它从 `useSessions(s => s).current` 里读"当前会话",而 DSH 0.1.6-alpha.2 把这个字段从
// SessionListState 移除了 ⇒ 客户端不再发 cwd ⇒ IDE 以空工作区启动(实测 pid.json 里 cwd 双空)。
// 纯函数测试对"喂什么形状"是无感的,只有真跑一遍注册出来的 React 组件、喂进两版 DSH 的
// 标准 prop 形状,才能钉住这条契约。
//
// 做法:用 scripts/client-bundle-harness.mjs 的"最小 DSH"把产物加载起来(它负责 window/document/
// fetch/react/slots 桩与渲染),拿到注册到 `sidebar.right.pane.tab` 的 body 与 `shell.overlay` 的
// 预热面,然后看两件事:① 它以什么 cwd 打 `POST /api/code-server/start`(0.3.46 漏掉的那一步);
// ② 它交给常驻 iframe 的 pageUrl(决定 workbench 用哪个 `?folder=` 打开)。
// 场景:DSH ≥ 0.1.6-alpha.2(sessionId 标准 prop)、≤ 0.1.6-alpha.1(快照上的 current)、换会话、
// 文件 tab(地址里的会话)、两版信源都没有(不得猜目录)、根作用域预热面。
//
// 产物缺失或比源码旧时 SKIP(exit 0)—— 与 test-webview-bundle.mjs 同一套约定:
// 没构建就"报绿"是假绿,但要的是显式的 SKIP 行,不是静默通过。
//
// 用法:node scripts/build-client.mjs && node scripts/test-client-bundle-cwd.mjs
import assert from 'node:assert/strict';
import { bundleStaleness, loadClientBundle } from './client-bundle-harness.mjs';

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

const stale = bundleStaleness();
if (stale !== null) {
  console.log(`SKIP ${stale};先跑 node scripts/build-client.mjs`);
  console.log('SUMMARY pass=0 fail=0 skip=1');
  process.exit(0);
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

const ALPHA2 = { ids: ['b'], byId: { b: { id: 'b', cwd: 'C:/work/beta' } }, phase: 'ready', subagentsByParent: {}, jobsBySession: {} };
const ALPHA1 = { ids: ['a'], byId: { a: { id: 'a', cwd: 'C:/work/alpha' } }, current: 'a', phase: 'ready' };
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

await test('DSH 0.1.6-alpha.2 形状:sessionId 标准 prop → /start 带 cwd 且 pageUrl 带 ?folder=', async () => {
  bundle.render(bodyReg.component, tabProps({ sessionId: 'b', sessions: ALPHA2, workspaces: NO_WS }));
  assert.equal(bundle.lastStartCwd(), 'C:/work/beta', '必须把该会话的工作区交给宿主(0.3.46 在这里漏了)');
  const src = bundle.surfaceSrc();
  assert.match(src, /\?s=9600/, '实例标记要在');
  assert.ok(src.includes(folderOf('C:/work/beta')), `folder 应是 /C:/work/beta,实际:${src}`);
});

await test('DSH 0.1.6-alpha.1 形状:快照上的 current 仍然认(向后兼容)', async () => {
  bundle.render(bodyReg.component, tabProps({ sessionId: undefined, sessions: ALPHA1, workspaces: NO_WS }));
  assert.equal(bundle.lastStartCwd(), 'C:/work/alpha');
  assert.ok(bundle.surfaceSrc().includes(folderOf('C:/work/alpha')), `实际:${bundle.surfaceSrc()}`);
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

await test('两版信源都没有 → 不猜目录(不发 cwd,pageUrl 不带 folder)', async () => {
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
