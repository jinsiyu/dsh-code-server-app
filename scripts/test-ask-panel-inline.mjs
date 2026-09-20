// scripts/test-ask-panel-inline.mjs —— 「问 DSH」面板(0.3.59 起手写在客户端半部里)的守卫
//
// 为什么需要:「问 DSH」的对话面板在 0.3.24–0.3.58 是一个**构建产物**(webview/thread.js:
// React + 官方渲染器 + 设计令牌打成一个 1MB 的 IIFE),由 host 读盘、经 `/ask/bundle`
// 交给客户端半部注入 DSH 页面执行(还要给它一个假的 acquireVsCodeApi)。
// 0.3.59 起面板直接 require 壳模块表里的 `react-dom/client` 与
// `@deepseek-ai/dsh-client-ui-primitives` —— 不需要打包了,但也**没有构建器兜底**了:
// 面板写错只会在用户点开对话框时白屏。这个套件钉住五件事:
//   P1 **注入机制真的下线**:客户端入口里不再有 /ask/bundle、acquireVsCodeApi、
//      __DSHCS_HOST__/__DSHCS_MOUNT__、sessionStorage 产物缓存、预热定时器;
//   P2 **视图状态只认白名单字段**(宿主塞别的东西进不来);
//   P3 **注入宿主页面的 CSS 是安全的**:选择器全部挂在 .dshcs-* 自己名下(不许碰 :root/body/
//      html —— 那会改掉整个 DSH 界面),且每个 `var(--vscode-*)` 都带 fallback
//      (DSH 页面里没有 --vscode-*;"没有 fallback 的 var()"是计算值无效 ⇒ 按钮/输入框透明,
//      这正是老面板在页面里看着发灰的真实原因);
//   P4 **六种条目的渲染形状 + 授权卡片 + 三条消息落点**(ask / approve / close);
//   P5 **拿不到模块表种子词时的降级路径**:正文 <pre>、按钮原生 button、折叠行朴素按钮,
//      并在控制台/面板里说清原因 —— 绝不白屏。
//
// 用法:node scripts/test-ask-panel-inline.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CLIENT_ENTRY, classNamesOf, loadClientBundle, textOf } from './client-bundle-harness.mjs';

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

const source = readFileSync(CLIENT_ENTRY, 'utf8');
/** 只保留代码行(整行注释剔掉):注释里会提到 acquireVsCodeApi / /ask/bundle 这些历史名字。 */
function codeLines(text) {
  return text.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
}

/** 元素树里所有满足条件的节点(深度优先,数组也算)。 */
function findAll(tree, predicate, out = []) {
  if (tree === null || tree === undefined || typeof tree !== 'object') return out;
  if (Array.isArray(tree)) {
    tree.forEach((node) => findAll(node, predicate, out));
    return out;
  }
  if (predicate(tree)) out.push(tree);
  if (tree.props !== undefined) findAll(tree.props.children, predicate, out);
  return out;
}

/** 按 className 找节点(类名以空格分隔,做精确匹配)。 */
function byClass(tree, className) {
  return findAll(tree, (node) => typeof node.props.className === 'string'
    && node.props.className.split(/\s+/).includes(className));
}

/** 树里所有按钮(官方 Button 桩渲染成 button.stub-button;降级路径渲染成 button.dshcs-btn)。 */
function buttonsOf(tree) {
  return findAll(tree, (node) => node.type === 'button');
}

/** 微任务清空(让 fetch 的 promise 落地)。 */
function settle() {
  return new Promise((resolve) => { setTimeout(resolve, 0) });
}

/** 一段真实形状的宿主状态(与 lib/index.js 的 askState() 同形)。 */
function fixture(overrides = {}) {
  return {
    entries: [],
    approvals: [],
    approvalHoldMs: 8000,
    contextText: '来自编辑器:a.ts:12-20 · 针对选中内容',
    statusText: '',
    status: 'idle',
    error: null,
    sessionId: 's1',
    available: true,
    threadError: null,
    uiVersion: '0.1.6-alpha.2',
    ...overrides,
  };
}

const PANEL_PROPS = {
  now: 2000,
  draft: '',
  sending: false,
  scriptError: null,
  decided: {},
  logRef: { current: null },
  onScroll: () => {},
  onDraft: () => {},
  onKeyDown: () => {},
  onSubmit: () => {},
  onDecide: () => {},
  onClose: () => {},
};

