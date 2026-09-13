// dshcs-editor-bridge —— 编辑器桥的扩展侧(由 dsh-code-server-app 插件安装)
//
// 职责边界(与 host 侧 lib/bridge.mjs / bridge-tools.mjs 的分工):
//   - **本扩展**是唯一知道"用户此刻看到什么"的一方,所以编辑器状态(活动文件/选区/脏缓冲区/诊断)
//     在这里采集;
//   - **host** 负责鉴权、给 agent 提供工具、观察 agent 的写操作,并把 agent 的回复同步回来;
//   - 双向流量都走 **一趟轮询**(`POST /sync`:上报状态 + 取回事件与回复)。没有第二个定时器,
//     也没有 SSE/WS —— 扩展宿主不监听端口,host 反向请求不到它。
//
// 三条硬规则:
//   1. **只读**:本扩展只读编辑器状态,不写文件、不执行命令、不应用编辑(host 侧命名空间同理只读)。
//   2. **休眠而不是报错**:读不到 bridge.json(IDE 是用户自己起的旧实例 / 插件关了桥 / 已停止)
//      就什么都不做。状态栏不显示任何东西,更不弹通知。
//   3. **绝不覆盖未保存改动**:agent 改了文件而该文档是脏的就只告警 + 给 diff,由用户决定。
//
// 「问 DSH」面板(0.2.0 起;0.2.3 起正文走 DSH 官方渲染器):
//   - 提问走 `/ask`(host 侧以**用户输入**进对话);
//   - 回答**不再是另一条通道**:host 用 `sessionController.follow` 把该会话的**新内容**
//     投影成条目,随 `/sync` 的 `thread` 回来,面板用官方 markdown 渲染器显示
//     (产物由 scripts/build-webview.mjs 打成 webview/thread.js + thread.css);
//   - 授权(写工作区外文件 / 执行命令):host 的 `approvals` 字段回到面板,用户在面板上
//     「允许一次 / 拒绝」,扩展调 `/approve` 提交(桥里唯一的非只读路由)。
//
// 只依赖 `vscode` 与 Node 内置模块;纯逻辑在 lib/ 下且不 require('vscode'),便于单测。

'use strict';

const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  POLL_INTERVAL_MS,
  CONFIG_REREAD_MS,
  createClient,
} = require('./lib/bridge-client.js');
const { createProjector } = require('./lib/context-model.js');
const { createDiffCache, describeChange } = require('./lib/diff-model.js');
const {
  applySync,
  createPanelState,
  failPanel,
  panelPayload,
  pendingQuestion,
  renderPanelHtml,
} = require('./lib/ask-panel.js');

/** 状态栏项(仅在桥连通时显示)。 */
let statusBar = null;
/** 输出通道(除非用户显式打开,绝不主动弹)。 */
let output = null;
/** 桥客户端(整个扩展生命周期一个)。 */
let client = null;
/** 轮询定时器。 */
let pollTimer = null;
/** 上次成功轮询的时间(状态栏 tooltip 用)。 */
let lastPollAt = 0;
/** 「问 DSH」面板:null = 没开。`{panel, state, mode}`(状态模型见 lib/ask-panel.js)。 */
let askPanel = null;
/** 宿主是否支持 DSH 页面里的悬浮对话框(0.2.5 探测;0.3.26 起不再自动启用)。 */
let askDialogSupported = false;
/** 上一份对话流快照(host 只在变化时回传,这里兜住"没变化"的那些轮询)。 */
let lastThreadSnapshot;
/** 本扩展**当前持有**的对话流修订号(随请求上报;-1 = 一份都还没有 ⇒ host 必须发). */
let lastThreadRev = -1;
/** 扩展根目录(activate 时记下;面板要按它取 webview 产物 URI)。 */
let extensionRoot = null;
/** 是否已经确认过 host 端点可达(避免把"IDE 刚起、扩展先加载"误判为断线)。 */
let connected = false;
/** 诊断集合缓存:host 请求时现算,这里只做"有没有变化"的计数上报。 */
let lastDiagnosticCount = -1;
/** pathspec → 上次已知的磁盘文本(用于没打开的文件也能给出 old 侧)。 */
const diffCache = createDiffCache();
/** diff 左栏(改动前)的文本存放处:URI 里只放 key,文本放这里。
 *  为什么不把文本塞进 URI:一份文件几百 KB,URI 会被 workbench 截断,而且每开一次 diff 都要
 *  重新拼一遍;用 key + TextDocumentContentProvider 又短又稳。 */
