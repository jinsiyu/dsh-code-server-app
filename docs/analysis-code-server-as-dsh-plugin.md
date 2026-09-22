# code-server 能否重构为 DSH 插件 —— 实测分析报告(Phase 0)

> **本文档是历史记录**:按版本分段记录当时的实测、取舍与踩过的坑(含已被取代的实现)。
> **当前实现以 README 为准**(「与 DSH 的协同:编辑器桥」「客户端半部:为什么没有构建步骤」
> 「「问 DSH」对话框:为什么没有构建步骤」三节);本文档只作为"为什么当初这么做"的溯源材料保留。

> 结论日期:2026-09-10 · 目标机器:Windows 11 ARM64 · 被测发行版:code-server 4.136.2(VS Code 1.136.1,`commit=8d5f383f301ca20681f5b6606b8207d9dc87bdd8`,`quality=stable`)
> 关联方案:见会话方案「把 code-server 重构为 DSH 插件」(Phase 0–5)

## 0. 结论

**Go。** code-server 的 Node 层可以被本插件自带的 ~200 行 launcher 完全替代,IDE 可直接挂到 DSH 自身的 HTTP 端口上,且**不需要** `--server-base-path`、**不需要**改写 workbench HTML、**不需要**独立 TCP 端口。

关键判定(全部本机实测,非推断):

| # | 验证项 | 结果 |
|---|---|---|
| 1 | 自建 launcher import `lib/vscode/out/server-main.js` → `loadCodeWithNls()` → `createServer(null, args)` | **通过**(144ms import / 198ms createServer;返回对象含 `handleRequest`/`handleUpgrade`/`dispose`;`address=undefined` — 内部不再自建监听) |
| 2 | 自建 `node:http` 分发 `handleRequest`/`handleUpgrade` | **通过**(`/version` `/` 静态 `/healthz` `/manifest.json` 404 全部符合预期) |
| 3 | **子路径挂载 `/code-server`(Phase 0 Go/No-Go)** | **通过**:prefix 路由 + 精确 WS 路由,浏览器端完整启动 workbench(截图 `.spike/workbench-subpath.png`) |
| 4 | 客户端真实 WS 路径 | **实测确认**:`/code-server/stable-8d5f383f…?reconnectionToken=<uuid>&reconnection=false&skipWebSocketFrames=false`(浏览器真实连接 3 次,见 proxy 日志) |
| 5 | DSH 认证 fence 语义(`requestRejection` 等价物) | **通过**:无 cookie → `401`;伪造 Host(`evil.example.com`)→ `403`;DSH 根 `/` 无 cookie → `401` |
| 6 | 命名管道传输(Phase 3 内部通道) | **通过**:launcher `LISTEN \\.\pipe\dshcs-spike-test`,`GET /version → 200(40B)`、`/healthz → 200`、`/ → 200(4222B HTML)` |

**同时更正 README「已知限制」中"子路径不支持、必须独立端口"的结论**——该结论不成立,依据见 §2.3。

---

## 1. 验证环境与方法

复现脚本(Phase 0 产物,不进发布物):

```powershell
# ① launcher:TCP 模式(8199)
node scripts/spike-launcher.mjs --port 8199 `
  --vs-root "$env:USERPROFILE\.dsh\profiles\web\node_modules\@jinsiyu\dshcs-code-server\code-server" `
  --data "$PWD\.spike\user-data"

# ② DSH webServer 等价代理(8200):prefix 路由 + 精确 upgrade 路由
node scripts/spike-dsh-proxy.mjs --port 8200 --target-port 8199 --vs-root <同上>

# ③ 契约探针(根挂载 / 子路径各跑一遍)
node scripts/spike-probe.mjs --port 8199
node scripts/spike-probe.mjs --port 8200 --base /code-server

# ④ 命名管道
node scripts/spike-launcher.mjs --pipe '\\.\pipe\dshcs-spike-test' --vs-root <同上> --data "$PWD\.spike\user-data-pipe"
node scripts/spike-pipe-probe.mjs --pipe '\\.\pipe\dshcs-spike-test'
```

**测试隔离**:全部使用独立数据目录(`.spike/user-data*`)与独立端口(8199/8200),未触碰正在运行的实例(`127.0.0.1:8090`,user-data `~/.dsh/code-server/user-data`)与 DSH GUI(3080)。

**沙箱事实**:本会话 workspace-write 沙箱按设计禁止打开命名管道(`EPERM connect \\.\pipe\…`),管道**客户端**验证用一次性 `danger-full-access` 放宽完成;监听侧在沙箱内即成功。DSH host 进程不受该沙箱限制。

---

## 2. 实测结果

### 2.1 launcher 形态(替代 code-server 的 `out/node/**`)

进程护栏(必须 import 前设置,来自源码审计 + 实测):

- `CODE_SERVER_PARENT_PID` —— 否则 `server-main.js` 末尾 `process.env.CODE_SERVER_PARENT_PID||OX()` 会执行 VS Code 自带 CLI main;
- `VSCODE_HANDLES_SIGPIPE=1` —— 避免它安装自己的 SIGPIPE 处理器;
- `VSCODE_CWD` + import 后 `process.chdir()` 复位 —— win32 顶层 `DB()` 会 `chdir(dirname(process.execPath))`。
- 实测中 cwd 复位未触发异常(import 后 cwd 未变),但保留复位逻辑作为防御。

`createServer(null, args)` 的最小可用 args:

```js
{ auth: 'none', 'user-data-dir': <dir>, 'extensions-dir': <dir>,
  'accept-server-license-terms': true, compatibility: '1.64',
  'without-connection-token': true, 'disable-telemetry': true, 'disable-update-check': true, _: [] }
```

实测返回对象键:`_store, _socketServer, _connectionToken, _vsdaMod, _environmentService, _productService, _logService, _instantiationService, _serverLifetimeService, _extHostLifetimeTokens, _webEndpointOriginChecker, _serverBasePath, _serverProductPath, _extHostConnections, _managementConnections, _allReconnectionTokens, _webClientServer, _reconnectionGraceTime`。

日志旁证:`[AgentHostChannel] Registered lazy IPC channel 'agentHostProxy'` / `Extension host agent started.` —— VS Code server 与我们的 launcher **同进程**,且**没有**第二个监听端口(netstat 复核:8199 一个)。

**开发期注意**:`vendor/code-server`(包内 dev 树)**缺** ESM 内部依赖 junction,直接跑会 `ERR_MODULE_NOT_FOUND: @vscode/spdlog / @vscode/deviceid / @vscode/windows-registry`。已安装的 profile 树(`<profile>/node_modules/@jinsiyu/dshcs-code-server/code-server`,含 `lib/vscode/node_modules` 24 个 junction + `lib/vscode/extensions/node_modules` 1 个)正常。→ Phase 2 的 `envCheck` 必须在**解析前**先跑 `ensureRuntimeLayout()`,dev 树同理。

### 2.2 根挂载契约(全部 PASS)

```
GET /version                                              → 200 text/plain(commit)
GET /                                                     → 200 text/html
GET /stable-<commit>/static/out/vs/code/browser/workbench/workbench.js → 200 text/javascript
GET /_static/src/browser/media/favicon.ico                → 200 image/x-icon(launcher 自己的静态)
GET /manifest.json                                        → 200 application/manifest+json(launcher 自己的)
GET /definitely-not-there                                 → 404 text/plain
WS  /stable-<commit>?reconnectionToken=…&reconnection=false&skipWebSocketFrames=false → 101 Switching Protocols
```

### 2.3 子路径挂载(Go/No-Go,全部 PASS)

同一组探针,基址换成 `http://127.0.0.1:8200/code-server`:HTTP 全通过,WS 握手 `101`,并且浏览器打开后 **workbench 完整启动**(Welcome 页 + 侧边栏 + Chat 面板,截图 `.spike/workbench-subpath.png`)。

服务端渲染出的 workbench 配置(`.spike/evidence/workbench-web-configuration.json`):

```
serverBasePath="."            rootEndpoint="."
proxyEndpointTemplate="./proxy/{{port}}/"
serviceWorker.path="./_static/out/browser/serviceWorker.js"
webviewEndpoint="stable-8d5f383f301ca20681f5b6606b8207d9dc87bdd8/static/out/vs/workbench/contrib/webview/browser/pre"
WORKBENCH_WEB_BASE_URL="stable-8d5f383f301ca20681f5b6606b8207d9dc87bdd8/static"
```

HTML 内 9 条 `href/src` 引用中 **绝对路径 0 条**:

```
./_static/src/browser/media/pwa-icon-192.png
./_static/src/browser/media/pwa-icon-512.png
./_static/src/browser/media/favicon-dark-support.svg
./_static/src/browser/media/favicon.ico
./manifest.json
stable-8d5f383f301ca20681f5b6606b8207d9dc87bdd8/static/out/vs/code/browser/workbench/workbench.css
stable-8d5f383f301ca20681f5b6606b8207d9dc87bdd8/static/out/nls.messages.js
(空 = WORKBENCH_NLS_URL,英文环境)
stable-8d5f383f301ca20681f5b6606b8207d9dc87bdd8/static/out/vs/code/browser/workbench/workbench.js
```

客户端 WS 拼接(`workbench.js` @18088077):`t = (location.pathname + "/" + getServerRootPath()).replace(/\/\/+/g,"/")`,其中 `getServerRootPath() = join(serverBasePath ?? "/", `${quality}-${commit}`)`。→ **路径由 `location.pathname` 决定**,因此挂载前缀自动生效。

**采用方案**:DSH 路由**剥掉 `/code-server` 前缀**后转发,VS Code 侧保持根挂载(与今天已验证的配置完全一致),不传 `--server-base-path`。于是 `{{BASE}} = .`,所有相对引用都落在 `/code-server/...`,由同一条 prefix 路由覆盖(含 `_static`)。
> 备选方案(未采用):传 `server-base-path=/code-server` 并转发完整路径。副作用:`{{BASE}}` 变成 `./..`(源码 `wX()` 相对根计算),`_static` 会被要求挂在**源站根** `/ _static`,与 DSH 根路径耦合,故弃用。

### 2.4 认证 fence

对**正在运行的** DSH GUI(3080)实测:

| 请求 | 结果 |
|---|---|
| `GET /api/<任意>`(无 cookie,Host=127.0.0.1:3080) | `401` |
| 同请求但 `Host: evil.example.com` | `403`(DNS rebinding 防线生效) |
| `GET /`(无 cookie) | `401`(浏览器会话认证) |

源码对应:`ctx.connection.requestRejection(request) → 401 | 403 | undefined`(`dsh-client-connection/lib/index.js:553`:`!isTrustedApiRequest → 403`;否则 `browserAuth.isAuthenticated ? undefined : 401`)。
→ **Phase 3 的 `/code-server/*` 与 upgrade 路由必须调用它**,否则会成为 DSH 源站上唯一的无认证面。

### 2.5 命名管道

launcher `LISTEN \\.\pipe\dshcs-spike-test` 成功;客户端经放宽后:

```
GET /version → 200 text/plain len=40
GET /healthz → 200 application/json len=89
GET /          → 200 text/html len=4222
```

---

## 3. 136 个包是干什么的(归属追踪)

`vendor/code-server/node_modules` = **34.5 MB / 136 顶层条目**,其中 **133 个**是 code-server `package.json` 里 **20 个直接依赖**的闭包:

| 根依赖 | 闭包包数 | 体积 | 用途 |
|---|---|---|---|
| `express` + `qs` | 57 | 1.72 MB | HTTP 框架(路由/body/静态/etag/statuses…) |
| `proxy-agent` | 24 | 3.83 MB | 出站代理链(pac-resolver/socks/degenerator/esprima/`@tootallnate/quickjs-emscripten` 1.65 MB…)——只为更新检查与走代理出网 |
| `argon2` | 10 | 1.64 MB | 口令认证;**整棵树唯一的原生包** |
| `js-yaml` | 2 | 1.55 MB | 读 `config.yaml` |
| `i18next` | 1 | 0.49 MB | 登录页多语言 |
| `compression` | 10 | 0.45 MB | 自身 gzip(DSH webServer 已开 gzip) |
| `pem` | 9 | 0.38 MB | 自签证书 |
| `limiter` | 2 | 0.37 MB | 登录限流 |
| `http-proxy` | 4 | 0.30 MB | `/proxy/:port` |
| `ws` | 1 | 0.14 MB | 自身 ws server |
| 其余 9 个 | 9 | ≈0.3 MB | semver/日志轮转/cookie/cookie-parser/logger/env-paths/xdg-basedir/safe-compare/httpolyglot |

不在闭包内的 3 个:`.bin`、`source-map`(0.77 MB)、`typescript`(**22.53 MB,与插件 `dependencies` 重复的冗余兜底**)。

**删除依据**:这些包的 import 点全在 `out/node/**`;`lib/vscode/out/server-main.js` 内 `express`/`ws`/`semver`/`js-yaml`/`http-proxy` 命中数均为 0,只命中 `import * as … from "cookie"`(2 处)。VS Code 真正需要外挂的只有 6 个名字 —— `cookie`、`ws`、`node-addon-api`、`typescript`、`http-proxy-agent`、`https-proxy-agent` —— 且**现在都由插件自身 `dependencies` 在 profile 根提供**。
树体积:232.3 MB = `lib/vscode` 196.9 + `node_modules` 34.5 + `out` 0.3 + `src` 0.1 → 重构后 ≈197 MB(**只降 15%**),但依赖数从「136 + 27 原生」降到「27 原生 + 6 个纯 JS 名字」,argon2 构建链整条消失。

---

## 4. 对实现的约束(来自本次实测)

1. `envCheck`/启动前**必须先跑 `ensureRuntimeLayout()`**(dev 树缺 junction 会 `ERR_MODULE_NOT_FOUND`,已实测)。
2. launcher 必须设 §2.1 三个进程护栏,并在 import 后复位 cwd。
3. 必须自带 `/healthz`、`/manifest.json`、`/_static/*`(VS Code server 不含这三条;实测其自身返回 404)。
4. WS 走**精确路径**注册:`/<prefix>/<quality>-<commit>`;客户端路径由 `location.pathname` + `productPath` 拼成,`productPath` 必须从 `lib/vscode/product.json` 现算(`quality`+`commit`),禁止硬编码。
5. upgrade 必须:`socket.pause()` → `req.ws = socket` → `handleUpgrade(req, socket)` → `socket.resume()`;`head` 被两处调用方忽略,但仍应透传。
6. `/code-server/*` 与 WS 必须调用 `ctx.connection.requestRejection()`(§2.4)。
7. 内部传输优先命名管道(已验证);需保留 TCP 回退(沙箱/权限异常场景)。
8. 静态资源 `/_static/*` 映射到树根;`serviceWorker.js` 需带 `Service-Worker-Allowed: /`。

## 5. 已知退化与限制

- **端口转发(WebSocket)**:`registerUpgrade` 是精确匹配,而转发端口号在路径里(`/proxy/:port`)→ Phase 3 下转发端口的 WS 不可用(HTTP 可用)。需要 DSH 上游提供 prefix-upgrade,或在 loopback 模式下使用。
- **同源 iframe**:`serve:'dsh'` 下 IDE 与 DSH GUI 同源,前端资源与 `/api` 同一信任域;因此 fence 必做(见 §2.4),且 iframe sandbox 属性需按模式区分。
- **desktop profile**:显式禁用了 `webserver` 行,无路由注册表 → 只能 `serve:'loopback'`。
- **体积**:IDE 本体(`lib/vscode` 196.9 MB)不可压缩。

## 6. 证据文件

| 文件 | 说明 |
|---|---|
| `.spike/evidence/workbench-subpath.html` | 子路径挂载下的 workbench HTML(实测) |
| `.spike/evidence/workbench-web-configuration.json` | 实测 web configuration(serverBasePath/rootEndpoint/proxyEndpointTemplate/serviceWorker) |
| `.spike/workbench-subpath.png` | 子路径下 workbench 完整启动的截图 |
| `scripts/spike-launcher.mjs` / `spike-dsh-proxy.mjs` / `spike-probe.mjs` / `spike-pipe-probe.mjs` | 可复现脚本(不进发布物) |

---

## 7. 实施结果(Phase 1–4,已在工作区落地)

### Phase 1 — vendor 流水线瘦身(已完成)

- 新增 `scripts/vendor-vscode-server.mjs`:从 code-server 发行版只保留
  `lib/vscode/**`、`out/browser/**`、`src/browser/**` 与许可文件 → `vendor/vscode/`(+生成的树根 `package.json`),
  `--dev-links` 可把 VS Code 内部依赖用 junction 复刻(开发期直接可跑)。
  **实测产物:197.2 MB**(原 232.3 MB,−15%),`productPath=stable-8d5f383f…`。
- 用生产 launcher 驱动**精简树**跑完整探针:6/6 PASS + WS 101 → 证明删掉的 `out/node/**` 与 136 个依赖确实不再被需要。
- `scripts/vendor-repacks.mjs`:`buildCodeServerPackage()` → `buildVscodeServerPackage()`
  (`@jinsiyu/dshcs-vscode-server`,包内布局 `vscode/`,排除内部依赖目录);删掉 `buildArgon2Package()` 与
  全部 argon2 接线(含旧 profile 别名表里的 argon2 回灌);顺带给平台专属原生包加了 **PE machine 校验**。
  **实测:`--reuse` 产出 27 个包(原 29)、16 个重打包条目、聚合包 deps 无 argon2、插件 package.json
  dependencies=36(树 + 35 纯 JS)、optionalDependencies=2 个聚合包 `^0.2.0`**。
- `lib/vendor.js`:新增 `vsRoot()/vsServerEntry()/productPath()/isVscodeOnlyTree()`,
  解析顺序 新树包 → 旧全量树包 → 0.1.37 平台子包 → 包内 vendor(新旧双轨,可回退)。

### Phase 2 — launcher + host 半部(已完成)

- 新增 `lib/launcher.mjs`(生产版):进程护栏(`CODE_SERVER_PARENT_PID` / `VSCODE_HANDLES_SIGPIPE` / `VSCODE_CWD`
  + import 后复位 cwd)、`loadCodeWithNls()` → `createServer(null, args)`、自建 `node:http` 分发
  `handleRequest`/`handleUpgrade`、`/healthz`(回传 `productPath` 与最近 upgrade 路径)、`/manifest.json`、
  `/_static/*`、`/proxy/:port`+`/absproxy/:port`(HTTP+WS)、`--parent-pid` 看门狗、优雅退出与 `uncaughtException` 兜底。
- `lib/index.js`:`resolveLaunch()` 改为 spawn launcher(`bin` 保留逃生舱);`envCheck()` 去掉 argon2,
  改为「树 + `server-main.js` + 内部依赖 + 预编译原生包」;`ensureRuntimeLayout()` **提前到 envCheck 之前**
  (精简树不含 `lib/vscode/node_modules`,已实测缺 junction 会 `ERR_MODULE_NOT_FOUND @vscode/spdlog`);
  修掉 `checkInnerDeps()` 把树包自身当成内部依赖的误报;`state/snapshot` 增加 `serve`/`pipe`/`productPath`;
  pipe 模式就绪探测 `healthCheckPipe()`;adopt 只在 loopback 模式启用。
- **harness 实测(scripts/spike-host-harness.mjs)**:`envCheck` 通过 → `POST /api/code-server/start` →
  `status=running`、`url=http://127.0.0.1:8303/`、`GET /version = 8d5f383f…` → `stop` 回收。

### Phase 3 — DSH 同源挂载(已完成)

- 新增 `lib/serve-dsh.mjs`:`webServer.register({kind:'prefix',path:'/code-server'})` +
  `registerUpgrade({path:'/code-server/<productPath>'})`,两条路径都先过
  `ctx.connection.requestRejection()`(401/403),再剥前缀转发到 launcher 目标(命名管道为主,TCP 为备),
  两个 handler 都带 try/catch(路由异常绝不冒泡到 DSH webServer)。
