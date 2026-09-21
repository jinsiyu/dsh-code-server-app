/**
 * lib/fim-adapter.mjs —— 实验性「FIM(幽灵)补全」的宿主侧:**一个注册进 DSH 的 LLM 适配器**(0.3.61)。
 *
 * 来源与许可:本文件**为独立实现,不含 continuedev/continue 的源码**;但其中的设计(停顿去抖、
 * 光标附近窗口、结果过滤/单行化、有界缓存、按文件禁用)与该设置项划分**参考**了该项目
 * (Apache License 2.0, Copyright 2023 Continue)。详见仓库根 `THIRD_PARTY_NOTICES.md`。
 *
 * ## 为什么是"注册自己的适配器"而不是直连(方案 A)
 *
 * FIM 走的是 **Completions API**(`POST /beta/completions`,参数 `prompt` + `suffix`),而 DSH 的
 * `ctx.llm.stream(GenerateOptions)` 词汇表里**只有 `messages`**、`purpose` 是封闭联合
 * (`'compaction' | 'session-title'`,见 `@deepseek-ai/dsh-llm` 的 `lib/types/types.d.ts:439-479`)——
 * **表达不了这个请求**。把 FIM 变成一等请求要改 DSH 源码;在插件里能做的有两条:
 *   ① **注册一个自己的 `LlmAdapter` 路由,用 messages 承载 prefix/suffix**(本文件,采纳);
 *   ② 直连 `fetch`(更短,但绕开 DSH 的 LLM 服务层:没有 `llm/stream` waterfall、没有取消契约、
 *      没有统一错误码,而且凭据与 attribution 语义要自己再实现一遍)。
 * ① 的代价是那条"信封"约定(见下),好处是**这条调用仍然是一次正常的模型调用**:取消、超时、
 * 终态 chunk、错误码全按服务的契约走,将来 DSH 把 completion 做成一等请求时,只要把
 * `stream()` 里的取数换成新 API 即可,调用方(`lib/index.js` 的 `/complete` 路由)一行都不用改。
 *
 * ## 信封(方案 A 唯一的"丑",所以写得尽量显式)
 *
 * `GenerateOptions.messages` 里放**一条 user 消息**,正文是:
 *
 *     dshcs-fim/1 {"prompt":"…","suffix":"…","language":"typescript","path":"src/a.ts"}
 *
 * 前缀是固定字面量(便于 grep / 单测 / 排障),载荷是 JSON。适配器**只认**这种正文:
 * 解不出信封就 `LlmError('…', 'INVALID_REQUEST')` —— 误用要**响**,不能静默降级成一次普通对话。
 *
 * ## 用量口径(最容易写错的一处)
 *
 * DSH 的 `TokenUsage` 是**互斥**计数(`types.d.ts:141-163`):`inputTokens` 只算**未缓存**输入,
 * 缓存读/写单独报;而 DeepSeek 的 `prompt_tokens` 是**含缓存的合计** ⇒ 必须减出去(`mapFimUsage`)。
 * 写错的表现是数字虚高、缓存收益看不见。
 *
 * ## 计量会落在哪(必须知道,不然会以为"没记账")
 *
 * 一次性插件调用**不是 loop 请求**(`isAgentLoopRequest` 为假),所以它**不会**写进会话日志 ⇒
 * `dsh-token-meter` 的逐轮/会话投影与遥测里**都没有它**(token-meter 只读会话事件,
 * 见 `dsh-token-meter/lib/index.js:397-398`)。因此本文件自带 `createFimStats()`,
 * 由状态栏把"这轮补全花了多少"显示给用户 —— 这是**唯一**的可见处。
 *
 * ## 边界(全部有界;这条链路会被每次击键触发)
 *
 * 前缀/后缀窗口、输出长度、单次超时、并发、速率都有上限,别放宽。
 */

import { loadDshExport, loadDshModule } from './dsh-resolve.mjs';

/** 我们注册的 provider 路由名(与官方的 `deepseek-official` 并列;同名会 DUPLICATE_ADAPTER)。 */
export const FIM_PROVIDER = 'dshcs-fim';

/** 官方 FIM 文档里的示例模型,也是本部署的默认模型。 */
export const FIM_MODEL = 'deepseek-flash';

/** Beta 基址(官方要求 base_url 带 /beta 才开 Beta 功能)。 */
export const FIM_BASE_URL = 'https://api.deepseek.com/beta';