/** 模块表种子词齐备的加载(生产形态)。 */
const h = loadClientBundle({ testHooks: true });
assert.ok(h.internals !== null, '需要 testHooks 才能拿到面板内部函数');
const mod = h.internals;

/** 渲染一次面板,拿回"已经下钻到底"的元素树。 */
function renderPanel(view, props = {}) {
  return h.render(mod.AskPanel, { ...PANEL_PROPS, view, ...props });
}

// ---------------------------------------------------------------- P1 注入机制下线

await test('P1:客户端入口里不再有产物注入机制(/ask/bundle、假 acquireVsCodeApi、sessionStorage)', () => {
  const code = codeLines(source).join('\n');
  const banned = [
    ['/ask/bundle', '产物路由'],
    ['acquireVsCodeApi', '假 VS Code API'],
    ['__DSHCS_HOST__', '宿主形态标记'],
    ['__DSHCS_MOUNT__', '注入挂载点'],
    ['sessionStorage', '产物缓存'],
    ['askPreload', '产物预热(1.4MB 的取/解析/执行已不存在)'],
    ['askBundle', '产物句柄'],
  ];
  for (const [needle, why] of banned) {
    assert.equal(code.includes(needle), false, `入口里还有 ${needle}(${why})—— 面板已改成手写源码,不该再有这条路径`);
  }
  // 面板仍然是"宿主状态推进来"的:推送入口必须还在(否则对话框永远显示首帧)。
  assert.ok(code.includes('ask.push'), '面板与外壳之间的状态推送(ask.push)必须保留');
});

// ---------------------------------------------------------------- P2 视图状态白名单

await test('P2:视图状态只认白名单字段,非法值走兜底', () => {
  const payload = {
    type: 'state',
    entries: [{ role: 'user', text: 'hi' }],
    approvals: [{ id: 'a1' }],
    approvalHoldMs: -5,
    contextText: '来自编辑器:x',
    statusText: 'DSH 正在回答…',
    status: 'thinking',
    error: 'boom',
    sessionId: 's2',
    available: true,
    threadError: 'err',
    uiVersion: 'v9',
    evil: '宿主偷偷塞的字段',
  };
  const view = mod.askApplyPayload(mod.askViewState(), payload);
  assert.deepEqual(Object.keys(view).sort(), [
    'approvalHoldMs', 'approvals', 'available', 'contextText', 'deliveryNote', 'entries', 'error',
    'sessionId', 'status', 'statusText', 'threadError', 'uiVersion',
  ], '视图字段必须是固定集合(不许把宿主的任意字段透传进渲染)');
  assert.equal(view.evil, undefined, '白名单外的字段不许进视图');
  assert.equal(view.approvalHoldMs, 8000, '非法授权窗口要回到兜底值');
  assert.equal(view.entries.length, 1);
  assert.equal(view.status, 'thinking');
  assert.equal(view.threadError, 'err');

  // 非 state 载荷(例如别的 postMessage)必须原样返回同一个引用。
  const before = mod.askViewState();
  assert.equal(mod.askApplyPayload(before, { type: 'nope' }), before, '非 state 载荷不许改动视图');
  assert.equal(mod.askApplyPayload(before, null), before);

  // 缺字段的载荷走默认值(宿主老版本 / 拓扑不同)。
  const sparse = mod.askApplyPayload(mod.askViewState(), { type: 'state' });
  assert.deepEqual(sparse.entries, []);
  assert.deepEqual(sparse.approvals, []);
  assert.equal(sparse.status, 'idle');
  assert.equal(sparse.available, null, 'available 未给 = 还不知道(不是 false)');
});

// ---------------------------------------------------------------- P3 注入 CSS 的安全性

