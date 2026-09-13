// dshcs-editor-bridge / webview/src/app.jsx —— 「问 DSH」面板(0.2.3)
//
// 面板 = 外壳(上下文 / 状态 / 输入框 / 授权卡片)+ **DSH 官方渲染的对话内容**。
// 对话数据来自宿主 `/sync` 的 `thread` 字段:只有**新内容**(0.3.22 起,历史不重放),
// 助手正文逐条交给官方 markdown 渲染器(thread.jsx)。
//
// 与扩展侧的分工(消息协议,postMessage):
//   扩展 → 面板:`{type:'state', …}`(面板状态载荷,形状见 lib/ask-panel.js 的 panelPayload)
//   面板 → 扩展:`{type:'ready'}` / `{type:'ask', text}` / `{type:'approve', id, outcome}`
//
// 纯逻辑(状态合并 / 载荷解析)在 lib/ask-panel.js 里,与扩展侧同一份,可在 Node 里单测;
// 本文件只做"把状态画出来"。

import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import panel from '../../lib/ask-panel.js';
import { ThreadEntry } from './thread.jsx';
import { ApprovalCard } from './approval.jsx';
import './panel.css';

/** 打包时的官方渲染器版本(由 scripts/build-webview.mjs 注入)。 */
const RENDERER_VERSION = typeof __DSHCS_RENDERER_VERSION__ === 'string' ? __DSHCS_RENDERER_VERSION__ : '';
/** 打包时的官方 UI 包名(用于版本不一致时的提示文案)。 */
const RENDERER_PACKAGE = typeof __DSHCS_RENDERER_PACKAGE__ === 'string' ? __DSHCS_RENDERER_PACKAGE__ : '';

const vscode = acquireVsCodeApi();

/** 宿主形态(0.2.5):`'dsh'` = 跑在 DSH 页面里的浮动对话框里,否则是 VS Code webview 面板。 */
const HOST = typeof window.__DSHCS_HOST__ === 'string' ? window.__DSHCS_HOST__ : 'webview';
/** 挂载点:对话框把它的容器交进来;webview 里就是 #root。 */
const MOUNT = window.__DSHCS_MOUNT__ instanceof HTMLElement
  ? window.__DSHCS_MOUNT__
  : document.getElementById('root');

/** 面板外壳的初始视图状态。 */
const INITIAL = panel.createViewState();

