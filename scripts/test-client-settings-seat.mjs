// scripts/test-client-settings-seat.mjs —— "设置面住在哪个座位、数据从哪条通道来"的入口级回归
//
// 背景(两次真事):
//   · 0.3.50:DSH **0.1.6-alpha.2** 把插件配置从"设置 → 插件"搬到**插件页**,`settings.plugin.item`
//     直接退役 —— 只注册旧座位 ⇒ 设置卡**静默消失**(没有报错、没有日志)。
//   · 0.3.66:DSH **0.1.7-alpha.1** 又把**数据通道**换掉了 —— 客户端服务 `settingsScope` 被删除,
//     改名/改模型为 `configForms`(`ctx.configForms.get(entryId)`,配置就是**插件条目自己的 Config`)。
//     本插件的 `inject` 当时还是 `['slots','settingsScope']` ⇒ 客户端条目**永远 pending**,
//     表现是右侧栏标签、设置卡、常驻预热**一起消失**,启动日志只有一句
//     `web boot: 1 entry did not activate` / `pending (waiting for service: settingsScope)`。
//
// 所以这里按**两条独立的轴**参数化,并把三种真实组合都钉住:
//   座位(声明驱动,`slots.inject` 只在插槽被声明时才回调):
//     · `plugins.bundle.config`(≥ 0.1.6-alpha.2,键 = **包名**)—— 页面自带标题/面包屑,我们只出表单 + 保存控件;
//     · `settings.plugin.item`(rc ≤ 0.1.5-rc.3,键 `code-server`)—— 设置页里的自绘可折叠卡片。
//   通道(能力探测,`configForms` 在就用新的,否则回退 `settingsScope`):
//     · 新 `ctx.configForms.get(...)`:写路径**只有** `mutate(ops, revision)`(原子、带 revision 栅栏),
//       注册还要经 `whileServed([entryId], …)` 门禁;
//     · 旧 `ctx.settingsScope.bind({namespace})`:逐字段 set/unset。
//   ① {旧座位, 旧通道} = rc 0.1.5-rc.x;② {新座位, 旧通道} = **0.1.6-alpha.2**;③ {新座位, 新通道} = ≥ 0.1.7-alpha.1。
//
// 外加一条**注入守卫**:两条线的真实服务集都必须能满足入口的静态 `inject`
// (`missingInject` 为空且 `applied` 为 true)—— 这正是本次故障的判据。
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
  latest: ['sidebar.right.pane.tab', 'shell.overlay', 'plugins.bundle.config'],
  rc: ['sidebar.right.pane.tab', 'shell.overlay', 'settings.plugin.item'],
  both: ['sidebar.right.pane.tab', 'shell.overlay', 'plugins.bundle.config', 'settings.plugin.item'],
  neither: ['sidebar.right.pane.tab', 'shell.overlay'],
};
/** 通道集:宿主提供哪些设置服务(0.1.7-alpha.1 起没有 settingsScope)。 */
const CHANNELS = {
  scope: { configForms: false, settingsScope: true }, // rc 线 + 0.1.6-alpha.2
  forms: { configForms: true, settingsScope: false }, // ≥ 0.1.7-alpha.1
};

const entriesAt = (h, name) => h.registrations.filter((r) => r.desc.name === name);
const injectAt = (h, name) => h.injects.find((i) => i.name === name);
const load = (seat, channel, extra = {}) => loadClientBundle({
  declaredSlots: SEATS[seat], ...CHANNELS[channel], ...extra,
});
/** 打开新通道那页的 props(像真壳层那样把注入面物化成 hooks + actions)。 */
function pageProps(h, reg, extra = {}) {
  return h.propsOf(reg, Object.assign({ view: 'page' }, extra));
}

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

// ================================================================ 注入守卫(本次故障的判据)

