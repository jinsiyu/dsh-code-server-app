// dshcs-editor-bridge / lib/ask-panel.js —— 「问 DSH」面板(0.2.0)
//
// 纯逻辑 + HTML 生成,**不 require('vscode')**,所以能在普通 Node 里单测
// (scripts/test-bridge-extension.mjs)。与 VS Code 交互的部分在 extension.js。
//
// 为什么要有这个面板:0.3.0–0.3.18 的提问是「输入框 → 发送 → 一条状态栏提示」,
// 用户在编辑器里问完必须切回 DSH 界面才看得到回答。面板把三件事放在一处:
//   ① 带着上下文提问(文件:行 + 选中内容,发送时再取一次当前选区);
//   ② 提问以**用户输入**的形态进 DSH 会话(host 侧 bridge-session.mjs 的 source.kind='user');
//   ③ 回答**同步显示在这里** —— host 把 agent 的正文随 /sync 的 answers 字段推回来
//      (见 lib/bridge-answer.mjs),面板每趟轮询刷新一次,不需要第二个定时器。

'use strict';

/** 面板里最多保留多少轮问答(超过丢最旧的:这是对话窗口,不是存档)。 */
const MAX_TURNS = 20;

/** 单条消息渲染上限(回答太长时截断,避免 webview 卡)。 */
const MAX_MESSAGE_CHARS = 20000;

/** HTML 转义:面板里所有用户/模型文本都必须走它(webview 里就是 XSS 面)。 */
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 面板状态模型(纯数据,便于单测)。
 * @returns {{turns: Array<{question: string, answer: string, done: boolean, error: string|null}>,
 *            context: object|null, status: string, sessionId: string|null}}
 */
function createPanelState() {
  return { turns: [], context: null, status: 'idle', sessionId: null };
}

/** 追加一次提问(开始新一轮)。 */
function pushQuestion(state, question, context) {
  state.turns.push({ question, answer: '', done: false, error: null });
  while (state.turns.length > MAX_TURNS) state.turns.shift();
  state.context = context ?? state.context;
  state.status = 'sending';
  state.sessionId = null;
  return state.turns[state.turns.length - 1];
}

/** 最后一次提问对应的轮次(没有就返回 null)。 */
function currentTurn(state) {
  return state.turns.length === 0 ? null : state.turns[state.turns.length - 1];
}

/**
 * 把 host 推回来的 answers 应用到状态上。
 * `answers` 是 `[{sessionId, text, done, at}]`(见 lib/bridge-answer.mjs);只认**本面板登记的会话**。
 * @returns {boolean} 是否有变化(调用方据此决定要不要刷新 webview)
 */
function applyAnswers(state, answers, sessionId) {
  const target = sessionId ?? state.sessionId;
  if (target === null || target === undefined || !Array.isArray(answers)) return false;
  const entry = answers.find((item) => item !== null && typeof item === 'object' && item.sessionId === target);
  if (entry === undefined) return false;
  const turn = currentTurn(state);
  if (turn === null) return false;
  const text = typeof entry.text === 'string' ? entry.text.slice(0, MAX_MESSAGE_CHARS) : '';
  const done = entry.done === true;
  const changed = turn.answer !== text || turn.done !== done || state.status !== (done ? 'idle' : 'thinking');
  turn.answer = text;
  turn.done = done;
  state.status = done ? 'idle' : 'thinking';
  return changed;
}

/** 状态 → 面板可渲染的 JSON(postMessage 的载荷)。 */
function panelPayload(state) {
  return {
    type: 'state',
    status: state.status,
    context: state.context,
    turns: state.turns.map((turn) => ({
      question: turn.question,
      answer: turn.answer,
      done: turn.done === true,
      error: turn.error ?? null,
    })),
  };
}

/** 上下文描述(标题栏那一行):文件:行 + 选区行数。 */
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

/**
 * 面板 HTML(一次性的外壳;之后靠 postMessage 增量更新,避免把用户正在输入的内容冲掉)。
 * @param {{cspSource: string, nonce: string}} options
 */
