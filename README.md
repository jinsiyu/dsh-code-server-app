# dsh-code-server-app — 在 DSH 中集成 code-server(VS Code 网页版)

> 源码仓库地址见 `package.json` 的 `repository` / `homepage` 字段。

> ## ⚠️ 扩展市场说明(重要)
>
> - **code-server 的扩展商店是 [Open VSX](https://open-vsx.org/),不是微软 Visual Studio Marketplace**;
> - 微软 Marketplace 的条款**禁止第三方产品(含 code-server)使用其 API**,所以 code-server 无法查询微软市场的扩展列表;
> - 因此微软**商业/专有**扩展(如 **GitHub Copilot、Remote-SSH 等 Remote 系列、Azure 系列、IntelliCode**)在商店里**找不到**——这是微软发行策略,不是缺失;
> - 微软**开源系**扩展(Python、TypeScript 调试、ESLint 等)在 Open VSX 有镜像,搜索正常可装;
> - **需要微软专有扩展时**:从 Marketplace 网页下载 `.vsix`,用 `code-server --install-extension <文件>`(或放入 `--extensions-dir`)手动安装,即可在插件列表使用。

静态 profile 插件(npm 包形态,host + client bundle),把最新版 [code-server](https://github.com/coder/code-server)
**按需安装到 profile 专用目录**(安装插件本身零脚本、不装 code-server),插件启动时自动发现并使用它,
无需全局 npm 安装、无需配置 `bin`。

## UI 载体(DSH 版本决定,运行时特性检测)

| DSH 版本 | 载体 | 入口 |
|---|---|---|
| **≥ 0.1.5-alpha.1**(有 `sidebarRight` / `sidebarRightTabs` 服务) | **右侧栏标签**(kind=`code-server`,标签名 `Code Server`),**不再使用悬浮窗** | ① 右侧栏「开始」页的 **Code Server 入口框**;② 每轮产物旁的图标按钮;③ 设置 → 插件 → Code Server → **「在右侧栏打开」** |
| 更早(无右侧栏服务) | 悬浮球 + 内部浮动窗口(与旧版一致) | 右下角悬浮球 |

- 检测方式:`ctx.inject(['sidebarRightTabs','sidebarRight'], …)`——服务就绪才注册标签类型;
  服务缺失/注册失败则整段不生效,自动回退悬浮球(不按版本号硬判,也不影响插件激活)。
- 侧栏标签内即 code-server 页面(iframe),跟随当前会话工作区;面板可折叠/分屏/浮动/全屏(由 DSH 右侧栏提供)。
- **已知取舍**:DSH 只渲染「当前激活标签」的 body,切到别的标签再切回会重挂 iframe
  (code-server 整页重载,未保存的编辑缓冲区会丢);需要长驻会话时请把该标签**浮动**出来或保持激活。
- 设置卡片在侧栏模式下隐藏「保留输入框上方空间」(只对浮窗有意义);
  「窗口化打开(新标签页)」仍然生效(开启后各入口改为浏览器新标签页打开)。
- `windowedOpen` 优先级最高:开启时入口按钮一律新开浏览器标签页。

## 悬浮球 / 浮窗(仅旧版 DSH 回退路径)

- **右下角悬浮球**(code-server 官方图标,输入框上方):点击**展开浮窗并亮起**(蓝色光环),再点击**收起并复原**;
  **可按住拖动到任意位置**(松手后记忆,刷新不丢;拖完不会误触发点击);
  无侧栏按钮、无窗口控制按钮组(球是唯一入口/开关);球上带运行状态点(绿=运行 / 黄=启动中 / 红=错误);
- 窗口为**内部浮动窗口**(参照 dsh-univer-office 的 WorktreeWindow 模式):固定定位浮窗 + 空转根容器,窗口接管指针事件,
  **无标题栏无按钮**——顶部细条拖动(悬停有淡色提示;**拖到窗口顶部松开 = 最大化**,
  **最大化后按住顶部细条向下拖 = 恢复**并继续跟手拖动)、双击最大化、8 向缩放、Esc 关闭(与球收起等效),
  初始位置在输入框上方靠右,最大化与缩放都止于输入栏上方,不遮挡 composer;
- 窗口内直接是 code-server 页面(iframe);未运行/启动失败时显示状态说明与错误信息;
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
- `node_modules`(依赖,含 code-server)已被 `.gitignore` 排除,推送/克隆仓库后按下方
  "安装插件(安装期零脚本,code-server 按需安装)"执行 `pnpm pack` + `dsh plugin --profile web add` 即可。

> 本机(BM: Windows 11 ARM64)实测:`code-server@4.134.0`(with Code 1.135.0)
> 随插件依赖安装并完成自动发现 → 启动 → healthz 200 → 运行中切换 cwd 重启 → 停止 → 回收全链路验证。

## 安装插件(安装期零脚本,code-server 按需安装)

```powershell
# 1) 打包(在插件工作区)
cd C:\Users\User\Desktop\dsh-code-server-app
# 全新克隆:先装开发依赖并生成 client bundle(lib/client.js 不入库,由 src/factory.js 构建)
pnpm install            # esbuild + motion(仅打包用)
pnpm run build:client   # src/factory.js → lib/client.js
pnpm pack
```

```powershell
# 2) 安装(发布形态 tarball;插件无 postinstall → 无需 pnpm approve-builds / allowBuilds)
dsh plugin --profile web add C:\Users\User\Desktop\dsh-code-server-app\dsh-code-server-app-0.1.31.tgz
```

> 安装只落插件文件,**不执行任何包脚本、不安装 code-server**(pnpm 不会提示 build scripts 许可)。
> code-server 在**首次使用时按需安装**:启动安装指引弹窗「开始安装」→ 设置 → 插件 → Code Server
> → 「安装环境」,或手动 `node <插件目录>\scripts\setup-code-server.mjs`(`npm run setup:code-server`)。

### 安装机制

- **安装期零脚本**:`package.json` 无 `postinstall`,pnpm 安装插件时不执行任何包脚本
  (无需 `pnpm approve-builds` / `allowBuilds` 批准),也不安装 code-server;
- **code-server 不在 `dependencies`**(pnpm 不触碰它、无脚本许可问题),改由
  `scripts/setup-code-server.mjs` 在 **profile 专用目录**用 **npm** 按需安装
  **最新版** `code-server`(不锁版本,安装时取 npm latest):
  - 触发方式:host `POST /code-server/setup`(启动安装指引弹窗「开始安装」/ 设置卡片「安装环境」)
    或手动 `npm run setup:code-server`;
  - 安装根:`<profile>\.code-server-app`(如 `C:\Users\User\.dsh\profiles\web\.code-server-app`),
    独立项目,与 profile 依赖树隔离(避开 ERESOLVE);
  - 安装根自带 `package.json`(allowScripts:`code-server: false` 跳过官方 `sh ./postinstall.sh`
    ——Windows 无 sh 会失败、`argon2/unrs-resolver: true` native 构建,均不带版本号);
  - 装完补装 VS Code 内部依赖(144 包)+ `bin\code-server.cmd`;
- **code-server 落在** `<profile>\.code-server-app\node_modules\code-server\`;
  幂等自愈(每次按需调用先检测:已实例化且版本与 npm latest 一致则跳过;**不一致则自动升级到最新**)。
- **锁版本**:设置环境变量 `DSHCS_CODE_SERVER_VERSION`(需出现在**执行 setup 的进程**环境中,UI 触发即 dsh web 进程)可钉住某个版本(如 `4.134.0`);缺省跟随 npm latest。
- **为什么安装期不装**:安装快、没有 C++ 工具链也能装成功(缺工具链的失败延后到「开始安装」,错误显示在
  顶部横幅与设置卡片日志);code-server 升级只发生在按需安装时,**不再随每次重装插件自动升级**。

> **从旧版本升级的迁移提示(≤ 0.1.28)**:旧版插件带 `postinstall`,profile 的 `pnpm-workspace.yaml`
> 里曾有 `allowBuilds: dsh-code-server-app@file:...<旧版本>.tgz: true` 条目,pnpm 11 还可能在
> `node_modules/.modules.yaml` 留下 `ignoredBuilds` 记录——于是每次安装后都会报
> `[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: dsh-code-server-app@file:...`(即使新版本已无任何
> 安装脚本)。处理:把 profile 的 `pnpm-workspace.yaml` 中该包相关条目合并为一条
> `dsh-code-server-app: false`(显式声明"永不构建"),重跑安装即可;本机 0.1.29 升级已完成该迁移。

> **卸载**:code-server 目录独立于插件包——先手动删除
> `Remove-Item -Recurse -Force <profile>\.code-server-app`,再 `dsh plugin --profile web remove dsh-code-server-app`。
> 设置卡片"环境检测"区也显示此提示。

> 安装/依赖变化后请**重启 `dsh web`**(静态插件行与 host 探测路径在启动时加载)。

### 开发期:源码目录安装(改动即时生效)

```powershell
dsh plugin --profile web add C:\Users\User\Desktop\dsh-code-server-app
```

> 源码路径以 `link:` 安装;host 的 `scripts/setup-code-server.mjs` 在 profile 布局不可用时回退把
> code-server 装到**插件工作区 node_modules**(两种布局 host 都支持)。
> 安装本身不跑脚本,首次使用需点「开始安装」或手动 `npm run setup:code-server`。
>
> **改动 client bundle**:编辑 `src/factory.js` 后执行 `pnpm run build:client`
> 重新生成 `lib/client.js`(仓库不跟踪该产物;浏览器刷新即生效,host 无需重启)。
> 窗口动画由内嵌 `motion` 驱动,手感参数在 `src/factory.js` 的 `winPhysics`(一处)。

### 安装环境要求(需要编译的包与工具链)

按需安装过程(`scripts/setup-code-server.mjs` → npm 自装 code-server + VS Code 内部依赖)中,**真正需要本地编译的只有一个包**(安装插件本身不需要任何工具链):

| 包 | 构建方式 | ARM64 本地编译 | x64 本地编译 |
|---|---|---|---|
| **code-server**(主包) | 官方 `sh ./postinstall.sh` 已被 `allowScripts: code-server: false` 跳过(Windows 无 sh) | ❌ | ❌ |
| **argon2** | `node-gyp-build`(binding.gyp + node-addon-api) | ✅ **必须** | ✅ **也必须**——prebuilds 目录里只有 Linux 的 `*.glibc.node`,**Windows 无任何预编译** |
| **unrs-resolver** | `napi-postinstall check`,加载 `@unrs/resolver-binding-win32-{x64,arm64}-msvc` 预编译绑定 | ❌ 纯预编译 | ❌ 纯预编译 |
| **VS Code 内部依赖**(`lib/vscode/node_modules`,144 包) | `ensureNpmDeps` 逐一 `npm install`,自带 postinstall(node-pty/koffi/kerberos 等) | ⚠️ 多数预编译 | ⚠️ 多数预编译 |

**基础环境清单(Windows 实测)**:

| 环境 | 版本/要求 | ARM64 | x64 |
|---|---|---|---|
| Node.js | **v24.x**(code-server 最新要求;本机 v24.13.1) | 必需 | 必需 |
| npm | 跟随 Node | 必需 | 必需 |
| **MSVC 构建工具** | **VS Community 2026(18.9)+ C++ 桌面负载** | ✅ **必需**(argon2 编译) | ✅ **必需**(argon2 编译) |
| **VS Spectre 缓解库** | "适用于 ARM64 的 MSVC v18x Spectre-mitigated 库"(x64 用对应位数库) | ✅ 必需(否则 MSB8040) | ✅ 必需(否则 MSB8040) |
| Python | **3.13.x**(如 `Python313-arm64\python.exe`;x64 用 x64 版) | ✅ 必需(node-gyp 脚本) | ✅ 必需 |
| node-gyp | **13.x**(9.x 不识别 VS 2026) | ✅ 必需 | ✅ 必需 |

> **结论(实测更正)**:
> - **Windows(x64 与 ARM64 相同)**:argon2 的 prebuilds 目录里**只有 Linux 的 `*.glibc.node`,没有 Windows 预编译**——`node-gyp-build` 找不到 → **一律回退本地 node-gyp 编译**。因此 **x64 同样必须配齐 C++ 工具链**(MSVC + Spectre + Python + node-gyp 13),不存在"x64 零编译";
> - 其余(unrs-resolver、VS Code 内部依赖)走预编译,无需额外工具;
> - 若开发机没有工具链,可将安装根 `package.json` 的 `allowScripts.argon2` 设为 `false` 跳过(但 argon2 缺失会导致 code-server 启动报 `node-gyp-build` 错误——仅适合不依赖 argon2 的场景,通常不建议)。

### Windows 原生构建要点(本机实测,ARM64)

- **VS 需 Spectre 缓解库组件**(MSB8040):Visual Studio Installer → 单个组件 →
  "适用于 ARM64 的 MSVC v18x Spectre-mitigated 库"(x86/x64 同理)。
- **node-gyp 13.x**(旧版 9.x 不识别 VS 2026):`npm install -g node-gyp@latest`。
- code-server 最新版要求 **Node v24**(本机 v24.13.1 通过;版本不足时启动会报错)。
- 若不需要插件自足(例如已有全局 code-server),可跳过安装:
  插件会回退到 PATH/配置的 `bin`(见"配置"表)。

### 升级 code-server 版本

- **默认自动**:脚本不锁版本——按需安装时若已装版本与 npm latest 不一致则自动重装到最新(无需手动改)。
- **触发检查**:设置 → 插件 → Code Server → 「安装环境」,或手动 `npm run setup:code-server`;
  **不再随插件重装自动升级**(重装插件本身不安装/升级 code-server)。
- **想钉住版本**:设环境变量 `DSHCS_CODE_SERVER_VERSION`(如 `4.134.0`;需在 dsh web 进程环境中);去掉它回到跟随 latest。
- 本机当前实测:已装 `4.135.0`,npm latest `4.136.2`——下次按需安装会升级到 `4.136.2`。

### 兼容旧的 runtime 目录安装

`runtime/node_modules/code-server`(早期 README 的手动安装方式)已移除支持——
host 探测顺序:`<profile>\.code-server-app`(专用目录)> 插件包内 `node_modules`> PATH/配置 `bin`
(profile 顶层 hoisted 属历史布局,已不再探测)。

## 设置卡片(设置 → 插件 → Code Server)

参照 dsh-auto-open-web 的自绘卡片模式,注册在 `settings.plugin.item` 插槽,
数据经官方 settings 域(`settingsScope`,命名空间 `code-server`)持久化到官方 settings 文档:

| 键 | 默认 | 说明 |
|---|---|---|
| `reserveComposer` | `true` | 窗口是否**保留输入框上方空间**:开启时窗口初始/拖动/缩放/最大化都止于输入栏上方(不遮挡 composer);关闭后允许盖住输入框(最大化到视口底)。**仅对旧版 DSH 的浮窗生效**——右侧栏模式下该行隐藏 |
| `windowedOpen` | `false` | **窗口化打开**:开启后各入口(产物按钮 / 设置卡 / 悬浮球)在浏览器**新标签页**打开 code-server(自动启动并跟随当前工作区目录);关闭(默认)使用右侧栏标签(旧版 DSH 为内部浮动窗口) |

> 卡片改动经 `scope.watch` 实时生效(host 端 status API 同步返回 `reserveComposer` 与
> `windowedOpen`,客户端立即生效);无需重启 dsh。**新增设置键后首次使用前需重启 dsh web**,
> 让 host 重新注册设置命名空间(schema 含新键),否则新键的保存与校验不生效。

## 配置(cordis.patch.yml 的 `config`,均有默认值)

| 键 | 默认 | 说明 |
|---|---|---|
| `bin` | `code-server`(占位) | 启动优先级:本配置显式 `bin` > `<profile>\.code-server-app`(专用目录,自动以 node 运行)> 插件包内 `node_modules`> PATH 中的 `code-server`。都不存在时启动报错并给出安装指引 |
| `host` | `127.0.0.1` | 绑定地址;`auth: none` 仅允许回环(localhost/127.0.0.1/::1) |
| `port` | `8090` | 端口;被占用时启动失败并给出诊断(不自动换端口) |
| `auth` | `none` | `none` \| `password`;非回环 host 自动要求 password |
| `passwordToken` | `''` | password 模式的 token(经 `PASSWORD` 环境变量传给 code-server) |
| `userDataDir` | `$DSH_HOME/code-server/user-data` | 用户数据隔离目录 |
| `extensionsDir` | `$DSH_HOME/code-server/extensions` | 扩展目录 |
| `readyTimeoutMs` | `60000` | /healthz 就绪探测超时 |

用户级覆盖示例(写在 `$DSH_HOME/profiles/web/cordis.patch.yml`,应使用 `- id: code-server` 行覆盖):

```yaml
- id: code-server
  config:
    port: 8091
    # 显式指定(覆盖依赖安装探测):全局安装的 shim,或任意 entry.js
    bin: C:\Users\User\AppData\Roaming\npm\code-server.cmd
```

## JSON API(同源 fetch,浮层与网页共用)

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/code-server/status` | `{ ok, running, status, host, port, pid, cwd, url, version, error, logTail, adopted }`(另含 `env` 环境检测与 `setup` 安装任务进度) |
| POST | `/code-server/start` | body `{ cwd? }`(省略 cwd 不切换工作目录);幂等 |
| POST | `/code-server/stop` | 停止并回收进程树 |
| POST | `/code-server/setup` | 后台执行环境安装(npm 自装 code-server + native + VS Code 内部依赖);进度经 `status.setup` 轮询 |

## 已知限制

- **子路径不支持**:code-server 前端使用根路径/WebSocket/Service Worker,因此必须独立端口
  iframe 直连,不做 DSH webServer 反向代理;`--base-path` 官方不支持。
- **跨会话单实例**:host 级共享一份 code-server;切换 cwd 需重启实例(右侧栏标签/浮窗自动处理并提示)。
- **侧栏标签切换重载**:DSH 右侧栏只渲染当前激活标签的 body,切走再切回会重挂 iframe(code-server 整页重载);
  长驻会话请保持该标签激活或将其浮动为独立面板。
- **远程访问**:默认仅回环 + 无认证。跨机访问需改 `host` + `auth: password` + `passwordToken`,
  且浏览器必须能直接到达该主机(本插件的“在新标签打开”按 `host:port` 拼 URL)。
