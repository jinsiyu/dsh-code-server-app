// dshcs-editor-bridge / lib/ask-panel.js —— 「问 DSH」面板的纯逻辑(0.2.3)
//
// **一份模型,两边用**:
//   - 扩展侧(extension.js)用它保存面板状态,并组装每趟轮询 postMessage 的载荷;
//   - 面板侧(webview/src/app.jsx,由 scripts/build-webview.mjs 打成 webview/thread.js)
//     用它把载荷变成视图 —— 消息正文交给 DSH **官方** markdown 渲染器
//     (`@deepseek-ai/dsh-client-ui-primitives` 的 MarkdownText,与 DSH 界面同一份代码)。
//
// 0.2.0–0.2.2 的面板自己拼 HTML 字符串、正文按 `white-space: pre-wrap` 原样显示,与 DSH 界面
// 的排版不一致;0.2.3 起正文走官方渲染器,面板只保留"外壳"逻辑(上下文 / 状态 / 输入框)。
//
// 本文件不 require('vscode')、不碰 DOM,所以能在普通 Node 里单测
// (scripts/test-bridge-extension.mjs)。

'use strict';

/** 面板保留的对话条目上限(宿主侧 lib/bridge-thread.mjs 也有上限;这里再兜一层)。 */
const MAX_ENTRIES = 200;

/** 本地乐观提问(已发出、宿主还没回显)的上限。 */
const MAX_PENDING = 6;

/** 单条正文渲染上限(宿主已截到 8000,这里只防意外)。 */
const MAX_TEXT = 20000;

/** 授权卡片的默认等待窗口(毫秒);宿主随 /sync 给出真实值,这里只是兜底。 */
const DEFAULT_HOLD_MS = 8000;

/** 条目角色(与 lib/bridge-thread.mjs 的投影一致)。 */
const ROLES = ['user', 'assistant', 'tool', 'approval'];

/** 折叠空白:用于"本地乐观提问"与"宿主回显"的同一性比较。 */
function normalizeText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** 面板状态(纯数据,便于单测)。 */
function createPanelState() {
  return {
    /** 对话条目(宿主权威;0.3.22 起只含**新内容**)。 */
    entries: [],
    /** 条目签名:变了才刷新面板(600ms 一趟轮询,不能每趟都重传几十 KB)。 */
    entriesSig: '',
    /** 已发出、宿主还没回显的提问(乐观显示)。 */
    pending: [],
    /** 待决授权请求 [{id, toolName, reason, callId, at}]。 */
    approvals: [],
    approvalSig: '',
    approvalHoldMs: DEFAULT_HOLD_MS,
    /** 宿主有没有对话流能力:null=还不知道,false=旧版宿主。 */
    available: null,
    /** 对话流的错误(订阅失败 / 旧版宿主)。 */
    threadError: null,
    /** 当前提问意图:'selection' | 'file'。 */
    mode: 'selection',
    /** 发送时那一次取的编辑器上下文。 */
    context: null,
    /** idle | sending | thinking | error */
    status: 'idle',
    error: null,
    /** 面板绑定的会话(host 回话里的 sessionId)。 */
    sessionId: null,
    /** DSH 界面的版本(host 的 /sync 报回来;面板据此提示渲染器版本不一致)。 */
    uiVersion: null,
  };
}

/** 一条宿主条目 → 规整过的渲染条目(字段白名单,不接受宿主塞别的东西)。 */
function cleanEntry(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const role = ROLES.includes(raw.role) ? raw.role : null;
  if (role === null) return null;
  const text = typeof raw.text === 'string' ? raw.text.slice(0, MAX_TEXT) : '';
  return {
    role,
    text,
    // 思考过程(0.3.23):渲染成默认收起的「思考」行。
    thinking: typeof raw.thinking === 'string' ? raw.thinking.slice(0, MAX_TEXT) : '',
    // 注入的上下文(0.3.24):桥自己拼的位置行 + 选区代码块,渲染成默认收起的「上下文」行。
    context: typeof raw.context === 'string' ? raw.context.slice(0, MAX_TEXT) : '',
    // 消息来源(0.3.43):非 'user' = 上下文注入,渲染成折叠行。
    sourceKind: typeof raw.sourceKind === 'string' && raw.sourceKind !== '' ? raw.sourceKind : null,
    streaming: raw.streaming === true,
    name: typeof raw.name === 'string' ? raw.name : null,
    summary: typeof raw.summary === 'string' ? raw.summary : null,
    status: typeof raw.status === 'string' ? raw.status : null,
    callId: typeof raw.callId === 'string' ? raw.callId : null,
    approvalId: typeof raw.approvalId === 'string' ? raw.approvalId : null,
  };
}