function renderPanelHtml({ cspSource, nonce }) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>DSH 提问</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px);
         color: var(--vscode-foreground); background: var(--vscode-editor-background); display: flex; flex-direction: column; height: 100vh; }
  header { padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border, #8884); font-size: 12px; opacity: .85; }
  #log { flex: 1; overflow-y: auto; padding: 12px; }
  .turn { margin-bottom: 16px; }
  .q { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, #8884);
       border-radius: 6px; padding: 6px 8px; white-space: pre-wrap; word-break: break-word; }
  .a { margin-top: 8px; padding: 2px 2px 0 8px; border-left: 2px solid var(--vscode-focusBorder, #8886);
       white-space: pre-wrap; word-break: break-word; }
  .a.empty { opacity: .5; font-style: italic; }
  .err { color: var(--vscode-errorForeground, #f66); margin-top: 6px; white-space: pre-wrap; }
  footer { border-top: 1px solid var(--vscode-panel-border, #8884); padding: 8px; display: flex; gap: 8px; align-items: flex-end; }
  textarea { flex: 1; resize: vertical; min-height: 54px; max-height: 40vh; padding: 6px 8px; box-sizing: border-box;
             color: var(--vscode-input-foreground); background: var(--vscode-input-background);
             border: 1px solid var(--vscode-input-border, #8884); border-radius: 4px; font-family: inherit; font-size: inherit; }
  button { padding: 6px 14px; border: none; border-radius: 4px; cursor: pointer;
           color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button:disabled { opacity: .5; cursor: default; }
  #status { padding: 0 12px 8px; font-size: 12px; opacity: .8; min-height: 16px; }
</style>
</head>
<body>
<header id="ctx">来自编辑器</header>
<div id="log"></div>
<div id="status"></div>
<footer>
  <textarea id="box" placeholder="问 DSH…(Enter 发送,Shift+Enter 换行)"></textarea>
  <button id="send">发送</button>
</footer>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const log = document.getElementById('log');
  const ctx = document.getElementById('ctx');
  const status = document.getElementById('status');
  const box = document.getElementById('box');
  const send = document.getElementById('send');

  function render(state) {
    ctx.textContent = state.contextText || '来自编辑器';
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.textContent = '';
    for (const turn of state.turns) {
      const wrap = document.createElement('div');
      wrap.className = 'turn';
      const q = document.createElement('div');
      q.className = 'q';
      q.textContent = turn.question;
      wrap.appendChild(q);
      const a = document.createElement('div');
      a.className = 'a' + (turn.answer ? '' : ' empty');
      a.textContent = turn.answer || (turn.error ? '' : (turn.done ? '(没有文字回答)' : '思考中…'));
      wrap.appendChild(a);
      if (turn.error) {
        const err = document.createElement('div');
        err.className = 'err';
        err.textContent = turn.error;
        wrap.appendChild(err);
      }
      log.appendChild(wrap);
    }
    status.textContent = state.statusText || '';
    send.disabled = state.status === 'sending';
    if (atBottom) log.scrollTop = log.scrollHeight;
  }

  function submit() {
    const text = box.value.trim();
    if (text === '') return;
    vscode.postMessage({ type: 'ask', text });
    box.value = '';
  }
  send.addEventListener('click', submit);
  box.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); }
  });
  window.addEventListener('message', (event) => { if (event.data && event.data.type === 'state') render(event.data); });
  // 出错就写在状态行上:面板静默空白是最难查的一种失败。
  window.addEventListener('error', (event) => {
    status.textContent = '面板脚本出错:' + (event && event.message ? event.message : '未知');
  });
  window.addEventListener('unhandledrejection', (event) => {
    status.textContent = '面板脚本出错:' + (event && event.reason ? String(event.reason) : '未知');
  });
  vscode.postMessage({ type: 'ready' });
  box.focus();
</script>
</body>
</html>`;
}

/** 状态 → 状态行文案(扩展侧组装,面板只显示)。 */
function statusText(state) {
  switch (state.status) {
    case 'sending': return '发送中…';
    case 'thinking': return 'DSH 正在回答…';
    case 'error': return '出错了';
    default: return '';
  }
}

module.exports = {
  MAX_TURNS,
  MAX_MESSAGE_CHARS,
  escapeHtml,
  createPanelState,
  pushQuestion,
  currentTurn,
  applyAnswers,
  panelPayload,
  describeContext,
  renderPanelHtml,
  statusText,
};
