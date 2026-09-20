// scripts/test-client-bundle-tabs.mjs —— "DSH 侧只有一个 code-server 标签页"(0.3.57,用户要求)
//
// 契约在**浏览器侧**:官方的标签页身份就是**地址**(SidebarRightTabClaim.contentId 的注释:
// "Stable identity of the content, which is the address itself. Two opens of the same address are
// the same tab"),所以点另一个文件必然新开一个标签页;而 `replaceTab` 只有发起方(产品自己的
// openFile)能传 —— 插件唯一能做的是"新标签页挂载时收掉同窗格里的旧标签页"。
// 这条规则写在 lib/client.js 的 CodeServerBody 段里(0.3.58 起入口是手写源码,没有构建产物),
// 只有把它真渲染一遍才验得到。
//
// 守四件事:
//   T1 新标签页(可见)挂载 ⇒ 同窗格里旧的被收掉(收掉的是**旧的**,新的一直在);
//   T2 不同窗格互不影响(多窗格是用户主动切的布局,官方自己也是"每窗格一份");
//   T3 新标签页还**不可见**时不收任何人(标签页恢复顺序不可控,免得乒乓);
//   T4 没有 actions / panel 的老形状不至于把 body 弄挂(缺服务时退化成"多一个标签页"而不是崩)。
//
// **每个用例都重新 loadClientBundle()**:标签页"座位"登记在入口的**模块作用域**里,而 harness 不跑
// unmount 清理 ⇒ 共用一份会让上一个用例的座位泄漏到下一个用例(第一版就是这么假红的)。
//
// 用法:node scripts/test-client-bundle-tabs.mjs
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

const SESSIONS = { ids: ['s'], byId: { s: { id: 's', cwd: 'C:/work/repo' } }, phase: 'ready' };
const NO_WS = { items: [], state: 'idle', phase: 'ready', error: null };

/** 每个用例一份新的产物 + 它自己的"关掉本标签页"记录。 */
function fresh() {
  const bundle = loadClientBundle({ declaredSlots: ['sidebar.right.pane.tab', 'shell.overlay'] });
  const body = bundle.registrations.find((r) => r.desc.name === 'sidebar.right.pane.tab');
  const closed = [];
  const render = ({ id, pane, visible = true, address = 'sidebar://code-server' }) => bundle.render(body.component, {
    sessionId: 's',
    useSessions: (selector) => selector(SESSIONS),
    useWorkspaces: (selector) => selector(NO_WS),
    useTabInfo: () => ({
      tab: {
        id,
        visible,
        navigation: { address, revision: 0 },
        actions: { close: () => { closed.push(id) } },
      },
      panel: { id: pane },
      sidebar: { fullscreen: true },
    }),
  });
  return { bundle, body, closed, render };
}

/** apply 期的 /status 预取先落地(store 里要有 running 状态,body 才渲染停靠位)。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

await test('注册面:body 仍然挂在 sidebar.right.pane.tab(回收逻辑不许把注册挤掉)', async () => {
  const { body } = fresh();
  assert.ok(body, '应注册 sidebar.right.pane.tab 的 body');
  assert.equal(body.desc.key, 'dsh-code-server-app');
});

await test('T1:新文件标签页(同窗格、可见)挂载 ⇒ 旧的那个被收掉,只留最新一个', async () => {
  const { render, closed } = fresh();
  await settle();
  render({ id: 'tab-page', pane: 'p1' });                       // 从 guide 打开的页面标签页
  assert.deepEqual(closed, [], '第一个标签页没有兄弟可收');
  render({ id: 'tab-file-a', pane: 'p1', address: 'dsh-resource://file/session/s/C:/work/repo/src/a.ts' });
  assert.deepEqual(closed, ['tab-page'], '旧的 code-server 标签页必须被收掉(只留一个)');
  render({ id: 'tab-file-b', pane: 'p1', address: 'dsh-resource://file/session/s/C:/work/repo/src/b.ts' });
  assert.deepEqual(closed, ['tab-page', 'tab-file-a'], '连续打开只留最新一个');
  assert.equal(closed.includes('tab-file-b'), false, '新的那个不许把自己关掉');
});

await test('T2:不同窗格互不影响(用户主动切分时每窗格各留一个)', async () => {
  const { render, closed } = fresh();
  await settle();
  render({ id: 'tab-p1', pane: 'p1' });
  render({ id: 'tab-p2', pane: 'p2' });
  assert.deepEqual(closed, [], '另一个窗格里的标签页不该被收掉');
  render({ id: 'tab-p2b', pane: 'p2' });
  assert.deepEqual(closed, ['tab-p2'], '只收同窗格里的旧标签页');
});

await test('T3:不可见的新标签页不收任何人(避免恢复标签页时互相收)', async () => {
  const { render, closed } = fresh();
  await settle();
  render({ id: 'tab-visible', pane: 'p1' });
  closed.length = 0;
  render({ id: 'tab-hidden', pane: 'p1', visible: false });
  assert.deepEqual(closed, [], '还没被激活(不可见)时不许收别人');
});

await test('T4:缺 actions / panel 的老形状不炸(退化成"多一个标签页"而不是崩)', async () => {
  const { bundle, body, closed } = fresh();
  await settle();
  const legacy = {
    sessionId: 's',
    useSessions: (selector) => selector(SESSIONS),
    useWorkspaces: (selector) => selector(NO_WS),
    // 老版 DSH:tab 上没有 actions,也没有 panel
    useTabInfo: () => ({ tab: { id: 'tab-legacy', visible: true, navigation: { address: 'sidebar://code-server', revision: 0 } }, sidebar: { fullscreen: true } }),
  };
  assert.doesNotThrow(() => bundle.render(body.component, legacy));
  assert.deepEqual(closed, [], '拿不到 close 时不该乱关(也关不掉)');
  assert.match(bundle.surfaceSrc(), /\?s=9600/, 'IDE 面照样要停靠(功能不受影响)');
});

console.log(`SUMMARY pass=${pass} fail=${fail} skip=0`);
process.exit(fail === 0 ? 0 : 1);
