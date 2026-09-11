又开始# 方案 B:自建 VS Code 构建,桌面端零端口跑 IDE

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

### 4.5 阶段 1 实测修订:为什么必须经父窗口中继(2026-09-11)

原计划让「工作台文档(loopback 源)直接 fetch `/api/code-server/tunnel`」。用一次性 Electron 实测后推翻:

| 方向 | 结果 |
|---|---|
| `dsh-app://` 文档 → `http://127.0.0.1:PORT` fetch(GET / streaming POST) | **Failed to fetch**(两侧都不行;POST 已带 `access-control-allow-origin: *`,所以不是 CORS 头的问题) |
| `http://127.0.0.1:PORT` 文档 → `dsh-app://` fetch(GET / streaming POST) | **Failed to fetch** |
| `dsh-app://` 文档 → `ws://127.0.0.1:PORT` | **可以连接**(101 成功;这解释了现状 loopback 方案为何能工作) |
| loopback 文档 → 同源 fetch / 同源 WS | 正常 |

结论:**自定义 scheme 与 loopback 之间只能靠导航(iframe/资源加载)与 WebSocket,不能 fetch**。因此阶段 1 的字节路径是:

```
工作台文档(loopback)              父窗口(DSH 前端,dsh-app://app)
  shim:RFC6455 客户端  ──postMessage(ArrayBuffer)──►  中继:fetch POST /api/code-server/tunnel
  (自己产出/解析帧)     ◄──postMessage(ArrayBuffer)──  (requestBody:'streaming',同源 ✓)
```

- 好处:token 只存在于父窗口,iframe 里没有凭据;而且**阶段 2 把文档搬到 `dsh-app://` 之后,同一套 shim 可以直连隧道**(中继退化为可选优化)。
- 代价:多两次 postMessage 跳转(同进程不同 frame,开销可忽略),以及需要在 `src/factory.js` 里装一个消息中继(`src/pipe-relay.js`)。
- 附带结论:loopback WS 仍然可用 —— 阶段 1 保留它作为回退,验收标准是"**隧道建立且 IDE 不再新开 `ws://` 连接**"。

## 5. 资源层(真正的工作量)

### 5.1 镜像树 + 一文件一路由

桌面端没有前缀路由(F10/F12),所以把 IDE 树按原样镜像到 `/api/code-server/asset/**`,**启动时枚举注册精确路由**:

