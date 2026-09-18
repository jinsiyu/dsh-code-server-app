// scripts/test-client-settings-seat.mjs —— "设置卡住在哪个座位"的产物级回归(0.3.50)
//
// 背景(真事):DSH **0.1.6-alpha.2** 把插件配置从"设置 → 插件"搬到**插件页**,`settings.plugin.item`
// 直接退役 —— 上游 agent note 的原话是"`settings.plugin.item` slot 退役"。我们(以及 profile 里
// 另外几个插件)仍然只注册旧座位 ⇒ 设置卡**静默消失**:没有报错、没有日志,页面里就是没有那块。
//
// 新座位契约(`plugins.bundle.config`,keyed / scope root):
//   · 键 = **组合包的包名**(插件页 `renderSlot(..., { entryKey: pkg.name })`),而插件页只在
//     `ledger.bundles.has(包名)` 时才渲染那一块 ⇒ 键写错 = 设置又不见了;
//   · owner props = `{ view: 'summary' | 'page' }`,bundle 配置区只用 `page`;
//   · 页面自己画标题/图标/面包屑,表单自带保存控件。
//
// 所以这里钉三件事(全部对**构建产物**验,而不是对源码):
//   ① 两个座位都注册、且 `slots.inject` 的半开语义让"每版 DSH 只有一个生效";
//   ② 新座位渲染出来的是**表单 + 保存控件**(不是旧的可折叠卡片:标题会与页面标题重复);
//   ③ `summary` 视图也答得起(契约要求 entry 两种视图都能渲染)。
//
// 用法:node scripts/build-client.mjs && node scripts/test-client-settings-seat.mjs
import assert from 'node:assert/strict';
import { DEFAULT_CLAIM_EXTENSIONS, normalizeClaimExtensions } from '../lib/claim-types.js';
import { bundleStaleness, classNamesOf, elementTypesOf, findElement, loadClientBundle, textOf } from './client-bundle-harness.mjs';

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

/** 一份插槽声明集:哪一版 DSH 声明了哪些座位,这里就是那次升级的全部差别。 */
const SEATS = {
  'alpha.2': ['sidebar.right.pane.tab', 'shell.overlay', 'plugins.bundle.config'],
  'alpha.1': ['sidebar.right.pane.tab', 'shell.overlay', 'settings.plugin.item'],
  'both': ['sidebar.right.pane.tab', 'shell.overlay', 'plugins.bundle.config', 'settings.plugin.item'],
  'neither': ['sidebar.right.pane.tab', 'shell.overlay'],
};

const entriesAt = (h, name) => h.registrations.filter((r) => r.desc.name === name);
const injectAt = (h, name) => h.injects.find((i) => i.name === name);

// ---------- DSH ≥ 0.1.6-alpha.2:注册到插件页的配置区 ----------
const alpha2 = loadClientBundle({ declaredSlots: SEATS['alpha.2'] });
const newEntries = entriesAt(alpha2, 'plugins.bundle.config');

await test('alpha.2:注册了 plugins.bundle.config,且键就是包名(插件页按 pkg.name 派发)', async () => {
  assert.equal(newEntries.length, 1, `应恰好注册一条,实际 ${newEntries.length}`);
  assert.equal(newEntries[0].desc.key, 'dsh-code-server-app');
});

await test('alpha.2:旧座位不再注册(它在新版已退役,注册了也不会被渲染)', async () => {
  assert.equal(entriesAt(alpha2, 'settings.plugin.item').length, 0);
});

await test('alpha.2:注册时把自己那份 settings scope 注入给表单', async () => {
  const injected = injectAt(alpha2, 'plugins.bundle.config');
  assert.ok(injected !== undefined, 'inject 应已回调');
  assert.equal(typeof injected.out, 'function', 'inject 工厂应返回 dispose 函数');
  const desc = newEntries[0].desc;
  assert.equal(typeof desc.inject, 'function', '注册项应带 inject(表单靠它拿 scope)');
  assert.equal(typeof desc.inject().scope.getSnapshot, 'function', 'inject 出来的 scope 要是 settings scope');
});