/**
 * 条目签名:正文/思考只会"流式变长"或"被耐久消息原地替换"(此时 streaming 翻转),
 * 所以 角色 + 状态 + 长度 + 是否流式 足够判变化,不必每趟比对几十 KB 文本。
 */
function entriesSignature(entries) {
  const parts = [];
  for (const entry of entries) {
    parts.push([
      entry.role,
      entry.status ?? '',
      entry.streaming ? 1 : 0,
      entry.text.length,
      entry.thinking.length,
      entry.context.length,
      entry.sourceKind === null ? '' : entry.sourceKind.length,
      entry.summary === null ? '' : entry.summary.length,
    ].join(':'));
  }
  return `${entries.length}|${parts.join(',')}`;
}

/** 本地乐观提问 → 渲染条目。 */
function pendingEntries(state) {
  return state.pending.map((item) => ({
    role: 'user',
    text: item.text,
    thinking: '',
    context: '',
    streaming: false,
    name: null,
    summary: null,
    status: item.error === null || item.error === undefined ? 'sending' : 'error',
    callId: null,
    approvalId: null,
  }));
}

/** 面板要渲染的完整列表(宿主条目 + 尚未回显的本地提问)。 */
function entriesOf(state) {
  const all = [...state.entries, ...pendingEntries(state)];
  return all.length > MAX_ENTRIES ? all.slice(all.length - MAX_ENTRIES) : all;
}

/**
 * 应用宿主 `/sync` 的 `thread` 快照。
 *
 * `thread === null` = 旧版宿主(没有这个字段)—— 必须**说出原因**,否则面板会永远停在"正在回答…"。
 * `thread.available === false` = 宿主有这个能力但当前没有 watch 到会话(还没提问过)。
 *
 * @returns {boolean} 是否有变化(调用方据此决定要不要刷新 webview)
 */
function applyThread(state, thread, sessionId) {
  if (thread === null || thread === undefined || typeof thread !== 'object') {
    const changed = state.available !== false || state.threadError === null;
    state.available = false;
    state.threadError = '宿主没有对话流能力(插件版本过旧?):请重启 dsh web 让 host 侧升级到 0.3.22 以上';
    // 已经问过了却拿不到对话流:不能只留一行提示,面板必须报错(否则永远停在"正在回答…")。
    if (state.pending.length > 0 && state.status !== 'error') {
      state.status = 'error';
      state.error = state.threadError;
    }
    return changed;
  }
  let changed = false;
  const next = [];
  if (Array.isArray(thread.entries)) {
    for (const raw of thread.entries) {
      const entry = cleanEntry(raw);
      if (entry !== null) next.push(entry);
    }
  }
  const sig = entriesSignature(next);
  if (sig !== state.entriesSig) {
    state.entries = next;
    state.entriesSig = sig;
    changed = true;
  }
  const available = thread.available !== false;
  if (available !== state.available) {
    state.available = available;
    changed = true;
  }
  const error = typeof thread.error === 'string' && thread.error !== '' ? thread.error : null;
  if (error !== state.threadError) {
    state.threadError = error;
    changed = true;
  }
  const session = typeof thread.sessionId === 'string' && thread.sessionId !== ''
    ? thread.sessionId
    : (typeof sessionId === 'string' && sessionId !== '' ? sessionId : null);
  if (session !== null && session !== state.sessionId) {
    state.sessionId = session;
    changed = true;
  }
  // 宿主回显了同一段文字 → 本地乐观条目退场(不重复显示)。
  const before = state.pending.length;
  state.pending = state.pending.filter((item) => !next.some(
    (entry) => entry.role === 'user' && normalizeText(entry.text) === normalizeText(item.text),
  ));
  if (state.pending.length !== before) changed = true;

  // 忙碌判定:有待回声的提问、有流式条目、或有还在跑的工具 → thinking。
  const busy = state.pending.length > 0
    || next.some((entry) => entry.streaming === true || (entry.role === 'tool' && entry.status === 'running'));
  if (busy && state.status !== 'error') state.status = 'thinking';
  else if (!busy && (state.status === 'thinking' || state.status === 'sending')) state.status = 'idle';
  return changed;
}