- `/api/code-server/asset/out/…`(263 文件)、`/api/code-server/asset/extensions/…`(1020 文件):合计 1283 条,`Map` 级开销,注册耗时需实测(<100 ms 预期)。
- 路由路径段允许 `[A-Za-z0-9_$.-]`(F10),恰好覆盖 1281 个文件;剩下 2 个(F14)在 repack 阶段改名(`Regular Expressions (JavaScript).tmLanguage` → `regular-expressions-javascript.tmLanguage`、`objective-c++.tmLanguage.json` → `objective-cpp.tmLanguage.json`)并同步改对应 `extensions/*/package.json` 的语法贡献路径。
- **iframe 文档也走这条路由**:`src = <asset 路由>/out/vs/code/browser/workbench/workbench.html`。这样不用 `srcdoc`、不用 `<base>`,文档 URL 天生就在镜像树里,相对 `import()`、worker、`fetch` 全部自然解析。
- 缓存:**自定义 scheme 下没有任何缓存可用**(Phase 0 实测,§8.1):三次 fetch 三次都打到 handler,`CacheStorage` 直接报 `Request scheme 'dshtest' is unsupported`,service worker 不可注册。因此
  1. 不要指望 `cache-control`/ETag —— 每次渲染器加载都会重新取一遍资产;
  2. 必须**预压缩**:把 `.gz`(或 brotli)变体与 `content-encoding` 一起发,`workbench.js` 18 MB → 约 5 MB;
  3. 首屏只加载工作台实际请求的子集,冷启动字节数与耗时必须实测(§10 性能基线)。

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
| worker + wasm(分词器 `oniguruma` 等) | Phase 0 已实测**全部可用**:经典 worker / module worker(worker 内再 `import './mod.js'` 也通)/ blob worker / `WebAssembly.instantiateStreaming` |
| service worker / PWA | Phase 0 实测**不可注册**(`The URL protocol of the current origin is not supported`)。需确认工作台不依赖它:code-server 的 offline/PWA 部分(`vscode/out/browser/serviceWorker.js`)在桌面端必须禁用 |
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
| **Phase 0 门禁** | G1 `dsh-app://` + `duplex:'half'` 流式请求体穿透 echo 测试(含背压观察);G2 自定义 scheme 下 `Worker` + wasm;G3 注入 `webSocketFactory`(B2 补丁)后,资产仍走 loopback、WS 走隧道,IDE 完整可用;G4 桌面载体上 `requestBody:'streaming'` 路由行为 | 三条全绿;任一条红 → 停,回 loopback,写结论 | 无(只读实验) | 0.5–1 天 ✅ 见 §8.1 |
| **Phase 1 传输** | tunnel 路由 + `DshPipeWebSocket`(RFC6455)+ 合成 upgrade bridge + token;资产仍 loopback | IDE 可用且 DevTools 里没有任何 `ws://` 连接;断隧道能干净报错重连;连续 30 min 无泄漏 | 关掉 `serve: pipe` 即回 loopback | 2–3 天 |
| **Phase 2 资源** | 镜像路由注册 + HTML 重写 + `_VSCODE_FILE_ROOT` + `/vscode-remote-resource` + 2 个改名 + 缓存头;含 G2 的 worker/wasm 兜底 | 全部资产走 `/api/…`;冷启动耗时与内存达标;扩展安装/终端/搜索/SCM 正常 | 资产切回 loopback | 4–6 天 |
| **Phase 3 零监听** | `createServer` 不再 `listen()`;合成 req/res;`netstat` 验证无端口;错误/重启/退出路径 | **无任何 TCP 监听** 且功能全绿 | 恢复 `listen()` | 2–3 天 |
| **Phase 4 量产** | 切 B1 自建构建;patch 清单 + 断言;CI 回归;版本跟版手册;README/分析报告更新 | 从源码可复现产出、与 B2 产物行为一致、回归全绿 | 回 B2 产物 | 3–5 天 |

合计约 **2–3 周**(单人、不含跟版维护)。若只做 B2 不做 B1,Phase 4 可压到 1–2 天。

### 8.1 Phase 0 结果(2026-09-11,已跑完)

**方法**:用应用自带的 Electron 二进制拼一个一次性 Electron(把 `DeepSeek Harness.exe` + 依赖 DLL/pak 复制到 `.spike/phase0/electron/`,把我们自己的 harness 放成 `resources/app/`),以完全相同的 scheme 权限(`standard/secure/supportFetchAPI/corsEnabled:false/stream/codeCache`)注册 `dshtest://` 并在真实渲染进程里跑用例。跑法见 §8.2。环境:`Chrome/152.0.7977.54 Electron/44.0.0`。

