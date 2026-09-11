# 方案 B:自建 VS Code 构建,桌面端零端口跑 IDE

> 目标读者:本插件维护者。写完于 2026-09-11,基于 code-server 4.136.2 / VS Code 1.136.1
> (`productPath=stable-8d5f383f301ca20681f5b6606b8207d9dc87bdd8`)与 DSH desktop 协议 v3。

## 0. 结论摘要

| 项 | 结论 |
|---|---|
| 可行性 | **可行**。VS Code 自带官方 seam `IWorkbenchConstructionOptions.webSocketFactory`,传输层本来就按载体可替换设计;桌面版 VS Code 自己就是把同一套协议跑在 MessagePort 上 |
| 客户端补丁面 | **1 行**(入口 IIFE 里给 options 加 `webSocketFactory`)。原以为要改 18.9 MB 的 minified bundle,实际是官方留的口子 |
| 服务端补丁面 | **0 行**。我们的 `lib/launcher.mjs` 本来就自己驱动 `handleRequest`/`handleUpgrade`,换成合成 req/res + 合成 socket 即可,不再监听端口 |
| 真正的工作量 | **资源层**:1283 个文件 / 196.8 MB 的 IDE 资产树要经 `/api/…` 精确路由送出去(桌面载体没有前缀/通配路由),加上 HTML 重写、worker/wasm 路径、缓存策略 |
| 主要风险 | 自定义 scheme 下 **Worker + wasm** 能否加载(存在性风险);`dsh-app://` 的**流式请求体**能否穿透(存在性风险);管道的**全局背压**会被 IDE 大流量拖慢 DSH 自身 API |
| 建议 | 先花 **0.5–1 天**跑 Phase 0 的三个门禁(§8)。三条全绿再投入;任一条红,回到 loopback 并把结论写进分析报告 |

## 1. 目标与非目标

**目标(硬指标)**

1. 桌面端 IDE 可用(工作台、扩展、终端、文件读写、搜索、SCM),且 **进程内不存在任何 TCP 监听**(`netstat` 验证,不是"只绑 127.0.0.1")。
2. 资源与 WebSocket 全部经 DSH 字节管道(`dsh-app://` → `/api/…`),不再需要 loopback 端口。
3. web profile 行为不变(继续 `serve: dsh` 挂 `webServer`);loopback 保留为兜底(老 DSH / 独立部署)。

**非目标**

- 不碰扩展宿主协议、不改 VS Code 的 IPC/Remote 语义(只换字节载体)。
- 不做 vscode.dev 形态(扩展跑 web worker + 浏览器内 FS 提供者):那会丢掉真磁盘/终端/原生扩展。
- 不改上游 DSH(hack 都在本插件与自建 VS Code 产物里)。

## 2. 关键事实(证据)