/** 应用宿主 `/sync` 的 `approvals` 快照(待决授权请求)。 */
function applyApprovals(state, approvals, holdMs) {
  const list = [];
  if (Array.isArray(approvals)) {
    for (const raw of approvals) {
      if (raw === null || typeof raw !== 'object') continue;
      if (typeof raw.id !== 'string' || raw.id === '') continue;
      list.push({
        id: raw.id,
        toolName: typeof raw.toolName === 'string' && raw.toolName !== '' ? raw.toolName : 'tool',
        reason: typeof raw.reason === 'string' ? raw.reason : '',
        callId: typeof raw.callId === 'string' ? raw.callId : null,
        at: Number.isSafeInteger(raw.at) ? raw.at : Date.now(),
      });
    }
    list.sort((a, b) => a.at - b.at);
  }
  const window = Number.isSafeInteger(holdMs) && holdMs > 0 ? holdMs : DEFAULT_HOLD_MS;
  const sig = `${window}|${JSON.stringify(list)}`;
  if (sig === state.approvalSig) return false;
  state.approvals = list;
  state.approvalHoldMs = window;
  state.approvalSig = sig;
  return true;
}

/**
 * 把宿主一趟 `/sync` 的结果并进面板状态(扩展侧只调这一个)。
 *
 * `result.thread === undefined` = 旧版宿主(没有这个字段)。
 * @returns {boolean} 是否有变化(调用方据此决定要不要刷新 webview)
 */
function applySync(state, result) {
  let changed = false;
  if (applyThread(state, result === null || result === undefined ? null : result.thread, result?.sessionId ?? null)) {
    changed = true;
  }
  if (applyApprovals(state, result === null || result === undefined ? [] : result.approvals, result?.approvalHoldMs)) {
    changed = true;
  }
  const version = result === null || result === undefined ? undefined : result.uiVersion;
  if (typeof version === 'string' && version !== '' && version !== state.uiVersion) {
    state.uiVersion = version;
    changed = true;
  }
  return changed;
}

/**
 * 登记一条本地提问(乐观显示;宿主回显后自动退场)。
 * @returns {object} 刚登记的 pending 条目
 */
function pendingQuestion(state, text, context) {
  const item = { text: String(text ?? ''), at: Date.now(), error: null };
  state.pending.push(item);
  while (state.pending.length > MAX_PENDING) state.pending.shift();
  if (context !== null && context !== undefined) state.context = context;
  state.status = 'sending';
  state.error = null;
  return item;
}

/** 投递失败 / 面板错误:状态行 + 最新一条本地提问都标上原因。 */
function failPanel(state, message) {
  state.status = 'error';
  state.error = message;
  const last = state.pending[state.pending.length - 1];
  if (last !== undefined) last.error = message;
  return state;
}

/** 上下文 → 一行描述(标题栏):文件:行 + 选区行数。 */
function describeContext(context) {
  if (context === null || context === undefined) return '';
  const name = typeof context.file === 'string' && context.file !== '' ? context.file : '(当前文件)';
  const base = name.replace(/^.*[\\/]/, '');
  if (Number.isSafeInteger(context.lineStart)) {
    const range = Number.isSafeInteger(context.lineEnd) && context.lineEnd !== context.lineStart
      ? `${context.lineStart}-${context.lineEnd}`
      : `${context.lineStart}`;
    return `${base}:${range}`;
  }
  return base;
}

