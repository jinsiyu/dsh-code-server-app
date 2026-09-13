// dshcs-editor-bridge / webview/src/thread.jsx —— 一个对话条目的渲染(0.2.3)
//
// 助手正文**不再自己排版**:直接调用 DSH 官方渲染器
// (`@deepseek-ai/dsh-client-ui-primitives` 的 `MarkdownText` —— 与 DSH 界面同一份代码,
// 同一套 mdast 管线、KaTeX、shiki 高亮、增量流式解析),面板只负责"外壳"。
//
// 用户消息:DSH 界面里用户消息是纯文本气泡,这里保持一致(不渲染 markdown)。
// 工具 / 授权:面板只给一行紧凑摘要(第 3 阶段的计划:不做逐工具的自定义卡片)。

import { memo } from 'react';
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives';

/** 官方渲染器的界面文案(面板自己给中文;DSH 界面走它自己的 locale)。 */
const LABELS = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' };

/** 工具状态 → 中文。 */
const TOOL_STATE = { running: '运行中', ok: '完成', error: '失败' };

/** 授权审计行状态 → 中文。 */
const APPROVAL_STATE = {
  asked: '等待授权',
  'allowed-once': '已允许一次',
  rejected: '已拒绝',
  cancelled: '已取消',
  unavailable: '无人处理',
};

export const ThreadEntry = memo(function ThreadEntry({ entry }) {
  if (entry.role === 'user') {
    return (
      <div className="dshcs-msg dshcs-user">
        <div className="dshcs-bubble" data-status={entry.status ?? undefined}>{entry.text}</div>
      </div>
    );
  }

  if (entry.role === 'assistant') {
    return (
      <div className="dshcs-msg dshcs-assistant">
        <MarkdownText
          text={entry.text}
          streaming={entry.streaming === true}
          labels={LABELS}
        />
      </div>
    );
  }

  if (entry.role === 'tool') {
    return (
      <div className="dshcs-tool" data-state={entry.status ?? 'running'}>
        <span className="dshcs-tool-name">{entry.name ?? 'tool'}</span>
        <span className="dshcs-tool-summary">{entry.summary ?? ''}</span>
        <span className="dshcs-tool-state" data-state={entry.status ?? 'running'}>
          {TOOL_STATE[entry.status] ?? entry.status ?? ''}
        </span>
      </div>
    );
  }

  if (entry.role === 'approval') {
    return (
      <div className="dshcs-tool dshcs-approval-row" data-state={entry.status ?? 'asked'}>
        <span className="dshcs-tool-name">{entry.toolName ?? entry.name ?? 'tool'}</span>
        <span className="dshcs-tool-summary">{entry.summary ?? ''}</span>
        <span className="dshcs-tool-state">{APPROVAL_STATE[entry.status] ?? entry.status ?? ''}</span>
      </div>
    );
  }

  return null;
});