| # | 事实 | 证据 |
|---|---|---|
| F1 | 工作台客户端传输是官方可替换的 seam | 上游 `src/vs/platform/remote/browser/browserSocketFactory.ts`:`interface IWebSocketFactory { create(url, debugLabel): IWebSocket }`;`BrowserSocketFactory` 的构造参数就是它,`options.webSocketFactory` 为空时用默认实现 |
| F2 | 我们这份预编译包里这个 seam 存在且只有一处构造点 | `lib/vscode/out/vs/code/browser/workbench/workbench.js`:`nAr=new class{create(s,o){return new cuo(s,o)}}`(= 默认工厂 → `BrowserWebSocket`)、`ffi=class{constructor(o){this._webSocketFactory=o\|\|nAr}…}`(`BrowserSocketFactory`)、`new ffi(this.configuration.webSocketFactory)`;整包 `new WebSocket(` **1 处** |
| F3 | 入口把配置从 meta 标签读出来再调 `create`,注入点是一行 | 同包尾部 IIFE:`let e={...JSON.parse(o),remoteAuthority:location.host}` … `Npo(ct.document.body,{...e,…})` |
| F4 | `IWebSocket` 的确切接口(要实现的东西) | 上游同文件:`onData: Event<ArrayBuffer>` / `onOpen: Event<void>` / `onClose: Event<IWebSocketCloseEvent\|void>` / `onError: Event<unknown>` / `traceSocketEvent?` / `send(ArrayBuffer\|ArrayBufferView)` / `close()` |
| F5 | 上层拿到的是**裸协议字节**,`BrowserSocket` 只做 `onData → VSBuffer`、`write → socket.send(buffer.buffer)`、`drain() → resolved`(无背压) | 上游同文件的 `class BrowserSocket implements ISocket` |
| F6 | 服务端只有一处 upgrade 入口,且自带握手 | `lib/vscode/out/server-main.js`:`p.on("upgrade",async(h,v)=>…(await a()).handleUpgrade(h,v))`;包内 `Sec-WebSocket-Accept` 命中 1 次 |
| F7 | 我们自己就已经在驱动服务端 | 本仓库 `lib/launcher.mjs`(`createServer(null,args)` + `handleRequest`/`handleUpgrade`)、`lib/serve-dsh.mjs`(web 上注册 prefix 路由 + 精确 upgrade 路由,先 `connection.requestRejection`) |
| F8 | DSH 管道支持双向流式且有背压 | `apps/desktop-host/src/wire.ts`(帧:magic `0x44534833`、13 字节头、data 帧 ≤64 KiB、request start/data/end/cancel、response start/data/end/error);`apps/desktop-host/src/index.ts:335-341` 请求体以 `duplex:'half'` 流式交给路由,`:352-362` 响应按 64 KiB 分片写出 |
| F9 | 桌面载体对请求体不缓冲 | `apps/desktop/src/host-process.ts:165`:"Forward one `dsh-app://app` request to the child without buffering its body" |
| F10 | 插件的 HTTP 面只能落在精确 `/api/…` 路由上 | `packages/client/connection/src/rpc-host.ts:127-128`(`fetchRoutes.get(pathname)` 精确查表)、`:266-275` `endpointFromPath`、`:33` `ENDPOINT_SEGMENT_PATTERN=/^[A-Za-z0-9_$.-]+$/` |
| F11 | 路由请求体支持流式(无总量上限、带背压) | `packages/client/connection/src/rpc.ts:113` `'buffered' \| 'streaming'`;`:121-122` "streaming requests arrive with backpressure and no aggregate cap" |
| F12 | 桌面端没有 `webServer`,也没有任意路径服务 | `apps/desktop-host/src/index.ts:342-346`(仅 `/.dsh/remote-stream`、`/api/*`、前端 dist 三路);`apps/desktop/README.zh.md:204` |
| F13 | IDE 资产树规模 | `lib/vscode/{out,extensions}`:**1283 文件 / 196.8 MB**;最大单文件 `workbench.js` 18.0 MB、`workbench.web.main.internal.js` 18.0 MB、若干 wasm(如 `tree-sitter-c-sharp.wasm` 5.6 MB) |
| F14 | 只有 2 个文件名不满足路由段字符集 | `extensions/javascript/syntaxes/Regular Expressions (JavaScript).tmLanguage`(空格+括号)、`extensions/objective-c/syntaxes/objective-c++.tmLanguage.json`(`+`) |

## 3. 目标架构

```
renderer (dsh-app://app,DSH SPA origin)
├─ DSH 客户端插件:右侧栏 iframe,src = <资产路由>/…/workbench.html
│   └─ iframe 文档(我们重写的 HTML)
│       ├─ <script>globalThis.__DSH_WS_FACTORY__ = DshPipeWebSocketFactory</script>
│       ├─ _VSCODE_FILE_ROOT = dsh-app://app/api/code-server/asset/out/
│       └─ <script type=module src=…/asset/out/vs/code/browser/workbench/workbench.js>
│              ├─ fetch(…) 资源 → GET /api/code-server/asset/<镜像路径>
│              └─ WS → __DSH_WS_FACTORY__.create() → POST /api/code-server/tunnel(双向字节)
│
│  ← DSH 字节管道(FD3/FD4,64 KiB 帧,全局背压)→
│
DSH Host 进程(本插件)
├─ route POST /api/code-server/tunnel   requestBody:'streaming'  → 合成 Duplex socket ↔ 合成 upgrade 请求 → code-server.handleUpgrade
├─ route GET  /api/code-server/asset/<镜像路径> × 1283(启动时枚举注册)
└─ route GET  /api/code-server/remote-resource(单路由 + query,替代 /vscode-remote-resource)
│
└─ code-server 子进程(无监听端口)
    ├─ handleRequest(合成 IncomingMessage/ServerResponse)
    └─ handleUpgrade(合成 req + 合成 socket)
```