/** 标题栏那一行:上下文 + 提问意图。 */
function contextLine(state) {
  const where = state.context === null || state.context === undefined
    ? '来自编辑器'
    : `来自编辑器:${describeContext(state.context)}`;
  if (state.context === null || state.context === undefined) return where;
  return state.mode === 'file' ? `${where} · 针对当前文件` : `${where} · 针对选中内容`;
}

/** 状态 → 状态行文案(扩展侧组装,面板只显示)。 */
function statusText(state) {
  if (state.status === 'error') return state.error ?? '出错了';
  if (state.status === 'sending') return '正在发给 DSH…';
  if (state.status === 'thinking') return 'DSH 正在回答…';
  return state.threadError ?? '';
}

/** 状态 → 面板可渲染的 JSON(postMessage 的载荷)。 */
function panelPayload(state) {
  return {
    type: 'state',
    entries: entriesOf(state),
    approvals: state.approvals,
    approvalHoldMs: state.approvalHoldMs,
    contextText: contextLine(state),
    statusText: statusText(state),
    status: state.status,
    error: state.error,
    sessionId: state.sessionId,
    available: state.available,
    threadError: state.threadError,
    uiVersion: state.uiVersion,
  };
}

/** 面板侧:把载荷并进本地视图状态(只认白名单字段)。 */
function applyPayload(state, payload) {
  if (payload === null || typeof payload !== 'object' || payload.type !== 'state') return state;
  return {
    ...state,
    entries: Array.isArray(payload.entries) ? payload.entries : [],
    approvals: Array.isArray(payload.approvals) ? payload.approvals : [],
    approvalHoldMs: Number.isSafeInteger(payload.approvalHoldMs) && payload.approvalHoldMs > 0
      ? payload.approvalHoldMs
      : DEFAULT_HOLD_MS,
    contextText: typeof payload.contextText === 'string' ? payload.contextText : '',
    statusText: typeof payload.statusText === 'string' ? payload.statusText : '',
    status: typeof payload.status === 'string' ? payload.status : 'idle',
    error: typeof payload.error === 'string' ? payload.error : null,
    sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : null,
    available: payload.available === undefined ? null : payload.available,
    threadError: typeof payload.threadError === 'string' ? payload.threadError : null,
    uiVersion: typeof payload.uiVersion === 'string' ? payload.uiVersion : null,
  };
}

/** 面板视图的初始状态(同 applyPayload 的输出形状,首帧渲染用)。 */
function createViewState() {
  return {
    entries: [],
    approvals: [],
    approvalHoldMs: DEFAULT_HOLD_MS,
    contextText: '来自编辑器',
    statusText: '',
    status: 'idle',
    error: null,
    sessionId: null,
    available: null,
    threadError: null,
    uiVersion: null,
  };
}

/** HTML 属性转义(只用于外壳里的 URI;正文一律走 React,不做字符串拼接)。 */
function escapeAttribute(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 面板 HTML(一次性外壳):只加载打包好的 thread.js / thread.css,
 * 之后全靠 postMessage 更新 —— 输入框与滚动位置不受影响。
 *
 * @param {{cspSource: string, nonce: string, scriptUri: string, styleUri: string}} options
 */
function renderPanelHtml({ cspSource, nonce, scriptUri, styleUri }) {
  const script = escapeAttribute(scriptUri);
  const style = escapeAttribute(styleUri);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; font-src ${cspSource}; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${style}">
<title>DSH 对话</title>
</head>
<body class="dshcs-panel">
<div id="root"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}

module.exports = {
  MAX_ENTRIES,
  MAX_PENDING,
  MAX_TEXT,
  DEFAULT_HOLD_MS,
  normalizeText,
  createPanelState,
  cleanEntry,
  entriesSignature,
  entriesOf,
  applyThread,
  applyApprovals,
  applySync,
  pendingQuestion,
  failPanel,
  describeContext,
  contextLine,
  statusText,
  panelPayload,
  applyPayload,
  createViewState,
  escapeAttribute,
  renderPanelHtml,
};
