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
// 「问 DSH」对话框(0.2.0 起;0.3.59 起是**唯一**的提问 UI):
//   - 提问:右键命令只向宿主上报意图(`POST /event {kind:'ask-open', mode}`),对话框开在 **DSH 页面**里;
//     提问正文由插件的客户端半部经 `/api/code-server/ask/send` 投递(host 侧以**用户输入**进对话);
//   - 回答:host 用 `sessionController.follow` 把该会话的**新内容**投影成条目,对话框轮询
//     `/api/code-server/ask/state` 取回,面板用 DSH 官方 markdown 渲染器显示 —— 面板本体在客户端
//     半部(lib/client.js):手写、不打包,直接用 DSH 页面模块表里那一份渲染器;
//   - 授权(写工作区外文件 / 执行命令):host 把待决请求放进同一份状态,用户在对话框上
//     「允许一次 / 拒绝」,客户端半部调 `/api/code-server/ask/approve` 提交;
//   - 编辑器里**不再有**自己的提问面板:0.3.59 删掉了那份 webview 产物(thread.js/css),
//     探测不到对话框心跳时只弹一条提示,不开一扇用户看不见的窗。
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
const {
  FIM_DEBOUNCE_DEFAULT_MS,
  shouldRequest,
  buildPayload,
  fingerprint,
  createCompletionCache,
  formatTokens,
  describeFimUsage,
  matchDisabledGlob,
  toSingleLine,
} = require('./lib/fim-completion.js');
const { chooseOldSide, createDiffCache, describeChange } = require('./lib/diff-model.js');

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
/** 宿主是否已经把"对话框活着"证明给我们看(host 侧 askDialogLive:5 秒内收到过 /ask/state 轮询)。 */
let askDialogSupported = false;
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

// ---------------------------------------------------------------- FIM(幽灵)补全:实验性
//
// 这条能力**只在宿主说 enabled=true 时才注册 provider**(宿主的 /sync 每趟都带上来),
// 所以"设置里没开"不会让编辑器每敲一个字就发一次注定被拒的请求。
//
// 三条与宿主一致的分工:
//   - **该不该问**在这里判(纯逻辑 shouldRequest):不值得问的位置根本不发请求 ——
//     实测模型在被问到"不该补的地方"时会硬凑(2/2),所以判据必须前置;
//   - **问什么**在这里裁(窗口内的前后文),宿主侧再兜一层同样的上限;
//   - **问过没有**用本地缓存答(相同前后文 + 语言)。
/** 宿主报来的 FIM 状态与用量({enabled:false} 表示设置里没开)。 */
let fimSnapshot = { enabled: false };
/** 已注册的 provider disposer(null = 未注册)。 */
let fimProvider = null;
/** 扩展上下文(activate 里赋值):provider 需要在轮询里注册/注销,而轮询拿不到 context 参数。 */
let extensionContext = null;
/** 前后文 → 补全文本 的有界缓存。 */
const fimCache = createCompletionCache();

/** 取消感知的停顿:打字过程中的请求全丢掉(宿主侧也有速率闸,但那是最后一道)。
 *  停顿毫秒数由设置在宿主侧提供(0.3.62),每趟 /sync 带上来;拿不到就用默认值。 */