await test('注入守卫:两条线的真实服务集都满足入口的静态 inject(缺一个 ⇒ 条目 pending、整块 UI 消失)', async () => {
  // 真实组合:rc 线(旧座位+旧通道)、0.1.6-alpha.2(新座位+旧通道)、0.1.7-alpha.1(新座位+新通道)。
  const real = [['rc', 'scope'], ['latest', 'scope'], ['latest', 'forms']];
  for (const [seat, channel] of real) {
    const h = load(seat, channel);
    assert.deepEqual(h.missingInject, [], `{${seat},${channel}} 的服务集满足不了 inject ⇒ 条目永远 pending`);
    assert.equal(h.applied, true, `{${seat},${channel}} 应当真的 apply`);
    for (const name of h.exports.inject) {
      assert.ok(h.services.has(name), `inject 里的 ${name} 不是两条线都有的服务(服务集:${[...h.services].join(',')})`);
    }
    assert.deepEqual(h.exports.inject, ['slots'], 'inject 只留普遍存在的 slots;两个通道服务必须运行时探测');
  }
});

await test('注入守卫:座位 × 通道的 8 种组合全部可 apply(座位与通道是两条独立的轴)', async () => {
  for (const seat of Object.keys(SEATS)) {
    for (const channel of Object.keys(CHANNELS)) {
      const h = load(seat, channel);
      assert.deepEqual(h.missingInject, [], `{${seat},${channel}} 缺服务:${h.missingInject.join(',')}`);
      assert.equal(h.applied, true, `{${seat},${channel}} 应当真的 apply`);
      // 侧栏标签不受设置那条轴的影响(0.3.66 之前的那次线上故障里,它被一起带走了)。
      assert.equal(entriesAt(h, 'sidebar.right.pane.tab').length, 1, `{${seat},${channel}} 侧栏标签必须照旧注册`);
    }
  }
});

await test('通道服务在 ctx 上不是属性:harness 对未声明服务做"属性访问即抛",插件两条线都照常起来', async () => {
  // harness 把这两个通道服务从 ctx 属性里拿掉(只留 ctx.get)—— 与 DSH 对"未在 inject 里声明的服务"
  // 的行为一致。于是插件里任何 `ctx.configForms` / `ctx.settingsScope` 的写法都会在 apply 期当场抛,
  // 连带侧栏标签与常驻预热一起注册不出来(下面那条断言就是那个信号)。
  const h = load('latest', 'forms');
  assert.throws(() => h.ctx.settingsScope, /只能经 ctx\.get/, '未声明的服务属性访问必须抛(harness 与 DSH 同行为)');
  assert.throws(() => h.ctx.configForms, /只能经 ctx\.get/, '通道服务即便可用也不做成属性:它不能进 inject');
  assert.equal(h.services.has('configForms'), true, '但它必须能经 ctx.get 拿到');
  for (const [seat, channel] of [['latest', 'forms'], ['rc', 'scope']]) {
    const line = load(seat, channel);
    assert.equal(entriesAt(line, 'sidebar.right.pane.tab').length, 1,
      `{${seat},${channel}} 侧栏标签没注册 ⇒ 很可能用了 ctx.<service> 属性访问`);
    assert.equal(entriesAt(line, 'shell.overlay').length, 1, '常驻预热同样要注册');
  }
});

// ================================================================ 新通道 ≥ 0.1.7-alpha.1

const newLine = load('latest', 'forms', { configServed: false });

await test('新线:注册被 whileServed 门禁挡住(宿主还没服务这个条目 ⇒ 页面不留痕迹)', async () => {
  assert.equal(entriesAt(newLine, 'plugins.bundle.config').length, 0, '门禁未通过时不许注册');
  assert.deepEqual(newLine.forms.calls.whileServed, [['code-server']], '门禁观察的命名空间必须是条目 id');
  assert.equal(entriesAt(newLine, 'settings.plugin.item').length, 0, '新线没有旧座位');
  newLine.setConfigServed(['code-server']);
});

await test('新线:门禁通过后注册进 plugins.bundle.config,键是包名,注入面是 hooks + actions', async () => {
  const list = entriesAt(newLine, 'plugins.bundle.config');
  assert.equal(list.length, 1, `应恰好注册一条,实际 ${list.length}`);
  assert.equal(list[0].desc.key, 'dsh-code-server-app', '插件页按 pkg.name 派发,键写错 = 设置又不见了');
  const injected = injectAt(newLine, 'plugins.bundle.config');
  assert.ok(injected !== undefined, 'inject 应已回调');
  const face = list[0].desc.inject();
  assert.equal(typeof face.hooks.codeServerForm.subscribe, 'function', '注入面要带 hooks.codeServerForm(快照源)');
  assert.equal(typeof face.hooks.codeServerForm.getSnapshot, 'function');
  assert.deepEqual(Object.keys(face).filter((k) => k !== 'hooks').sort(), ['discard', 'edit', 'resetField', 'save']);
  for (const action of ['edit', 'resetField', 'save', 'discard']) {
    assert.equal(typeof face[action], 'function', `${action} 必须是 action prop`);
  }
  assert.equal(newLine.forms.calls.get[0], 'code-server', '表单按条目 id 取(configForms.get)');
});

