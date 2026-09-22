// scripts/test-client-settings-seat.mjs —— "设置卡住在哪个座位"的入口级回归(0.3.50)
//
// 背景(真事):DSH **0.1.6-alpha.2**(alpha 线)把插件配置从"设置 → 插件"搬到**插件页**,`settings.plugin.item`
// 直接退役 —— 上游 agent note 的原话是"`settings.plugin.item` slot 退役"。我们(以及 profile 里
// 另外几个插件)仍然只注册旧座位 ⇒ 设置卡**静默消失**:没有报错、没有日志,页面里就是没有那块。
//
// 新座位契约(`plugins.bundle.config`,keyed / scope root):
//   · 键 = **组合包的包名**(插件页 `renderSlot(..., { entryKey: pkg.name })`),而插件页只在
//     `ledger.bundles.has(包名)` 时才渲染那一块 ⇒ 键写错 = 设置又不见了;
//   · owner props = `{ view: 'summary' | 'page' }`,bundle 配置区只用 `page`;
//   · 页面自己画标题/图标/面包屑,表单自带保存控件。
//
// 所以这里钉三件事(全部对**客户端入口** lib/client.js 验,而不是对某个中间产物):
//   ① 两个座位都注册、且 `slots.inject` 的半开语义让"每版 DSH 只有一个生效" —— 本插件支持的只有两条线:
//      · **rc 线** 0.1.5-rc.x(最新 0.1.5-rc.3)= 声明 `settings.plugin.item`;
//      · **alpha 线** ≥ 0.1.6-alpha.2(最新 0.1.7-alpha.1)= 声明 `plugins.bundle.config`。
//      更早的 alpha 不单独支持(形状与 rc 线相同,不是另一套契约)。
//   ② 新座位渲染出来的是**表单 + 保存控件**(不是旧的可折叠卡片:标题会与页面标题重复);
//   ③ `summary` 视图也答得起(契约要求 entry 两种视图都能渲染)。
//
// 用法:node scripts/test-client-settings-seat.mjs
import assert from 'node:assert/strict';
import { DEFAULT_CLAIM_EXTENSIONS, normalizeClaimExtensions } from '../lib/claim-types.js';
import { classNamesOf, elementTypesOf, findElement, loadClientBundle, textOf } from './client-bundle-harness.mjs';

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

/** 一份插槽声明集:两条支持线各自声明了哪个座位 —— 这里就是它们之间的全部差别。 */
const SEATS = {
  'latest': ['sidebar.right.pane.tab', 'shell.overlay', 'plugins.bundle.config'],
  'rc': ['sidebar.right.pane.tab', 'shell.overlay', 'settings.plugin.item'],
  'both': ['sidebar.right.pane.tab', 'shell.overlay', 'plugins.bundle.config', 'settings.plugin.item'],
  'neither': ['sidebar.right.pane.tab', 'shell.overlay'],
};

const entriesAt = (h, name) => h.registrations.filter((r) => r.desc.name === name);
const injectAt = (h, name) => h.injects.find((i) => i.name === name);

