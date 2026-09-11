// scripts/test-sidebar-fullscreen.mjs —— "打开即全屏右侧栏"动作的单元测试(桩 DOM)
//
// 为什么要有:这个动作靠点 ui-sidebar-right 自己的 chrome 按钮实现(插件拿不到模式 setter),
// 依赖两个 DOM 约定:body 的祖先里有 `[data-sidebar-right-panel]`、面板里有 `[data-sidebar-right-mode="fullscreen"]`。
// 约定漂移时必须"保持现状 + 回报原因",而不是抛错打断 React 渲染 —— 这里把四条失败路径钉死。
//
// 用法:node scripts/test-sidebar-fullscreen.mjs
import assert from 'node:assert/strict';

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

/** 桩节点:只实现本模块用到的部分。 */
function makePanel({ control }) {
  const panel = {
    selector: null,
    queried: [],
    querySelector(sel) { panel.queried.push(sel); return control === undefined ? null : control; },
  };
  return panel;
}
function makeRoot({ panel, closestThrows }) {
  return {
    closestCalls: [],
    closest(sel) {
      this.closestCalls.push(sel);
      if (closestThrows === true) throw new Error('boom');
      return panel === undefined ? null : panel;
    },
  };
}
function makeControl({ clicks, throws }) {
  return {
    click() { clicks.push(1); if (throws === true) throw new Error('handler boom'); },
  };
}

const mod = await import('../src/sidebar-mode.js');

await test('找到按钮时点一次,返回 clicked(作用域只在自己面板内)', async () => {
  const clicks = [];
  const control = makeControl({ clicks });
  const other = { queried: 0, querySelector() { other.queried += 1; return control; } };
  const panel = makePanel({ control });
  const root = makeRoot({ panel });
  assert.equal(mod.requestFullscreenPanel(root), 'clicked');
  assert.equal(clicks.length, 1, '按钮必须被点一次');
  assert.deepEqual(root.closestCalls, ['[data-sidebar-right-panel]'], '必须按面板属性向上找');
  assert.deepEqual(panel.queried, ['[data-sidebar-right-mode="fullscreen"]'], '必须按模式属性找按钮');
  assert.equal(other.queried, 0, '不得在别的面板里找');
});

await test('无 root(还没挂载)→ no-root,不抛', async () => {
  assert.equal(mod.requestFullscreenPanel(null), 'no-root');
  assert.equal(mod.requestFullscreenPanel(undefined), 'no-root');
  assert.equal(mod.requestFullscreenPanel({}), 'no-root');
});

await test('向上找不到面板(body 不在侧栏里)→ no-panel,不抛', async () => {
  assert.equal(mod.requestFullscreenPanel(makeRoot({ panel: undefined })), 'no-panel');
});

await test('已在全屏(按钮不存在)→ no-control,且不抛', async () => {
  const panel = makePanel({ control: undefined });
  assert.equal(mod.requestFullscreenPanel(makeRoot({ panel })), 'no-control');
});

await test('按钮 click 抛错 → click-failed(异常不外泄)', async () => {
  const clicks = [];
  const control = makeControl({ clicks, throws: true });
  const panel = makePanel({ control });
  assert.equal(mod.requestFullscreenPanel(makeRoot({ panel })), 'click-failed');
  assert.equal(clicks.length, 1, '确实点过(异常发生在 handler 里)');
});

await test('closest 抛错 → lookup-failed(不打断面板渲染)', async () => {
  let threw = false;
  let result = null;
  try {
    result = mod.requestFullscreenPanel({ closest() { throw new Error('boom'); } });
  } catch { threw = true; }
  assert.equal(threw, false, '不得把异常抛给 layout effect');
  assert.equal(result, 'lookup-failed');
});

await test('querySelector 抛错 → lookup-failed(不打断面板渲染)', async () => {
  const panel = { querySelector() { throw new Error('boom'); } };
  assert.equal(mod.requestFullscreenPanel(makeRoot({ panel })), 'lookup-failed');
});

console.log(`SUMMARY pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
