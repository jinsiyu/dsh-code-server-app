// dshcs-editor-bridge / lib/fim-completion.js —— 纯逻辑:FIM 补全的请求决策与载荷构造
//
// 来源与许可:本文件**为独立实现,不含 continuedev/continue 的源码**;其门控/窗口/缓存的设计与
// 设置项划分**参考**了该项目(Apache License 2.0, Copyright 2023 Continue)。详见 `THIRD_PARTY_NOTICES.md`。
//
// **不 require('vscode')**:入参都是纯文本/数字,所以能在没有 VS Code 的环境里单测
// (scripts/test-fim.mjs 就是这么用的)。与编辑器交互的部分在 extension.js(glue)里。
//
// 这个文件回答三个问题(顺序就是补全一次要过的三关):
//   1. **该不该问**(`shouldRequest`)—— 模型在被问到"不该补的地方"时会硬凑(实测 2/2),
//      所以"不值得问"必须在**发请求之前**判掉,而不是拿到回答再丢;
//   2. **问什么**(`buildPayload`)—— 只送光标附近的窗口,不是整份文件;
//   3. **问过没有**(`createCompletionCache`)—— 同样的前后文重复问是纯浪费(实测 temperature=0
//      下两次回答逐字相同 ⇒ 缓存命中率会很高)。
//
// 窗口常量与宿主侧 `lib/fim-adapter.mjs` **同名同值**:扩展是随包分发的静态文件、不能 import
// 宿主代码,所以一致性靠 scripts/test-fim.mjs 的断言钉住(与 bridge-client.js 的桥常量同一套做法)。

'use strict';

/** 与宿主 lib/fim-adapter.mjs 保持一致(改一边就要改另一边,测试会拦)。 */
const FIM_MAX_PREFIX_CHARS = 6000;
const FIM_MAX_SUFFIX_CHARS = 2000;
const FIM_MAX_PREFIX_LINES = 120;
const FIM_MAX_SUFFIX_LINES = 40;

/** 停顿多久才真的发请求(毫秒)。打字过程中的请求全是浪费,而且会被宿主的速率闸挡掉。 */
const FIM_DEBOUNCE_MS = 250;

/** 超过这个行数的文档不参与补全(大文件里补全的收益低;用行数而不是字符数是为了避免
 *  每次击键都 `document.getText()` 把整份文档摸一遍)。 */
const FIM_MAX_DOCUMENT_LINES = 20000;

/** 缓存条目上限与有效期(键 = 前后文指纹;命中直接给结果,不再问模型)。 */
const FIM_CACHE_MAX = 24;
const FIM_CACHE_TTL_MS = 120000;

/** 把文本裁到窗口内(与宿主侧 `trimWindow` 同语义:字符与行数取先到者)。 */
function trimWindow(text, maxChars, maxLines, fromEnd) {
  if (typeof text !== 'string' || text === '') return '';
  let out = text;
  if (maxLines > 0) {
    const split = out.split('\n');
    if (split.length > maxLines) out = (fromEnd ? split.slice(split.length - maxLines) : split.slice(0, maxLines)).join('\n');
  }
  if (maxChars > 0 && out.length > maxChars) out = fromEnd ? out.slice(out.length - maxChars) : out.slice(0, maxChars);
  return out;
}

/**
 * 该不该为这次光标位置请求补全。
 *
 * 判据都是"**便宜且不会错判**"的那些 —— 宁可不补,也不要补错(补错一次,用户就关掉它)。
 *
 * @param {{selectionEmpty: boolean, scheme: string, lineCount: number,
 *          prefixText: string, suffixText: string, lineTextBefore: string}} input
 * @returns {{ask: boolean, reason: string}}
 */