| 用例 | 结果 | 关键数据 |
|---|---|---|
| G1 流式请求体(`duplex:'half'`) | ✅ | 三片分别在 **2 / 47 / 94 ms** 到达 handler(间隔 40 ms),真流式、未被缓冲;响应方向 2 / 71 / 136 ms 同样逐片 |
| G1 省略 `duplex` | ✅ 如期报错 | `The 'duplex' member must be specified for a request with a streaming body` |
| G1 8 MiB 上传 | ✅ | **172 ms** 完成,8388608 B 全到,共 **128 个分片 = 正好 64 KiB/片**,与 DSH 管道 `DESKTOP_PIPE_CHUNK_BYTES` 同粒度 |
| G2 经典 worker | ✅ | 自定义 scheme 下可创建并可通信 |
| G2 module worker | ✅ | worker 内再 `import './mod.js'` **也通**(返回 42) |
| G2 blob worker / blob 模块 import | ✅ | 兜底路径可用 |
| G2 动态 `import()` | ✅ | `import.meta.url` = scheme URL |
| G2 wasm | ✅ | `instantiate(bytes)` 与 `instantiateStreaming(fetch(...))`(MIME `application/wasm`)都通过 |
| G2 service worker | ❌ | `The URL protocol of the current origin ('dshtest://app') is not supported` |
| 存储:localStorage / sessionStorage / indexedDB | ✅ | indexedDB 建库建表写读全通 |
| 存储:CacheStorage | ❌ | `Cache.put` 报 `Request scheme 'dshtest' is unsupported` |
| 存储:cookie | ⚠️ | 写入后 `document.cookie` 仍为空 |
| 其它 | ✅ | `isSecureContext=true`、`crypto.subtle` 可用、`navigator.storage.estimate` 配额约 30 GB |
| 协议级 HTTP 缓存 | ❌ | 同一 URL 连取三次,**三次都打到 handler**(`cache-control: max-age=600` 无效) |

**结论:GO**,带两条设计修正:

1. **G1/G2 两条存在性风险全部排除** —— 流式双向 + worker/wasm 在自定义 scheme 下都成立,方案 B 的传输层与资源层在平台侧没有拦路虎。
2. **缓存必须自己扛**(新发现,原计划假设错误):自定义 scheme 下 HTTP 缓存、CacheStorage、service worker 三样都没有,冷启动每次都要重新取资产 → §5.1 改为预压缩 + 只取首屏子集,并把冷启动字节/耗时列入 Phase 2 验收。
3. **工作台不得依赖 service worker**(code-server 的 PWA/offline 路径要在我们重写的 HTML/补丁里禁用)。
4. G4(桌面载体 `requestBody:'streaming'`)按静态证据先判为通过:`apps/desktop-host/src/index.ts:335-341` 在请求体存在时以 `duplex:'half'` 构造真实 `Request`,`apps/desktop/src/host-process.ts:165` 明确"不缓冲转发请求体";G1 已证明渲染器→main 这半段是流式的。**端到端确认并入 Phase 1 的 tunnel 首次联调**。
5. G3(注入 `webSocketFactory` 后 IDE 完整可用)本质上是 Phase 1 的第一个里程碑(需要 B2 补丁 + shim + 桥接),不单独做。

### 8.2 复现方式

```powershell
# 1. 拼一次性 Electron(约 365 MB,读应用产物、写本仓库 .spike/,不碰用户在用安装)
#    复制 <win-arm64-unpacked>\* 与 locales\ 到 .spike\phase0\electron\,exe 改名 electron.exe
#    把 .spike\phase0\{package.json,main.cjs,probe.html,probe.js,worker*.js,mod.js,sw.js} 放进 electron\resources\app\
# 2. 跑(必须在非受限沙箱下:Chromium 的 mojo 平台通道需要命名管道)
.\.spike\phase0\electron\electron.exe --user-data-dir=.\.spike\phase0\userdata
# 3. 报告:electron\resources\app\report.json(harness.log 是主进程侧日志)
```

> 注意:直接对应用自带的 exe 传 app 路径**不会**生效(打包产物仍加载自己的 `resources/app.asar`),所以必须走复制;受限沙箱下 Electron 起不来(`platform_channel.cc: Check failed: 拒绝访问`),要 `danger-full-access`。



## 9. 风险与缓解

