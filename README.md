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
**作为插件依赖随装**(package.json dependencies),插件启动时自动发现并使用它,
无需全局 npm 安装、无需配置 `bin`。

- **右下角悬浮球**(code-server 官方图标,输入框上方):点击**展开浮窗并亮起**(蓝色光环),再点击**收起并复原**;
  **可按住拖动到任意位置**(松手后记忆,刷新不丢;拖完不会误触发点击);
  无侧栏按钮、无窗口控制按钮组(球是唯一入口/开关);球上带运行状态点(绿=运行 / 黄=启动中 / 红=错误);
- 窗口为**内部浮动窗口**(参照 dsh-univer-office 的 WorktreeWindow 模式):固定定位浮窗 + 空转根容器,窗口接管指针事件,
  **无标题栏无按钮**——顶部细条拖动(悬停有淡色提示;**拖到窗口顶部松开 = 最大化**,
  **最大化后按住顶部细条向下拖 = 恢复**并继续跟手拖动)、双击最大化、8 向缩放、Esc 关闭(与球收起等效),
  初始位置在输入框上方靠右,最大化与缩放都止于输入栏上方,不遮挡 composer;
- 窗口内直接是 code-server 页面(iframe);未运行/启动失败时显示状态说明与错误信息;
- code-server 服务目录**跟随活动工作区/会话**:浮层打开期间切换 DSH 会话/工作区,code-server 自动重启到新目录
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
  "安装插件(code-server 包内自装)"执行 `pnpm pack` + `dsh plugin --profile web add` 即可。

> 本机(BM: Windows 11 ARM64)实测:`code-server@4.134.0`(with Code 1.135.0)
> 随插件依赖安装并完成自动发现 → 启动 → healthz 200 → 运行中切换 cwd 重启 → 停止 → 回收全链路验证。

## 安装插件(code-server 包内自装,零 flag 零报错)

```powershell
# 1) 打包(在插件工作区)
cd C:\Users\User\Desktop\dsh-code-server-app
# 全新克隆:先装开发依赖并生成 client bundle(lib/client.js 不入库,由 src/factory.js 构建)
pnpm install            # esbuild + motion(仅打包用)
pnpm run build:client   # src/factory.js → lib/client.js
pnpm pack

# 2) 一次性前置:批准插件 postinstall 许可(pnpm 只认宿主根配置,无包内声明路径)
cd C:\Users\User\.dsh\profiles\web
pnpm approve-builds dsh-code-server-app   # 交互选 yes;失败时手动编辑 pnpm-workspace.yaml
```

> 若 `approve-builds` 不接受 file: spec(提示 unknown),把 `pnpm-workspace.yaml` 的
> `allowBuilds` 中 `dsh-code-server-app@file:...tgz`改为 `true`
> (等价于交互批准,仅此一次;之后安装无需再次处理)。

```powershell
# 3) 安装(发布形态 tarball;无需 --ignore-scripts / --allow-build)
dsh plugin --profile web add C:\Users\User\Desktop\dsh-code-server-app\dsh-code-server-app-0.1.15.tgz
```

### 安装机制

- **code-server 不在 `dependencies`**(pnpm 不触碰它、无脚本许可问题);
- 插件的 `postinstall`(`scripts/setup-code-server.mjs`)在 **profile 专用目录**用 **npm** 自装
  **最新版** `code-server`(不锁版本,安装时取 npm latest):
  - 安装根:`<profile>\.code-server-app`(如 `C:\Users\User\.dsh\profiles\web\.code-server-app`),
    独立项目,与 profile 依赖树隔离(避开 ERESOLVE);
  - 安装根自带 `package.json`(allowScripts:`code-server: false` 跳过官方 `sh ./postinstall.sh`
    ——Windows 无 sh 会失败、`argon2/unrs-resolver: true` native 构建,均不带版本号);
  - 装完补装 VS Code 内部依赖(144 包)+ `bin\code-server.cmd`;