await test('新线:page 视图渲染出全部设置项 + 自己的保存控件,且不是旧的可折叠卡片', async () => {
  const reg = entriesAt(newLine, 'plugins.bundle.config')[0];
  const tree = newLine.render(reg.component, pageProps(newLine, reg));
  const text = textOf(tree);
  for (const label of ['认领类型', '打开即全屏', '后台常驻']) {
    assert.ok(text.includes(label), `表单里应有「${label}」,实际:${text.slice(0, 200)}`);
  }
  assert.ok(text.includes('保存'), '表单要自带保存控件');
  assert.ok(text.includes('放弃修改'), '表单要自带放弃控件');
  const classes = classNamesOf(tree);
  assert.ok(classes.includes('dshcs-cfgpage'), `根应是 cfgpage,实际:${classes.join('|')}`);
  assert.ok(!classes.includes('dshcs-card'), '不应再渲染设置页那种卡片壳');
});

await test('新线:summary 视图也答得起(契约要求同一 entry 两种视图都能渲染)', async () => {
  const reg = entriesAt(newLine, 'plugins.bundle.config')[0];
  const summary = newLine.render(reg.component, newLine.propsOf(reg, { view: 'summary' }));
  assert.equal(typeof summary, 'string', `summary 应是一句话,实际是 ${typeof summary}`);
  assert.ok(summary.includes('工作区'));
});

await test('新线:认领类型渲染成多行文本域,并按内容自动长高(不再是单行 input)', async () => {
  const reg = entriesAt(newLine, 'plugins.bundle.config')[0];
  const tree = newLine.render(reg.component, pageProps(newLine, reg));
  const types = elementTypesOf(tree);
  assert.ok(types.includes('textarea'), '认领类型应是 textarea(默认值 98 条排除项,单行框看不到也改不动)');
  assert.equal(types.filter((t) => t === 'input').length, 5, '单行 input 是四个复选框(打开即全屏 / FIM 补全 / 允许多行 / 后台常驻)+ 一个数字输入(停顿毫秒数)');
  const area = findElement(tree, 'textarea');
  const rows = Number(area.props.rows);
  assert.ok(rows >= 8 && rows <= 12, `默认值(~700 字符)应自动长到 8-12 行,实际 rows=${rows}`);
  assert.equal(area.props.value, DEFAULT_CLAIM_EXTENSIONS, '文本域里应是当前生效值');
  assert.match(String(area.props.placeholder), /留空/, '占位文案改短:默认值另有提示块展示');
});

await test('0.3.61:FIM 补全项在配置区里,写明"实验性 / 默认关闭 / 会外发代码"', async () => {
  const reg = entriesAt(newLine, 'plugins.bundle.config')[0];
  const text = textOf(newLine.render(reg.component, pageProps(newLine, reg)));
  assert.ok(text.includes('FIM 补全(实验性)'), '设置项标题必须带"实验性"字样');
  assert.ok(text.includes('默认关闭'), '必须写明默认关闭');
  assert.ok(text.includes('唯一会把内容发出去'), '必须写明它是本插件唯一外发内容的能力(隐私边界要写在用户看得见的地方)');
  assert.ok(text.includes('不计入 DSH'), '必须写明这条调用不进 DSH 的 token 计量(否则用户会在账单与界面之间困惑)');
});