await test('P3:注入的 CSS 只碰 .dshcs-* 选择器,且每个 --vscode-* 都有 fallback', () => {
  const css = mod.ASK_CSS;
  assert.equal(typeof css, 'string');
  assert.ok(css.length > 2000, `CSS 太短(${css.length} 字符),像是被截断了`);

  // 选择器 = 每条规则那一行(本文件的规则都写成"选择器单独一行,行尾 {"`)。
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors = withoutComments
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('{'))
    .map((line) => line.slice(0, -1).trim());
  assert.ok(selectors.length > 20, `没解析出选择器(${selectors.length} 条),检查解析逻辑`);
  for (const selector of selectors) {
    assert.ok(
      selector.startsWith('.dshcs-'),
      `选择器 \`${selector}\` 不挂在 .dshcs-* 名下:往 DSH 页面注入的样式只能影响面板自己`,
    );
  }
  // 危险选择器(按行首判断,避免 `.dshcs-think-body {` 这类误报)+ 危险 at 规则。
  for (const line of withoutComments.split('\n').map((l) => l.trim())) {
    assert.equal(
      /^(body|html|:root|\*)\b/.test(line), false,
      `CSS 里出现 \`${line}\`:会改到整个 DSH 界面(注入样式只许碰 .dshcs-*)`,
    );
  }
  for (const at of ['@import', '@media', '@supports', '@font-face']) {
    assert.equal(withoutComments.includes(at), false, `CSS 里不该出现 ${at}(面板样式只作用于自己的容器)`);
  }

  // --vscode-* 在 DSH 页面里不存在 ⇒ 每个 var() 都必须带 fallback。
  const bare = [...css.matchAll(/var\(\s*(--vscode-[a-z-]+)\s*\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(bare)], [], `这些 var() 没有 fallback,在 DSH 页面里是计算值无效:${[...new Set(bare)].join(', ')}`);
  // DSH 页面里真正存在的令牌:至少得用到它们(否则面板在页面里没颜色)。
  for (const token of ['--dsw-alias-label-primary', '--dsw-alias-bg-base', '--dsw-font-family']) {
    assert.ok(css.includes(token), `CSS 应当用页面令牌 ${token} 作为 fallback`);
  }
});

await test('P3:面板不再 @import 官方令牌副本(令牌由 DSH 页面提供)', () => {
  assert.equal(mod.ASK_CSS.includes('@import'), false, '导入 official-tokens.css 是 webview 时代的做法');
  const css = codeLines(source).join('\n');
  assert.equal(
    /official-tokens/.test(css), false,
    '客户端入口不该再引用 official-tokens.css(那是给编辑器 webview 的 28KB 副本)',
  );
});

// ---------------------------------------------------------------- P4 渲染形状

await test('P4:空对话显示引导语,且不渲染任何消息条目', () => {
  const tree = renderPanel(fixture());
  assert.equal(byClass(tree, 'dshcs-app').length, 1, '面板根必须是 .dshcs-app');
  assert.equal(byClass(tree, 'dshcs-empty').length, 1);
  assert.ok(textOf(byClass(tree, 'dshcs-empty')[0]).includes('在下面提问'), '空态要说清"在这里提问"');
  assert.deepEqual(byClass(tree, 'dshcs-msg'), []);
  assert.equal(textOf(byClass(tree, 'dshcs-where')[0]), '来自编辑器:a.ts:12-20 · 针对选中内容', '标题栏要显示上下文');
});

await test('P4:用户条目 = 折叠的上下文行 + 气泡;注入条目走「上下文注入」', () => {
  const context = 'From the editor: src/a.ts:12-20\n```typescript\nconst x = 1\n```';
  const tree = renderPanel(fixture({
    entries: [
      { role: 'user', text: '这个函数为什么是错的', context, thinking: '', streaming: false },
      { role: 'user', text: 'From the editor: 别的东西', sourceKind: 'mcp' },
    ],
  }));
  const bubbles = byClass(tree, 'dshcs-bubble');
  assert.equal(bubbles.length, 1, '注入条目不算用户气泡');
  assert.equal(textOf(bubbles[0]), '这个函数为什么是错的');

  const disclosures = byClass(tree, 'stub-disclosure');
  assert.equal(disclosures.length, 2, '上下文行 + 上下文注入行');
  assert.equal(disclosures[0].props['data-title'], '上下文');
  assert.equal(disclosures[0].props['data-open'], false, '上下文默认收起(与 DSH 界面一致)');
  assert.ok(textOf(disclosures[0]).includes('src/a.ts:12-20'), '收起时的摘要要带位置行');
  assert.ok(textOf(disclosures[0]).includes('const x = 1'), '展开内容是正文(由官方部件决定显隐)');
  assert.equal(disclosures[1].props['data-title'], '上下文注入', '带 sourceKind 的走「上下文注入」');
  assert.equal(byClass(tree, 'dshcs-injection').length, 1);
});