| 风险 | 级别 | 缓解 / 决策点 |
|---|---|---|
| ~~自定义 scheme 下 `Worker`/wasm 被拒~~ | **已排除** | Phase 0 G2 全绿(§8.1):经典 / module / blob worker、worker 内模块解析、wasm 两种实例化全通过 |
| ~~`dsh-app://` 流式请求体不可用~~ | **已排除** | Phase 0 G1 全绿(§8.1):40 ms 间隔的片逐片到达 handler,8 MiB 上传 172 ms,分片正好 64 KiB |
| **没有任何缓存**(协议级 HTTP 缓存 / CacheStorage / SW 三样都不可用) | 中高 | §5.1:预压缩(18 MB → ~5 MB)+ 只取首屏子集;冷启动字节与耗时进 Phase 2 验收 |
| 管道全局背压拖慢 DSH UI | 中 | §4.4 四条缓解;Phase 2 量化 |
| 1283 路由注册的启动开销 / 内存 | 中 | 实测;必要时只注册首屏所需子集 + 首访惰性注册(需保留一份可增删的注册表) |
| 18 MB 首屏 bundle 的冷启动(且每次都重取) | 中 | 预压缩 + 拆首屏子集 + 实测;不能再假设缓存兜底 |
| CSP、webview `fake.html` 等相对路径假设 | 中 | HTML 由我们重写,nonce/政策自定;webview pre 单独回归(service worker 已在 §8.1 判定不可用,直接禁用) |
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

## 13. Phase 1 实况与最终传输设计(2026-09-11)

### 13.1 最终形态

```
工作台文档(loopback)            父窗口(DSH 前端)              DSH host                    launcher 子进程
 src/pipe-ws.js ──postMessage──▶ src/pipe-relay.js ──同源 POST──▶ /api/code-server/tunnel ──▶ 连 IDE 自己的监听器
 (裸字节客户端)    ArrayBuffer     (双向流)         streaming    lib/pipe-tunnel.mjs         (写等价 upgrade 请求后双向搬字节)
                                                                                                │
                                                                                      VS Code 自己的 http/ws 服务端
                                                                                      (真 TCP socket → 句柄可交给扩展宿主)
```

- **客户端不依赖任何端口**:它只把字节 `postMessage` 给父窗口(DSH 前端),父窗口走同源 `/api` 隧道。
- **服务端零改造**:监听、accept、WS 握手、扩展宿主句柄传递全部由 VS Code 自己做;我们只把 upgrade 请求写进上游连接。
- **客户端只有两处改动**:`webSocketFactory` 注入(工作台 bundle 1 行)+ 裸字节 shim(约 200 行)。
- **必须强制 `skipWebSocketFrames=true`**:该标志下服务端把连接当纯字节流(与 Electron 的 MessagePort 传输同形);设 false 它会套一层 deflate 帧,裸客户端解析不了。

### 13.2 Windows 句柄约束(为什么"进程内零监听"做不到)

VS Code 用 IPC `child.send(msg, handle)` 把连接句柄交给扩展宿主进程,而 Windows 上**只有 TCP socket 句柄可发**:

| 交给 handleUpgrade 的"socket" | 结果 |
|---|---|
| 自造 `Duplex` | `ERR_INVALID_HANDLE_TYPE: This handle type cannot be sent` |
| 命名管道真实 socket | `write ENOTSUP`(uv_write2 不支持管道句柄) |
| **监听器 accept 的 TCP socket** | ✓ 正常(原生 loopback 形态) |

三者失败时的现象都是"**扩展远程主机在过去 5 分钟内意外终止**"、所有扩展不激活(内置 `dshcs-open-file` 因此不消费信号文件 → 点击文件不跳转)。结论:**launcher 保留一个仅本机的监听**作为 VS Code 的工作 socket,客户端仍然看不见它;§8 Phase 3 的"彻底不 listen()"在本平台不可达,已作废。

### 13.3 阶段 1 踩过的 8 个坑(全部有回归资产)

| # | 症状 | 根因 |
|---|---|---|
| 1 | 桌面端 `pnpm clean` 后 shell 全挂 | 删掉了 host 自己解析沙箱 runner/tsx 的那棵 profile 树 |
| 2 | 能启动但白屏 | `http.ClientRequest` 只在首次 write/end 才发 header,而请求体要等 101 → 死锁(**flushHeaders**) |
| 3 | 同上 | 合成 upgrade 缺 `req.ws` / `req.head`(loopback 路径有) |
| 4 | 连接秒断、无限重连 | `skipWebSocketFrames=false` 让服务端套帧层,裸客户端解析不了 |
| 5 | 101 出去后服务端一言不发 | 合成 socket 少了 `pause()`/`resume()`(入方向永不被读) |
| 6 | 同上 | `_write` 等自身 `'drain'` = 自锁(应等下游) |
| 7 | 扩展宿主终止(ERR_INVALID_HANDLE_TYPE) | 自造 Duplex 没有真实句柄 |
| 8 | 扩展宿主终止(ENOTSUP) | 命名管道句柄在 Windows 上不可 IPC 传递 |

