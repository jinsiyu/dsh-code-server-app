/**
 * lib/bridge-approval.mjs — 让编辑器面板也能就地处理 DSH 的授权请求(0.3.22)。
 *
 * ## 为什么需要
 * DSH 把"敏感动作需要人确认"收敛到 `@deepseek-ai/dsh-user-approval` 的 `approval` 服务:
 * `approval/request` 是一个 **agent 作用域的 waterfall 事件**,答案方可以是服务端监听器,
 * 也可以是通过 Remote 参与进来的**浏览器客户端**(官方 `ui-approval` 卡片,
 * `packages/api/remotes/src/remote-events.ts:18` 把它注册为 waterfall 远程事件)。
 * outcome 只有四种:`allowed-once | rejected | cancelled | unavailable`,**没有答案者就 fail closed**。
 * 于是"从编辑器里提问"的场景会撞上一堵墙:agent 想**写工作区外的文件**或**执行命令**时,
 * 授权卡片只出现在 DSH 界面里 —— 而用户人在编辑器,既看不到、也可能因为超时而失败关闭。
 *
 * ## 策略(先面板、后官方;绝不自动放行)
 * 只对**被面板 watch 的会话**注册监听(`agent.ctx.on('approval/request', …)`,agent 作用域天然只收本会话):
 *   1. 生成 pending 记录 → 面板随 `/sync` 的 `approvals` 字段看到卡片(工具名 / 原因 / 倒计时);
 *   2. 等面板决策,最多 `HOLD_MS`(**默认 5 分钟** —— 0.3.22 的 8 秒对人不现实:
 *      卡片出现到用户读完、点下去,8 秒早就过了,表现就是"授权框失效"):
 *      - 面板作答 → **返回该 outcome**(settle;官方卡片不出现,人在编辑器就地处理);
 *      - **面板关掉了**(`hasPanel()` 变 false,每 `WATCH_POLL_MS` 检查一次)→ 立刻 `return next()`,
 *        不干等到窗口结束;
 *      - 窗口到点仍没人答 → `return next()`,**原样交给官方链路**(DSH 界面照旧弹卡);
 *   3. 永不返回自动授权:`allowed-once` 只能来自用户点击。
 *
 * ## 安全
 * 面板的决策只能通过桥的 `POST /approve` 进来(令牌 + 带 Origin 一律 403),而且:
 *   - `id` 必须是**本进程发起、仍未决**的请求(单次使用,用后即废);
 *   - outcome 只接受 `allowed-once` 与 `rejected` 两个白名单值;
 *   - 不接受任何自由文本 / 路径 / 命令参数 —— 这条路由**只能回答既有的问题**,不能发起动作。
 */

/** 面板优先的等待窗口(毫秒)。5 分钟:面板就在用户眼前,时间不该成为失败原因。 */
export const DEFAULT_HOLD_MS = 300000;

/** 等待期间检查"面板还在不在看"的间隔(毫秒):面板一关就立刻交回官方链路,不干等。 */
export const WATCH_POLL_MS = 500;

/** 同时挂起的授权请求上限(超了直接交给官方,避免堆积)。 */
export const MAX_PENDING = 4;

/** 允许的面板决策值(白名单;其余一律拒绝)。 */
export const PANEL_OUTCOMES = ['allowed-once', 'rejected'];

/** 造一个 pending 注册表(纯逻辑,可单测)。 */
export function createApprovalBoard({ holdMs = DEFAULT_HOLD_MS, maxPending = MAX_PENDING, now = () => Date.now() } = {}) {
  /** requestId → {id, toolName, callId, reason, at, settle} */
  const pending = new Map();
  /** 修订号:待决列表每次变化 +1(对话框据此只在变化时拉全量)。 */
  let rev = 0;

  return {
    size() {
      return pending.size;
    },
    rev() {
      return rev;
    },
    /** 面板要显示的待决列表(纯 JSON)。 */
    snapshot() {
      return [...pending.values()].map((item) => ({
        id: item.id,
        toolName: item.toolName,
        callId: item.callId ?? null,
        reason: item.reason ?? '',
        at: item.at,
      }));
    },
    get(id) {
      return pending.get(id) ?? null;
    },
    /** 登记一条请求,返回它的 Promise(面板点击前一直挂着)。 */
    open({ id, toolName, callId, reason }) {
      if (typeof id !== 'string' || id === '' || pending.has(id)) return null;
      if (pending.size >= maxPending) return null;
      let settle;
      const decision = new Promise((resolve) => { settle = resolve; });
      pending.set(id, { id, toolName, callId: callId ?? null, reason: reason ?? '', at: now(), settle });
      rev += 1;
      return decision;
    },
    /** 面板作答:只接受白名单值;未知 / 已决 → false。 */
    answer(id, outcome) {
      const item = typeof id === 'string' ? pending.get(id) : undefined;
      if (item === undefined) return false;
      if (!PANEL_OUTCOMES.includes(outcome)) return false;
      pending.delete(id);
      rev += 1;
      item.settle(outcome);
      return true;
    },
    /** 窗口到点 / 面板关闭:把这条请求撤出面板(调用方随后 `next()` 交给官方)。 */
    drop(id) {
      const item = typeof id === 'string' ? pending.get(id) : undefined;
      if (item === undefined) return false;
      pending.delete(id);
      rev += 1;
      item.settle(undefined);
      return true;
    },
    /** 丢弃全部(卸载 / 面板关闭)。 */
    clear() {
      for (const id of [...pending.keys()]) this.drop(id);
    },
  };
}