function shouldRequest(input) {
  const value = input === null || input === undefined ? {} : input;
  if (value.selectionEmpty !== true) return { ask: false, reason: '有选区(用户在选中内容,不是在打字)' };
  if (value.scheme !== 'file') return { ask: false, reason: `非文件文档(${value.scheme ?? '未知'})` };
  if (!(Number.isFinite(value.lineCount) && value.lineCount > 0)) return { ask: false, reason: '空文档' };
  if (value.lineCount > FIM_MAX_DOCUMENT_LINES) return { ask: false, reason: '文档过大' };
  if (typeof value.prefixText !== 'string' || typeof value.suffixText !== 'string') return { ask: false, reason: '拿不到前后文' };
  // 光标前整行都是空白、且前面也没有内容 ⇒ 没什么可续的(新建的空文件、文件开头按回车)。
  if (typeof value.lineTextBefore === 'string' && value.lineTextBefore.trim() === '') {
    if (value.prefixText.trim() === '' && value.suffixText.trim() === '') return { ask: false, reason: '空上下文' };
  }
  return { ask: true, reason: 'ok' };
}

/** 前后文的指纹(缓存键):只看窗口内的内容,与路径/语言一起构成键。 */
function fingerprint(prefix, suffix, language) {
  const text = `${language ?? ''}\u0000${prefix ?? ''}\u0000${suffix ?? ''}`;
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${text.length}:${(hash >>> 0).toString(36)}`;
}

/**
 * 构造发往宿主的载荷(只含窗口内的前后文)。
 * @returns {{prompt: string, suffix: string, language: string, path: string}}
 */
function buildPayload({ prefixText, suffixText, language, path }) {
  return {
    prompt: trimWindow(prefixText ?? '', FIM_MAX_PREFIX_CHARS, FIM_MAX_PREFIX_LINES, true),
    suffix: trimWindow(suffixText ?? '', FIM_MAX_SUFFIX_CHARS, FIM_MAX_SUFFIX_LINES, false),
    language: typeof language === 'string' ? language : '',
    path: typeof path === 'string' ? path : '',
  };
}

/** 有界 + 带 TTL 的结果缓存。 */
function createCompletionCache({ max = FIM_CACHE_MAX, ttlMs = FIM_CACHE_TTL_MS, now = () => Date.now() } = {}) {
  const store = new Map();
  return {
    get(key) {
      const hit = store.get(key);
      if (hit === undefined) return null;
      if (now() - hit.at > ttlMs) {
        store.delete(key);
        return null;
      }
      store.delete(key);
      store.set(key, hit);
      return hit.text;
    },
    set(key, text) {
      if (typeof key !== 'string' || key === '' || typeof text !== 'string') return false;
      store.delete(key);
      store.set(key, { text, at: now() });
      while (store.size > max) {
        const oldest = store.keys().next();
        if (oldest.done === true) break;
        store.delete(oldest.value);
      }
      return true;
    },
    size() {
      return store.size;
    },
    clear() {
      store.clear();
    },
  };
}

/** 数字 → 状态栏用短串(1.2k / 12k / 1.2M)。 */
function formatTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1000000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1000000).toFixed(1)}M`;
}

/** 状态栏 tooltip 里那段 FIM 说明(纯字符串组装,便于单测)。 */
function describeFimUsage(fim) {
  if (fim === null || typeof fim !== 'object') return [];
  if (fim.enabled !== true) return ['FIM 补全:已关闭(设置里可开,实验性)'];
  const lines = [
    `FIM 补全(实验性):已开启${fim.available === false ? ` —— 不可用:${fim.reason ?? '原因未知'}` : ''}`,
    `调用 ${fim.calls ?? 0} 次(成功 ${fim.ok ?? 0}/失败 ${fim.failed ?? 0})`,
    `输入 ${formatTokens(fim.inputTokens)} tok · 输出 ${formatTokens(fim.outputTokens)} tok · 缓存命中 ${formatTokens(fim.cacheReadTokens)} tok`,
    `停顿 ${Number.isFinite(fim.debounceMs) ? Math.round(fim.debounceMs) : FIM_DEBOUNCE_DEFAULT_MS}ms · `
      + `${fim.multiline === false ? '仅单行' : '允许多行'}`
      + `${Array.isArray(fim.disableGlobs) && fim.disableGlobs.length > 0 ? ` · 禁用 ${fim.disableGlobs.length} 条 glob` : ''}`,
  ];
  if (Number.isFinite(fim.lastMs)) lines.push(`最近一次 ${Math.round(fim.lastMs)}ms`);
  if (typeof fim.lastError === 'string' && fim.lastError !== '') lines.push(`最近错误:${fim.lastError}`);
  return lines;
}

