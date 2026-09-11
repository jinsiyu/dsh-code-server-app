# dsh-code-server-app — 在 DSH 中集成 code-server(VS Code 网页版)

> 源码仓库地址见 `package.json` 的 `repository` / `homepage` 字段。

> ## ⚠️ 扩展市场说明(重要)
>
> - **code-server 的扩展商店是 [Open VSX](https://open-vsx.org/),不是微软 Visual Studio Marketplace**;
> - 微软 Marketplace 的条款**禁止第三方产品(含 code-server)使用其 API**,所以 code-server 无法查询微软市场的扩展列表;
> - 因此微软**商业/专有**扩展(如 **GitHub Copilot、Remote-SSH 等 Remote 系列、Azure 系列、IntelliCode**)在商店里**找不到**——这是微软发行策略,不是缺失;
> - 微软**开源系**扩展(Python、TypeScript 调试、ESLint 等)在 Open VSX 有镜像,搜索正常可装;
> - **需要微软专有扩展时**:从 Marketplace 网页下载 `.vsix`,用 `code-server --install-extension <文件>`(或放入 `--extensions-dir`)手动安装,即可在插件列表使用。

静态 profile 插件(npm 包形态,host + client bundle),把 [code-server](https://github.com/coder/code-server)
发行版里的 **VS Code server 树** 作为平台无关依赖随插件安装(打包期产物 `vendor/vscode` → `@jinsiyu/dshcs-vscode-server`,
无安装脚本、无 postinstall);**code-server 的 Node 服务层已由插件自带的 `lib/launcher.mjs` 取代**
(它直接驱动 `<树>/lib/vscode/out/server-main.js` 的 `loadCodeWithNls()` / `createServer()` / `handleRequest()` /
`handleUpgrade()`,并补上 `/healthz`、`/manifest.json`、`/_static/*`、`/proxy/:port` 这几条 code-server 原本提供的 HTTP 面);
原生模块(node-pty / @vscode/sqlite3 / spdlog …)由 `@jinsiyu/dshcs-*-win32-<架构>` 平台包经聚合包按架构自动选中 ——
**无需全局 npm 安装、无需配置 `bin`、无需改 profile 配置、无需第二条安装命令、无需 argon2/C++ 工具链**。

> 0.2.0 起:**argon2 与 code-server 的 136 个运行时依赖(express / proxy-agent / js-yaml / pem / limiter …)
> 全部不再随包分发**(减少 ~34.5MB + 一条原生构建链);IDE 提供方式见下方「服务方式(serve)」。
> 依据与实测证据见 `docs/analysis-code-server-as-dsh-plugin.md`(含子路径挂载、WS 路径、命名管道、fence 的逐项验证)。

## UI 载体与 DSH 版本要求(0.2.3 起只支持带右侧栏的 DSH)

| DSH 版本 | 载体 | 入口 |
|---|---|---|
| **≥ 0.1.5-alpha.1**(有 `sidebarRight` / `sidebarRightTabs` 服务) | **右侧栏标签**(kind=`code-server`,标签名 `Code Server`),并**认领文件地址**(见下) | ① **DSH 官方的产物 chip / 「交付」卡片预览 / 正文里的文件名**(0.2.5 起,走官方 `openFile` → 文件地址 → 本 tab);② 右侧栏「开始」页的 **Code Server 入口框**;③ 设置 → 插件 → Code Server → **「在右侧栏打开」** |
| 更早(无右侧栏服务) | **不受支持**:除设置页的一条提示外**不提供任何入口** | 无(设置 → 插件 → Code Server 显示升级提示) |

- 检测方式:先 `ctx.get('sidebarRightTabs') / ctx.get('sidebarRight')` 同步探测;
  服务可能晚于本插件就绪,则 `ctx.inject(['sidebarRightTabs','sidebarRight'], …)` 等待,
  **2.5 s 内仍未就绪即判定旧版 DSH**(不按版本号硬判,也不影响插件激活)。
  0.2.4 起判定**可逆**、且注册不再依赖 `ctx` 属性访问(desktop 上曾因此静默不注册、表现为"设置卡正常但侧栏没有入口"):
  - 服务查找先读 `ctx.<name>`,再回退 `ctx.get(name)`——两种上下文形态都能注册;
  - 同步已能看到服务、但 `inject` 迟迟不回调时,**1.5 s 后用同步服务兜底注册**;
  - 2.5 s 只给设置页提示,**10 s** 仍无服务才通知 host 回收/停止预启动(避免误杀慢启动的宿主);
  - 服务晚到 → 自动撤销旧版判定、补注册侧栏,并上报 `{sidebar:true}` 让 host 恢复;
  - 注册失败不再静默:控制台报错,设置卡入口行显示"已探测到右侧栏服务,但标签注册失败"。
- **0.2.3 起不再兼容旧版 DSH**:悬浮球与内部浮动窗口回退**已删除**。判定为旧版时:
  - 只注册设置卡片,内容是一条升级提示(见下),不注册悬浮球/浮窗/**文件地址认领**,也不预热 IDE;
  - 客户端向 host 上报 `/api/code-server/ui-mode { sidebar:false }`(在上面的 10 s 宽限之后),host 据此**回收自动预启动的实例**
    并停止预启动(用户手动启动的实例不受影响);服务随后才出现时会再上报 `{sidebar:true}` 撤销;
  - 升级 DSH 后**无需重装插件**,刷新页面即可,本页会恢复为完整设置卡片。
- 侧栏标签内即 code-server 页面(iframe),跟随当前会话工作区;面板可折叠/分屏/浮动/全屏(由 DSH 右侧栏提供)。
- **打开即全屏(0.2.9 起,默认开)**:打开 Code Server 标签(含点开产物 chip / 交付卡片 / 正文文件名)时,
  自动把右侧栏从"与对话并排"切到**全屏**(铺满窗口)——IDE 在窄栏里太挤。
  只影响"打开那一刻":随时点右侧栏的「退出全屏」不会被抢回去;切走再切回、再次打开文件 tab 会重新切全屏。
  不想要就在设置卡片里关掉(`fullscreenOnOpen=false`)。
  - 实现说明:DSH **没有**把"模式"开放给插件 —— `ctx.sidebarRight` 只有 `isExpanded`/`toggleExpanded`(展开/收起),
    push ⟷ fullscreen 记在 `ui-sidebar-right` 自己的 store 里(`actions.setMode`,只发给它的 seat 内部组件);
    `ctx.layout.openRightbar(track, fullscreen)` 也不是控制面,而是 seat 用来**汇报** presentation 的通道
    (上游源码注释:*the occupant reports it; nothing else writes it*)。
    所以本插件做的是"用户那个动作本身":`closest('[data-sidebar-right-panel]')` 定位自己所在面板,
    再点面板 chrome 上的 `[data-sidebar-right-mode="fullscreen"]` 按钮(与手点完全同一条路径,
    含窄视口下的连带处理)。按钮找不到时保持原模式并 `console.warn` 一条,绝不影响面板渲染。
- **IDE 常驻(0.2.2 起,默认开)**:切到别的标签/收起侧栏再回来**不再重载** code-server——
  未保存的编辑缓冲区、终端、调试会话都留在原处(见下方「为什么切标签不再重载」)。
- 设置卡片只有**三个设置**:「**认领范围**」「**打开即全屏**」与「**后台常驻(切标签不重载)**」——没有其它行(0.2.7 起移除「入口」「依赖安装」「环境检测」)。
  打开 IDE 用右侧栏「开始」页的 **Code Server 入口框**,或直接点官方的产物 chip / 交付卡片 / 正文文件名;
  诊断看 DSH host 日志里的 `[code-server]` 输出(`/api/code-server/status` 仍返回 `env` 供脚本排查)。
  旧版的 `windowedOpen`(窗口化打开)、`reserveComposer` 已在 0.2.6 移除:旧设置文档里残留的这两个键不会报错,只是被忽略(不再出现在 schema 里)。
  需要在新标签页用 IDE 时,直接访问回环地址 `http://127.0.0.1:<port>/`(`serve: dsh` 时为 DSH 的 `/code-server/`)。

## 文件打开(0.2.5 起走官方入口)

DSH 用**资源地址**命名文件,`openFile` 只负责把地址交给右侧栏去认领:

```
官方产物 chip / 「交付」卡片预览 / 正文内联提及
      → openFile(path, { line? })                     (ui-chat 提供)
      → dsh-resource://file/session/<sessionId>/<path> (或 …/file/absolute/<path>)
      → ctx.sidebarRight.openResource(address)
      → 由注册了匹配 patterns 的 tab 类型认领(优先级 extension(3) > builtin(2) > fallback(1),
        同带内按 pattern 长度、再按注册顺序)
```

本插件注册时带上:

| 字段 | 值 | 作用 |
|---|---|---|
| `patterns` | `['dsh-resource://file/**']` | 认领文件地址(含 `:` 的 pattern 按**整址** glob 匹配) |
| `priority` | `'extension'` | 高于官方纯文本预览的 `fallback`——DSH 源码注释写明后者是"VS Code 文本编辑器在编辑器中的位次,任何更具体的类型都应当击败它" |
| `canOpen` | 见下 | 按「认领范围」设置否决,未认领的地址由官方预览兜底 |
| `title` | 地址末段(=文件名) | tab chip 显示文件名;页面 tab(`sidebar://code-server`)仍是 `Code Server` |

- **认领范围**(设置卡片可切,`fileOpenScope`):
  - `session`(默认)= 只认领 `dsh-resource://file/session/…`(会话里的产物、交付、正文提及、工具视图都走这条);
  - `all` = 连不带会话的 `dsh-resource://file/absolute/…` 也认领("所有文件"模式)。
- **tab body 怎么定位文件**:从 `useTabInfo().tab.navigation.address` 解析出会话与路径
  (`src/address.js`,与 DSH `parseFileAddress` 同语义),相对路径按该会话 cwd 展开成绝对路径,
  再把绝对路径 + 可选 `line` 交给 host 的 `/api/code-server/open-file`;内建扩展
  (`dshcs-open-file`)在 workbench 里 `showTextDocument`(带行号时定位到该行)。
- **一个地址 = 一个 tab**(官方语义,`contentId` 就是地址):打开三个文件会有三个 chip,
  但它们共用同一个常驻 workbench(我们的 IDE 是单实例),切换时只是让 workbench 定位到对应文件。
- **为什么还留着那个内建扩展**:VS Code Web 没有"从外部打开文件"的官方 API(唯一入口是
  `?folder=` 指定工作区),所以"让 workbench 定位到某个文件"只能由树内的扩展完成;
  host 写信号文件、扩展轮询并 `showTextDocument`,失败保留重试(实例尚未就绪时也不会丢)。

## 为什么切标签不再重载(IDE 常驻)

**过去的坑**:DSH 的右侧栏(ui-dockkit)`TabPanel` **只渲染当前激活标签的 body**
(`TabPanel.tsx:412` → `renderTab(active)`)——切到别的标签 = React 卸载该 body = iframe 被移出文档 =
浏览上下文销毁,切回来就是一次完整的 VS Code 重载(未保存的缓冲区丢失)。把标签浮动成独立面板只是绕开它,
并没有解决。

**现在的做法(客户端 `src/surface.js`,0.2.2)**:插件把 iframe **从 React 手里接管**,做成**单例常驻面**:

| 场景 | 动作 | 结果 |
|---|---|---|
| 标签激活 | `host.moveBefore(frame, null)` 移进当前可见的停靠位 | 状态保持型原子移动,**不重载** |
| 标签失活 / 收起侧栏 | 移回文档级 park 容器(离屏、保留最后停靠尺寸、`inert` + `aria-hidden`) | 面不销毁,后台继续跑 |
| 工作区 / 端口变化 | 显式设置 `src` | 这是唯一正常的"重载"入口 |

- **为什么是 `moveBefore`**:浏览器实测(Edge/Chromium 151)普通 `appendChild` 移动 iframe 会让内部计时器**归零**
  (等价重载),而 `Element.moveBefore()`(Chromium ≥133)保持状态(计时器 1→2 连续)。
- **降级不静默**:`moveBefore` 缺失、或宿主已被 React 摘除而抛 `HierarchyRequestError: invalid hierarchy`
  (passive effect cleanup 晚于 DOM 卸载)时,退回 `appendChild`——会重载一次,但**绝不丢帧**;
  状态里 `degraded`/`lastMoveError` 明示,界面据此提示"常驻不可用"。
- **重绘兜底(实测坑)**:真实 GUI 里观测到一次"元素在、画面不重绘"——iframe 尺寸、命中测试、`visibility`
  全部正常,面板却一片白(连续两张截图哈希相同,确认没有新帧);`translateZ(0)`、`opacity` 微调无效,
  `display:none → 强制重排 → 还原`(同一个 JS 任务内)可恢复,且 iframe 文档不重载、内部状态不变、无可见闪烁。
  **触发条件未能复现**:探针页里 `moveBefore` 停放 337 s(超过 Chrome 对不可见跨源 iframe 的 ~5 min 节流窗口)
  后移回、且关掉修复,仍正常绘制。因此把它当**兜底**保留:每次「停放 → 停靠」补一次
  `nudgeRepaint()`(`surfaceSnapshot().nudgeCount` 计数,`setNudgeEnabled(false)` 可现场 A/B)。
- **后台预热**:配置 `keepResident`(默认 `true`)时,宿主在插件启动后就把面建好并停在停放区,
  首次点开标签无需冷启动等待;`preload` 不会把正在使用的面拽走。
- **排障句柄**:控制台可用 `window.__dshcsSurface`(`snapshot()` / `setParkStrategy('offscreen'|'behind')` /
  `dock()` / `park()` / `nudge()` / `setNudgeEnabled(false)` / `destroy()`)。

**实测记录**(DSH web GUI,sidebar 标签间真实鼠标切换):切走 → `docked:false`、iframe 仍为同一节点、内部探针存活、
`degraded:false`;切回 → `docked:true`、`src` 不变、IDE 画面与编辑状态保持(无整页重载)。
完整证据与探针脚本见 `docs/analysis-code-server-as-dsh-plugin.md`。

## 服务方式(serve)

| 方式 | 说明 | 需要 |
|---|---|---|
| **`loopback`(默认)** | 插件自己起一个回环端口(`host:port`),右侧栏 iframe 跨源直连;进程可被 adopt(DSH host 重启后接管) | 无 |
| **`dsh`** | IDE 挂到 **DSH 自己的 HTTP 端口**上的 `/code-server/*`(HTTP prefix 路由)+ `/code-server/<quality>-<commit>`(WS 精确路由),转发到 launcher 的**命名管道**;**没有额外端口**;每条请求(含 WS 握手)先过 `ctx.connection.requestRejection()` —— 与 `/api` 同一套 Host/Origin fence + 浏览器 cookie 认证 | DSH 提供 `webServer` 服务(web profile);desktop 无此服务 → 自动回退 loopback |

- 在 `cordis.patch.yml` 的 `config.serve`(或设置文档里的 `code-server.serve`)切换,下次启动生效 —— **设置卡片不提供这一行**(卡片只有认领范围/打开即全屏/后台常驻三个设置)。
- `dsh` 模式的实际收益:单一 URL/单一端口(远程访问 DSH 即可用 IDE)、不再暴露额外回环端口、认证与 DSH 同级。
- `dsh` 模式的两点**已知取舍**:
  1. iframe 与 DSH **同源** → 该模式下不再挂 `sandbox`(同源 + `allow-same-origin` 可被 frame 自行摘除,属"看起来有防护");
     `loopback` 模式跨源,`sandbox` 保持原样作为真防护。剪贴板仍由 `allow="clipboard-read; clipboard-write"` 提供。
  2. 转发端口(Ports 面板)的 **WebSocket** 无法用精确升级路由覆盖(端口号在路径里)→ 该功能在 `dsh` 模式下不可用;
     HTTP 转发端口正常;需要端口转发 WS 时请用 `loopback` 模式。

- `loopback` 模式下 upgrade 会做 **code-server 同款 Origin 校验**(0.2.1 起):带 `Origin` 时其 host 必须等于 `Host`
  (含 `Forwarded: host=` / `X-Forwarded-Host` 的反代语义),否则回 `403`;缺 `Origin` 的非浏览器请求放行。
  没有这道检查时,本机任意浏览器页面都能对 `ws://127.0.0.1:<port>/stable-<commit>` 完成握手并驱动 IDE。

## 旧版 DSH(0.2.3 起不再支持)

**行为**:探测不到 `sidebarRightTabs` / `sidebarRight` 时,插件只注册一张设置卡片,内容是:

> **Code Server** — 当前 DSH 版本不受支持(缺少右侧栏服务)
> 本插件自 0.2.3 起不再兼容旧版 DSH。
> 未检测到右侧栏插件服务 sidebarRightTabs / sidebarRight,因此插件不提供任何入口(旧版的悬浮球与浮动窗口已移除),
> 也不会后台启动 IDE。升级 DSH 到带右侧栏的版本(≥ 0.1.5-alpha.1)后,Code Server 会出现在右侧栏标签里,
> 本页同时显示完整设置项;升级后无需重装本插件,刷新页面即可。

- **没有任何其他 UI**:不注册 `shell.overlay`(悬浮球)、不认领文件地址、不做常驻预热。
- **host 侧**:客户端会 `POST /api/code-server/ui-mode { sidebar:false }`;host 收到后
  ① 不再自动预启动 IDE(`maybePrestart` 直接返回),② 若 IDE 是本插件刚自动预启动且尚未被 adopt,则**回收**该进程,
  避免留下一个用不上的 IDE 与端口。用户手动启动的实例(`adopted`)不会被停。
- **为什么删除而不是保留**:内部浮动窗口是 2026 年早期 DSH(无右侧栏服务)时代的临时载体,
  常驻面、剪贴板、快捷键、面板折叠等能力都建立在 DSH 右侧栏之上;维护两套载体的成本高于其残余价值。
  旧版用户继续用 `0.2.2` 即可(`dsh plugin --profile web add dsh-code-server-app@0.2.2`)。
- **回滚**:任何版本都能降级到旧版实现,例如 `dsh plugin --profile web add dsh-code-server-app@0.2.2`。

## code-server 服务目录与进程生命周期

- code-server 服务目录**跟随活动工作区/会话**:打开期间切换 DSH 会话/工作区,code-server 自动重启到新目录
  (解析优先级:当前会话 cwd → 会话所属 workspace.path → recentWorkspace.path → 首个 workspace.path);
  打开目录显示在 code-server 页面内(`?folder=<cwd>`,跟随切换时页面自动重新加载);
  实现要点:iframe src 必须带 `?folder=<cwd>`——code-server 前端会记住“最近工作区”并自行恢复,
  仅用裸根 URL 只会显示上一次打开的目录、不会跟随切换(本机实测确认)。
  **Windows 路径格式(实测)**:folder 参数必须以 `/` 开头且全部正斜杠,形如 `/C:/Users/User/Desktop/biss`;
  裸 Windows 路径(`C:\...`)会被前端当 URI scheme 而剥掉盘符(页面显示 `\Users\User\...` 且文件树为空),
  `file:///C:/...` 形式则报 “Workspace does not exist”。
- process 生命周期由 host 插件管理:启动写 `$DSH_HOME/code-server/pid.json`,停止树级终止(taskkill /T 或进程组 SIGKILL),
  崩溃/退出实时更新状态;DSH host 重启后自动 adopt 仍在运行的实例(校验 pid + /healthz),不重复启动、不误杀别的进程;
- `node_modules`、`vendor/` 与 `repack/` 已被 `.gitignore` 排除,推送/克隆仓库后按下方
  "打包(如何出包)"执行 `pnpm install` → `pnpm run build:client` → `pnpm run vendor:vscode` →
  (发布预编译原生包)→ `pnpm pack` + `dsh plugin --profile web add` 即可。

> 本机(BM: Windows 11 ARM64)实测:`code-server@4.136.2`(with Code 1.136.1)由平台子包
> `@jinsiyu/dshcs-code-server-win32-arm64` 提供(主包 0.1.37 仅 105KB),
> 35 个纯 JS 内部依赖 + 16 个预编译原生包(经平台聚合包装回原名)由 pnpm 一条命令装好 →
> healthz 200 → 运行中切换 cwd 重启 → 停止 → 回收全链路验证。

## 打包(如何出包)

```powershell
cd C:\Users\User\Desktop\dsh-code-server-app
pnpm install             # 开发依赖(esbuild + motion);allowBuilds 已显式声明 → 不执行任何 postinstall
pnpm run build:client    # src/factory.js → lib/client.js(不入库,必须先构建)
pnpm run vendor:check    # 可选:查看内置 VS Code 树版本 vs code-server 最新版
pnpm run vendor:vscode                            # ① 生成 vendor/vscode(精简 VS Code 树,≈197MB)
pnpm run repack:build -- --target win32-arm64,win32-x64 --pack   # ② 统一脚本产出全部子包(见下表)
pnpm run publish:repacks                         # ③ 发布全部 @jinsiyu/* 子包(默认 dist-tag = next)
pnpm pack                                        # ④ → dsh-code-server-app-<version>.tgz(约 107KB)
pnpm run publish:plugin                          # ⑤ 发布插件本体(默认 dist-tag = next)
# 用户重启 dsh web 确认无误后,再把 latest 推进到该版本:
pnpm run promote -- <version>
```

> **dist-tag 政策(必须遵守)**:发布一律发到 **`next`**,**不动 `latest`**;
> `latest` 只保留「最近一个确认无 bug 的版本」,由 `pnpm run promote -- <version>`
> (= `npm dist-tag add dsh-code-server-app@<version> latest`)在**用户重启 dsh web 确认无误后**才推进。
> 这样 `dsh plugin add dsh-code-server-app`(不带版本)和任何按 latest 安装的流程都不会拿到未验证的版本。
> 子包(`@jinsiyu/dshcs-*`、聚合包)被依赖以精确/插入符版本引用,dist-tag 不影响解析,但同样默认发 `next`。
> 查看当前标签:`npm dist-tag ls dsh-code-server-app`。

`repack:build`(`scripts/vendor-repacks.mjs`)是**唯一的子包产出脚本**,一次生成:

| 子包 | 内容 | os/cpu |
|---|---|---|
| `@jinsiyu/dshcs-vscode-server@<code-server 版本>` | 精简 VS Code 树(`lib/vscode` + `out/browser` + `src/browser`,**不含** code-server 的 `out/node` 与 136 个运行时依赖) | 平台无关 |
| `@jinsiyu/dshcs-<名字>[-win32-<arch>]` ×16 | VS Code 内部依赖里需要构建的原生包(node-pty / @vscode/sqlite3 / kerberos / koffi / ssh2 / spdlog / …) | 平台专属带 os/cpu |
| `@jinsiyu/dsh-code-server-runtime-win32-<arch>` | 平台聚合包:`dependencies` 用 `npm:` 别名把上面 16 个原生包装回原始名字 | win32-<arch> |

> argon2 已随 code-server 服务层一起移除(0.2.0):`auth` 固定 `none`,需要对外访问请用 `serve: dsh`。

| 目标 | 命令 |
|---|---|
| **打最新版(上游 code-server 发行版)** | `pnpm run vendor:latest`(= `--force`):从 registry 取 `code-server@latest` 的树到 `vendor/vscode`;之后**必须**重跑 `repack:build` 并重发全部子包 |
| **指定版本** | `pnpm run vendor:vscode -- --version 4.136.2` |
| **从已装好的树快照** | `pnpm run vendor:vscode -- --from <code-server 目录>`(秒级) |
| **开发期让树可直接跑** | `pnpm run vendor:vscode -- --dev-links`(额外把 `lib/vscode/node_modules` 用 junction 补上) |
| **完整重打子包** | `pnpm run repack:build -- --target win32-arm64,win32-x64 --pack`(不给 `--from` 会自动 npm install 解包 + 编译,耗时) |
| **只重打树包/聚合包** | `node scripts/vendor-repacks.mjs --reuse --target win32-arm64,win32-x64 --pack`(复用 `repack/build` 里已有的原生包,不重新分析源树) |
| **发布子包** | `pnpm run publish:repacks`(`--dry-run` 预览;`--only <子串>` 过滤;`--otp <code>` / `--limit N` 应对 2FA) |
| **发布插件本体** | `pnpm run publish:plugin`(发布**已验证过的那份 tarball**,不会重新打包;默认 dist-tag = `next`) |
| **推进 latest** | `pnpm run promote -- <version>`(用户重启确认无误后;`--dry-run` 先看当前标签) |
| **只报告版本** | `pnpm run vendor:check` |

> `pnpm pack` 的 `prepack` 会自动跑一次 `vendor-vscode-server` 脚本;`vendor/vscode` 已存在时它是
> **秒级 no-op**,所以日常只改插件代码的话直接 `pnpm pack` 即可(不会偷偷升级 VS Code)。
> 升级树必须显式 `pnpm run vendor:latest`(或 `--force`/`--version`),并重发子包。

## 安装插件(一条命令;依赖全部由包管理器装好)

```powershell
# 包内无 postinstall → 无需 pnpm approve-builds / allowBuilds;一条命令装完
dsh plugin --profile web add dsh-code-server-app@0.2.1
# 本地 tarball 同理:
dsh plugin --profile web add C:\Users\User\Desktop\dsh-code-server-app\dsh-code-server-app-0.2.1.tgz
```

装完即用,**没有第二步、没有「安装环境」、不弹安装指引**。主包约 **110KB**(插件自身代码 + launcher),
其余全部是依赖:

- **VS Code 树**(`lib/vscode` 196.9MB + `out/browser` + `src/browser`)是**一个平台无关的包**
  `@jinsiyu/dshcs-vscode-server@<code-server 版本>`(0.2.0 起),写进插件 `dependencies`,运行根在
  `<profile>\node_modules\@jinsiyu\dshcs-vscode-server\vscode`;
- VS Code 内部依赖里**纯 JS 的部分**(35 个:xterm / katex / typescript / ws / tar …)也写在插件
  `dependencies`,由 pnpm 装到 profile 的 `node_modules`(hoisted);
- **二进制部分**全部由 `@jinsiyu/dshcs-*` 平台包提供(每个平台各一份,os/cpu 限定):
  16 个原生包经**平台聚合包** `@jinsiyu/dsh-code-server-runtime-win32-<arch>` 用 `npm:` 别名装回**原始名字**
  (`node-pty` / `@vscode/sqlite3` / `@vscode/spdlog` / …),聚合包挂在插件 `optionalDependencies` → pnpm 按架构自动选;
- 因此依赖图里**没有任何带 pre/install/postinstall 或 binding.gyp 的包** →
  不需要 profile 的 `allowBuilds`、不执行任何构建、**使用者机器不需要 C++ 工具链**;
- **升级插件不再重下树**:树包版本按上游 code-server 版本缓存,pnpm 直接复用(约 60MB,解包 ≈197MB)。

### 安装机制(为什么这样设计)

- **pnpm 11 的硬约束**:依赖树里任何带 `preinstall|install|postinstall`(或包内含 `binding.gyp`/`.hooks`)
  的包都被判定"需要构建",必须由**宿主 profile** 的 `pnpm-workspace.yaml` 用 `allowBuilds` 批准,
  否则 `dsh plugin add` 直接 `[ERR_PNPM_IGNORED_BUILDS]` exit 1。依赖包自己的 `pnpm.allowBuilds`、
  `.npmrc`、`patch:` 协议、`optionalDependencies` 全都不起作用(实测 2026-09,pnpm 11.25);
- **树**打包期用 `npm install code-server@<版本> --ignore-scripts`(跳过官方 `sh ./postinstall.sh`:
  Windows 无 sh,且它只认 npm/yarn 的 user-agent)拿到上游发行版,然后**只保留 VS Code 树**:
  `scripts/vendor-vscode-server.mjs` 复制 `lib/vscode/**`、`out/browser/**`、`src/browser/**` 与许可文件到
  `vendor/vscode/`,生成树根 `package.json`(版本 = 上游 code-server 版本,便于版本比对);
  code-server 自己的 `out/node/**` 与 136 个运行时依赖**不再进包**(由 `lib/launcher.mjs` 取代);
- **需要编译的包**由 `scripts/vendor-repacks.mjs` 重打包成 `@jinsiyu/dshcs-*`:
  复制已编译的包目录 → **删除 `scripts` / `files` / `binding.gyp` / `.hooks` / `.npmignore`**
  (保留编译好的 `.node` 与全部运行时文件)→ 依赖里的同集包改成 `npm:` 别名 → 平台专属的加
  `os`/`cpu` 与 `-<platform>-<arch>` 后缀;win32 目标还会校验 `.node` 的 PE machine
  (0x8664=x64 / 0xaa64=arm64),防交叉编译产物装错架构;
- **平台聚合包**把重打包包按原始名字装回去(如 `"node-pty": "npm:@jinsiyu/dshcs-node-pty@1.2.0-beta.15"`),
  于是 VS Code 的 `import('node-pty')` 不用改;聚合包本身 `os`/`cpu` 限定,
  插件 `optionalDependencies` 同时声明 win32-arm64 与 win32-x64 两份 → 一条命令自动选对;
- **解析路径**:host 用 `require.resolve('@jinsiyu/dshcs-vscode-server/package.json')` 找到运行根
  (包内子目录 `vscode/`),入口 `vscode/lib/vscode/out/server-main.js`;VS Code 内部依赖从该运行根向上查找
  (`vscode/lib/vscode/node_modules` → 包 `node_modules` → `<profile>/node_modules`)。
  (旧全量树 `@jinsiyu/dshcs-code-server/code-server` 仍作为回退被识别。)
- **运行时布局自愈**(`lib/native.js` 的 `ensureRuntimeLayout()`,**激活时(先于 envCheck)与每次启动前**幂等执行):
  host 会在 VS Code 树里补两类 **junction**(Windows junction / POSIX 目录软链):
  1. `ensureAliasLinks()`:把聚合包带回的原生别名补到 `<树>/node_modules`
     —— pnpm 会把 `os`/`cpu` 限定的包**嵌套装在聚合包自己的 node_modules 下**,而 VS Code 的
     `lib/vscode/out/server-main.js` 用 **ESM import**(ESM 不认 `NODE_PATH`),缺了就直接 500;
  2. `ensureInnerModuleLinks()`:把 VS Code 的**内部依赖目录** `lib/vscode/node_modules` 与
     `lib/vscode/extensions/node_modules` 按两个 `package.json` 的 `dependencies` 补回老布局
     —— 精简树里没有这两个目录,**用显式路径拼依赖的代码**
     (如内置 TS 扩展找 `<ext>/../node_modules/typescript/lib/tsserver.js`)否则会报
     「VS Code's tsserver was deleted by another application…」(1.136.1 实测)。
  链接都指向包管理器装出来的真实包,树被重装后的断链会被自动清理重建;`envCheck` 按双锚点解析,
  并用 `NODE_PATH` 兜底 CJS。

> **体积提示**:插件 tarball 约 **110KB**;`@jinsiyu/dshcs-vscode-server` 约 **60MB**(解包 ≈197MB);
> 16 个原生包合计约 250MB。全部合计安装下载约 310MB。`vendor/` 与 `repack/` 都不入 git(见 `.gitignore`)。

> **从 ≤ 0.1.43 升级**:树包由 `@jinsiyu/dshcs-code-server`(全量 code-server,含 `out/node` 与 136 个依赖)
> 换成 `@jinsiyu/dshcs-vscode-server`(精简树);**新代码默认 `serve: loopback`,行为与 0.1.43 等价**,
> 需要同源挂载再切 `serve: dsh`。升级命令不变(一条
> `dsh plugin --profile web add dsh-code-server-app@<版本>`),旧的 `dshcs-code-server` 子包会被 pnpm 清掉。

> **从 ≤ 0.1.35 升级**:旧版的安装根 `<profile>\.code-server-app`(含约 1.4GB 内部依赖)与
> 「安装环境」步骤都不再需要 —— 新版本会检测到它并打一条日志提示可安全删除:
> `Remove-Item -Recurse -Force <profile>\.code-server-app`。profile 的 `pnpm-workspace.yaml` 里
> 若还留着 `dsh-code-server-app: false` 之类的旧条目,也可以删掉(新版不再需要任何构建许可)。

> **卸载**:`dsh plugin --profile web remove dsh-code-server-app` 即可;树包与原生包
> 是独立依赖,若要彻底清干净可再 `dsh plugin --profile web remove @jinsiyu/dshcs-code-server`
> (或直接在 profile 里 `pnpm remove`);若还残留旧安装根,再手动删除 `<profile>\.code-server-app`。

> 安装/依赖变化后请**重启 `dsh web`**(静态插件行与 host 探测路径在启动时加载)。

### 开发期:源码目录安装(改动即时生效)

```powershell
dsh plugin --profile web add C:\Users\User\Desktop\dsh-code-server-app
```

> 源码路径以 `link:` 安装。开发机上没有 `vendor/vscode` 时先 `pnpm run vendor:vscode -- --dev-links`;
> 没有平台子包时 host 会回退到包内 `vendor/code-server`(两种布局都支持)。
> 依赖(内部 JS 依赖 + 平台子包 + 聚合包)同样由 pnpm 安装 —— 本地未发布的 `@jinsiyu/*` 需先发布,
> 或把 `repack/tgz/*.tgz` 以 `file:` 依赖临时装进 profile(见 `.tmp-verify.mjs`)。
>
> **改动 client bundle**:编辑 `src/factory.js` 后执行 `pnpm run build:client`
> 重新生成 `lib/client.js`(仓库不跟踪该产物;浏览器刷新即生效,host 无需重启)。
> 窗口动画由内嵌 `motion` 驱动,手感参数在 `src/factory.js` 的 `winPhysics`(一处)。

### 打包机环境要求(使用者机器什么都不需要)

**工具链只在打包期需要;使用者机器不需要 C++ 工具链,也不需要联网装依赖之外的任何东西。**

| 环境 | 版本/要求 | 使用者机器 | 打包机 |
|---|---|---|---|
| Node.js | **v24.x**(code-server 最新要求;本机 v24.13.1) | 必需 | 必需 |
| npm / pnpm | npm 跟随 Node;pnpm 由 DSH 提供 | 必需(装依赖) | 必需 |
| **MSVC 构建工具** | **VS Community 2026 + C++ 桌面负载** | ❌ 不需要 | 打包期需要(编译 16 个原生包) |
| **VS Spectre 缓解库** | ARM64 与 **x86/x64** 各一份("MSVC v14x Spectre-mitigated libs") | ❌ 不需要 | 打包期需要(否则 MSB8040) |
| Python | **3.13.x** | ❌ 不需要 | 打包期需要(node-gyp) |
| node-gyp | **13.x**(旧版不识别 VS 2026) | ❌ 不需要 | 打包期需要 |

> **缺 Spectre 库也能出包**:`vendor-repacks.mjs` 在某个包编译失败时会自动把该架构 `*.gyp` 里的
> `SpectreMitigation` 降级为 `false` 并重试(只是少了 Spectre 加固,功能不受影响),日志会明确提示。

### Windows 原生构建要点(打包期,本机实测 ARM64)

- **VS 需 Spectre 缓解库组件**(MSB8040):Visual Studio Installer → 单个组件 →
  "MSVC v14x Spectre-mitigated libs",**ARM64 与 x86/x64 要分别安装**(只装一个架构会缺另一个)。
- **node-gyp 13.x**(旧版 9.x 不识别 VS 2026):`npm install -g node-gyp@latest`。
- **x64 交叉编译**:`vendor-repacks.mjs` 用 `npm install --os=win32 --cpu=x64 --ignore-scripts`
  取包,再 `npm rebuild --arch=x64` 逐个编译,已验证产物 PE 架构正确(kerberos / sqlite3 / spdlog …)。
- code-server 最新版要求 **Node v24**。
- 若不需要插件自足(例如已有全局 code-server),可跳过安装:
  插件会回退到 PATH/配置的 `bin`(见"配置"表)。

### 升级 VS Code 树(上游 = code-server 发行版)

- **打包期决定版本**:`pnpm run vendor:latest`(= `--force`)取 npm **最新版 code-server** 的树并重建 `vendor/vscode`;
  也可 `pnpm run vendor:vscode -- --version 4.136.2` 或设 `DSHCS_CODE_SERVER_VERSION`。
  已有 `vendor/vscode` 时,不带 `--force`/`--version` 不会升级(日常 `pnpm pack` 是 no-op)。
- **先查再升**:`pnpm run vendor:check` 打印「内置版本 / 上游 latest」。
- **换版本后重新出子包并发布**(全部由同一个脚本):
  1. `pnpm run repack:build -- --target win32-arm64,win32-x64 --pack` → 新的树包
     (`@jinsiyu/dshcs-vscode-server@<新版本>`)以及按新内部依赖重建的原生包
     (脚本会把新的「纯 JS 直装集」写进插件 `dependencies`、更新两个聚合包版本);
  2. `pnpm run publish:repacks` → 发布;然后 bump 插件版本 → `pnpm pack` → 发布插件。
- `productPath`(`<quality>-<commit>`,客户端 WS 路径的组成)**从 `lib/vscode/product.json` 现算**,
  升级树后无需改代码 —— 但也意味着切版本后必须重启 dsh web(路由在激活期注册)。
- **不再有运行期自动升级**:不会在启动时联网取 latest;版本完全由内置产物决定。
- 本机当前内置:`code-server@4.136.2` 的树(VS Code 1.136.1,`productPath=stable-8d5f383f…`)。

### 兼容旧安装位

host 探测顺序:`@jinsiyu/dshcs-vscode-server/vscode`(**0.2.0+ 正式布局**)> `@jinsiyu/dshcs-code-server/code-server`
(0.1.40–0.1.43 全量树)> `@jinsiyu/dshcs-code-server-<平台>-<架构>/code-server`(0.1.37 平台专属子包)>
插件包内 `vendor/vscode` > 插件包内 `vendor/code-server`(开发期)。旧安装根
`<profile>\.code-server-app` 只在启动日志里提示可删除,不再被使用。

## 设置卡片(设置 → 插件 → Code Server)

参照 dsh-auto-open-web 的自绘卡片模式,注册在 `settings.plugin.item` 插槽,
数据经官方 settings 域(`settingsScope`,命名空间 `code-server`)持久化到官方 settings 文档:

| 键 | 默认 | 说明 |
|---|---|---|
| `fileOpenScope` | `session` | **认领范围**(0.2.5):`session` = 只认领会话作用域的文件地址(`dsh-resource://file/session/…`,即官方产物/交付/正文提及);`all` = 连无会话的绝对路径(`…/file/absolute/…`)也认领。未认领的地址由 DSH 自带预览兜底 |
| `fullscreenOnOpen` | `true` | **打开即全屏**(0.2.9):打开 Code Server 标签(含点开文件)时自动把右侧栏切到全屏(铺满窗口);关闭则保持 DSH 默认的 push(与对话并排)。只影响打开那一刻,用户点「退出全屏」不会被抢回去 |
| `keepResident` | `true` | **后台常驻**:开启后宿主启动即把 IDE 预加载到"停放区",切标签/收起侧栏不重载、首次打开免等待;关闭则只在打开面板时加载(省内存) |

(0.2.9 起卡片只留上面三个设置;`windowedOpen` 与 `reserveComposer` 已移除 —— 旧设置文档里残留的键既不报错也不生效。
`serve` 仍是设置命名空间里的键(便于用设置文档切换),但**没有卡片行**,见「服务方式」。)

0.2.7 起卡片**没有**「入口」「依赖安装」「环境检测」三行:入口在右侧栏「开始」页的 Code Server 入口框(或官方的文件点击),
诊断信息不再进 UI —— `/api/code-server/status` 的 `env` 字段仍返回
树版本 / `productPath` / server 入口、VS Code 内部依赖、**预编译原生包**(平台聚合包名 + 已解析模块数),需要时用脚本查或看 host 日志。

> 卡片改动经 `scope.watch` 实时生效(host 端 status API 同步返回 `keepResident`、`fileOpenScope` 与
> `fullscreenOnOpen`,客户端立即生效);无需重启 dsh。**新增设置键后首次使用前需重启 dsh web**,
> 让 host 重新注册设置命名空间(schema 含新键),否则新键的保存与校验不生效。

## 配置(cordis.patch.yml 的 `config`,均有默认值)

| 键 | 默认 | 说明 |
|---|---|---|
| `serve` | `loopback` | 服务方式:`loopback`(独立回环端口,iframe 跨源)→ `dsh`(挂到 DSH 自身端口的 `/code-server/*`,转发到命名管道,复用 DSH 的 Host/Origin + cookie 防护)。需 DSH 提供 `webServer`,缺失时自动回退 loopback |
| `bin` | `''`(空 = 用自带 launcher) | 逃生舱:显式指定外部 code-server 可执行文件 / `out/node/entry.js` 时退回旧模型(不经 `lib/launcher.mjs`) |
| `host` | `127.0.0.1` | loopback 模式的绑定地址(仅允许回环) |
| `port` | `8090` | loopback 模式的端口;被占用时启动失败并给出诊断(不自动换端口) |
| `auth` | `none` | 固定 `none`(0.2.0 起 argon2 已移除;需要对外访问请用 `serve: dsh`) |
| `userDataDir` | `$DSH_HOME/code-server/user-data` | 用户数据隔离目录 |
| `extensionsDir` | `$DSH_HOME/code-server/extensions` | 扩展目录 |
| `locale` | `''` | 界面语言(空 = 跟随浏览器),如 `zh-cn` |
| `readyTimeoutMs` | `60000` | `/healthz` 就绪探测超时(TCP 或命名管道) |

用户级覆盖示例(写在 `$DSH_HOME/profiles/web/cordis.patch.yml`,应使用 `- id: code-server` 行覆盖):

```yaml
- id: code-server
  config:
    serve: dsh        # 同源挂载:/code-server/*(无额外端口,复用 DSH 防护)
    # port: 8091      # serve: loopback 时才生效
```

## JSON API(同源 fetch;web 与 desktop 同一套路径)

**不依赖 `webServer`**:host 半部经 `ctx.connection.fetch.register` 把路由挂在 DSH Connection 的共享 `/api` 通道上——
web profile 由 Connection 自己把 `/api` 前缀挂到 webServer(带 Host/Origin 校验 + 浏览器鉴权),
desktop profile 由 `apps/desktop-host` 把 `/api/*` 交给同一个 `createSharedFetchHandler('/api')`(IPC 帧管道,无 HTTP 服务器)。
客户端只写相对路径 `fetch('/api/code-server/<op>')`,两端行为一致。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/code-server/status` | `{ ok, running, status, host, port, pid, cwd, url, version, error, logTail, adopted }`(另含 `env` 环境检测与 `setup` 兼容字段) |
| POST | `/api/code-server/start` | body `{ cwd? }`(省略 cwd 不切换工作目录);幂等 |
| POST | `/api/code-server/stop` | 停止并回收进程树 |
| POST | `/api/code-server/setup` | **兼容空操作**:0.1.36 起依赖由包管理器安装,调用只重新自检 `env` 并返回 |
| POST | `/api/code-server/open-file` | body `{ file }` — 写信号文件,由内置扩展 `dshcs-open-file` 在 code-server 中打开 |

> 插件不再注册 `/code-server/*` 这类 webServer 专有路由;code-server 图标已内联为 data URI(client bundle 内),
> 因此客户端不请求任何插件自有 HTTP 资源。

## DSH Desktop(无 webServer)

- host 半部 `inject = ['connection', 'settings']`(**不含 `webServer`**)——desktop profile 关掉了 webserver/web-runtime,
  本插件照常工作;`/api/*` 请求由 Electron `dsh-app://` 协议处理器 → IPC 帧管道 → `createSharedFetchHandler('/api')`。
- 右侧栏标签、guide 入口框、文件地址认领、设置卡片在 desktop 下与 web 相同(code-server 仍是本机 `http://127.0.0.1:<port>` 的 iframe;
  桌面端 `webSecurity: true` 且页面无 CSP 限制,跨源 iframe 正常加载)。
  桌面端同样自带 `dsh-client-ui-sidebar-right`(见 desktop 构建 seed 包列表),因此 0.2.3 的
  "只支持带右侧栏的 DSH" 对 desktop 不构成降级;唯一差别是 desktop 无 `webServer`,`serve: dsh` 会自动回退 loopback。
- 安装到 desktop profile:桌面端插件管理窗(**不是** CLI,见下)。
- **桌面端安装的 24 小时供应链策略(实测,2026-09-10,已用它装上 0.2.4)**:
  - CLI 路径不可用:`dsh plugin --profile desktop …` 会被拒绝(*"profile "desktop" is managed exclusively by the Electron application"*),
    桌面端只能走应用内的包事务(`pnpm add <spec> --save-exact`,在 `~/.dsh/desktop/staging/<uuid>/profile` 里执行后激活)。
  - 该事务用的 pnpm(应用自带 **11.7.0**,DeepSeek 打过补丁)在 `add` 前先做**锁文件供应链校验**:
    "Verifying lockfile against supply-chain policies (717 entries)",默认要求**发布满 24 小时**,
    否则 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`。
  - **关键区别(两者行为不同,实测)**:
    - 校验**已有锁文件**时:不接受 `minimumReleaseAgeExclude`(精确版本、裸包名都试过,不放行);
    - **解析**(没有锁文件可校验时,如 `pnpm clean --lockfile` 之后):**认**这份名单,而且 pnpm 自己会往
      `pnpm-workspace.yaml` 追加条目(安装日志会打印 *"Added N entries to minimumReleaseAgeExclude…"*)。
  - 因此桌面端装**刚发布**(<24h)版本的可行路径是 **从"没有锁文件"的干净起点安装**:
    1. `pnpm clean --lockfile`(**注意:它会连 `node_modules` 一起删**,profile 变成待重装状态);
    2. 用应用自带的 runtime 在 profile 目录里 `add <spec> --save-exact --trust-lockfile`
       (运行时/仓库/配置目录都在 `~/.dsh/desktop/pnpm/{store,cache,state,config,home}`,`--config.userconfig=…/config/npmrc`,
       否则会出现 `ERR_PNPM_UNEXPECTED_STORE` / `…UNEXPECTED_VIRTUAL_STORE`);
    3. 安装后应用启动用的 `install --offline --frozen-lockfile --trust-lockfile` 可正常通过(锁文件与 package.json 一致、
       包已在 store);`dsh.profile.bundles` 里已有插件名时不需要再改。
  - 不要用 `minimumReleaseAge: 0` 绕过:它确实能让校验通过,但那个键**不在应用容忍的 policy 段里**
    (`project-manager.ts` 只忽略 `minimumReleaseAgeExclude:` / `trustPolicyExclude:`,且每次 `mutate()` 前都会校验),
    写进去会让应用报 *"core package mapping does not match desktop-packages.json"*。
  - 也可以选择 **等满 24 小时**再在插件管理里正常安装;web profile 不受影响(它的 `pnpm-workspace.yaml` 是 `minimumReleaseAge: false`)。
  - 本插件的依赖闭包里含平台原生子包(`@jinsiyu/dsh-code-server-runtime-win32-*`),它们与插件本身**同批发布**,
    因此每次新版本在桌面端都会受这条策略约束。
- **桌面端的客户端 bundle 会被 Electron 缓存,重启应用不保证换新**(2026-09 实测,0.2.5 踩到):
  - 现象:profile 里 `lib/client.js` 已是新版本,但渲染器仍跑旧代码——`%APPDATA%\@deepseek-ai\dsh-desktop\Code Cache\js`
    里只有旧版本独有的字符串(如 `dshcs-artifacts`),新版本独有的字符串(如 `fileOpenScope`)一个都没有;
    `Cache\` 里也存着一份引用 `dsh-code-server-app` 的旧响应体。官方插件同理(缓存里那份 `ui-deliverables`
    连当前的 `data-presented-files-row` 都没有)。
  - 诊断手法(字节级,注意别用按控制台编码读文件的 `Select-String`,中文标记会假阴性):
    在 `Code Cache\js` 里搜本版本独有的**ASCII** 标记(我们用 `fileOpenScope`),命中即说明新 bundle 真的被编译过。
  - 修法:完全关闭应用后删 `Cache`、`Code Cache`、`GPUCache` 三个目录再启动(只清缓存,不动 profile/会话/设置):
    ```powershell
    Remove-Item -Recurse -Force "$env:APPDATA\@deepseek-ai\dsh-desktop\Cache","$env:APPDATA\@deepseek-ai\dsh-desktop\Code Cache","$env:APPDATA\@deepseek-ai\dsh-desktop\GPUCache"
    ```
  - 影响面:不只本插件——**任何**客户端插件升级后都可能继续跑旧代码;发布后请按上面的标记法确认渲染器真的换了 bundle。

## 已知限制

- ~~子路径不支持~~ **已不成立(0.2.0 实测更正)**:VS Code 渲染出的 workbench HTML 里
  **资源引用全是相对路径**(实测 9 条引用中绝对路径 0 条,`serverBasePath="."`、`rootEndpoint="."`),
  客户端 WebSocket 路径由 `location.pathname + join(serverBasePath ?? '/', <quality>-<commit>)` 拼成,
  因此可以直接挂在 DSH 自身的 `/code-server/*` 下(`serve: dsh`),不需要独立端口、
  也不需要改写 HTML。逐项证据见 `docs/analysis-code-server-as-dsh-plugin.md`。
- **`serve: dsh` 的端口转发 WS 不可用**:`registerUpgrade` 是精确路径匹配,而 `/proxy/:port` 的端口号在路径里
  → 该模式下 Ports 面板的 **WebSocket** 转发不可用(HTTP 转发正常);需要时用 `serve: loopback`。
- **`serve: dsh` 的 iframe 与 DSH 同源** → 该模式不挂 `sandbox`(同源 + `allow-same-origin` 可被 frame 自行摘除);
  `loopback` 模式跨源,`sandbox` 作为真防护保留。
- **跨会话单实例**:host 级共享一份 IDE;切换 cwd 需重启实例(右侧栏标签自动处理并提示)。
- **旧版 DSH 不受支持(0.2.3 起)**:没有 `sidebarRightTabs`/`sidebarRight` 的 DSH 上,除设置页一条升级提示外无任何入口;
  旧版用户请留在 `0.2.2`(`dsh plugin --profile web add dsh-code-server-app@0.2.2`)。
- **侧栏标签切换**(0.2.2 起不再重载):DSH 右侧栏只渲染当前激活标签的 body,React 卸载会移走 iframe;
  插件把 iframe 收成单例常驻面,用 `Element.moveBefore()`(状态保持型原子移动)在停靠位与文档级停放区之间搬,
  切标签/收起侧栏再回来**不重载**。不支持 `moveBefore` 的浏览器退回旧行为(`appendChild` → 整页重载),
  状态里以 `degraded` 明示;详见下方「为什么切标签不再重载」。
- **远程访问**:`serve: dsh` 下浏览器只需能到达 DSH 本身(单一端口,认证与 `/api` 同级);
  `serve: loopback` 默认仅回环、`auth: none`,跨机访问请改用 `serve: dsh`
  (0.2.0 起不再支持 `auth: password`)。
