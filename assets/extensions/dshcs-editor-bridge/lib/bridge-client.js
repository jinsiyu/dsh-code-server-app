// dshcs-editor-bridge / lib/bridge-client.js —— 纯逻辑:读配置、与 host 同步
//
// 这个文件**不 require('vscode')**,所以能在没有 VS Code 的环境里单测
// (scripts/test-bridge-extension.mjs 就是这么用的)。与编辑器交互的部分在
// lib/context-model.js(纯数据投影)与 extension.js(glue)里。
//
// 三条通道里属于扩展的两条:
//   1. 读 `<extensionsDir>/.dshcs-bridge/bridge.json` —— host 写,扩展**每次请求前重读**
//      (host 重启会让端口与令牌轮换,而 IDE 进程可能被 adopt 继续活着,env 方案跟不上);
//   2. `POST <BRIDGE_BASE>/sync?since=N` —— **一趟来回同时做两件事**:
//      把编辑器状态(活动文件/脏缓冲区/诊断)推给 host,并取回 host 推来的 agent 改动提示。
//      为什么合并:扩展宿主里没有 HTTP 服务器,host 反向请求不到它,状态只能由扩展推上来;
//      而轮询本来就在跑,合并成一个请求就省掉了第二个定时器与一次往返。
//      带着 x-dshcs-bridge-token 头。

'use strict';

const fs = require('fs');
const path = require('path');

/** 与 host 侧 lib/bridge.mjs 的常量保持一致(改动必须两边同步;scripts/test-bridge-extension.mjs
 *  里有一条一致性断言,会把两边的字面量放在一起比)。 */
const BRIDGE_DIRNAME = '.dshcs-bridge';
const BRIDGE_FILENAME = 'bridge.json';
/** 桥的挂载前缀。**故意不在 `/api` 下**:那层有 Connection 的 cookie fence,扩展宿主(Node 进程)
 *  拿不到浏览器 cookie,请求会在到达插件路由之前被 401(0.3.9 修正)。 */
const BRIDGE_BASE = '/code-server-bridge';
const TOKEN_HEADER = 'x-dshcs-bridge-token';
const STATE_FILENAME = 'extension-state.json';
const REQUEST_TIMEOUT_MS = 3000;
/** 轮询间隔:host 侧事件只是"去看一眼这个文件"的提示,600ms 足够且几乎无开销。 */
const POLL_INTERVAL_MS = 600;
/** 宿主配置重读间隔(令牌/端口轮换后最多这么久恢复)。 */
const CONFIG_REREAD_MS = 5000;


const TOKEN_RE = /^[0-9A-Za-z_-]{16,128}$/;

/** 桥配置所在目录(=`<extensionsDir>/.dshcs-bridge`)。
 *
 *  取值顺序(0.3.12 修正 —— 这里以前写错了,是"桥永远休眠"的另一半原因):
 *   1. **host 注入的 `DSHCS_EXTENSIONS_DIR`**(launcher 的 env 会被扩展宿主继承,与 dshcs-open-file
 *      用 `DSHCS_OPEN_FILE_SIGNAL` 是同一套做法)。0.3.12 起桥扩展装在**内置**目录(树里),
 *      与 <extensionsDir> 不再同级,只能靠 host 告诉它;
 *   2. 调用方显式给的 `extensionsDir`(测试用);
 *   3. 从本文件反推:`<extensionsDir>/dshcs-editor-bridge/lib/` 上溯两级。
 *      —— 注意 `extension.js` 曾自己算过一次,算成了三级(比 <extensionsDir> 还高一级),
 *      即使按老的用户级布局也读不到配置。计算只留在这里一处。
 */
function defaultExtensionsDir() {
  const fromEnv = process.env.DSHCS_EXTENSIONS_DIR;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv;
  return path.resolve(__dirname, '..', '..');
}

/** 桥配置路径;`extensionsDir` 可由调用方给(测试用),默认见 `defaultExtensionsDir`。 */
function bridgeFile(extensionsDir) {
  const dir = extensionsDir ?? defaultExtensionsDir();
  return path.join(dir, BRIDGE_DIRNAME, BRIDGE_FILENAME);
}

/** 扩展自己的小状态文件(since 游标),与桥配置同目录。 */
function stateFile(extensionsDir) {
  const dir = extensionsDir ?? defaultExtensionsDir();
  return path.join(dir, BRIDGE_DIRNAME, STATE_FILENAME);
}

/**
 * 读桥配置。
 * @returns {{url: string, token: string, pid: number|null}|null} null = 未配置/格式不对 → 休眠
 */
function readBridgeConfig(extensionsDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(bridgeFile(extensionsDir), 'utf8'));
    if (raw === null || typeof raw !== 'object') return null;
    if (typeof raw.url !== 'string' || !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(raw.url)) return null;
    if (!TOKEN_RE.test(String(raw.token))) return null;
    return { url: raw.url, token: String(raw.token), pid: Number.isSafeInteger(raw.pid) ? raw.pid : null };
  } catch {
    return null;
  }
}

/** 读回上次的轮询游标(实例没换才有意义)。 */
function readState(extensionsDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(extensionsDir), 'utf8'));
    if (raw === null || typeof raw !== 'object') return { since: 0, pid: null };
    return {
      since: Number.isSafeInteger(raw.since) && raw.since > 0 ? raw.since : 0,
      pid: Number.isSafeInteger(raw.pid) ? raw.pid : null,
    };
  } catch {
    return { since: 0, pid: null };
  }
}