const diffTextStore = new Map();
/** 同一个文件的 diff tab 不重复开。 */
const openDiffTabs = new Map();

/** 把"改动前的文本"登记进 store,返回它的 docId。 */
function registerDiffText(text) {
  const docId = crypto.createHash('sha256').update(text ?? '').digest('hex');
  diffTextStore.set(docId, text ?? '');
  // 有界:只保留最近 32 份(够回看几步;超出就丢最旧的)。
  while (diffTextStore.size > 32) {
    const oldest = diffTextStore.keys().next();
    if (oldest.done === true) break;
    diffTextStore.delete(oldest.value);
  }
  return docId;
}

/** 只读虚拟文档:diff 的左栏。 */
const oldSideProvider = {
  provideTextDocumentContent(uri) {
    return diffTextStore.get(uri.path) ?? '';
  },
};

function log(message) {
  if (output !== null) output.appendLine(`[${new Date().toISOString()}] ${message}`);
}

/** 是否落在某个工作区文件夹内(不能把 workspaceFolder 之外的路径喂给 DSH)。 */
function isInWorkspace(fsPath) {
  try {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const root = folder.uri.fsPath;
      if (typeof root !== 'string' || root === '') continue;
      const rel = path.relative(root, fsPath);
      if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return true;
    }
  } catch {
    // 探测失败 → 保守当作不包含
  }
  return false;
}

const projector = createProjector(isInWorkspace);

// ---------------------------------------------------------------- 编辑器状态采集

/** 一个文档的稳定标识:有磁盘路径用路径,否则用 untitled:<n>。 */
function documentId(doc) {
  if (doc === null || doc === undefined) return null;
  if (doc.uri === undefined || doc.uri === null) return null;
  if (doc.uri.scheme === 'untitled') return `untitled:${doc.uri.path}`;
  if (doc.uri.scheme !== 'file') return `${doc.uri.scheme}:${doc.uri.path}`;
  return doc.uri.fsPath;
}

/** 未保存的改动涉及多少行(用于让模型感知"改动量级")。 */
function countDirtyLines(doc) {
  try {
    // 存盘版本与当前缓冲区逐行比:只数"内容不同的行"这一个廉价近似。
    const current = doc.getText();
    const currentLines = current.split(/\r\n|\r|\n/);
    if (doc.isUntitled === true) return currentLines.length;
    if (doc.isDirty !== true) return 0;
    // 没有磁盘基线可比时,退回"当前行数"作为量级(不是精确值,但足以提示"有未保存内容")。
    return currentLines.length;
  } catch {
    return 0;
  }
}

/** 拍平一个文档。 */
function documentSnapshot(doc) {
  const id = documentId(doc);
  return {
    path: doc.uri.scheme === 'file' ? doc.uri.fsPath : (id ?? null),
    name: id ?? null,
    language: typeof doc.languageId === 'string' ? doc.languageId : null,
    dirty: doc.isDirty === true,
    untitled: doc.isUntitled === true,
    unsavedLines: countDirtyLines(doc),
    version: Number.isSafeInteger(doc.version) ? doc.version : null,
  };
}

/** 拍平工作区里全部诊断(`languages.getDiagnostics()`,核心已去抖 50ms)。 */
function diagnosticsSnapshot() {
  const groups = [];
  for (const [uri, items] of vscode.languages.getDiagnostics()) {
    if (uri.scheme !== 'file') continue; // 虚拟文档/untitled 的诊断没有可交出去的文件路径
    const fsPath = uri.fsPath;
    if (!isInWorkspace(fsPath)) continue;
    groups.push({
      path: fsPath,
      items: (items ?? []).map((item) => ({
        line: item.range.start.line + 1, // VS Code 0 基 → 对外统一 1 基
        column: item.range.start.character + 1,
        severity: item.severity,
        message: typeof item.message === 'string' ? item.message : '',
        source: typeof item.source === 'string' ? item.source : undefined,
        code: item.code === undefined || item.code === null
          ? undefined
          : (typeof item.code === 'object' ? item.code.value : item.code),
      })),
    });
  }
  return groups;
}

