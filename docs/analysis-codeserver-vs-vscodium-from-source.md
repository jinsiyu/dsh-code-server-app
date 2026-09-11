# code-server 与 VSCodium 的区别（逐条对照源码）

> 结论先行：**两者不是同一层的东西。** VSCodium 是「把 Microsoft 的 vscode 仓库编译成自由许可二进制的**构建脚本集合**」，产出的是**桌面 Electron 应用**；code-server 是「一个自己写的 Node/Express 服务端应用 + 一个被 patch 过的 VS Code **web/server** 子模块」，产出的是**浏览器里访问的远程 IDE**。
> 仓库自述即是最硬的证据 —— VSCodium `README.md` 首段原文：
> "**This is not a fork. This is a repository of scripts to automatically build Microsoft's `vscode` repository into freely-licensed binaries with a community-driven default configuration.**"
> 而 code-server `package.json` 的 `description` 是 "Run VS Code on a remote server."，`bin` 指向 `out/node/entry.js`。

本文所有结论均来自以下源码/构建脚本（fetched，非记忆）：

| 项目 | 关键文件 |
| --- | --- |
| coder/code-server @ main | `.gitmodules`、`patches/series`、`patches/*.diff`、`src/node/**`、`ci/build/build-vscode.sh`、`ci/build/build-release.sh`、`package.json` |
| VSCodium/vscodium @ master | `README.md`、`prepare_vscode.sh`、`utils.sh`、`get_repo.sh`、`build.sh`、`build_cli.sh`、`product.json`、`patches/**`、`docs/telemetry.md`、`upstream/stable.json` |

---

## 1. 仓库里到底有什么代码（本质差异）

### code-server：有产品源码，VS Code 是 submodule

`.gitmodules`（HTTP 200，全文）：

```
[submodule "lib/vscode"]
	path = lib/vscode
	url = https://github.com/microsoft/vscode
```

- 主仓库自带 **258 个文件**，其中 `src/` **49 个文件 / 223 KB** 是 code-server 自己的代码：CLI、Express 服务端、路由、认证、代理、i18n、wrapper……
  - `src/node/cli.ts`（31,826 B，最大源文件）—— 自己的一套 flag 体系
  - `src/node/routes/` 9 个文件：`index.ts` `vscode.ts` `login.ts` `logout.ts` `health.ts` `update.ts` `pathProxy.ts` `domainProxy.ts` `errors.ts`
  - `src/node/app.ts`（4,596 B）、`src/node/http.ts`（14,574 B）、`src/node/wrapper.ts`（11,241 B）、`src/node/vscodeSocket.ts`（5,810 B）
  - `src/browser/` 16 个文件：**只有** 登录页/错误页/图标/service worker（唯一 `.ts` 是 `serviceWorker.ts`，349 B）——编辑器 UI 不在这里
- VS Code 本体在 `lib/vscode`，**固定 commit `645f29cc3176500b4b5762ba887cf2a7f0ffdf2c`**
- 编辑器侧改动全部表达为 **28 个 `patches/*.diff`**（外加 `series` 清单，27 个 diff 入列）

### VSCodium：没有产品源码，只有构建脚本 + patch

- 仓库根目录能找到的是：`prepare_vscode.sh`、`utils.sh`、`get_repo.sh`、`build.sh`、`build_cli.sh`、`version.sh`、`release.sh`、`undo_telemetry.sh`、`product.json`、`patches/**`、`.github/workflows/**`、`build/{windows,linux,osx}`、`stores/{snapcraft,winget}`、`docs/**`
- `src/stable/` 与 `src/insider/` 下只有 **`resources/`（图标、.desktop、appdata、inno/icns/ico 素材）和 5 个 `src/vs/workbench/**/*.svg` 图**，**没有任何 TypeScript 产品代码**
- **没有 `.gitmodules`**（HTTP 404）；VS Code 由 `get_repo.sh` 在构建时现拉：
  ```bash
  git remote add origin https://github.com/Microsoft/vscode.git
  git fetch --depth 1 origin "${MS_COMMIT}"
  git checkout FETCH_HEAD
  ```
  （版本来自 `upstream/stable.json`，当前 `{"tag":"1.135.0","commit":"08d4889f9ec4a1685d257b9b95de036c8e1ce1e5"}`）
