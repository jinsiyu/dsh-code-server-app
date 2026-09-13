// dshcs-editor-bridge / webview/src/thread.jsx —— 一个对话条目的渲染(0.2.3 起;0.2.4 加思考行)
//
// 助手正文**不再自己排版**:直接调用 DSH 官方渲染器
// (`@deepseek-ai/dsh-client-ui-primitives` 的 `MarkdownText` —— 与 DSH 界面同一份代码,
// 同一套 mdast 管线、KaTeX、shiki 高亮、增量流式解析),面板只负责"外壳"。
//
// 思考过程(0.2.4):DSH 界面把它渲染成一行可折叠的「思考」(官方 `ReasoningRow` 用的就是
// `DisclosureRow` + `IconThinkOutline14`,**默认收起**,收起时显示首行 / 流式时的最新一行)。
// 面板用同一套官方部件重现它,差别只在文案与类名。
//
// 用户消息:DSH 界面里用户消息是纯文本气泡,这里保持一致(不渲染 markdown)。
// 工具 / 授权:面板只给一行紧凑摘要(不做逐工具的自定义卡片)。

import { memo, useState } from 'react';
import {
  DisclosureRow,
  IconContextInjectionOutline16,
  IconThinkOutline14,
  MarkdownText,
} from '@deepseek-ai/dsh-client-ui-primitives';

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

/** 折叠摘要取首行(还在流式时取最新一行)—— 与官方 ReasoningRow 同一规则。 */
function summaryLine(text, running) {
  const source = running ? text.trimEnd() : text;
  if (source === '') return '';
  const index = running ? source.lastIndexOf('\n') : source.indexOf('\n');
  const line = index === -1 ? source : (running ? source.slice(index + 1) : source.slice(0, index));
  return line.replaceAll('**', '');
}

/**
 * 一行「思考」(默认收起,点行即展开)—— 外形与交互照抄官方 `ReasoningRow`。
 * @param {{text: string, running: boolean}} props running = 这一轮的正文还没开始落
 */
function ThinkingRow({ text, running }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="dshcs-think" data-state={running ? 'running' : 'ok'} data-expanded={expanded || undefined}>
      <DisclosureRow
        icon={<IconThinkOutline14 size={14} />}
        title={running ? '思考中' : '思考'}
        open={expanded}
        expandable
        expandOnRowClick
        onToggle={() => setExpanded((value) => !value)}
        collapsedContent={(
          <>
            <span className="dshcs-think-separator" aria-hidden />
            <span className="dshcs-think-summary">{summaryLine(text, running)}</span>
          </>
        )}
      >
        <div className="dshcs-think-body">{text}</div>
      </DisclosureRow>
    </div>
  );
}

/**
 * 一行「注入的上下文」(默认收起):桥拼进消息的位置行 + 选区代码块。
 *
 * 与 DSH 界面对注入上下文的处理一致 —— 默认折叠,只留一行摘要;点开才看得到那段代码。
 * 摘要取位置行(第一行),去掉 `From the editor: ` 前缀(标题已经说了"来自编辑器")。
 */
function ContextRow({ text, title = '上下文' }) {
  const [expanded, setExpanded] = useState(false);
  const firstLine = text.split('\n')[0] ?? '';
  const summary = firstLine.replace(/^From the editor:\s*/i, '');
  return (
    <div className="dshcs-context" data-expanded={expanded || undefined}>
      <DisclosureRow
        icon={<IconContextInjectionOutline16 size={16} />}
        title={title}
        open={expanded}
        expandable
        expandOnRowClick
        onToggle={() => setExpanded((value) => !value)}
        collapsedContent={<span className="dshcs-context-summary">{summary}</span>}
      >
        <pre className="dshcs-context-body">{text}</pre>
      </DisclosureRow>
    </div>
  );
}

export const ThreadEntry = memo(function ThreadEntry({ entry }) {
  if (entry.role === 'user') {
    // **别的工具注入的上下文不是"用户说的"**(0.3.43):DSH 界面按「上下文注入」折叠显示,面板照做 ——
    // 否则这些注入会变成一屏用户气泡,把真正的对话挤掉。
    if (typeof entry.sourceKind === 'string' && entry.sourceKind !== '') {
      return (
        <div className="dshcs-msg dshcs-injection">
          <ContextRow text={entry.text} title="上下文注入" />
        </div>
      );
    }
    const context = typeof entry.context === 'string' ? entry.context : '';
    return (
      <div className="dshcs-msg dshcs-user">
        <div className="dshcs-user-stack">
          {context === '' ? null : <ContextRow text={context} />}
          <div className="dshcs-bubble" data-status={entry.status ?? undefined}>{entry.text}</div>
        </div>
      </div>
    );
  }

  if (entry.role === 'assistant') {
    const thinking = typeof entry.thinking === 'string' ? entry.thinking : '';
    // 正文还没到(整轮都是思考)→ 思考行标"思考中";正文到了就标"思考"(官方同一判据)。
    const running = entry.streaming === true && entry.text === '';
    return (
      <div className="dshcs-msg dshcs-assistant">
        {thinking === '' ? null : <ThinkingRow text={thinking} running={running} />}
        {entry.text === ''
          ? null
          : <MarkdownText text={entry.text} streaming={entry.streaming === true} labels={LABELS} />}
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