/** 活动编辑器快照(含选区与选中文本)。 */
function activeSnapshot() {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || editor === null) return null;
  const doc = editor.document;
  const base = documentSnapshot(doc);
  const selection = editor.selection;
  const result = {
    path: base.path,
    name: base.name,
    language: base.language,
    dirty: base.dirty,
    selection: null,
    selectedText: '',
  };
  if (selection !== undefined && selection !== null && selection.isEmpty === false) {
    result.selection = {
      startLine: selection.start.line + 1, // 1 基
      startColumn: selection.start.character + 1,
      endLine: selection.end.line + 1,
      endColumn: selection.end.character + 1,
    };
    try {
      result.selectedText = doc.getText(selection);
    } catch {
      result.selectedText = '';
    }
  }
  return result;
}

// ---------------------------------------------------------------- host → 扩展:事件

/** 活动编辑器快照(含选区与选中文本)。 */

/**
 * agent 改了一个文件:给出 old/new 两侧并开 diff。
 *
 * 时序很关键:事件到达时 VS Code 的磁盘 watcher 可能还没把新内容灌进缓冲区,
 * 所以**先同步取缓冲区文本**(= 改动前),再去读磁盘(= 改动后)。
 */
async function handleAgentEdit(event) {
  const target = typeof event.path === 'string' && event.path !== '' ? event.path : null;
  if (target === null) return;
  if (!isInWorkspace(target)) {
    log(`跳过工作区外的改动:${target}`);
    return;
  }
  const uri = vscode.Uri.file(target);

  // 1) old 侧:优先"此刻的缓冲区"(还未被磁盘改动刷新);没有打开的文档就退回缓存。
  let oldText = diffCache.recall(target);
  let dirty = false;
  const open = vscode.workspace.textDocuments.find((doc) => documentId(doc) === target);
  if (open !== undefined) {
    try {
      oldText = open.getText();
    } catch {
      // 保留缓存值
    }
    dirty = open.isDirty === true;
  }

  // 2) new 侧:磁盘内容。
  let newText = null;
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    newText = Buffer.from(bytes).toString('utf8');
  } catch {
    newText = null; // 可能被删了
  }
  diffCache.remember(target, newText === null ? '' : newText, Date.now());

  const decision = describeChange(oldText, newText);
  if (decision.show === false) {
    log(`agent 改动 ${target}:${decision.reason} → 不打扰`);
    return;
  }

  // 3) 开 diff(**左 = 改动前的虚拟文档,右 = 真实的磁盘文件**)。
  //    右栏刻意用 file: URI:这样用户在 diff 里按"撤销/编辑"落到的是真文件,VS Code 的
  //    常规编辑与撤销栈全部生效,我们不需要自己做任何写回。
  const docId = registerDiffText(oldText ?? '');
  const left = vscode.Uri.from({ scheme: 'dshcs-old', path: docId });
  const right = uri;
  // 行数统计可能是 null(只有一侧时无从得知)—— 那时只显示原因,不显示数字。
  const delta = (decision.added === null || decision.removed === null)
    ? ''
    : `${decision.added > 0 ? ` +${decision.added}` : ''}${decision.removed > 0 ? ` -${decision.removed}` : ''}`;
  const title = `${path.basename(target)} ← DSH 改动 (${decision.reason}${delta})`;
  const previewTab = dirty !== true; // 脏缓冲区时用正式 tab(用户要长时间对照)
  try {
    const existing = openDiffTabs.get(target);
    if (existing !== undefined) {
      try {
        existing.dispose();
      } catch {
        // 已被用户关掉
      }
      openDiffTabs.delete(target);
    }
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: previewTab, preserveFocus: true });
    // 记下这次开的 tab(下次同文件先关旧的,避免堆一屏同名 diff);有界,避免长会话里泄漏。
    try {
      const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs);
      const ours = tabs.find((tab) => {
        const input = tab.input;
        return input !== undefined && input !== null
          && input.original !== undefined && input.original.scheme === 'dshcs-old'
          && input.modified !== undefined && input.modified.fsPath === target;
      });
      if (ours !== undefined) {
        openDiffTabs.set(target, ours);
        while (openDiffTabs.size > 8) {
          const oldest = openDiffTabs.keys().next();
          if (oldest.done === true) break;
          openDiffTabs.delete(oldest.value);
        }
      }
    } catch {
      // 拿不到 tab 列表(版本差异)不影响 diff 已经打开这件事
    }
  } catch (error) {
    log(`打开 diff 失败(${target}):${error && error.message ? error.message : error}`);
  }

  // 4) 脏缓冲区:只告警,绝不覆盖。
  if (dirty === true) {
    const choice = await vscode.window.showWarningMessage(
      `${path.basename(target)} 在编辑器里有未保存的改动,而 DSH 刚改了磁盘上的同名文件。`,
      { modal: false },
      '查看差异',
      '忽略',
    );
    if (choice === '查看差异') {
      try {
        await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: false });
      } catch {
        // 已经开过了
      }
    }
  }
}

