# dsh-code-server — 在 DSH 中集成 code-server(VS Code 网页版)

静态 profile 插件(npm 包形态,host + client bundle),把最新版 [code-server](https://github.com/coder/code-server)
**作为插件自带运行时安装进 DSH**:code-server 装在插件工作区的 `runtime/` 目录,插件启动时自动发现并使用它,
无需全局 npm 安装、无需配置 `bin`。

- 侧栏底部新增 **“Code Server”按钮**;点击打开**内部浮动窗口**(参照 dsh-univer-office 的 WorktreeWindow 模式):
  固定定位浮窗 + 空转根容器,窗口接管指针事件,**可拖动标题栏、8 向缩放、双击/按钮最大化、折叠(只剩标题栏)、关闭(Esc)**,
  初始位置在输入框上方靠右,最大化与缩放都止于输入栏上方,不遮挡 composer;
- 窗口内:标题栏(状态徽章:运行中/启动中/错误/未运行)+ 工具栏(重新加载/新标签打开/启动/停止)+ iframe;
- code-server 服务目录**跟随活动工作区/会话**:浮层打开期间切换 DSH 会话/工作区,code-server 自动重启到新目录
  (解析优先级:当前会话 cwd → 会话所属 workspace.path → recentWorkspace.path → 首个 workspace.path);
  顶栏显示“跟随: <cwd>”与“编辑器 cwd: <cwd>”,二者不同时显示“目标: <cwd>(切换即重启)”。
  实现要点:iframe src 必须带 `?folder=<cwd>`——code-server 前端会记住“最近工作区”并自行恢复,
  仅用裸根 URL 只会显示上一次打开的目录、不会跟随切换(本机实测确认)。
  **Windows 路径格式(实测)**:folder 参数必须以 `/` 开头且全部正斜杠,形如 `/C:/Users/User/Desktop/biss`;
  裸 Windows 路径(`C:\...`)会被前端当 URI scheme 而剥掉盘符(页面显示 `\Users\User\...` 且文件树为空),
  `file:///C:/...` 形式则报 “Workspace does not exist”。
- process 生命周期由 host 插件管理:启动写 `$DSH_HOME/code-server/pid.json`,停止树级终止(taskkill /T 或进程组 SIGKILL),
  崩溃/退出实时更新状态;DSH host 重启后自动 adopt 仍在运行的实例(校验 pid + /healthz),不重复启动、不误杀别的进程;
- `runtime/` 与 `node_modules` 已被 `.gitignore` 排除,推送/克隆仓库后按下方“runtime 恢复命令”重新构建即可。

> 本机(BM: Windows 11 ARM64)实测:`code-server@4.134.0`(with Code 1.135.0)
> 已安装进插件 runtime 并完成自动发现 → 启动 → healthz 200 → 运行中切换 cwd 重启 → 停止 → 回收全链路验证。

## 安装插件(code-server 自动跟随)

```powershell
# 开发期:源码目录路径安装(改动即时生效)
dsh plugin --profile web add C:\Users\User\Desktop\dsh-code-server-app

# 或发布形态:tarball
# cd C:\Users\User\Desktop\dsh-code-server-app && pnpm pack
# dsh plugin --profile web add .\dsh-code-server-0.1.0.tgz
```

**code-server 已声明为插件依赖**(`package.json` dependencies = `code-server ^4.134.0`),
`npm install` / `dsh plugin add` 时自动随装。插件的 `postinstall` 脚本
(`scripts/setup-code-server.mjs`,纯 Node、Windows 兼容)负责补齐 VS Code 内部依赖与
native 构建——官方 `sh ./postinstall.sh` 在 Windows 上无 `sh` 会失败,已由本脚本替代。

> 安装/依赖变化后请**重启 `dsh web`**(静态插件行与 host 探测路径在启动时加载)。

> 首次安装如遇 npm 11 的 install-scripts 拦截,按提示批准后重建:
> ```powershell
> npm install
> npm install-scripts approve argon2 unrs-resolver   # native 模块构建脚本(npm 11 白名单)
> npm rebuild
> node scripts/setup-code-server.mjs                 # 补装 VS Code 内部依赖
> ```

### Windows 原生构建要点(本机实测,ARM64)

- **VS 需 Spectre 缓解库组件**(MSB8040):Visual Studio Installer → 单个组件 →
  "适用于 ARM64 的 MSVC v18x Spectre-mitigated 库"(x86/x64 同理)。
- **node-gyp 13.x**(旧版 9.x 不识别 VS 2026):`npm install -g node-gyp@latest`。
- code-server 最新版要求 **Node v24**(postinstall 校验;本机 v24.13.1 通过)。
- 若不需要插件自足(例如已有全局 code-server),可跳过安装:
  插件会回退到 PATH/配置的 `bin`(见"配置"表)。

### 兼容旧的 runtime 目录安装

`runtime/node_modules/code-server`(早期 README 的手动安装方式)仍被支持——
host 探测顺序:`node_modules`(推荐,随插件安装)> `runtime`(旧方式)> PATH/配置 `bin`。

## 设置卡片(设置 → 插件 → Code Server)

参照 dsh-auto-open-web 的自绘卡片模式,注册在 `settings.plugin.item` 插槽,
数据经官方 settings 域(`settingsScope`,命名空间 `code-server`)持久化到官方 settings 文档:

| 键 | 默认 | 说明 |
|---|---|---|
| `reserveComposer` | `true` | 窗口是否**保留输入框上方空间**:开启时窗口初始/拖动/缩放/最大化都止于输入栏上方(不遮挡 composer);关闭后允许盖住输入框(最大化到视口底) |

> 卡片改动经 `scope.watch` 实时生效(host 端 status API 同步返回 `reserveComposer`,
> 客户端窗口立即重新 fit);无需重启 dsh。首次使用前需 **重启 dsh web** 让 host
> 注册该设置命名空间(静态插件行加载)。

## 配置(cordis.patch.yml 的 `config`,均有默认值)

| 键 | 默认 | 说明 |
|---|---|---|
| `bin` | `code-server`(占位) | 启动优先级:本配置显式 `bin` > 插件自带 runtime(`runtime/node_modules/code-server/out/node/entry.js`,自动以 node 运行)> PATH 中的 `code-server`。都不存在时启动报错并给出安装指引 |
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
    # 显式指定(覆盖自带 runtime 探测):全局安装的 shim,或任意 entry.js
    bin: C:\Users\User\AppData\Roaming\npm\code-server.cmd
```

## JSON API(同源 fetch,浮层与网页共用)

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/code-server/status` | `{ ok, running, status, host, port, pid, cwd, url, version, error, logTail, adopted }` |
| POST | `/code-server/start` | body `{ cwd? }`(省略 cwd 不切换工作目录);幂等 |
| POST | `/code-server/stop` | 停止并回收进程树 |

## 已知限制

- **子路径不支持**:code-server 前端使用根路径/WebSocket/Service Worker,因此必须独立端口
  iframe 直连,不做 DSH webServer 反向代理;`--base-path` 官方不支持。
- **跨会话单实例**:host 级共享一份 code-server;切换 cwd 需重启实例(浮层自动处理并提示)。
- **远程访问**:默认仅回环 + 无认证。跨机访问需改 `host` + `auth: password` + `passwordToken`,
  且浏览器必须能直接到达该主机(本插件的“在新标签打开”按 `host:port` 拼 URL)。
