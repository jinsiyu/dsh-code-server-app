# code-server 能否重构为 DSH 插件 —— 实测分析报告(Phase 0)

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
