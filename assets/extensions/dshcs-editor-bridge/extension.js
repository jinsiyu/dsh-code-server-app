// dshcs-editor-bridge —— 编辑器桥的扩展侧(由 dsh-code-server-app 插件安装)
//
// 职责边界(与 host 侧 lib/bridge.mjs / bridge-tools.mjs 的分工):
//   - **本扩展**是唯一知道"用户此刻看到什么"的一方,所以 /context 与 /diagnostics 的数据在这里采集;
//   - **host** 负责鉴权、给 agent 提供工具、观察 agent 的写操作;
//   - 方向 host → 扩展 的事件走 **轮询**(host 推环形缓冲,这里 GET /events?since=N)。
//
// 三条硬规则:
//   1. **只读**:本扩展只读编辑器状态,不写文件、不执行命令、不应用编辑(host 侧命名空间同理只读)。
//   2. **休眠而不是报错**:读不到 bridge.json(IDE 是用户自己起的旧实例 / 插件关了桥 / 已停止)
//      就什么都不做。状态栏不显示任何东西,更不弹通知。
//   3. **绝不覆盖未保存改动**:agent 改了文件而该文档是脏的就只告警 + 给 diff,由用户决定。
//
// 只依赖 `vscode` 与 Node 内置模块;纯逻辑在 lib/ 下且不 require('vscode'),便于单测。

'use strict';

const vscode = require('vscode');
const crypto = require('crypto');
const path = require('path');

const {
  POLL_INTERVAL_MS,
  CONFIG_REREAD_MS,
  createClient,
} = require('./lib/bridge-client.js');
const { createProjector } = require('./lib/context-model.js');
const { createDiffCache, describeChange } = require('./lib/diff-model.js');

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

// ---------------------------------------------------------------- 命令

/** 选中内容 → DSH(编辑器→DSH 的主入口)。 */
async function askAboutSelection() {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || editor === null) {
    vscode.window.showInformationMessage('没有活动的编辑器。');
    return;
  }
  if (client === null || client.isDormant()) {
    vscode.window.showInformationMessage('编辑器桥未启用:请在 DSH 里打开 Code Server 标签后重试。');
    return;
  }
  const doc = editor.document;
  const selection = editor.selection;
  const hasSelection = selection !== undefined && selection !== null && selection.isEmpty === false;
  const selectedText = hasSelection ? doc.getText(selection) : '';
  const question = await vscode.window.showInputBox({
    title: hasSelection ? '问 DSH(带选中内容)' : '问 DSH(当前文件)',
    prompt: `${path.basename(doc.fileName)}${hasSelection ? ` 第 ${selection.start.line + 1}-${selection.end.line + 1} 行` : ''}`,
    placeHolder: '例如:这段逻辑有什么问题?',
    ignoreFocusOut: true,
  });
  if (question === undefined || question.trim() === '') return;
  try {
    const result = await client.ask({
      text: question.trim(),
      file: doc.uri.scheme === 'file' ? doc.uri.fsPath : null,
      lineStart: hasSelection ? selection.start.line + 1 : (doc.isDirty ? null : editor.selection.active.line + 1),
      lineEnd: hasSelection ? selection.end.line + 1 : null,
      selection: selectedText === '' ? null : selectedText,
      languageId: doc.languageId ?? null,
    });
    if (result.ok === true) {
      vscode.window.setStatusBarMessage('$(check) 已发送给 DSH', 3000);
      log(`已投递编辑器消息(session=${result.sessionId ?? '?'})`);
    } else {
      vscode.window.showWarningMessage(`未投递:${result.error ?? '未知原因'}`);
    }
  } catch (error) {
    const status = error && error.status;
    if (status === 409) vscode.window.showWarningMessage('DSH 里没有可投递的会话:请先打开或新建一个会话。');
    else if (status === 401 || status === 503) vscode.window.showWarningMessage('编辑器桥尚未就绪,请稍后重试。');
    else vscode.window.showWarningMessage(`投递失败:${error && error.message ? error.message : error}`);
  }
}

/** 整个文件 → DSH(不需要选中)。 */
async function askAboutFile() {
  await askAboutSelection();
}

function showBridgeLog() {
  if (output !== null) output.show(true);
}

// ---------------------------------------------------------------- 激活

function activate(context) {
  output = vscode.window.createOutputChannel('DSH Editor Bridge');
  context.subscriptions.push(output);

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
