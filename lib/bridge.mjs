/**
 * lib/bridge.mjs — 「编辑器桥」的宿主侧基元(0.3.0)。
 *
 * 编辑器桥把树内扩展 `dshcs-editor-bridge` 与 DSH 连起来,让 agent 拿到只有编辑器才知道的
 * 信息(未保存缓冲区、诊断、活动选区),并让用户在编辑器里的动作反过来驱动 DSH。
 *
 * ## 三条通道(为什么是这三种机制)
 *
 * - **配置/凭据,host → 扩展**:`<extensionsDir>/.dshcs-bridge/bridge.json`(原子写)。
 *   host 重启会让端口与令牌轮换,而 IDE 进程可能被 adopt 继续活着 —— 扩展必须能"每次请求前重读",
 *   所以走文件而不是环境变量(env 在子进程启动那一刻就定死了)。令牌不进 argv(本机任意进程都能读
 *   命令行),与 `path-token` 同一决策。
 * - **扩展 → host:一个轮询里同时**上报编辑器状态、取回待处理事件**(`POST /bridge/sync`)。
 *   扩展宿主里**没有 HTTP 服务器**(Node 的扩展宿主只是 VS Code server 的一个子进程,
 *   不监听端口),所以 host **不能**反向请求它 —— 编辑器状态必须由扩展主动推上来。
 *   反过来 host → 扩展 也不用 SSE/WS:`ctx.connection.fetch.register` 的 methods 只允许
 *   `GET | HEAD | POST`,流式要另走已被 `dsh-api-gateway` 占用的 WS mux。
 *   于是轮询成了唯一干净的形态,而且它顺带给了两条性质:幂等(丢一次事件只是少一次提示,
 *   数据本身永远在编辑器里)、以及**状态天然是最新的**(每次轮询都刷新缓存)。
 * - **host → 扩展的"事件"**:同一个轮询的响应体(环形缓冲 + `since` 游标)。
 *   事件只是"去看一眼这个文件"的提示,不是数据。
 *
 * ## 认证(关键:桥绕开了 DSH 的 cookie fence,所以自带令牌)
 *
 * `/api/*` 的 Host/Origin/cookie 校验由 Connection 在分发前做
 * (`dsh-client-connection/lib/index.js`:`requestRejection` → 403 不可信 / 401 无 cookie)。
 * 扩展宿主是 Node 进程:`fetch` **不带 Origin**,Host 是 `127.0.0.1:<port>`(在 trustedHosts 内)
 * → 过 403;但它**拿不到浏览器 cookie** → 必然 401。所以桥路由必须自带独立令牌校验,
 * 且**不能**依赖 Connection 的认证。反过来,凭令牌就能调用,因此:
 *
 * ## 安全不变量(改这个文件之前先读这四条)
 *
 * 1. **`BRIDGE_BASE`(`/code-server-bridge`)命名空间永久只读。** 不允许出现任何写文件、改文档、执行命令、
 *    拉起进程的路由 —— `bridge.json` 里那个令牌对本机同用户进程可读,爆炸半径必须封在
 *    "泄露编辑器里的信息",绝不能变成任意文件写 / 任意命令执行。
 * 2. **带 `Origin` 的请求一律 403。** 浏览器发起的请求必带 Origin,扩展宿主进程不带。
 *    这条只排除浏览器,不误伤扩展(也顺带挡住 CSRF / DNS rebinding 这类"用你的浏览器打本机端口")。
 * 3. **路径收敛在编辑器当前工作区**(由扩展侧 `workspace.getWorkspaceFolder` 判定)。
 * 4. **有界。** 事件缓冲 64 条、请求/响应体上限见下方常量。
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** 桥端点目录名(位于 extensionsDir 下 —— 扩展必须能读到它)。 */
export const BRIDGE_DIRNAME = '.dshcs-bridge';

