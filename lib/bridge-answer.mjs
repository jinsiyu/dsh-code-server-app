/**
 * lib/bridge-answer.mjs — 把 agent 的回复同步回编辑器(0.3.19)。
 *
 * 方向:DSH → 编辑器。用户在编辑器里问了一句之后,当然想**在原地**看到回答,而不是切回 DSH 界面。
 * 桥本来就是"扩展每 600ms 拉一次 `/sync`",所以回复走同一趟,新增一个字段而不是挤进事件环形缓冲:
 *
 *   `/sync` 响应 = `{ ok, events, answers }`
 *   `answers` = `[{ sessionId, text, done, at }]` —— **每个会话只保留最新一条**,
 *   且每次都是"到目前为止的完整正文"(不是增量)。这样:
 *     · 事件环形缓冲(64 条)不被正文挤爆 —— `agent-edit` 那些提示不会因此丢掉;
 *     · 丢中间态无所谓 —— 面板永远渲染最新那条完整正文,不需要做增量合并;
 *
 * 数据来源(都是 agent 作用域的事件,根上下文监听器能看到所有 agent):
 *   - `agent/assistant-stream` 的 `text-delta` 帧 → 累积正文(**不含 reasoning**);
 *   - `agent/status` → `idle`(这一轮跑完了)→ 标记 `done:true`。
 *
 * 只同步"**被编辑器问过**的会话"(ask 时登记 sessionId):别的会话在 DSH 界面里聊得再多,
 * 也不该往桥里塞数据。会话数有上限,超了丢最旧的。
 */

/** 每个会话保留的最新回复;超过这么多会话就丢最旧的(编辑器里问过的会话不会有几个)。 */
export const MAX_TRACKED_SESSIONS = 8;

/** 回复正文上限:面板只用来显示,超长截断(避免一次 sync 把响应撑大)。 */
export const MAX_ANSWER_CHARS = 20000;

/** 累积器的实现:`registerBridgeAnswers` 用它,测试也直接用它。 */
export function createAnswerBoard({ maxSessions = MAX_TRACKED_SESSIONS } = {}) {
  /** sessionId → { text, done, at }(插入顺序即新旧顺序) */
  const entries = new Map();

  return {
    /** ask 成功时登记:之后这个会话的回复才会同步给编辑器。 */
    track(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return false;
      entries.delete(sessionId);
      entries.set(sessionId, { text: '', done: false, at: Date.now() });
      while (entries.size > maxSessions) entries.delete(entries.keys().next().value);
      return true;
    },
    /** 追加一段正文(只在已登记的会话上生效)。 */
    append(sessionId, text) {
      if (typeof text !== 'string' || text === '' || !entries.has(sessionId)) return false;
      const current = entries.get(sessionId);
      const next = current.text + text;
      entries.set(sessionId, {
        text: next.length > MAX_ANSWER_CHARS ? next.slice(-MAX_ANSWER_CHARS) : next,
        done: false,
        at: Date.now(),
      });
      return true;
    },
    /** 一轮跑完(或出错):定稿。 */
    finish(sessionId) {
      const current = entries.get(sessionId);
      if (current === undefined) return false;
      entries.set(sessionId, { ...current, done: true, at: Date.now() });
      return true;
    },
    /** 新的一轮开始:清掉上一次的正文,避免新旧回答拼在一起。 */
    restart(sessionId) {
      if (!entries.has(sessionId)) return false;
      entries.set(sessionId, { text: '', done: false, at: Date.now() });
      return true;
    },
    /** 给 `/sync` 的快照(数组顺序 = 登记顺序)。 */
    snapshot() {
      return [...entries.entries()].map(([sessionId, value]) => ({ sessionId, ...value }));
    },
    /** 某会话当前状态(诊断/测试用)。 */
    get(sessionId) {
      return entries.get(sessionId) ?? null;
    },
    size() {
      return entries.size;
    },
  };
}

/** 从 agent 对象取会话 id(与 lib/bridge-session.mjs 同一套取值规则)。 */
export function sessionIdOf(agent) {
  if (agent === null || agent === undefined) return null;
  if (agent.session !== undefined && agent.session !== null && typeof agent.session === 'object') {
    return agent.session.id ?? agent.id ?? null;
  }
  return agent.id ?? null;
}

/**
 * 订阅 agent 事件,把回复喂进 board。
 *
 * @param {object} ctx cordis 上下文(需要 `on`)
 * @param {{board: ReturnType<typeof createAnswerBoard>, log?: (message: string) => void}} deps
 * @returns {() => void} 注销函数(永不抛)
 */
export function registerBridgeAnswers(ctx, deps) {
  const { board } = deps;
  const log = deps.log ?? (() => {});
  if (ctx === undefined || ctx === null || typeof ctx.on !== 'function') return () => {};
  const disposers = [];
  /** sessionId → 上次看到的 turn(换轮时重新累积正文)。 */
  const lastTurn = new Map();
  const on = (event, handler) => {
    try {
      const dispose = ctx.on(event, handler);
      if (typeof dispose === 'function') disposers.push(dispose);
    } catch (err) {
      log(`订阅 ${event} 失败:${err && err.message ? err.message : String(err)}`);
    }
  };

  on('agent/assistant-stream', (payload) => {
    try {
      const agent = payload?.agent;
      const frame = payload?.frame;
      if (frame?.type !== 'chunk') return;
      const chunk = frame.chunk;
      // 只同步**正文**:reasoning 是模型的内心戏,不该出现在编辑器的提问框里。
      if (chunk?.type !== 'text-delta' || typeof chunk.text !== 'string' || chunk.text === '') return;
      const sessionId = sessionIdOf(agent);
      if (sessionId === null) return;
      // 换了一轮(turn 变了)就重新累积:新问题给的是新回答,不该和上一轮拼在一起。
      const turn = Number.isSafeInteger(frame.turn) ? frame.turn : null;
      if (turn !== null && lastTurn.get(sessionId) !== turn) {
        lastTurn.set(sessionId, turn);
        board.restart(sessionId);
      }
      board.append(sessionId, chunk.text);
    } catch (err) {
      // 同步失败绝不影响 agent 的一轮(这与 lib/bridge-observe.mjs 同一策略)。
      log(`同步回复失败:${err && err.message ? err.message : String(err)}`);
    }
  });

  on('agent/status', (payload) => {
    try {
      if (payload?.status !== 'idle') return;
      const sessionId = sessionIdOf(payload?.agent);
      if (sessionId === null) return;
      board.finish(sessionId);
    } catch (err) {
      log(`收尾回复失败:${err && err.message ? err.message : String(err)}`);
    }
  });

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // 注销失败无关正确性
      }
    }
  };
}
