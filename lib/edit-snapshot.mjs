/**
 * lib/edit-snapshot.mjs — 写前原文快照:把"改动前的完整内容"从工具调用里取出来(0.3.55)。
 *
 * **为什么需要它**(用户实测到的症状:diff 左侧空、右侧全文):
 * 扩展侧拿 old 侧的渠道以前只有两条 —— ① 编辑器里**打开着**的缓冲区;② 它自己上次看过的缓存。
 * 文件没在编辑器里打开(最常见:agent 直接改一个新文件)时两条都落空 ⇒ 左栏是空文本,
 * 标题写着"没有改动前的内容"。而"写之前文件长什么样"这件事,**只有 host 知道**。
 *
 * **为什么不用 `tools/result`**:那条通道是 emit 型 + durable 投影,`ToolResult` 里**故意**没有
 * `value`(见 DSH `packages/core/tools/src/index.ts`:`Execution-local canonical value;
 * deliberately omitted from durable events`)。真正的完整前后文在 `ToolExecutionSuccess.value` 里:
 *   · `write` → `{path, operation, before, after}`(`before` 是写前全文,新建时为 `null`)
 *   · `edit`  → `{path, before, after}`(都是**整份文件**文本,不是 hunk)
 * 所以取值点在 `tools/post-execute`(waterfall,能看见 live 的 `result.value`)。
 *
 * **两条硬约束**(踩了会出真事故,别改):
 *   1. `tools/post-execute` 的监听器**抛错会把成功的调用变成 `isError`**
 *      (DSH 源码注释:`Runs inside execute's outer try/catch (a throwing listener → isError)`)。
 *      ⇒ 调用方必须整体 try/catch;本模块的每个函数都设计成"宁可返回 null,绝不抛"。
 *   2. `value` 是 **execution-local**:会话日志/replay 里没有它,只有当场那一次能拿到。
 *
 * **路径可能是相对的**:`value.path` 是 `displayPath`(文档明说"可能是工作区相对路径"),
 * `meta.diffs[].path` 更是**原样的调用参数**。相对路径由 DSH 按**会话 cwd**
 * (`exec.agent.session.header.cwd`)展开 —— 扩展侧拿到相对路径会去按 IDE 自己的 cwd 解析,
 * 于是 `isInWorkspace()` 判否(不出 diff)或匹配到另一个文件。所以这里统一绝对化。
 *
 * 纯逻辑(不 import DSH、不碰 cordis),因此可以直接单测:scripts/test-edit-snapshot.mjs。
 */

import { randomBytes } from 'node:crypto';
import path from 'node:path';

/** 会改文件的工具名(各 profile 里的名字不同,所以按"名字 + 参数里有路径"双重判定)。 */
export const WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor', 'create_file', 'apply_patch', 'multi_edit']);

/** 单份快照上限:超过就不存(改由扩展回退到缓冲区/缓存,并在标题里说明原因)。 */
export const MAX_SNAPSHOT_BYTES = 1024 * 1024;
/** 快照缓存总量上限(它是为了"下一次轮询",不是版本控制)。 */
export const SNAPSHOT_BUDGET_BYTES = 4 * 1024 * 1024;
/** 快照条数上限(扩展每 600ms 取一次,8 条足够覆盖"这一批改动")。 */
export const MAX_SNAPSHOTS = 8;
/** 快照存活时长:过期即丢(没人来取 = 扩展没在跑,留着只是占内存)。 */
export const SNAPSHOT_TTL_MS = 5 * 60 * 1000;

/** 本次调用会话的工作目录(DSH 用它展开相对路径;非 agent 调用没有)。 */
export function sessionCwdOf(exec) {
  const cwd = exec === null || exec === undefined || exec.agent === null || exec.agent === undefined
    ? undefined
    : exec.agent.session === undefined || exec.agent.session === null
      ? undefined
      : exec.agent.session.header === undefined || exec.agent.session.header === null
        ? undefined
        : exec.agent.session.header.cwd;
  return typeof cwd === 'string' && cwd !== '' ? cwd : null;
}