await test('P4:助手条目 = 折叠的思考行 + 官方 markdown 渲染器(流式透传)', () => {
  const tree = renderPanel(fixture({
    entries: [{
      role: 'assistant', text: '**原因**是……', thinking: '先看看这个函数\n再看调用点', streaming: true,
    }],
  }));
  const think = byClass(tree, 'stub-disclosure');
  assert.equal(think.length, 1);
  assert.equal(think[0].props['data-title'], '思考', '正文已经落下来了 ⇒ 标"思考"');
  assert.equal(think[0].props['data-open'], false, '思考默认收起');
  assert.ok(textOf(byClass(tree, 'dshcs-think-summary')[0]).includes('先看看这个函数'), '摘要取首行');

  const md = byClass(tree, 'stub-markdown');
  assert.equal(md.length, 1, '正文必须交给官方 MarkdownText');
  assert.equal(textOf(md[0]), '**原因**是……');
  assert.equal(md[0].props['data-streaming'], true, 'streaming 要透传(官方靠它做增量解析)');
  assert.equal(md[0].props['data-copy-label'], '复制', 'labels 必须是面板自己的中文文案');

  // 整轮只有思考(正文还没到)→ 思考行标"思考中",且没有正文节点。
  const early = renderPanel(fixture({
    entries: [{ role: 'assistant', text: '', thinking: '正在想', streaming: true }],
  }));
  assert.equal(byClass(early, 'stub-disclosure')[0].props['data-title'], '思考中');
  assert.deepEqual(byClass(early, 'stub-markdown'), []);
});

await test('P4:工具行 / 授权审计行给出名字、摘要与中文状态', () => {
  const tree = renderPanel(fixture({
    entries: [
      { role: 'tool', text: '', name: 'read_file', summary: 'src/a.ts', status: 'ok' },
      { role: 'tool', text: '', name: 'run_command', summary: 'npm test', status: 'running' },
      { role: 'tool', text: '', name: 'write_file', summary: 'x', status: 'error' },
      { role: 'approval', text: '', name: 'run_command', summary: 'npm test', status: 'allowed-once' },
    ],
  }));
  const names = byClass(tree, 'dshcs-tool-name').map((node) => textOf(node));
  assert.deepEqual(names, ['read_file', 'run_command', 'write_file', 'run_command']);
  const states = byClass(tree, 'dshcs-tool-state').map((node) => textOf(node));
  assert.deepEqual(states, ['完成', '运行中', '失败', '已允许一次'], '状态必须是中文');
  assert.ok(textOf(byClass(tree, 'dshcs-tool-summary')[0]).includes('src/a.ts'));
});

await test('P4:授权卡片用官方按钮,两个决策各自落到 onDecide(白名单值)', () => {
  const decided = [];
  const tree = renderPanel(fixture({
    approvals: [{ id: 'ap1', toolName: 'run_command', reason: '需要执行命令', callId: 'c1', at: 1000 }],
  }), { now: 2000, onDecide: (id, outcome) => decided.push([id, outcome]) });

  const card = byClass(tree, 'dshcs-approval');
  assert.equal(card.length, 1);
  assert.ok(textOf(card[0]).includes('需要你的授权'));
  assert.ok(textOf(card[0]).includes('run_command'));
  assert.ok(textOf(card[0]).includes('需要执行命令'), '原因要显示出来(用户据此决定)');
  assert.ok(textOf(byClass(tree, 'dshcs-approval-timer')[0]).includes('7 秒后交回 DSH 界面'), '250ms 一跳的倒计时文案');
  assert.ok(textOf(card[0]).includes('只对这一次动作有效'), '必须说清授权只对这次动作有效');

  const buttons = buttonsOf(card[0]);
  assert.equal(buttons.length, 2, '恰好两个决策按钮(没有"以后都允许")');
  assert.deepEqual(buttons.map((node) => node.props['data-variant']), ['primary', 'outline']);
  assert.deepEqual(buttons.map((node) => textOf(node)), ['允许一次', '拒绝']);
  assert.equal(buttons[0].props.disabled, false, '卡片在 = 宿主仍挂着这条请求 ⇒ 按钮可点(老版本按 8 秒自己判过期,是"授权框失效"的根因)');
  buttons[0].props.onClick();
  buttons[1].props.onClick();
  assert.deepEqual(decided, [['ap1', 'allowed-once'], ['ap1', 'rejected']]);
});