await test('0.3.62:FIM 的三个子项在配置区里(停顿毫秒数 / 允许多行 / 按 glob 禁用)', async () => {
  const reg = entriesAt(newLine, 'plugins.bundle.config')[0];
  const tree = newLine.render(reg.component, pageProps(newLine, reg));
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

await test('新线:下面的提示是多行(默认值按三组折行,不再一整行撑破卡片)', async () => {
  const reg = entriesAt(newLine, 'plugins.bundle.config')[0];
  const tree = newLine.render(reg.component, pageProps(newLine, reg));
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

await test('新线:保存走**唯一写路径** mutate(一次原子提交全部暂存编辑 + revision 栅栏),不碰 set/unset', async () => {
  const h = load('latest', 'forms');
  const reg = entriesAt(h, 'plugins.bundle.config')[0];
  const props = pageProps(h, reg);
  // 两处编辑:一个文本、一个数字(都要归一化后再写)
  props.edit('claimExtensions', ' py ; ts ');
  props.edit('fimDebounceMs', '999');
  props.edit('fim', true);
  const landed = await props.save();
  assert.equal(landed, true, 'save 应返回宿主的接受结果');
  assert.equal(h.forms.calls.mutate.length, 1, '保存必须恰好一次 mutate(原子)');
  assert.deepEqual(h.forms.calls.mutate[0].ops, [
    { op: 'set', path: ['claimExtensions'], value: 'py;ts' },
    { op: 'set', path: ['fim'], value: true },
    { op: 'set', path: ['fimDebounceMs'], value: 999 },
  ], 'op 顺序与归一化后的值都要对');
  assert.equal(h.forms.calls.mutate[0].revision, 7, '要带上暂存起点读到的 revision(冲突栅栏)');
  assert.equal(h.forms.calls.set.length, 0, '新通道不许用 set(它不是原子路径)');
  assert.equal(h.forms.calls.unset.length, 0, '新通道不许用 unset');
});

await test('新线:草稿与存量等价时不写(避免"看起来没改却写了一次")', async () => {
  const h = load('latest', 'forms');
  const reg = entriesAt(h, 'plugins.bundle.config')[0];
  const props = pageProps(h, reg);
  props.edit('claimExtensions', DEFAULT_CLAIM_EXTENSIONS); // 抄回来:归一化后与存量相同
  props.edit('fimDebounceMs', '250');
  assert.equal(await props.save(), false, '没有真实改动 ⇒ 不发写');
  assert.equal(h.forms.calls.mutate.length, 0);
});

await test('新线:"恢复默认"提交 unset(移除覆盖层、回落继承),而不是写一个默认值', async () => {
  const h = load('latest', 'forms', { formSnapshot: { value: { claimExtensions: 'py' }, user: { claimExtensions: 'py' } } });
  const reg = entriesAt(h, 'plugins.bundle.config')[0];
  const props = pageProps(h, reg);
  props.resetField('claimExtensions');
  assert.equal(await props.save(), true);
  assert.deepEqual(h.forms.calls.mutate[0].ops, [{ op: 'unset', path: ['claimExtensions'] }]);
  assert.equal(h.forms.calls.set.length, 0);
  assert.equal(h.forms.calls.unset.length, 0);
});

await test('新线:宿主拒写时保留草稿并报失败(不吞掉用户刚敲的内容)', async () => {
  const h = load('latest', 'forms', { applyMutate: false, mutateLands: false });
  const reg = entriesAt(h, 'plugins.bundle.config')[0];
  const props = pageProps(h, reg);
  props.edit('claimExtensions', 'py');
  assert.equal(await props.save(), false, '被拒时 save 应返回 false');
  const tree = h.render(reg.component, pageProps(h, reg));
  const text = textOf(tree);
  assert.ok(text.includes('已保留供你修改'), `要显示失败提示,实际:${text.slice(-200)}`);
  assert.equal(findElement(tree, 'textarea').props.value, 'py', '草稿必须还在(否则用户白改)');
});

await test('新线:宿主未就绪(status != ready)时给一句可读的话,不显示半截表单', async () => {
  const h = load('latest', 'forms', { formSnapshot: { status: 'loading' } });
  const reg = entriesAt(h, 'plugins.bundle.config')[0];
  const tree = h.render(reg.component, pageProps(h, reg));
  assert.ok(textOf(tree).includes('宿主还没有提供本插件的配置'), '要说清是宿主还没给配置');
});

await test('新线:壳层模块表里没有 dsh-client-store 时降级(客户端半部照常加载,只少配置区)', async () => {
  const h = load('latest', 'forms', { clientStore: false });
  assert.equal(h.applied, true, '拿不到 store 不许让整条客户端崩掉');
  assert.equal(entriesAt(h, 'plugins.bundle.config').length, 0, '没有快照 store ⇒ 新通道的页面不注册');
  assert.equal(entriesAt(h, 'sidebar.right.pane.tab').length, 1, '侧栏标签照旧');
});

// ================================================================ 旧通道(rc 线 + 0.1.6-alpha.2)

const rcLine = load('rc', 'scope');

await test('rc 线:{旧座位, 旧通道} ⇒ 注册 settings.plugin.item(键 code-server),注入的是 settings scope', async () => {
  const old = entriesAt(rcLine, 'settings.plugin.item');
  assert.equal(old.length, 1);
  assert.equal(old[0].desc.key, 'code-server');
  assert.equal(old[0].desc.label, 'Code Server');
  assert.equal(entriesAt(rcLine, 'plugins.bundle.config').length, 0, 'rc 线没有插件页配置区');
  const injected = injectAt(rcLine, 'settings.plugin.item');
  assert.ok(injected !== undefined, 'inject 应已回调');
  assert.equal(typeof injected.out, 'function', 'inject 工厂应返回 dispose 函数');
  assert.equal(typeof old[0].desc.inject().scope.getSnapshot, 'function', 'inject 出来的 scope 要是 settings scope');
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

await test('0.1.6-alpha.2:{新座位, **旧通道**} ⇒ 插件页配置区由旧 scope 供数据(第三种真实组合)', async () => {
  const h = load('latest', 'scope');
  const list = entriesAt(h, 'plugins.bundle.config');
  assert.equal(list.length, 1, '新座位必须注册');
  assert.equal(list[0].desc.key, 'dsh-code-server-app');
  assert.equal(entriesAt(h, 'settings.plugin.item').length, 0, '座位已退役,不该再注册');
  assert.equal(typeof list[0].desc.inject().scope.getSnapshot, 'function', '这一版的数据仍来自 settingsScope');
  const tree = h.render(list[0].component, { view: 'page', scope: list[0].desc.inject().scope });
  const classes = classNamesOf(tree);
  assert.ok(classes.includes('dshcs-cfgpage'), `根应是 cfgpage,实际:${classes.join('|')}`);
  assert.ok(!classes.includes('dshcs-card'), '插件页里不该再套一层卡片壳');
  assert.ok(textOf(tree).includes('认领类型'), '表单项照旧');
  assert.equal(elementTypesOf(tree).filter((t) => t === 'input').length, 5, '四个复选框 + 一个数字输入');
});

// ================================================================ 座位都在 / 都不在 / 通道都没有

await test('两个座位都被声明时各自注册(不会互相顶掉,也不会重复渲染同一个视线)', async () => {
  const both = load('both', 'scope');
  assert.equal(entriesAt(both, 'plugins.bundle.config').length, 1);
  assert.equal(entriesAt(both, 'settings.plugin.item').length, 1);
});

await test('没有任何设置座位时不报错、不注册(极旧 DSH)', async () => {
  const none = load('neither', 'scope');
  assert.equal(entriesAt(none, 'plugins.bundle.config').length, 0);
  assert.equal(entriesAt(none, 'settings.plugin.item').length, 0);
  assert.equal(entriesAt(none, 'sidebar.right.pane.tab').length, 1, '侧栏标签不受影响');
});

await test('两条通道都不可见时只跳过配置区:侧栏标签与常驻预热必须照旧(0.3.66 修掉的第二层故障)', async () => {
  const h = loadClientBundle({
    declaredSlots: SEATS['both'], configForms: false, settingsScope: false,
  });
  assert.equal(h.applied, true, '通道缺失不该让条目 pending(inject 里没有它们)');
  assert.equal(entriesAt(h, 'plugins.bundle.config').length, 0);
  assert.equal(entriesAt(h, 'settings.plugin.item').length, 0);
  assert.equal(entriesAt(h, 'sidebar.right.pane.tab').length, 1, '侧栏标签必须照旧注册');
  assert.equal(entriesAt(h, 'shell.overlay').length, 1, '常驻预热必须照旧注册');
});

console.log(`SUMMARY pass=${pass} fail=${fail} skip=0`);
process.exit(fail === 0 ? 0 : 1);