await test('alpha.2:page 视图渲染出三个设置项 + 自己的保存控件', async () => {
  const reg = newEntries[0];
  const scope = reg.desc.inject().scope;
  const tree = alpha2.render(reg.component, { view: 'page', scope });
  const text = textOf(tree);
  for (const label of ['认领类型', '打开即全屏', '后台常驻']) {
    assert.ok(text.includes(label), `表单里应有「${label}」,实际:${text.slice(0, 200)}`);
  }
  assert.ok(text.includes('保存'), '表单要自带保存控件');
  assert.ok(text.includes('放弃修改'), '表单要自带放弃控件');
});

await test('alpha.2:page 视图不是旧的可折叠卡片(页面已有标题,不该再套一层)', async () => {
  const reg = newEntries[0];
  const tree = alpha2.render(reg.component, { view: 'page', scope: reg.desc.inject().scope });
  const classes = classNamesOf(tree);
  assert.ok(classes.includes('dshcs-cfgpage'), `根应是 cfgpage,实际:${classes.join('|')}`);
  assert.ok(!classes.includes('dshcs-card'), '不应再渲染设置页那种卡片壳');
});

await test('alpha.2:summary 视图也答得起(契约要求同一 entry 两种视图都能渲染)', async () => {
  const reg = newEntries[0];
  const summary = alpha2.render(reg.component, { view: 'summary', scope: reg.desc.inject().scope });
  assert.equal(typeof summary, 'string', `summary 应是一句话,实际是 ${typeof summary}`);
  assert.ok(summary.includes('工作区'));
});

// ---------- 表单细节(0.3.52:输入框与它下面的提示都改成多行) ----------
await test('alpha.2:认领类型渲染成多行文本域,并按内容自动长高(不再是单行 input)', async () => {
  const reg = newEntries[0];
  const tree = alpha2.render(reg.component, { view: 'page', scope: reg.desc.inject().scope });
  const types = elementTypesOf(tree);
  assert.ok(types.includes('textarea'), '认领类型应是 textarea(默认值 98 条排除项,单行框看不到也改不动)');
  assert.equal(types.filter((t) => t === 'input').length, 2, '剩下的单行 input 只该是两个复选框(打开即全屏 / 后台常驻)');
  const area = findElement(tree, 'textarea');
  const rows = Number(area.props.rows);
  assert.ok(rows >= 8 && rows <= 12, `默认值(~700 字符)应自动长到 8-12 行,实际 rows=${rows}`);
  assert.equal(area.props.value, DEFAULT_CLAIM_EXTENSIONS, '文本域里应是当前生效值');
  assert.match(String(area.props.placeholder), /留空/, '占位文案改短:默认值另有提示块展示');
});

await test('alpha.2:下面的提示是多行(默认值按三组折行,不再一整行撑破卡片)', async () => {
  const reg = newEntries[0];
  const tree = alpha2.render(reg.component, { view: 'page', scope: reg.desc.inject().scope });
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

// ---------- DSH ≤ 0.1.6-alpha.1:继续用设置页的卡片 ----------
const alpha1 = loadClientBundle({ declaredSlots: SEATS['alpha.1'] });

await test('alpha.1:仍然注册 settings.plugin.item(旧版没有插件页配置区)', async () => {
  const old = entriesAt(alpha1, 'settings.plugin.item');
  assert.equal(old.length, 1);
  assert.equal(old[0].desc.key, 'code-server');
  assert.equal(entriesAt(alpha1, 'plugins.bundle.config').length, 0);
});

await test('alpha.1:旧座位渲染的仍是那张可折叠卡片(标题+描述在头部,保存控件在展开体里)', async () => {
  const reg = entriesAt(alpha1, 'settings.plugin.item')[0];
  const tree = alpha1.render(reg.component, { scope: reg.desc.inject().scope });
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