## 4. 传输层(tunnel)

### 4.1 路由

```
POST /api/code-server/tunnel?ws=<原始 ws URL 编码>&token=<每次启动随机>
  content-type: application/octet-stream
  requestBody: 'streaming'      # F11:带背压、无总量上限
  请求体  = 客户端 → 服务端 字节(RFC6455 帧,含握手)
  响应体  = 服务端 → 客户端 字节(同上)
```

一个 POST 同时承载两个方向:`wire.ts` 的 streamId 让请求帧与响应帧各自归属同一条流,响应可以边读边写(F8)。`cancel` 帧 → Host 侧 AbortSignal → 插件拆掉合成 socket → code-server 侧连接关闭。

### 4.2 客户端 shim(`IWebSocket`,逐字对应 F4)

```js
globalThis.__DSH_WS_FACTORY__ = {
  create(url, debugLabel) {
    // 1) fetch('/api/code-server/tunnel?ws=' + encodeURIComponent(url), {
    //      method:'POST', duplex:'half', body: clientStream, signal })
    // 2) 把 WritableStream 侧接给 send(),把 response.body 读出来喂 onData
    // 3) 自己实现 RFC6455 客户端侧:握手(一次性)+ 帧(掩码、ping/pong、close)
    return { onData, onOpen, onClose, onError, send, close };
  },
};
```

**为什么连 RFC6455 也自己实现**:让两端保持"真 WebSocket"语义不动 —— 服务端仍是 code-server 里那套 `ws`(握手、帧、permessage-deflate 全不动),客户端只是把"浏览器 WebSocket"换成"管道上的 WebSocket"。约 200 行,规范明确,可对着真实 `ws://` 逐字节对拍。URL 里的 `skipWebSocketFrames=false` 原样保留(F2 里浏览器也是这样传的)。

**备选(Phase 1 评估,不先做)**:插件侧用 Node `ws` 终止连接,隧道只走 payload 并把 query 改成 `skipWebSocketFrames=true`。代码更少,但依赖服务端帧层语义,先不赌。

### 4.3 服务端桥接(零监听)

- 启动 code-server 时不调用其 `listen()`(现有 `lib/launcher.mjs` 已经是这个形态):只保留 `handleRequest` / `handleUpgrade`。
- 资源请求:`new IncomingMessage(syntheticSocket)` + `new ServerResponse(req)`,把 `handleRequest` 的输出接回响应流;需要完整复刻 `method/url/headers`(尤其 `accept-encoding`、`range`、`if-none-match`)。
- Upgrade:tunnel 建立时构造合成 upgrade 请求(`url` 取自 `ws` 参数、`headers` 按需:`upgrade`、`connection`、`sec-websocket-key/version`、`origin`、`host`),再把隧道的一对 `Duplex` 交给 `handleUpgrade(req, socket, head)`。Origin/Host 由我们自己填 —— 顺带消掉了 loopback 方案里那套 Host/Origin 栅栏问题。
- 授权:隧道必须带 `token`(每次 IDE 启动随机,插件侧校验),避免同源页面之外的路径被复用;现有 `connection.requestRejection` 在桌面端没有 webServer 语义,不能替代这一步。

### 4.4 背压与流量(必须实测)

