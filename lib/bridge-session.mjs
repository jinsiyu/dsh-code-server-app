/**
 * lib/bridge-session.mjs — 把编辑器里的动作投递成 DSH 的一条**用户消息**(0.3.0;0.3.19 起以用户输入呈现)。
 *
 * 方向:编辑器 → DSH。用户在编辑器里选中一段代码、说一句"这个函数为什么是错的",
 * 这句话应当出现在**当前会话**里(就像用户自己敲进去的),并且带上文件:行与选区文本。
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
 * 把 `composeEditorPrompt` 拼出来的文本**拆回**"注入的上下文"与"用户原话"(0.3.24)。
 *
 * 为什么需要:注入的上下文(位置行 + 选区代码块)在 DSH 界面里是**折叠**的,面板如果整段平铺,
 * 用户看到的就是一大坨和自己问题无关的代码。解析按位置走(不能按空行切:选区自己常含空行):
 *   ① 可选的第一行 `From the editor: <位置>`;
 *   ② 可选的紧接着的 ``` 围栏块(语言标记 + 选区正文);
 *   ③ 剩下的是用户原话。
 * 认不出来就整段当原话(例如用户在 DSH 界面里自己敲的消息)—— 面板照常渲染成普通气泡。
 *
 * @param {string} text 投递出去的完整文本
 * @returns {{context: string, question: string}} context 为空串 = 不是桥拼出来的消息
 */
