// scripts/test-ask-dialog.mjs —— 「问 DSH」对话框的接线回归(0.2.3 起;0.3.59 起改名为 ask-dialog)
//
// 这个套件原来叫 test-webview-bundle.mjs:那时提问面板是一个**构建产物**(webview/thread.{js,css}),
// 这里守着"产物在不在、官方渲染器与令牌打进去没有、版本对不对"。0.3.59 把那份产物、构建脚本
// (scripts/build-webview.mjs,esbuild)与编辑器里的兜底面板一起删掉了 —— 面板本体现在就在
// `lib/client.js` 里手写(守卫在 scripts/test-ask-panel-inline.mjs),所以这个套件只留下**接线**:
//   A1 **没有构建产物了**(产物目录/构建脚本/依赖/工作流/忽略项一处都不许留);
//   A2 **宿主侧 4 条 ask 路由**(state / send / approve / close)+ 能力位 + 上下文折叠;
//   A3 **扩展侧只上报编辑器状态**:不再上报 watch 列表、不再接对话流;拿不到心跳时给提示而不是开面板;
//   A4 **授权**(窗口 5 分钟 / 面板一关立刻交回 / 白名单 / fail closed);
//   A5 **桥的安全不变式**(唯一的非只读路由仍然只能回答既有请求)。
//
// 用法:node scripts/test-ask-dialog.mjs
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const EXT = '../assets/extensions/dshcs-editor-bridge';

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

const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');
const exists = (relative) => existsSync(new URL(relative, import.meta.url));
const pkg = JSON.parse(read('../package.json'));
const extPkg = JSON.parse(read(`${EXT}/package.json`));

/** 只保留代码行(整行注释剔掉):注释里会讲历史实现,字符串级断言不该被它带偏。 */
function codeLines(relative) {
  return read(relative).split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
}

// ---------------------------------------------------------------- A1 去构建化

await test('A1:面板产物与整条构建链已彻底消失(webview/**、build-webview.mjs、ask-panel.js)', () => {
  assert.equal(exists(`${EXT}/webview`), false, 'webview/ 产物目录必须删除(thread.js 1MB + thread.css 428KB)');
  assert.equal(exists('../scripts/build-webview.mjs'), false, '构建脚本必须删除(它是 esbuild 唯一的用户)');
  assert.equal(exists(`${EXT}/lib/ask-panel.js`), false, '面板纯模型随 webview 一起退役(对话框的面板在 lib/client.js)');
  assert.equal(exists(`${EXT}/webview/THIRD-PARTY.md`), false, '打包第三方许可文件随产物一起删除');
});

await test('A1:package.json 里不再有 webview 构建步骤与那批打包依赖', () => {
  assert.equal(pkg.scripts['build:webview'], undefined, 'build:webview 脚本必须删除');
  assert.doesNotMatch(pkg.scripts.prepack, /build-webview/, 'prepack 不许再构建 webview');
  assert.match(pkg.scripts.prepack, /vendor-vscode-server\.mjs/, 'prepack 仍然要生成 vendor 树');
  const webviewOnly = [
    'esbuild', 'react', 'react-dom', 'shiki', '@shikijs/langs', 'katex',
    'micromark-core-commonmark', 'micromark-extension-gfm', 'micromark-extension-math',
    'mdast-util-from-markdown', 'mdast-util-gfm', 'mdast-util-math',
    '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-theme',
  ];
  for (const name of webviewOnly) {
    assert.equal(pkg.devDependencies[name], undefined,
      `devDependency ${name} 只服务那次打包,必须一起清掉(渲染器现在由 DSH 页面模块表提供)`);
  }
});