/** 写回轮询游标(best-effort:写不进去只影响"重复收到一次提示",不影响正确性)。 */
function writeState(extensionsDir, state) {
  try {
    fs.mkdirSync(path.dirname(stateFile(extensionsDir)), { recursive: true });
    fs.writeFileSync(stateFile(extensionsDir), JSON.stringify(state), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** host 侧拒绝时的统一错误(带 status,便于区分 401/503/403)。 */
class BridgeError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'BridgeError';
    this.status = status;
  }
}

/**
 * 造一个桥客户端。
 *
 * @param {{extensionsDir?: string, fetchImpl?: Function, now?: Function}} [options]
 *        `fetchImpl` / `now` 可注入,便于单测(默认用 Node 18+ 的全局 fetch)。
 */
function createClient(options) {
  const extensionsDir = options && options.extensionsDir !== undefined ? options.extensionsDir : undefined;
  const fetchImpl = (options && options.fetchImpl) || ((...args) => fetch(...args));
  /** 当前配置(null = 休眠)。 */
  let config = null;
  /** 上次读配置的时间(避免每 600ms 都碰磁盘)。 */
  let configReadAt = 0;
  let since = (options && Number.isSafeInteger(options.since)) ? options.since : 0;

  /** 重读配置(必要时指定强制)。返回当前配置。 */
  function refreshConfig(force) {
    const now = (options && options.now ? options.now() : Date.now());
    if (!force && config !== null && now - configReadAt < CONFIG_REREAD_MS) return config;
    configReadAt = now;
    const next = readBridgeConfig(extensionsDir);
    if (next !== null && config !== null && next.url !== config.url) {
      // 端口/实例变了:游标失去意义(旧实例的事件不该在新实例上重放)。
      since = 0;
    }
    if (next !== null && config !== null && next.pid !== config.pid) since = 0;
    config = next;
    return config;
  }

  /** 一次带鉴权的请求;非 2xx 抛 BridgeError(带 status)。 */
  async function request(route, init) {
    const current = refreshConfig(true);
    if (current === null) throw new BridgeError('编辑器桥未配置(休眠中)', 0);
    const headers = Object.assign({ [TOKEN_HEADER]: current.token }, (init && init.headers) || {});
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetchImpl(current.url + route, Object.assign({}, init, { headers, signal: controller.signal }));
    } catch (error) {
      throw new BridgeError(`无法连接宿主:${error && error.message ? error.message : String(error)}`, 0);
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    let body = null;
    try {
      body = text === '' ? null : JSON.parse(text);
    } catch {
      body = null;
    }
    if (!response.ok) {
      const reason = body !== null && typeof body.error === 'string' ? body.error : `HTTP ${response.status}`;
      throw new BridgeError(reason, response.status);
    }
    return body;
  }

  return {
    /** 当前配置(null = 休眠)。 */
    get config() {
      return config;
    },
    /** 当前轮询游标。 */
    get cursor() {
      return since;
    },
    /** 是否处于休眠(未配置)。 */
    isDormant() {
      return refreshConfig(false) === null;
    },
    /** 强制重读配置(实例切换、状态栏刷新时用)。 */
    refresh() {
      return refreshConfig(true);
    },
    /** 轻量探活:host 端点是否可达(不碰编辑器)。 */
    async health() {
      return request(`${BRIDGE_BASE}/health`);
    },
    /**
     * **一趟来回:上报编辑器状态 + 取回待处理事件。**
     *
     * 上报失败/过期都不影响编辑器:失败只返回 `{ok:false}`,由调用方决定记日志还是静默。
     * 游标只在拿到事件后推进,所以丢一次响应大不了下次重放。
     *
     * @param {{context: object, diagnostics: object[]}} payload 由 context-model 投影出来的状态
     * @returns {Promise<{ok: boolean, events?: object[], error?: string, status?: number}>}
     */
    async sync(payload) {
      if (refreshConfig(false) === null) return { ok: false, error: 'dormant', status: 0 };
      try {
        const body = await request(`${BRIDGE_BASE}/sync?since=${since}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const events = body !== null && Array.isArray(body.events) ? body.events : [];
        for (const event of events) {
          if (Number.isSafeInteger(event.seq) && event.seq > since) since = event.seq;
        }
        return { ok: true, events };
      } catch (error) {
        return { ok: false, error: error.message, status: error.status };
      }
    },
    /** 把"选中内容 + 问题"投给 DSH 的当前会话。 */
    async ask(payload) {
      return request(`${BRIDGE_BASE}/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    },
    /** 把游标落盘(实例重启后不重复播报旧事件)。 */
    persist() {
      return writeState(extensionsDir, { since, pid: config === null ? null : config.pid });
    },
    /** 从磁盘恢复游标(实例没换才生效)。 */
    restore() {
      const saved = readState(extensionsDir);
      if (config !== null && saved.pid === config.pid) since = saved.since;
      else since = 0;
      return since;
    },
  };
}

module.exports = {
  BRIDGE_DIRNAME,
  BRIDGE_FILENAME,
  BRIDGE_BASE,
  TOKEN_HEADER,
  STATE_FILENAME,
  POLL_INTERVAL_MS,
  CONFIG_REREAD_MS,
  REQUEST_TIMEOUT_MS,
  BridgeError,
  defaultExtensionsDir,
  bridgeFile,
  stateFile,
  readBridgeConfig,
  readState,
  writeState,
  createClient,
};