export function splitEditorPrompt(text) {
  const source = typeof text === 'string' ? text : '';
  const lines = source.split('\n');
  const context = [];
  let index = 0;
  if ((lines[0] ?? '').startsWith('From the editor: ')) {
    context.push(lines[0]);
    index = 1;
    if (lines[index] === '') index += 1;
  }
  if ((lines[index] ?? '').startsWith('```')) {
    context.push(lines[index]);
    index += 1;
    // 选区正文照抄到收尾围栏(收尾围栏是**恰好**三个反引号的一行,与 composeEditorPrompt 一致)。
    while (index < lines.length && lines[index] !== '```') {
      context.push(lines[index]);
      index += 1;
    }
    if (index < lines.length) {
      context.push('```');
      index += 1;
    }
    if (lines[index] === '') index += 1;
  }
  return { context: context.join('\n'), question: lines.slice(index).join('\n') };
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
 * 忙碌时按 Enter 的投递方式 —— **跟着 DSH 自己的设置走**。
 *
 * DSH 的对话插件把这个偏好放在 `ui-conversation` 命名空间的 `busyEnter` 字段
 * (`dsh-client-ui-conversation` 契约:`BUSY_ENTER_BEHAVIORS = ['queue','steer']`,默认 `'queue'`),
 * 用户在 设置 → 对话 里改的就是它。面板里按 Enter 与主界面按 Enter 是同一个手势,所以这里读同一个值:
 *   - `'steer'` ⇒ `agent.steer(msg)`(DSH 契约:"an idle driver starts a turn; a running driver
 *     consumes it at its **next step boundary**")—— 正在跑的那一轮就能看到你的追问;
 *   - `'queue'` ⇒ `agent.followup(msg)`(契约:"becomes the sole ordinary message of **its own turn**")
 *     —— 排到下一轮,不打扰当前轮。
 *
 * **设置数据面的两条线**(与 lib/index.js 的自有配置同一套分界,判据一律是能力):
 *   - 旧线(rc 0.1.5-rc.x、0.1.6-alpha.2):`ctx.settings.get(ns)` —— "Read one registered
 *     namespace's resolved value";
 *   - 新线(alpha ≥ 0.1.7-alpha.1):`SettingsForms` **没有 `get`**(命名空间模型换成"条目自己的
 *     Config"),只有 `describe()` —— 返回每个条目 `{ns, value, …}`,`ns` 就是条目 id
 *     (`dsh-client-ui-conversation` 客户端自己也是 `ctx.configForms.get('ui-conversation')`)。
 * 读不到(命名空间没注册 / 极简组合 / 老版本 DSH / 探测失败)一律回默认 `'queue'`,绝不抛;
 * `agent.steer` 是否可用另外逐项探测。
 *
 * @param {object} ctx cordis 上下文
 * @returns {'queue'|'steer'}
 */
export function pickBusyEnter(ctx) {
  const settings = getService(ctx, 'settings');
  if (settings === undefined || settings === null) return 'queue';
  const behaviorOf = (section) => {
    const value = section !== null && typeof section === 'object' ? section.busyEnter : undefined;
    return value === 'steer' ? 'steer' : 'queue';
  };
  if (typeof settings.get === 'function') {
    try {
      return behaviorOf(settings.get('ui-conversation'));
    } catch {
      // 未注册的命名空间在多数实现里是 undefined,但契约允许实现抛 —— 一律当默认值
      return 'queue';
    }
  }
  if (typeof settings.describe === 'function') {
    try {
      const forms = settings.describe();
      if (!Array.isArray(forms)) return 'queue';
      const entry = forms.find((form) => form !== null && typeof form === 'object' && form.ns === 'ui-conversation');
      return entry === undefined ? 'queue' : behaviorOf(entry.value);
    } catch {
      return 'queue';
    }
  }
  return 'queue';
}

/**
 * 投递一条编辑器消息。
 *
 * **永不抛**:返回结构化结果,由路由决定 HTTP 码。
 * 所有失败路径都带上 `code`,便于编辑器侧给出可操作的提示。
 *
 * @param {object} ctx cordis 上下文
 * @param {object} input `composeEditorPrompt` 的输入
 * @param {{delivery?: 'queue'|'steer'}} [options] 投递方式(缺省按 DSH 设置推导,见 pickBusyEnter)
 * @returns {Promise<{ok: boolean, code?: string, error?: string, sessionId?: string, text?: string, delivery?: string}>}
 */
export async function deliverEditorPrompt(ctx, input, options = {}) {
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
    // **以"用户输入"进对话(0.3.19)**:`source:{kind:'user'}` 让 DSH 把它渲染成用户消息。
    // 0.3.0–0.3.18 用的是 `{kind:'plugin', form:'notice', summary:'来自编辑器'}` ——
    // `MessageSourceMap.plugin` 是 `plugin + ContextFormed`,DSH 会把它当成**上下文更新**,
    // 于是用户在界面里看到的不是"自己说的话"。来源信息不丢:正文第一行仍是
    // `From the editor: <file>:<行>`,扩展侧面板也标着"来自编辑器"。
    message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    });
  } catch (err) {
    return { ok: false, code: 'BAD_MESSAGE', error: `构造消息失败:${err && err.message ? err.message : String(err)}` };
  }
  // 请求方可以显式指定(queue/steer);没指定就跟着 DSH 的 `ui-conversation.busyEnter` 走。
  const requested = options.delivery === 'steer' || options.delivery === 'queue' ? options.delivery : null;
  const busy = agent.status === 'running';
  let delivery = requested ?? pickBusyEnter(ctx);
  // 空闲时两者等价(DSH 契约:steer 在空闲驱动上同样"starts a turn"),但**空闲一律走 followup** ——
  // 语义最直白,也不依赖 steer 存在。
  if (!busy) delivery = 'queue';
  // steer 是 0.3.59 才用到的 API:老宿主没有它时静默退回 queue,绝不因为"设置里写了 steer"就投不出去。
  if (delivery === 'steer' && typeof agent.steer !== 'function') delivery = 'queue';
  try {
    if (delivery === 'steer') {
      // steer = "Submit steering for the nearest step":正在跑的那一轮会在下一个 step 边界领取它,
      // 所以追问能当轮被看到(而不是等下一轮)。
      agent.steer(message);
    } else {
      // followup = 下一轮 + 唤醒:agent 空闲就立刻开一轮,在跑就排队,两种情况用户都能看到。
      agent.followup(message);
    }
  } catch (err) {
    return { ok: false, code: 'DELIVER_FAILED', error: `投递失败:${err && err.message ? err.message : String(err)}` };
  }
  const sessionId = agent.session !== undefined && agent.session !== null && typeof agent.session === 'object'
    ? (agent.session.id ?? agent.id ?? null)
    : (agent.id ?? null);
  // `agent` 是给调用方用的**内部句柄**(授权拦截要拿 `agent.ctx` 注册 agent 作用域监听),
  // 路由返回前必须剥掉:它不可 JSON 序列化,也不该泄漏进编辑器。
  // `delivery` + `busy` 一并回去:面板据此说清这条追问会怎么被处理 ——
  // 只看 delivery 会把**空闲**时的 followup 误报成"排到下一轮"(实测踩到:空闲时发一条,
  // 面板却写"当前轮结束后…",而当时根本没有当前轮,消息是立刻开的新一轮)。
  return { ok: true, sessionId, text, delivery, busy, agent };
}
