/**
 * lib/bridge-thread.mjs — 把「被面板观看的会话」投影成有界的对话条目流(0.3.22)。
 *
 * 方向:DSH → 编辑器。编辑器里的「问 DSH」面板要像 DSH 对话那样显示内容,数据来自
 * **正规的实时通道** `sessionController.follow()`(冷安全:开帧给 `cursor`,之后是
 * gap-free 的耐久事件帧 + 无游标的助手流帧)。
 *
 * 为什么不用别的(都核查过):
 *   - 同步读会话历史(`Session.snapshotEvents/eventAt/ownEvents`)已被 DSH 明令禁止新增调用
 *     (`.agents/notes/.../2026-09-09-deprecate-synchronous-session-event-reads.zh.md`);
 *   - `sessionController.page()` 是**历史分页** —— 本版本按用户要求**只渲染新内容**,不调用它;
 *   - 投影(`turnOutline` 等)只给有界预览(50/120 字符),不够渲染正文。
 *
 * `follow` 的帧形状(源码实证,`packages/api/session-controller/src/types.ts:515`):
 *   | { type:'snapshot'; cursor; records[]; assistantStream? }   ← 开帧(历史,本版本**丢弃**)
 *   | { type:'event'; event: SessionWireEvent }                  ← 耐久事件
 *   | { type:'assistant-stream'; frame: { type:'start'|'chunk'; turn; chunk } }
 *
 * 有界:每会话 ≤ `MAX_ENTRIES` 条、单条正文 ≤ `MAX_TEXT`、同时 watch ≤ `MAX_WATCHED`(LRU + abort)。
 */

/** 每个会话保留的条目上限(丢最旧的;更早的内容本版本不提供)。 */
export const MAX_ENTRIES = 120;

/** 单条正文上限(超出截断并标注)。 */
export const MAX_TEXT = 8000;

/** 同时 watch 的会话上限。 */
export const MAX_WATCHED = 4;

/** 工具参数 / 原因摘要上限。 */
export const MAX_SUMMARY = 160;

/** 截断到上限并标注。 */
function clip(text, limit = MAX_TEXT) {
  if (typeof text !== 'string') return '';
  return text.length > limit ? `${text.slice(0, limit)}…(已截断)` : text;
}

/** 从消息内容块里取正文(text 块拼接;reasoning / tool-call 不进面板)。 */
export function textOfContent(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return clip(parts.join(''));
}

/** 工具调用摘要:从原始 JSON 参数里抽一个最有信息量的字段(路径 / 命令首行)。 */
export function summarizeToolArguments(rawArguments) {
  if (typeof rawArguments !== 'string' || rawArguments.trim() === '') return '';
  let args;
  try {
    args = JSON.parse(rawArguments);
  } catch {
    return clip(rawArguments, MAX_SUMMARY);
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return '';
  for (const key of ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'prompt']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim() !== '') return clip(value.split('\n')[0], MAX_SUMMARY);
  }
  const keys = Object.keys(args);
  return keys.length === 0 ? '' : clip(keys.slice(0, 4).join(', '), MAX_SUMMARY);
}

/** 一个会话的投影状态(纯数据,便于单测)。 */
export function createThreadState(sessionId) {
  return {
    sessionId,
    entries: [],
    /** tool/call 的 callId → entries 下标(用于 result 回填)。 */
    callIndex: new Map(),
    /** 流式条目在 entries 里的下标(没有则 null)。 */
    streamingIndex: null,
    /** 流式条目属于哪一轮;换轮时新建条目。 */
    streamingTurn: null,
    error: null,
  };
}

/** 重建 callId / 流式条目索引(条目数很小,整表扫一遍最不容易错)。 */
function rebuildIndex(state) {
  state.callIndex.clear();
  state.streamingIndex = null;
  for (let i = 0; i < state.entries.length; i += 1) {
    const item = state.entries[i];
    if (item.callId !== undefined) state.callIndex.set(String(item.callId), i);
    if (item.streaming === true) state.streamingIndex = i;
  }
}

/** 追加一条条目;超上限时丢最旧。 */
function push(state, entry) {
  state.entries.push(entry);
  if (state.entries.length > MAX_ENTRIES) state.entries.shift();
  rebuildIndex(state);
  return state.entries.length - 1;
}