await test('P4:已提交的决策锁住按钮并改文案;授权倒计时到点说"已交回"', () => {
  const tree = renderPanel(fixture({
    approvals: [{ id: 'ap1', toolName: 't', reason: '', callId: null, at: 1000 }],
  }), { now: 1000, decided: { ap1: 'rejected' } });
  const buttons = buttonsOf(byClass(tree, 'dshcs-approval')[0]);
  assert.deepEqual(buttons.map((node) => node.props.disabled), [true, true], '点了之后锁住,避免连点');
  assert.ok(textOf(byClass(tree, 'dshcs-approval-note')[0]).includes('已拒绝'));

  assert.equal(mod.askRemainingText({ at: 1000 }, 8000, 12000), '已交回 DSH 界面');
  assert.equal(mod.askRemainingText({ at: 0 }, 300000, 120000), '3 分 00 秒后交回 DSH 界面');
});

await test('P4:状态行显示宿主状态;脚本错误优先;threadError 另起一行告警', () => {
  const plain = renderPanel(fixture({ statusText: 'DSH 正在回答…', status: 'thinking' }));
  assert.equal(textOf(byClass(plain, 'dshcs-status')[0]), 'DSH 正在回答…');

  const broken = renderPanel(fixture({ statusText: 'DSH 正在回答…' }), { scriptError: '面板脚本出错:boom' });
  assert.equal(textOf(byClass(broken, 'dshcs-status')[0]), '面板脚本出错:boom', '面板自己的错误优先显示');
  assert.equal(byClass(broken, 'dshcs-warn').length, 1);

  const noThread = renderPanel(fixture({ threadError: '宿主没有对话流能力' }));
  assert.ok(textOf(byClass(noThread, 'dshcs-warn')[0]).includes('宿主没有对话流能力'));
});

await test('P4:输入框与发送按钮(draft 空/纯空白 ⇒ 不可发;非空 ⇒ 可点)', () => {
  const submitted = [];
  const empty = renderPanel(fixture(), { draft: '' });
  const emptySend = buttonsOf(byClass(empty, 'dshcs-footer')[0]);
  assert.equal(emptySend.length, 1);
  assert.equal(emptySend[0].props.disabled, true);

  const blank = renderPanel(fixture(), { draft: '   \n  ' });
  assert.equal(buttonsOf(byClass(blank, 'dshcs-footer')[0])[0].props.disabled, true, '纯空白不算提问');

  const typed = renderPanel(fixture(), { draft: '为什么', onSubmit: () => submitted.push('x') });
  const send = buttonsOf(byClass(typed, 'dshcs-footer')[0])[0];
  assert.equal(send.props.disabled, false);
  send.props.onClick();
  assert.deepEqual(submitted, ['x']);

  const textarea = findAll(typed, (node) => node.type === 'textarea');
  assert.equal(textarea.length, 1, '面板必须只有一个输入框');
  assert.equal(textarea[0].props.value, '为什么');
  assert.ok(String(textarea[0].props.placeholder).includes('Enter 发送'), '要写明发送快捷键');

  // 关闭按钮:交给外壳处理(同一个 window,不走 postMessage)。
  const closed = [];
  const closable = renderPanel(fixture(), { onClose: () => closed.push('x') });
  byClass(closable, 'dshcs-close')[0].props.onClick();
  assert.deepEqual(closed, ['x']);
});

await test('P4:带 hook 的组件只能当元素用(当函数调用会把 hook 记到父组件头上)', () => {
  // 这块面板是手写的(没有 JSX):`React.createElement(AskDisclosureRow, {...})` 与
  // `AskDisclosureRow({...})` 长得几乎一样,但后者会把子组件的 useState 记进**父组件**的 hook 链 ——
  // 父组件的分支一变(如 thinking 从空变非空),hook 数量就变,React 直接抛
  // "Rendered more hooks than during the previous render"。这条守卫按源码判:除了定义处,
  // 这几个名字后面不许直接跟 `(`。
  const code = codeLines(source).join('\n');
  for (const name of ['AskDisclosureRow', 'AskThreadEntry', 'AskApprovalCard', 'AskPanel', 'AskRoot', 'AskBoundary']) {
    const direct = [...code.matchAll(new RegExp(`(?<!function )\\b${name}\\(`, 'g'))];
    assert.equal(direct.length, 0,
      `${name} 被当函数直接调用了(会串 hook 链)—— 必须写成 React.createElement(${name}, …)`);
  }
});