/** 处理一条 host 事件。 */
async function handleEvent(event) {
  if (event === null || typeof event !== 'object') return;
  switch (event.kind) {
    case 'agent-edit':
      await handleAgentEdit(event);
      break;
    case 'diagnostics-changed':
      // 目前 host 不推这条;留着是为了将来"改完提示 agent 复查"。
      log('诊断有变化(host 上报)');
      break;
    default:
      log(`未知事件 ${String(event.kind)}`);
  }
}

// ---------------------------------------------------------------- 轮询

async function pollOnce() {
  if (client === null) return;
  if (client.isDormant()) {
    // 休眠:读不到配置(桥关着 / IDE 是自己起的旧实例)。静默,状态栏也收起来。
    if (connected) {
      connected = false;
      log('桥配置消失 → 进入休眠');
    }
    updateStatusBar();
    return;
  }
  // 一趟来回:推状态 + 取事件。诊断只在有文档打开时才现算(关掉面板时不做无用功)。
  const docs = vscode.workspace.textDocuments;
  const hasEditor = docs.length > 0;
  const diagnostics = hasEditor ? diagnosticsSnapshot() : [];
  const payload = {
    context: projector.context({
      active: activeSnapshot(),
      documents: docs.map((doc) => documentSnapshot(doc)),
      diagnostics,
    }),
    diagnostics,
    at: Date.now(),
    // 面板声明它要看哪个会话:host 据此对齐 `sessionController.follow` 订阅,
    // 并用"有没有人在看"决定授权请求是先问面板还是直接交给 DSH 界面
    // (见 host 侧 lib/bridge-thread.mjs / lib/bridge-approval.mjs)。
    watch: askPanel !== null && askPanel.state.sessionId !== null ? [askPanel.state.sessionId] : [],
    // 声明"本扩展懂对话流修订号"(0.2.9):host 才会在没变化时省略 thread 省流量。
    // 不声明(旧扩展)时 host 照旧发整份快照 —— 否则旧扩展会误报"宿主没有对话流能力"。
    threadRev: lastThreadRev,
    // 声明"我这边能把授权卡片画出来"(0.3.30):面板开着 **且** 对话流正常(不是那条"宿主没有对话流能力"
    // 的坏状态)。宿主只在它为 true 时才敢抢答授权 —— 否则"抢过来却没人看得见"就是用户遇到的
    // "没弹出授权"(官方卡片被我们吞了,面板又不画)。
    approvalsUi: askPanel !== null && askPanel.state.available === true,
  };
  const result = await client.sync(payload);
  if (result.ok !== true) {
    if (connected) {
      // 401 = 令牌轮换(host 重启);503/0 = IDE 停了。都只降级显示,不弹窗。
      connected = false;
      log(`同步失败(${result.status ?? 0}):${result.error ?? '未知'};等待恢复`);
      updateStatusBar();
    }
    return;
  }
  if (!connected) {
    connected = true;
    log(`已连接宿主(${client.config.pipe})`);
    updateStatusBar();
  }
  lastPollAt = Date.now();
  for (const event of result.events ?? []) {
    await handleEvent(event);
  }
  if ((result.events ?? []).length > 0) client.persist();
  // 能力探测:宿主支持悬浮对话框(0.3.24)⇒ 右键提问不再开编辑器面板。
  if (result.askDialog === true && !askDialogSupported) {
    askDialogSupported = true;
    log('宿主支持 DSH 页面里的对话对话框(本版仍用编辑器面板,见 0.3.26 回退)');
  }
  // 对话流 + 授权待决:host 每趟把被观看会话的**新内容**与待决授权一起回来
  // (见 host 侧 lib/bridge-thread.mjs / lib/bridge-approval.mjs),面板有变化才重画。
  // 0.3.27 起 host **没变化就不带 thread**(省掉每 600ms 一份 ~1MB 的快照,那会把 /sync 拖成超时,
  // 于是 approvals 也一起丢掉、卡片永远不出现)⇒ 这里沿用上一份快照。
  if (askPanel !== null) {
    const thread = result.thread !== undefined
      ? result.thread
      : (result.threadRev !== undefined ? lastThreadSnapshot : undefined);
    if (result.thread !== undefined) lastThreadSnapshot = result.thread;
    if (Number.isSafeInteger(result.threadRev)) lastThreadRev = result.threadRev;
    // 刚开面板、手里还没有任何快照,而 host 说"没变化"(它只看到我们持有 -1)→ 等下一份,别误报
    // "宿主没有对话流能力"(0.3.29)。
    if (result.thread === undefined && lastThreadSnapshot === undefined) {
      refreshAskPanel();
      return;
    }
    if (applySync(askPanel.state, { ...result, thread })) refreshAskPanel();
  }
}