/** 凭据引用名:与官方适配器的 `apiKeyEnv` 默认值同名 ⇒ 用户不需要再配一次。 */
export const FIM_CREDENTIAL_REF = 'DEEPSEEK_API_KEY';

/** 信封前缀(改这里等于改线上约定:扩展侧不参与,只有宿主两侧)。 */
export const FIM_ENVELOPE_PREFIX = 'dshcs-fim/1 ';

/** 前缀/后缀窗口(字符与行数取先到者;扩展侧也有一份同名常量,由 scripts/test-fim.mjs 钉住一致性)。 */
export const FIM_MAX_PREFIX_CHARS = 6000;
export const FIM_MAX_SUFFIX_CHARS = 2000;
export const FIM_MAX_PREFIX_LINES = 120;
export const FIM_MAX_SUFFIX_LINES = 40;

/** 输出上限与清洗上限(官方 FIM 最大 4K,但我们只要"插在光标处的一小段")。 */
export const FIM_MAX_TOKENS = 128;
export const FIM_MAX_OUTPUT_CHARS = 2000;

/** 单次超时(实测 112–416ms;4s 是"慢到不该再用"的判定线)。 */
export const FIM_TIMEOUT_MS = 4000;

/** 声明的模型上下文窗口(只是给服务做校验用的;我们的请求远小于它)。 */
export const FIM_CONTEXT_WINDOW = 131072;

/** 停顿窗口(可设):太短会在打字过程中反复触发,太长就失去"补全"的意义。 */
export const FIM_DEBOUNCE_DEFAULT_MS = 250;
export const FIM_DEBOUNCE_MIN_MS = 100;
export const FIM_DEBOUNCE_MAX_MS = 3000;

/** 把停顿值夹到合法范围(设置是用户填的,不能让 5ms 或 10^9 这样的值打到链路上)。
 *  **空值(undefined / null / '' / 非数字)回落默认值**,而不是被 `Number(null)===0` 夹成下限 ——
 *  输入框被清空是"没填",不是"要 100ms"。 */
export function clampDebounce(value) {
  if (value === undefined || value === null || value === '') return FIM_DEBOUNCE_DEFAULT_MS;
  const n = Number(value);
  if (!Number.isFinite(n)) return FIM_DEBOUNCE_DEFAULT_MS;
  return Math.min(FIM_DEBOUNCE_MAX_MS, Math.max(FIM_DEBOUNCE_MIN_MS, Math.round(n)));
}