/** 助手流帧(SessionAssistantStreamFrame):只取正文 text-delta。 */
export function applyStreamFrame(state, frame) {
  if (frame === null || typeof frame !== 'object' || frame.type !== 'chunk') return false;
  const chunk = frame.chunk;
  if (chunk === null || typeof chunk !== 'object' || chunk.type !== 'text-delta' || typeof chunk.text !== 'string') return false;
  const turn = Number.isSafeInteger(frame.turn) ? frame.turn : null;
  if (state.streamingIndex !== null && state.streamingTurn === turn) {
    const current = state.entries[state.streamingIndex];
    current.text = clip(current.text + chunk.text);
    return true;
  }
  state.streamingIndex = push(state, { role: 'assistant', text: clip(chunk.text), streaming: true });
  state.streamingTurn = turn;
  return true;
}

/**
 * 把一个会话事件投影进状态。
 * @param {ReturnType<typeof createThreadState>} state
 * @param {{type: string, seq?: number, data?: object}} event `SessionWireEvent`
 * @returns {boolean} 是否变化
 */
export function applyEvent(state, event) {
  if (state === null || event === null || typeof event !== 'object') return false;
  const data = event.data ?? {};

  if (event.type === 'user/message') {
    const text = textOfContent(data.content);
    if (text === '') return false;
    push(state, { role: 'user', text });
    return true;
  }

  if (event.type === 'assistant/message') {
    const text = textOfContent(data.message?.content);
    const streamingIndex = state.streamingIndex;
    state.streamingIndex = null;
    state.streamingTurn = null;
    if (streamingIndex !== null && state.entries[streamingIndex] !== undefined) {
      // 耐久消息落地:原地替换同一轮的流式临时条目(不重复显示,顺序也不变)。
      if (text === '') {
        state.entries.splice(streamingIndex, 1);
        rebuildIndex(state);
        return true;
      }
      state.entries[streamingIndex] = { role: 'assistant', text };
      rebuildIndex(state);
      return true;
    }
    if (text === '') return false;
    push(state, { role: 'assistant', text });
    return true;
  }

  if (event.type === 'tool/call') {
    const callId = typeof data.callId === 'string' ? data.callId : undefined;
    const index = push(state, {
      role: 'tool',
      callId,
      name: typeof data.name === 'string' ? data.name : 'tool',
      summary: summarizeToolArguments(data.arguments),
      status: 'running',
    });
    if (callId !== undefined) state.callIndex.set(callId, index);
    return true;
  }

  if (event.type === 'tool/result') {
    const callId = data.message?.source?.callId;
    const index = callId === undefined ? undefined : state.callIndex.get(String(callId));
    if (index === undefined) return false;
    const block = Array.isArray(data.message?.content) ? data.message.content[0] : undefined;
    state.entries[index].status = block !== undefined && block.isError === true ? 'error' : 'ok';
    return true;
  }

  // 授权审计(会话事件,log-only):面板据此显示"已授权一次 / 已拒绝"。
  if (event.type === 'approval/asked') {
    push(state, {
      role: 'approval',
      approvalId: typeof data.id === 'string' ? data.id : undefined,
      toolName: typeof data.toolName === 'string' ? data.toolName : 'tool',
      summary: typeof data.reason === 'string' ? clip(data.reason, MAX_SUMMARY) : '',
      status: 'asked',
    });
    return true;
  }

  if (event.type === 'approval/decided') {
    const id = typeof data.id === 'string' ? data.id : undefined;
    for (let i = state.entries.length - 1; i >= 0; i -= 1) {
      const item = state.entries[i];
      if (item.role === 'approval' && (id === undefined || item.approvalId === id)) {
        item.status = typeof data.outcome === 'string' ? data.outcome : 'unavailable';
        return true;
      }
    }
    return false;
  }

  return false;
}

/**
 * 收一帧 `follow` 输出。
 * 开帧(`snapshot`)只取 `cursor` 与助手流基线 —— 历史记录按"只渲染新内容"丢弃。
 */
export function consumeFrame(state, frame) {
  if (state === null || frame === null || typeof frame !== 'object') return false;
  if (frame.type === 'snapshot') {
    state.cursor = Number.isSafeInteger(frame.cursor) ? frame.cursor : state.cursor ?? 0;
    return false; // 不渲染历史
  }
  if (frame.type === 'assistant-stream') return applyStreamFrame(state, frame.frame);
  if (frame.type === 'event') return applyEvent(state, frame.event);
  // 兼容:调用方直接喂会话事件(测试与降级路径)
  if (typeof frame.type === 'string' && frame.data !== undefined) return applyEvent(state, frame);
  return false;
}