function startPolling(context) {
  if (pollTimer !== null) return;
  // 首次延迟:让 IDE 的扩展宿主把工作区索引起来,免得一上来就报一堆诊断。
  pollTimer = setInterval(() => {
    pollOnce().catch((error) => log(`轮询异常:${error && error.message ? error.message : error}`));
  }, POLL_INTERVAL_MS);
  context.subscriptions.push({ dispose() { if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; } } });
  // 立刻跑一次,别等 600ms。
  setTimeout(() => { pollOnce().catch(() => {}); }, 1200);
}

function updateStatusBar() {
  if (statusBar === null) return;
  if (connected && client !== null && client.config !== null) {
    statusBar.text = '$(plug) DSH';
    statusBar.tooltip = `编辑器桥已连接:${client.config.pipe}\n上次轮询:${lastPollAt === 0 ? '—' : new Date(lastPollAt).toLocaleTimeString()}\n点击查看日志`;
    statusBar.command = 'dsh-code-server.showBridgeLog';
    statusBar.show();
  } else {
    statusBar.hide();
  }
}

// ---------------------------------------------------------------- 命令 / 提问面板

/**
 * 当前编辑器上下文(发送时现取一次:用户可以在面板开着的同时换选区)。
 *
 * @param {'selection'|'file'} mode 提问意图:
 *   - `selection`(「针对选中内容提问」):有选区就带上**行区间 + 选区正文**;
 *     没有选区时退化成**纯文件**(不带行号 —— 光标停在哪一行跟问题无关,行号只会误导 agent);
 *   - `file`(「针对当前文件提问」):**永远不带行号、不带选区**,只给文件路径。
 */
function captureAskContext(mode) {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || editor === null) return null;
  const doc = editor.document;
  const selection = editor.selection;
  const hasSelection = mode === 'selection'
    && selection !== undefined && selection !== null && selection.isEmpty === false;
  const selectedText = hasSelection ? doc.getText(selection) : '';
  return {
    file: doc.uri.scheme === 'file' ? doc.uri.fsPath : null,
    lineStart: hasSelection ? selection.start.line + 1 : null,
    lineEnd: hasSelection ? selection.end.line + 1 : null,
    selection: selectedText === '' ? null : selectedText,
    languageId: doc.languageId ?? null,
  };
}