回归资产:`scripts/test-pipe-tunnel.mjs`(host 转发 6 例,含防死锁)、`scripts/test-pipe-ws.mjs`(shim 11 例)、`scripts/repro-tunnel.mjs`(**本地端到端复现**:真 launcher + 真 VS Code 树 + 真 shim,不需要桌面应用/重启;`DSHCS_REPRO_PLUGIN=<工作区>` 可直接跑工作区副本)。

### 13.4 方向决定:B(客户端零端口)

在 A(全放权,客户端直连 loopback)/ B(接管客户端传输)/ C(两者都留)之间,用户选 **B**:继续只做管道方案,不引入客户端侧端口依赖。随之的收敛项(都是减法,待做):

1. **补丁从"改磁盘文件"改为"serve 时改写"**:launcher 已在改写工作台 HTML,同样可在返回 `workbench.js` 时做那 1 行注入(带"命中数=1"断言)。不再动 pnpm 硬链接的树、不需要每 profile 打补丁、VS Code 升级只影响一个函数。
2. shim / 隧道**只在管道方案里存在**,不参与 `serve: dsh`(web)路径。
3. Phase 2(资产镜像 + 一文件一路由)继续:让工作台文档也来自 `dsh-app://`,那时隧道可同源 fetch,父窗口中继退化为可选优化。

## 14. Phase 2 结果(2026-09-11):客户端文档与子资源都搬到 dsh-app://

### 14.1 实现