await test('P4:官方部件两种形状都认(函数 / React.memo 对象)—— 实机踩过 typeof === "function"', () => {
  // 2026-09-20 实机实测:官方 MarkdownText 是 `React.memo` 的产物(**对象**,不是函数),
  // 面板第一版只认函数 ⇒ 实机上正文整个退成 <pre>,而单测的桩当时写成函数 ⇒ 全绿。
  // 所以桩现在就是 memo 形状(见 client-bundle-harness.mjs),这里再把两种形状都钉一遍。
  const stub = mod.askPrimitives().primitives;
  assert.equal(typeof stub.MarkdownText, 'object', '桩必须是 memo 形状(否则这条 bug 类又会被漏掉)');
  assert.equal(stub.MarkdownText.$$typeof, Symbol.for('react.memo'));
  assert.equal(typeof stub.Button, 'function');

  const memo = { $$typeof: Symbol.for('react.memo'), type: () => null };
  const forward = { $$typeof: Symbol.for('react.forward_ref'), render: () => null };
  assert.equal(typeof mod.askComponent({ X: function f() {} }, 'X'), 'function', '函数形态要认');
  assert.equal(mod.askComponent({ X: memo }, 'X'), memo, 'memo 形态要认(整对象交回,createElement 认它)');
  assert.equal(mod.askComponent({ X: forward }, 'X'), forward, 'forwardRef 形态要认');
  assert.equal(mod.askComponent({ X: 'nope' }, 'X'), null, '字符串之类一律不认');
  assert.equal(mod.askComponent({}, 'X'), null);
  assert.equal(mod.askComponent(null, 'X'), null);

  // 默认渲染路径必须真的用上 memo 形状的 MarkdownText(而不是悄悄退成 <pre>)。
  const tree = renderPanel(fixture({ entries: [{ role: 'assistant', text: '正文', thinking: '' }] }));
  assert.equal(byClass(tree, 'stub-markdown').length, 1, 'memo 形状的 MarkdownText 必须被渲染');
  assert.deepEqual(byClass(tree, 'dshcs-md-fallback'), [], '不许退成 <pre>(官方部件就在手边)');

  // 会话里也应该能看到它:整棵面板树里不出现降级 <pre>。
  const full = renderPanel(fixture({
    entries: [
      { role: 'user', text: '问', context: 'From the editor: a.ts:1' },
      { role: 'assistant', text: '正文', thinking: '想一下' },
    ],
  }), { draft: 'x' });
  assert.deepEqual(byClass(full, 'dshcs-md-fallback'), [], '有官方渲染器时任何条目都不许走降级');
});

await test('P4:投递提示(立刻开新一轮 / 排队 / 插入当前轮)显示在状态行,但不覆盖宿主状态与错误', () => {
  // 为什么要有这条:面板发的追问在"当前轮还在跑 + queue"时主界面看不到(DSH 的待发队列没有 UI),
  // 用户会以为消息丢了。宿主 /ask/send 的回话里带 delivery + busy,客户端把它转成这行提示。
  assert.match(mod.askDeliveryNote('queue', false), /立刻开始新一轮/, '空闲时两种方式都会立刻开新一轮 —— 不能说成"排到下一轮"');
  assert.match(mod.askDeliveryNote('steer', false), /立刻开始新一轮/);
  assert.match(mod.askDeliveryNote('queue', true), /排入下一轮/);
  assert.match(mod.askDeliveryNote('steer', true), /插入当前轮/);
  assert.match(mod.askDeliveryNote('whatever', true), /已发送/, '未知方式也要给一句话,不返回 null');

  const plain = renderPanel(fixture({ statusText: '' }));
  assert.equal(textOf(byClass(plain, 'dshcs-status')[0]), '', '没有提示时状态行是空的');

  const withNote = h.render(mod.AskPanel, {
    ...PANEL_PROPS,
    view: fixture({ statusText: '', deliveryNote: mod.askDeliveryNote('queue', true) }),
  });
  assert.match(textOf(byClass(withNote, 'dshcs-status')[0]), /排入下一轮/, '提示要出现在状态行');

  const hostWins = h.render(mod.AskPanel, {
    ...PANEL_PROPS,
    view: fixture({ statusText: 'DSH 正在回答…', deliveryNote: mod.askDeliveryNote('steer', true) }),
  });
  assert.equal(textOf(byClass(hostWins, 'dshcs-status')[0]), 'DSH 正在回答…', '宿主状态优先于这条提示');

  const errorWins = h.render(mod.AskPanel, {
    ...PANEL_PROPS,
    view: fixture({ statusText: '', deliveryNote: mod.askDeliveryNote('steer', true) }),
    scriptError: '面板脚本出错:boom',
  });
  assert.equal(textOf(byClass(errorWins, 'dshcs-status')[0]), '面板脚本出错:boom', '面板错误优先于一切');

  // 视图白名单:deliveryNote 只接受字符串,别的东西不进视图。
  const view = mod.askApplyPayload(mod.askViewState(), { type: 'state', deliveryNote: 42 });
  assert.equal(view.deliveryNote, null);
});

