/**
 * lib/bridge-observe.mjs — 观察 agent 的写操作,并把结果送进编辑器(0.3.0)。
 *
 * 三个观察点,各司其职:
 *
 * **① agent → 编辑器**(`tools/result`):把所有写类工具的落点推成"去看一眼这个文件"的事件。
 *   - 不限定 agent:`ctx.on('tools/result')` 注册在根上下文,而 `dsh-scope` 的载体过滤是
 *     `tag === undefined → true`,所以**一个监听器能看到所有 agent 与子 agent 的调用**;
 *   - 有两条抽取路径,都必要:
 *       ① `result.meta.diffs`(`dsh-tool-fs` 的 write/edit 会带上 `FsDiffMeta`);
 *       ② 从 `exec.arguments.file_path` / `.path` 直接取(`str_replace_editor` **不带** meta,
 *          在别的 profile 里它才是主力工具);
 *   - 路径一律按**会话 cwd** 绝对化(见下):相对路径喂给编辑器只会被当成"工作区外"丢掉,
 *     或者在 IDE 自己的 cwd 上匹配到另一个文件。
 *   - `tools/result` 是 emit 型观察点:抛错不会影响调用结果(`notifyResult` 内部吞掉 listener
 *     异常),所以这里出问题最坏就是"少一次 diff 提示",绝不会弄坏 agent 的一轮。
 *
 * **② 写前原文**(`tools/post-execute`,0.3.55):`write`/`edit` 的 `result.value` 里有**完整**的
 *   写前/写后全文,而 `tools/result` 的 durable 投影**故意**剥掉了 `value` —— 这就是"diff 左侧空、
 *   右侧全文"的根因(文件没在编辑器里打开时,扩展侧没有任何 old 侧来源)。这里把写前原文存进
 *   有界快照缓存(见 lib/edit-snapshot.mjs),事件里只带一个不透明 key,文本由扩展按需走 `/old` 取。
 *   - **绝不抛**:`tools/post-execute` 的监听器抛错会把成功的调用变成 `isError`(DSH 源码注释:
 *     `a throwing listener → isError`),所以整段包在 try/catch 里,宁可少一次提示。
 *   - 只在决策是 `accept` 且 `result.isError !== true` 时记录:被拦下的调用不该弹 diff。
 *
 * **③ 编辑器 → agent**(`tools/pre-execute`):写之前如果该文件在编辑器里是脏的,附一条提示。
 *   - 用 `exec.deferContext(...)` 而不是改写入参:`PreToolDecision` **明确排除了入参改写**
 *     (参数已经进日志与展示了),所以"提醒"是唯一正确的介入方式;
 *   - **不阻断**:误报的代价是模型看到一句提示,而阻断一个正确的编辑会让 agent 卡住;
 *   - 桥不可用/状态过期 → 直接放行,零开销。
 */

import { WRITE_TOOLS, absolutePath, extractEditSnapshot, sessionCwdOf } from './edit-snapshot.mjs';
import { loadDshExport } from './dsh-resolve.mjs';

/** 待配对快照的存活时长(秒级:post-execute 与 tools/result 是同一次调用的前后两步)。 */
const PENDING_TTL_MS = 30_000;
/** 待配对快照条数上限(每个文件一条;同一次调用多个 hunk 也只算一条)。 */
const PENDING_MAX = 16;

/** 提示词的来源标记(会话日志里能看出这条来自编辑器桥)。 */
const SOURCE_PLUGIN = 'dsh-code-server-app:editor-bridge';

/** 同一个文件在多少毫秒内不重复推事件(agent 连续改同一文件时避免刷屏)。 */
const DEBOUNCE_MS = 1500;

/**
 * 从一次工具结果里抽出"被改动的文件路径"。
 *
 * @param {string} name 工具名
 * @param {unknown} args 调用参数(可能含 file_path / path)
 * @param {{meta?: unknown}} result 结果(maybe 带 FsDiffMeta)
 * @param {string|null} [cwd] 会话 cwd(给了就把相对路径展开;不给则原样返回,旧行为)
 * @returns {string[]} 绝对路径列表(去重)
 */
export function extractEditedPaths(name, args, result, cwd = null) {
  const paths = new Set();
  // ① 结果元数据里的 diff(最准:`dsh-tool-fs` 的 write/edit 每个 hunk 一条)
  const meta = result !== null && typeof result === 'object' ? result.meta : undefined;
  if (meta !== null && typeof meta === 'object' && Array.isArray(meta.diffs)) {
    for (const diff of meta.diffs) {
      if (diff !== null && typeof diff === 'object' && typeof diff.path === 'string' && diff.path !== '') {
        paths.add(diff.path);
      }
    }
  }
  // ② 参数里的路径(str_replace_editor 这类没有 meta 的工具靠这条)
  if (paths.size === 0 && WRITE_TOOLS.has(name) && args !== null && typeof args === 'object') {
    for (const key of ['file_path', 'path', 'file']) {
      const value = args[key];
      if (typeof value === 'string' && value !== '') {
        paths.add(value);
        break;
      }
    }
    // str_replace_editor 的 `view` 不改文件 —— 别把只读调用也报成改动
    if (name === 'str_replace_editor' && args.command === 'view') paths.clear();
  }
  // `meta.diffs[].path` 是**原样的调用参数**(可能是相对路径,由 DSH 按会话 cwd 展开);
  // 不展开就交给编辑器的话,它会按 IDE 自己的进程 cwd 解析 —— 轻则判"工作区外"丢掉,
  // 重则匹配到另一个同名文件。没有 cwd(非 agent 调用)时保持原样,不猜。
  return [...paths].map((item) => absolutePath(item, cwd) ?? item);
}