- 因此 VSCodium 的「源码」= **47 个顶层 patch（编号分组）+ 若干子目录 patch**，全部作用在临时克隆出来的 `vscode/` 上

一句话：**code-server 是应用，VSCodium 是发行版。**

---

## 2. 构建期如何改造 VS Code

| | code-server | VSCodium |
| --- | --- | --- |
| 上游获取 | git submodule `lib/vscode` | `get_repo.sh` 里 `git fetch --depth 1` 指定 commit |
| patch 载体 | `patches/*.diff`（quilt 序列，`patches/series`） | `patches/*.patch` + 少量 `*.json`（声明式动作） |
| 应用方式 | `quilt push -a`；Windows CI 退化为 `git apply --whitespace=nowarn patches/$patch` | 全局脚本 `apply_patch()` → `git apply --ignore-whitespace`；`apply_actions()` → 按 JSON 里 `action: remove` 删文件 |
| 变量注入 | 无 | `apply_patch()` 先用 `sed -E` 把 `!!APP_NAME!!`、`!!BINARY_NAME!!`、`!!ASSET_REPOSITORY!!`、`!!GH_REPO_PATH!!`、`!!GLOBAL_DIRNAME!!`、`!!ORG_NAME!!`、`!!RELEASE_VERSION!!`、`!!TUNNEL_APP_NAME!!`、`!!APP_NAME_LC!!` 替换进 patch 文本再 `git apply` |
| 构建目标 | `gulp core-ci` + `gulp vscode-reh-web-$VSCODE_TARGET-min-ci`（**只构建 reh-web**） | `gulp vscode-<platform>-<arch>-min-packing`（桌面）+ `minify-vscode-reh` / `minify-vscode-reh-web`（`build.sh` 里由 `SHOULD_BUILD_REH*` 控制） |
| 文件删除 | 无（靠 patch 内部 hunk） | 由 `patches/*.json` 驱动，如 `52-ext-copilot-remove-it.json`、`80-ui-disable-onboarding.json` |

VSCodium `prepare_vscode.sh` 的调用顺序很关键：

```bash
if [[ "${DISABLE_UPDATE}" == "yes" ]]; then apply_patch ../patches/00-update-disable.patch.yet; fi
for file in ../patches/*.json;  do apply_actions "${file}"; done
for file in ../patches/*.patch; do apply_patch   "${file}"; done
# 然后 insider/ → ${OS_NAME}/ → user/
```

注意 `*.patch.yet` / `*.patch.no` 这类后缀**故意不被 `*.patch` 通配匹配**（`00-update-disable.patch.yet`、`00-build-update-electron.patch.no`），即「保留但默认不打」。

code-server 的 `patches/series`（27 行，按顺序）：

```
integration.diff  base-path.diff  proposed-api.diff  marketplace.diff  webview.diff
disable-builtin-ext-update.diff  insecure-notification.diff  update-check.diff
logout.diff  store-socket.diff  proxy-uri.diff  unique-db.diff  local-storage.diff
service-worker.diff  sourcemaps.diff  external-file-actions.diff  telemetry.diff
cli-window-open.diff  getting-started.diff  keepalive.diff  clipboard.diff
display-language.diff  trusted-domains.diff  signature-verification.diff
copilot.diff  app-name.diff  csp-hashes.diff
```

而 VSCodium 的 patch 命名本身就编码了意图（数字前缀即顺序组）：