/** 桥配置文件名。 */
export const BRIDGE_FILENAME = 'bridge.json';

/** 桥路由前缀。
 *
 *  **故意不放在 `/api` 下(0.3.9 修正)**:Connection 给 `/api` 装了 Host/Origin/cookie fence
 *  (`packages/client/connection/src/index.ts`:`requestRejection` → 无 cookie 即 401),而桥的客户端是
 *  VS Code 扩展宿主里的一个 Node 进程 —— 它**永远拿不到浏览器 cookie**,请求在到达插件路由之前就被挡掉了。
 *  实测(0.3.7):扩展按 `/api/code-server/bridge/sync` 轮询,请求要么 405(打到 launcher/VS Code)、
 *  要么 401(打到 DSH 的 /api fence),桥从来没有真正同步过。
 *  现在挂到 DSH 自己的 webServer 前缀下,鉴权完全由桥自己的令牌承担(见下方安全不变量)。 */
export const BRIDGE_BASE = '/code-server-bridge';

/** 事件环形缓冲上限:超出即丢最旧的(事件是提示,不是数据)。 */
export const EVENT_RING_MAX = 64;

/** 请求/响应体上限(超出直接拒绝,避免一次把内存吃满)。 */
export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_UPSTREAM_BYTES = 256 * 1024;

/** 单次上游调用超时。 */
export const UPSTREAM_TIMEOUT_MS = 3000;

/** 令牌形状(与 `path-token` 同一字符集;VS Code 自己的 token 校验也接受)。 */
const TOKEN_RE = /^[0-9A-Za-z_-]{16,128}$/;

/** 令牌的名字:扩展读 bridge.json 拿它,host 用它命名请求头。**改这里必须同步扩展侧**
 *  (扩展是随包分发的静态文件,不做版本协商 —— 对齐靠两边同名常量 + 脚本测试里的一致性断言)。 */
export const BRIDGE_TOKEN_HEADER = 'x-dshcs-bridge-token';

/** 每次新启动 / 每次 adopt 都轮换的桥令牌(24 字节 → base64url 32 位)。 */
export function mintBridgeToken() {
  return randomBytes(24).toString('base64url');
}

/**
 * 由实际监听地址算桥的基址。
 * @param {string} host 绑定地址(仅回环)
 * @param {number} port 实际端口
 */
export function bridgeUrl(host, port) {
  const h = host === '::1' ? '[::1]' : host;
  return `http://${h}:${port}`;
}

/** 桥配置文件路径(`<extensionsDir>/.dshcs-bridge/bridge.json`)。 */
export function bridgeFile(extensionsDir) {
  return path.join(extensionsDir, BRIDGE_DIRNAME, BRIDGE_FILENAME);
}

/**
 * 原子写桥配置。扩展每 5s 重读一次;需要时(端口/令牌变化)由 host 重写。
 * @param {string} extensionsDir 扩展目录
 * @param {{url: string, token: string, pid: number|null, startedAt: number|null}} value
 */
export function writeBridgeConfig(extensionsDir, value) {
  const file = bridgeFile(extensionsDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = JSON.stringify({
    version: 1,
    url: value.url,
    token: value.token,
    pid: value.pid,
    startedAt: value.startedAt,
    writtenAt: Date.now(),
  }, null, 2);
  // 原子替换:扩展可能正好读到一半(Windows 上 rename 到已存在目标是覆盖语义)。
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return file;
}

/** 删除桥配置(停止 IDE / 插件卸载时调用)。 */
export function removeBridgeConfig(extensionsDir) {
  try {
    fs.rmSync(bridgeFile(extensionsDir), { force: true });
    return true;
  } catch {
    return false;
  }
}

/** 读回桥配置(诊断用;缺失或格式不对返回 null)。 */
export function readBridgeConfig(extensionsDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(bridgeFile(extensionsDir), 'utf8'));
    if (raw === null || typeof raw !== 'object') return null;
    if (typeof raw.url !== 'string' || !TOKEN_RE.test(String(raw.token))) return null;
    return raw;
  } catch {
    return null;
  }
}