await test('A1:仓库里不再有指向已删产物的引用(源码/脚本/工作流/忽略项)', () => {
  const offenders = [];
  const scan = (label, text) => {
    for (const [i, line] of text.split('\n').entries()) {
      if (/^\s*(\/\/|\*|#)/.test(line)) continue; // 注释/工作流注释里会讲历史
      if (/build:webview|build-webview\.mjs|thread\.(js|css)|ask-panel\.js|official-tokens/.test(line)) {
        offenders.push(`${label}:${i + 1} ${line.trim().slice(0, 100)}`);
      }
    }
  };
  for (const name of readdirSync(new URL('../scripts', import.meta.url))) {
    // 两个"守卫自己":本套件与 test-ask-panel-inline 都在**断言这些东西不存在**,
    // 它们的断言里必然出现这些字样 —— 跳过它们,扫其余文件。
    if (!name.endsWith('.mjs') || name === 'test-ask-dialog.mjs' || name === 'test-ask-panel-inline.mjs') continue;
    scan(`scripts/${name}`, read(`../scripts/${name}`));
  }
  scan('lib/index.js', read('../lib/index.js'));
  scan('lib/client.js', read('../lib/client.js'));
  scan('extension.js', read(`${EXT}/extension.js`));
  scan('bridge-client.js', read(`${EXT}/lib/bridge-client.js`));
  scan('ci.yml', read('../.github/workflows/ci.yml'));
  scan('release.yml', read('../.github/workflows/release.yml'));
  scan('.gitignore', read('../.gitignore'));
  assert.deepEqual(offenders, [], `还有文件在引用已删除的面板产物/构建步骤:\n  ${offenders.join('\n  ')}`);

  // 发布物不再包含任何 webview 目录(package.json 的 files 白名单是整目录,磁盘上已经没有它)。
  assert.equal(exists(`${EXT}/webview`), false);
  assert.match(extPkg.version, /^\d+\.\d+\.\d+$/, '扩展版本号要正常');
});

// ---------------------------------------------------------------- A2 宿主侧接线

await test('A2:宿主 4 条 ask 路由 + 能力探测 + 上下文折叠(0.3.24 / 0.3.59 去产物)', () => {
  const host = read('../lib/index.js');
  for (const route of ['ask/state', 'ask/send', 'ask/approve', 'ask/close']) {
    assert.ok(host.includes(`${'${API_BASE}'}/ask/${route.split('/')[1]}`), `缺少路由 ${route}`);
  }
  assert.equal(host.includes(`${'${API_BASE}'}/ask/bundle`), false, '/ask/bundle 必须删除(不再有产物可发)');
  assert.match(host, /askDialog: askDialogLive\(\)/,
    '/sync 的能力位必须建立在"客户端半部真的在轮询"之上');
  assert.match(host, /function askDialogLive\(\)/, '要有对话框存活判据(0.3.25 的教训)');
  assert.match(host, /askDialog\.lastPollAt = Date\.now\(\)/, '/ask/state 每次轮询都要记时间(存活证据)');
  assert.match(host, /kind === 'ask-open'/, '桥的 /event 要认 ask-open(右键提问的入口)');
  assert.match(host, /function askContextFromCache\(mode\)/, '上下文从宿主缓存的编辑器状态里取');
  assert.match(host, /const \{ agent: _agent, ...payload \} = result/, 'agent 句柄绝不能进 JSON');
  assert.match(host, /function answerApproval\(id, outcome\)/, '对话框与桥的 /approve 共用同一套白名单校验');
  // 授权窗口长度仍要由宿主给(对话框的倒计时基准),但**只走 /ask/state** —— /sync 不再驮这些字段。
  assert.match(host, /approvalHoldMs: DEFAULT_HOLD_MS/, '授权窗口长度要由宿主给出(面板不猜)');
  const syncBody = host.split('async function handleBridgeSync')[1].split('async function handleBridgeAsk')[0];
  for (const gone of ['thread:', 'threadRev', 'approvals:', 'approvalHoldMs', 'uiVersion']) {
    assert.equal(syncBody.includes(gone), false, `/sync 不该再带 ${gone}(那是编辑器面板时代的分工)`);
  }
  // 上下文折叠:host 拆分 → 投影进条目 → 面板渲染成默认收起的行。
  const session = read('../lib/bridge-session.mjs');
  assert.match(session, /export function splitEditorPrompt\(text\)/, '桥自己拼的消息要能拆回"上下文 + 原话"');
  const thread = read('../lib/bridge-thread.mjs');
  assert.match(thread, /splitEditorPrompt\(text\)/, '投影用户消息时要用它拆');
  // 客户端半部的面板形状由 test-ask-panel-inline 全面守着;这里只钉"面板确实在手写入口里"。
  const client = read('../lib/client.js');
  assert.match(client, /function askEnsureShell\(\)/, 'client 半部要造对话框外壳');
  assert.match(client, /function AskPanel\(props\)/, '面板本体是 lib/client.js 里的组件(不再是注入的产物)');
  assert.match(client, /require\('react-dom\/client'\)/, '面板要自己建 React 根(模块表种子词)');
  assert.match(client, /function askComponent\(primitives, name\)/,
    '官方部件要按"函数或 memo 对象"取(0.3.59 实测:MarkdownText 是 React.memo 对象)');
  const clientCode = codeLines('../lib/client.js');
  assert.doesNotMatch(clientCode, /__DSHCS_MOUNT__|acquireVsCodeApi|ask\/bundle/,
    '0.3.59 起不再注入构建产物:挂载点标记、假 VS Code API 与产物路由都必须彻底消失');
});

await test('A2:对话流思考投影仍在(含流式 reasoning-delta)', () => {
  const thread = read('../lib/bridge-thread.mjs');
  assert.match(thread, /block\.type === 'reasoning'/, '耐久消息里的 reasoning 块要投影');
  assert.match(thread, /reasoning-delta/, '流式帧的 reasoning-delta 也要投影(思考先到、正文后到)');
  assert.match(thread, /thinking: entry\.thinking \?\? null/, '快照要带 thinking 字段');
  const client = read('../lib/client.js');
  assert.match(client, /entry\.thinking/, '面板要读 thinking');
  assert.match(client, /IconThinkOutline14/, '思考行用官方思考图标');
});

// ---------------------------------------------------------------- A3 扩展侧接线

await test('A3:扩展只上报编辑器状态,不再上报 watch/对话流(面板已退役)', () => {
  const source = read(`${EXT}/extension.js`);
  assert.doesNotMatch(source, /askPanel|panelPayload|applySync|pendingQuestion|failPanel|renderPanelHtml/,
    '编辑器面板的状态机必须彻底删除');
  assert.doesNotMatch(source, /createWebviewPanel|asWebviewUri|localResourceRoots/,
    '不许再创建 webview 面板(那是 0.3.59 删掉的兜底路径)');
  assert.doesNotMatch(source, /threadRev|lastThreadSnapshot|approvalsUi/,
    '对话流/授权判据不再经扩展上报(0.3.59:全走 /api/code-server/ask/*)');
  // 右键命令只上报意图;拿不到心跳时**明确提示**,不开一扇看不见的窗。
  assert.match(source, /client\.askOpen\(mode\)/, '提问要走 ask-open(宿主打开 DSH 页面里的对话框)');
  assert.match(source, /notifyAskDialogUnavailable\(\)/, '对话框不可用要给出提示');
  assert.match(source, /请在 DSH 页面里打开\(或刷新\)Code Server 标签/, '提示要说清怎么办');
  assert.match(source, /captureAskContext\(mode\)/, '提问前仍要确认有活动编辑器(意图语义不变)');
  assert.doesNotMatch(source, /client\.ask\(|client\.approve\(/,
    '扩展不再直接投递提问/授权(那条路只在编辑器面板里存在过)');

  const client = read(`${EXT}/lib/bridge-client.js`);
  assert.match(client, /askDialog: body !== null && body\.askDialog === true/, '能力位要透传');
  assert.doesNotMatch(client, /body\.thread|body\.approvals|body\.uiVersion/, '客户端不再解析面板字段');
});

// ---------------------------------------------------------------- A4 授权

await test('A4:授权窗口 5 分钟 + 对话框一关立刻交回(0.3.23 修"授权框失效")', () => {
  const approval = read('../lib/bridge-approval.mjs');
  assert.match(approval, /export const DEFAULT_HOLD_MS = 300000/, '窗口默认 5 分钟(8 秒对人来说不现实)');
  assert.match(approval, /WATCH_POLL_MS/, '要有"面板还在不在看"的检查间隔');
  assert.match(approval, /if \(!hasPanel\(\)\) \{/, '对话框关掉要立刻交回官方链路,不干等窗口(0.3.37 起带日志)');
  const host = read('../lib/index.js');
  // 0.3.40:关掉对话框必须**解除武装**,否则 10 分钟 TTL 内还会接住请求却没地方显示卡片。
  assert.match(host, /askDialog\.armed === true && askDialog\.polls > 0/, '能力判据必须要求"武装中"');
  assert.match(host, /askDialog\.armed = false;/, '/ask/close 立即解除武装');
  assert.match(host, /askDialog\.lastPollAt = 0;/, '/ask/close 顺手清掉心跳时间戳');
  // 0.3.59:抢答判据收紧成"对话框在看 + 客户端半部在轮询" —— 客户端自己声明 approvalsUi 那条
  // 随编辑器面板一起删了(声明者已经不存在)。
  assert.match(host, /const verdict = watcher && dialogCapable/, '授权拦截:有人看 + 对话框真的能显示卡片');
  assert.equal(host.includes('bridgeApprovalsUi'), false, 'approvalsUi 判据必须删除(没有声明者了)');
  assert.match(host, /bridgeWatch\.dialogIds/, '唯一在看来源 = 对话框会话');
  assert.equal(host.includes('bridgeWatch.ids'), false, '编辑器面板的 watch 列表必须删除');
});

// ---------------------------------------------------------------- A5 桥的安全不变式

await test('A5:桥完全只读;唯一的写口令在 DSH 同源的 ask/approve 上,且只能回答既有请求', () => {
  const host = read('../lib/index.js');
  const table = host.split('function bridgeRouteTable()')[1].split('function ')[0];
  for (const suffix of ['/health', '/sync', '/old', '/event']) {
    assert.ok(table.includes(`suffix: '${suffix}'`), `桥应当有 ${suffix}`);
  }
  for (const gone of ['/ask', '/approve', '/bundle']) {
    assert.equal(table.includes(`suffix: '${gone}'`), false, `桥不该再有 ${gone}(0.3.59:提问与授权走 /api/code-server/ask/*)`);
  }
  assert.equal(host.includes('handleBridgeApprove'), false, '旧的桥 /approve handler 必须删除');
  // 写口令的约束(白名单 + 只认仍未决的 id)写死在实现里,且挂在 /api 那条上。
  assert.match(host, /if \(!PANEL_OUTCOMES\.includes\(outcome\)\)/, 'outcome 白名单在宿主侧把关');
  assert.match(host, /if \(bridgeApprovalBoard\.get\(id\) === null\)/, '只认本进程发起且仍未决的 id(单次使用)');
  assert.match(host, /\{ path: `\$\{API_BASE\}\/ask\/approve`, methods: \['POST'\]/, '写口令挂在 /api/code-server/ask/approve');
  const approval = read('../lib/bridge-approval.mjs');
  assert.match(approval, /export const PANEL_OUTCOMES = \['allowed-once', 'rejected'\]/, '只能给这两个 outcome');
  assert.match(approval, /没有答案者就 fail closed|fail closed/, '没有答案者必须失败关闭(不自动放行)');
  const bridge = read('../lib/bridge.mjs');
  assert.match(bridge, /四条只读路由 \+ 一条有界的模型调用/, '桥头部的安全不变量要写明"没有写路由",并交代 /complete 这条唯一例外');
  assert.match(bridge, /不允许\*\*出现写文件、改文档、执行命令/, '桥头部必须明确禁止写文件/执行命令类的路由');
});

console.log(`\nSUMMARY pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