- `00-telemetry-disable` `00-cloud-remove` `00-settings-gallery` `00-settings-user-product`
- `00-extension-disable-signature-verification` `00-ext-github-authentication-use-pat` `00-ext-github-remove-vscodedev`
- `00-build-disable-mangle` `00-build-download-extensions-from-gh` `00-build-replace-unicode` `00-build-update-sourcemap-url`
- `10-version-add-release` `11-update-use-github-release` `12-update-add-cooldown`
- `20-keymap-use-custom-lib` `21-policy-use-custom-lib`
- `40-cli-use-reh-archive` `50-build-improve-gulp-tasks` `53-ext-copilot-remove-it`
- `60-security-add-option-for-malicious-ext` `80/81-ui-disable-onboarding`

---

## 3. 运行形态：浏览器远程 IDE vs 桌面应用（最本质的区别）

### code-server：自己监听端口，然后把请求交给 VS Code 的 web server

`src/node/app.ts`：自己 `express()` + `httpolyglot.createServer`（同时吃 http/https），并在 `args["session-socket"]` 上另开一个 **editor session manager** server：

```ts
const server = args.cert
  ? httpolyglot.createServer({ cert: ..., key: ... }, router)
  : http.createServer(router)
await listen(server, args)
const wsRouter = express()
handleUpgrade(wsRouter, server)
const editorSessionManagerServer = await makeEditorSessionManagerServer(args["session-socket"], editorSessionManager)
```

`src/node/routes/index.ts` 注册的路由（原文片段）：

```ts
app.router.use("/", domainProxy.router)
app.router.all("/proxy/:port{/*path}", ...)        // 端口代理
app.router.all("/absproxy/:port{/*path}", ...)     // 透传路径代理
app.router.use("/_static", express.static(rootPath, {...}))
app.router.use("/healthz", health.router)
if (args.auth === AuthType.Password) { app.router.use("/login", login.router); app.router.use("/logout", logout.router) }
app.router.use("/update", update.router)
for (const routePrefix of ["/vscode", "/"]) { app.router.use(routePrefix, vscode.router) }
```

`src/node/routes/vscode.ts` 把请求**直接转发进 VS Code 自己的 server 实现**（同进程）：

```ts
export interface IVSCodeServerAPI {
  handleRequest(req, res): Promise<void>
  handleUpgrade(req, socket): void
  dispose(): void
}
const mod = (await eval(`import("${modPath}")`)) as VSCodeModule   // lib/vscode/out/server-main.js
const serverModule = await mod.loadCodeWithNls()
return serverModule.createServer(null, { ...(await toCodeArgs(req.args)), "without-connection-token": true })
...
router.all(/.*/, ensureAuthenticated, ensureVSCodeLoaded, (req, res) => vscodeServer!.handleRequest(req, res))
```

为了让 VS Code 能被「require 进来」而不是自己启动，靠 `patches/integration.diff` 把 `src/server-main.ts` 顶层逻辑包成 `start()`，并只在没有 `CODE_SERVER_PARENT_PID` 时自启：

```ts
// This is not indented to make the diff less noisy.  We need to move this out
// of the top-level so it will not run immediately and we can control the start.
async function start() { ... }
export { loadCodeWithNls as loadCodeWithNls };
if (!process.env.CODE_SERVER_PARENT_PID) { start(); }
```

它自己的认证/会话逻辑：

- `src/node/routes/login.ts`：`RateLimiter` = **每分钟 2 次、每小时 12 次**；成功登录把 `hashedPassword` 写进 cookie（`res.cookie(req.cookieSessionName, hashedPassword, getCookieOptions(req))`）
- `src/node/routes/health.ts`：`/healthz` 返回 `{status: "alive"|"expired", lastHeartbeat}`
- `patches/logout.diff` + `patches/service-worker.diff` 把 `/logout`、`/update/check`、`/_static/out/browser/serviceWorker.js` 注入 `productConfiguration`

### VSCodium：桌面 Electron 应用（附带的 server 是上游 CLI 行为，不额外加壳）

