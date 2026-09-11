/**
 * lib/asset-mirror.mjs —— 工作台资产镜像(阶段 2)。
 *
 * 目标:让 iframe 的文档也来自 `dsh-app://app`,这样工作台的全部子资源都在同一个源下,
 * 客户端就再也不碰 loopback 端口(阶段 1 只搬走了 WebSocket,阶段 2 搬资产)。
 *
 * 做法:桌面载体只把 `/api/*` 交给插件,而 Connection 的 exact Fetch route 不支持前缀匹配,
 * 所以在启动时**枚举 IDE 的 URL 空间**并为每个路径注册一条精确路由;每条路由把请求
 * (同路径 + 同查询串)转发给 IDE 自己的监听器,响应流式回传。
 *
 * 为什么可以"照抄 URL 路径":实测工作台不含任何 origin-root 绝对资源路径
 * (HTML 里全是 `./…`、`stable-<commit>/static/out/…`;`location.origin` 只用于同源校验
 * 与"开新窗口"),所以只要文档挂在 `<base>/index.html`、路径空间原样镜像,相对引用自然成立,
 * `_VSCODE_FILE_ROOT` 也会解析成镜像源下的绝对地址。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';

/** 镜像挂载点(客户端用它拼文档地址)。 */
export const ASSET_BASE = '/api/code-server/asset';
/** 文档路径:必须以文件名结尾(exact route 不接受空段),同时保证相对引用落在镜像根下。 */
export const ASSET_DOCUMENT = `${ASSET_BASE}/index.html`;

/** 单文件镜像:这些路径在 IDE 侧由 code-server 自己的静态处理/模板渲染提供。 */
const SINGLETONS = [
  '/manifest.json',
  '/favicon.ico',
  '/favicon.svg',
  '/robots.txt',
  '/vscode-remote-resource', // 扩展资源走这里(单路由 + path 查询),顺带避开非法文件名的路由限制
];

function walkFiles(root, prefix, out) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    const url = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) walkFiles(full, url, out);
    else if (entry.isFile()) out.add(url);
  }
}

/**
 * 枚举镜像需要注册的 URL 路径。
 * @param {string} tree - VS Code 树根(vsRoot():`<pkg>/vscode`)
 * @param {string} productPath - `stable-<commit>`
 * @returns {string[]} 形如 `/stable-xxx/static/out/vs/…` 的路径(不含镜像前缀)
 */
export function enumerateAssetPaths(tree, productPath) {
  const urls = new Set(SINGLETONS);
  const staticRoot = `/${productPath}/static`;
  walkFiles(path.join(tree, 'lib', 'vscode', 'out'), `${staticRoot}/out`, urls);
  walkFiles(path.join(tree, 'lib', 'vscode', 'extensions'), `${staticRoot}/extensions`, urls);
  // code-server 自己的浏览器资源(模板/favicon/媒体)走 /_static/**
  walkFiles(path.join(tree, 'src', 'browser'), '/_static/src/browser', urls);
  return [...urls].sort();
}

/** 精确路由路径是否合法(与 Connection 的 endpointFromPath 同规则)。 */
export function isRegistrable(pathname) {
  const rel = pathname.replace(/^\/+/, '');
  if (rel === '') return false;
  return rel.split('/').every((segment) => /^[A-Za-z0-9_$.-]+$/.test(segment));
}

/**
 * 建镜像。
 * @param {object} options
 * @param {() => ({kind:'loopback',port:number}|{kind:'pipe',pipe:string}|null)} options.getTarget
 * @param {string} options.tree - VS Code 树根
 * @param {string} options.productPath
 * @param {(message:string)=>void} [options.log]
 */