- `lib/index.js` 用 `ctx.inject(['webServer'], …)` 特性检测后挂载;`serve: dsh` 且无 webServer 时自动回退 loopback。
- **harness 实测**:`scripts/spike-dsh-mount-harness.mjs` 11/11(prefix/静态/404/fence 401+403/WS 101/未注册 upgrade destroy);
  `scripts/spike-dsh-e2e.mjs` **18/18**(场景 A:管道模式 + 无端口 + 路由 + fence + WS;场景 B:无 webServer 自动回退 loopback 且 IDE 可用)。
- 过程中抓到并修复一个真实缺陷:`net.connect` 需要 `{path}` 而 `http.request` 需要 `{socketPath}`,
  目标描述符改为 `{kind:'pipe'|'tcp'}` 后翻译;此前该缺陷会在 WS 升级时抛出未捕获异常(已加 try/catch 双保险)。

### Phase 4 — 客户端与文档(已完成)

- `src/factory.js`:按 `status.serve` 区分 iframe `sandbox`(同源模式不挂 sandbox,只保留剪贴板 `allow`);
  诊断面板按模式显示提示;环境检测卡片改为显示「树版本 / productPath / server 入口 / 内部依赖 / 预编译原生包」。
  客户端 bundle 已重建(`lib/client.js`,173KB)。
- `cordis.patch.yml`:`serve` / `locale` 等新键与说明;`auth` 注明固定 `none`。
- `README.md` / `README.en.md`:新增「服务方式(serve)」章节;**更正已知限制里"子路径不支持"的错误结论**
  (附实测依据),补充 dsh 模式的两点取舍与转发端口 WS 限制;打包/升级/配置/体积说明同步到 0.2.0。
- 版本 `0.2.0`;`files` 清单补齐 `lib/serve-dsh.mjs`(否则安装后 `serve: dsh` 会在 import 时失败)。

### 尚未执行(Phase 5,需要你确认)

1. `repack:build --pack` 打包 27 个子包 → `publish:repacks`(**会改 registry**,首次需要你的 2FA);
2. `pnpm pack` → `publish:plugin`(发 **next**,不动 latest);
3. 你重启 `dsh web` 确认无误后,`pnpm run promote -- 0.2.0` 推进 latest。
   回退路径:`dsh plugin --profile web add dsh-code-server-app@0.1.43`。

## 8. 常驻 IDE 面(0.2.2)

### 8.1 触发点:DSH 右侧栏只渲染激活标签

- 证据(读源码):`ui-dockkit` 的 `TabPanel.tsx:412` 只调用 `callbacks.renderTab(active)`——非激活标签 body
  **不在文档里**;切走 = React 卸载 iframe = 浏览上下文销毁,切回 = 整页重载(未保存缓冲区丢失)。
- 侧栏收起(`transform: translateX(100%)`)时面板**仍挂载**,只有标签切换会真卸载。

### 8.2 机理验证:`appendChild` 重载 vs `moveBefore` 状态保持

在真实浏览器(Edge/Chromium 151)里用一个同源 iframe 装计数器探针,分别用两种方式在 A/B 容器间搬:

| 移动方式 | 探针计数器 | 结论 |
|---|---|---|
| `dst.appendChild(frame)` | 归零(1 → 重新 1) | 等价重载 |
| `dst.moveBefore(frame, null)` | 连续(1 → 2) | **状态保持**,不重载 |

- `Element.moveBefore` 为 Chromium ≥133 的"状态保持型原子移动";运行时不支持时按 `degraded` 处理。
- 实测捕获的失败面:宿主被 React 先摘出文档、后跑 effect cleanup 时 `moveBefore` 抛
  `HierarchyRequestError: State-preserving atomic move cannot be performed on nodes participating in an invalid hierarchy`。
  修法:停放改在 `useLayoutEffect` cleanup(先于 DOM 摘除)执行 + `moveBefore` try/catch 退回 `appendChild`,
  并记录 `degraded` / `lastMoveError`,**绝不把 iframe 留在已脱离文档的宿主里**。

### 8.3 端到端实测(DSH web GUI,真实鼠标事件)

| 步骤 | 观测 |
|---|---|
| 关闭 Code Server 标签 | `frames:1`、`sameNode:true`、内部探针存活、`parent:"dshcs-park"`、`degraded:false` |
| 真实点击标签切回 | `docked:true`、`owner:"tab:<id>"`、`src` 不变、同一 iframe 节点、无整页重载 |

### 8.4 观测到一次"元素在、画面不重绘"(触发条件**未复现**,按兜底处理)

- 现象(真实 GUI,1 次):跨源 iframe 被移回停靠位后,`getBoundingClientRect()`、尺寸、`elementFromPoint()` 命中、
  `visibility/opacity/transform`、`inert` 状态**全部正常**,但面板**一片白**;连续两张截图(哈希相同)与多次探测都不恢复。
- 排除项:把同一 URL 作为顶层标签打开,workbench 正常渲染 ⇒ 服务端、认证与截图/合成管线都正常,
  问题只在"被搬回文档的跨源 iframe"这一层。
- 无效尝试:`transform: translateZ(0)`、`opacity` 微调、单纯等待(截图字节级相同 ⇒ 确实没有新帧)。
- 有效恢复:`frame.style.display='none'; void frame.offsetHeight; frame.style.display=<原值>`
  —— **同一个 JS 任务内**完成,不产生可见闪烁;iframe 文档不重载(VS Code 布局、"欢迎"页状态保持)。
- **触发条件复现实验(阴性)**:独立探针页 `.spike/park-probe.html`(同几何:跨源 iframe → `left:-20000px`
  + `visibility:hidden` + `contain:strict` 的停放容器),`moveBefore` 停放 **337 s**(超过 Chrome 对不可见跨源
  iframe 的 ~5 min 节流窗口)后移回,**关闭修复(nudge off)仍正常绘制**;真实 GUI 里 86 s 停放的自动回停靠
  同样正常绘制。⇒ "长时间离屏停放"**不是**可靠触发条件,该现象未能稳定复现(疑似一次性合成/时序问题)。
- 结论与取舍:不宣称修好了某个已定位的根因;把它作为**兜底**保留——每次「停放 → 停靠」补一次
  `nudgeRepaint()`(代价:一次强制重排;实测无重载、无状态丢失、无闪烁),计数进
  `surfaceSnapshot().nudgeCount`;`setNudgeEnabled(false)` 可用于现场 A/B,`window.__dshcsSurface` 为排障句柄。
- 仍未测量的变量:页面级 `visibilitychange`(切到别的浏览器标签再回来)、窗口在停放期间被 resize、
  以及 `sandbox` 属性对跨源 iframe 合成的影响——三者都是当时现场存在、而探针页里不存在的差异。

### 8.5 宿主半部

- `Config.keepResident: boolean`(默认 `true`)→ 插件启动后即建面并停在停放区(**预热**),
  首次点开标签不必等冷启动;`preload` 不抢正在停靠的面。设置卡片新增行「后台常驻(切标签不重载)」。

## 9. 不再兼容旧版 DSH(0.2.3)

### 9.1 决策与范围

- 旧版 DSH(2026 早期、尚无右侧栏服务的版本)此前的载体是**插件自绘的悬浮球 + 内部浮动窗口**(参照 univer-office
  的 WorktreeWindow)。0.2.3 起**整段删除**:常驻面、剪贴板 `allow`、面板折叠/分屏/全屏、键盘焦点都建立在
  DSH 右侧栏之上,维护两套载体的成本高于其残余价值。
- 旧版上的行为收敛为一条**设置页提示**(`设置 → 插件 → Code Server`):说明缺 `sidebarRightTabs`/`sidebarRight`
  服务、本插件不再支持该版本、升级路径(rc 线 0.1.5-rc.x 或 0.1.6-alpha.2 起的 alpha 线);升级后无需重装,刷新页面即恢复完整卡片。

### 9.2 探测方式(特性检测,不按版本号硬判)

1. 先同步探测:`ctx.get('sidebarRightTabs')` 与 `ctx.get('sidebarRight')` 同时存在 → 现代 DSH,立即注册;
2. 服务可能晚于本插件就绪 → 退回 `ctx.inject(['sidebarRightTabs','sidebarRight'], cb)` 等待;
3. **2.5 s 内既没同步命中、也没等到 `inject` 回调 → 判定 legacy**(`LEGACY_PROBE_TIMEOUT_MS`)。
   注:DSH 客户端插件里没有可靠的版本号读数(无 `version` 服务、无 `DSH_VERSION` 环境变量,
   只有 web shell 的 `window.__DSH_BOOT__`),故不引入版本比较。

### 9.3 legacy 分支到底做了什么

| 侧 | 行为 |
|---|---|
| 客户端 | 只注册一条升级提示(座位随 DSH 版本:`settings.plugin.item` 或 `plugins.bundle.config`;`noticeOnly` 模式:无只读条、无"保存/放弃"按钮,默认展开);**不注册** `shell.overlay`(悬浮球/预热)、`conversation.chat.turnTail`(产物按钮)、`sidebar.right.pane.tab`(侧栏 body) |
| 客户端 → host | `POST /api/code-server/ui-mode { sidebar:false }` |
| host | 记录 `state.sidebarUi=false`;`maybePrestart()` 直接返回(**不再预启动**);若当前实例是"本插件刚自动预启动且未被 adopt",则 `stop('legacy-ui')` **回收**,避免留下用不上的 IDE 进程与端口 |

- 新增路由 `/api/code-server/ui-mode`(第 6 条 exact Fetch 路由);`snapshot()` 增加 `sidebarUi` 字段。
- `reserveComposer` 配置键**保留但废弃**(只对已删除的浮窗有意义):保留是为了让旧设置文档继续通过校验,
  schema 与 snapshot 里的字段仍在,客户端不再读取。

### 9.4 验证(离线,不依赖渲染)

`.spike/spike-legacy-ui.mjs`:用最小 `window/document/require/fetch` 桩跑 `lib/client.js` 导出的 factory,
断言两个场景(共 17 项,全部 PASS):

- **场景 A(旧版)**:只注册设置卡;没有 overlay / turnTail / 侧栏 body 注册;上报了 `{sidebar:false}`;
  卡片元素树含"不再兼容旧版 DSH"与缺服务说明,且不含任何设置项。
- **场景 B(现代)**:注册侧栏 tab 类型 + body + overlay + turnTail + 设置卡,且不上报 legacy;
  卡片为常规卡片(含"窗口化打开")。

真实 GUI(本机 DSH,带右侧栏)复核:刷新后页面**不存在** `.dshcs-ball` / `.dshcs-win` 节点;
点产物旁的图标按钮 → 打开侧栏标签 → workbench 正常绘制(`docked:true`、`nudgeCount:1`)。

### 9.5 体积副产物

删除 `motion` 与浮窗/悬浮球后,客户端 bundle **180.4 KB → 37.3 KB**(-79%;`motion` 不再被打进客户端,
`react-dom` 的静态 require 也随之消失——浮窗是唯一使用 portal 的地方)。

## 10. 回归与修复:desktop 上"设置卡正常、右侧栏却没有 Code Server"(0.2.4)

### 10.1 现场与排查路径(用户报告)

用户在 dsh-desktop 里看不到右侧栏的 Code Server 入口。逐步取证:

1. **profile 安装**:`~/.dsh/profiles/desktop/package.json` 的 dependencies 里有 `dsh-code-server-app@0.2.3`,
   且它是该 profile **唯一**的第三方依赖;`node_modules/dsh-code-server-app/lib/client.js` = 37 326 B(0.2.3 构建)。
   `dsh plugin --profile desktop …` 会被 CLI 直接拒绝("profile "desktop" is managed exclusively by the Electron application"),
   说明 desktop 的包事务由 Electron 应用自己完成。
2. **合成清单**:`desktop-packages.json`(241 包)只含第一方 core 包集(不含第三方),`desktop.cordis.yml` 每次启动被
   desktop-host 覆写为 `[]`("package transactions own this file")→ 真正的合成来自 profile 的 `package.json` 依赖层
   + `apps/desktop-host/config/desktop.cordis.patch.yml`。该补丁注释写明 *"Electron reuses the browser composition"*,
   只 disabled `web-startup` / `webserver` / `web-runtime` / `client-hmr` / `open-in-app` / `ui-open-in-app` / `directory-picker`,
   并插入原生目录选择器 —— **`ui-sidebar-right` 未被禁用**。
3. **服务名**:`@deepseek-ai/dsh-client-ui-sidebar-right` 的 bundle 里 `ctx.reflect.provide("sidebarRight")` 与
   `provide("sidebarRightTabs")` 同时存在 → 名字与我的探测一致。
4. **运行态**:`~/.dsh/code-server/pid.json` 的 `launchCommand` 指向
   `~\\.dsh\\profiles\\desktop\\node_modules\\dsh-code-server-app\\lib\\launcher.mjs`,实例 22:21:51 启动且 `/healthz` 200
   → **host 半部在 desktop 正常工作**,并且没有被我新加的"旧版回收"逻辑杀掉。