/** 定长时间比较;长度不同直接 false(不泄露前缀信息)。 */
function tokenEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** 浏览器发起的请求必带 Origin;`null` 是沙箱 iframe / data: 页面的字面量取值,同样是浏览器。 */
function originIsBrowser(origin) {
  if (typeof origin !== 'string') return false;
  if (origin === '') return false; // 有些代理会写成空串 —— 当"没有 Origin"处理
  return true;
}

/**
 * 桥路由的准入检查。
 *
 * 返回 `null` = 放行;返回 `Response` = 直接回给调用方。
 * 顺序有意义:**先看 Origin**(浏览器一律拒绝,且不因为令牌碰巧对就放行 ——
 * 否则等于给浏览器一个"令牌对不对"的 oracle),再看令牌。两者都不消耗资源,故放在最前面。
 *
 * header 读取面:`request.dshcsRawHeaders`(DSH webServer 路由给的 Node 原始 headers)优先于
 * `request.headers` —— 因为 **undici 的 Request 构造器会把 `origin` 当 forbidden header 归一化掉**,
 * 由它包一层的请求读不到 Origin,那道 403 会静默失效(scripts/test-bridge-routes.mjs 里有实测记录)。
 *
 * @param {Request & {dshcsRawHeaders?: {get(name: string): string|null}}} request 桥路由收到的请求
 * @param {string|null} expectedToken 当前桥令牌(未启用时 null)
 */
