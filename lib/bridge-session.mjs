/**
 * lib/bridge-session.mjs — 把编辑器里的动作投递成 DSH 的一条用户消息(0.3.0)。
 *
 * 方向:编辑器 → DSH。用户在编辑器里选中一段代码、说一句"这个函数为什么是错的",
 * 这句话应当出现在**当前会话**里,并且带上文件:行与选区文本。
 *
 * 投递目标的选取顺序(都通过 `ctx.get(...)` 特性探测,DSH 版本差异不会炸主流程):
 *   1. `ctx.agents.currentInitiator()` —— 正在跑的那次驱动链的 agent(最贴近"当前会话");
 *   2. `ctx.agents.list()` —— 有 running 的取 running,否则取列表里最后一个(通常是最新的);
 *   3. 都没有 → `{ok:false, code:'NO_AGENT'}`(编辑器侧据此提示"先在 DSH 里打开一个会话")。
 *
 * 投递方式是 `agent.followup(message)`(= `send(msg, 'next-turn', true)`):
 * agent 空闲则立刻开一轮,正在跑则排在下一轮 —— 两种情况下用户都能看到自己的话进了对话。
 */

import { loadDshExport } from './dsh-resolve.mjs';

/** 消息来源标记:在会话日志里能一眼看出这条来自编辑器桥。 */
export const SOURCE_PLUGIN = 'dsh-code-server-app:editor-bridge';

/**
 * 取一个 DSH 服务。
 *
 * **只能走 `ctx.get()`,不能走属性访问**:`ctx.agents` 这类属性访问在服务"存在但对该 fiber
 * 不可达"时会抛 `cannot get property "agents" without inject`;这条路径跑在路由回调里,
 * 抛了就变成 500,连"没有可用会话"的 409 提示都给不出来。
 * (0.3.6 的线上事故同源:`bridge-tools.mjs` 里 `ctx.systemPrompt` 的属性访问让整棵插件树
 *  加载失败、dsh web 起不来。)
 */
function getService(ctx, name) {
  if (ctx === undefined || ctx === null || typeof ctx.get !== 'function') return undefined;
  try {
    return ctx.get(name);
  } catch {
    return undefined;
  }
}

/** 拼进消息的选区文本上限(超长时截断并注明)。 */
export const MAX_SELECTION_CHARS = 8000;

/** 供模型识别的文件引用文本(1 基行号,与 VS Code 一致)。 */
function locationText(file, lineStart, lineEnd) {
  if (typeof file !== 'string' || file === '') return null;
  if (!Number.isSafeInteger(lineStart)) return file;
  if (!Number.isSafeInteger(lineEnd) || lineEnd === lineStart) return `${file}:${lineStart}`;
  return `${file}:${lineStart}-${lineEnd}`;
}

/**
 * 组消息文本。
 *
 * 结构刻意保持"人类可读 + 机器可抠":第一行是位置,代码块带语言标记,
 * 最后是用户的原话 —— 这样即使模型没调任何工具,它也知道该看哪个文件。
 *
 * @param {{text: string, file: string|null, lineStart: number|null, lineEnd: number|null,
 *          languageId: string|null, selection: string|null}} input
 */
export function composeEditorPrompt(input) {
  const parts = [];
  const location = locationText(input.file, input.lineStart, input.lineEnd);
  if (location !== null) parts.push(`From the editor: ${location}`);
  if (typeof input.selection === 'string' && input.selection !== '') {
    const lang = typeof input.languageId === 'string' && input.languageId !== '' ? input.languageId : '';
    const body = input.selection.length > MAX_SELECTION_CHARS
      ? `${input.selection.slice(0, MAX_SELECTION_CHARS)}\n…(selection truncated)`
      : input.selection;
    parts.push(['```' + lang, body, '```'].join('\n'));
  }
  parts.push(input.text);
  return parts.join('\n\n');
}

/**
 * 选一个投递目标 agent。
 * @param {object} ctx cordis 上下文
 */
export function pickAgent(ctx) {
  const agents = getService(ctx, 'agents');
  if (agents === undefined || agents === null) return null;
  try {
    if (typeof agents.currentInitiator === 'function') {
      const current = agents.currentInitiator();
      if (current !== undefined && current !== null) return current;
    }
  } catch {
    // 不在 initiator 边界内(正常:路由回调不在驱动链上)
  }
  try {
    if (typeof agents.list === 'function') {
      const list = agents.list();
      if (Array.isArray(list) && list.length > 0) {
        const running = list.filter((agent) => agent !== null && agent !== undefined && agent.status === 'running');
        return running.length > 0 ? running[running.length - 1] : list[list.length - 1];
      }
    }
  } catch {
    // 探测失败 = 当作没有可用 agent
  }
  return null;
}

/**
 * 投递一条编辑器消息。
 *
 * **永不抛**:返回结构化结果,由路由决定 HTTP 码。
 * 所有失败路径都带上 `code`,便于编辑器侧给出可操作的提示。
 *
 * @param {object} ctx cordis 上下文
 * @param {object} input `composeEditorPrompt` 的输入
 * @returns {Promise<{ok: boolean, code?: string, error?: string, sessionId?: string, text?: string}>}
 */
export async function deliverEditorPrompt(ctx, input) {
  const createUserMessage = await loadDshExport('@deepseek-ai/dsh-llm', 'createUserMessage');
  if (typeof createUserMessage !== 'function') {
    return { ok: false, code: 'NO_LLM', error: '解析不到 @deepseek-ai/dsh-llm 的 createUserMessage(DSH 部署不完整?)' };
  }
  const agent = pickAgent(ctx);
  if (agent === null || agent === undefined) {
    return { ok: false, code: 'NO_AGENT', error: '没有可投递的会话:请先在 DSH 里打开或新建一个会话' };
  }
  const text = composeEditorPrompt(input);
  let message;
  try {
    message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: SOURCE_PLUGIN, form: 'notice', summary: '来自编辑器' },
    });
  } catch (err) {
    return { ok: false, code: 'BAD_MESSAGE', error: `构造消息失败:${err && err.message ? err.message : String(err)}` };
  }
  try {
    // followup = 下一轮 + 唤醒:agent 空闲就立刻开一轮,在跑就排队,两种情况用户都能看到。
    agent.followup(message);
  } catch (err) {
    return { ok: false, code: 'DELIVER_FAILED', error: `投递失败:${err && err.message ? err.message : String(err)}` };
  }
  const sessionId = agent.session !== undefined && agent.session !== null && typeof agent.session === 'object'
    ? (agent.session.id ?? agent.id ?? null)
    : (agent.id ?? null);
  return { ok: true, sessionId, text };
}