async function fimWait(token) {
  const configured = Number.isFinite(fimSnapshot.debounceMs) ? fimSnapshot.debounceMs : FIM_DEBOUNCE_DEFAULT_MS;
  const deadline = Date.now() + configured;
  while (Date.now() < deadline) {
    if (token.isCancellationRequested === true) return false;
    // 40ms 一跳:足够细,且不会为一次补全拉起一串定时器。
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return token.isCancellationRequested !== true;
}

/** 取光标前后的窗口(只按行取,不把整份文档摸一遍 —— 大文件上每次击键都 getText() 是灾难)。 */
function fimWindows(document, position) {
  const startLine = Math.max(0, position.line - 120);
  const endLine = Math.min(document.lineCount - 1, position.line + 40);
  const prefixText = document.getText(new vscode.Range(new vscode.Position(startLine, 0), position));
  const afterEnd = document.lineAt(endLine).range.end;
  const suffixText = document.getText(new vscode.Range(position, afterEnd));
  const lineTextBefore = document.lineAt(position.line).text.slice(0, position.character);
  return { prefixText, suffixText, lineTextBefore };
}

/** 内联补全 provider。返回 null = 这次不补(与"补一个空串"是两回事)。 */
function createFimProvider() {
  return {
    async provideInlineCompletionItems(document, position, _context, token) {
      if (fimSnapshot.enabled !== true) return null;
      const editor = vscode.window.activeTextEditor;
      const windows = fimWindows(document, position);
      const decision = shouldRequest({
        selectionEmpty: editor === undefined || editor === null ? true : editor.selection.isEmpty,
        scheme: document.uri.scheme,
        lineCount: document.lineCount,
        prefixText: windows.prefixText,
        suffixText: windows.suffixText,
        lineTextBefore: windows.lineTextBefore,
      });
      if (decision.ask !== true) return null;
      const payload = buildPayload({
        prefixText: windows.prefixText,
        suffixText: windows.suffixText,
        language: document.languageId,
        path: document.uri.scheme === 'file' ? document.uri.fsPath : document.uri.toString(),
      });
      // 按 glob 禁用(0.3.62):**在发请求之前**判 —— 这是这一层存在的主要理由(不花冤枉钱)。
      // 宿主侧还会再判一次(服务端那道),所以即使这里漏了也不会真的发出去。
      const blocked = matchDisabledGlob(payload.path, fimSnapshot.disableGlobs);
      if (blocked !== null) return null;
      const key = fingerprint(payload.prompt, payload.suffix, payload.language);
      const cached = fimCache.get(key);
      if (cached !== null) {
        return cached === '' ? null : [new vscode.InlineCompletionItem(cached, new vscode.Range(position, position))];
      }
      if ((await fimWait(token)) !== true) return null;
      if (client === null || client.isDormant()) return null;
      if (typeof client.complete !== 'function') return null;
      const result = await client.complete(payload);
      if (token.isCancellationRequested === true) return null;
      if (result.ok !== true) {
        if (result.status !== 409 && result.status !== 429) log(`补全失败:${result.error ?? '未知'}(status=${result.status ?? 0})`);
        return null;
      }
      // 多行关掉时宿主已经裁过一道;这里再裁一次是防"宿主版本比扩展旧"(随包分发的静态文件可能不同步)。
      const raw = typeof result.text === 'string' ? result.text : '';
      const text = fimSnapshot.multiline === false ? toSingleLine(raw) : raw;
      fimCache.set(key, text);
      if (text.trim() === '') return null; // 模型说"这里不用补"是合法回答
      log(`补全 ${text.length} 字符(${result.ms ?? '?'}ms,缓存${result.usage?.cacheReadTokens ?? 0} tok)`);
      return [new vscode.InlineCompletionItem(text, new vscode.Range(position, position))];
    },
  };
}

/** 按宿主状态注册/注销 provider(状态翻转时才动)。 */
function syncFimProvider() {
  const want = fimSnapshot.enabled === true;
  if (want && fimProvider === null) {
    fimProvider = vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, createFimProvider());
    if (extensionContext !== null) extensionContext.subscriptions.push(fimProvider);
    log('FIM 补全(实验性)已启用:开始提供内联补全');
  } else if (!want && fimProvider !== null) {
    try {
      fimProvider.dispose();
    } catch {
      // 已被 VS Code 回收
    }
    fimProvider = null;
    fimCache.clear();
    log('FIM 补全已关闭:不再提供内联补全');
  }
}

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
 * 时序很关键,别随手调换顺序:
 *   ① **先同步取缓冲区文本**(此刻 VS Code 的磁盘 watcher 可能还没把新内容灌进缓冲区 ⇒
 *      晚一步就取不到"改动前"了)与 isDirty;
 *   ② 再去宿主取**写前原文快照**(事件里的 oldKey;宿主在写的那一刻抓的,唯一精确的来源);
 *   ③ old 侧按 chooseOldSide 的优先级选,④ 最后才读磁盘作 new 侧。
 * ②③ 都要 await,所以①必须在它们之前 —— 否则"文件开着但宿主没给快照"的那条路就废了。
 */
