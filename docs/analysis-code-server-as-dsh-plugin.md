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

## 9. 不再兼容旧版 DSH(0.2.3)

### 9.1 决策与范围

- 旧版 DSH(2026 早期、尚无右侧栏服务的版本)此前的载体是**插件自绘的悬浮球 + 内部浮动窗口**(参照 univer-office
  的 WorktreeWindow)。0.2.3 起**整段删除**:常驻面、剪贴板 `allow`、面板折叠/分屏/全屏、键盘焦点都建立在
  DSH 右侧栏之上,维护两套载体的成本高于其残余价值。
- 旧版上的行为收敛为一条**设置页提示**(`设置 → 插件 → Code Server`):说明缺 `sidebarRightTabs`/`sidebarRight`
  服务、本插件不再支持该版本、升级路径(≥ 0.1.5-alpha.1);升级后无需重装,刷新页面即恢复完整卡片。

### 9.2 探测方式(特性检测,不按版本号硬判)

1. 先同步探测:`ctx.get('sidebarRightTabs')` 与 `ctx.get('sidebarRight')` 同时存在 → 现代 DSH,立即注册;
2. 服务可能晚于本插件就绪 → 退回 `ctx.inject(['sidebarRightTabs','sidebarRight'], cb)` 等待;
3. **2.5 s 内既没同步命中、也没等到 `inject` 回调 → 判定 legacy**(`LEGACY_PROBE_TIMEOUT_MS`)。
   注:DSH 客户端插件里没有可靠的版本号读数(无 `version` 服务、无 `DSH_VERSION` 环境变量,
   只有 web shell 的 `window.__DSH_BOOT__`),故不引入版本比较。

### 9.3 legacy 分支到底做了什么

| 侧 | 行为 |
|---|---|
| 客户端 | 只注册 `settings.plugin.item`(提示卡,`noticeOnly` 模式:无只读条、无"保存/放弃"按钮,默认展开);**不注册** `shell.overlay`(悬浮球/预热)、`conversation.chat.turnTail`(产物按钮)、`sidebar.right.pane.tab`(侧栏 body) |
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