// ---------------------------------------------------------------- 与宿主同语义的两件小事
//
// 为什么在这里**再实现一遍**:扩展是随包分发的静态文件,不能 import 宿主代码(ESM/CJS + 树内外),
// 而这两个判据必须在"发请求之前/收响应之后"本地生效 —— 一致性由 scripts/test-fim.mjs 用同一组
// 语料对两边做等价断言(与桥常量、窗口常量同一套做法)。

/** 与宿主 lib/fim-adapter.mjs 的 FIM_DEBOUNCE_DEFAULT_MS 同值(宿主会在 /sync 里给实际值)。 */
const FIM_DEBOUNCE_DEFAULT_MS = 250;

/** 解析 glob 清单(与宿主 compileGlobList 同语义)。 */
function compileGlobList(text) {
  if (typeof text !== 'string' || text.trim() === '') return [];
  const seen = new Set();
  const out = [];
  for (const raw of text.split(/[;,\s]+/)) {
    const item = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (item === '' || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/** glob → 正则(与宿主 globToRegExp 同语义:`*` 不跨目录、`**` 跨目录、不含 `/` 只匹配文件名)。 */
function globToRegExp(glob) {
  let g = typeof glob === 'string' ? glob.trim().replace(/\\/g, '/').replace(/^\.\//, '') : '';
  if (g === '') return null;
  if (g.endsWith('/')) g += '**';
  const anchored = g.includes('/');
  let out = '';
  for (let i = 0; i < g.length; i += 1) {
    const ch = g[i];
    if (ch === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return { re: new RegExp(`^${out}$`), anchored };
}

/** 路径是否命中禁用清单(返回命中的模式或 null)。
 *  含 `/` 的模式按**完整路径与各层尾段**各试一次(与宿主 lib/fim-adapter.mjs 同语义:
 *  用户写 `vendor/**` 的直觉是"任何层级下的 vendor",而绝对路径永远以 `/` 或盘符开头)。 */
function matchDisabledGlob(filePath, globs) {
  if (typeof filePath !== 'string' || filePath === '') return null;
  const list = Array.isArray(globs) ? globs : compileGlobList(globs);
  if (list.length === 0) return null;
  const full = filePath.replace(/\\/g, '/');
  const slash = full.lastIndexOf('/');
  const base = slash === -1 ? full : full.slice(slash + 1);
  for (const glob of list) {
    const parsed = globToRegExp(glob);
    if (parsed === null) continue;
    if (!parsed.anchored) {
      if (parsed.re.test(base)) return glob;
      continue;
    }
    if (parsed.re.test(full)) return glob;
    for (let i = full.indexOf('/'); i !== -1; i = full.indexOf('/', i + 1)) {
      if (parsed.re.test(full.slice(i + 1))) return glob;
    }
  }
  return null;
}

/** 只保留第一行(宿主在关掉多行时也会做;这里是第二道)。 */
function toSingleLine(text) {
  if (typeof text !== 'string' || text === '') return '';
  const first = text.split('\n')[0];
  return first.trim() === '' ? '' : first;
}

module.exports = {
  FIM_MAX_PREFIX_CHARS,
  FIM_MAX_SUFFIX_CHARS,
  FIM_MAX_PREFIX_LINES,
  FIM_MAX_SUFFIX_LINES,
  FIM_DEBOUNCE_MS,
  FIM_DEBOUNCE_DEFAULT_MS,
  FIM_MAX_DOCUMENT_LINES,
  FIM_CACHE_MAX,
  FIM_CACHE_TTL_MS,
  trimWindow,
  shouldRequest,
  fingerprint,
  buildPayload,
  createCompletionCache,
  formatTokens,
  describeFimUsage,
  compileGlobList,
  globToRegExp,
  matchDisabledGlob,
  toSingleLine,
};