/**
 * 把工具给的路径变成绝对路径。
 *
 * 没有 cwd(非 agent 调用)或本来就绝对时不做猜测:绝对路径只做归一化,相对路径**原样返回**
 * (扩展侧对它保持旧行为:不在工作区内就跳过 —— 宁可不显示,也不要打开错的文件)。
 *
 * @param {unknown} value 工具给的路径
 * @param {string|null} cwd 会话 cwd
 * @returns {string|null}
 */
export function absolutePath(value, cwd) {
  if (typeof value !== 'string' || value === '') return null;
  if (path.isAbsolute(value)) return path.normalize(value);
  if (typeof cwd !== 'string' || cwd === '') return value;
  return path.resolve(cwd, value);
}

/** UTF-8 字节数(内存预算按它算,不是按字符数)。 */
function byteLength(text) {
  return Buffer.byteLength(text, 'utf8');
}

/** 取第一个非空字符串(按给定顺序)。 */
function firstString(values) {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

/**
 * 从一次工具结果里抽出"这次写操作的写前原文"。
 *
 * `oldSide` 的取值(扩展侧据此决定标题与左栏):
 *   · `snapshot`    拿到了完整写前文本(见 `beforeText`);
 *   · `create`      明确的新建(`operation === 'create'`,或 `before === null`)⇒ 左栏本来就该是空的;
 *   · `too-large`   写前文本超过 {@link MAX_SNAPSHOT_BYTES} ⇒ 不传,扩展回退;
 *   · `unavailable` 工具没给文本(`str_replace_editor` 这类 output 是纯字符串的工具,或旧版 DSH)。
 *
 * @param {string} name 工具名
 * @param {unknown} args 调用参数
 * @param {{isError?: boolean, value?: unknown}} result 结果(成功时带 execution-local `value`)
 * @param {unknown} exec 调用上下文(只为取会话 cwd)
 * @returns {{path: string, operation: string|null, oldSide: string, beforeText: string|null, bytes: number}|null}
 *          null = 这次不是"能取出写前原文的写操作"
 */
export function extractEditSnapshot(name, args, result, exec) {
  if (typeof name !== 'string' || !WRITE_TOOLS.has(name)) return null;
  if (result === null || typeof result !== 'object') return null;
  if (result.isError === true) return null;
  const argv = args !== null && typeof args === 'object' ? args : null;
  // str_replace_editor 的 `view` 不改文件 —— 别把只读调用也报成改动
  if (name === 'str_replace_editor' && argv !== null && argv.command === 'view') return null;

  const value = result.value !== null && result.value !== undefined && typeof result.value === 'object' ? result.value : null;
  const raw = firstString([
    value === null ? null : value.path,
    argv === null ? null : argv.file_path,
    argv === null ? null : argv.path,
    argv === null ? null : argv.file,
  ]);
  const abs = absolutePath(raw, sessionCwdOf(exec));
  if (abs === null) return null;

  const operation = value !== null && (value.operation === 'create' || value.operation === 'update') ? value.operation : null;
  const hasBefore = value !== null && Object.hasOwn(value, 'before');
  const before = hasBefore ? value.before : undefined;

  // 新建:写前没有内容。`before === null` 只可能出现在新建(fs 层"存在但读不到内容"不会发生:
  // 写前必读,写与读之间还有版本栅栏),所以它和 `operation === 'create'` 同义。
  if (operation === 'create' || before === null) {
    return { path: abs, operation: operation ?? 'create', oldSide: 'create', beforeText: null, bytes: 0 };
  }
  if (typeof before === 'string') {
    const bytes = byteLength(before);
    if (bytes > MAX_SNAPSHOT_BYTES) {
      return { path: abs, operation, oldSide: 'too-large', beforeText: null, bytes };
    }
    return { path: abs, operation, oldSide: 'snapshot', beforeText: before, bytes };
  }
  return { path: abs, operation, oldSide: 'unavailable', beforeText: null, bytes: 0 };
}

/**
 * `/old` 路由的响应(纯逻辑,便于单测:路由本体只是"过闸 + 解析 key + jsonResponse")。
 *
 * 语义:
 *   · 缺 key → 400(调用方写错了,不是"过期");
 *   · 取不到 → 404(过期 / 被淘汰 / 宿主重启 —— **正常路径**,扩展据此回退到缓冲区,不重试);
 *   · 取到 → 200 + 文本(不消费,重复取拿到同一份)。
 *
 * @param {{get: (key: string) => ({path: string, text: string, bytes: number}|null)}|null} store 快照缓存
 * @param {string|null} key 事件里的 oldKey
 * @returns {{status: number, body: object}}
 */
export function snapshotResponse(store, key) {
  if (typeof key !== 'string' || key === '') {
    return { status: 400, body: { ok: false, error: '需要 key 参数' } };
  }
  const snapshot = store === null || store === undefined || typeof store.get !== 'function' ? null : store.get(key);
  if (snapshot === null || snapshot === undefined) {
    return { status: 404, body: { ok: false, error: '快照已失效' } };
  }
  return { status: 200, body: { ok: true, path: snapshot.path, text: snapshot.text, bytes: snapshot.bytes } };
}

/**
 * 有界快照缓存:host 存写前原文,扩展拿着**不透明 key** 来取。
 *
 * 为什么不让事件直接带文本:扩展每 600ms 的 `/sync` 响应还驮着对话流与待决授权,
 * 里面塞过 ~1MB 的文本会把那一趟拖成超时(0.3.27 的真实事故:超时 ⇒ approvals 一起丢 ⇒
 * 授权卡片永远不出现)。所以事件只带 key,文本走独立的 `/old` 路由按需取。
 *
 * key 是不透明随机串(不是路径、不是序号):即使令牌泄露,能读到的也只是"最近几次 agent 写操作
 * 的写前内容"这一份有界缓存,拿不到任意文件。
 *
 * @param {{maxEntries?: number, budgetBytes?: number, maxBytes?: number, ttlMs?: number, now?: () => number}} [options]
 */
export function createSnapshotStore(options = {}) {
  const maxEntries = Number.isSafeInteger(options.maxEntries) && options.maxEntries > 0 ? options.maxEntries : MAX_SNAPSHOTS;
  const budgetBytes = Number.isSafeInteger(options.budgetBytes) && options.budgetBytes > 0 ? options.budgetBytes : SNAPSHOT_BUDGET_BYTES;
  const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : MAX_SNAPSHOT_BYTES;
  const ttlMs = Number.isSafeInteger(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : SNAPSHOT_TTL_MS;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();

  /** key → {path, text, bytes, at}。插入顺序 = 时间顺序(淘汰最旧的用)。 */
  const items = new Map();
  let total = 0;

  function drop(key) {
    const item = items.get(key);
    if (item === undefined) return;
    items.delete(key);
    total -= item.bytes;
  }

  /** 过期清理 + 容量淘汰(put/get 时顺手做,不额外起定时器)。 */
  function reap() {
    const at = now();
    for (const [key, item] of items) {
      if (at - item.at > ttlMs) drop(key);
    }
    while (items.size > maxEntries || total > budgetBytes) {
      const oldest = items.keys().next();
      if (oldest.done === true) break;
      drop(oldest.value);
    }
  }

  return {
    /**
     * 存一份写前原文。
     * @returns {string|null} 不透明 key;不存(超限/非法)时返回 null
     */
    put(filePath, text) {
      if (typeof filePath !== 'string' || filePath === '' || typeof text !== 'string') return null;
      const bytes = byteLength(text);
      if (bytes > maxBytes || bytes > budgetBytes) return null;
      reap();
      const key = randomBytes(9).toString('base64url');
      items.set(key, { path: filePath, text, bytes, at: now() });
      total += bytes;
      reap();
      return key;
    },
    /** 取一份(不消费:扩展可能重复轮询同一条事件)。过期/未知 → null。 */
    get(key) {
      if (typeof key !== 'string' || key === '') return null;
      reap();
      const item = items.get(key);
      if (item === undefined) return null;
      return { path: item.path, text: item.text, bytes: item.bytes, at: item.at };
    },
    size() {
      reap();
      return items.size;
    },
    bytes() {
      return total;
    },
    clear() {
      items.clear();
      total = 0;
    },
  };
}