async function handleAgentEdit(event) {
  const target = typeof event.path === 'string' && event.path !== '' ? event.path : null;
  if (target === null) return;
  if (!isInWorkspace(target)) {
    log(`跳过工作区外的改动:${target}`);
    return;
  }
  const uri = vscode.Uri.file(target);

  // 1) 先无条件把"此刻的缓冲区"抓在手里(它只在拿不到快照时才被采用,但必须现在取)。
  let bufferText = null;
  let dirty = false;
  const open = vscode.workspace.textDocuments.find((doc) => documentId(doc) === target);
  if (open !== undefined) {
    try {
      bufferText = open.getText();
    } catch {
      bufferText = null;
    }
    dirty = open.isDirty === true;
  }

  // 2) 宿主侧的写前原文(0.3.55):文件没在编辑器里打开时,这是唯一的 old 侧来源。
  let snapshotText = null;
  if (typeof event.oldKey === 'string' && event.oldKey !== '' && client !== null && typeof client.oldText === 'function') {
    try {
      snapshotText = await client.oldText(event.oldKey);
    } catch (error) {
      log(`取写前原文失败(${target}):${error && error.message ? error.message : error}`);
      snapshotText = null;
    }
  }

  // 3) old 侧:新建 ⇒ 空;其次快照;再退缓冲区;再退上次见过的缓存。
  const chosen = chooseOldSide({
    snapshotText,
    bufferText,
    cachedText: diffCache.recall(target),
    operation: typeof event.operation === 'string' ? event.operation : null,
  });
  const oldText = chosen.text;

  // 4) new 侧:磁盘内容。
  let newText = null;
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    newText = Buffer.from(bytes).toString('utf8');
  } catch {
    newText = null; // 可能被删了
  }
  diffCache.remember(target, newText === null ? '' : newText, Date.now());

  const decision = describeChange(oldText, newText, {
    operation: typeof event.operation === 'string' ? event.operation : null,
    oldSide: typeof event.oldSide === 'string' ? event.oldSide : null,
  });
  if (decision.show === false) {
    log(`agent 改动 ${target}:${decision.reason} → 不打扰`);
    return;
  }
  log(`agent 改动 ${target}:old=${chosen.source}(${oldText === null ? '无' : `${oldText.length} 字符`}) ${decision.reason}`);

  // 5) 开 diff(**左 = 改动前的虚拟文档,右 = 真实的磁盘文件**)。
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

  // 6) 脏缓冲区:只告警,绝不覆盖。
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
  // FIM(实验性):宿主每趟带状态与用量上来。只在**翻转**时注册/注销 provider,
  // 但状态栏每趟都刷 —— 用户要看到的是"这轮补全花了多少 token",它一直在变。
  const nextFim = result.fim !== null && typeof result.fim === 'object' ? result.fim : { enabled: false };
  const wasEnabled = fimSnapshot.enabled === true;
  fimSnapshot = nextFim;
  if ((nextFim.enabled === true) !== wasEnabled) syncFimProvider();
  updateStatusBar();
  // 能力探测(0.3.24):宿主证明"DSH 页面里的对话框活着"⇒ 右键提问走 ask-open 事件。
  // 0.3.59 起这是**唯一**的提问 UI(编辑器里的 webview 面板已退役):探测不到就只弹一条提示,
  // 绝不退回到一扇用户看不见的窗。
  if (result.askDialog === true && !askDialogSupported) {
    askDialogSupported = true;
    log('宿主已证明「问 DSH」对话框活着:右键提问将打开 DSH 页面里的对话框');
  } else if (result.askDialog !== true && askDialogSupported) {
    askDialogSupported = false;
    log('宿主不再报告对话框心跳(页面关了/刷新过):右键提问会给出提示');
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
    // FIM(实验性)开着时,状态栏多一格 token 计数 —— 这条链路的调用**不进 DSH 的计量**
    // (一次性调用不是 loop 请求,不进会话日志 ⇒ token-meter 看不到它),所以这里是用户唯一能看到
    // "补全花了多少"的地方(设置卡里也有同样一份,见 README)。
    const fimOn = fimSnapshot !== null && fimSnapshot.enabled === true;
    const used = fimOn ? Number(fimSnapshot.totalTokens ?? 0) : 0;
    statusBar.text = fimOn
      ? (used > 0 ? `$(plug) DSH $(zap) ${formatTokens(used)}` : '$(plug) DSH $(zap)')
      : '$(plug) DSH';
    const lines = [
      `编辑器桥已连接:${client.config.pipe}`,
      `上次轮询:${lastPollAt === 0 ? '—' : new Date(lastPollAt).toLocaleTimeString()}`,
      '',
      ...describeFimUsage(fimSnapshot),
      '',
      '点击查看日志',
    ];
    statusBar.tooltip = lines.join('\n');
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

/** 提问对话框不可用时的提示(0.3.59 起不再退回编辑器面板 —— 那一半已退役)。 */
function notifyAskDialogUnavailable() {
  const message = '「问 DSH」对话框不可用:请在 DSH 页面里打开(或刷新)Code Server 标签后重试。';
  log(message);
  void vscode.window.showInformationMessage(message);
}

/** 选中内容 → DSH(编辑器→DSH 的主入口):请宿主打开对话框并带上当前上下文。 */
async function askAboutSelection() {
  await openAskPanelFor('selection');
}

/** 整个文件 → DSH(不带选中、**不带行号**)。 */
async function askAboutFile() {
  await openAskPanelFor('file');
}

/** 两个命令的公共前置检查(桥可用 + 有活动编辑器 + 对话框活着)。 */
async function openAskPanelFor(mode) {
  if (client === null || client.isDormant()) {
    vscode.window.showInformationMessage('编辑器桥未启用:请在 DSH 里打开 Code Server 标签后重试。');
    return;
  }
  if (captureAskContext(mode) === null) {
    vscode.window.showInformationMessage('没有活动的编辑器:请先打开一个文件。');
    return;
  }
  // 0.3.59:提问 UI 只有一处 —— **DSH 页面里的悬浮对话框**(面板本体在插件客户端半部:手写、不打包,
  // 直接用页面模块表里的官方渲染器)。编辑器里的 webview 面板已退役:那份 1.4MB 产物 + esbuild +
  // 十几个打包依赖,只为了兜底一条"宿主证明不了对话框活着"的路 —— 而那种情况下用户在编辑器里
  // 看到的其实也不是他想要的对话(而且我们在 0.3.30 之后就从没走到过那条路)。
  // 所以现在:拿不到心跳就**明确说清怎么办**,不再开一扇看不见的窗。
  if (!askDialogSupported) {
    notifyAskDialogUnavailable();
    return;
  }
  try {
    const result = await client.askOpen(mode);
    if (result !== null && result.ok === true) {
      log(`已请宿主打开「问 DSH」对话框(mode=${mode})`);
      return;
    }
    log(`宿主没有打开对话框(${result !== null && result.error ? result.error : '未知原因'})`);
    notifyAskDialogUnavailable();
  } catch (error) {
    log(`ask-open 失败(${error && error.message ? error.message : error})`);
    notifyAskDialogUnavailable();
  }
}

function showBridgeLog() {
  if (output !== null) output.show(true);
}

// ---------------------------------------------------------------- 激活

function activate(context) {
  extensionContext = context;
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