/** 解析"按 glob 禁用"清单(分号 / 逗号 / 空白 / 换行分隔,与认领类型同一套书写习惯)。空串 = 不禁用。 */
export function compileGlobList(text) {
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

/**
 * glob → 正则(语义刻意做得小且可预测,别加"聪明"规则):
 *   - `*` 不跨目录;`**` 跨目录(含 0 层 ⇒ `**​/x` 也匹配 `x`);`?` 单个非 `/` 字符
 *   - **不含 `/` 的模式只匹配文件名**(`*.md` 命中 `a.md` 与 `src/a.md`);含 `/` 的匹配**完整路径**
 *   - 以 `/` 结尾视作 `/**`(`node_modules/` 符合直觉)
 *   - 大小写敏感,不做 Windows 特例
 * @returns {{re: RegExp, anchored: boolean}|null} null = 空模式
 */
export function globToRegExp(glob) {
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
          out += '(?:.*/)?'; // `**/` = 任意层目录(含 0 层)
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

/**
 * 路径是否命中禁用清单。
 *
 * 含 `/` 的模式**按完整路径与各层尾段各试一次**:用户写 `vendor/**`、`src/*.ts` 的直觉是
 * "任何层级下的它",而不是"仅根目录";只有这样写才不会静默失效(绝对路径永远以 `/` 或盘符开头)。
 * 不含 `/` 的模式只看文件名(与 .gitignore 的直觉一致)。
 *
 * @returns {string|null} 命中的那条模式(便于回给用户/写日志),未命中返回 null
 */
export function matchDisabledGlob(filePath, globs) {
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

/** 只保留第一行(设置里关掉"允许多行"时用)。首行是空白 ⇒ 空串,调用方据此当作"这次不补"。 */
export function toSingleLine(text) {
  if (typeof text !== 'string' || text === '') return '';
  const first = text.split('\n')[0];
  return first.trim() === '' ? '' : first;
}

/** 审计/归属:`attributionHeaders()` 是适配器契约要求的头,解不到就退回空对象并记账(见 stats.notes)。 */
export const FIM_PKG = 'dsh-code-server-app';

// ---------------------------------------------------------------- 纯函数(全部可单测)

/** 造信封正文。 */
export function encodeFimRequest(payload) {
  const clean = {
    prompt: typeof payload?.prompt === 'string' ? payload.prompt : '',
    suffix: typeof payload?.suffix === 'string' ? payload.suffix : '',
  };
  if (typeof payload?.language === 'string' && payload.language !== '') clean.language = payload.language;
  if (typeof payload?.path === 'string' && payload.path !== '') clean.path = payload.path;
  return FIM_ENVELOPE_PREFIX + JSON.stringify(clean);
}

/**
 * 解信封:不是信封、JSON 坏、字段类型不对 ⇒ null(调用方据此报 INVALID_REQUEST)。
 * 前缀不匹配时**不看**后面的内容,避免把普通对话误当作补全请求。
 */
export function decodeFimRequest(text) {
  if (typeof text !== 'string' || !text.startsWith(FIM_ENVELOPE_PREFIX)) return null;
  let parsed;
  try {
    parsed = JSON.parse(text.slice(FIM_ENVELOPE_PREFIX.length));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  if (typeof parsed.prompt !== 'string' || typeof parsed.suffix !== 'string') return null;
  return {
    prompt: parsed.prompt,
    suffix: parsed.suffix,
    language: typeof parsed.language === 'string' ? parsed.language : '',
    path: typeof parsed.path === 'string' ? parsed.path : '',
  };
}

/**
 * 从 `GenerateOptions.messages` 里找信封。
 *
 * 只看 text 块;第一条命中即返回(我们不接受"多条信封"这种用法 —— 一次调用一次补全)。
 * @returns {{prompt: string, suffix: string, language: string, path: string}|null}
 */
export function extractFimEnvelope(messages) {
  if (!Array.isArray(messages)) return null;
  for (const message of messages) {
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== 'text' || typeof block.text !== 'string') continue;
      const decoded = decodeFimRequest(block.text);
      if (decoded !== null) return decoded;
    }
  }
  return null;
}

/** 把文本裁到窗口内(`fromEnd=true` 表示保留靠近光标的那一端)。 */
export function trimWindow(text, { maxChars, maxLines, fromEnd }) {
  if (typeof text !== 'string' || text === '') return '';
  const chars = Number.isSafeInteger(maxChars) && maxChars > 0 ? maxChars : 0;
  const lines = Number.isSafeInteger(maxLines) && maxLines > 0 ? maxLines : 0;
  let out = text;
  if (lines > 0) {
    const split = out.split('\n');
    if (split.length > lines) out = (fromEnd ? split.slice(split.length - lines) : split.slice(0, lines)).join('\n');
  }
  if (chars > 0 && out.length > chars) out = fromEnd ? out.slice(out.length - chars) : out.slice(0, chars);
  return out;
}

/** 特殊/控制标记:`<｜…｜>` 与 `<|…|>` 两族(实测见过 DeepSeek 吐出 `<｜｜DSML｜｜ parameter>`)。 */
const CONTROL_TOKEN_RE = /<[/\\]?[｜|]+[^<>]*?[｜|]+\s*[a-z_-]*\s*>/gi;

/**
 * 清洗模型输出,使它**可以直接插在光标处**。
 *
 * 处理的四类脏(前两类实测见过,后两类零成本兜住):
 *   ① 控制标记(上面的正则);
 *   ② 代码围栏(```lang … ```)—— chat 路由上必现,原生 FIM 上未复现;
 *   ③ CRLF 归一;
 *   ④ 长度上限。
 * **不做**的事:不 trim 行首缩进(那是补全内容的一部分)、不猜"这段像不像代码"
 * (假阳性由编辑器侧的判据兜,见 extension 侧 `lib/fim-completion.js`)。
 */
export function cleanFimCompletion(text) {
  if (typeof text !== 'string' || text === '') return '';
  let out = text.replace(/\r\n?/g, '\n').replace(CONTROL_TOKEN_RE, '');
  const fenced = out.match(/^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/);
  if (fenced !== null) out = fenced[1];
  else out = out.replace(/^\s*```[^\n]*\n/, '').replace(/\n```\s*$/, '');
  if (out.length > FIM_MAX_OUTPUT_CHARS) out = out.slice(0, FIM_MAX_OUTPUT_CHARS);
  return out;
}

/**
 * provider usage → DSH 的互斥口径(见文件头)。
 * 缺字段按 0;`cacheRead` 不会超过 `prompt`;总数不自洽时按 `prompt + completion` 算。
 */
export function mapFimUsage(raw) {
  const num = (value) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
  const prompt = num(raw?.prompt_tokens);
  const completion = num(raw?.completion_tokens);
  const cacheRead = Math.min(num(raw?.prompt_cache_hit_tokens), prompt);
  const totalRaw = num(raw?.total_tokens);
  return {
    inputTokens: Math.max(0, prompt - cacheRead),
    outputTokens: completion,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: 0,
    totalTokens: totalRaw >= prompt + completion ? totalRaw : prompt + completion,
  };
}

/** 计数器(状态栏只有这一处可见;见文件头"计量会落在哪")。 */
export function createFimStats() {
  const state = {
    calls: 0,
    ok: 0,
    failed: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    lastMs: null,
    lastError: null,
    lastAt: null,
  };
  return {
    recordOk(usage, ms) {
      state.calls += 1;
      state.ok += 1;
      state.inputTokens += usage?.inputTokens ?? 0;
      state.outputTokens += usage?.outputTokens ?? 0;
      state.cacheReadTokens += usage?.cacheReadTokens ?? 0;
      state.totalTokens += usage?.totalTokens ?? 0;
      state.lastMs = Number.isFinite(ms) ? Math.round(ms) : null;
      state.lastError = null;
      state.lastAt = Date.now();
      return state;
    },
    recordFailure(reason, ms) {
      state.calls += 1;
      state.failed += 1;
      state.lastMs = Number.isFinite(ms) ? Math.round(ms) : null;
      state.lastError = typeof reason === 'string' ? reason : 'unknown';
      state.lastAt = Date.now();
      return state;
    },
    snapshot() {
      return { ...state };
    },
  };
}

/** 速率/并发闸(这条链路由击键触发,必须有)。 */
export function createFimBudget({ minIntervalMs = 120, maxInflight = 1, callsPerMinute = 60, now = () => Date.now() } = {}) {
  let inflight = 0;
  let lastAt = 0;
  /** 最近一分钟的调用时间戳(滑动窗口)。 */
  const recent = [];
  return {
    /** @returns {'ok'|'busy'|'too-fast'|'rate-limited'} */
    acquire() {
      if (inflight >= maxInflight) return 'busy';
      const t = now();
      if (lastAt !== 0 && t - lastAt < minIntervalMs) return 'too-fast';
      while (recent.length > 0 && t - recent[0] > 60000) recent.shift();
      if (recent.length >= callsPerMinute) return 'rate-limited';
      inflight += 1;
      lastAt = t;
      recent.push(t);
      return 'ok';
    },
    release() {
      inflight = Math.max(0, inflight - 1);
    },
    snapshot() {
      const t = now();
      return { inflight, callsLastMinute: recent.filter((at) => t - at <= 60000).length };
    },
  };
}

// ---------------------------------------------------------------- 线上取数

/**
 * 发一次 FIM 请求(非流式)。
 *
 * 为什么**不流式**:实测同一题 `stream:true` 首字 691–810ms、总 833–1045ms,而 `stream:false`
 * 整份只要 112–416ms —— 非流式反而更快,而且补全本来就是"一小段要一次到位"。
 * 为什么**不设 stop**:4/4 全部自然收尾(`finish=stop`),任何 stop 串都可能把合法的多行补全腰斩。
 *
 * @returns {Promise<{ok: true, text: string, usage: object, finish: string|null, ms: number}
 *                  | {ok: false, code: string, message: string, status?: number, ms: number}>}
 */
export async function callFimWire({
  fetchImpl,
  apiKey,
  baseUrl = FIM_BASE_URL,
  model = FIM_MODEL,
  payload,
  maxTokens = FIM_MAX_TOKENS,
  headers = {},
  signal,
  timeoutMs = FIM_TIMEOUT_MS,
}) {
  const started = Date.now();
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}`, ...headers },
      body: JSON.stringify({
        model,
        prompt: payload.prompt,
        suffix: payload.suffix,
        max_tokens: maxTokens,
        temperature: 0,
        stream: false,
      }),
      signal: combined,
    });
  } catch (error) {
    const ms = Date.now() - started;
    if (signal !== undefined && signal.aborted === true) return { ok: false, code: 'ABORTED', message: '补全请求被取消', ms };
    if (timeout.aborted === true) return { ok: false, code: 'TRANSPORT', message: `补全请求超时(${timeoutMs}ms)`, ms };
    return { ok: false, code: 'TRANSPORT', message: `补全请求失败:${error?.message ?? String(error)}`, ms };
  }
  const ms = Date.now() - started;
  if (response.ok !== true) {
    let detail = '';
    try {
      detail = (await response.text()).slice(0, 300);
    } catch {
      detail = '';
    }
    const code = response.status === 401 || response.status === 403 ? 'AUTH'
      : response.status === 429 ? 'RATE_LIMIT'
        : response.status >= 500 ? 'PROVIDER' : 'INVALID_REQUEST';
    return { ok: false, code, message: `补全端点 HTTP ${response.status}${detail === '' ? '' : `:${detail}`}`, status: response.status, ms };
  }
  let json;
  try {
    json = await response.json();
  } catch (error) {
    return { ok: false, code: 'PROVIDER', message: `补全响应不是 JSON:${error?.message ?? String(error)}`, ms };
  }
  const choice = Array.isArray(json?.choices) ? json.choices[0] : null;
  if (choice === null || typeof choice !== 'object') return { ok: false, code: 'PROVIDER', message: '补全响应缺少 choices', ms };
  return {
    ok: true,
    text: cleanFimCompletion(typeof choice.text === 'string' ? choice.text : ''),
    usage: mapFimUsage(json?.usage),
    finish: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
    ms,
  };
}

// ---------------------------------------------------------------- 适配器工厂

/** 解析基类与辅助(解析不到 = 这个 DSH 没有对应服务 ⇒ 调用方把 FIM 判为不可用)。 */
export async function loadFimBase() {
  const [Base, attribution, assertKey, createUserMessage] = await Promise.all([
    loadDshExport('@deepseek-ai/dsh-llm', 'LlmAdapter'),
    loadDshExport('@deepseek-ai/dsh-llm', 'attributionHeaders'),
    loadDshExport('@deepseek-ai/dsh-llm', 'assertUsableApiKey'),
    loadDshExport('@deepseek-ai/dsh-llm', 'createUserMessage'),
  ]);
  if (typeof Base !== 'function') return null;
  return {
    Base,
    attributionHeaders: typeof attribution === 'function' ? attribution : null,
    assertUsableApiKey: typeof assertKey === 'function' ? assertKey : null,
    createUserMessage: typeof createUserMessage === 'function' ? createUserMessage : null,
  };
}

/** `LlmError`(用于"请求非法"这类要响的错误;取不到就退化成普通 Error)。 */
async function loadLlmError() {
  const mod = await loadDshModule('@deepseek-ai/dsh-llm');
  return typeof mod?.LlmError === 'function' ? mod.LlmError : null;
}

/** 造一个终态 error/aborted chunk(契约:每条流都以一个 finish 收尾)。 */
function failureChunk(kind, code, message, status) {
  const failure = { code, message, ...(Number.isSafeInteger(status) ? { status } : {}) };
  return { type: 'finish', reason: kind === 'aborted' ? { kind: 'aborted', failure } : { kind: 'error', failure } };
}

/**
 * 造适配器类(`Base` 必须在运行时解析,所以类也是运行时造的)。
 *
 * @param {Function} Base `LlmAdapter` 基类
 * @param {{resolveApiKey: () => Promise<string>, fetchImpl?: Function, model?: string,
 *          baseUrl?: string, attributionHeaders?: Function|null, assertUsableApiKey?: Function|null,
 *          timeoutMs?: number, log?: (message: string) => void}} deps
 */
export function createFimAdapterClass(Base, deps) {
  const log = deps.log ?? (() => {});
  const model = deps.model ?? FIM_MODEL;
  const fetchImpl = deps.fetchImpl ?? ((...args) => fetch(...args));

  return class FimCompletionAdapter extends Base {
    providerInfo(provider) {
      return { id: provider, name: 'DSH FIM(实验性)' };
    }

    listModels(provider) {
      return Promise.resolve([{ provider, id: model, name: `DeepSeek FIM (${model})` }]);
    }

    resolveModel(provider, id) {
      return Promise.resolve({
        provider,
        id,
        name: `DeepSeek FIM (${id})`,
        description: '实验性:走 Completions API 的 FIM 补全,只由编辑器补全使用',
        inputModalities: ['text'],
        context: { contextWindow: FIM_CONTEXT_WINDOW },
        defaultMaxTokens: FIM_MAX_TOKENS,
      });
    }

    prepareCall(provider, id) {
      const resolved = {
        provider,
        id,
        name: `DeepSeek FIM (${id})`,
        context: { contextWindow: FIM_CONTEXT_WINDOW },
        defaultMaxTokens: FIM_MAX_TOKENS,
      };
      return Promise.resolve({ model: resolved, stream: (options) => this.stream(options) });
    }

    /**
     * 唯一必填的方法。**永不抛**:所有失败都以契约要求的终态 chunk 收尾,
     * 调用方(桥的 /complete 路由)因此只有一条取值路径。
     */
    async *stream(options) {
      const payload = extractFimEnvelope(options?.messages);
      if (payload === null) {
        log('收到不是信封的请求:拒绝(避免把普通对话当成补全)');
        yield failureChunk('error', 'INVALID_REQUEST', 'dshcs-fim 只接受 FIM 信封请求');
        return;
      }
      const prompt = trimWindow(payload.prompt, { maxChars: FIM_MAX_PREFIX_CHARS, maxLines: FIM_MAX_PREFIX_LINES, fromEnd: true });
      const suffix = trimWindow(payload.suffix, { maxChars: FIM_MAX_SUFFIX_CHARS, maxLines: FIM_MAX_SUFFIX_LINES, fromEnd: false });

      let apiKey;
      try {
        apiKey = await deps.resolveApiKey();
        if (deps.assertUsableApiKey !== null && deps.assertUsableApiKey !== undefined) {
          apiKey = deps.assertUsableApiKey(apiKey, FIM_PKG, FIM_CREDENTIAL_REF);
        }
      } catch (error) {
        yield failureChunk('error', 'MISSING_CREDENTIAL', error?.message ?? '缺少凭据');
        return;
      }

      let headers = {};
      try {
        if (typeof deps.attributionHeaders === 'function') headers = deps.attributionHeaders() ?? {};
      } catch {
        headers = {};
      }

      const wire = await callFimWire({
        fetchImpl,
        apiKey,
        baseUrl: deps.baseUrl ?? FIM_BASE_URL,
        model: options?.model ?? model,
        payload: { prompt, suffix },
        maxTokens: Number.isSafeInteger(options?.maxTokens) ? options.maxTokens : FIM_MAX_TOKENS,
        headers,
        signal: options?.signal,
        timeoutMs: deps.timeoutMs ?? FIM_TIMEOUT_MS,
      });

      if (wire.ok !== true) {
        yield failureChunk(wire.code === 'ABORTED' ? 'aborted' : 'error', wire.code, wire.message, wire.status);
        return;
      }

      // 块协议:block-start → text-delta → usage → block-end → finish(usage 必须先于 finish)。
      yield { type: 'block-start', index: 0, blockType: 'text' };
      if (wire.text !== '') yield { type: 'text-delta', index: 0, text: wire.text };
      yield { type: 'usage', usage: wire.usage };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: wire.text } };
      yield { type: 'finish', reason: { kind: wire.finish === 'length' ? 'max-tokens' : 'stop' } };
    }
  };
}

/**
 * 解析凭据(与官方适配器同一条路:`credentials.resolve` → 启动环境变量 → fail closed)。
 * @param {object} ctx cordis 上下文
 * @param {string} [ref]
 */
export function createApiKeyResolver(ctx, ref = FIM_CREDENTIAL_REF) {
  return async () => {
    let credentials = null;
    try {
      credentials = typeof ctx?.get === 'function' ? ctx.get('credentials') : null;
    } catch {
      credentials = null;
    }
    if (credentials !== null && credentials !== undefined && typeof credentials.resolve === 'function') {
      const hit = await credentials.resolve(ref);
      if (hit !== undefined && hit !== null && typeof hit.value === 'string' && hit.value !== '') return hit.value;
    }
    const ambient = process.env[ref];
    if (typeof ambient === 'string' && ambient.length > 0) return ambient;
    throw new Error(`没有可用的 ${ref}(请在 DSH 的模型设置里存一次凭据,或在启动环境里导出它)`);
  };
}