/** 给 `/sync` 的快照(纯 JSON)。 */
export function threadSnapshot(state) {
  return {
    cursor: Number.isSafeInteger(state.cursor) ? state.cursor : null,
    entries: state.entries.map((entry) => ({
      role: entry.role,
      text: entry.text ?? null,
      streaming: entry.streaming === true,
      name: entry.name ?? null,
      callId: entry.callId ?? null,
      summary: entry.summary ?? null,
      status: entry.status ?? null,
      approvalId: entry.approvalId ?? null,
    })),
  };
}

/**
 * watch 注册表。
 *
 * @param {{resolveController: () => object|undefined, log?: (message: string) => void,
 *          maxWatched?: number}} deps `resolveController()` 每次现取(host 侧一律 `ctx.get`)。
 */
export function createThreadRegistry(deps) {
  const log = deps.log ?? (() => {});
  const maxWatched = deps.maxWatched ?? MAX_WATCHED;
  /** sessionId → {state, abort} */
  const watched = new Map();

  function controller() {
    try {
      return deps.resolveController();
    } catch (err) {
      log(`取 sessionController 失败:${err && err.message ? err.message : String(err)}`);
      return undefined;
    }
  }

  function unwatch(sessionId) {
    const entry = watched.get(sessionId);
    if (entry === undefined) return false;
    watched.delete(sessionId);
    try {
      entry.abort.abort();
    } catch {
      // abort 失败不影响正确性
    }
    return true;
  }

  async function run(sessionId, entry, signal) {
    try {
      const service = entry.service;
      const stream = service.follow(
        { address: { kind: 'session', sessionId }, maxMessages: 50, assistantStream: true },
        signal,
      );
      for await (const frame of stream) {
        if (signal.aborted) break;
        consumeFrame(entry.state, frame);
      }
    } catch (err) {
      if (!signal.aborted) {
        entry.state.error = `会话订阅失败:${err && err.message ? err.message : String(err)}`;
        log(`会话 ${sessionId} 订阅结束:${entry.state.error}`);
      }
    }
  }

  function watch(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return false;
    if (watched.has(sessionId)) return true;
    const service = controller();
    if (service === undefined || typeof service.follow !== 'function') return false;
    while (watched.size >= maxWatched) {
      const oldest = watched.keys().next().value;
      log(`watch 超过 ${maxWatched} 个,丢弃最旧的会话 ${String(oldest)}`);
      unwatch(oldest);
    }
    const abort = new AbortController();
    const entry = { service, state: createThreadState(sessionId), abort };
    watched.set(sessionId, entry);
    void run(sessionId, entry, abort.signal);
    return true;
  }

  return {
    watch,
    unwatch,
    /** 按扩展声明的 watch 列表对齐(多余的停止、缺的建立)。 */
    sync(sessionIds) {
      if (!Array.isArray(sessionIds)) return;
      const wanted = new Set(sessionIds.filter((id) => typeof id === 'string' && id !== ''));
      for (const id of [...watched.keys()]) if (!wanted.has(id)) unwatch(id);
      for (const id of wanted) watch(id);
    },
    /** 快照:返回面板关心的那个会话(数组首个);没 watch 到就返回空壳。 */
    snapshot(sessionIds) {
      const wanted = Array.isArray(sessionIds) ? sessionIds : [...watched.keys()];
      for (const id of wanted) {
        const entry = watched.get(id);
        if (entry !== undefined) {
          return { available: true, sessionId: id, ...threadSnapshot(entry.state), error: entry.state.error ?? null };
        }
      }
      return { available: watched.size > 0, sessionId: null, cursor: null, entries: [], error: null };
    },
    /** 有没有可用的会话服务(面板据此区分"宿主没能力"与"没在 watch")。 */
    supported() {
      const service = controller();
      return service !== undefined && typeof service.follow === 'function';
    },
    /** 该会话是否在 watch 中(授权拦截据此判断"面板是否在看")。 */
    isWatched(sessionId) {
      return watched.has(sessionId);
    },
    /** 卸载:abort 全部订阅。 */
    dispose() {
      for (const id of [...watched.keys()]) unwatch(id);
    },
  };
}