5. **渲染器实际加载的 bundle**:在 `%APPDATA%\@deepseek-ai\dsh-desktop\Code Cache\js\` 里能同时找到
   `sidebarUi` / `__dshcsSurface`(0.2.3 的字符串字面量)与旧版的 `dshcs-ball` → 0.2.3 的 client **确实被 desktop 渲染器加载过**。
6. 用户观察(决定性):**设置卡是正常设置项**(说明没走 legacy 分支),但右侧栏没有入口/标签。

### 10.2 根因(两个脆弱点,均已修)

- **① 注册走了"插件 ctx 的属性访问"**:0.2.3 的实现是"同步探测命中 → `onModernUi(ctx)`",而 `registerSidebarTab` 读的是
  `sctx.sidebarRightTabs` / `sctx.sidebarRight` **属性**。desktop 的上下文只保证 `ctx.get(name)` 可见时,这两个属性是
  `undefined` → 命中 `if (tabs == null || controller == null) return` **静默返回** → 标签类型/body/入口框全都没注册,
  但 `sidebarUi` 已被置为 `modern` → 卡片看起来完全正常。web 之所以没暴露:web 上服务晚于本插件就绪,
  走的是 `ctx.inject` 回调(注入上下文里属性可见),从未走那条快路径。
- **② 判定会 latch**:超时一旦判定 legacy,后来的 `ctx.inject` 回调被丢弃 → 即使服务随后就绪也永远不注册。
- 另有一个放大器:0.2.3 的 legacy 上报没有宽限,一旦误判就会让 host 回收刚预启动的实例;
  本次 desktop 实例没被杀,是因为走到的是 ① 而不是 legacy 分支(卡片正常即为证据)。

### 10.3 修复(0.2.4)

| 项 | 做法 |
|---|---|
| 服务查找 | `serviceOf(ctx,name)`:`ctx[name]` → `ctx.get(name)` 双通道,任一可见即用 |
| 注册路径 | 统一走 `ctx.inject(['sidebarRightTabs','sidebarRight'], cb)`;同步可见但 inject 不回调时 **1.5 s 兜底注册**(`SYNC_FALLBACK_MS`) |
| 判定可逆 | 服务晚到 → 撤销 legacy、补注册、上报 `{sidebar:true}`;`modernSettled` 只保证不重复注册 |
| 上报宽限 | 2.5 s 只提示(`LEGACY_NOTICE_MS`),**10 s** 才上报 host(`LEGACY_REPORT_MS`),避免误杀慢启动宿主 |
| 不再静默 | `registerSidebarTab` 返回布尔并显式 `console.error`;失败写入 `sidebarRegisterFailed`,设置卡入口行显示告警 |

### 10.4 回归用例(`.spike/spike-legacy-ui.mjs`,共 27 项,全部 PASS)

| 场景 | 覆盖 |
|---|---|
| A | 旧版 DSH:只注册设置卡、无 overlay/turnTail/body、2.5 s 时**尚未**上报 |
| A2 | 超过 10 s 宽限后才上报 `{sidebar:false}` |
| B | 现代 DSH + inject 同步回调:全量注册、不上报 legacy、卡片为常规设置项 |
| C | **desktop 形态**:服务只在 `ctx.get` 可见、`inject` 不回调 → 200 ms 时未注册、1.5 s 后兜底注册成功、未误报旧版 |
| D | 服务 3 s 才出现:2.7 s 时"只等不注册"、到达后补注册、从未误报 |
| D2 | 先落到旧版判定、服务 3.5 s 才到:卡片先显示提示 → 到达后补注册 + 上报 `{sidebar:true}` + 卡片恢复常规设置项 |

> 教训(写给下一次):客户端插件的服务获取不要只依赖一种形态(属性 vs `get()`),
> 注册失败不要静默,超时判定要可逆 —— 三者叠加才会产生"UI 看起来正常、功能却整段没生效"这种最难查的故障。

## 11. 桌面端安装:24h 供应链策略(0.2.4 实测,含沙盒复现)

用户两次在 dsh-desktop 的插件管理里安装/更新都失败:

```
[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 3 lockfile entries failed verification:
  @jinsiyu/dsh-code-server-runtime-win32-arm64@0.2.0 published 2026-09-10T08:29:43Z, within the cutoff (…)
  @jinsiyu/dsh-code-server-runtime-win32-x64@0.2.0   published 2026-09-10T08:29:48Z
  dsh-code-server-app@0.2.3                            published 2026-09-10T14:05:51Z
```

### 11.1 复现方法(可复用)

把 `~/.dsh/profiles/desktop` 的 `package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml` 复制到 `%TEMP%` 沙盒
(必要时把 `desktop-packages/` 做成 junction,因为 `file:` 依赖指向它),用**应用自带**的 runtime 跑同一条命令:

```powershell
& "<app>\resources\runtime\node\node.exe" "<app>\resources\runtime\pnpm\bin\pnpm.mjs" `
  "--config.registry=https://registry.npmjs.org/" "--config.store-dir=$tmp\store" `
  "--config.enable-global-virtual-store=false" "--config.userconfig=$tmp\cfg\npmrc" `
  add dsh-code-server-app@0.2.4 --save-exact        # cwd 必须是沙盒目录(pnpm 用 cwd 当项目根)
```

### 11.2 结论:两个阶段行为不同(这是把它装上的关键)

| 阶段 | 是否读 `minimumReleaseAgeExclude` | 证据 |
|---|---|---|
| **校验已有锁文件**(`pnpm add` 最开始那步) | **不读**。精确版本、裸包名都试过,依旧违规 | 沙盒复现;`pnpm config get minimumReleaseAgeExclude` 能列出名单 |
| **解析**(没有锁文件可校验时) | **读**,而且 pnpm 会自己往 `pnpm-workspace.yaml` 追加条目 | 安装日志打印 *"Added 3 entries to minimumReleaseAgeExclude in pnpm-workspace.yaml"* |

- 这条 24h 是该 pnpm 构建(应用自带 **11.7.0**,DeepSeek 打过补丁)的默认;`SECURITY_POLICY_CFG_KEYS` 里的键
  (`minimumReleaseAge` / `…Exclude` / `trustLockfile` / `trustPolicy…`)**只从 workspace manifest 读**,
  写进应用那份 npmrc 无效(实测)。
- 把 `minimumReleaseAge: 0` 写进 manifest 的确能让校验通过(42 ms),但 `apps/desktop/src/project-manager.ts:297`
  只忽略 `minimumReleaseAgeExclude:` / `trustPolicyExclude:` 两个 policy 段,且每次 `mutate()` 前都会
  `verifyDesktopCorePackageSet(active)`,写这个键会让应用抛 *"core package mapping does not match desktop-packages.json"*
  —— **不能持久化**。
- CLI 路径本就不通:`dsh plugin --profile desktop …` 被拒绝(profile 由 Electron 独占);
  web profile 不受影响(它的 `pnpm-workspace.yaml` 是 `minimumReleaseAge: false`)。
- 应用的 `mutate()` 事务:先校验 active → `copyMetadata` 到 `staging/<uuid>/profile` → 在 staging 里
  `pnpm add <spec> --save-exact`(**就是这里被卡**)→ `hooks.healthCheck(staging)` → `activate()` 换入。

### 11.3 实际采用的安装步骤(成功,0.2.4)

1. 备份 active profile 的 `package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml`。
2. 在 profile 里 `pnpm clean --lockfile` —— **注意它会连 `node_modules` 一起删**(输出 "Removing node_modules"),
   profile 因此进入待重装状态;这一步是为了让事务/安装从"没有锁文件"的起点开始,从而走解析阶段。
3. 用应用自带 runtime 在 profile 目录执行
   `add dsh-code-server-app@0.2.4 --save-exact --trust-lockfile`
   (store/cache/state/config/home 都在 `~/.dsh/desktop/pnpm/**`;直接用 profile 自己的 store 才不会
   `ERR_PNPM_UNEXPECTED_STORE` / `…UNEXPECTED_VIRTUAL_STORE`)。624 包,1 分 18 秒。
4. 校验:依赖版本、`dsh.profile.bundles`、锁文件条目、以及 `lib/{index.js,client.js,launcher.mjs}`
   与发布 tarball **sha256 逐一相同**;应用启动用的
   `install --offline --frozen-lockfile --trust-lockfile` 可正常通过。
5. 重启应用,用户确认正常;随后 `promote 0.2.4` → `latest`。

> 备选路径:等满 24 小时再在插件管理里正常安装。因为平台原生子包与插件同批发布,
> **每次新版本在桌面端都会撞这条策略** —— 要么等一天,要么按上面第 2–3 步从干净起点装。

## 12. 0.2.5:改走官方文件交付与"地址认领"

### 12.1 官方新版文件交付栈(源码证据)

| 层 | 位置 | 事实 |
|---|---|---|
| 工具 | `packages/fs/tool-present/src/index.ts` | 一等公民工具 `present`,`files: [{path, description?}]`(默认上限 8),要求文件**已存在且是常规文件**;成功后 `session.append('deliverables/presented', {turn, callId, files})`(事件已登记进 `packages/core/session/src/known-event-types.ts`)。工具描述明确:*"在回复里提到路径不能替代这个调用"* |
| 回合数据 | `packages/client/ui-deliverables/src/client/turn-deliverables.ts` | `owner.turn.data.get('deliverables')` = `{ produced: {seq,path}[], presented?: PresentedPath[] }`;`produced` 来自本回合成功的 `write`/`edit`/可变 `str_replace_editor` 调用(不是正文),`PresentedPath = PresentedFile & {seq,index}`(授权坐标)。公开导出 `producedForClosing` / `selectProducedFiles` / `presentedForClosing` / `producedFileMentions` |
| 渲染 | 同上 `client/index.ts`、`Deliverables.tsx`、`ProducedFiles.tsx`、`PresentRow.tsx` | 三处:① 回合尾行 `conversation.chat.turnTail`(`select: selectDeliverables`)→ `ProducedFiles`(chips,≤6 + "还有 N 个")与 `PresentedFileCard`(预览 + 原生 open/reveal,>4 折叠);② `present` 工具调用行 `tool.call.toolview` key `'present'`;③ 正文内联提及服务 `ctx.provide('chatFileMentions', …)` |
| 打开(DSH 内) | `packages/client/ui-chat/src/client/apply.ts` | `openFile(path, {line?})` → 生成 `dsh-resource://file/session/<id>/<path>` → `ctx.sidebarRight.openResource(address)`。注释原话:**"哪个 tab 类型认领这个地址由右侧栏决定,不是这个调用点的决定"** |
| 打开(交给操作系统) | `packages/client/ui-deliverables/src/present-open.ts` | `POST /api/present.open?sessionId&seq&index&action=open\|reveal`(host 按坐标回读 `deliverables/presented` 做**授权** → `workspaceFiles.stat` → `fs.resolve` 校验 host 路径 → `sessionController.openWorkspacePath`),可用性 `GET /api/present.host` |
| 地址语法 | `packages/util/workspace-path/src/file-address.ts` | `dsh-resource://file/session/<sessionId>/<path>`(path 相对工作区或绝对,段做 component 编码、`:` 保持字面量)与 `dsh-resource://file/absolute/<path>`;查询串/片段忽略;页面 tab 的地址是 `sidebar://<kind>`(`ui-sidebar-right/src/client/contract/seed.ts`) |

### 12.2 认领机制(右侧栏 tab 注册表)

`ui-sidebar-right/src/client/tab-registry.ts`:

- `patterns`:**含 `:` 的 pattern 按整址 glob**(`dsh-resource://file/**`),不含则按 URI 路径 glob(`*.md` 任意深度);
- 排名:`band`(`extension` 3 > `builtin` 2 > `fallback` 1)→ 命中 pattern 长度 → 注册顺序;`canOpen(address)` 可否决;
- `openResource(address, {kind})` 指定 kind 时忽略 glob、只问 `canOpen`;`claim()` 找不到认领者会抛错(视为接线错误);
- 官方纯文本预览(`ui-sidebar-documentpreview`,`kind:'text'`)的注册是
  `patterns:['dsh-resource://file/**'] + priority:'fallback' + canOpen: parseFileAddress(address)?.scope==='session'`,
  其文件头注释写明:*这是 VS Code 文本编辑器在编辑器中的位次,任何更具体的类型都应当击败它* —— **官方明确留位**。

### 12.3 我们改了什么(0.2.5)

- `src/address.js`(新):`parseFileAddress`(与官方同语义,不依赖其包)/ `basenameOfAddress` / `resolveFilePath` /
  `claimsAddress`;纯字符串处理,便于离线单测。
- 注册:`patterns:['dsh-resource://file/**']`、`priority:'extension'`、
  `canOpen: address => claimsAddress(parseFileAddress(address), fileOpenScope())`、
  `title(address)`:页面地址 → `Code Server`,文件地址 → 文件名(末段解码)。
- body:从 `useTabInfo().tab.navigation.address` 解析会话与路径,优先用地址里的 `sessionId` 对齐工作区;
  相对路径按该会话 cwd 展开,连同可选 `navigation.params.line` 交给 `/api/code-server/open-file`。
- **删除** 0.2.4 及更早的耦合:不再注册 `conversation.chat.turnTail`(曾用 `priority:-9` 顶掉官方产物行)、
  删掉自绘产物列表(`TurnArtifacts`/`selectProduced`/`producePathList`/`OpenFileGlyph` 及其 CSS)。
- host:`Config.fileOpenScope`(`session` 默认 | `all`)+ `scope.watch` + `snapshot().fileOpenScope`;
  `/api/code-server/open-file` 接受可选 `line`(1 基,原样写进信号文件)。
- 扩展 `dshcs-open-file` 升到 0.0.2:支持 `{file, line}`(`showTextDocument` + `Range` 定位);
  安装器从"缺失才拷"改为**内容有变化即同步**(否则插件升级后已装的旧副本永远不会更新)。

### 12.4 仍然保留的机制,以及为什么

- **信号文件 + 树内扩展**:VS Code Web 没有"从外部打开某个文件"的官方 API(唯一入口是 `?folder=` 选工作区),
  所以"让 workbench 定位到某文件"只能由树内扩展完成。host 写信号、扩展每 800ms 轮询并 `showTextDocument`,
  失败保留重试(实例尚未就绪也不丢)。
- **`/api/present.open` 没被用**:它是"交给操作系统默认应用/文件管理器",不是"在 DSH 内打开";
  我们要的是后者,所以不需要它。

### 12.5 行为与取舍

- **一个地址 = 一个 tab**(`contentId` 就是地址,官方语义):打开三个文件会有三个 chip,但共用一个常驻 workbench
  (我们的 IDE 是单实例),切标签只是让 workbench 重新定位。
- **认领范围**默认 `session`:只认领会话作用域的地址;`all` 连 `…/file/absolute/…` 也认领。
  未认领的地址自动落到官方预览(官方那边 `canOpen` 会接住),不会出现"无人认领"的报错。
- 官方的产物行/交付卡片/正文提及现在都由**官方插件**渲染,我们只提供"文件在哪打开"这一个决定 ——
  官方 UI 改版时不再影响本插件。

### 12.6 回归

`.spike/spike-legacy-ui.mjs` 共 7 个场景全部 PASS(在既有 A/A2/B/C/D/D2 之外新增):

- **E**:tab 定义含 `patterns:['dsh-resource://file/**']`、`priority:'extension'`;
  `canOpen` 接受 session 地址、默认拒绝 absolute 地址、拒绝页面地址;`title` 对文件地址给文件名、对页面地址给 `Code Server`;
  guide 入口仍在;**不再注册 `conversation.chat.turnTail`**。
- **E2**:host 快照 `fileOpenScope:'all'` → `canOpen` 也接受 absolute 地址。

## 13. 0.2.6:设置瘦身、注释体检与死代码清理

### 13.1 设置瘦身(只留两个)

| 键 | 处置 | 依据 |
|---|---|---|
| `keepResident` | 保留(卡片行「后台常驻」) | 决定是否预热停放面 |
| `fileOpenScope` | 保留(卡片行「认领范围」) | 决定认领哪些文件地址 |
| `windowedOpen` | **删除**(schema + host 变量/watch/snapshot + 客户端草稿/保存/重置 + 整行 UI + 唯一使用者 `openExternalTab`) | 0.2.5 起官方文件点击链由 DSH 自己发起,"新标签页打开"只剩设置卡与 guide 入口两个入口,收益不抵一个设置项 |
| `reserveComposer` | **删除**(自 0.2.3 起已是只读的废弃键) | 只服务已删除的内部浮窗 |
| `serve` | 保留在 schema、**无卡片行** | 仍可用设置文档切换(删掉会让这样配置的用户静默回退 loopback) |

- **旧设置文档安全性(已核实)**:`settings.resolve()` 直接以 schema 调用合并后的值
  (`packages/settings/settings/src/index.ts:748`),而 schemastery 的 object 在非 strict 下把未知键
  `merge` 进结果(`vendor/schemastery/src/index.ts:752-762`)→ 文档里残留的 `windowedOpen`/`reserveComposer`
  既不报错也不生效,无需迁移代码。
- 行为变化(已写入 README):不再有"在浏览器新标签页打开"的入口;需要时直接访问回环地址
  (`serve: dsh` 时为 DSH 的 `/code-server/`)。

### 13.2 注释体检

删掉版本考古与重复叙述,并把最长的文件头压缩(动作与结果):

| 文件 | 头/最长块 | 处置 |
|---|---|---|
| `lib/index.js` | 41 行头 | 压到 13 行;**修正过时断言**——原文写"auth=none 仅允许回环 host;非回环强制 password",实现是 0.2.0 起不再支持口令(`index.js` 里对 `auth: 'password'` 只告警并按 none 运行) |
| `src/factory.js` | 29 行头 | 压到 12 行;删 `priority:-9` 劫持、0.2.3/0.2.5 考古;`sidebarBridge` 注释由"产物按钮/设置卡"改为"设置卡/guide 入口";能力探测与 turnTail 两处历史注释各压一行 |
| `src/surface.js` | 23 行头 | 压到 11 行(保留两条实测事实);`dockInto` 注释删"浮窗里的占位 div" |
| `src/address.js` | 143 行/58 行注释 | 头压到 8 行;10 个函数的 JSDoc 收敛为单行(保留地址语法摘要) |
| `lib/launcher.mjs` | 21 行头 | 压到 12 行(保留用法与就绪信号) |
| `lib/native.js` | 写"只做两件事"却列三条 | 改为"三件事" |
| `scripts/vendor-repacks.mjs` | 26 行头 | 压到 15 行(删 argon2 括注与"结果:"段) |
| `scripts/build-client.mjs` | 含版本考古 | 删"0.2.3 删除浮窗后不再内嵌 motion",补上 `./address.js` |

### 13.3 死代码清理(逐项证据 = 全仓引用计数)

| 符号 | 位置 | 证据 | 动作 |
|---|---|---|---|
| `openExternalTab` | `src/factory.js` | 唯一调用者(产物行)已删 | 删 |
| `bundledRuntimeEntry` | `lib/index.js` | 零引用 | 删(连带其唯一使用者 `codeServerEntry` 的 import) |
| `wasRunning` | `lib/index.js` `stop()` | 计算后从未使用 | 删该行 |
| `isVscodeOnlyTree` | `lib/vendor.js` | 仅历史文档提到 | 删 |
| `codeServerTarget` | `lib/vendor.js` | 零引用 | 删 |
| `codeServerEntry` | `lib/vendor.js` | 删除 `bundledRuntimeEntry` 后零引用 | 删 |
| `SCOPE_ALL` / `isAbsoluteFilePath` | `src/address.js` | 仅文件内使用 | 取消导出(常量/函数保留) |
| `.dshcs-hint` 重复定义 | `src/factory.js`(主 CSS 与 CARD_CSS) | 同名选择器两处定义,后者覆盖前者 | 卡片那份改为 `.dshcs-card .dshcs-hint`,不再全局覆盖 |

复核后**不是**死代码(未删):`.dshcs-cbtn*`(拼接字符串使用)、`.dshcs-frame`/`.dshcs-park`(`src/surface.js` 使用)、
`surface.js` 的调试导出(`nudgeRepaint`/`setNudgeEnabled`/`setParkStrategy`/`getParkStrategy`/`destroySurface`,对应 README 的 `window.__dshcsSurface`)、
`index.js` 的 `handleSetup` 兼容路由与 `auth: 'password'` 告警。

### 13.4 回归

`.spike/spike-legacy-ui.mjs` 场景 B 增断言:卡片含「认领范围」「后台常驻」、**不含**「窗口化打开」;
认领范围下拉的选项恰为 `session`/`all`;客户端产物里 `windowedOpen|reserveComposer` 归零。
(测试桩升级:元素树遍历现在会显式调用函数组件以求值 —— 桩不渲染组件,`csSelect` 这类纯组件的内部结构
此前看不见。)

### 13.5 卡片再精简(0.2.7):只留两个设置

用户确认"卡片里只保留后台常驻与认领范围",于是把卡片上剩下的三行也删掉:

| 行 | 处置 | 去处 |
|---|---|---|
| 「入口」+「在右侧栏打开」按钮 | 删 | 入口本就由右侧栏「开始」页的 guide 入口框提供;官方文件点击也直接开 tab |
| 「依赖安装」(静态说明) | 删 | 内容(依赖由包管理器安装)已在 README「安装插件」章节 |
| 「环境检测」(按钮 + 状态 + 运行位置/卸载提示) | 删 | `/api/code-server/status` 的 `env` 字段仍返回同样信息;host 日志有 `[code-server]` 输出 |

连带清理(都因失去唯一读取者而变成死代码):
- `sidebarBridge`(`{ openTab }` 桥接:定义、赋值、卸载复位三处)—— 入口按钮是它最后的调用方;
- store 里的 `sidebarActive` 字段(初始值 + 两处 `setState` 写入;卡片里那个局部变量也一并删掉)——
  载体状态现在由 `sidebarUi` + `sidebarRegisterFailed` 两个字段表达;
- 空态文案里"请到设置卡点「检测环境」"改为"查看 host 日志的 `[code-server]` 输出"。

体积:客户端 37 721 → 33 765 B。回归新增三条断言(不含「依赖安装」「环境检测」「在右侧栏打开」)。

## 14. 0.2.8–0.2.11:三个线上 bug、打开即全屏、认领类型

0.3.x 那条线(命名管道传输 + 资源镜像)整体回退后,回到 0.2.7 基线继续走 0.2.x。

### 14.1 0.2.8:排查确认的三个 bug

| 编号 | 现象 | 根因 | 修法 |
|---|---|---|---|
| B3 | IDE 未就绪时加载到的错误页(503/连接失败)一直粘在 iframe 上,点重启也不重新加载 | `buildPageUrl` 只拼 `?folder=<cwd>`:URL 不变 ⇒ 组件判定"同址"不导航 | URL 固定带实例标记 `?s=<pid|startedAt>` |
| B6 | 预启动与用户点击并发时双开 launcher,第二个进程绑不上端口,状态被顶成 `error`("端口被占用") | `maybePrestart()` 与点击都走 `start()`,写同一份 `pid.json` | `start()` 串行化(一条 promise 链),第二个调用复用第一个的结果 |
| B1 | 升级插件后渲染器仍跑旧 bundle(18MB 的 workbench.js/css 按稳定 URL 取缓存) | launcher 用 `url === '/'` 判断文档路由,而客户端永远带查询串(`?s=…&folder=…`)⇒ HTML 改写从未生效 | 路由统一按 `url.split('?')[0]` 匹配;HTML 缓冲改写给 `workbench.(js|css)`、`nls.messages.js` 加 `?v=<tag>`(tag = 插件版本 + 树) |

回归:`scripts/test-launcher-routes.mjs`(5 项,修复前必挂)+ `scripts/test-plugin-apply.mjs`(桩 ctx 冒烟)。

### 14.2 0.2.9 / 0.2.10:打开 Code Server 标签即把右侧栏切到全屏

- 需求:打开的 IDE 只有铺满窗口才够用,设置项默认开。
- **接口边界(实测源码)**:`ctx.sidebarRight` 只开放 `isExpanded`/`toggleExpanded`(展开/收起),
  push ⟷ fullscreen 这个"模式"记在 `ui-sidebar-right` 自己的 store(`actions.setMode`),只发给它的
  seat 内部组件;`ctx.layout.openRightbar(track, fullscreen)` 不是控制面,而是 seat **汇报**
  presentation 的通道(上游注释:*the occupant reports it; nothing else writes it*)。
- 因此实现是"复刻用户的动作":`closest('[data-sidebar-right-panel]')` 定位自己所在面板,点面板 chrome 上的
  `[data-sidebar-right-mode="fullscreen"]`(`src/sidebar-mode.js`,六种结果都回报、绝不抛错)。
  契约在两版上游源码里核对:0.1.5-rc.1(desktop)/ rc.2(web)都具备这两个属性,且 chrome 由
  `DockSurface` 内联渲染(整包只有 tab 菜单走 `createPortal`)。
- 触发时机 = 本标签"变得可见"的那一刻(打开/切回/重新展开),每个可见周期只切一次 ⇒
  用户点「退出全屏」不会被抢回去。
- 0.2.10 修 0.2.9 的一处抢跑:`status` 由 fetch 异步填充,原判据把"未知"当成"开" ⇒
  页面刷新且标签被恢复时,即使设置关着也会切一次;改为 `status != null && status.fullscreenOnOpen !== false`
  (未知不动作,值到达后由依赖变化补一次)。

### 14.3 0.2.11:认领类型取代认领范围

- 旧:`fileOpenScope`(`session` 默认 | `all`)—— 按**作用域**决定认领。
- 新:`claimExtensions` —— **不区分作用域**(session/absolute 一视同仁),只按**扩展名**决定;
  设置卡里是一个文本框,分号分隔(`,`/空白/换行也认;`py`、`.py`、`*.py` 等价;大小写不敏感):
  `*` = 其余类型也认领,`!ext` = 不认领(**排除优先**),空文本 = 不认领任何文件。
- 默认 `*;!md;!markdown;!html;!htm;!png;!jpg;!jpeg;!gif;!webp;!bmp;!ico;!svg;!pdf`:
  把 DSH 自带预览(`ui-sidebar-documentpreview`,`priority: fallback`,内部按扩展名分派
  markdown / html / 图片 / PDF / 代码高亮 / 纯文本)渲染得好的四类留给它,其余全进 IDE。
  未知扩展名默认进 IDE(反过来的白名单会让 `.zig`/`.vue` 这类静默落到只读预览)。
- 单一事实来源:`lib/claim-types.js`(host `Config` 默认值与客户端 `canOpen` 共用,随包发布),
  单测 `scripts/test-claim-types.mjs`(9 项)。
- 顺带:`ctx.sidebarRight.openTab(kind)`(guide 入口框那条路)不查 `canOpen`(`placeTab` 只要求 kind 已注册),
  所以收紧 `canOpen` 不会影响页面 tab 的入口 —— 已在上游源码核对(rc.1 `client.js` 的 `placeTab`)。

### 14.4 0.2.12:切工作区不再重启进程(轻量切换)

- 现象(用户报):"切换工作区时,code-server 的工作区也在后台切换" —— 跟随本身是有意的(用户明确保留),
  问题在**代价**:`startInner` 发现 `cwd !== state.cwd` 就 `stop('restart')` + 重新 launch,
  整进程重启(扩展宿主/终端/服务端状态全丢);而侧栏收起时 panel 只是滑走 + `visibility:hidden`,
  标签 body **没有卸载** ⇒ 这件事发生在用户看不见的后台。
- 关键事实:工作区目录由**客户端 URL 的 `&folder=<绝对路径>`** 决定(`buildPageUrl`);服务进程的 cwd
  只通过 spawn 的 `cwd`(→ launcher 的 `VSCODE_CWD`)影响它自己对相对路径的解析 ⇒ 换目录**不需要**重启进程。
- 改法:`adoptWorkspace(cwd)` —— 运行中(含 `starting` 结算后已 running)只更新 `state.cwd` 并返回快照;
  客户端侧 url 变化本来就会让常驻面重新导航(`ensureSurface` → `setSurfaceSrc`)。
  新增 `status.launchCwd`(进程启动目录,诊断用;三条 adopt 路径都填),`stop` 时清空。
- 代价(README 已明说):旧目录里由 IDE 拉起的后台进程/终端不再被自动收走(以前是"重启顺带杀掉")。
- 回归:`scripts/test-workspace-switch.mjs` —— 用真实活进程当"IDE"(spawn 长活子进程 + 只回 200 的
  `/healthz` + pid.json)走真实路由,断言 cwd 跟随、pid 不变、进程存活、同目录幂等、无 cwd 不切换;
  实测把 `adoptWorkspace` 改回 `stop('restart')` 时 ①②④⑤ 必挂。

### 14.5 0.2.13:树升级到 code-server 4.137.0(VS Code 1.137.0)+ 两处工具链修正

- 版本:`vendor:check` 报内置 4.136.2 / 上游 4.137.0(2026-09-11 发布,changelog 仅 "Update to Code 1.137.0"
  与 "Windows releases are now available");升级后 `productPath=stable-b11dabdaca0d3369986975be285db92c8795cea5`,
  树 197.9 MB。
- **升级前兼容性预检(只读,不重建 197MB 树)**:把 4.137.0 的 npm 包(53.4 MB)拉下来逐项核对 ——
  `loadCodeWithNls` 的导出形态逐字同构(`process.env.CODE_SERVER_PARENT_PID||…;export{X as loadCodeWithNls}`)、
  `createServer`/`handleRequest`/`handleUpgrade`/参数名全在、`workbench.html` 的资源引用两版逐字相同
  (我们的 `?v=` 改写依赖它)、code-server 自身 20 个依赖无变化、树内 50 个依赖仅 13 处版本跳动且**原生包无变化**
  ⇒ 判定为低风险,可走 `--reuse` 路径(不重新编译原生包)。事后证明预检准确。
- **vendor 脚本源树优先级修正**:修正前 `defaultSourceTree()`(profile 里的旧树 → `vendor/code-server`)
  会抢在 registry 之前,即使给了 `--force`/`--version` —— 这正是"内置树一直停在 4.136.2、`vendor:latest`
  却没取到 4.137.0"的原因。现在:显式 `--from` 用给定树;显式 `--force`/`--version` 一定走 registry;
  两者都没有才复用本机源树。
- **依赖 pin 同步**:`--reuse` 的纯 JS 直装集是从插件 package.json 现读的,所以先按新树更新 pin。
  用"仅当现有 pin 不满足新范围才动"的规则,得到 10 个 `@xterm/*` beta 跳号;
  若无脑"去 ^ 取值"会把 `cookie 0.7.2→0.7.0`、`ws 8.21.0→8.19.0`、`tar 7.5.22→7.5.20`、
  `node-addon-api 6.1.0→6.0.0` 四处**降级**(它们本来就满足新范围)—— 已避免。
- 发布:`@jinsiyu/dshcs-vscode-server@4.137.0`(50.8 MB)+ 两个平台聚合包 `0.2.13`
  (聚合包版本跟插件版本走,所以 bump 插件版本必须在 repack 之前);
  x64 聚合包在 registry 上比 arm64 晚几分钟才可见(publish 返回 "being processed"),重查即可。

### 14.6 0.2.14:随机端口 + 路径令牌 + Host 白名单(回环端口加固)

- 需求(用户):"随机化通信端口并加强安全"。
- **为什么不能用 VS Code 自带的 `connection-token`**(读树确认):它靠 `?tkn=` → 302 +
  `Set-Cookie: vscode-tkn; SameSite=Lax`(server-main.js `_handleRoot`)。桌面端 iframe 是**跨源**的
  (`dsh-app://` → `127.0.0.1`),Lax cookie 在跨站子框架里不会被带上 ⇒ 一走 cookie 就把 desktop 打挂。
  (其 token 格式校验 `/^[0-9A-Za-z_-]+$/` 我们沿用了。)
- **改用 URL 路径前缀**:`http://127.0.0.1:<port>/<token>/…`。workbench 的资源与 WS 全部由
  `location.pathname` 派生(`serve: dsh` 挂在 `/code-server/` 下已证同一机制),前缀天然跟随所有子请求与
  WS 握手,不需要 cookie/header 注入,客户端代码也不用改(它只用 `status.url`)。
- **端口随机化**:`port` 默认 `0` → 系统分配;launcher 把实际地址原子写进 `endpoint.json`,host 读回后才
  开始就绪轮询,并把实际端口补写进 `pid.json`。固定端口仍可用(显式配 `port`),此时"端口被占用"的
  adopt/报错分支保留(探针带令牌)。
- **Host 白名单**:回环模式只接受 `127.0.0.1|localhost|[::1]:<实际端口>`。补的是 `originAllowed()` 的缺口
  —— 它对"不带 Origin"的请求放行,而 DNS rebinding 恰好能构造这种请求。
- **令牌传递**:文件(`$DSH_HOME/code-server/path-token`,原子写 0600)而非 argv(命令行本机任意进程可见);
  日志不打印令牌;文档响应加 `Referrer-Policy: no-referrer`。
- **adopt 语义收紧**:host 重启后接管需要"pid 存活 + 令牌文件在 + endpoint 记录的端口上 /healthz 带令牌响应",
  缺一不接管(陌生占用会被当成冲突报错,而不是误杀)。
- 验证:
  - `scripts/test-launcher-routes.mjs` 扩到 9 项(端口 0 → endpoint 回报、无令牌/错令牌 404、少斜杠 302、
    伪造 Host 403、文档改写与 `?v=`、healthz 回报实际端口、前缀下 manifest/_static);
  - `.spike/probe-token-iframe.mjs`(真 Edge + CDP,跨源 iframe + 随机端口 + 令牌):workbench 渲染成功
    (`hasWorkbench`、23 个样式表)、`workbench.js?v=` 生效、launcher 记录到前缀下的两次 WS 握手、无控制台错误
    —— 这是"不用 cookie"这条设计的关键证据;
  - `test-workspace-switch.mjs` 补写令牌文件(host 的探针/接管读它)。

## 15. 0.3.x 编辑器桥(agent 与编辑器之间的只读通道)

> **版本号为什么跳到 0.3.6**:能力本身落地为 0.3.0,但 0.3.0(随后 0.3.1)在 npm 上被拒:
> `E400 Cannot publish over previously published version`,而同一时刻 `dist-tags` 的
> `latest`/`next` 都还停在 0.2.14、packument 的 `versions` 里也没有任何 0.3.x 正式版 ——
> 即"版本号已存在但不可见"。用户据此把这些版本删掉后,0.3.0/0.3.1 依旧是同样的 400
> (npm 对已发布过的版本号不回收),于是按 patch 前进到 **0.3.6** 发布、随后又前移到 **0.3.7**
> (见 15.8 的事故),`latest` 始终保持不动。下文说的"0.3.0 起"就是本节这套能力。

- **需求(用户)**:"vscode 常见的 ai 辅助插件能做什么?我需要一个方案让 dsh 与 code-server 更紧密地协同"。
  结论落在"补编辑器侧的高保真上下文与交互入口":code-server 的开源树里 Chat 外壳、agent 框架、审批、
  MCP、终端工具、diff 审阅都在,缺的只有模型/agent loop —— 那是 DSH 已有的 —— 以及**只有编辑器才知道的
  信息**(未保存缓冲区、语言服务器诊断、活动选区)。
- **需求边界(用户选择)**:只做路线 A(上下文 + 交互闭环);`chatSessionsProvider` 原生智能体会话、
  `languageModelChatProviders` 自带模型、行内补全、MCP gateway 全部**不做**,但保留接口位。

### 15.1 一个被实测推翻的中间设计(值得记下来)

第一版设计是"host 反向 GET 扩展的 HTTP 面"(`/bridge/context`、`/bridge/diagnostics`)。写出来才发现:
**扩展宿主不监听任何端口** —— 它是 VS Code server 的子进程,只是一个 Node 进程。host 无从调用它。

改成"扩展在轮询里把状态推上来"之后反而更简单:
- 只剩四条路由(`health` / `sync` / `ask` / `event`),没有"两个方向的 HTTP"这种不对称;
- 状态缓存天然最新(每趟轮询刷新一次),不需要 host 侧再维护"上一次拉取";
- 事件与状态共用一趟来回(带上 `?since=` 拿事件),扩展侧不需要第二个定时器。

代价是状态最多滞后一个轮询周期(600ms),以及需要一条"过期"判据(10s 没更新就明说,而不是把旧数据
当新数据)。这两条都写进了 README 的已知限制。

### 15.2 判定顺序:Origin 必须先于令牌(测试抓到的真实缺口)

`bridgeGuard` 第一版写的是"带 Origin 且 origin !== '' 且 origin !== 'null' → 403"。写测试时用
`new Request(url, { headers: { origin: 'null' } })` 做断言,结果是 401 而不是 403 —— 两个原因叠在一起:

1. **undici 把 `origin` 当 forbidden header 归一化掉了**:`new Request(...)` 里根本读不到它。
   所以这组断言只能用裸 headers 对象(测试里专门留了一条注释与一组裸 headers 用例)。
2. 顺手修了一个真缺口:`Origin: null` 是**沙箱 iframe / data: 页面的字面量取值**,同样是浏览器,
   必须拒。

还确立了顺序本身的意义:Origin **先于**令牌判定。反过来的话,一个网页就能通过"401 还是 403"区分
"令牌错了"与"Origin 不对",等于给它一个爆破 oracle。

### 15.3 通道选择:为什么不是 SSE/WS,也不是 MCP

- **`ctx.connection.fetch.register` 的 methods 只允许 `GET | HEAD | POST`**(`dsh-client-connection`
  的 `ConnectionFetchRoute` 定义),流式要另走 WS mux,而 `/api/remote.mux` 已被 `dsh-api-gateway`
  用 `rpc.intercept('/api', …)` 占住(再注册会抛)。
- **MCP 反向不行**:`dsh-mcp-client` 只实现 `stdio` 与 `streamable-http`,且只有 `tools/list` +
  `tools/call` 两个方向 —— 它能让编辑器**提供工具**,但**不能观察** agent 的活动,而"agent 改了哪个文件"
  正是本项目要的。而且 MCP 需要额外配置一个 server 进程,而桥是零配置的。
- **`ctx.on('tools/result')` 才是观察点**:它注册在根上下文,而 `dsh-scope` 的载体过滤是
  `tag === undefined → true`(`dsh-scope/lib/index.js` 的 `scopeTarget`),所以**一个监听器能看到
  所有 agent 与子 agent 的调用**,不需要为每个会话挂钩子。

### 15.4 改动抽取的两条路径(profile 差异)

同一件事在 DSH 里有两个工具来源,只做一条就会在别的 profile 上失灵:

| 工具 | 结果元数据 | 抽取方式 |
|---|---|---|
| `dsh-tool-fs` 的 `write` / `edit` | 带 `FsDiffMeta {diffs: FileDiff[]}`(`presentationMeta` 产出) | 读 `result.meta.diffs[].path` |
| `dsh-tool-str-replace-editor` | **不带 meta**(output schema 只有 `{type:'string'}` + `render`) | 从 `exec.arguments.file_path` / `.path` 取,并跳过 `command === 'view'`(只读) |

当前 profile 只挂了 `tool-fs`(`dsh-base/cordis.patch.yml` 里没有 str-replace-editor 的行),
但两条路径都实现了 —— 换 preset 时不会突然"agent 改了文件而编辑器毫无反应"。

### 15.5 只读是硬约束,不是措辞

令牌文件(`<extensionsDir>/.dshcs-bridge/bridge.json`)对本机同用户进程可读,所以命名空间的爆炸半径
必须被封死。落地方式有三层:

1. **代码上**:四条路由没有任何写文件/改文档/执行命令的能力;`/ask` 也只投递一条消息。
2. **测试上**:`scripts/test-bridge-routes.mjs` 有一条白名单断言 —— `bridge/*` 下的路由必须**恰好**
   是那四条,且路由名里不允许出现 `write|edit|exec|run|shell|apply|save|delete|remove|create`。
   新增只读路由要显式改白名单(逼着人重新想一遍"这是只读的吗")。
3. **文档上**:README 双语都写了四条不变量与"这一层挡什么、不挡什么"。

### 15.6 未保存缓冲区:只提醒、只 diff,不接管

agent 的读写仍然全部走它自己的 `fs` 工具(按磁盘内容),桥不介入数据面。所以"用户有未保存改动"这件事
只能通过**降低伤害**来处理,三个点各管一段:

| 时机 | 手段 | 实现 |
|---|---|---|
| 写之前 | 附一条提示(不阻断、不改入参) | `tools/pre-execute` 里 `exec.deferContext(...)`。**`PreToolDecision` 明确排除入参改写**(参数已进日志与展示),所以"提醒"是唯一正确的介入方式 |
| 写之后 | 开原生 diff | 左栏是 `dshcs-old:` 只读虚拟文档(文本放内存 store,URI 只放 sha256 key —— 把整份文件塞进 URI query 会被 workbench 截断),右栏是**真实的 file: URI**,于是撤销/编辑全走 VS Code 常规路径 |
| 冲突时 | 非模态告警,绝不覆盖 | 该文档 `isDirty` 时弹 `showWarningMessage`,选项只有"查看差异 / 忽略" |

### 15.7 回归

- `scripts/test-bridge-routes.mjs`(18 项):路由表 + 只读白名单、Origin 优先于令牌(含 `Origin: null`)、
  401 与 503 的语义区分、令牌头名三处一致(host 常量 / 扩展常量 / 测试字面量)、status 快照不含令牌、
  配置原子写与坏配置视为未配置、事件环形缓冲有界、上下文缓存新鲜度、请求体上限、`dsh-resolve` 不抛、
  真 `defineTool` 注册两个工具并渲染,以及两条针对 15.8 事故的守卫(动态代理用例 + 源码级检查)。
- `scripts/test-bridge-extension.mjs`(17 项):未保存缓冲区上报(含无标题占位)、诊断工作区收敛 /
  排序 / 截断、`agent 改动行数不猜`(只有一侧时 `added/removed` 为 null)、diff 缓存 LRU、
  扩展侧配置只接受回环 + 合法令牌、休眠时一个请求都不发、`sync` 带令牌头且游标前进、
  写操作抽取三条路径、投递文本组装、无会话时 `NO_AGENT` 而不是抛异常、选中 agent 收到 `followup`。
- **测试隔离**(踩过一次):第一版 `test-bridge-routes.mjs` 没设 `DSH_HOME`,于是 `apply()` adopt 了
  开发机上**正在跑的那个实例**,断言全错、还改写了真实的 `bridge.json`。现在脚本把 `DSH_HOME` 指向
  临时目录,并在最后加一条"隔离自检"断言真实配置一字未动。

### 15.8 事故:0.3.6 让 dsh web 起不来(DSH 服务只能经 ctx.get 获取)

- **现象**:把 0.3.6 装进 web profile 后 `dsh web` 直接退出,报
  `dsh: plugin tree failed to load: failed to apply loader entry code-server (dsh-code-server-app)`,
  底层是 `cannot get property "systemPrompt" without inject`。用户先把 `code-server` 行禁用它才启动起来。
- **根因(一行代码)**:`lib/bridge-tools.mjs` 的 `registerEditorPrompt` 写的是
  `ctx?.systemPrompt ?? ctx.get('systemPrompt')` —— cordis 的 Context 代理里 **属性访问是可能抛的**
  (`cordis/src/reflect.ts:144` 构造 `cannot get property "x" without inject`,再由 `internal/get`
  瀑布 / accessor / `reflect.get(prop, false)` 决定是否真的抛出去)。可选链只挡 `null`/`undefined`,
  **挡不住抛错**,所以 `??` 右边的 `ctx.get()` 永远没机会执行。它又恰好在 `apply()` 里,
  loader 判定 entry 应用失败 → 终止整棵插件树 → 进程退出。同一缺陷在
  `lib/bridge-session.mjs` 的 `ctx?.agents` 上还有一份(那条在路由回调里,代价是 500)。
- **判定依据(实测,不是推断)**:裸 `Context` 里属性访问未必抛(服务已 provide 时返回对象),
  所以只读源码很容易低估——我第一轮探测就得到"不抛"的结论,直到确认 `ctx.get()` 走的是另一条路:
  `ReflectService.get → _getImpl`,服务没提供时**返回 undefined、永不抛**。
  工程结论:**`ctx.<service>` 只对已声明 `inject` 的服务安全;其余一律 `ctx.get()` + 判空。**
- **修复(0.3.7)**:两个文件各加一个 `getService()`(`ctx.get` + try/catch),三处服务获取全部改走它;
  `registerEditorPrompt` 对 `section()` 的调用也加了保护(注册失败只 `console.warn`,不影响其余能力)。
- **回归怎么防(两条,一条动态一条静态)**:
  ① 动态:一个**属性访问会抛**的代理上下文,跑过 `registerEditorPrompt` / `registerEditorTools` /
  `registerBridgeObserver` / `deliverEditorPrompt` 四个入口,并断言全过程没有出现过属性访问;
  ② 静态:直接扫源码,凡 `ctx.<服务名>` 写法一律判失败(列了 11 个已知服务名,注释与 import 跳过)。
  **②是必需的**:①在裸 cordis 下抓不住原始写法(那时属性访问不抛),而这条错误的代价是**整机起不来**。
  已实测:把旧写法注入回 `bridge-tools.mjs` → ②立刻 FAIL;还原 → PASS。
- **教训(与 0.2.4 的 desktop 事故同类)**:桩 ctx 测试通过 ≠ 真环境通过。这类"加载期即刻致命"的写法
  没有任何运行时兜底,必须静态检查 + 真环境冒烟**两者一起**守;也只有真启动一次才能发现它,
  所以任何改动 `apply()` 路径的版本都必须先在隔离 DSH_HOME 里 boot 一次再发。

## 16. 桌面端安装报 `resolves tslib outside its owned packages`(0.3.8)

用户在 dsh-desktop 的插件管理里安装(裸包名 → 拉到 `latest` = 0.2.14)失败:

```
Error invoking remote method 'dsh-desktop:plugins-add': Error: desktop profile:
dsh-code-server-app -> @microsoft/1ds-core-js -> @microsoft/applicationinsights-core-js
resolves tslib outside its owned packages
```

### 16.1 复现(沿用 §11.1 的沙盒法)

把真实 profile 的 `pnpm-workspace.yaml` 复制进沙盒,用**应用自带**的 runtime(node 24.17 / pnpm 11.7.0)
跑同一条 `pnpm add`,再用应用自己的 `apps/desktop/src/profile-packages.ts` 原样校验(只读):

```powershell
# 只读诊断:应用自己的 validateDesktopPluginGraph + 一遍全闭包 inventory
node .spike\desktop-install-0.3.8\inspect-graph.mjs `
  "$env:USERPROFILE\.dsh\profiles\desktop" `
  "<app>\resources\dsh" dsh-code-server-app
```

原样复现出用户那条报错。**但 inventory 显示闭包里还有别的硬伤** —— 下面三层原因要一起看。
原始输出与全部探针脚本归档在 `.spike/desktop-install-0.3.8/`(见该目录 `summary.md`)。

### 16.2 三层原因(先串成一条报错,修掉一层才露出下一层)

| # | 层 | 现象 | 归属 |
|---|---|---|---|
| 1 | `tslib` 没装 | `@microsoft/applicationinsights-core-js@2.8.15` 把 `tslib` 声明为**非可选 peer**(`peerDependencies.tslib="*"`),而桌面 profile 的 workspace 写死 `autoInstallPeers: false` ⇒ 没人装它;Node 于是解析到 profile 外的 `~/.dsh/profiles/node_modules/tslib` ⇒ 校验器判"依赖越界" | 本插件(已修) |
| 2 | 同一条 registry `add` 把可选运行树的**同平台**依赖一起跳过 | 0.2.14(peer `tslib` 未满足)→ `.modules.yaml` skipped **105** 条,node-pty/koffi/ssh2/cpu-features/@parcel/watcher/… 全缺;0.3.8(声明 tslib 后)→ **35** 条(全是正确的跨平台变体),包全齐。CLI 的 11.25.0 对两版都正常 ⇒ **① 的修复把 ② 一起消掉了** | 本插件(随 ① 一起修掉) |
| 3 | 校验器解析不了与 Node 内建同名的依赖 | `packageFrom()` 用 `createRequire(...).resolve.paths(name)`;该 API 对**核心模块名**(`buffer`/`util`/`events`/`stream`/`string_decoder`/`process`…)返回 `null`,`?? []` 之后直接返回 undefined ⇒ 已装好的包被判 `requires missing buffer@^5.5.0` | 桌面端上游(**仍需修**) |

**① 的修复(已落地并发布)**:把 peer 显式升为直接依赖 —— `"dependencies": { "tslib": "2.8.1", … }`,
版本 0.3.7 → **0.3.8**(`next`)。运行时其实**没有任何代码** `require('tslib')`(实测该闭包 0 处 import),
但桌面校验器判的是**声明闭包**,peer 也必须在 profile 内被满足。

**② 的证据**(应用自带 pnpm 11.7.0、同一沙盒、同一命令、warm store,背靠背三跑):

| 跑 | 版本 | `@jinsiyu/dshcs*` skipped | 总数 | node-pty/koffi/ssh2/cpu-features/@parcel/watcher | tslib |
|---|---|---|---|---|---|
| a1 | 0.2.14 | 17 | 105 | 全缺 | 缺 |
| a2 | 0.3.8 | 8 | 35 | 全在 | 在 |
| a3 | 0.2.14 | 17 | 105 | 全缺 | 缺 |

即"缺包"这个现象由 **peer 未满足**触发,与 pnpm 版本叠加:11.25.0 下两版都正常(35 条),
11.7.0 下只有声明了 tslib 的 0.3.8 正常。触发面还受安装方式影响(`add <tarball>` 与
`install --frozen-lockfile` 都不触发),所以**不要**把 11.7.0 的行为单独当成根因。
修好 ① 后 registry `add dsh-code-server-app@0.3.8` 在 11.7.0 与 11.25.0 下都得到完整 profile
(已用发布版实测,两次都 +node-pty … +tslib),所以 **② 不需要额外改桌面端**。

**③ 的证据**:一个"依赖全装齐 + ① 已修"的 profile,原版校验器仍 FAIL,报的就是
`bl requires missing buffer@^5.5.0`;把 `packageFrom` 换成"先 `resolve.paths`,为 null 时逐级向上找 `node_modules`"
后同一 profile **PASS**(窄版与宽版两种改法都实测 PASS)。本闭包命中两个核心模块名依赖:
`buffer <- bl`、`string_decoder <- readable-stream`(链路:运行树 → kerberos → prebuild-install →
tar-fs → tar-stream → bl),链路本身无法在插件侧消除,只能上游修:

```diff
 function packageFrom(anchor: string, name: string): string | undefined {
   if (!PACKAGE_NAME.test(name)) throw new Error(`desktop profile: invalid package name ${name}`)
-  for (const modules of createRequire(join(anchor, 'package.json')).resolve.paths(name) ?? []) {
+  // resolve.paths() returns null for names that are Node core modules (buffer, util, events, …):
+  // such a package is still an ordinary dependency, so walk the ancestor node_modules directories.
+  const searched = createRequire(join(anchor, 'package.json')).resolve.paths(name) ?? []
+  const candidates = [...searched]
+  if (searched.length === 0) {
+    for (let dir = anchor; ;) {
+      candidates.push(join(dir, 'node_modules'))
+      const parent = dirname(dir)
+      if (parent === dir) break
+      dir = parent
+    }
+  }
+  for (const modules of candidates) {
     const path = join(modules, name)
     if (existsSync(join(path, 'package.json'))) return realpathSync.native(path)
   }
   return undefined
 }
```

补丁文件:`.spike/desktop-install-0.3.8/desktop-profile-packages-core-modules.patch`(`git apply`,从仓库根)。
(等价修法:核心模块名直接视为已满足 —— 反正 Node 运行时用的就是内建实现。)
**只要 ③ 没修,当前桌面构建就装不上这个插件**:③ 与插件版本无关,任何包含 `buffer` 这类依赖的闭包都会命中。

### 16.3 现场恢复(profile 卡在 pending)—— 0.3.11 之后的最终步骤

失败的事务把 `~/.dsh/profiles/desktop` 留在"装了旧版、但有 `desktop-packages-pending`"的半成品状态
(那份 `node_modules` 缺 tslib 与运行树的一堆同平台包)。启动流程是:`backend.start()` →
`assertProfileRuntime()` 抛 *"package preparation is incomplete"* → `applyRelease()` 走 pending 重建分支
(删 `node_modules` + `install --frozen-lockfile`)→ `finishPackageOperation()` 里两次校验。
**0.3.11 之后不需要任何桌面端补丁**,只要把 profile 里的插件换上去:

1. 关掉桌面端,用应用自带 runtime 在 profile 目录升级插件(§11.3 的做法:store/cache/state 都用
   `~/.dsh/desktop/pnpm/**`,否则 `ERR_PNPM_UNEXPECTED_STORE` / `…UNEXPECTED_VIRTUAL_STORE`):
   `add dsh-code-server-app@0.3.11 --save-exact --ignore-scripts`;
2. 直接启动应用:pending 分支会重装并校验,通过后自己删掉标记;
3. 想先核对,就在 profile 目录再跑一次 `install --frozen-lockfile --ignore-scripts`,确认
   `node_modules` 里 `tslib`/`node-pty`/`koffi`/`sqlite3` 都在,且没有 `prebuild-install`/`buffer`。

> 历史备注:0.2.14 那一步必须先修 ③(app 侧)才动得起来;0.3.11 之后 ③ 不再被触发,
> 上游那条 `packageFrom` 修复只作为建议保留(补丁仍在 16.2)。

### 16.4 另一条路:repack 期删掉构建期专用依赖(已落地)

③ 只对"与 Node 内建同名"的依赖发作,而这类依赖在本闭包里**只有一个源头** ——
`@jinsiyu/dshcs-kerberos-*` 从上游继承的 `prebuild-install`(install 期下载预编译产物的 CLI):

```
@jinsiyu/dshcs-kerberos-win32-arm64 → prebuild-install → tar-fs → tar-stream → bl → buffer
                                                                 bl/tar-stream → readable-stream → string_decoder
```

- repack 早已删掉 `scripts`(`vendor-repacks.mjs` 里 `delete m.scripts`),所以 `prebuild-install`
  **永远不会被调用**;实测全 profile 只有这一个包声明它;
- 删掉它之后,profile 里"与 Node 内建同名的依赖"边数 **2 → 0**(审计脚本见 `.spike/desktop-install-0.3.8/`),
  桌面校验器 ③ 对这个插件不再命中 —— 不改桌面端也能装;
- 已落地:`scripts/vendor-repacks.mjs` 的 `writeRepack()` 在删 `scripts` 之后,一并从
  `dependencies`/`optionalDependencies` 删除 `prebuild-install`。生效需要重跑
  `repack:build -- --target win32-arm64,win32-x64 --pack` → `publish:repacks`,再出新运行树/插件版本
  (运行树里**内嵌**的那份 kerberos manifest 也会随之变成删过的版本,所以树必须重新生成);
- 注意:这只解决本插件的闭包。别家插件只要声明了同类依赖仍会撞 ③,上游那条 `packageFrom` 修复
  依旧值得提(补丁见 16.2)。

### 16.5 发布结果:全部走插件侧(0.3.8 → 0.3.10 → 0.3.11)

| 层 | 插件侧修法 | 版本 |
|---|---|---|
| ① tslib peer 没装 | 把 `tslib` 写进 `dependencies` | 0.3.8 |
| ② 同平台依赖被跳过 | 随 ① 一起消失(触发条件是"peer 未满足",且只在 registry `add` + 应用自带 pnpm 11.7.0 下出现) | 0.3.8 |
| ③ 核心模块名解析不了 | repack 期删掉 `prebuild-install`(`vendor-repacks.mjs` 的 `writeRepack()`),kerberos 重发 `2.1.1-dshcs.1`,运行树重发 `0.3.10` | 0.3.10 |
| ④ 宿主 peer 的 semver 预发布陷阱 | 删掉 `peerDependencies."@deepseek-ai/dsh"` | 0.3.11 |

**④ 是什么**:校验器的 peer 检查是 `satisfies(hostVersion, range)`(node-semver,默认不含预发布),
而 `>=0.1.2-rc.1` **永远匹配不上** `0.1.5-rc.2` —— 规则是"候选项带预发布时,只有当**同一个
major.minor.patch** 的比较符也带预发布才算命中"(`*` 同样不匹配预发布)。所以任何"≥ 某个预发布"的
区间都不可能匹配未来任意预发布宿主,每换一次宿主预发布就要改一次区间。本插件运行时**不 import**
`@deepseek-ai/dsh`/`cordis`(schemastery 走 `lib/index.js` 的动态解析兜底,见 `lib/dsh-resolve.mjs`),
生态里也有插件完全不声明宿主 peer(`deepseek-harness-wallet` / `dsh-safemode-profile`),直接删掉最稳;
兼容性意图仍由 `dsh.env.minVersion` 元数据 + 运行期特性探测(0.2.3 的旧版提示卡)承担。

**发布记录**(日志与脚本在 `.spike/release-0.3.10/`):

```
repack : @jinsiyu/dshcs-kerberos-win32-{arm64,x64}@2.1.1-dshcs.1
         (deps 只剩 bindings + node-addon-api;prebuild-install 已删)
         @jinsiyu/dsh-code-server-runtime-win32-{arm64,x64}@0.3.10(kerberos 别名指向新版本)
publish: [publish] 完成:发布 4 个,跳过 23 个,失败 0 个      ← dist-tag next,latest 未动
plugin : + dsh-code-server-app@0.3.11                       ← next
```

**验收(应用原版、未打补丁的校验器)**:全新 desktop 风格沙盒 + 应用自带 pnpm 11.7.0 +
`add dsh-code-server-app@0.3.11`:

```
VALIDATE: PASS — the application would accept this profile
=== every declared edge that leaves the profile ===
none
profile facts: +tslib +node-pty +koffi +ssh2 +cpu-features +kerberos
               -prebuild-install -buffer -string_decoder -bl -tar-stream -readable-stream
```

即"装进 dsh-desktop"现在**完全不需要上游补丁**;16.2 的 app 补丁只作为上游建议保留。

### 16.6 教训(写给下一次)

- 桌面校验器判的是**声明闭包**,不是运行时真正 import 的子集:peer / optional 都要能追溯,哪怕一行都没用到。
- 三层原因会串成**一条**报错:先报最先命中的(tslib),修掉才露出后两层 ⇒ "报错信息 = 根因"只对第一层成立,
  必须把整个闭包跑一遍 inventory 才知道要修几处。
- 同一个"缺包"现象别急着判给工具版本:A/B 只改**插件版本**(0.2.14 / 0.3.8)就能把 skipped 从 105 翻到 35;
  pnpm 版本只是叠加条件(11.25.0 对两版都正常)。
- 验收必须走**真实安装路径**:registry `add` + 应用自己的校验器。tarball 安装与 `--frozen-lockfile`
  都会掩盖 registry `add` 才有的行为(本次两者都不触发 ②)。
- 复现必须用**应用自带的 runtime 与 workspace 设置**(§11.1):store、reporter、安装方式都会改变结论。
- 校验器的 peer 检查对**预发布宿主**无解:`satisfies('0.1.5-rc.2', '>=0.1.2-rc.1') === false`。插件要在
  预发布 DSH 上保持可安装,就别把宿主版本写成"≥ 某个预发布"的 peer —— 要么不声明(靠 `dsh.env.minVersion`
  元数据 + 运行期探测),要么声明一个**稳定版**宿主包(例如 `@deepseek-ai/cordis: ^4.0.1`)。
- "只改插件"完全可行:四层里三层在插件侧(peer 升依赖、repack 删构建期依赖、删宿主 peer),
  只有 ③ 属于上游;而 ③ 被 repack 剥离绕开后,桌面端一行都不用改。发布链本身是幂等的
  (`publish-repacks.mjs` 默认 `--tag next`,已存在版本自动跳过),可安全重跑。

## 17. 0.3.9:修掉编辑器桥的两个真缺陷(桥从来没同步过 + 桥扩展装不全)

> 起因:用户报"web profile 启动崩溃"。排查过程中核对 0.3.7 的桥实现,发现**两个独立缺陷**;
> 两者都不会让进程崩,而是让"编辑器桥"这个功能整体静默失效 —— 恰好是"改坏了不会有人立刻发现"的类型。

### 17.1 缺陷一:`/api` 上的桥路由永远到不了(被 Connection 的 cookie fence 401 掉)

- 0.3.7 把四条桥路由注册在 `ctx.connection.fetch.register({ path: '/api/code-server/bridge/…' })`。
- 但 DSH 的 Connection 插件给整个 `/api` 前缀装了 fence(`packages/client/connection/src/index.ts:124-137`):
  `requestRejection(req)` → 不可信 Host 403 / **无浏览器 cookie 401**,而且发生在**分发到插件路由之前**。
- 桥的客户端是 VS Code **扩展宿主里的 Node 进程** —— 它拿不到浏览器 cookie(这正是桥自带令牌的原因),
  于是请求必然被 401 掉,`bridgeGuard` 根本没机会执行。
- 实测(0.3.7,IDE 在 8090 上跑):扩展按配置里的 URL 发 `POST /api/code-server/bridge/sync?since=0`:
  - 不带路径令牌 → **404**(launcher 自己的门);
  - 带路径令牌 → **405**(请求穿透到 VS Code server,那里没有这条 POST 路由)。
  两个方向都不是桥 ⇒ 桥从未同步过一次。
- 另一个同等错误:`syncBridgeRuntime({host, port: state.port})` 把 **launcher 的** origin 写进了 `bridge.json`,
  而 launcher 只服务 workbench、**没有任何 `/api` 路由**(`launcher.mjs` 里 grep `/api/` = 0 处)。
- **修法(0.3.9)**:桥改挂 **DSH 自己的 webServer** 前缀 `${BRIDGE_BASE}` = `/code-server-bridge`,
  鉴权完全由桥令牌承担(Origin→403 仍优先于令牌)。origin 由 `WebServer` 服务暴露的**实际端口**
  算出(`packages/host/webserver/src/index.ts:149-151`,config.port=0 时是 OS 分配值)。
  没有 webServer 的部署(desktop)**不写 bridge.json**(宁可休眠,不可指向死地址)并说明一次;
  **文件打开不受影响**(走信号文件,与 serve 模式无关)。
- 适配器细节:Node 路由 → Fetch 风格 handler 需要包一层,而 `new Request(url, {headers})` 会把
  `origin` 当 **forbidden header 归一化掉** ⇒ guard 必须读原始 headers(适配器挂在 `request.dshcsRawHeaders` 上)。
  测试里那条"Origin 必须穿过适配器仍然是 403"的用例就是钉这件事。

### 17.2 缺陷二:桥扩展装不全(`lib/*.js` 没被拷进去)

- `assets/extensions/dshcs-editor-bridge/` 里,`extension.js` 通过 `require('./lib/bridge-client.js' | './lib/context-model.js' | './lib/diff-model.js')`
  使用三个纯逻辑模块(刻意不 require('vscode'),便于单测)。
- 而 `installBundledExtensions` 的 `const files = ['package.json', 'extension.js']` 是**硬编码两项**、不递归 ⇒
  装到 profile 的副本没有 `lib/`,扩展一加载就 `Cannot find module`
  (**归因更正见 17.4**:`Marked extension as removed` 那行日志与"装不全"无关,是 profile 机制打的标记)。
- **修法(0.3.9)**:改为**递归列出源目录**并同步(内容不同即覆盖,**源里已不存在的文件从目标删除**,
  避免升级后旧 `lib/` 残留),仍然保留"清理放错位置副本"的行为。
- 回归:`scripts/test-bridge-routes.mjs` 直接调 `installBundledExtensions`(它导出是为了可测 —— 安装发生在 start 里),
  断言五个文件落地、内容一致、幂等、陈旧文件被清掉。

### 17.3 顺带修正与遗留

- `test-launcher-routes.mjs` 原本硬编码 desktop profile 的树,而 0.3.7 的安装把树换成新的(没有 junction)⇒
  测试以 `ERR_MODULE_NOT_FOUND @vscode/spdlog` 失败(环境问题,不是 launcher 问题)。改为:优先挑一个
  profile 的树,借**已安装插件自己的** `lib/native.js` 把 junction 建齐,一个都不行才 SKIP。
- `lib/bridge.mjs` 的 `callBridge()` 是死代码(host 想反向调扩展,但扩展宿主根本没有 HTTP 面,
  lib/ 里也无人调用)—— 本次**没删**,留给出桥定方向的人决定;新代码路径不依赖它。
- 回归总览:7 个套件 70 项断言全绿(bridge-routes 21 / bridge-extension 17 / claim-types 9 /
  launcher-routes 9 / sidebar-fullscreen 7 / workspace-switch 5 / plugin-apply 2)。

## 18. 0.3.12:第三个缺陷 —— 桥扩展"装对了也不加载"(VS Code 的 `.obsolete` 自锁)

> 0.3.9 修完"路由挂了"和"文件装全了"之后,**桥依然没有状态**:DSH 的 `editor_context` /
> `editor_diagnostics` 一直答"编辑器里的扩展还没有上报状态"。
> 注意别被 `/code-server-bridge/health` 骗了 —— 它回的 `bridge:true` 只表示"桥的目标已就绪"
> (`bridgeMeta !== null`),**不表示扩展在跑**。

### 18.1 现场证据(2026-09-13,本机 web profile 实跑)

- `<extensions-dir>/.obsolete` = `{"dsh-code-server-app.dshcs-editor-bridge-0.1.0":true}`;
- 每次 IDE 启动的服务端日志都有一行
  `Marked extension as removed dsh-code-server-app.dshcs-editor-bridge-0.1.0`
  —— 10 次启动 10 条(`user-data/logs/*/remoteagent.log` 第 8 行),包含 0.3.9 已把 `lib/` 装全之后的那几次;
- `<extensions-dir>/extensions.json`(= VS Code **default profile 的清单**)里只有语言包与 `dshcs-open-file`,
  **没有桥扩展**;
- exthost 日志(`*/exthost*/remoteexthost.log`)里只有 `dsh-code-server-app.dshcs-open-file` 的激活记录,
  桥扩展**一次都没有**被激活。

### 18.2 机制(读 `out/server-main.js` 定位到 `ExtensionsWatcher#initialize`)

```js
await this.extensionsScannerService.initializeDefaultProfileExtensions()
await this.onDidChangeProfiles(this.userDataProfilesService.profiles)
this.registerListeners()
await this.deleteExtensionsNotInProfiles()      // ← 就是这里打标记
```

- `deleteExtensionsNotInProfiles()` 取"**在用户扩展目录里、但不在任何 profile 的 extensions.json 里**"的扩展,
  交给 `ExtensionManagementService.deleteExtensions` → `ExtensionsScannerService.setExtensionsForRemoval`
  → 写 `.obsolete` + 打 `Marked extension as removed`;
- 而 `initializeDefaultProfileExtensions()` 只在 profile 清单**不存在**时才去建
  (`bailOutWhenFileNotFound:true`);本机清单已存在(语言包 + open-file)⇒ **不会**把新出现的目录补进 profile;
- 真正会把"运行期出现的扩展目录"补进 profile 的是文件监听那条路
  (`onDidFilesChange` → `rawAdded` → `Added extensions to default profile from external source`),
  而插件是在 **IDE 启动之前**把目录拷进去的 —— 监听看不到这次新增。

⇒ 于是:扫描器见到 `.obsolete` 就跳过它 → 下一轮它又不在 profile 里 → 再标一次。**每启动一次循环一次,自锁。**

**结论**:插件直接往 `<extensions-dir>` 拷目录这种"安装"方式,在 VS Code 服务端的 profile 机制下站不住。
0.3.0–0.3.11 的注释写着"桥必须装用户级,用户才有办法卸载" —— 这个意图改由插件设置
`editorBridge=false`(不挂桥、不注册工具)承担即可,不需要用户级位置。

### 18.3 修法(0.3.12)

1. 桥扩展改为**内置**安装(`<树>/lib/vscode/extensions/dshcs-editor-bridge`,与 `dshcs-open-file` 同处)——
   内置目录不参与 profile 机制,一次装好即生效(正面对照:`dshcs-open-file` 一直是内置的,从来没被标 removed);
2. `installBundledExtensions()` 每次跑完调用 `clearObsoleteMarkers()` 清掉 `.obsolete` 里属于本插件两个扩展的键
   (别的扩展的键原样保留;清空后直接删文件),把历史遗留的自锁解开;
3. 既有的"清理放错位置副本"逻辑会自动删掉用户目录里那份 0.3.11 残留。

回归:`scripts/test-bridge-routes.mjs` 的安装用例改为注入假树(`installBundledExtensions(dir, ud, {treeRoot})`),
断言五类文件落在**内置**目录、用户级旧副本被删、`.obsolete` 里本插件的键被清而别的键保留、只剩本插件键时删文件。

### 18.4 第四个缺陷:扩展自己算错了配置目录(改内置之后必须由 host 告诉它)

修完 18.3 立刻用一棵**独立数据根**的 VS Code server 复验(同树、`--user-data-dir` 换新、8123 端口,
浏览器真开一次 workbench),exthost 日志里出现了第一条激活记录:

```
ExtensionService#_doActivateExtension dsh-code-server-app.dshcs-editor-bridge, startup: true, activationEvent: '*'
```

但 DSH 的 `editor_context` 仍然答"还没有上报状态" —— 因为扩展**读不到配置**:

- `extension.js` 里 `extensionDir()` 是 `path.resolve(__dirname, '..', '..')`;
  `__dirname` = `<ext>/`(入口是 `./extension.js`)⇒ 得到的是 **`<extensionsDir>` 的上一级**,
  比正确值多上溯了一级。`bridge-client.js` 自己的默认(`<ext>/lib/` 上溯两级 = `<extensionsDir>`)**是对的**,
  却被这个显式覆盖参数顶掉了 ⇒ 0.3.0–0.3.11 无论装哪种布局都读不到 `bridge.json`,桥永远是休眠态。
- 而改成内置安装之后,"与配置文件同级"这个前提本身也不成立了:内置目录在**树里**,
  与 `<extensionsDir>` 不在同一棵树下。

**修法(0.3.12)**:
1. host 在 spawn launcher 时注入 `DSHCS_EXTENSIONS_DIR`(env 会被扩展宿主继承 ——
   与既有的 `DSHCS_OPEN_FILE_SIGNAL` 完全同一套做法,`dshcs-open-file` 一直这么干);
2. `lib/bridge-client.js` 的 `defaultExtensionsDir()`:**env → 调用方显式值 → 自己位置反推**,
   并且**只在这一处算**;`extension.js` 不再自己算配置目录(`createClient()` 走默认);
3. 回归:新增两条断言(env 优先 / 不带参数也能按 env 读到配置)+ 一条源码级断言
   (`extension.js` 里不允许再出现 `resolve(__dirname…`)。

**端到端复验(同一棵独立 server,注入 env 后)**:

```
editor_context  → 活动编辑器:无(用户没有聚焦任何文件)
                  未保存缓冲区:无(磁盘内容 = 用户所见)
                  问题面板:无错误/警告
editor_diagnostics → 没有匹配的诊断
```

这正是"扩展活了、配置读到了、轮询打通了"三件事同时成立的证据(该 server 里确实没开任何文件)。

### 18.5 教训

- **"我以为装上了"要分开验三层**:文件在不在(磁盘)、VS Code 认不认(profile/`.obsolete`)、扩展跑没跑
  (exthost 日志)。三层里任何一层断了,表现都是同一句话"编辑器还没有上报状态"。
- 康威式的坑:**服务端日志里的那行 `Marked extension as removed` 就是根因**,当时把它当成"加载失败的副产物",
  于是 0.3.9 只修了文件拷贝,症状没变 —— **把日志行当成结论前,先找到打印它的那行源码**。
- 扩展的放置位置是**产品契约**问题,不是实现细节:内置 = 产品自带、用户级 = 用户可装卸;
  插件替用户"装"一个用户级扩展,就得替 VS Code 维护 profile 清单,而那不在插件的能力范围内。
- **同一件事只允许一处实现**:配置目录被算了两次(一处对、一处错),错的那处还恰好覆盖了对的那处 ——
  这类 bug 不看运行结果几乎发现不了。相邻模块之间的"我替你算好了"是最贵的一种好意。
- 验证要**分层到能被观察**:先看 exthost 有没有激活(是/否),再看工具返回有没有数据(是/否);
  一次只推进一层,才能立刻定位断在哪。

## 19. 0.3.13:适配 desktop —— 桥改走本机 IPC(命名管道 / unix socket)

> 需求:**适配 desktop 模式**。桌面端此前桥永远休眠(`bridge.supported=false`),
> 原因是传输选错了 —— 桥一直挂在"某种 HTTP 面"上,而 desktop 根本没有 HTTP 面。

### 19.1 事实核对(三处源码,决定了设计)

1. **desktop 的 `/api` 是进程内函数调用,进程外不可达**:`apps/desktop-host/src/index.ts:308`
   `const api = connection.createSharedFetchHandler('/api')`,由 Electron preload 暴露给渲染进程的
   `host.fetch(command, body)` 调用 —— 只有渲染进程能用,而且它不是网络请求。
2. **`/api` 即使有 HTTP 面也不行**:`packages/client/connection/src/index.ts:119-139` 里,
   `/api` 路由**只在有 `webServer` 服务时才注册**(`ctx.inject(['webServer'], …)`),而且 handler 第一件事就是
   `connection.requestRejection(req)`(Host/Origin fence + 浏览器 cookie 认证)。扩展宿主是 Node 进程 →
   没有 cookie → 401。
3. **DSH 没有给插件用的本机 IPC 设施**:`git grep -ln socketPath -- packages apps` 命中 0 处;
   所以这条路要插件自己搭 —— 但本仓库已经有两处先例:`lib/launcher.mjs --pipe`(IDE 的服务端挂载)
   与 `lib/index.js` 的 `healthCheckPipe`。

### 19.2 修法:桥的传输换成**本机 IPC**,web 与 desktop 同一条路

新增 `lib/bridge-ipc.mjs`(host 侧传输层):

- `bridgeEndpointPath(root, pid)`:Windows → `\\.\pipe\dshcs-bridge-<pid>-<12hex>`(随机后缀不可猜);
  其它平台 → `<dataRoot>/bridge-<pid>-<12hex>.sock`,POSIX 上 `chmod 0600`,关闭时删除,
  启动时顺带清掉 24h 以前的残留 socket(崩溃留下的,不碰别人正在用的);
- `startBridgeListener({socketPath, handler})`:`http.createServer(handler).listen(socketPath)`,
  失败时 reject(调用方据此**不写 bridge.json**,宁可休眠)。
- host 侧 `net`/`http` 直接复用原有链路:Node req/res → `nodeRouteFromFetch` → `dispatchBridge` → `bridgeGuard`
  —— 路由表、只读白名单、令牌、Origin 403 全部不变。

扩展侧(`lib/bridge-client.js`):`bridge.json` 的字段从 `url` 变成 `pipe`(配置 `version` 1→2),
请求从 `fetch(url)` 换成 `http.request({socketPath})`(`fetch` 不支持 socket),并校验端点形状
(Windows 必须是命名管道名、其它平台必须是绝对路径);旧版 v1 配置一律视为"未配置"→ 休眠。

其它同步改动:

- `lib/index.js`:`ctx.inject(['webServer'])` 里那段桥挂载删掉,改由 `ctx.effect` 起/停本机 IPC 监听口
  (设置项 `editorBridge=false` 时把监听口一起关掉);`/status` 的 `bridge.supported` 改为"监听口在不在"
  (**desktop 现在也是 true**),并把 `url` 字段换成 `endpoint`;`/health` 返回 `transport:"ipc"` + `endpoint`;
- `lib/bridge.mjs`:`writeBridgeConfig`/`readBridgeConfig` 走 `pipe`,`bridgeUrl()` 删除(没人用了);
- `package.json` 的 `files` 加上 `lib/bridge-ipc.mjs`。

### 19.3 回归与验收

- `scripts/test-bridge-routes.mjs`:**不再用桩 webServer**,而是让 `apply()` 真的把监听口起起来
  (桩 ctx 的 `effect` 真的执行回调),再用**真实命名管道**驱动四条路由 —— 覆盖
  `404 / 405 / 401 / 403 / 503 / health 无鉴权`;并断言"桥不再挂到 webServer 上"。
- `scripts/test-bridge-extension.mjs`:客户端用例改注入 `requestImpl`(断言 `socketPath`、`path`、令牌头),
  新增**端到端**用例:host 侧 `startBridgeListener` + 扩展侧 `defaultRequest` 在一条真管道上跑完整轮
  (含"宿主没在跑 → `ok:false, status:0`"),以及"v1 配置(url)必须判为未配置"。
- **沙箱边界**:workspace-write 下**连接**命名管道是 EPERM(监听允许)——
  这类用例在沙箱里打印 `SKIP …EPERM`,不静默通过;放宽后 6 个用例全部真实执行。
  这是本机沙箱限制,与代码正确性无关(生产里 `serve: dsh` 的管道一直这么用)。

### 19.4 adopt 路径的坑:被接管的 IDE 里跑的是**旧扩展代码**(0.3.14)

`startInner()` 在"显式固定端口 + 该端口上已有本插件的实例"时会 **adopt**(接管)那个 IDE 而不是重启它
(`lib/index.js` 的 adopt 分支,`state.adopted = true`)。这条路径**不重新加载扩展**:
文件可以同步,但扩展宿主里跑的仍是上次启动时那份代码。于是"桥的传输换了(0.3.13 的 url → pipe)"
在 adopt 场景下会表现为:host 写的是 v2 配置、扩展里的还是 v1 代码 → 读不到 `url` → 休眠 →
用户看到的仍是那句没法自查的"编辑器还没有上报状态"。

修法(0.3.14 + 0.3.15):

- `installBundledExtensions()` 返回 `{updated, cleared}`(本次真的动过哪些扩展 / 清了哪些 `.obsolete` 键);
- adopt 分支也执行一次同步,并在**两种**信号下明确告警:
  ① `updated` 非空(本次真的改了文件);② `newestBundledExtensionMtime()` > IDE 进程启动时间
  (即"安装目录里的扩展文件比这个进程还新" ⇒ 该进程不可能加载过它们)。
  第二条是 0.3.15 补的:文件可能是上一次插件启动时写的(这次 `updated` 为空),但那个 IDE 进程照样在跑旧代码
  —— 只靠 `updated` 会漏判,而漏判的表现就是"静默休眠"。
- 告警文案给出可操作动作:「若编辑器桥没有状态(editor_context 报"编辑器还没有上报状态"),
  请在 Code Server 标签里重载一次窗口(或重启 IDE)让扩展宿主读到新代码」;
- 回归:断言"内容一致时 `updated` 为空"(接管安全)、"清掉陈旧文件时 `updated` 含该扩展"、
  "`newestBundledExtensionMtime()` 读的是安装目录里最新的那个文件,且文件时间改老后判定跟着变"。

**给升级用户的准确步骤**(固定端口 8090 的部署尤其适用):重启 `dsh web` → 若日志出现上面那条告警,
在 Code Server 标签里**重载一次窗口**(渲染进程重连 ⇒ 扩展宿主进程重启 ⇒ 读到新代码)。

### 19.5 被接管的 IDE 连环境变量都没有(0.3.16)

`DSHCS_EXTENSIONS_DIR` 只在 host **spawn** IDE 时注入。被 adopt 的进程是上一次启动的,
env 早已定死 —— 于是即便用户按上面重载窗口、拿到新代码,扩展仍然读不到配置(它自己反推只能到
`<树>/lib/vscode/extensions`,而配置写在 `<extensionsDir>/.dshcs-bridge/`)。桥只能等 IDE 重启。

修法:**host 把同一份 bridge.json 也写到内置扩展旁边**(`<树>/lib/vscode/extensions/.dshcs-bridge/`),
即 `bridgeConfigDirs()` 的第一/第二份写入位置 —— 第二份正好是 `bridge-client` 的兜底解析路径
(`<ext>/lib/` 上溯两级)。两份由同一个 `syncBridgeRuntime()`/`clearBridgeRuntime()` 一起写/一起删,
不存在优先级问题;env 仍然优先(它指向权威位置)。

回归:新增用例把扩展的三个 lib 文件复制到一棵假树的 `<树>/lib/vscode/extensions/dshcs-editor-bridge/`,
把配置写到它旁边,**清掉 env** 后断言 `defaultExtensionsDir()` 落在这一层且能读到配置。

### 19.6 教训

- **传输是设计决策,不是"顺手用现成的"**:0.3.0 起桥三次换传输(`/api` → `webServer` 前缀 → 本机 IPC),
  每次都是因为"现成的那条路"只在某一个部署形态里成立。桥的两端是**同一台机器上的两个进程**,
  这个事实本身就是最强的约束 —— 直接用它,不必绕道网络栈。
- **"支持某平台"要落到具体事实**(有没有 HTTP 面、谁来调、进程边界在哪),不能停在"应该能通"。
  这次的三条事实各自十行源码,却决定了整套传输的取舍。

## 20. 0.3.19:「问 DSH」面板 —— 回答同步回编辑器 + 提问以用户输入进对话

用户要求三件事:①不再折腾图标;②优化提问框、提问后把回答同步显示在里面;
③在 DSH 界面里提问要**以用户输入**进对话,而不是"上下文更新"。

### 20.1 图标尝试(0.3.17/0.3.18)撤销

源码定论(VS Code 1.137):**右键菜单不渲染命令图标** ——
`ContextMenu.doGetActionViewItem` 构造普通菜单项时只传 `{enableMnemonics,useEventAsContext,keybinding}`,
而菜单项类构造器是 `icon: i.icon !== void 0 ? i.icon : !1` ⇒ 恒为 false。
能显示命令图标的容器只有菜单栏下拉/命令面板/工具栏(`MenuEntryActionViewItem.render` 会加
`codicon codicon-<name>` 类)。0.3.18 试过挂 `editor/title` 按钮(实测标题栏确实出现 `codicon-comment`),
但用户不要那条路 ⇒ 0.3.19 把 `icon` 与 `editor/title` 全部撤掉,**只保留右键菜单最上面两条**:
group `navigation@-2/-1` —— `navigation` 是 `_compareMenuItems` 里唯一被特殊化到最前的组
(其余按 `localeCompare` 比组名),而 order 用 `Number(...)` 解析 ⇒ **负 order 合法**。
回归断言改成"两个命令都**不该**再声明图标、也不该注册 editor/title"。

### 20.2 提问以「用户输入」进对话(一行改动的语义差别)

`lib/bridge-session.mjs` 原来构造
`createUserMessage({ content, source: { kind: 'plugin', plugin, form: 'notice', summary: '来自编辑器' } })`,
而 `MessageSourceMap.plugin = plugin + ContextFormed` ⇒ DSH 把它当**上下文更新**渲染,
用户在界面里看到的不是"自己说的话"。改成 `source: { kind: 'user' }`;
来源信息靠正文首行 `From the editor: <file>:<行>` 保留,不依赖消息元数据。
回归:投递用例断言 `sent[0].source.kind === 'user'` 且首行仍是 `From the editor: `。

### 20.3 回答同步回编辑器(同一趟轮询的 `answers` 字段)

- **host**(新增 `lib/bridge-answer.mjs`):订阅 `agent/assistant-stream`(只取 `text-delta`,忽略
  `reasoning-delta`)累积正文、`agent/status` → `idle` 定稿;`turn` 变了就重新累积(新问题 → 新回答)。
  只同步**被编辑器问过**的会话(ask 成功时 `board.track(sessionId)`),否则 DSH 界面里聊什么都往桥里灌。
- **传输**:放在 `/sync` 响应的**独立字段** `answers`(不是事件环形缓冲)—— 每个会话只给
  "到目前为止的**完整正文**",于是丢中间态无所谓、也不会把 64 条的 agent-edit 事件挤掉;
  面板永远只渲染最新一条,不做增量合并。
- **扩展**(新增 `lib/ask-panel.js`,纯逻辑 + HTML,可单测):右键命令打开/聚焦 webview 面板 ——
  上面问答记录、下面输入框(Enter 发送、Shift+Enter 换行),`postMessage({type:'ask'})` 交给扩展投递;
  扩展在轮询回调里 `applyAnswers(state, result.answers, state.sessionId)` →
  `postMessage({type:'state'})` 增量刷新(不重建外壳,输入框与滚动位置都不受影响);
  发送时**现取当前选区**,所以面板开着也能换上下文再问。

### 20.4 验证

- **面板前端冒烟(真浏览器)**:`.spike/make-panel-preview.mjs` 用生产代码生成 HTML(stub 掉
  `acquireVsCodeApi`)并由本地静态服务打开 ⇒ 上下文行、状态行、问答渲染、`ready`/`ask` 消息、
  发送后清空输入框全部实测通过。顺带发现:CSP `script-src 'nonce-…'` 下**没有 nonce 的注入脚本会被拦掉**
  (预览脚本自己踩了),于是给面板脚本加了 `error`/`unhandledrejection` 兜底 —— 面板静默空白是最难查的失败。
- **回归**:bridge-extension 新增两条(面板状态机:只有本会话的回答落到当前轮、超长截断、
  CSP nonce、上下文描述、HTML 转义);bridge-routes 新增两条(回复同步:未登记会话不入 board、
  text-delta 累积、reasoning 忽略、换 turn 重置、idle 定稿、会话上限丢最旧、disposer 摘订阅;
  以及 `/sync` 带 answers、ask 登记会话、`source.kind='user'` 三个接线点的源码级断言)。

## 21. 0.3.22:面板直接渲染 DSH 对话(官方 markdown 渲染器)+ 就在面板里处理授权

用户的两条要求(0.3.21 之后):①消息框不要"纯文本回答",要**像 DSH 对话那样渲染**,但**只渲染新内容**;
②把**权限**问题一起解决 —— "工作区外写入和指令执行的授权"。这一节记录为什么长成这样、每条断言的证据在哪。

### 21.1 为什么不是 iframe(把 DSH 界面嵌进 webview)

三条硬阻塞,都看过源码:

1. **会话 cookie 拿不到**:DSH Web 的会话 cookie 是 `HttpOnly; SameSite=Strict`
   (`packages/client/connection/src/browser-auth.ts:122`)⇒ webview 里 iframe 带不上它,DSH 界面必然 401;
2. **没有会话深链接**:DSH Web 是纯内存 SPA(全仓 `pushState` 零命中)⇒ 就算能带 cookie,
   也定位不到"当前这个会话";
3. **webview 的 CSP/`localResourceRoots` 本来就不允许把 DSH 的 origin 当子框架加载** ——
   要开后门就得放开 `frame-src` 与跨源访问,爆炸半径远大于收益。

所以走"**面板自己渲染**":数据从 DSH 的正规 API 来,渲染用 DSH 官方的渲染器(见 21.4)。

### 21.2 对话流:`sessionController.follow` 是唯一允许的实时通道(且只渲染新内容)

- 同步读会话历史(`Session.snapshotEvents` / `eventAt` / `ownEvents`)已被 DSH **明令禁止新增调用**
  (`.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.zh.md`);
- `sessionController.page()` 是**历史分页** API —— 本版本按用户要求**只渲染新内容**,不调用它,
  所以面板里没有"加载更早"(未来的版本要补,得先在这条禁令下论证);
- 用的是被 sanction 的实时 API `sessionController.follow(address, signal)`
  (`packages/api/session-controller/src/types.ts:515`),帧形状三种:
  `{type:'snapshot',cursor,records[],assistantStream?}` / `{type:'event',event}` /
  `{type:'assistant-stream',frame:{type:'start'|'chunk',turn,chunk}}`。
  开帧的 `records`(历史)**丢弃**,只留 `cursor` 与助手流基线 ⇒ 从订阅那一刻起渲染"新内容"。
- host 侧新增 `lib/bridge-thread.mjs`:把事件投影成有界条目流 —— `user/message` → 用户气泡、
  `assistant/message` → 助手正文(**原地替换**同一轮的流式临时条目,不重复显示)、
  `tool/call` + `tool/result` → 一行工具摘要(按 `callId` 配对、状态 running/ok/error)、
  `approval/asked` + `approval/decided` → 授权审计行。有界:每会话 ≤120 条、单条 ≤8000 字符、
  同时 watch ≤4 个会话(LRU + abort)。
- **谁能看**:扩展每趟轮询上报 `watch:[sessionId]`,host 据此 `bridgeThread.sync(ids)` ——
  没声明的会话一律取消订阅,面板关掉就没人看,不做无谓的后台订阅。

### 21.3 授权:面板优先 8 秒,然后**原样**交回官方链路

DSH 把敏感动作收敛到 `approval` 服务(`@deepseek-ai/dsh-user-approval`):
`approval/request` 是 **agent 作用域的 waterfall 事件**,答案方可以是服务端监听器,也可以是浏览器客户端
(官方 `ui-approval` 卡片,`packages/api/remotes/src/remote-events.ts:18` 把它注册为 waterfall 远程事件);
outcome 只有四种 `allowed-once | rejected | cancelled | unavailable`,**没有答案者就 fail closed**。

于是"人在编辑器里提问"必然撞墙:agent 要写工作区外的文件 / 执行命令时,授权卡片只出现在 DSH 界面,
而用户根本不在那儿 —— 要么看不到,要么超时失败。做法(host 侧新增 `lib/bridge-approval.mjs`):

1. 只对**被面板 watch 的会话**注册 `agent.ctx.on('approval/request', …)`(agent 作用域天然只收本会话);
2. 生成 pending 记录 → 面板随 `/sync` 的 `approvals` 看到卡片(工具名 / 原因 / 倒计时);
3. 用户点「允许一次 / 拒绝」→ 扩展 `POST /approve` → 立刻 settle(官方卡片不再出现);
4. 8 秒没人答 / 面板没开 → `return next()`,**原样交给官方链路**(DSH 界面照旧弹卡);
5. **永不自动放行**:`allowed-once` 只能来自用户点击。

`/approve` 是桥里**唯一**的非只读路由,约束写死在实现里(`lib/bridge.mjs` 头部的安全不变量第 2 条):
只能回答**本进程发起、仍未决**的请求(单次使用)、outcome 只有两个白名单值、
**不接受任何自由文本 / 路径 / 命令参数** —— 它只能"回答问题",不能"发起动作"。

### 21.4 渲染:把 DSH 官方 markdown 渲染器打进 webview(`scripts/build-webview.mjs`)

- **渲染器** = `@deepseek-ai/dsh-client-ui-primitives` 的 `MarkdownText`(根导出,ESM):
  与 DSH 界面**同一份代码** —— 同一套 micromark/mdast 管线、同一个增量流式解析器、同一个 shiki 高亮
  (启动集:typescript / shellscript / json)、同一套 CSS 模块、KaTeX 公式。面板只包一层外壳(React 视图 +
  授权卡片 + 输入框)。
- **设计令牌**:markdown / 代码块样式依赖 `--dsw-*`(排版与配色)、`--shiki-*`(高亮色)、
  `--dsh-scrollbar-width` 等,而这些 CSS **不随包发布** —— `@deepseek-ai/dsh-client-ui-theme` 的
  `files` 里写了 `lib/styles` 但 tarball 里没有那个目录(`exports` 还挂着 `./src/*`,而 `src/` 同样不在
  发布物里);它们被 esbuild 内联成 `lib/client.js` 里的字符串。于是构建脚本从**那份发布物**里按
  "顶层为 `:root` / `body` 的字面量"把 5 段令牌表原样抽出来生成 `webview/src/official-tokens.css`
  (生成物,列了 `REQUIRED_TOKENS` 自检,缺一个就报出来,不静默降级)。
- **版本一致性**:渲染器版本必须和 DSH 部署的界面同版本。构建脚本读部署里
  `@deepseek-ai/dsh-web-frontend` 的版本(那份 UI 就在它里面)与本仓库 devDependency 比对,
  不一致**直接报错退出**(`--allow-version-mismatch` 才放行);运行期宿主还把 `uiVersion` 随 `/sync` 给面板,
  面板再比一次,不一致就在顶部显示一行提示(附带重建命令)。
- **体积与取舍**(实测):`thread.js` 996KB + `thread.css` 87KB + KaTeX woff2 字体 254KB ≈ 1.34MB;
  KaTeX 默认打包(`--no-katex` 可省 540KB,公式按字面 TeX 显示);官方那 23 套**懒加载**语法
  (约 1.6MB)换成"空注册" —— 那些语言的代码块纯文本显示(与 DSH 首次渲染同形),不报错。
- **第三方许可**:产物里打包的是 MIT 代码(ui-primitives / ui-theme / react / shiki / micromark / katex …),
  构建脚本生成 `webview/THIRD-PARTY.md` 列清单与版本。

### 21.5 两个"容易踩"的工程细节

1. **esbuild 的 JS API 在 workspace-write 沙箱里跑不起来**:它以
   `stdio: ["pipe","pipe","inherit"]` 拉起服务进程,而沙箱**拒绝创建子进程管道**(spawn EPERM)。
   CLI(`esbuild/bin/esbuild`)走的是 `execFileSync(binPath, args, { stdio: "inherit" })`(继承标准流),
   沙箱内可用 —— 代价是不能用插件,所以"虚拟模块"(懒加载语法替身 / KaTeX 替身 / 令牌表)
   都落成真实文件(`.tmp-webview/` 与 `official-tokens.css`)。
2. **产物不入 git、但必须进 npm 包**:与 `lib/client.js` 同一约定 —— `.gitignore` 掉,
   `prepack` 里跑 `build:webview`,扩展目录本就在 `files` 里,所以发布物带的是当次构建的面板。

### 21.6 验证

- **真浏览器里跑打包产物**(`.spike/webview-preview/`,`serve.mjs` 静态服务 + `acquireVsCodeApi` 替身):
  实测通过 —— 标题/列表/表格/引用/行内代码与链接、`ts`/`bash`/`json` 三套语法**真高亮**、
  `python` 纯文本降级、KaTeX 行内与独立公式、脚注区、超长行换行、授权卡片倒计时与「允许一次 / 拒绝」、
  版本不一致提示、旧版宿主(没有 `thread` 字段)的错误提示。
- **回归**:`test-bridge-extension` 28 条(对话流只渲染新内容 / 本地提问回显后退场 / 流式变化才刷新 /
  角色白名单 / 旧版宿主必须报错 / 授权列表 + 窗口长度 / 外壳 CSP 与 `localResourceRoots` /
  正文必须走官方渲染器)、`test-webview-bundle` 11 条(产物存在与体积区间、第三方许可、
  渲染器版本注入与构建期把关、官方令牌与 KaTeX 样式在 CSS 里、令牌抽取不许手改、
  懒加载语法替身、CLI 构建、宿主 `/sync` 四字段、扩展 `watch` 与 `applySync` 接线、
  `/approve` 的四条约束),`test-bridge-routes` 27 条不变绿。




## 22. 0.3.23:面板改对话框形状 + 思考过程照官方折叠 + 修好授权窗口


这一版全部来自用户实测反馈(0.3.22 发布当天):「对话不要用侧边栏,还是改成对话框形式」
「思考过程要显示,和官方一样默认折叠」「授权框失效了」。三条都改在面板侧,桥的安全模型不动。

### 22.1 对话框形状(不再挤成侧栏一列)

0.3.22 的面板用 `createWebviewPanel(..., { viewColumn: ViewColumn.Beside })` —— 在"IDE 就在 DSH 右侧栏里"
的形态下,那等于把本来就不宽的工作台再切成两列,用户看到的就是一条窄栏。改成:

- `ViewColumn.Active`(开在**当前编辑器组**、占满工作台宽度);
- 面板内容自己居中限宽(`.dshcs-app { max-width: 900px; margin: 0 auto }`),右上角一个 ✕
  (`postMessage({type:'close'})` → 扩展 `panel.dispose()`)—— 看起来就是一扇对话窗而不是一列记录;
- 再次右键提问只 `reveal`(不重复开窗)。

### 22.2 思考过程(默认折叠,照官方 ReasoningRow)

- **host**(`lib/bridge-thread.mjs`):内容块类型来自 `packages/llm/llm/src/types.ts` —— `{type:'text'}` 是正文、
  `{type:'reasoning'}` 是思考。以前只取 text,思考整个丢掉。现在 `partsOfContent()` 同时取两者,
  条目的 `thinking` 字段进快照;流式帧除 `text-delta` 外也接 `reasoning-delta`(思考通常先来、正文后到),
  两者累积到**同一条**流式条目上;耐久 `assistant/message` 落地时两个字段一起覆盖。
- **面板**(`webview/src/thread.jsx`):用官方部件重现官方 `ReasoningRow` —— `DisclosureRow` +
  `IconThinkOutline14`,**`useState(false)` 默认收起**,收起时显示首行(流式时显示最新一行)、去掉 `**`,
  点整行展开全文;正文还没到时标题写「思考中」(与官方 `running` 判据一致)。
- 回归:`test-bridge-routes` 的会话流用例断言 `reasoning` 块与 `reasoning-delta` 都进 `thinking`、
  快照带该字段、耐久消息覆盖流式值;`test-bridge-extension` 断言模型白名单收 thinking、签名覆盖 thinking
  (思考变长也要刷新)、渲染层默认收起。

### 22.3 授权窗口:8 秒 → 5 分钟,面板一关就立刻交回

0.3.22 的窗口是 `HOLD_MS = 8000`,而且**面板自己按时间判过期**(`expired` ⇒ 按钮 disabled)。
实测结果就是"授权框失效了":卡片出现到用户读完、点下去,8 秒早过了,按钮已经是灰的。

- **窗口默认 5 分钟**(`DEFAULT_HOLD_MS = 300000`):面板就在用户眼前,时间不该成为失败原因。
- **前端不再判过期**:只要卡片还在(host 侧仍未决)按钮就可点;倒计时只是"还有多久交回官方链路"的提示。
  请求被交回时它会从 `approvals` 里消失,面板改为显示审计行 —— 前端不再自己发明"过期"这个状态。
- **面板一关就立刻交回**(`WATCH_POLL_MS = 500` 轮询 `hasPanel()`):不干等窗口结束;
  窗口到点仍没人答也照旧 `next()` 交回官方链路。**永不自动放行**的语义没变(`allowed-once` 只能来自点击)。
- 回归:`test-bridge-routes` 新增"面板关掉 → 立刻返回(<2s,窗口设 60s)"这条;
  `test-webview-bundle` 断言 5 分钟窗口、轮询常量、以及前端源码里不再出现 `expired`。

### 22.4 验证

- **真浏览器跑打包产物**(`.spike/webview-preview/`):思考行默认收起且标题为「思考」、点整行展开显示全文;
  只有思考没有正文时标题为「思考中」;授权卡片倒计时显示"4 分 49 秒后交回 DSH 界面"且**两个按钮可点**;
  头部有「DSH / 上下文 / 渲染器版本 / ✕」;正文仍是官方渲染结果(标题、表格、高亮、公式)。
- **回归**:`test-bridge-routes` 27、`test-bridge-extension` 30(+1 SKIP:沙箱不许连命名管道)、
  `test-webview-bundle` 13,其余套件不变绿。

## 23. 0.3.24:对话改成 DSH 页面里的悬浮对话框 + 上下文折叠 + 授权有人看着才拦

0.3.23 用户实测后提的三条:「打开了一个 dsh 对话页面,没有弹出对话框」「授权问题仍然存在」
「上下文注入没有折叠」。逐条定位与修法:

### 23.1 为什么编辑器里做不出"对话框",于是搬进 DSH 页面

编辑器的 webview **只能是编辑器组里的一个 tab/一列**(`ViewColumn.Beside` 是挤成一条窄栏,
`ViewColumn.Active` 是占满整个工作台的一页)—— 两条路用户都试过,反馈都是"这不是对话框"。
VS Code 扩展 API 没有悬浮窗;所以对话框只能画在 **DSH 页面自己**的 DOM 上,由插件的 **client 半部**
实现(它本来就在 DSH 页面里跑):

| 部分 | 做什么 |
| --- | --- |
| client 半部(`src/factory.js`) | 造浮动容器(fixed、右下角、可拖动、可缩放、✕ 关闭);每 900ms 问一次 `/api/code-server/ask/state?rev=N`,**没变化只回一个数字**;打开时懒加载面板产物并注入 |
| host(`lib/index.js`) | 新增 5 条同源路由 `/api/code-server/ask/{state,send,approve,close,bundle}`;`/sync` 加能力位 `askDialog: true` |
| 扩展 | 右键命令改成 `POST /code-server-bridge/event {kind:'ask-open', mode}`(**只上报意图**,上下文由 host 从它自己的缓存取);老宿主(探测不到能力位)才退回编辑器面板 |

产物注入而不是 iframe:desktop 的 `/api` 是 **Electron IPC 帧管道**(`host.fetch()`),
`<iframe src="/api/...">` 在那边根本不可用;所以改成 fetch 文本 + 注入
(`<style>` 装 CSS、`<script>` 装 JS),面板脚本通过 `window.__DSHCS_MOUNT__` 拿到挂载点。

**注入安全(两条硬约束)**:
1. 面板 CSS 的排版规则全部挂在 `.dshcs-panel` 下,**绝不出现 `body {}`** —— 注入不改宿主界面;
2. 从官方令牌表抽出来的 CSS **只保留 `--` 自定义属性声明**(普通声明会改到 DSH 页面);
   嵌套块(滚动条那条 `@supports`)整段不注入,只在缺 `--dsh-scrollbar-width` 时补官方值。
   实测(`.spike/webview-preview/dsh.html` 模拟注入):宿主 body 的 `background:#102030 / Georgia 17px`
   一个都没变,面板里 markdown、思考行、上下文行、授权卡片全部正常。

### 23.2 上下文注入折叠(`splitEditorPrompt`)

桥自己拼的消息长这样(见 `composeEditorPrompt`):第一行 `From the editor: <位置>`、可选一个围栏
代码块(选区正文)、然后是用户原话。以前面板把**整段**平铺在气泡里 —— 用户看到一大坨跟自己问题无关的代码。
现在 host 按位置拆开(不能按空行切:选区自己常含空行):

- `lib/bridge-session.mjs` 新增 `splitEditorPrompt(text)` → `{context, question}`;
- `lib/bridge-thread.mjs` 投影 `user/message` 时用它:上下文进条目的 `context` 字段,`text` 只留原话;
- 面板渲染成一行**默认收起**的「上下文」行(官方 `DisclosureRow` + `IconContextInjectionOutline16`),
  摘要就是位置行,点开才看得到代码;认不出来的消息(用户在 DSH 里自己敲的)照旧是普通气泡。

### 23.3 授权:"有人看着"才拦,而且面板/对话框必须真的在看

0.3.23 把窗口放到 5 分钟、前端不再判过期之后,用户仍反馈"授权问题仍然存在" —— 实测复盘是
**当时没有任何一方在"看"**:编辑器面板是个 tab,用户切走了/关了,`hasPanel()` 为假,授权就直接
走了官方链路(DSH 界面的卡片)。0.3.24 相应调整:

- "有人在看" = 编辑器面板声明的会话 **∪** 对话框声明的会话(`bridgeWatch.ids` / `dialogIds`),
  两边任一在看就算在看;
- 对话框关掉 → `/ask/close` → `dialogIds` 清空 → 拦截器的 500ms 轮询立刻 `next()` 交回官方链路;
- 面板/对话框里的卡片只要还在(host 仍未决)就可点,窗口 5 分钟(0.3.23 已改)。

### 23.4 其它

- 面板和对话框**共用同一个产物**(`webview/thread.js|css`):host 的 `/ask/bundle` 直接读盘给文本;
  KaTeX 字体改成 **data URI 内联**(注入到 DSH 页面时相对 `fonts/...` 会 404),`fonts/` 目录不再产出;
- `lib/bridge-thread.mjs` 与 `lib/bridge-approval.mjs` 各加了 `rev` 修订号,对话框轮询靠它省流量;
- 面板脚本按 `window.__DSHCS_HOST__`(`'webview'` / `'dsh'`)区分宿主:对话框形态下**不碰**
  `body[data-ds-dark-theme]`(那是 DSH 自己的主题开关)。

### 23.5 验证

- `test-webview-bundle` 新增两条:5 条 ask 路由 + 能力位 + `answerApproval` 共用校验 + client 半部的
  壳/替身/轮询 + `splitEditorPrompt` 接线;产物那条改成"字体内联、无 fonts 目录"。
- 浏览器注入实测(见上):无样式泄漏、上下文默认收起、思考默认收起、授权卡片可点。
- 回归:`test-bridge-routes` 27、`test-bridge-extension` 30、`test-webview-bundle` 14。

### 23.6 0.3.59:注入机制整体下线(这一节 23.1–23.5 的"产物注入"已被取代)

上面记录的"host 读盘 `thread.{js,css}` → `/ask/bundle` → 客户端半部注入 `<style>` + `<script>`"在
**0.3.59 被删掉了**。理由很直接:对话框本来就跑在 DSH 页面里,而壳的模块表(`dsh-web-frontend` 的
`staticModules`)已经冻结了 `react` / `react/jsx-runtime` / `react-dom` / `react-dom/client` /
`@deepseek-ai/dsh-client-ui-primitives` / … —— 面板直接 `require` 它们就行,于是:

- 不需要 1MB 产物、不需要假 `acquireVsCodeApi`、不需要给面板准备挂载点(`window.__DSHCS_MOUNT__`);
- **不可能**再出现 23.4 提到的"面板内置渲染器版本 ≠ 界面版本"(同一次 require 拿到的就是界面那一份);
- 代码高亮走 DSH 自己的 shiki 懒加载语法集(产物里只能带 boot 的三套);官方令牌副本(28KB)也不再需要;
- 代价是面板必须自己保证两件事:注入的 CSS 只碰 `.dshcs-*`(23.1 的"注入安全"两条约束在这里同样成立,
  而且现在有自动化守卫),以及拿不到种子词时**降级不白屏**(正文 `<pre>`、按钮原生 `button`、错误边界)。

本文档 23.1–23.5 的注入细节仍然准确描述 **0.3.24–0.3.58** 的行为;编辑器里的 webview 兜底面板至今
仍用那份产物。现在的约束清单见 README「「问 DSH」对话框为什么也没有构建步骤(0.3.59 起)」,
守卫见 `scripts/test-ask-panel-inline.mjs`(P1 注入机制已下线 / P2 视图白名单 / P3 CSS 安全 /
P4 六种条目与授权卡片 / P5 降级路径 / P6 消息落点)。



这一条功能从 0.3.22 起反复"看起来没生效",真正的原因有四个,每一个都是独立的坑;记在这里,免得下一版再踩。

### 24.1 `approval/request` 是 **agent 作用域** 的 waterfall,我们挂对了地方

派发点:`packages/interaction/user-approval/src/index.ts:275` ——
`ctx.waterfall(scopeTarget(req.agent, req.agent), 'approval/request', req, () => 'unavailable')`;
作用域提取器见 `packages/core/scope/src/scoped-events.generated.ts:24`(`args[0]['agent']`)。
所以 `agent.ctx.on('approval/request', …)` 能收到 —— **前提是下面 24.2 那条**。

### 24.2 必须 `{ prepend: true }`:官方客户端卡片更早注册

DSH 的审批卡片是客户端侧的 waterfall 监听器(`packages/client/ui-approval/src/client/index.ts:90`
的 `ctx.remote.$on('approval/request', …)`),它**在用户点击前不会返回**。waterfall 按注册顺序走,
我们后注册就永远轮不到(实测:请求到达时连 `hasPanel()` 都没被调用过)。
官方测试里"抢先作答"的写法就是 `{ prepend: true }`
(`packages/interaction/user-approval/tests/approval.spec.ts:437`)⇒ 我们照抄。

### 24.3 **审批事件没有 `id` 字段**(最关键的一条)

事件形状是 `{agent, toolName, callId?, reason?, signal?}` —— 没有 `id`。
我们最初的实现是 `if (typeof request.id !== 'string') return next()`,于是**每一次**授权都被静默交回
官方卡片,而且不留任何日志(0.3.38 才补上入口日志,随即看到 `收到授权请求:pwsh id=undefined`)。
修法:`id` 只是"面板上那张卡"与"这次请求"的对号键,DSH 侧根本不需要它 ——
本地生成(`local-<n>`)即可,`board.answer(id, outcome)` 结算的是我们自己的 decision promise。

### 24.4 `/sync` 不能每 600ms 重传整份对话流

对话流快照(≤120 条 × ≤8KB)每趟都塞进 `/sync` 响应,实测把请求拖成 **3 秒超时**;
超时会让扩展丢掉**整份响应**(包括 `approvals`)⇒ 面板永远看不到卡片。
现在只在"客户端持有的修订号 ≠ 当前修订号"时才回传(`threadRev` 由扩展声明,旧扩展一律收整份以免误报),
并把扩展的请求超时放宽到 8 秒。

### 24.5 最终证据链(0.3.39 实测)

```
hasPanel -> true (hasWatcher=true approvalsUi=false dialogLive=true polls=84 open=true session=session-…)
收到授权请求:pwsh id=undefined hasPanel=true
已接住授权,正在等面板/对话框作答(此后再翻 false 会立刻放手)
decision -> "allowed-once" (typeof=string)
授权由编辑器面板决定:pwsh → allowed-once          ← 用户在编辑器侧点的
```

诊断文件:`<home>/.dsh/code-server/bridge-approval.log`(有界 256KB)—— 判据取值、心跳、入口、决策、放手原因全部落盘。
这一节的价值不只是结论:**在没有读数的情况下,任何"再改一版试试"都是在赌**;先把每一步写成一行日志,再谈修。

## 25. 0.3.45:弃用「平台聚合包 + `npm:` 别名」——用 desktop 自带的 pnpm 复现出第一名牺牲品

用户问的是「为什么官方安装方法第一次安装还会报 `requires missing @microsoft/mxc-sdk@npm:…`,重启就自己装好了」。

### 25.1 先复现,再谈根因

不猜,直接用 desktop 应用自带的 node/pnpm 逐字复刻它的安装命令
(`<unpacked>/resources/runtime/{node/node.exe,pnpm/bin/pnpm.cjs}`,pnpm **11.7.0**),目录用 desktop 新建
profile 的等价物(`pnpm-workspace.yaml` 逐字照抄:`nodeLinker: hoisted` / `autoInstallPeers: false` /
`strictDepBuilds: true` / `minimumReleaseAge: 0`):

```powershell
& $node $pnpm … add dsh-code-server-app@0.3.44 --save-exact --ignore-scripts
node .spike/repro-agg/probe.mjs .spike/repro-agg       # 复刻校验器的 packageFrom()
```

结果(联网/离线各一次,完全一致):**16 个别名目标只有 7 个被链上**,缺的 9 个是
`@microsoft/mxc-sdk`、`@parcel/watcher`、`@vscode/fs-copyfile`、`@vscode/proxy-agent`、
`@vscode/windows-ca-certs`、`cpu-features`、`node-pty`、`ssh2`、`koffi`;pnpm 自己的
`node_modules/.modules.yaml` 把它们连同传递依赖一起记进 `skipped`。
删掉 `node_modules` 再 `install --frozen-lockfile`(8.5s)⇒ **0 missing**,且全部拍平到 profile 根。

### 25.2 定位到具体一行代码

dsh-desktop 的校验器是 `apps/desktop/src/profile-packages.ts:171-238`;调用它的顺序在
`project-manager.ts`:`mutate()` → `pnpm add` → `reconcileProfile()`(第 371 行 `rebuild` 在
`packagesChanged=true` 时为 **false**,不做完整重装)→ `finishPackageOperation()` 的**第一个动作**就是
`prepareProfile()` → `validateDesktopPluginGraph()`。校验器要求「每个已安装包声明的依赖都要按**声明的键名**
解析得到」,而 `@microsoft/mxc-sdk` 正好是聚合包依赖表里**排第一**的那个,于是它成了报错里的名字。

重启自愈也来自同一段代码:`runPnpm()` 会先写 `desktop-packages-pending`,只有 `finishPackageOperation()`
末尾才删 ⇒ 校验失败时标记残留 ⇒ 下次启动走第 377-378 行「删 node_modules + `install --frozen-lockfile`」⇒ 补齐。

### 25.3 三条被推翻的假设(都留了证据)

| 假设 | 实测 |
| --- | --- |
| 「只跟 mxc-sdk 有关,把它搬进树包就行」 | ✗ 9 个都缺,搬一个报错只会换成 `@parcel/watcher`(这就是 `docs/plan-mxc-sdk-into-tree.md` 作废的原因) |
| 「24h 供应链策略挡的」 | ✗ profile 的 `minimumReleaseAge: 0`,lockfile 里解析成功 |
| 「发布物坏了」 | ✗ 0.8.0 的 fileCount/upackedSize/integrity 与本地 `repack/build` 一致 |

对照实验还定位了触发面:聚合包**直接**做根 optionalDependency(深度 0)时 0 missing;两个聚合包同时装也
0 missing;真名直接依赖在 `--ignore-scripts` 下 100% 装上 ⇒ 丢包只发生在「深度 ≥2 且父节点是 optional 子树」。

### 25.4 改动(0.3.45)

- `scripts/vendor-repacks.mjs`:不再产出 `@<scope>/dsh-code-server-runtime-<平台>-<架构>`;改为写
  `lib/vendored.json`(原名 → 真名)并把 16 个重打包包**按真名直接挂到插件依赖上**(平台无关的 8 个进
  `dependencies`,平台专属的 8 个 × 2 目标进 `optionalDependencies`)。`--reuse` 优先读该表,
  旧机器上先从聚合包清单/profile 别名迁移一次。
- `lib/native.js`:删除 `resolveRuntime()` / `runtimePackageName()` / `aliasNodePathDirs()`,改为读表 +
  `vendoredEntries()` / `nativeRuntimeStatus()`;`ensureAliasLinks()` 按表补 junction。
- `lib/index.js`:envCheck 用 `nativeRuntimeStatus()`;不再给子进程加 `NODE_PATH`(目录链已由 junction 覆盖)。
- `scripts/test-vendored-table.mjs`(11 条):钉死「无任何 `npm:` 别名 / 不引用聚合包 / 表与依赖表逐项一致 /
  `lib/vendored.json` 在 `files` 里」。

### 25.5 验证(同一个安装命令 + 校验器自己的判据)

```powershell
# 用 desktop 自带 pnpm 装本地 tarball(联网,等同真实条件)
& $node $pnpm … add <repo>\.spike\pack\dsh-code-server-app-0.3.45.tgz --save-exact --ignore-scripts
node .spike/validate-graph.mjs .spike/verify-install2 dsh-code-server-app
#   → checked 109 packages / OK 依赖图完整(校验器判据全部通过)
node .spike/verify-runtime.mjs .spike/verify-install2/node_modules/dsh-code-server-app
#   → modules 16, installed 16, resolved 16, missing 0
```

基线(同一脚本、同一个 0.3.44 profile)报的是 17 条,第一条逐字就是用户看到的那句。
**结论:根因在 desktop 的「装完就校验」顺序,我们这边能做的是让自己不再依赖那个 pnpm 行为。**
桌面应用侧的根治办法(改包的 mutation 也走完整安装)记在
`docs/desktop-first-install-root-cause.md` 第三节,由用户决定是否改那份检出。

## 26. 0.3.66:配置数据面从 `settingsScope` 迁到 `configForms`(并保留 rc 线)

### 26.1 现场(DSH 0.1.7-alpha.1)

启动即:

```
Failed to load plugins
web boot: 1 entry did not activate
dsh-code-server-app: pending (waiting for service: settingsScope)
```

**右侧栏标签、设置区、常驻预热一起消失**,而且只有这一行日志 —— 因为客户端条目的静态
`inject = ['slots','settingsScope']` 在 0.1.7-alpha.1 上永远等不到那个服务(条目 pending ⇒ `apply` 根本没跑)。

### 26.2 三个事实(逐条读源码/包得到的,不是版本号推测)

| 事实 | 证据 |
|---|---|
| **座位**与**数据通道**的分界点**不在同一版** | `@deepseek-ai/dsh-cordis-client-runner` 词汇表命中数:`0.1.5-rc.3` = `settingsScope`×1 + `settings.plugin.item`×3;`0.1.6-alpha.2` = `settingsScope`×1 + `plugins.bundle.config`×4;`0.1.7-alpha.1` = `configForms`×1 + `plugins.bundle.config`×4(**`settingsScope` 0 命中**) |
| 客户端新通道是 `ctx.configForms.get(entryId)` | `dsh-client-ui-settings/lib/types/client/config-form.d.ts`:`get(entryId)` 内部就是 `new ConfigFormController(owner, { namespace: entryId }, …)` ⇒ **entryId 即设置命名空间**;`ConfigFormSnapshot` = `{status:'loading'\|'ready'\|'unavailable', value, base, user, revision, writable, mode}`;写只有 `mutate(ops, expectedRevision)`(另有 `set`/`unset`);注册经 `whileServed(namespaces, register)` 门禁 |
| 宿主新模型是"**条目自己的 Config**" | `dsh-settings@0.1.7-alpha.1` 不再有 `register/get/watch`,只有 `describe/update/replace/mutate/configure`;`lib/index.js` 里对非 volatile 路径直接抛 `Config field "x" is not volatile`,对没有 volatile 字段的条目抛 `Plugin entry "ns" has no volatile fields` |

### 26.3 两条线(三种真实组合)

| # | DSH | 座位 | 数据通道 | 宿主半行为 |
|---|---|---|---|---|
| ① | rc `0.1.5-rc.x` | `settings.plugin.item` | `settingsScope` | `settings.register('code-server', SettingsSchema)` + `scope.get()/watch()` |
| ② | `0.1.6-alpha.2` | `plugins.bundle.config` | `settingsScope`(这一版还在) | 同 ① |
| ③ | alpha `≥ 0.1.7-alpha.1` | `plugins.bundle.config` | `configForms` | 读 `config.<field>.get()` 活叶子 + `settings/document-updated` |

- **座位用声明驱动**(两条腿都 `slots.inject`,谁被声明谁生效),**通道用能力探测**
  (`typeof settings.register === 'function'` / `ctx.get('configForms')`)—— 判据全是能力,不做版本比较。
- 客户端 `inject` 收敛成 `['slots']`:两个通道服务都**不能**写进 inject(写进去就让另一条线上的条目 pending)。
  探测只走 `ctx.get`(未声明的服务**属性访问会抛**,这是 0.3.6 那类事故的同一根因,见 §15.8)。
- **宿主两套 schema 来自同一份字段表**(`SETTING_FIELDS` + `settingShape(wrap)`):`Config` 带 `.volatile()`,
  旧线注册的 `SettingsSchema` **不带**。原因:schemastery 3.18.3 起 volatile 是**解析期**行为
  (`createVolatile(value)` 在 schema 里完成),旧的 settings 域会把活引用直接交给线路(JSON 化后是 `{}`)
  ⇒ 卡片读到的全是空值;而 rc 线的 schemastery 是 **3.18.2,根本没有 `.volatile()`**(实测 0 命中),
  无条件调用会在模块求值期抛错、整棵插件树加载失败。故 `vol()` 先探测能力再包。
- **自带配置页要显式声明**:`ctx.inject(['settings'], child => child.effect(() => child.settings.configure({auto:false}, ctx.fiber)))`
  —— 子级是**可选**的(业务插件无 Settings 也能跑),策略只关掉"按 schema 自动生成页面",不移除配置读写。

### 26.4 回归(都在 `scripts/`,进 `run-all-tests.mjs`)

- `test-client-settings-seat.mjs`:座位 × 通道 **8 种组合**的**注入守卫**(`missingInject` 为空 + 真 apply)、
  三种真实组合的行为;新线钉"注册只在 `whileServed` 之后""写路径**只有** `mutate`(带 revision 栅栏)""`unset` = 恢复默认"
  "被拒时保留草稿";rc 线钉旧座位与 scope 注入;两条通道都缺时**侧栏标签与预热必须照旧**(第二层故障)。
- `test-client-bundle-harness.mjs`:桩里补了 `configForms`(含 `whileServed` 门禁与 mutate 镜像)、
  `@deepseek-ai/dsh-client-store` 模块表、`propsOf()`(像真壳层那样把注入面物化成 `use<Key>` hook)、
  以及**与 DSH 同语义的 `ctx.inject`/静态 `inject` 门禁**("缺一个服务就不 apply" —— 故障形态因此能在测试里复现)。
- `test-plugin-apply.mjs`:宿主两条线各一条用例(新线读 volatile 活叶子并随 `settings/document-updated`;
  旧线注册**不带 volatile** 的 schema 并订阅 `scope.watch`),外加"两份 schema 字段一致 / volatile 只在有该能力时生效"。
- 既有用例的期望随之更新:`test-fim.mjs` 与 `test-plugin-apply.mjs` 里 `plugin.Config({})` 的取值改为
  "解活引用后再断言"(同一份断言在 schemastery 3.18.2 与 3.18.3 上都成立),`test-client-entry.mjs` 的
  `inject` 断言改成 `['slots']`。

### 26.5 顺带修掉的同一个旧契约:`pickBusyEnter` 读别人的命名空间

`lib/bridge-session.mjs` 的 `pickBusyEnter` 读的是**另一个插件**的偏好(`ui-conversation.busyEnter`,
决定「问 DSH」面板按 Enter 是 `steer` 还是 `queue`),用的也是同一批被删掉的 API:

- 旧线:`ctx.settings.get('ui-conversation')`("Read one registered namespace's resolved value");
- 新线:**`SettingsForms` 没有 `get`**,只有 `describe()` → `[{ns, value, …}]`,而 `ns` 就是条目 id
  (官方 `dsh-client-ui-conversation` 客户端自己也是 `ctx.configForms.get('ui-conversation')`)。
  漏了这条通道的表现是**静默的**:用户在「设置 → 对话」里选了 steer,面板永远按 queue 投递。

修法与 `lib/index.js` 同构:先认 `get`(旧线),再认 `describe()`(新线),都拿不到/形状不对/抛错一律
回 `'queue'`;回归在 `test-bridge-extension.mjs` 的"投递方式"那条(新旧两种形状各 8~9 个断言)。

## 27. 0.3.67:插件页的图标与文案 —— 走宿主的包元数据契约

### 27.1 现象与目标

插件页那一行/那张卡一直是**占位图形 + 2000 字的描述**:标题落在 `manifest.name`,描述直接取
`package.json` 的 `description`(那段是给 npm 页面写的完整说明,README 里也说清了它是"包说明"不是"界面文案")。
目标是插件页显示**真图标**与**一句话本地化文案**,且中英文各一套。

### 27.2 契约(逐行读 `@deepseek-ai/dsh-app-boot` 的 `readPluginMeta` 得到,不是版本号推测)

| 项 | 规则 | 失败模式 |
|---|---|---|
| 图标 | package.json 顶层 `icon`:必须**相对路径**(绝对路径或带 scheme 抛错)、扩展名 ∈ {svg,png,jpg,jpeg,webp}、realpath 后仍在 manifest 目录内、常规文件、**≤ 256 KiB**;宿主转 `data:<mediaType>;base64` 交给前端 `<img src>` | **静默**:丢图标(只记 `meta.error`)⇒ 退化成占位图形 |
| 文案 | 先解析 `<包>/locale/en.json` 作**锚点**,再枚举同目录下所有 `*.json`;每份读 `meta.title` / `meta.description`(非空字符串,其它键忽略);语言名 = 文件名(`/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/`,按小写去重);返回 `{en: <manifest 兜底>, ...各语言}` | ① **缺 `en.json`** ⇒ 词典集合为空、完全不本地化;② 词典**没在 `exports` 里** ⇒ 模块解析器报 `ERR_PACKAGE_PATH_NOT_EXPORTED`,被当成"没有词典"⇒ 与 ① 同一后果:英文界面继续显示 manifest 长描述 |

`localizedText` 返回 `{ en: fallback ?? finalFallback, ...Object.fromEntries(entries) }` —— 展开在 `en` 之后,
所以 **`en` 会被 `en.json` 的值覆盖**:en.json 必须同时给 title 与 description,否则英文界面照样是长文。
前端只渲染 `meta.title` / `meta.description`(`packageText()`;行、卡片、详情页共用),manifest 的
`description` 虽仍被台账携带,但**不进插件页**。

官方范式:`@deepseek-ai/dsh-experimental-voice-input-bundle`(`"icon": "./icon.svg"` + `locale/{en,zh}.json`,
且 `files` 与 `exports` 两处都列了它们)。语言名跟随官方先例用 `zh`(不是 `zh-cn`)。

### 27.3 落地

- `package.json`:`"icon": "./assets/favicon.svg"`(复用侧栏标签已在用的那个 favicon:0.7 KB、无外链、
  内嵌 `prefers-color-scheme` 深色自适应);`exports` 加 `./locale/*.json`;`files` **逐条**列
  `locale/en.json` 与 `locale/zh.json`(不用 glob:`test-package-files.mjs` 的存在性检查是字面 `existsSync`,
  写成 `locale/*.json` 会被判"幽灵条目")。
- `locale/en.json` / `locale/zh.json`:`title = "Code Server"`(与侧栏标签、设置座位标题一致)+ 一句话描述。
- `lib/client.js` 的 guide 入口描述与 `zh.json` 统一口径(只改字符串)。

### 27.4 回归

新增 `scripts/test-plugin-metadata.mjs`(`pnpm test:metadata`,已进 `run-all-tests.mjs`):

- 图标:存在、相对、无 scheme、扩展名白名单、realpath 在包内、常规文件、≤ 256 KiB、被 `files` 覆盖、
  SVG 无 `<script>`/无外链且有 `viewBox`(它是要被内联成 `data:` 用的);
- 词典:`en.json` 锚点必须存在;每份语言 id 合法且大小写不重复;`meta` 的键集**恰好** `title` + `description`
  且各语言一致;标题 ≤ 40、描述 ≤ 140(插件页一行放不下就该改文案,而不是被截断);
- **通道守卫**:`exports` 必须暴露 `./locale/*.json`(否则静默不本地化)、`en.json` 的描述不得等于
  `manifest.description`、`package.json` 里不许写顶层 `title`(宿主不读它 ⇒ 写了会让人误以为生效)。

结论:上面两个**静默失败**模式现在都在本地测试里直接报错,而不是在界面上悄悄退化。