export function bridgeGuard(request, expectedToken) {
  const headers = request?.dshcsRawHeaders ?? request.headers;
  // 不变量 2:浏览器发起必带 Origin(`null` 也算)。扩展宿主(Node)不带。
  const origin = headers.get('origin');
  if (originIsBrowser(origin)) {
    return new Response(JSON.stringify({ ok: false, error: 'bridge 不接受带 Origin 的请求(浏览器一律拒绝)' }), {
      status: 403,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  if (typeof expectedToken !== 'string' || expectedToken === '') {
    return new Response(JSON.stringify({ ok: false, error: '编辑器桥未启用' }), {
      status: 503,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  const provided = headers.get(BRIDGE_TOKEN_HEADER);
  if (!tokenEquals(provided ?? '', expectedToken)) {
    return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  return null;
}

/**
 * 调扩展侧 HTTP 面(仅回环)。
 *
 * 只发 GET/POST;**永远不带 Origin**(Node 默认行为),因此扩展侧同样能把浏览器挡在外面。
 * `signal` 来自宿主工具调用的 `exec.signal`,取消即中断。
 *
 * @param {{base: string, token: string}} target 桥目标(启用时由 host 维护)
 * @param {string} route 形如 `${BRIDGE_BASE}/context`
 * @param {{method?: 'GET'|'POST', body?: unknown, query?: Record<string, string>, signal?: AbortSignal}} [options]
 */
export async function callBridge(target, route, options = {}) {
  const method = options.method ?? 'GET';
  const url = new URL(route, target.base);
  if (options.query !== undefined) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
  }
  const headers = { 'x-dshcs-bridge-token': target.token, accept: 'application/json' };
  let body;
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers['content-type'] = 'application/json';
  }
  // 上游超时与调用方取消取先到者;AbortSignal.any 缺失时退化为仅上游超时(Node 24 有)。
  const timeout = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const signal = options.signal === undefined
    ? timeout
    : (typeof AbortSignal.any === 'function' ? AbortSignal.any([timeout, options.signal]) : timeout);
  const response = await fetch(url, { method, headers, body, signal });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`bridge ${route} → HTTP ${response.status}${text === '' ? '' : `: ${text.slice(0, 300)}`}`);
  }
  if (text.length > MAX_UPSTREAM_BYTES) throw new Error(`bridge ${route} 响应过大(${text.length} 字节)`);
  const parsed = text === '' ? null : JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object') throw new Error(`bridge ${route} 响应不是 JSON 对象`);
  if (parsed.ok === false) throw new Error(`bridge ${route}: ${parsed.error ?? '扩展未提供原因'}`);
  return parsed;
}

/**
 * 事件环形缓冲。host 侧唯一的事件源是 `ctx.on('tools/result')`。
 *
 * 语义:**不是可靠队列**。60/64 条只是让扩展在下一次轮询时"追上",超出即丢最旧的;
 * host 重启后 seq 归零,扩展用 `since=0` 重新对齐(不承诺断点续传)。
 */
export function createEventRing(max = EVENT_RING_MAX) {
  /** @type {{seq: number, kind: string, time: number}[]} */
  let items = [];
  let nextSeq = 1;
  return {
    /** 推入一条事件(有界:超出丢最旧)。 */
    push(kind, fields = {}) {
      const event = { seq: nextSeq, kind, time: Date.now(), ...fields };
      nextSeq += 1;
      items.push(event);
      if (items.length > max) items = items.slice(items.length - max);
      return event;
    },
    /** 取 `seq > since` 的事件(游标轮询);`since` 非法按 0 处理。 */
    since(seq) {
      const from = Number.isSafeInteger(seq) && seq > 0 ? seq : 0;
      return items.filter((e) => e.seq > from);
    },
    /** 最高已分配 seq(扩展用它判断是否有空洞 —— 空洞只意味着"漏了提示",不需要处理)。 */
    lastSeq() {
      return nextSeq - 1;
    },
    /** 当前缓冲条数(诊断用)。 */
    size() {
      return items.length;
    },
    /** 清空(IDE 进程换掉时调用)。 */
    reset() {
      items = [];
      nextSeq = 1;
    },
  };
}

/**
 * 校验桥请求体不超过上限(少数 route 需要;Connection 的 buffered 模式已有一层宽上限)。
 * @param {unknown} value 已解析的 JSON
 */
export function bodyWithinLimit(value) {
  try {
    return JSON.stringify(value ?? null).length <= MAX_BODY_BYTES;
  } catch {
    return false;
  }
}

/**
 * 造一个「编辑器状态缓存」。
 *
 * 为什么需要它:扩展宿主**没有 HTTP 服务器**,host 反向请求不到它。所以编辑器状态由扩展在
 * 每次轮询里推上来(见 `POST /bridge/sync`),这里缓存最近一份,agent 的工具调用来读它。
 *
 * 新鲜度:`/sync` 是 600ms 一次的轮询,所以缓存最多滞后一个轮询周期;缓存还带 `at`,
 * 工具输出里会带上这个时间戳,让模型能判断"这是不是刚刚的状态"。
 * 太久没更新(默认 10s)时标记 `stale` —— 比如用户在 IDE 里把面板关了、或扩展被禁用。
 */
export function createContextCache(staleAfterMs = 10000) {
  let snapshot = null;
  return {
    /** 扩展推上来的新状态(`{context, diagnostics}`)。 */
    update(value) {
      snapshot = {
        context: value !== null && typeof value.context === 'object' ? value.context : null,
        diagnostics: Array.isArray(value?.diagnostics) ? value.diagnostics : [],
        at: Date.now(),
      };
      return snapshot;
    },
    /** 当前缓存(null = 还没有扩展上报过)。 */
    get() {
      return snapshot;
    },
    /** 是否已超过 `staleAfterMs` 没更新。 */
    isStale() {
      return snapshot === null || Date.now() - snapshot.at > staleAfterMs;
    },
    /** 距上次更新的毫秒数(null = 从未上报)。 */
    ageMs() {
      return snapshot === null ? null : Date.now() - snapshot.at;
    },
    clear() {
      snapshot = null;
    },
  };
}

