/**
 * lib/bridge-observe.mjs — 观察 agent 的写操作,并把结果送进编辑器(0.3.0)。
 *
 * 两个方向:
 *
 * **agent → 编辑器**(`tools/result`):把所有写类工具的落点推成"去看一眼这个文件"的事件。
 *   - 不限定 agent:`ctx.on('tools/result')` 注册在根上下文,而 `dsh-scope` 的载体过滤是
 *     `tag === undefined → true`,所以**一个监听器能看到所有 agent 与子 agent 的调用**;
 *   - 事件里**只带路径**,不带内容 —— 内容由扩展自己算(它才知道缓冲区里那一份),
 *     这也让 host 侧不持有文件内容(少一处泄密面);
 *   - 有两条抽取路径,都必要:
 *       ① `result.meta.diffs`(`dsh-tool-fs` 的 write/edit 会带上 `FsDiffMeta`);
 *       ② 从 `exec.arguments.file_path` / `.path` 直接取(`str_replace_editor` **不带** meta,
 *          在别的 profile 里它才是主力工具)。
 *   - `tools/result` 是 emit 型观察点:抛错不会影响调用结果(`notifyResult` 内部吞掉 listener
 *     异常),所以这里出问题最坏就是"少一次 diff 提示",绝不会弄坏 agent 的一轮。
 *
 * **编辑器 → agent**(`tools/pre-execute`):写之前如果该文件在编辑器里是脏的,附一条提示。
 *   - 用 `exec.deferContext(...)` 而不是改写入参:`PreToolDecision` **明确排除了入参改写**
 *     (参数已经进日志与展示了),所以"提醒"是唯一正确的介入方式;
 *   - **不阻断**:误报的代价是模型看到一句提示,而阻断一个正确的编辑会让 agent 卡住;
 *   - 桥不可用/状态过期 → 直接放行,零开销。
 */

import { loadDshExport } from './dsh-resolve.mjs';

/** 会改文件的工具名(各 profile 里的名字不同,所以按"名字 + 参数里有路径"双重判定)。 */
const WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor', 'create_file', 'apply_patch', 'multi_edit']);

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
 * @returns {string[]} 绝对路径列表(去重)
 */
export function extractEditedPaths(name, args, result) {
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
  return [...paths];
}

/**
 * 注册观察器(返回同步 disposer)。
 *
 * @param {object} ctx cordis 上下文(需要能 `on`)
 * @param {{
 *   emit: (kind: string, fields?: object) => void,
 *   context: () => object|null,
 *   isLive: () => boolean,
 * }} deps
 *   `emit(kind, fields)` 把事件推进 host 的环形缓冲;
 *   `context()` 取编辑器状态缓存(可能为 null);
 *   `isLive()` 桥是否就绪(用于决定要不要做脏缓冲区检查)。
 */
export function registerBridgeObserver(ctx, deps) {
  if (ctx === undefined || ctx === null || typeof ctx.on !== 'function') return null;
  const disposers = [];
  /** path → 上次推送时间(去抖)。 */
  const lastEmit = new Map();

  const onResult = (exec, result) => {
    try {
      if (exec === null || exec === undefined) return;
      const name = typeof exec.name === 'string' ? exec.name : '';
      if (name === '') return;
      const isError = result !== null && typeof result === 'object' && result.isError === true;
      if (isError) return; // 失败的写没有落点,别把编辑器叫起来
      const paths = extractEditedPaths(name, exec.arguments, result);
      if (paths.length === 0) return;
      const now = Date.now();
      const sessionId = exec.agent !== undefined && exec.agent !== null && exec.agent.session !== undefined
        ? (exec.agent.session.id ?? exec.agent.id ?? null)
        : null;
      for (const filePath of paths) {
        const previous = lastEmit.get(filePath);
        if (previous !== undefined && now - previous < DEBOUNCE_MS) continue;
        lastEmit.set(filePath, now);
        deps.emit('agent-edit', { path: filePath, tool: name, sessionId });
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

  const onPreExecute = async (exec, next) => {
    const decision = await next();
    try {
      if (decision === null || decision === undefined || decision.kind !== 'allow') return decision;
      if (!deps.isLive()) return decision;
      const name = typeof exec?.name === 'string' ? exec.name : '';
      if (!WRITE_TOOLS.has(name)) return decision;
      const args = exec.arguments;
      if (args === null || typeof args !== 'object') return decision;
      const filePath = typeof args.file_path === 'string' ? args.file_path
        : (typeof args.path === 'string' ? args.path : null);
      if (filePath === null || filePath === '') return decision;
      if (name === 'str_replace_editor' && args.command === 'view') return decision;
      const cached = deps.context();
      if (cached === null || cached === undefined || cached.context === null) return decision;
      const dirty = Array.isArray(cached.context.dirtyBuffers) ? cached.context.dirtyBuffers : [];
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