/** 把状态推给面板(增量更新:输入框与滚动位置都不受影响)。 */
function refreshAskPanel() {
  if (askPanel === null) return;
  void askPanel.panel.webview.postMessage(panelPayload(askPanel.state));
}

/** 面板进入错误态:状态行 + 最新一条本地提问都标上原因(绝不静默)。 */
function failAskPanel(message) {
  if (askPanel === null) return;
  failPanel(askPanel.state, message);
  log(message);
  refreshAskPanel();
}

/** 面板收到一条提问:投递到 DSH,**本地先乐观显示**,回答由 host 的对话流回填。 */
async function sendAskFromPanel(text) {
  if (askPanel === null || client === null) return;
  // 用面板自己的意图(selection / file)取上下文:文件级提问永远不带行号。
  const context = captureAskContext(askPanel.mode) ?? askPanel.state.context;
  pendingQuestion(askPanel.state, text, context);
  refreshAskPanel();
  try {
    const result = await client.ask({
      text,
      file: context === null ? null : context.file,
      lineStart: context === null ? null : context.lineStart,
      lineEnd: context === null ? null : context.lineEnd,
      selection: context === null ? null : context.selection,
      languageId: context === null ? null : context.languageId,
    });
    if (result.ok === true) {
      askPanel.state.sessionId = typeof result.sessionId === 'string' ? result.sessionId : null;
      askPanel.state.status = 'thinking';
      log(`已投递编辑器消息(session=${result.sessionId ?? '?'})`);
    } else {
      failAskPanel(`未投递:${result.error ?? '未知原因'}`);
      return;
    }
  } catch (error) {
    const status = error && error.status;
    failAskPanel(status === 409
      ? 'DSH 里没有可投递的会话:请先在 DSH 里打开或新建一个会话。'
      : (status === 401 || status === 503
        ? '编辑器桥尚未就绪,请稍后重试。'
        : `投递失败:${error && error.message ? error.message : error}`));
    return;
  }
  refreshAskPanel();
}

/**
 * 面板对一条授权请求的决策 → `POST /approve`。
 *
 * 只接受白名单的两个值(host 侧同样只认这两个);失败必须说出来:面板里点不动的时候,
 * 用户唯一的线索就是这行状态/日志。
 */
async function decideApproval(id, outcome) {
  if (askPanel === null || client === null) return;
  if (outcome !== 'allowed-once' && outcome !== 'rejected') return;
  try {
    await client.approve(id, outcome);
    log(`面板授权决策已提交:${id} → ${outcome}`);
  } catch (error) {
    const status = error && error.status;
    const message = status === 409
      ? '这条授权请求已经过期或已被处理(DSH 界面里会弹同一张卡片)。'
      : (status === 401 || status === 503
        ? '编辑器桥尚未就绪,授权没有提交。'
        : `授权提交失败:${error && error.message ? error.message : error}`);
    // 卡片已经没意义了:本地撤掉,避免用户反复点。
    askPanel.state.approvals = askPanel.state.approvals.filter((item) => item.id !== id);
    failAskPanel(message);
    return;
  }
  refreshAskPanel();
}

/**
 * 打开(或聚焦)「问 DSH」面板。
 * @param {'selection'|'file'} mode 提问意图(决定发送时带不带行号/选区),见 captureAskContext。
 */