- `BrowserSocket.drain()` 返回 resolved(F5),即 VS Code 上层**不感知背压**;`send()` 会把字节塞进隧道。管道背压是**全局**的(F8 的 reader 全局暂停),IDE 一次大传输可能拖慢 DSH 自身 API。
- 缓解:① 隧道 WritableStream 设有限 `highWaterMark`,超过阈值直接关闭隧道(快速失败,而不是无限涨内存);② 关掉 IDE 侧大流量来源(遥测、marketplace 轮询、`workbench.editor` 预取);③ 必要时把两个方向拆成两条隧道,至少让其中一个方向独立;④ Phase 2 用真实工程(装 expansion 包 + 大文件搜索)量化 DSH UI 延迟。

## 5. 资源层(真正的工作量)

### 5.1 镜像树 + 一文件一路由

桌面端没有前缀路由(F10/F12),所以把 IDE 树按原样镜像到 `/api/code-server/asset/**`,**启动时枚举注册精确路由**:

- `/api/code-server/asset/out/…`(263 文件)、`/api/code-server/asset/extensions/…`(1020 文件):合计 1283 条,`Map` 级开销,注册耗时需实测(<100 ms 预期)。
- 路由路径段允许 `[A-Za-z0-9_$.-]`(F10),恰好覆盖 1281 个文件;剩下 2 个(F14)在 repack 阶段改名(`Regular Expressions (JavaScript).tmLanguage` → `regular-expressions-javascript.tmLanguage`、`objective-c++.tmLanguage.json` → `objective-cpp.tmLanguage.json`)并同步改对应 `extensions/*/package.json` 的语法贡献路径。
- **iframe 文档也走这条路由**:`src = <asset 路由>/out/vs/code/browser/workbench/workbench.html`。这样不用 `srcdoc`、不用 `<base>`,文档 URL 天生就在镜像树里,相对 `import()`、worker、`fetch` 全部自然解析。
- 缓存:所有资产响应带 `cache-control: immutable`(或 `no-cache` + ETag);`workbench.js` 18 MB 是首屏大头,靠 Electron 的 HTTP `Cache` + `codeCache`(privilege 已开)二次启动走缓存。首屏冷启动耗时要量化。

### 5.2 HTML 重写(服务端已模板化,不需要改 VS Code)

code-server 的 `out/vs/code/browser/workbench/workbench.html` 是 2.4 KB 的模板(`{{BASE}}` / `{{VS_BASE}}` / `{{WORKBENCH_WEB_BASE_URL}}` / `{{WORKBENCH_WEB_CONFIGURATION}}` / nonce)。插件在把它发给客户端前:

1. 把三处 base 占位替换成我们的资产路由前缀;`_VSCODE_FILE_ROOT` 指向 `…/asset/out/`。
2. 在入口脚本之前插入 shim 脚本(定义 `__DSH_WS_FACTORY__`,并可在此收敛 CSP/nonce)。
3. `WORKBENCH_WEB_CONFIGURATION` 里 `remoteAuthority` 会被入口覆写成 `location.host`(= `app`),对我们的 shim 无影响(URL 只用来取 query)。

### 5.3 特殊端点

| 端点 | 处理 |
|---|---|
| `/vscode-remote-resource?path=…`(服务端 bundle 里 3 处) | 单一路由 + query(**不**需要镜像),直接转给 code-server |
| webview pre(`extensions/**` 之外的 `vs/workbench/contrib/webview/browser/pre/**`) | 已在 `out/` 镜像树内;注意 webview 内部 `fake.html`/service worker 的相对路径假设 |
| worker + wasm(分词器 `oniguruma` 等) | **风险点**:`new Worker('dsh-app://app/api/code-server/asset/…')` 与 wasm 实例化在自定义 scheme 下是否被允许 → Phase 0 门禁 G2 |
| NLS(`nls.messages.js` 1.0 MB) | 在 `out/` 镜像树内 |
| codicon 字体、图标、主题 json | 同上 |

## 6. 服务端零监听改造(本插件)

改 `lib/launcher.mjs` + 新增 `lib/serve-dsh-pipe.mjs`:

1. 新增服务方式 `serve: pipe`(桌面端默认),不再 `listen()`。
2. `createTunnelBridge({ handleRequest, handleUpgrade, token })`:合成 req/res、合成 socket、生命周期与 `dispose`。
3. `lib/index.js`:`serve` 决策改为 `webServer 存在 → dsh;否则 pipe(桌面)/ loopback(兜底)`;`GET /api/code-server/status` 增加 `transport: 'pipe' | 'loopback' | 'dsh'`。
4. 资产路由注册器:`registerAssetRoutes(treeRoot, pluginCtx)` → 1283 条 + 2 个改名映射;在 IDE 启动时注册、停止时释放。

## 7. 客户端补丁:两条路线

### B1(选定路线)自建 VS Code 构建

产物替换现有的 `@jinsiyu/dshcs-vscode-server`(我们本来就在发布这个 repack 包,管线已有:`scripts/vendor-repacks.mjs`、`repack/`)。

1. 固定上游 commit(1.136.1)与 code-server 4.136.2 的 patch 集;
2. 我们的 patch 只有一处语义改动,加在 `src/vs/code/browser/workbench/workbench.ts` 的 options 字面量里:

```ts
create(document.body, {
  ...configuration,
  webSocketFactory: (globalThis as { __DSH_WS_FACTORY__?: IWebSocketFactory }).__DSH_WS_FACTORY__,
  ...
});
```

3. 顺带可做(可选、低风险):F14 两个文件改名 + manifest 路径、webview pre 的相对路径假设、去掉 PWA/service worker 注册(桌面端不需要)。
4. 构建产物:与现包同结构(`vscode/{lib,out,src}` + `VENDOR-TREE.json`),`productPath` 由 `product.json` 现算不变;发布为 `@jinsiyu/dshcs-vscode-server@4.136.2`(或 `+dsh.N` 后缀)。
5. CI 需要:源码 + 构建 toolchain(比现在纯 repack 重);每次跟版重跑 patch 并跑 §10 的回归。

### B2(过渡/对照)预编译包外科补丁

同一处改动以字节补丁落在那 18.9 MB bundle 的 IIFE 上(纯 ASCII,注意 esbuild 会把非 ASCII 转义):

```
remoteAuthority:location.host}  →  remoteAuthority:location.host,webSocketFactory:globalThis.__DSH_WS_FACTORY__}
```

加上一条"补丁命中数=1"的断言(命中 0 或 >1 直接失败),放进现有 repack 流程。**PoC(Phase 1–3)用 B2 提速,量产再切 B1** —— 两者产物对客户端完全等价。

## 8. 分阶段计划(含门禁与回滚)

| 阶段 | 内容 | 验收 | 回滚 | 估时 |
|---|---|---|---|---|
| **Phase 0 门禁** | G1 `dsh-app://` + `duplex:'half'` 流式请求体穿透 echo 测试(含背压观察);G2 自定义 scheme 下 `Worker` + wasm;G3 注入 `webSocketFactory`(B2 补丁)后,资产仍走 loopback、WS 走隧道,IDE 完整可用;G4 桌面载体上 `requestBody:'streaming'` 路由行为 | 三条全绿;任一条红 → 停,回 loopback,写结论 | 无(只读实验) | 0.5–1 天 |
| **Phase 1 传输** | tunnel 路由 + `DshPipeWebSocket`(RFC6455)+ 合成 upgrade bridge + token;资产仍 loopback | IDE 可用且 DevTools 里没有任何 `ws://` 连接;断隧道能干净报错重连;连续 30 min 无泄漏 | 关掉 `serve: pipe` 即回 loopback | 2–3 天 |
| **Phase 2 资源** | 镜像路由注册 + HTML 重写 + `_VSCODE_FILE_ROOT` + `/vscode-remote-resource` + 2 个改名 + 缓存头;含 G2 的 worker/wasm 兜底 | 全部资产走 `/api/…`;冷启动耗时与内存达标;扩展安装/终端/搜索/SCM 正常 | 资产切回 loopback | 4–6 天 |
| **Phase 3 零监听** | `createServer` 不再 `listen()`;合成 req/res;`netstat` 验证无端口;错误/重启/退出路径 | **无任何 TCP 监听** 且功能全绿 | 恢复 `listen()` | 2–3 天 |
| **Phase 4 量产** | 切 B1 自建构建;patch 清单 + 断言;CI 回归;版本跟版手册;README/分析报告更新 | 从源码可复现产出、与 B2 产物行为一致、回归全绿 | 回 B2 产物 | 3–5 天 |