- `build.sh` 主产物是 `vscode-<platform>-<arch>-min-packing`（Electron 桌面）；`build_cli.sh` 用 **Rust 编译上游 `cli/`**，且 `VSCODE_CLI_BINARY_NAME` 取自 `product.json` 的 `serverApplicationName`（即 `codium-server`），下载/更新端点被改成 VSCodium 自己的 GitHub Releases：
  ```bash
  export VSCODE_CLI_BINARY_NAME="$( node -p "require(\"../product.json\").serverApplicationName" )"
  export VSCODE_CLI_UPDATE_ENDPOINT="https://raw.githubusercontent.com/VSCodium/versions/refs/heads/master"
  ```
- reh / reh-web 是**条件构建**（`SHOULD_BUILD_REH`、`SHOULD_BUILD_REH_WEB`；Windows 非 x64 时被强制置 `no`），且默认是给「VS Code 官方 Remote/Tunnel 那套客户端」用的
- 反向证据：VSCodium 里有 `patches/linux/client/00-build-disable-remote.patch`、`00-tunnel-disable-recommendation.patch`、`00-remote-disable-client-validation.patch`——它在**削弱** remote 场景，而不是提供 web IDE
- 它没有 code-server 那套：登录页、cookie 会话、限流、`/healthz`、`/proxy/:port`、`--bind-addr`、`--auth password`……**一个都没有**

---

## 4. 扩展市场：都落到 Open VSX，但注入时机与优先级不同

### VSCodium：构建期把 `extensionsGallery` 写进 product.json

`prepare_vscode.sh`：

```bash
setpath_json "product" "extensionsGallery" '{"serviceUrl": "https://open-vsx.org/vscode/gallery", "itemUrl": "https://open-vsx.org/vscode/item", "latestUrlTemplate": "https://open-vsx.org/vscode/gallery/{publisher}/{name}/latest", "controlUrl": "https://raw.githubusercontent.com/EclipseFdn/publish-extensions/refs/heads/master/extension-control/extensions.json"}'
...
jsonTmp=$( jq -s '.[0] * .[1]' product.json ../product.json )   # 与仓库根 product.json 深合并
echo "${jsonTmp}" > product.json
```

（仓库根 `product.json` 里其实**没有** `extensionsGallery`，全是 `extensionEnabledApiProposals` / `extensionKind` / `extensionVirtualWorkspacesSupport` 之类的兼容性清单。）

再叠一层运行时覆盖 —— `patches/00-settings-gallery.patch` 往 `product.ts` 里加了**环境变量覆盖**：

```ts
const { serviceUrl, controlUrl, itemUrl, latestUrlTemplate, extensionUrlTemplate, resourceUrlTemplate } = product.extensionsGallery || {};
Object.assign(product, {
  extensionsGallery: {
    serviceUrl: env['VSCODE_GALLERY_SERVICE_URL'] || serviceUrl,
    controlUrl: env['VSCODE_GALLERY_CONTROL_URL'] || controlUrl,
    ...
  }
});
```

更有意思的是 `patches/00-settings-user-product.patch`：它让 VSCodium 在启动时读取用户数据目录下的 `product.json` 并合并进全局（`globalThis._VSCODE_USER_PRODUCT_JSON`，含 `src/cli.ts`、`src/main.ts`、`product.ts`、`src/typings/vscode-globals-product.d.ts` 四处改动）——**用户可以不重新构建就改写 product 配置**。code-server 没有这个机制。

### code-server：运行期强制 Open VSX，`EXTENSIONS_GALLERY` 可整体替换

`patches/marketplace.diff` 在 `product.ts` 里**无条件** assign（覆盖构建期 product.json 的值）：

