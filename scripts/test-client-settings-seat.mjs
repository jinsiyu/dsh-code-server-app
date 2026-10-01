// scripts/test-client-settings-seat.mjs —— "设置面住在哪个座位、数据从哪条通道来"的入口级回归
//
// 背景(两件真事,现在都已成历史):
//   · 0.3.50:DSH **0.1.6-alpha.2** 把插件配置从"设置 → 插件"搬到**插件页**,`settings.plugin.item`
//     直接退役 —— 只注册旧座位 ⇒ 设置卡**静默消失**(没有报错、没有日志)。
//   · 0.3.66:DSH **0.1.7-alpha.1** 又把**数据通道**换掉了 —— 客户端服务 `settingsScope` 被删除,
//     改名/改模型为 `configForms`(`ctx.configForms.get(entryId)`,配置就是**插件条目自己的 Config**)。
//     本插件的 `inject` 当时还是 `['slots','settingsScope']` ⇒ 客户端条目**永远 pending**,
//     表现是右侧栏标签、设置卡、常驻预热**一起消失**,启动日志只有一句
//     `web boot: 1 entry did not activate` / `pending (waiting for service: settingsScope)`。
//
// **现状(0.2 这一代唯一)**:两套界面(web 与 desktop)都已升到 DSH 0.2,旧座位与旧通道已从
// lib/client.js 整块删除。所以这里不再是"两条轴 × 三种真实组合",而是**单座位 + 单通道**:
//   · 座位(声明驱动,`slots.inject` 只在插槽被声明时才回调):只有
//     `plugins.bundle.config`(键 = **包名** `dsh-code-server-app`)—— 页面自带标题/面包屑,
//     我们只出表单 + 保存控件;
//   · 通道(能力探测,只经 `ctx.get` 拿):只有 `ctx.configForms.get(...)` —— 写路径**只有**
//     `mutate(ops, revision)`(原子、带 revision 栅栏),注册还要经 `whileServed([entryId], …)` 门禁。
//
// 删掉的那两样东西在这里被改成**反断言**(比删用例更有价值):
//   · 任何宿主形状下都不得注册 `settings.plugin.item`,也不得为它回调 inject;
//   · 入口的活代码里不得再出现 `settingsScope` / `settings.plugin.item`,运行时也不得经
//     `ctx` 属性去摸旧通道。
// 另外**必须保留**的一条:通道缺失时只跳过配置区,侧栏标签与常驻预热照旧(0.3.66 修掉的第二层故障)。
//
// 用法:node scripts/test-client-settings-seat.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_CLAIM_EXTENSIONS, normalizeClaimExtensions } from '../lib/claim-types.js';
import { CLIENT_ENTRY, classNamesOf, elementTypesOf, findElement, loadClientBundle, textOf } from './client-bundle-harness.mjs';

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

/** 唯一的设置座位(0.2 起):插件页按**包名**派发配置区。 */
const SEAT = 'plugins.bundle.config';
/** 旧座位(0.2 之前才有):已删除,只用于反断言。 */
const LEGACY_SEAT = 'settings.plugin.item';
/** 侧栏标签 + 常驻预热:与设置那条轴完全无关,任何形状下都必须在。 */
const BASE_SLOTS = ['sidebar.right.pane.tab', 'shell.overlay'];
/** 正常 0.2 宿主:两个基础座位 + 插件页配置座位。 */
const WITH_SEAT = [...BASE_SLOTS, SEAT];
/** 宿主没声明配置座位(插件页没给这个插槽):配置区不注册,其余照旧。 */
const WITHOUT_SEAT = [...BASE_SLOTS];

const entriesAt = (h, name) => h.registrations.filter((r) => r.desc.name === name);
const injectAt = (h, name) => h.injects.find((i) => i.name === name);
/** 正常 0.2 宿主(座位已声明 + 配置通道可见);`extra` 覆盖单项,如 `configForms: false`。 */
const load = (extra = {}) => loadClientBundle({ declaredSlots: WITH_SEAT, configForms: true, ...extra });
/** 打开那页的 props(像真壳层那样把注入面物化成 hooks + actions)。 */
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

// ================================================================ 注入守卫(线上故障的判据)

await test('注入守卫:0.2 宿主的真实服务集满足入口的静态 inject(缺一个 ⇒ 条目 pending、整块 UI 消失)', async () => {
  // 两种真实形态:宿主在服务本条目配置(通道可见)、宿主没在服务(通道不可见)。
  for (const [label, extra] of [['配置通道可见', {}], ['配置通道不可见', { configForms: false }]]) {
    const h = load(extra);
    assert.deepEqual(h.missingInject, [], `{${label}} 的服务集满足不了 inject ⇒ 条目永远 pending`);
    assert.equal(h.applied, true, `{${label}} 应当真的 apply`);
    for (const name of h.exports.inject) {
      assert.ok(h.services.has(name), `inject 里的 ${name} 不是所有宿主都有的服务(服务集:${[...h.services].join(',')})`);
    }
    assert.deepEqual(h.exports.inject, ['slots'], 'inject 只留普遍存在的 slots;配置通道必须运行时探测');
  }
});