function App() {
  const [view, setView] = useState(INITIAL);
  const [now, setNow] = useState(() => Date.now());
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [scriptError, setScriptError] = useState(null);
  const [decided, setDecided] = useState({});
  const logRef = useRef(null);
  const stickRef = useRef(true);
  const boxRef = useRef(null);

  // 对话框形态:壳子直接推状态(同一个 window,不走 postMessage —— DSH 页面里 postMessage 是公共广播)。
  useEffect(() => {
    if (HOST !== 'dsh') return undefined;
    window.__DSHCS_ASK_PUSH__ = (payload) => {
      if (payload === null || typeof payload !== 'object') return;
      setView((prev) => panel.applyPayload(prev, { ...payload, type: 'state' }));
    };
    return () => { delete window.__DSHCS_ASK_PUSH__; };
  }, []);

  // 扩展 → 面板的消息(webview 形态)。
  useEffect(() => {
    const onMessage = (event) => {
      const data = event.data;
      if (data === null || typeof data !== 'object') return;
      if (data.type === 'state') setView((prev) => panel.applyPayload(prev, data));
    };
    window.addEventListener('message', onMessage);
    // 面板脚本自己出错也要说出来:静默空白是最难查的一种失败。
    // **但"ResizeObserver loop completed with undelivered notifications"不是脚本错误**(0.3.41):
    // 那是 Chromium 在布局收敛时投递的良性告警(官方渲染器的视口高亮/折叠行都会触发它),
    // 浏览器自己会重试,重试后一帧内就恢复。把它当成"面板脚本出错"会误导用户去查一个不存在的问题。
    const BENIGN = /ResizeObserver loop/i;
    const onError = (event) => {
      const message = event && event.message ? String(event.message) : '未知';
      if (BENIGN.test(message)) return;
      setScriptError(`面板脚本出错:${message}`);
    };
    const onRejection = (event) => {
      const reason = event && event.reason ? String(event.reason) : '未知';
      if (BENIGN.test(reason)) return;
      setScriptError(`面板脚本出错:${reason}`);
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    vscode.postMessage({ type: 'ready' });
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  // 暗色主题:官方令牌表用 body[data-ds-dark-theme] 切换调色板。
  // **只在 webview 里做**:在 DSH 页面里那个属性属于 DSH 自己,面板不能去改它(会翻掉整个界面主题)。
  useEffect(() => {
    if (HOST === 'dsh') return undefined;
    const sync = () => {
      const dark = document.body.classList.contains('vscode-dark')
        || document.body.classList.contains('vscode-high-contrast');
      if (dark) document.body.setAttribute('data-ds-dark-theme', '');
      else document.body.removeAttribute('data-ds-dark-theme');
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  // 授权倒计时:只在有卡片时跑。
  useEffect(() => {
    if (view.approvals.length === 0) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [view.approvals.length]);

  // 已提交的决策:卡片消失后清掉(不然 decided 会一直涨)。
  useEffect(() => {
    setDecided((prev) => {
      const ids = new Set(view.approvals.map((item) => item.id));
      const next = {};
      let changed = false;
      for (const [id, value] of Object.entries(prev)) {
        if (ids.has(id)) next[id] = value;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [view.approvals]);

  // 贴底滚动:用户主动往上翻时不打扰。
  useEffect(() => {
    const node = logRef.current;
    if (node !== null && stickRef.current) node.scrollTop = node.scrollHeight;
  }, [view.entries]);

  // 宿主状态回来了就解除"发送中"的按钮锁。
  useEffect(() => {
    if (view.status !== 'sending') setSending(false);
  }, [view.status]);

  const onScroll = () => {
    const node = logRef.current;
    if (node === null) return;
    stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
  };

  const submit = () => {
    const text = draft.trim();
    if (text === '' || sending) return;
    setSending(true);
    setDraft('');
    vscode.postMessage({ type: 'ask', text });
  };

  const onKeyDown = (event) => {
    if (event.key === 'Enter' && event.shiftKey === false) {
      event.preventDefault();
      submit();
    }
  };

  const onDecide = (id, outcome) => {
    setDecided((prev) => ({ ...prev, [id]: outcome }));
    vscode.postMessage({ type: 'approve', id, outcome });
  };

  const status = scriptError === null ? view.statusText : scriptError;
  const versionNote = view.uiVersion !== null && view.uiVersion !== undefined && RENDERER_VERSION !== ''
    && view.uiVersion !== RENDERER_VERSION
    ? `面板内置的渲染器是 ${RENDERER_PACKAGE}@${RENDERER_VERSION},而当前 DSH 界面是 ${view.uiVersion}:`
      + '排版可能有差异(重建面板:pnpm run build:webview)。'
    : null;

  return (
    <div className="dshcs-app">
      <header className="dshcs-header">
        <span className="dshcs-title">DSH</span>
        <span className="dshcs-where">{view.contextText}</span>
        {RENDERER_VERSION === '' ? null : <span className="dshcs-version">渲染器 {RENDERER_VERSION}</span>}
        <button
          type="button"
          className="dshcs-close"
          title="关闭(Shift+Esc)"
          aria-label="关闭"
          onClick={() => vscode.postMessage({ type: 'close' })}
        >
          ✕
        </button>
      </header>

      {view.threadError === null ? null : <div className="dshcs-warn">{view.threadError}</div>}
      {versionNote === null ? null : <div className="dshcs-warn">{versionNote}</div>}

      <main className="dshcs-log" ref={logRef} onScroll={onScroll}>
        {view.entries.length === 0
          ? <div className="dshcs-empty">在下面提问:DSH 的回答会像 DSH 界面那样显示在这里(思考折叠、正文按官方渲染)。</div>
          : view.entries.map((entry, index) => (
            <ThreadEntry key={`${entry.role}-${index}-${entry.callId ?? entry.approvalId ?? ''}`} entry={entry} />
          ))}
      </main>

      {view.approvals.map((item) => (
        <ApprovalCard
          key={item.id}
          item={item}
          holdMs={view.approvalHoldMs}
          now={now}
          decided={decided[item.id] ?? null}
          onDecide={onDecide}
        />
      ))}

      <div className="dshcs-status" data-status={view.status}>{status}</div>

      <footer className="dshcs-footer">
        <textarea
          ref={boxRef}
          value={draft}
          placeholder="问 DSH…(Enter 发送,Shift+Enter 换行)"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          autoFocus
        />
        <button type="button" disabled={sending || draft.trim() === ''} onClick={submit}>发送</button>
      </footer>
    </div>
  );
}

if (MOUNT === null || MOUNT === undefined) {
  console.error('[dshcs] 面板挂载点不存在(#root 或 window.__DSHCS_MOUNT__)');
} else {
  createRoot(MOUNT).render(<App />);
}
