// dshcs-editor-bridge / lib/diff-model.js —— 纯逻辑:agent 改动 → 编辑器侧审阅决策
//
// **不 require('vscode')**:入参是纯文本,所以能单测。
//
// 端到端这条链路是这样走的(每一步都有理由,别随手简化):
//
//   host: `ctx.on('tools/result')` 看到写类工具(exec.name + exec.arguments)
//     → 推一条 {kind:'agent-edit', path} 进环形缓冲(只播"去看一眼",不播数据)
//   ext : 轮询拿到事件
//     → **立刻**取该文档当前文本作 old 侧:此时 VS Code 的磁盘 watcher 还没把新内容灌进缓冲区,
//       所以缓冲区里拿到的正是"改动前"的内容(时序敏感,不能先 await 别的)
//     → 再用 workspace.fs 读磁盘作 new 侧
//     → old === new ⇒ 不打扰用户(agent 写的和盘上一样,缓冲区本来就没差别)
//     → 不同 ⇒ 开 diff tab;若该文档 isDirty,弹一条非模态告警(绝不自动覆盖用户的未保存改动)
//
// 为什么要缓存"上次见过的内容":文件没在编辑器里打开时缓冲区取不到 old 侧,只能靠上次轮询时
// 记下的内容。缓存有界(超出丢最旧),因为它的用途只是 diff,不是版本控制。

'use strict';

/** 缓存条目上限(每个条目是一份完整文件文本 —— 不能无界)。 */
const CACHE_MAX = 64;

/**
 * 判据:这次改动值不值得开 diff。
 *
 * 只有"文本确实不同"才值得。空文件 ↔ 空文件、或 agent 写回了一模一样的内容,都不该打扰用户。
 *
 * `added` / `removed` 在**只有一侧**时是 `null` 而不是猜出来的数字:没有 old 侧就无从知道
 * "新增了几行"(新文件的所有行都是新增,但那只对新建文件成立;覆盖写不是)——
 * 报个 0 或报个全文行数都会误导用户与模型。null 让调用方只显示"有变化"。
 *
 * @param {string|null} oldText 改动前(缓冲区/缓存)
 * @param {string|null} newText 改动后(磁盘)
 * @returns {{show: boolean, reason: string, added: number|null, removed: number|null}}
 */
function describeChange(oldText, newText) {
  const oldStr = typeof oldText === 'string' ? oldText : null;
  const newStr = typeof newText === 'string' ? newText : null;
  if (oldStr === null && newStr === null) return { show: false, reason: '两侧都不可读', added: null, removed: null };
  if (oldStr === null) return { show: newStr !== '', reason: '没有改动前的内容', added: null, removed: null };
  if (newStr === null) return { show: oldStr !== '', reason: '文件已被删除', added: null, removed: null };
  if (oldStr === newStr) return { show: false, reason: '内容未变化', added: 0, removed: 0 };
  const stats = lineStats(oldStr, newStr);
  return { show: true, reason: '内容有变化', added: stats.added, removed: stats.removed };
}

/** 行数(空串算 0 行)。 */
function countLines(text) {
  if (typeof text !== 'string' || text === '') return 0;
  return text.split(/\r\n|\r|\n/).length;
}

/**
 * 极简行级统计(不是完整 diff —— 只用来给用户一句"±N 行"的量级,完整 diff 由 VS Code 渲染)。
 * 用"最长公共前后缀裁剪"来近似:裁剪后剩下的行数就是改动规模。
 */
function lineStats(oldText, newText) {
  const a = oldText.split(/\r\n|\r|\n/);
  const b = newText.split(/\r\n|\r|\n/);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  return { removed: a.length - head - tail, added: b.length - head - tail };
}

/**
 * 有界 LRU 文本缓存(键 = 绝对路径)。
 */
function createDiffCache(max) {
  const cap = Number.isSafeInteger(max) && max > 0 ? max : CACHE_MAX;
  /** @type {Map<string, {text: string, at: number}>} */
  const store = new Map();

  function touch(key) {
    const value = store.get(key);
    if (value === undefined) return undefined;
    store.delete(key);
    store.set(key, value);
    return value;
  }

  return {
    /** 记下"现在这个文件长这样"。 */
    remember(key, text, at) {
      if (typeof key !== 'string' || key === '' || typeof text !== 'string') return false;
      store.delete(key);
      store.set(key, { text, at: Number.isFinite(at) ? at : 0 });
      while (store.size > cap) {
        const oldest = store.keys().next();
        if (oldest.done === true) break;
        store.delete(oldest.value);
      }
      return true;
    },
    /** 取上次见过的内容(命中会把它挪到最新)。 */
    recall(key) {
      const value = touch(key);
      return value === undefined ? null : value.text;
    },
    has(key) {
      return store.has(key);
    },
    get size() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    keys() {
      return [...store.keys()];
    },
  };
}

module.exports = {
  CACHE_MAX,
  describeChange,
  countLines,
  lineStats,
  createDiffCache,
};