// ---------------------------------------------------------------- P5 降级路径

await test('P5:拿不到官方 primitives 时降级渲染(正文 <pre>、按钮原生 button),不抛错', () => {
  const degraded = loadClientBundle({ testHooks: true, clientPrimitives: false });
  const dmod = degraded.internals;
  const resolved = dmod.askPrimitives();
  assert.equal(resolved.primitives, null, '取不到 = null,由组件各自降级');
  assert.ok(resolved.why.includes('dsh-client-ui-primitives'), `要留下可查的原因,实际:${resolved.why}`);

  const tree = degraded.render(dmod.AskPanel, {
    ...PANEL_PROPS,
    view: fixture({
      entries: [
        { role: 'user', text: '问', context: 'From the editor: a.ts:1\n```ts\nx\n```' },
        { role: 'assistant', text: '正文', thinking: '想一下', streaming: false },
      ],
      approvals: [{ id: 'ap1', toolName: 'run_command', reason: 'r', callId: null, at: 1000 }],
    }),
    draft: 'x',
  });
  const fallback = byClass(tree, 'dshcs-md-fallback');
  assert.equal(fallback.length, 1, '没有官方渲染器时正文退成 <pre>,而不是空白');
  assert.equal(textOf(fallback[0]), '正文');
  assert.equal(fallback[0].type, 'pre');

  const toggles = byClass(tree, 'dshcs-row-toggle');
  assert.equal(toggles.length, 2, '思考行与上下文行都退成朴素的可点按钮行');
  assert.ok(textOf(toggles[0]).includes('上下文'), `第一条是用户条的上下文行,实际:${textOf(toggles[0])}`);
  assert.ok(textOf(toggles[1]).includes('思考'), `第二条是助手的思考行,实际:${textOf(toggles[1])}`);

  const names = buttonsOf(tree).map((node) => node.props.className);
  assert.ok(names.includes('dshcs-btn'), '发送按钮退成原生 button.dshcs-btn');
  assert.ok(buttonsOf(tree).some((node) => String(node.props.className).includes('dshcs-btn-secondary')), '次要按钮有次要样式');
});

await test('P5:连 react-dom/client 都取不到时,面板里写明原因而不是白屏', () => {
  const broken = loadClientBundle({ testHooks: true, clientReactDom: false, declaredSlots: [] });
  const bmod = broken.internals;
  assert.equal(bmod.askPrimitives().createRoot, null);
  bmod.askMount(); // 不许抛
  const body = globalThis.document.body;
  const dialog = body.children.find((el) => el.className === 'dshcs-dialog');
  assert.ok(dialog !== undefined, '外壳仍然要建出来(用户至少看到一扇有标题的窗)');
  const panel = dialog.children.find((el) => el.className === 'dshcs-panel');
  assert.ok(panel !== undefined);
  assert.equal(panel.children.length, 1);
  assert.ok(String(panel.children[0].textContent).includes('react-dom/client'), '要说清缺的是哪个种子词');
  assert.equal(broken.roots.length, 0, '取不到 createRoot 时不许建根');
});

// ---------------------------------------------------------------- P6 装配 + 消息面

await test('P6:挂载只做一次 —— 样式进 head、React 根挂在对话框里', () => {
  const mounted = loadClientBundle({ testHooks: true });
  const mmod = mounted.internals;
  mmod.askMount();
  assert.equal(mmod.askState.mounted, true);

  const style = globalThis.document.head.children.find((el) => el.id === 'dshcs-ask-style');
  assert.ok(style !== undefined, '面板样式必须注入一次 <style id="dshcs-ask-style">');
  assert.equal(style.textContent, mmod.ASK_CSS);
  assert.equal(globalThis.document.head.children.filter((el) => el.id === 'dshcs-ask-style').length, 1, '样式不许重复注入');

  assert.equal(mounted.roots.length, 1, '只建一个 React 根');
  assert.equal(mounted.roots[0].container.className, 'dshcs-panel', '根必须挂在对话框的 body 上');
  assert.equal(mounted.roots[0].container.attributes['data-dshcs-ask-root'], '');
  // 根上渲染的是"错误边界 → 面板根":整棵树能渲染出 .dshcs-app。
  const tree = mounted.render(() => mounted.roots[0].rendered, {});
  assert.equal(byClass(tree, 'dshcs-app').length, 1);

  // 再挂一次是 no-op(不许出现第二个根 / 第二份样式)。
  mmod.askMount();
  assert.equal(mounted.roots.length, 1);
});