```ts
Object.assign(product, {
  extensionsGallery: env.EXTENSIONS_GALLERY ? JSON.parse(env.EXTENSIONS_GALLERY) : (product.extensionsGallery || {
    serviceUrl: "https://open-vsx.org/vscode/gallery",
    itemUrl: "https://open-vsx.org/vscode/item",
    extensionUrlTemplate: "https://open-vsx.org/vscode/gallery/{publisher}/{name}/latest",
    resourceUrlTemplate: "https://open-vsx.org/vscode/asset/{publisher}/{name}/{version}/Microsoft.VisualStudio.Code.WebResources/{path}",
    controlUrl: "",
    recommendationsUrl: "",
  })
});
```

同一 patch 还去掉了 web extension 走 `serverRootPath` 的间接层（否则升级后 commit 变化会让已缓存的路径 404），并顺带给 `marketplace.ts` 加了 `authorizationHeaderToken` 支持。`src/node/main.ts` 里会打印 `Using custom extensions gallery`。

**两者共同的现实约束**：微软 Marketplace 的 ToS 只允许在微软自家产品里使用，所以都只能用 Open VSX；微软专有扩展需要手工 `.vsix` 安装。这一点在本仓库的 `README.md` 顶部也做了说明。

---

## 5. 遥测与网络出口：方向完全相反

| | code-server | VSCodium |
| --- | --- | --- |
| 构建期设置 | `ci/build/build-vscode.sh` 的 jq 合并里显式写 **`"enableTelemetry": true`** | `docs/telemetry.md`："we do not pass the telemetry build flags and go out of our way to cripple the baked-in telemetry" |
| 默认端点 | `patches/telemetry.diff`：`telemetryEndpoint: env.CS_TELEMETRY_URL || product.telemetryEndpoint || "https://v1.telemetry.coder.com/track"` | 无端点；`undo_telemetry.sh` 把 `.data.microsoft.com` 类域名**在源码文本里**替换成 `0.0.0.0` |
| 关闭方式 | 需要 `--disable-telemetry`（flag 存在，但默认可上报） | 默认全关：`patches/00-telemetry-disable.patch` 把一串 `default: true` 改成 `false` |
| 自研上报器 | 有：`telemetry.diff` 新增 `src/vs/server/node/telemetryClient.ts`（`AppInsightsCore` 子类，POST 到上面那个 endpoint，附带 cores/memory/shell/arch/remoteMachineId/isContainer） | 无 |

`undo_telemetry.sh` 原文：

```bash
SEARCH="\.data\.microsoft\.com"
REPLACEMENT="s|//[^/]+\.data\.microsoft\.com|//0\.0\.0\.0|g"
./node_modules/@vscode/ripgrep/bin/rg --no-ignore -l "${SEARCH}" . | xargs -I {} bash -c 'replace_with_debug "${1}" "{}"' _ "${REPLACEMENT}"
```

`patches/00-telemetry-disable.patch` 改的默认值（逐 hunk）：

```diff
- 'default': TelemetryConfiguration.ON,      + 'default': TelemetryConfiguration.OFF,
- 'default': true,  (telemetry.enableTelemetry)          + 'default': false,
- 'default': true   (command palette NL search)          + 'default': false
- default: true,    (editTelemetry)                      + default: false,
- 'default': true,  (settings NL search)                 + 'default': false,
- 'default': true,  (telemetry.enableCrashReporting)     + 'default': false,
- 'default': true,  (workbench.enableExperiments)        + 'default': false,
```

所以：**「code-server 更干净」是误解** —— 它默认开着自家遥测；VSCodium 默认全关且拿掉了微软端点。

---

## 6. 更新机制

- code-server：`src/node/update.ts` 的 `UpdateProvider`（`https://api.github.com/repos/coder/code-server/releases/latest`）+ 前端 `patches/update-check.diff` 的 6 小时轮询 / 每周提醒；`--disable-update-check` 关闭。服务端**不自升级**，只提示。
- VSCodium：`prepare_vscode.sh` 把 `product.updateUrl` 指到 `https://raw.githubusercontent.com/VSCodium/versions/refs/heads/master`、`downloadUrl` 指到自己的 GitHub Releases；`11-update-use-github-release.patch`、`12-update-add-cooldown.patch` 支撑这套；Linux 上文档说明「应用更新服务在构建期即被禁用，交给包管理器」。`DISABLE_UPDATE=yes` 时打 `00-update-disable.patch.yet`。