function openAskPanel(mode = 'selection') {
  const contextInfo = captureAskContext(mode);
  if (askPanel === null) {
    // webview 产物是构建出来的(scripts/build-webview.mjs)。缺了就别开一个空白面板。
    const webviewDir = vscode.Uri.joinPath(extensionRoot, 'webview');
    const bundle = vscode.Uri.joinPath(webviewDir, 'thread.js');
    const style = vscode.Uri.joinPath(webviewDir, 'thread.css');
    if (!fs.existsSync(bundle.fsPath) || !fs.existsSync(style.fsPath)) {
      const message = `面板产物缺失(${bundle.fsPath}):请重新安装插件,或在源码里跑 pnpm run build:webview`;
      log(message);
      void vscode.window.showErrorMessage(message);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'dshAsk',
      'DSH 对话',
      // 对话框形状(0.2.4):开在**当前编辑器组**,占满工作台宽度 —— 不再用 `Beside` 挤成一条侧栏。
      // 面板内容自己居中限宽,看起来就是编辑器上的一扇对话窗;右上角的 ✕ 关掉它。
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        // 只允许加载扩展自己的 webview 目录(产物 + 字体),不给别的本地文件开口子。
        localResourceRoots: [webviewDir],
      },
    );
    askPanel = { panel, state: createPanelState(), mode };
    panel.webview.html = renderPanelHtml({
      cspSource: panel.webview.cspSource,
      nonce: crypto.randomBytes(16).toString('base64url'),
      scriptUri: panel.webview.asWebviewUri(bundle).toString(),
      styleUri: panel.webview.asWebviewUri(style).toString(),
    });
    panel.webview.onDidReceiveMessage((message) => {
      if (message === null || typeof message !== 'object') return;
      if (message.type === 'ready') {
        refreshAskPanel();
        return;
      }
      if (message.type === 'ask' && typeof message.text === 'string') {
        const text = message.text.trim();
        if (text !== '') void sendAskFromPanel(text);
        return;
      }
      if (message.type === 'approve' && typeof message.id === 'string') {
        void decideApproval(message.id, message.outcome);
        return;
      }
      if (message.type === 'close') {
        // 面板上的 ✕:关掉它(= 不再看这个会话 ⇒ 待决授权立刻交回 DSH 界面,不用干等窗口)。
        panel.dispose();
      }
    });
    panel.onDidDispose(() => {
      askPanel = null;
    });
  }
  askPanel.state.context = contextInfo;
  askPanel.mode = mode;
  // 已经开着就提到前面(对话框不重复开)。
  askPanel.panel.reveal(vscode.ViewColumn.Active, false);
  refreshAskPanel();
}

/** 选中内容 → DSH(编辑器→DSH 的主入口):打开面板并带上当前上下文。 */
async function askAboutSelection() {
  await openAskPanelFor('selection');
}

/** 整个文件 → DSH(不带选中、**不带行号**)。 */
async function askAboutFile() {
  await openAskPanelFor('file');
}

/** 两个命令的公共前置检查(桥可用 + 有活动编辑器)。 */
async function openAskPanelFor(mode) {
  if (client === null || client.isDormant()) {
    vscode.window.showInformationMessage('编辑器桥未启用:请在 DSH 里打开 Code Server 标签后重试。');
    return;
  }
  if (captureAskContext(mode) === null) {
    vscode.window.showInformationMessage('没有活动的编辑器:请先打开一个文件。');
    return;
  }
  // 0.3.26 回退:提问**始终**开编辑器里的 webview 面板。
  // 0.2.5/0.2.6 试过"浮在 DSH 页面上的对话框",但实测在编辑器侧看不到授权卡片,而面板这条路是
  // 验证过的(0.3.22/0.3.23 实测卡片就在面板里)。功能优先:先把能看、能批授权的 UI 还给用户;
  // 对话框那套(client 半部 + /api/code-server/ask/*)留着但**不再自动启用**。
  // 0.3.30:把悬浮对话框还回来(用户要的形态),但只在宿主证明客户端半部在轮询时才用
  // (askDialogSupported 现在等于 askDialogLive());否则安静退回编辑器面板 —— 两条路都能看能批授权。
  if (askDialogSupported) {
    try {
      const result = await client.askOpen(mode);
      if (result !== null && result.ok === true) {
        log('已请宿主打开悬浮对话框(mode=' + mode + ')');
        return;
      }
      log('宿主没有打开对话框(' + (result !== null && result.error ? result.error : '未知原因') + ')→ 退回编辑器面板');
    } catch (error) {
      log('ask-open 失败(' + (error && error.message ? error.message : error) + ') → 退回编辑器面板');
    }
  }
  openAskPanel(mode);
}

function showBridgeLog() {
  if (output !== null) output.show(true);
}

// ---------------------------------------------------------------- 激活