- `lib/asset-mirror.mjs`:启动时枚举 IDE 的 URL 空间(out/** 与 extensions/** → `/<productPath>/static/**`,
  code-server 浏览器资源 → `/_static/**`,外加 `/vscode-remote-resource`、`/manifest.json` 等单点),
  为每个**合法**路径注册一条精确路由(GET/HEAD),把同路径 + 同查询串转发给 IDE 自己的监听器,
  响应流式回传;文档路由 `/api/code-server/asset/index.html` 映射到上游 `/`(继续吃 launcher 的 HTML 改写)。
  真实树:**1297 枚举 / 1295 可注册 / 2 非法**(两个带空格与加号的语法文件名,它们走
  `/vscode-remote-resource` 查询端点,不受影响)。注册耗时 **1–3 ms**(实测)。
- `src/factory.js`:`buildPageUrl` 优先用 `assetMirror.document`(需 `enabled !== false` 且 `registered > 0`),
  否则回退 `status.url`(loopback)——镜像失效时行为与 0.2.x 完全一致。

### 14.2 关键侦察结论(省掉了全部引用重写)

工作台**不含任何 origin-root 绝对资源路径**:HTML 里全是 `./…`、`stable-<commit>/static/out/…`;
`location.origin` 只用于同源校验与"开新窗口"。所以只要文档挂在 `<base>/index.html`、URL 空间原样镜像,
相对引用自然成立,`_VSCODE_FILE_ROOT` 也解析到镜像源下。

### 14.3 实测证据(2026-09-11 14:18)

| 证据 | 含义 |
|---|---|
| `/healthz`:`shimInjections: 1` | **serve 时注入在生产里真的生效**(磁盘 bundle 保持原版) |
| `/healthz`:`recentUpgrades` 由 `/api/code-server/asset/index.html/stable-…` 变为 `/stable-…` | 文档确实来自镜像(WS 路径由 `location.pathname` 派生),剥前缀修复生效 |
| `tunnel.log`:`out#9 n=1517 head=01000000` | 隧道在跑真实协议消息(0x01 常规消息) |
| `page-errors.log`:空 | 镜像源下页面无 JS 错误 |
| 用户确认 | IDE 正常可用(文件树/编辑器/终端/扩展) |

### 14.4 两个坑(已修,commit 68d9bef)

1. **错误页粘住**:IDE 未就绪时镜像返回 503 JSON,而它是**文档内容**;此后 URL 不变 →
   `setSurfaceSrc` 判定同址不导航 → JSON 一直挂在 iframe 上。修:URL 加实例标记 `?s=<pid|startedAt>`,
   IDE 就绪/重启后 URL 变化即自动重导航(顺带让"IDE 崩溃后 iframe 自动重载"成立)。
2. **WS 路径被塞镜像前缀**:工作台用 `location.pathname + '/' + productPath` 拼 WS 地址 →
   `/api/code-server/asset/index.html/stable-…`。修:launcher 转发前剥掉镜像前缀。

### 14.5 现状与待办

- **客户端**:文档 + 全部子资源来自 `dsh-app://app/api/code-server/asset/**`,WebSocket 走 DSH 隧道
  → 客户端**不再触碰 loopback 端口**(阶段 2 目标达成)。
- **服务端**:仍保留仅本机监听(Windows 句柄约束,见 §13.2),客户端不可见。
- 待办:①镜像目前对 web(`serve: dsh`)也会注册路由,应收敛为只在 loopback 模式启用,避免动到
  web 侧既有行为;②发布 0.3.0 到 `next`(阶段 1+2 已是实打实的功能版本)。

## 15. Phase 3 侦察(2026-09-11):服务端也能不占 TCP 端口 —— 上游自带的命名管道路径

§13.2 的结论是"Windows 上必须存在监听器,因为 VS Code 把 accept 出来的**真 TCP socket 句柄**交给
扩展宿主"。现在的问题变成:这个监听器**是否可以不是 TCP**。答案是上游自己给了开关。

### 15.1 上游源码证据(vendored 树 `out/server-main.js` + `out/vs/workbench/api/node/extensionHostProcess.js`)

- 交接点:`_sendSocketToExtensionHost` → `extensionHostProcess.send(msg, socket)`,socket 从包装类
  剥两层取真 `net.Socket`(Windows 上 `child.send` 只认真 socket 句柄 —— 这正是 §13.2 的根因)。
- **Windows 特例**:`this._canSendSocket = !isWindows || !this._environmentService.args['socket-path']`。
  即 Windows 上一旦给了 `--socket-path`,服务端就**不传句柄**,改为 `_listenOnPipe()` 自建一个内部命名
  管道、把管道名写进扩展宿主 env,扩展宿主连进来后由 `_pipeSockets()` 双向泵字节。
- 监听端本身也支持管道:`p.listen(r['socket-path'] ? { path } : { host, port })`。
- 扩展宿主侧 `readExtHostConnection()` 三个分支:`type 3` = Electron **MessagePort**(桌面版路径)、
  `type 2` = 等 `VSCODE_EXTHOST_IPC_SOCKET` 句柄(会打 `[reconnection-grace-time] … read …` 日志)、
  其余 = `createConnection(pipeName)` 连管道并用裸 socket 包装(`extHost-renderer`)。
- **与 VSCodium 无关**:`get_repo.sh` 直接 `git fetch Microsoft/vscode`,86 个补丁里触碰 remote/server 的
  只有客户端校验开关(`00-remote-disable-client-validation.patch`,只加一个 boolean)、依赖、产品 URL、
  `reh` 打包;没有一个改传输层 → 换 VSCodium 不会让端口消失。

### 15.2 实现(`lib/launcher.mjs`)

新增 `--exthost-ipc <path>`:仅把该值塞进 `codeArgs['socket-path']` 以**翻转上面那个开关**(不真的监听它);
`/healthz` 增加 `exthost: socket|pipe` 与 `listen`。launcher 早在 `serve: dsh` 模式就支持 `--pipe <name>`
监听管道,host 侧 `lib/asset-mirror.mjs` / `lib/pipe-tunnel.mjs` 也早已实现 `{ kind: 'pipe' }` 目标 —— 
整条链路不缺组件,缺的只是"让扩展宿主也能走管道"这一下。

### 15.3 验证矩阵(`.spike/pipe-ipc/probe.mjs`:真树 + 真 shim + 真隧道 + 真控制帧握手)

探针自己实现 `[type:1][id:4][ack:4][len:4]` 协议帧,发 `{type:'auth'}` + 
`{type:'connectionType', desiredConnectionType:2}`,从而**真的拉起扩展宿主**并对话。

| 组 | 监听端 | 扩展宿主 | 握手/协议 | 后代 TCP 连接 | grace-time 日志 |
|---|---|---|---|---|---|
| A | TCP 端口 | 句柄传递(默认) | ✓ 336 B,含 sign/pause/resume/Regular/KeepAlive | 4 条(launcher 名下) | **有**(⇒ 走了 type 2 分支) |
| B | TCP 端口 | 内部管道(`--exthost-ipc`) | ✓ 帧完全一致 | 4 条 | **无**(⇒ 走了管道分支) |
| C | **命名管道**(`--pipe`) | 内部管道 | ✓ 帧完全一致 | **0 条** | 无 |

- A/B 的差异只有那一行日志,而它只在 `type===2`(收句柄)分支里打印 ⇒ **B 确实是管道链路**,不是
  netstat 分不清的句柄复制。
- C 的日志前缀是 `[<unknown>][probe][ExtensionHostConnection]`(管道连接没有 remoteAddress),且
  `healthz` 的 `listen` 就是管道名;`/healthz`、`/`、`workbench.js`(注入生效)、隧道 101 全部经管道完成。
- 结论:**desktop 的 8090 可以彻底消失**(换成 `\\.\pipe\dshcs-vscode-<pid>`),host 侧协议不用改,
  客户端本来就是零依赖端口。
- 注意:探针必须在**非受限沙箱**下跑(受限模式下连接命名管道直接 EPERM)。

### 15.4 落地(0.3.2 → 0.3.3 拆掉全部回退)

- `lib/index.js`:`launcherFlags()`(`--pipe` 必配 `--exthost-ipc`)+ `spawnOnce()`;pid.json/状态快照
  记 `transport`/`pipe`、`url` 指向资产镜像文档;镜像/隧道目标判定统一为"有管道就转发"。
- 顺带修掉一个真实竞态:apply 期的预启动与界面点击会并发进入 `start()`,两边写同一个管道名 → 第二个
  launcher `EADDRINUSE`。`start()` 现在串行化。
- **0.3.3 按用户要求"不要设计任何回退",删掉全部降级路径**:
  ① 端口传输(第 15.2 节一度留的 `DSHCS_TRANSPORT=tcp` 开关与"管道 10s 未就绪就换端口重启"的分支);
  ② `bin` 逃生舱(配置外部 code-server 可执行文件 / `out/node/entry.js` 退回旧模型);
  ③ `serve: dsh` 在缺 `webServer` 时静默降级为 loopback。
  连带删除 `host`/`port`/`bin` 配置项与 TCP 版 `healthCheck()`;任何一环不成立 → 显式 `error`,
  错误文案给出可执行建议(例:`serve=dsh 需要 DSH 提供 webServer 服务…desktop profile 请用 serve: loopback`)。
- 测试:`scripts/test-plugin-apply.mjs` 断言"管道是唯一传输、无 `--port`、`resolveTransport` 已移除";
  `scripts/test-desktop-pipe.mjs`(桩 ctx → 真插件 → 真 IDE 起在管道上:transport/pipe、管道 `/healthz`、
  **launcher 零 TCP 监听**、镜像注册、stop 收敛);`scripts/spike-dsh-e2e.mjs` 20 项(含场景 B
  "serve=dsh 缺 webServer → 报错且不启动任何进程")。