await test('注入守卫:座位声明 × 配置通道有无的 4 种组合全部可 apply(座位与通道互不牵连)', async () => {
  for (const [seatLabel, declaredSlots] of [['座位已声明', WITH_SEAT], ['座位未声明', WITHOUT_SEAT]]) {
    for (const [channelLabel, configForms] of [['通道可见', true], ['通道不可见', false]]) {
      const h = loadClientBundle({ declaredSlots, configForms });
      assert.deepEqual(h.missingInject, [], `{${seatLabel},${channelLabel}} 缺服务:${h.missingInject.join(',')}`);
      assert.equal(h.applied, true, `{${seatLabel},${channelLabel}} 应当真的 apply`);
      // 侧栏标签/常驻预热不受设置那条轴的影响(0.3.66 之前的那次线上故障里,它们被一起带走了)。
      assert.equal(entriesAt(h, 'sidebar.right.pane.tab').length, 1, `{${seatLabel},${channelLabel}} 侧栏标签必须照旧注册`);
      assert.equal(entriesAt(h, 'shell.overlay').length, 1, `{${seatLabel},${channelLabel}} 常驻预热必须照旧注册`);
    }
  }
});

// ================================================================ 反断言:删掉的座位/通道不许复活

await test('反断言:任何宿主形状下都不得注册旧座位 settings.plugin.item,也不得为它回调 inject', async () => {
  const shapes = [
    ['旧座位被声明 + 通道可见', [...BASE_SLOTS, LEGACY_SEAT], true],
    ['旧座位被声明 + 通道不可见', [...BASE_SLOTS, LEGACY_SEAT], false],
    ['新旧座位都被声明 + 通道可见', [...WITH_SEAT, LEGACY_SEAT], true],
    ['只声明了旧座位(插件页座位没声明)', [...BASE_SLOTS, LEGACY_SEAT], true],
  ];
  for (const [label, declaredSlots, configForms] of shapes) {
    const h = loadClientBundle({ declaredSlots, configForms });
    assert.equal(h.applied, true, `{${label}} 应当照常 apply(旧座位不是 inject 的一部分)`);
    assert.equal(entriesAt(h, LEGACY_SEAT).length, 0, `{${label}} 旧座位已删除,不许再注册`);
    assert.equal(injectAt(h, LEGACY_SEAT), undefined, `{${label}} 不许为旧座位回调 inject`);
  }
  // 光看"旧座位没注册"可能是整个配置区都瘫了 —— 这里确认新座位照旧工作。
  const h = loadClientBundle({ declaredSlots: [...WITH_SEAT, LEGACY_SEAT], configForms: true });
  assert.equal(entriesAt(h, SEAT).length, 1, '新座位不受"旧座位被声明"影响');
});