function activate(context) {
  output = vscode.window.createOutputChannel('DSH Editor Bridge');
  context.subscriptions.push(output);

  // 面板 webview 的产物按扩展根目录取 URI(0.2.3 起正文走官方渲染器,产物是打包出来的)。
  extensionRoot = context.extensionUri;

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  context.subscriptions.push(statusBar);

  // diff 左栏的只读虚拟文档(`dshcs-old:`)。必须注册,否则 vscode.diff 左栏是空的。
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('dshcs-old', oldSideProvider),
  );

  // 配置目录由 bridge-client 统一解析(host 注入的 DSHCS_EXTENSIONS_DIR → 自身位置反推)。
  // **不要在这里自己算**:0.3.0–0.3.11 那段 `resolve(__dirname,'..','..')` 比 <extensionsDir>
  // 还高一级,任何布局都读不到 bridge.json ⇒ 桥一直休眠(见 docs 第 18 节)。
  client = createClient();
  if (client.refresh() === null) {
    log('未找到桥配置(休眠)。DSH 插件启用编辑器桥并启动 IDE 后,这里会自动连上。');
  } else {
    client.restore();
    log(`发现桥配置:${client.config.pipe}`);
  }

  // host 请求时才现算,这里只维护"上次计数",用于日志与将来的变化上报。
  context.subscriptions.push(vscode.languages.onDidChangeDiagnostics(() => {
    try {
      const total = diagnosticsSnapshot().reduce((sum, group) => sum + group.items.length, 0);
      if (lastDiagnosticCount >= 0 && total !== lastDiagnosticCount) {
        log(`诊断变化:${lastDiagnosticCount} → ${total}`);
      }
      lastDiagnosticCount = total;
    } catch {
      // 忽略
    }
  }));

  // 文档关闭时把最后内容留在缓存里(下次 agent 改它就能给出 old 侧)。
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument((doc) => {
    const id = documentId(doc);
    if (id === null || doc.uri.scheme !== 'file') return;
    try {
      diffCache.remember(id, doc.getText(), Date.now());
    } catch {
      // 忽略
    }
  }));

  // **方向说明(改之前先读)**:扩展宿主里**没有** HTTP 服务器 —— 它是 VS Code server 的
  // 一个子进程,不监听任何端口。所以 host **不能**反向请求本扩展拿编辑器状态。
  // 实际方向是:本扩展在每次轮询里 `POST <BRIDGE_BASE>/sync`,把状态推上去、
  // 同时取回 host 的待处理事件(agent 改了哪个文件)。host 侧缓存状态供 agent 工具读。
  // 见 lib/bridge-client.js 的 sync() 与 lib/bridge.mjs 顶部的通道说明。
  // **路径是 /code-server-bridge,不是 /api/...**(0.3.9 修正):/api 那层要求浏览器 cookie,
  // 扩展宿主拿不到 ⇒ 请求永远到不了插件路由。

  // 命令
  context.subscriptions.push(vscode.commands.registerCommand('dsh-code-server.askAboutSelection', () => {
    askAboutSelection().catch((error) => log(`askAboutSelection 异常:${error && error.message ? error.message : error}`));
  }));
  context.subscriptions.push(vscode.commands.registerCommand('dsh-code-server.askAboutFile', () => {
    askAboutFile().catch((error) => log(`askAboutFile 异常:${error && error.message ? error.message : error}`));
  }));
  context.subscriptions.push(vscode.commands.registerCommand('dsh-code-server.showBridgeLog', () => showBridgeLog()));

  // 定期重读配置(令牌/端口轮换后最多 CONFIG_REREAD_MS 恢复)。
  const refreshTimer = setInterval(() => {
    if (client === null) return;
    const before = client.config === null ? null : client.config.pipe;
    const next = client.refresh();
    const after = next === null ? null : next.pipe;
    if (before !== after) {
      log(`桥目标变化:${before ?? '(休眠)'} → ${after ?? '(休眠)'}`);
      if (after !== null) client.restore();
      updateStatusBar();
    }
  }, CONFIG_REREAD_MS);
  context.subscriptions.push({ dispose() { clearInterval(refreshTimer); } });

  startPolling(context);
  updateStatusBar();
  log('dshcs-editor-bridge 已激活');
}

function deactivate() {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (client !== null) client.persist();
}

module.exports = { activate, deactivate };