/** 找第一个满足谓词的宿主元素(harness 的 findElement 只按类型找,数字输入要按 props 找)。 */
function findInputBy(tree, predicate) {
  if (tree === null || tree === undefined || typeof tree !== 'object') return null;
  if (Array.isArray(tree)) {
    for (const item of tree) {
      const hit = findInputBy(item, predicate);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (tree.type === 'input' && predicate(tree.props) === true) return tree;
  return tree.props === undefined ? null : findInputBy(tree.props.children, predicate);
}

// ---------- alpha 线(DSH ≥ 0.1.6-alpha.2,含最新 0.1.7-alpha.1):注册到插件页的配置区 ----------
const latestLine = loadClientBundle({ declaredSlots: SEATS['latest'] });
const newEntries = entriesAt(latestLine, 'plugins.bundle.config');

await test('最新线:注册了 plugins.bundle.config,且键就是包名(插件页按 pkg.name 派发)', async () => {
  assert.equal(newEntries.length, 1, `应恰好注册一条,实际 ${newEntries.length}`);
  assert.equal(newEntries[0].desc.key, 'dsh-code-server-app');
});

await test('最新线:旧座位不再注册(它在新版已退役,注册了也不会被渲染)', async () => {
  assert.equal(entriesAt(latestLine, 'settings.plugin.item').length, 0);
});

await test('最新线:注册时把自己那份 settings scope 注入给表单', async () => {
  const injected = injectAt(latestLine, 'plugins.bundle.config');
  assert.ok(injected !== undefined, 'inject 应已回调');
  assert.equal(typeof injected.out, 'function', 'inject 工厂应返回 dispose 函数');
  const desc = newEntries[0].desc;
  assert.equal(typeof desc.inject, 'function', '注册项应带 inject(表单靠它拿 scope)');
  assert.equal(typeof desc.inject().scope.getSnapshot, 'function', 'inject 出来的 scope 要是 settings scope');
});

await test('最新线:page 视图渲染出三个设置项 + 自己的保存控件', async () => {
  const reg = newEntries[0];
  const scope = reg.desc.inject().scope;
  const tree = latestLine.render(reg.component, { view: 'page', scope });
  const text = textOf(tree);
  for (const label of ['认领类型', '打开即全屏', '后台常驻']) {
    assert.ok(text.includes(label), `表单里应有「${label}」,实际:${text.slice(0, 200)}`);
  }
  assert.ok(text.includes('保存'), '表单要自带保存控件');
  assert.ok(text.includes('放弃修改'), '表单要自带放弃控件');
});

await test('最新线:page 视图不是旧的可折叠卡片(页面已有标题,不该再套一层)', async () => {
  const reg = newEntries[0];
  const tree = latestLine.render(reg.component, { view: 'page', scope: reg.desc.inject().scope });
  const classes = classNamesOf(tree);
  assert.ok(classes.includes('dshcs-cfgpage'), `根应是 cfgpage,实际:${classes.join('|')}`);
  assert.ok(!classes.includes('dshcs-card'), '不应再渲染设置页那种卡片壳');
});

await test('最新线:summary 视图也答得起(契约要求同一 entry 两种视图都能渲染)', async () => {
  const reg = newEntries[0];
  const summary = latestLine.render(reg.component, { view: 'summary', scope: reg.desc.inject().scope });
  assert.equal(typeof summary, 'string', `summary 应是一句话,实际是 ${typeof summary}`);
  assert.ok(summary.includes('工作区'));
});

// ---------- 表单细节(0.3.52:输入框与它下面的提示都改成多行) ----------
await test('最新线:认领类型渲染成多行文本域,并按内容自动长高(不再是单行 input)', async () => {
  const reg = newEntries[0];
  const tree = latestLine.render(reg.component, { view: 'page', scope: reg.desc.inject().scope });
  const types = elementTypesOf(tree);
  assert.ok(types.includes('textarea'), '认领类型应是 textarea(默认值 98 条排除项,单行框看不到也改不动)');
  assert.equal(types.filter((t) => t === 'input').length, 5, '单行 input 是四个复选框(打开即全屏 / FIM 补全 / 允许多行 / 后台常驻)+ 一个数字输入(停顿毫秒数)');
  const area = findElement(tree, 'textarea');
  const rows = Number(area.props.rows);
  assert.ok(rows >= 8 && rows <= 12, `默认值(~700 字符)应自动长到 8-12 行,实际 rows=${rows}`);
  assert.equal(area.props.value, DEFAULT_CLAIM_EXTENSIONS, '文本域里应是当前生效值');
  assert.match(String(area.props.placeholder), /留空/, '占位文案改短:默认值另有提示块展示');
});

await test('0.3.61:FIM 补全项在卡片上,写明"实验性 / 默认关闭 / 会外发代码"', async () => {
  const reg = newEntries[0];
  const tree = latestLine.render(reg.component, { view: 'page', scope: reg.desc.inject().scope });
  const text = textOf(tree);
  assert.ok(text.includes('FIM 补全(实验性)'), '设置项标题必须带"实验性"字样');
  assert.ok(text.includes('默认关闭'), '必须写明默认关闭');
  assert.ok(text.includes('唯一会把内容发出去'), '必须写明它是本插件唯一外发内容的能力(隐私边界要写在用户看得见的地方)');
  assert.ok(text.includes('不计入 DSH'), '必须写明这条调用不进 DSH 的 token 计量(否则用户会在账单与界面之间困惑)');
});

await test('0.3.62:FIM 的三个子项在卡片上(停顿毫秒数 / 允许多行 / 按 glob 禁用)', async () => {
  const reg = newEntries[0];
  const tree = latestLine.render(reg.component, { view: 'page', scope: reg.desc.inject().scope });
  const text = textOf(tree);
  assert.ok(text.includes('停顿毫秒数'), '要有停顿毫秒数这一行');
  assert.ok(text.includes('允许多行补全'), '要有多行开关');
  assert.ok(text.includes('按 glob 禁用'), '要有按 glob 禁用这一行');
  assert.ok(text.includes('100–3000ms'), '停顿的范围要写在用户看得见的地方');
  assert.ok(text.includes('扩展侧先判'), '要说清 glob 是两边都判(扩展不发请求 + 宿主再判一遍)');
  const numberInput = findInputBy(tree, (p) => p !== undefined && p.type === 'number');
  assert.ok(numberInput !== null, '停顿毫秒数要渲染成数字输入(type=number)');
  assert.equal(numberInput.props.min, 100, 'min 要与宿主 clampDebounce 的下限一致');
  assert.equal(numberInput.props.max, 3000, 'max 要与宿主 clampDebounce 的上限一致');
  assert.equal(Number(numberInput.props.value), 250, '默认值 250ms');
  // glob 那一行必须是多行文本域(与"认领类型"同一形态,清单会长)
  assert.equal(elementTypesOf(tree).includes('textarea'), true, 'glob 清单用 textarea');
});

await test('最新线:下面的提示是多行(默认值按三组折行,不再一整行撑破卡片)', async () => {  const reg = newEntries[0];
  const tree = latestLine.render(reg.component, { view: 'page', scope: reg.desc.inject().scope });
  const text = textOf(tree);
  assert.ok(text.includes('实际规则:'), '「实际规则」一行要在');
  assert.ok(text.includes('默认值(可整段复制'), '默认值提示块要在');
  const code = findElement(tree, 'code');
  assert.ok(code !== null, '默认值应以代码块展示');
  assert.equal(code.props['data-claim-default'], 'lines');
  const lines = String(code.props.children).split('\n').filter((line) => line !== '');
  assert.ok(lines.length >= 4, `默认值应折成多行(* + 三组),实际 ${lines.length} 行`);
  assert.equal(lines[0], '*');
  for (const marker of ['!md', '!exe', '!docx']) {
    assert.ok(lines.some((line) => line.includes(marker)), `默认值里应有 ${marker}`);
  }
  // 折行后的文本当策略解析,必须与官方默认值**逐字相同**(解析器把换行与分号一视同仁)
  assert.equal(normalizeClaimExtensions(String(code.props.children)), DEFAULT_CLAIM_EXTENSIONS);
});

// ---------- rc 线(DSH ≤ 0.1.5-rc.3,含最新 rc):继续用设置页的卡片 ----------
const rcLine = loadClientBundle({ declaredSlots: SEATS['rc'] });

await test('rc 线:仍然注册 settings.plugin.item(旧版没有插件页配置区)', async () => {
  const old = entriesAt(rcLine, 'settings.plugin.item');
  assert.equal(old.length, 1);
  assert.equal(old[0].desc.key, 'code-server');
  assert.equal(entriesAt(rcLine, 'plugins.bundle.config').length, 0);
});

await test('rc 线:旧座位渲染的仍是那张可折叠卡片(标题+描述在头部,保存控件在展开体里)', async () => {
  const reg = entriesAt(rcLine, 'settings.plugin.item')[0];
  const tree = rcLine.render(reg.component, { scope: reg.desc.inject().scope });
  const classes = classNamesOf(tree);
  assert.ok(classes.includes('dshcs-card'), `应渲染卡片壳,实际:${classes.join('|')}`);
  const text = textOf(tree);
  assert.ok(text.includes('Code Server'), `卡片头部应有标题,实际:${text.slice(0, 120)}`);
  assert.ok(classes.includes('dshcs-cardHeader'), '头部应是可点开的折叠头');
});

// ---------- 两个座位都在 / 都不在 ----------
await test('两个座位都被声明时各自注册(不会互相顶掉,也不会重复渲染同一个视线)', async () => {
  const both = loadClientBundle({ declaredSlots: SEATS['both'] });
  assert.equal(entriesAt(both, 'plugins.bundle.config').length, 1);
  assert.equal(entriesAt(both, 'settings.plugin.item').length, 1);
});

await test('没有任何设置座位时不报错、不注册(极旧 DSH)', async () => {
  const none = loadClientBundle({ declaredSlots: SEATS['neither'] });
  assert.equal(entriesAt(none, 'plugins.bundle.config').length, 0);
  assert.equal(entriesAt(none, 'settings.plugin.item').length, 0);
  assert.equal(entriesAt(none, 'sidebar.right.pane.tab').length, 1, '侧栏标签不受影响');
});

console.log(`SUMMARY pass=${pass} fail=${fail} skip=0`);
process.exit(fail === 0 ? 0 : 1);