- **code-server 落在** `<profile>\.code-server-app\node_modules\code-server\`;
  幂等自愈(pnpm 重装插件 → postinstall 重跑 → 检测已实例化则跳过;**若已装版本与最新不一致则自动升级到最新**)。
- **锁版本**:设置环境变量 `DSHCS_CODE_SERVER_VERSION`(如在 dsh web 环境)可钉住某个版本(如 `4.134.0`);缺省跟随 npm latest。

> **卸载**:code-server 目录独立于插件包——先手动删除
> `Remove-Item -Recurse -Force <profile>\.code-server-app`,再 `dsh plugin --profile web remove dsh-code-server-app`。
> 设置卡片"环境检测"区也显示此提示。

> 安装/依赖变化后请**重启 `dsh web`**(静态插件行与 host 探测路径在启动时加载)。

### 开发期:源码目录安装(改动即时生效)

```powershell
dsh plugin --profile web add C:\Users\User\Desktop\dsh-code-server-app
```

> 源码路径以 `link:` 安装,pnpm 会把 code-server 装到**插件工作区 node_modules**;
> 与方案 D 的布局不同(host 已支持两种)。首次也需按上面的步骤 2 批准 postinstall 许可。
>
> **改动 client bundle**:编辑 `src/factory.js` 后执行 `pnpm run build:client`
> 重新生成 `lib/client.js`(仓库不跟踪该产物;浏览器刷新即生效,host 无需重启)。
> 窗口动画由内嵌 `motion` 驱动,手感参数在 `src/factory.js` 的 `winPhysics`(一处)。

### Windows 原生构建要点(本机实测,ARM64)

- **VS 需 Spectre 缓解库组件**(MSB8040):Visual Studio Installer → 单个组件 →
  "适用于 ARM64 的 MSVC v18x Spectre-mitigated 库"(x86/x64 同理)。
- **node-gyp 13.x**(旧版 9.x 不识别 VS 2026):`npm install -g node-gyp@latest`。
- code-server 最新版要求 **Node v24**(postinstall 校验;本机 v24.13.1 通过)。
- 若不需要插件自足(例如已有全局 code-server),可跳过安装:
  插件会回退到 PATH/配置的 `bin`(见"配置"表)。

### 升级 code-server 版本

- **默认自动**:postinstall 不锁版本——已装版本与 npm latest 不一致时自动重装到最新(无需手动改)。
- **想钉住版本**:设环境变量 `DSHCS_CODE_SERVER_VERSION`(如 `4.134.0`);去掉它回到跟随 latest。
- 重新 `pnpm pack` + `dsh plugin --profile web add <tgz>` 即触发 postinstall 检查(或直接删 `.code-server-app` 重装)。

### 兼容旧的 runtime 目录安装

`runtime/node_modules/code-server`(早期 README 的手动安装方式)已移除支持——
host 探测顺序:`<profile>\.code-server-app`(专用目录)> 插件包内 `node_modules`> PATH/配置 `bin`
(profile 顶层 hoisted 属历史布局,已不再探测)。

## 设置卡片(设置 → 插件 → Code Server)

参照 dsh-auto-open-web 的自绘卡片模式,注册在 `settings.plugin.item` 插槽,
数据经官方 settings 域(`settingsScope`,命名空间 `code-server`)持久化到官方 settings 文档:

| 键 | 默认 | 说明 |
|---|---|---|
| `reserveComposer` | `true` | 窗口是否**保留输入框上方空间**:开启时窗口初始/拖动/缩放/最大化都止于输入栏上方(不遮挡 composer);关闭后允许盖住输入框(最大化到视口底) |
| `windowedOpen` | `false` | **窗口化打开**:开启后点击悬浮球在浏览器**新标签页**打开 code-server(自动启动并跟随当前工作区目录);关闭(默认)使用内部浮动窗口 |

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
- **跨会话单实例**:host 级共享一份 code-server;切换 cwd 需重启实例(浮层自动处理并提示)。
- **远程访问**:默认仅回环 + 无认证。跨机访问需改 `host` + `auth: password` + `passwordToken`,
  且浏览器必须能直接到达该主机(本插件的“在新标签打开”按 `host:port` 拼 URL)。