await test('反断言:旧通道 settingsScope 已从入口消失(活代码里不再引用,运行时也不得经 ctx 属性摸)', async () => {
  // ① 静态:只剔掉**整行注释**(文件头保留历史说明),看剩下的活代码。
  const code = readFileSync(CLIENT_ENTRY, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  assert.ok(!code.includes('settingsScope'), '入口的活代码里不许再出现 settingsScope(0.2 起旧通道已整块删除)');
  assert.ok(!code.includes('settings.plugin.item'), '入口的活代码里不许再出现旧座位 settings.plugin.item');
  // ② 运行时:这个服务在 0.2 宿主上根本不存在,属性访问按"未声明服务"当场抛 —— 插件仍要照常起来。
  const h = load();
  assert.equal(h.ctx.get('settingsScope'), undefined, '0.2 宿主没有 settingsScope 这个服务');
  assert.throws(() => h.ctx.settingsScope, /只能经 ctx\.get/, '旧通道不许经 ctx 属性访问(未声明服务在 DSH 里会抛)');
  assert.equal(entriesAt(h, 'sidebar.right.pane.tab').length, 1, '旧通道消失不该影响侧栏标签');
  assert.equal(entriesAt(h, SEAT).length, 1, '配置区只靠 configForms,照样注册');
});

await test('通道服务在 ctx 上不是属性:未声明服务属性访问即抛,插件照常起来', async () => {
  // harness 把 `configForms` 从 ctx 属性里拿掉(只留 ctx.get)—— 与 DSH 对"未在 inject 里声明的服务"
  // 的行为一致。于是插件里任何 `ctx.configForms` 的写法都会在 apply 期当场抛,
  // 连带侧栏标签与常驻预热一起注册不出来(下面那条断言就是那个信号)。
  const h = load();
  assert.throws(() => h.ctx.configForms, /只能经 ctx\.get/, '通道服务即便可用也不做成属性:它不能进 inject');
  assert.equal(h.services.has('configForms'), true, '但它必须能经 ctx.get 拿到');
  assert.equal(entriesAt(h, SEAT).length, 1, '配置区照旧注册 ⇒ 没有用 ctx.<service> 属性访问');
  for (const extra of [{}, { configForms: false }]) {
    const line = load(extra);
    assert.equal(entriesAt(line, 'sidebar.right.pane.tab').length, 1,
      `{configForms:${extra.configForms !== false}} 侧栏标签没注册 ⇒ 很可能用了 ctx.<service> 属性访问`);
    assert.equal(entriesAt(line, 'shell.overlay').length, 1, '常驻预热同样要注册');
  }
});

// ================================================================ 0.2 的设置座位 + configForms 通道

const newLine = load({ configServed: false });

await test('0.2:注册被 whileServed 门禁挡住(宿主还没服务这个条目 ⇒ 页面不留痕迹)', async () => {
  assert.equal(entriesAt(newLine, SEAT).length, 0, '门禁未通过时不许注册');
  assert.deepEqual(newLine.forms.calls.whileServed, [['code-server']], '门禁观察的命名空间必须是条目 id');
  assert.equal(entriesAt(newLine, LEGACY_SEAT).length, 0, '旧座位已删除');
  newLine.setConfigServed(['code-server']);
});

await test('0.2:门禁通过后注册进 plugins.bundle.config,键是包名,注入面是 hooks + actions', async () => {
  const list = entriesAt(newLine, SEAT);
  assert.equal(list.length, 1, `应恰好注册一条,实际 ${list.length}`);
  assert.equal(list[0].desc.key, 'dsh-code-server-app', '插件页按 pkg.name 派发,键写错 = 设置又不见了');
  const injected = injectAt(newLine, SEAT);
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

await test('0.2:page 视图渲染出全部设置项 + 自己的保存控件,且不是旧的折叠卡片', async () => {
  const reg = entriesAt(newLine, SEAT)[0];
  const tree = newLine.render(reg.component, pageProps(newLine, reg));
  const text = textOf(tree);
  for (const label of ['认领类型', '打开即全屏', '后台常驻']) {
    assert.ok(text.includes(label), `表单里应有「${label}」,实际:${text.slice(0, 200)}`);
  }
  assert.ok(text.includes('保存'), '表单要自带保存控件');
  assert.ok(text.includes('放弃修改'), '表单要自带放弃控件');
  const classes = classNamesOf(tree);
  assert.ok(classes.includes('dshcs-cfgpage'), `根应是 cfgpage,实际:${classes.join('|')}`);
  assert.ok(!classes.includes('dshcs-card'), '不应再渲染旧座位那种折叠卡片壳');
});

await test('0.2:summary 视图也答得起(契约要求同一 entry 两种视图都能渲染)', async () => {
  const reg = entriesAt(newLine, SEAT)[0];
  const summary = newLine.render(reg.component, newLine.propsOf(reg, { view: 'summary' }));
  assert.equal(typeof summary, 'string', `summary 应是一句话,实际是 ${typeof summary}`);
  assert.ok(summary.includes('工作区'));
});

await test('0.2:认领类型渲染成多行文本域,并按内容自动长高(不再是单行 input)', async () => {
  const reg = entriesAt(newLine, SEAT)[0];
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
  const reg = entriesAt(newLine, SEAT)[0];
  const text = textOf(newLine.render(reg.component, pageProps(newLine, reg)));
  assert.ok(text.includes('FIM 补全(实验性)'), '设置项标题必须带"实验性"字样');
  assert.ok(text.includes('默认关闭'), '必须写明默认关闭');
  assert.ok(text.includes('唯一会把内容发出去'), '必须写明它是本插件唯一外发内容的能力(隐私边界要写在用户看得见的地方)');
  assert.ok(text.includes('不计入 DSH'), '必须写明这条调用不进 DSH 的 token 计量(否则用户会在账单与界面之间困惑)');
});

await test('0.3.62:FIM 的三个子项在配置区里(停顿毫秒数 / 允许多行 / 按 glob 禁用)', async () => {
  const reg = entriesAt(newLine, SEAT)[0];
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

await test('0.2:下面的提示是多行(默认值按三组折行,不再一整行撑破卡片)', async () => {
  const reg = entriesAt(newLine, SEAT)[0];
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

await test('0.2:保存走**唯一写路径** mutate(一次原子提交全部暂存编辑 + revision 栅栏),不碰 set/unset', async () => {
  const h = load();
  const reg = entriesAt(h, SEAT)[0];
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
  assert.equal(h.forms.calls.set.length, 0, '唯一通道不许用 set(它不是原子路径)');
  assert.equal(h.forms.calls.unset.length, 0, '唯一通道不许用 unset');
});

await test('0.2:草稿与存量等价时不写(避免"看起来没改却写了一次")', async () => {
  const h = load();
  const reg = entriesAt(h, SEAT)[0];
  const props = pageProps(h, reg);
  props.edit('claimExtensions', DEFAULT_CLAIM_EXTENSIONS); // 抄回来:归一化后与存量相同
  props.edit('fimDebounceMs', '250');
  assert.equal(await props.save(), false, '没有真实改动 ⇒ 不发写');
  assert.equal(h.forms.calls.mutate.length, 0);
});

await test('0.2:"恢复默认"提交 unset(移除覆盖层、回落继承),而不是写一个默认值', async () => {
  const h = load({ formSnapshot: { value: { claimExtensions: 'py' }, user: { claimExtensions: 'py' } } });
  const reg = entriesAt(h, SEAT)[0];
  const props = pageProps(h, reg);
  props.resetField('claimExtensions');
  assert.equal(await props.save(), true);
  assert.deepEqual(h.forms.calls.mutate[0].ops, [{ op: 'unset', path: ['claimExtensions'] }]);
  assert.equal(h.forms.calls.set.length, 0);
  assert.equal(h.forms.calls.unset.length, 0);
});

await test('0.2:宿主拒写时保留草稿并报失败(不吞掉用户刚敲的内容)', async () => {
  const h = load({ applyMutate: false, mutateLands: false });
  const reg = entriesAt(h, SEAT)[0];
  const props = pageProps(h, reg);
  props.edit('claimExtensions', 'py');
  assert.equal(await props.save(), false, '被拒时 save 应返回 false');
  const tree = h.render(reg.component, pageProps(h, reg));
  const text = textOf(tree);
  assert.ok(text.includes('已保留供你修改'), `要显示失败提示,实际:${text.slice(-200)}`);
  assert.equal(findElement(tree, 'textarea').props.value, 'py', '草稿必须还在(否则用户白改)');
});

await test('0.2:宿主未就绪(status != ready)时给一句可读的话,不显示半截表单', async () => {
  const h = load({ formSnapshot: { status: 'loading' } });
  const reg = entriesAt(h, SEAT)[0];
  const tree = h.render(reg.component, pageProps(h, reg));
  assert.ok(textOf(tree).includes('宿主还没有提供本插件的配置'), '要说清是宿主还没给配置');
});

await test('0.2:壳层模块表里没有 dsh-client-store 时降级(客户端半部照常加载,只少配置区)', async () => {
  const h = load({ clientStore: false });
  assert.equal(h.applied, true, '拿不到 store 不许让整条客户端崩掉');
  assert.equal(entriesAt(h, SEAT).length, 0, '没有快照 store ⇒ 配置区不注册');
  assert.equal(entriesAt(h, 'sidebar.right.pane.tab').length, 1, '侧栏标签照旧');
});

// ================================================================ 座位没声明 / 通道不可见

await test('座位没被声明时只跳过配置区:不报错、不注册,侧栏标签照旧', async () => {
  const none = loadClientBundle({ declaredSlots: WITHOUT_SEAT, configForms: true });
  assert.equal(entriesAt(none, SEAT).length, 0);
  assert.equal(entriesAt(none, LEGACY_SEAT).length, 0);
  assert.equal(entriesAt(none, 'sidebar.right.pane.tab').length, 1, '侧栏标签不受影响');
  assert.equal(none.missingInject.length, 0, '座位不在 inject 里,少一个插槽不该让条目 pending');
});

await test('configForms 不可见时只跳过配置区:侧栏标签与常驻预热必须照旧(0.3.66 修掉的第二层故障)', async () => {
  const h = loadClientBundle({ declaredSlots: WITH_SEAT, configForms: false });
  assert.equal(h.applied, true, '通道缺失不该让条目 pending(inject 里没有它)');
  assert.equal(entriesAt(h, SEAT).length, 0, '没有通道 ⇒ 配置区不注册');
  assert.equal(entriesAt(h, LEGACY_SEAT).length, 0, '也不许悄悄回落到旧座位');
  assert.equal(entriesAt(h, 'sidebar.right.pane.tab').length, 1, '侧栏标签必须照旧注册');
  assert.equal(entriesAt(h, 'shell.overlay').length, 1, '常驻预热必须照旧注册');
  // 旧通道早已不存在:这里连 settingsScope 服务都没提供,唯一能解释"照旧起来"的就是"没读它"。
  assert.equal(h.ctx.get('settingsScope'), undefined);
});

console.log(`SUMMARY pass=${pass} fail=${fail} skip=0`);
process.exit(fail === 0 ? 0 : 1);