---

## 7. 签名校验

两家都**关掉了扩展签名校验**，但写法不同：

- code-server `patches/signature-verification.diff`：
  ```diff
  - const value = this.configurationService.getValue(VerifyExtensionSignatureConfigKey);
  - verifySignature = isBoolean(value) ? value : true;
  + verifySignature = false;
  ```
- VSCodium `patches/00-extension-disable-signature-verification.patch`（1068 B，同类改动）

---

## 8. 分发形态

**code-server**（`ci/build/build-release.sh` + `ci/build/build-vscode.sh`）：

- npm 包（`main: out/node/entry.js`，`bin: code-server`），`postinstall.sh` 在安装侧补装 `lib/vscode` 依赖并建 `remote-cli`/`helpers` 软链
- standalone 压缩包：把 `out/`、`src/browser/{media,pages,robots.txt}`、`lib/vscode-reh-web-$VSCODE_TARGET/`（排除 `/node`）打在一起，并在 `lib/` 放一份 node 二进制
- 注意 `bundle_vscode()` 会把内嵌 VS Code 的包名改成 `code-oss`：`.name = "code-oss"`，注释写明是防止漏洞扫描器误判（#7071）
- 另有 deb/rpm（`ci/build/nfpm.yaml` + `code-server@.service`）、systemd、Docker（`ci/release-image/Dockerfile*`）、**Helm chart（`ci/helm-chart/` 12 个文件）**、`install.sh`、Nix flake

**VSCodium**（`README.md` 的 Supported Platforms + `.github/workflows`）：

- macOS `zip`/`dmg`；Windows 安装器（Inno `build/windows/rtf` + MSI `build/windows/msi/vscodium.wxs` 112 KB + AppX）；Linux `deb`/`rpm`/`AppImage`/`snap`/`tar.gz`
- 多架构：x64 / arm64 / **riscv64 / loong64 / ppc64le**（`patches/linux/41..46` 系列 + `.github/workflows` 交叉编译）
- 渠道：brew / winget / choco / scoop / snap / AUR / flatpak
- 更新链路由 `VSCodium/versions` 仓库承载

---

## 9. 能力矩阵（差异速查）

| 维度 | code-server | VSCodium |
| --- | --- | --- |
| 形态 | 服务端 + 浏览器 IDE | 桌面 Electron 应用 |
| 自带产品源码 | 有（`src/` 49 文件 / 223 KB） | 无（只有资源与 5 个 svg） |
| VS Code 引入方式 | git submodule（固定 commit） | `get_repo.sh` 构建期 `git fetch --depth 1` |
| Patch 数量级 | 27 个 diff | 47 个顶层 patch + 子目录（linux/osx/windows/alpine/insider/helper/user） |
| VS Code 版本 | 由 submodule 锁定 | 由 `upstream/stable.json` 锁定（现 1.135.0） |
| 认证 | 自带登录页 + argon2 + 限流 + cookie（`--auth none\|password`） | 无（桌面应用不需要） |
| 反向代理友好 | `--proxy-domain` / `/proxy/:port` / `/absproxy/:port` / `--abs-proxy-base-path` / `base-path.diff` | 无 |
| 健康检查 | `/healthz`（HTTP + WS） | 无 |
| 幂等/状态隔离 | `unique-db.diff`（IndexedDB 按 URL 路径哈希）、`local-storage.diff`（设置落盘到服务器） | 桌面本地状态 |
| 扩展市场 | Open VSX（运行期覆盖，`EXTENSIONS_GALLERY` 可换） | Open VSX（构建期写 product.json + `VSCODE_GALLERY_*` 可覆盖 + 用户 product.json 合并） |
| 遥测 | **默认开**（`enableTelemetry: true`，Coder endpoint，`--disable-telemetry` 关） | **默认关**（改默认值 + 屏蔽微软端点） |
| 扩展签名校验 | 关闭 | 关闭 |
| 自更新 | 仅提示 | 桌面自更新（GitHub Releases；Linux 交给包管理器） |
| Copilot | `patches/copilot.diff`（打补丁以可用） | 整套移除（`52-ext-copilot-remove-it.json` + `53-ext-copilot-remove-it.patch` 133 KB） |
| 多用户/远程协作定位 | 明确（Coder 生态、Helm、Docker） | 单机桌面 |

