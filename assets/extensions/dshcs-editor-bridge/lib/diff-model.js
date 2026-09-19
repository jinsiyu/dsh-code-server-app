// dshcs-editor-bridge / lib/diff-model.js —— 纯逻辑:agent 改动 → 编辑器侧审阅决策
//
// **不 require('vscode')**:入参是纯文本,所以能单测。
//
// 端到端这条链路是这样走的(每一步都有理由,别随手简化):
//
//   host: `ctx.on('tools/post-execute')` 拿到这次写的**完整写前原文**(`result.value.before`)
//     → 存进有界快照缓存,`tools/result` 的事件里只带一个不透明 key(见 host 侧 lib/edit-snapshot.mjs)
//   ext : 轮询拿到事件
//     → old 侧按优先级取:`operation==='create'`(左栏本来就该空)→ **快照**(写前磁盘内容,
//       唯一精确的来源)→ 该文档此刻的缓冲区(**必须在 await 别的之前同步取**:此刻 VS Code 的
//       磁盘 watcher 可能还没把新内容灌进缓冲区,晚一步就拿不到"改动前"了)→ 上次见过的缓存
//     → 再用 workspace.fs 读磁盘作 new 侧
//     → old === new ⇒ 不打扰用户(agent 写的和盘上一样,缓冲区本来就没差别)
//     → 不同 ⇒ 开 diff tab;若该文档 isDirty,弹一条非模态告警(绝不自动覆盖用户的未保存改动)
//
// 为什么快照优先于缓冲区(0.3.55 之前是反过来的):文件**没在编辑器里打开**时缓冲区根本不存在,
// 那时左栏只能给空文本 + "没有改动前的内容" —— 用户实测到的就是这个(空 old / 全文 new)。
// 缓冲区是"用户此刻看到的东西",不是"DSH 改之前磁盘上的东西";只有拿不到快照时才用它兜底,
// 而它偏向哪一侧(改前/改后)取决于磁盘 watcher 有没有抢在前面刷新。
//
// 为什么要缓存"上次见过的内容":文件没在编辑器里打开、宿主也没给快照(旧版 DSH / 工具没给 value)
// 时,只能靠上次轮询时记下的内容。缓存有界(超出丢最旧),因为它的用途只是 diff,不是版本控制。

'use strict';

/** 缓存条目上限(每个条目是一份完整文件文本 —— 不能无界)。 */
const CACHE_MAX = 64;

/**
 * 选 old 侧文本(改动前的左侧),并说明它来自哪里。
 *
 * 优先级(每条都有具体理由,见文件头):
 *   1. `operation === 'create'` —— 宿主明确说是新建 ⇒ 左栏就该是空文本(而不是"拿不到")。
 *   2. 快照文本 —— 宿主在**写的那一刻**抓的写前原文,唯一精确的来源。
 *   3. 缓冲区文本 —— 文档开着才有的兜底;可能是改后(磁盘 watcher 已刷新)或用户的未保存改动。
 *   4. 上次见过的缓存 —— 老行为,聊胜于无。
 *   5. 都没有 ⇒ null(调用方据此显示"拿不到改动前的内容",而不是假装文件原来是空的)。
 *
 * @param {{snapshotText?: string|null, bufferText?: string|null, cachedText?: string|null,
 *          operation?: string|null}} input
 * @returns {{text: string|null, source: 'create'|'snapshot'|'buffer'|'cache'|'none'}}
 */
function chooseOldSide(input) {
  const value = input === null || input === undefined ? {} : input;
  if (value.operation === 'create') return { text: '', source: 'create' };
  if (typeof value.snapshotText === 'string') return { text: value.snapshotText, source: 'snapshot' };
  if (typeof value.bufferText === 'string') return { text: value.bufferText, source: 'buffer' };
  if (typeof value.cachedText === 'string') return { text: value.cachedText, source: 'cache' };
  return { text: null, source: 'none' };
}

/**
 * 判据:这次改动值不值得开 diff。
 *
 * 只有"文本确实不同"才值得。空文件 ↔ 空文件、或 agent 写回了一模一样的内容,都不该打扰用户。
 *
 * `added` / `removed` 在**只有一侧**时是 `null` 而不是猜出来的数字:没有 old 侧就无从知道
 * "新增了几行"(新文件的所有行都是新增,但那只对新建文件成立;覆盖写不是)——
 * 报个 0 或报个全文行数都会误导用户与模型。null 让调用方只显示"有变化"。
 * **例外**:宿主明确说了 `operation === 'create'`(真·新建)时行数是确定的(全文都是新增),
 * 报 `+N` 不是猜的。
 *
 * @param {string|null} oldText 改动前(快照/缓冲区/缓存)
 * @param {string|null} newText 改动后(磁盘)
 * @param {{operation?: string|null, oldSide?: string|null}} [options]
 *        `operation` 来自宿主的 FsWriteOutcome('create' | 'update');
 *        `oldSide` 是宿主对"为什么没有 old 文本"的说明('too-large' | 'unavailable')。
 * @returns {{show: boolean, reason: string, added: number|null, removed: number|null}}
 */
function describeChange(oldText, newText, options) {
  const oldStr = typeof oldText === 'string' ? oldText : null;
  const newStr = typeof newText === 'string' ? newText : null;
  const opts = options === null || options === undefined ? {} : options;
  if (opts.operation === 'create') {
    if (newStr === null) return { show: false, reason: '新建的文件已不可读', added: null, removed: null };
    if (newStr === '') return { show: false, reason: '新建了空文件', added: 0, removed: 0 };
    // 用"diff 意义上的行数":末尾那个换行不算一整行(否则 "a\nb\nc\n" 会报 +4,而 diff 里只显示 3 行)
    return { show: true, reason: '新建文件', added: contentLineCount(newStr), removed: 0 };
  }
  if (oldStr === null && newStr === null) return { show: false, reason: '两侧都不可读', added: null, removed: null };
  if (oldStr === null) {
    return {
      show: newStr !== '',
      reason: opts.oldSide === 'too-large' ? '改动前的内容过大,未取到' : '拿不到改动前的内容',
      added: null,
      removed: null,
    };
  }
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

/** diff 意义上的行数:末尾的换行符不算多出一行(VS Code 的 diff 也是这么显示的)。 */
function contentLineCount(text) {
  if (typeof text !== 'string' || text === '') return 0;
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
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
  chooseOldSide,
  describeChange,
  countLines,
  lineStats,
  createDiffCache,
};
