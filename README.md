# dsh-code-server — 在 DSH 中集成 code-server(VS Code 网页版)

静态 profile 插件(npm 包形态,host + client bundle),把最新版 [code-server](https://github.com/coder/code-server)
**作为插件自带运行时安装进 DSH**:code-server 装在插件工作区的 `runtime/` 目录,插件启动时自动发现并使用它,
无需全局 npm 安装、无需配置 `bin`。

- 侧栏底部新增 **“Code Server”按钮**;点击打开**全屏浮层**,内嵌 code-server 的 VS Code 界面(iframe);
- 浮层顶栏:状态点(绿=运行/黄=启动中/红=错误)、端口、cwd,以及 **[重新加载] [在新标签打开] [启动] [停止] [关闭(Esc)]**;
- code-server 服务目录默认取当前会话 cwd;文件直接落在 DSH workspace 磁盘上,agent 与编辑器看到同一份文件;
- process 生命周期由 host 插件管理:启动写 `$DSH_HOME/code-server/pid.json`,停止树级终止(taskkill /T 或进程组 SIGKILL),
  崩溃/退出实时更新状态;DSH host 重启后自动 adopt 仍在运行的实例(校验 pid + /healthz),不重复启动、不误杀别的进程;
- `runtime/` 与 `node_modules` 已被 `.gitignore` 排除,推送/克隆仓库后按下方“runtime 恢复命令”重新构建即可。

> 本机(BM: Windows 11 ARM64)实测:`code-server@4.134.0`(with Code 1.135.0)
> 已安装进插件 runtime 并完成自动发现 → 启动 → healthz 200 → 停止 → 回收全链路验证。

## 安装 code-server 到插件 runtime(一次性,Windows 原生)

```powershell
# 1) 安装最新版 node-gyp(13.x,旧版 9.x 不识别 VS 2026)
npm install -g node-gyp@latest

# 2) 在插件工作区安装 code-server 最新版(
cd C:\Users\User\Desktop\dsh-code-server-app
npm install --prefix runtime node-gyp@latest --ignore-scripts
$env:FORCE_NODE_VERSION="24"; $env:PYTHON="$env:LOCALAPPDATA\Programs\Python\Python313-arm64\python.exe"
$env:npm_config_node_gyp=...node-gyp\bin\node-gyp.js   # 指向上面安装的 node-gyp
npm install --prefix runtime code-server@latest
npm install-scripts approve code-server argon2 unrs-resolver   # npm 11 拦 postinstall 时
npm rebuild --prefix runtime
```

> Windows 原生构建要点(本机实测,ARM64):
> - **VS 需要 Spectre 缓解库组件**(MSB8040):Visual Studio Installer → 单个组件 →
>   “适用于 ARM64 的 MSVC v18x Spectre-mitigated 库”(x86/x64 同理)。
> - code-server 最新版要求 Node v24(postinstall 校验;本机 v24.13.1 通过)。
> - 若不需要在插件内自足(例如已有全局 code-server),可跳过此步;
>   插件会回退到 PATH/配置的 `bin`(见“配置”表)。

## 安装插件

```powershell
# 开发期:源码目录路径安装(改动即时生效)
dsh plugin --profile web add C:\Users\User\Desktop\dsh-code-server-app

# 或发布形态:tarball
# cd C:\Users\User\Desktop\dsh-code-server-app && pnpm pack
# dsh plugin --profile web add .\dsh-code-server-0.1.0.tgz
```

重启 `dsh web`(静态插件的 client bundle 在服务启动时编入 `window.__DSH_BOOT__`)。

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