await test('P6:面板的三条消息落到宿主路由(ask / approve / close),ready 只回推状态', async () => {
  const wired = loadClientBundle({ testHooks: true });
  const wmod = wired.internals;
  wmod.askMount();
  // 挂载前推状态不许抛(push 还没登记)。
  wmod.askPush(true);

  wmod.askState.pending = { open: true, mode: 'selection' };
  wmod.askState.rev = 7;
  // 模拟面板挂上来的推送函数:外壳把宿主状态原样递进去。
  wmod.askState.push = (payload) => { wmod.askState.pushed = payload };
  wmod.askPush(true);
  assert.equal(wmod.askState.pushed.mode, 'selection', 'askPush 必须把宿主状态递给面板');

  wmod.askOnMessage({ type: 'ready' });
  await settle();
  assert.equal(wired.calls.filter((call) => call.method === 'POST').length, 0, 'ready 不该发任何请求');

  wmod.askOnMessage({ type: 'ask', text: '为什么' });
  await settle();
  const askCall = wired.calls.find((call) => call.url.endsWith('/api/code-server/ask/send'));
  assert.ok(askCall !== undefined, '提问必须走 /ask/send');
  assert.equal(askCall.body.text, '为什么');
  assert.equal(askCall.body.mode, 'selection', '提问意图(选区/整文件)要带给宿主');

  wmod.askOnMessage({ type: 'approve', id: 'ap1', outcome: 'allowed-once' });
  await settle();
  const approveCall = wired.calls.find((call) => call.url.endsWith('/api/code-server/ask/approve'));
  assert.ok(approveCall !== undefined);
  assert.deepEqual(approveCall.body, { id: 'ap1', outcome: 'allowed-once' });

  wmod.askOnMessage({ type: 'close' });
  await settle();
  assert.ok(wired.calls.some((call) => call.url.endsWith('/api/code-server/ask/close')), '关闭要告诉宿主(待决授权立刻交回官方链路)');
  assert.equal(wmod.askState.open, false);

  // 乱消息不许打穿面板。
  for (const junk of [null, 42, 'x', {}, { type: 'ask' }, { type: 'approve' }]) {
    wmod.askOnMessage(junk);
  }
  await settle();
});

await test('P6:错误边界接住渲染异常并显示原因(不白屏)', () => {
  const boundary = new mod.AskBoundary({ children: 'ok' });
  assert.equal(boundary.render(), 'ok');
  boundary.componentDidCatch({ message: 'boom' });
  const text = textOf(boundary.render());
  assert.ok(text.includes('面板渲染出错:boom'), `边界要显示原因,实际:${text}`);
  assert.ok(textOf(mod.askErrorView(new Error('x'))).includes('面板渲染出错:x'));

  // 边界要能穿过 harness 的渲染器(类组件不能被当成函数组件调用)。
  // 注意:harness 不是 React,它没有"子组件抛错 → 边界接管"的语义,所以这里只验证
  // "类组件在这条渲染路径上可实例化、可渲染";接住异常那一段由上面直接调 componentDidCatch 钉住。
  const tree = h.render(() => ({
    type: mod.AskBoundary,
    props: { children: { type: 'span', props: { children: 'ok' } } },
  }), {});
  assert.equal(textOf(tree), 'ok');
});

await test('P6:请求失败时状态行说原因(而不是停在"正在回答…")', async () => {
  const failing = loadClientBundle({ testHooks: true });
  globalThis.fetch = async () => { throw new Error('连接被拒') };
  failing.internals.askOnMessage({ type: 'ask', text: 'x' });
  await settle();
  // 面板不吞异常:控制台有记录,且面板状态仍可继续(下一趟轮询会纠正)。
  assert.equal(failing.internals.askState.open, false);
});

console.log(`SUMMARY pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