合计约 **2–3 周**(单人、不含跟版维护)。若只做 B2 不做 B1,Phase 4 可压到 1–2 天。

## 9. 风险与缓解

| 风险 | 级别 | 缓解 / 决策点 |
|---|---|---|
| 自定义 scheme 下 `Worker`/wasm 被拒(tokenizer 等) | **高(存在性)** | G2 必须先测;兜底:blob worker + 内联 wasm,或把相关特性降级;都不行 → 方案失败 |
| `dsh-app://` 流式请求体不可用 | **高(存在性)** | G1;兜底:分块 POST(每 ≤64 KiB 一个请求)会显著增加延迟,只适合作为最后手段 |
| 管道全局背压拖慢 DSH UI | 中 | §4.4 四条缓解;Phase 2 量化 |
| 1283 路由注册的启动开销 / 内存 | 中 | 实测;必要时只注册首屏所需子集 + 首访惰性注册(需保留一份可增删的注册表) |
| 18 MB 首屏 bundle 的冷启动 | 中 | immutable 缓存 + Electron code cache;必要时拆分/预压缩 |
| CSP、service worker、`fake.html` 等相对路径假设 | 中 | HTML 由我们重写,nonce/政策自定;webview pre 单独回归 |
| 两个非法文件名 | 低 | repack 改名 + manifest 补丁(F14) |
| 跟版维护(上游 seam 变动) | 中高 | B1 源码 patch + CI 断言"补丁命中数=1";每次跟版跑回归 |
| 安全面(把 IDE 流量挂到 DSH API 通道) | 中 | 每次启动随机 token + 插件侧校验;不做跨会话复用 |

## 10. 测试计划

- **存在性门禁**:Phase 0 的 G1/G2,脚本留在 `.spike/`,结论写进分析报告。
- **传输单测**:RFC6455 客户端(掩码/分片/ping/close)对着 Node `ws` 逐条对拍;隧道双向 echo;取消与半关闭;token 错误必须 401/403。
- **集成**:无端口启动 → 工作台加载 → 打开文件 → 终端 → 扩展安装 → 大文件搜索(观察 DSH UI 延迟与内存)。
- **回归清单**(跟版必跑):资产路由数 = 树文件数;两个改名映射存在;HTML 占位全部替换;`netstat` 无监听;DevTools 无 `ws://`。
- **性能基线**:冷/热启动时间、首屏字节数、隧道吞吐、DSH UI 往返延迟(有/无 IDE 负载)。

## 11. 待确认项(Phase 0 产出)

1. `dsh-app://` 上 `fetch` + `ReadableStream` 请求体的真实行为(Chromium 版本相关)。
2. 自定义 scheme 下 `Worker` / `Wasm` / `blob:` 的可用性矩阵。
3. 我们这份树的 `skipWebSocketFrames` 语义(若决定走 §4.2 备选)。
4. 合成 `IncomingMessage`/`ServerResponse` 能否满足 code-server 的全部路由(尤其 range/压缩/静态)。
5. 1283 条路由的注册耗时与内存实测。

## 12. 与现状的关系

- 桌面端现状(loopback + iframe)是**已验证可用**的兜底;本方案落地前不改变默认行为。
- web profile 继续走 `serve: dsh`(挂 DSH `webServer`),零改动。
- 本方案不改 DSH;若上游将来在桌面载体提供 raw route/upgrade 席位(方案 A),本方案的 Phase 2/3 可直接删掉,只留 Phase 1 的元数据部分。