---

## 10. 容易搞错的几点（源码级澄清）

1. **不是「VSCodium = 无遥测版 code-server」**：一个是桌面 App，一个是浏览器服务；遥测默认值还正好相反（见 §5）。
2. **VSCodium 不是 fork**：它没有维护 VS Code 代码分支，只是「克隆上游 + 打 patch」的产物（`README.md` 首段）。
3. **code-server 的 web UI 不是它自己写的**：`src/browser/` 只有登录/错误页和图标；真正的 workbench 来自 `lib/vscode` 的 `vscode-reh-web` 构建产物，code-server 用 `IVSCodeServerAPI.handleRequest/handleUpgrade` 把流量导进去（`src/node/routes/vscode.ts`）。
4. **VSCodium 里确实有 server/reh/web 构建目标**（`build.sh` 的 `SHOULD_BUILD_REH*`、`build_cli.sh` 编 Rust CLI、`product.json` 里 `serverApplicationName: codium-server`），但它**没有 code-server 那套面向浏览器多用户的壳**（认证/代理/健康检查/i18n 登录页）。
5. **`patches/*.patch.yet` / `*.patch.no` 不是笔误**：VSCodium 用后缀让它们逃过 `../patches/*.patch` 的 glob，属于「保留待用」的补丁（如 `00-update-disable.patch.yet`、`00-build-update-electron.patch.no`）。
6. **日期/版本会漂移**：本文引用的行号/大小对应抓取时刻；`patches/` 目录曾整体重命名（jsDelivr 缓存里还是旧名 `marketplace.diff`、`use-github-pat.patch`、`disable-cloud.patch` 等），所以**任何静态文件清单都可能过期**，请以 GitHub API 的实时目录为准。

---

## 附：抓取来源

- https://raw.githubusercontent.com/coder/code-server/main/.gitmodules
- https://raw.githubusercontent.com/coder/code-server/main/patches/series
- https://raw.githubusercontent.com/coder/code-server/main/patches/{integration,base-path,marketplace,webview,local-storage,unique-db,service-worker,update-check,telemetry,signature-verification}.diff
- https://raw.githubusercontent.com/coder/code-server/main/src/node/{cli,main,app}.ts
- https://raw.githubusercontent.com/coder/code-server/main/src/node/routes/{index,vscode,login,health}.ts
- https://raw.githubusercontent.com/coder/code-server/main/ci/build/{build-vscode,build-release}.sh
- https://raw.githubusercontent.com/coder/code-server/main/docs/npm.md
- https://api.github.com/repos/coder/code-server/git/trees/main?recursive=1
- https://raw.githubusercontent.com/VSCodium/vscodium/master/README.md
- https://raw.githubusercontent.com/VSCodium/vscodium/master/{prepare_vscode,utils,get_repo,build,build_cli,undo_telemetry}.sh
- https://raw.githubusercontent.com/VSCodium/vscodium/master/{product.json,upstream/stable.json}
- https://raw.githubusercontent.com/VSCodium/vscodium/master/docs/telemetry.md
- https://raw.githubusercontent.com/VSCodium/vscodium/master/patches/{00-telemetry-disable,00-settings-gallery,00-settings-user-product,00-ext-github-authentication-use-pat,00-remote-disable-client-validation}.patch
- https://api.github.com/repos/VSCodium/vscodium/contents/patches