/**
 * 注册授权拦截。
 *
 * @param {object} deps
 * @param {ReturnType<typeof createApprovalBoard>} deps.board
 * @param {(message: string) => void} [deps.log]
 * @param {number} [deps.holdMs]
 * @param {number} [deps.pollMs]   检查"面板还在不在看"的间隔
 * @param {() => boolean} deps.hasPanel 面板是否在看着(关掉时立刻交给官方,不做无谓等待)
 * @returns {{intercept: (agent: object, sessionId: string) => () => void}}
 */
export function createApprovalInterceptor(deps) {
  const board = deps.board;
  const log = deps.log ?? (() => {});
  const holdMs = deps.holdMs ?? DEFAULT_HOLD_MS;
  const pollMs = deps.pollMs ?? WATCH_POLL_MS;
  const hasPanel = deps.hasPanel ?? (() => true);
  /** agent → disposer(每个被 watch 的 agent 一个监听器) */
  const registered = new Map();

  /** 睡一小段(不占事件循环;unref 掉,别把进程钉住)。 */
  function sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (typeof timer.unref === 'function') timer.unref();
    });
  }

  /**
   * 等面板决策:面板作答 / 面板关掉 / 窗口到点,三者谁先到算谁。
   * @returns {Promise<string|undefined>} outcome,或 undefined = 交给官方链路
   */
  async function waitForDecision(decision) {
    const deadline = Date.now() + holdMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return undefined;
      const outcome = await Promise.race([decision, sleep(Math.min(pollMs, remaining))]);
      if (outcome !== undefined) return outcome;
      // 面板关掉了(用户关掉 webview / 换了会话)→ 立刻交回官方链路,不干等窗口结束。
      if (!hasPanel()) return undefined;
    }
  }

  async function handle(request, next) {
    try {
      // 面板没在看:完全不拦截,保持今天的行为。
      if (!hasPanel()) return await next();
      const id = typeof request?.id === 'string' ? request.id : null;
      if (id === null) return await next();
      const decision = board.open({
        id,
        toolName: typeof request.toolName === 'string' ? request.toolName : 'tool',
        callId: request.callId ?? null,
        reason: typeof request.reason === 'string' ? request.reason : '',
      });
      if (decision === null) {
        // 上限已满 / id 重复:不抢,交给官方。
        return await next();
      }
      const outcome = await waitForDecision(decision);
      if (typeof outcome === 'string' && PANEL_OUTCOMES.includes(outcome)) {
        board.drop(id); // 幂等:answer() 已删过也没关系
        log(`授权由编辑器面板决定:${request.toolName ?? 'tool'} → ${outcome}`);
        return outcome;
      }
      board.drop(id);
      log(`授权 ${request.toolName ?? 'tool'} 面板未作答(面板关闭或超过 ${holdMs}ms),交给 DSH 界面`);
      return await next();
    } catch (err) {
      // 拦截器出问题绝不能把授权变成"放行":退回官方链路(它自己会 fail closed)。
      log(`授权拦截异常,交回官方链路:${err && err.message ? err.message : String(err)}`);
      return await next();
    }
  }

  return {
    /**
     * 为某个 agent 注册拦截(agent 作用域 ⇒ 只收到该会话的请求)。
     * @returns {() => void} disposer(永不抛)
     */
    intercept(agent, sessionId) {
      if (agent === null || typeof agent !== 'object') return () => {};
      const scope = agent.ctx ?? null;
      if (scope === null || typeof scope.on !== 'function') return () => {};
      if (registered.has(agent)) return registered.get(agent);
      let dispose = () => {};
      try {
        // **必须 prepend**(0.3.36):DSH 的客户端审批卡片是一个更早注册的 waterfall 监听器
        // (packages/client/ui-approval/src/client/index.ts:90 的 ctx.remote.$on),它在用户点击前不会返回
        // ⇒ 我们的监听器排在他后面就永远轮不到(实测:日志里连 hasPanel() 都没被调用过)。
        // prepend 之后我们排在最前:能答就答,答不了 next() 原样交回官方卡片。
        // 派发点与作用域见 packages/interaction/user-approval/src/index.ts:275(scopeTarget(req.agent, req.agent))。
        const result = scope.on('approval/request', handle, { prepend: true });
        if (typeof result === 'function') dispose = result;
      } catch (err) {
        log(`注册授权拦截失败(${sessionId}):${err && err.message ? err.message : String(err)}`);
        return () => {};
      }
      const wrapped = () => {
        registered.delete(agent);
        board.clear();
        try {
          dispose();
        } catch {
          // 注销失败无关正确性
        }
      };
      registered.set(agent, wrapped);
      log(`授权拦截已启用(会话 ${sessionId},面板优先 ${holdMs}ms,之后交给 DSH 界面)`);
      return wrapped;
    },
    /** 当前注册的 agent 数(诊断 / 测试)。 */
    size() {
      return registered.size;
    },
    /** 全部撤销。 */
    dispose() {
      for (const dispose of [...registered.values()]) dispose();
      registered.clear();
    },
  };
}