export function createAssetMirror({ getTarget, tree, productPath, log = () => {} }) {
  const all = enumerateAssetPaths(tree, productPath);
  const registrable = all.filter(isRegistrable);
  const skipped = all.filter((p) => !isRegistrable(p));
  const stats = { registered: 0, served: 0, failed: 0, bytes: 0, lastError: null, skipped: skipped.length };

  function connectionOptions(target) {
    if (target === null) return null;
    if (target.kind === 'pipe') return { socketPath: target.pipe, headers: { host: 'localhost' } };
    return { host: '127.0.0.1', port: target.port, headers: {} };
  }

  /** 把一条请求转发给 IDE 监听器,响应流式回传。 */
  async function forward(request, upstreamPath) {
    const options = connectionOptions(getTarget());
    if (options === null) {
      return new Response(JSON.stringify({ ok: false, error: 'code-server is not running' }), {
        status: 503,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    const incoming = new URL(request.url);
    const search = incoming.search ?? '';
    const upstream = await new Promise((resolve, reject) => {
      const req = httpRequest({
        method: request.method,
        path: `${upstreamPath}${search}`,
        ...options,
        headers: {
          ...options.headers,
          accept: request.headers.get('accept') ?? '*/*',
          'accept-encoding': request.headers.get('accept-encoding') ?? 'identity',
          ...(request.headers.get('range') === null ? {} : { range: request.headers.get('range') }),
        },
      }, (res) => resolve({ req, res }));
      req.on('error', reject);
      request.signal?.addEventListener('abort', () => req.destroy(new Error('client aborted')), { once: true });
      req.flushHeaders();
      if (request.body === null) req.end();
      else {
        const body = Readable.fromWeb(request.body);
        body.on('error', (error) => req.destroy(error));
        body.pipe(req);
      }
    });

    stats.served += 1;
    const { res } = upstream;
    const headers = {};
    for (const [name, value] of Object.entries(res.headers)) {
      if (value === undefined) continue;
      if (name === 'transfer-encoding' || name === 'connection') continue;
      headers[name] = Array.isArray(value) ? value.join(', ') : value;
    }
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of res) {
            stats.bytes += chunk.length;
            controller.enqueue(new Uint8Array(chunk));
          }
          controller.close();
        } catch (error) {
          stats.failed += 1;
          stats.lastError = error && error.message ? error.message : String(error);
          controller.error(error);
        }
      },
      cancel(reason) {
        res.destroy(reason instanceof Error ? reason : undefined);
      },
    });
    return new Response(stream, { status: res.statusCode ?? 502, headers });
  }

  /** 注册到 Connection 的共享 /api 通道。 */
  function register(connection) {
    const disposers = [];
    for (const urlPath of registrable) {
      const routePath = `${ASSET_BASE}${urlPath}`;
      disposers.push(connection.fetch.register({
        path: routePath,
        methods: ['GET', 'HEAD'],
        requestBody: 'buffered',
        fetch: (request) => forward(request, urlPath),
      }));
    }
    // 文档:镜像根下的 index.html → IDE 的 `/`(模板渲染 + launcher 的 HTML 改写)
    disposers.push(connection.fetch.register({
      path: ASSET_DOCUMENT,
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: (request) => forward(request, '/'),
    }));
    stats.registered = registrable.length + 1;
    log(`资产镜像:注册 ${stats.registered} 条路由(跳过 ${stats.skipped} 个非法文件名路径)`);
    return () => {
      for (const dispose of disposers) {
        try { Promise.resolve(dispose()).catch(() => {}); } catch { /* ignore */ }
      }
    };
  }

  let enabled = true;
  function snapshot() {
    // enabled 是 host 侧的模式/急停开关:客户端只在它非 false 时才把文档搬到镜像。
    // web(serve: dsh)有 webServer 同源挂载,既不需要也不应该走镜像。
    return { enabled, base: ASSET_BASE, document: ASSET_DOCUMENT, total: all.length, ...stats };
  }

  return {
    register,
    snapshot,
    base: ASSET_BASE,
    document: ASSET_DOCUMENT,
    /** 关闭镜像:快照 enabled=false 并释放已注册的路由。
     *  只在"组合里出现了 webServer"时调用(改用 dsh 同源挂载)——不是失败回退,镜像本身没有备用路径。 */
    disable(stopRoutes) {
      if (!enabled) return;
      enabled = false;
      try { stopRoutes?.(); } catch { /* ignore */ }
    },
  };
}