/**
 * 注册观察器(返回同步 disposer)。
 *
 * @param {object} ctx cordis 上下文(需要能 `on`)
 * @param {{
 *   emit: (kind: string, fields?: object) => void,
 *   context: () => object|null,
 *   isLive: () => boolean,
 *   snapshots?: {put: (path: string, text: string) => string|null},
 * }} deps
 *   `emit(kind, fields)` 把事件推进 host 的环形缓冲;
 *   `context()` 取编辑器状态缓存(可能为 null);
 *   `isLive()` 桥是否就绪(用于决定要不要做脏缓冲区检查);
 *   `snapshots` 写前原文缓存(缺省时事件不带 oldKey,扩展退回旧行为)。
 */
export function registerBridgeObserver(ctx, deps) {
  if (ctx === undefined || ctx === null || typeof ctx.on !== 'function') return null;
  const disposers = [];
  /** path → 上次推送时间(去抖)。 */
  const lastEmit = new Map();
  /** 绝对路径 → 本次调用的写前原文信息(post-execute 记、tools/result 消费)。 */
  const pending = new Map();

  /** 记下本次调用的写前原文(有界:条数 + 存活时间,长会话里不会涨)。 */
  const rememberSnapshot = (info) => {
    const at = Date.now();
    for (const [key, item] of pending) {
      if (at - item.at > PENDING_TTL_MS) pending.delete(key);
    }
    pending.delete(info.path); // 同一文件的旧记录让位给本次调用
    pending.set(info.path, { info, at });
    while (pending.size > PENDING_MAX) {
      const oldest = pending.keys().next();
      if (oldest.done === true) break;
      pending.delete(oldest.value);
    }
  };

  /** 取走某个文件的写前原文信息(消费:只有紧随其后的那次事件能用它)。 */
  const takeSnapshot = (filePath) => {
    const item = pending.get(filePath);
    if (item === undefined) return null;
    pending.delete(filePath);
    if (Date.now() - item.at > PENDING_TTL_MS) return null;
    return item.info;
  };

  const onResult = (exec, result) => {
    try {
      if (exec === null || exec === undefined) return;
      const name = typeof exec.name === 'string' ? exec.name : '';
      if (name === '') return;
      const isError = result !== null && typeof result === 'object' && result.isError === true;
      if (isError) return; // 失败的写没有落点,别把编辑器叫起来
      const cwd = sessionCwdOf(exec);
      const paths = extractEditedPaths(name, exec.arguments, result, cwd);
      if (paths.length === 0) return;
      const now = Date.now();
      const sessionId = exec.agent !== undefined && exec.agent !== null && exec.agent.session !== undefined
        ? (exec.agent.session.id ?? exec.agent.id ?? null)
        : null;
      for (const filePath of paths) {
        const previous = lastEmit.get(filePath);
        if (previous !== undefined && now - previous < DEBOUNCE_MS) {
          // 去抖丢掉的这条事件,对应的快照也别留着(否则会错配给下一次改动)
          takeSnapshot(filePath);
          continue;
        }
        lastEmit.set(filePath, now);
        const snapshot = takeSnapshot(filePath);
        // 写前原文走快照缓存(事件里只带不透明 key):/sync 的响应还驮着对话流与待决授权,
        // 往里塞全文会把那一趟拖成超时(0.3.27 的真实事故)。
        let oldKey = null;
        if (snapshot !== null && snapshot.oldSide === 'snapshot' && typeof deps.snapshots?.put === 'function') {
          try {
            oldKey = deps.snapshots.put(filePath, snapshot.beforeText);
          } catch (err) {
            console.warn(`[code-server] 编辑器桥:写前原文入缓存失败 ${err && err.message ? err.message : err}`);
            oldKey = null;
          }
        }
        const fields = { path: filePath, tool: name, sessionId };
        if (snapshot !== null) {
          fields.operation = snapshot.operation ?? null;
          fields.oldSide = oldKey === null ? snapshot.oldSide : 'snapshot';
          if (oldKey !== null) fields.oldKey = oldKey;
          if (snapshot.oldSide === 'too-large') fields.oldBytes = snapshot.bytes;
        }
        deps.emit('agent-edit', fields);
      }
      // 去抖表也要有界(长时间会话里文件数会涨)。
      if (lastEmit.size > 512) {
        for (const [key, at] of lastEmit) {
          if (now - at > DEBOUNCE_MS * 10) lastEmit.delete(key);
        }
      }
    } catch (err) {
      // emit 型观察点的异常会被 DSH 吞掉,这里自己记一条更清楚
      console.warn(`[code-server] 编辑器桥:处理 tool/result 失败 ${err && err.message ? err.message : err}`);
    }
  };

  /**
   * 写类工具的完整前后文只在 `tools/post-execute` 里可见(execution-local `value`,
   * durable 投影按设计剥掉了它)。**这里抛错会把成功的调用变成 isError** —— 见文件头。
   */
  const onPostExecute = async (exec, result, next) => {
    const decision = await next();
    try {
      if (decision === null || decision === undefined || decision.kind !== 'accept') return decision;
      if (result === null || typeof result !== 'object' || result.isError === true) return decision;
      const info = extractEditSnapshot(
        exec === null || exec === undefined ? '' : exec.name,
        exec === null || exec === undefined ? null : exec.arguments,
        result,
        exec,
      );
      if (info !== null) rememberSnapshot(info);
    } catch (err) {
      // 取值失败最坏是"这次 diff 没有 old 侧",绝不能影响 agent 的调用结果
      console.warn(`[code-server] 编辑器桥:取写前原文失败 ${err && err.message ? err.message : err}`);
    }
    return decision;
  };

  const onPreExecute = async (exec, next) => {
    const decision = await next();
    try {
      if (decision === null || decision === undefined || decision.kind !== 'allow') return decision;
      if (!deps.isLive()) return decision;
      const name = typeof exec?.name === 'string' ? exec.name : '';
      if (!WRITE_TOOLS.has(name)) return decision;
      const args = exec.arguments;
      if (args === null || typeof args !== 'object') return decision;
      const filePath = absolutePath(typeof args.file_path === 'string' ? args.file_path
        : (typeof args.path === 'string' ? args.path : null), sessionCwdOf(exec));
      if (filePath === null || filePath === '') return decision;
      if (name === 'str_replace_editor' && args.command === 'view') return decision;
      const cached = deps.context();
      if (cached === null || cached === undefined || cached.context === null) return decision;
      const dirty = Array.isArray(cached.context.dirtyBuffers) ? cached.context.dirtyBuffers : [];
      // 编辑器上报的是绝对路径,这里也必须绝对化后再比(否则相对路径永远匹配不上)
      const hit = dirty.find((item) => item !== null && item.path === filePath);
      if (hit === undefined) return decision;
      const createUserMessage = await loadDshCreateUserMessage();
      if (typeof createUserMessage !== 'function') return decision;
      if (typeof exec.deferContext !== 'function') return decision;
      exec.deferContext(createUserMessage({
        content: [{
          type: 'text',
          text: `Note from the editor: ${filePath} has UNSAVED changes in the VS Code buffer.`
            + ' Writing it now will conflict with what the user sees; the editor will keep their buffer and show a diff.'
            + ' Consider mentioning it, or asking them to save/discard first.',
        }],
        source: { kind: 'plugin', plugin: SOURCE_PLUGIN, form: 'notice', summary: '编辑器里有未保存改动' },
      }));
    } catch (err) {
      // 提示失败绝不影响调用
      console.warn(`[code-server] 编辑器桥:dirty 提示失败 ${err && err.message ? err.message : err}`);
    }
    return decision;
  };

  try {
    disposers.push(ctx.on('tools/result', onResult));
  } catch (err) {
    console.warn(`[code-server] 编辑器桥:注册 tools/result 失败 ${err && err.message ? err.message : err}`);
  }
  try {
    // 写前原文只有这里拿得到(value 是 execution-local,durable 投影里没有)。
    // 旧版 DSH(没有这个观察点)不会报错,只是事件里缺 oldKey —— 扩展退回旧行为。
    disposers.push(ctx.on('tools/post-execute', onPostExecute));
  } catch (err) {
    console.warn(`[code-server] 编辑器桥:注册 tools/post-execute 失败 ${err && err.message ? err.message : err}`);
  }
  try {
    disposers.push(ctx.on('tools/pre-execute', onPreExecute));
  } catch (err) {
    console.warn(`[code-server] 编辑器桥:注册 tools/pre-execute 失败 ${err && err.message ? err.message : err}`);
  }

  return () => {
    for (const dispose of disposers) {
      try {
        if (typeof dispose === 'function') dispose();
      } catch {
        // 忽略
      }
    }
  };
}

/** 懒解析(与 bridge-tools 同一策略):解析不到就静默跳过提示。 */
let createUserMessagePromise = null;
function loadDshCreateUserMessage() {
  createUserMessagePromise ??= loadDshExport('@deepseek-ai/dsh-llm', 'createUserMessage');
  return createUserMessagePromise;
}
