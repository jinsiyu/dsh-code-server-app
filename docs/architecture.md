# 当前架构(0.3.1)

> 面向维护者。描述的是**已经落地并验证过**的形态;历史决策与踩坑过程见
> [`analysis-code-server-as-dsh-plugin.md`](analysis-code-server-as-dsh-plugin.md) 与
> [`plan-noport-desktop-ide.md`](plan-noport-desktop-ide.md)。

## 1. 一句话

IDE 仍然是 **code-server(= VS Code 服务端)自己的进程**,插件负责三件事:**拉起并看护它**、
**把它的资产与连接搬进 DSH 的通道**(客户端因此不依赖任何端口)、**把 DSH 的文件打开请求送进 IDE**。

## 2. 进程与边界

```
┌─ Electron 应用(desktop) / node 进程(web)───────────────────────────────────────────┐
│                                                                                    │
│  DSH Host 进程                                                                      │
│   ├─ 插件 host 半部 lib/index.js(与 host 同进程,注册 /api 路由、管理子进程)          │
│   │    ├─ lib/pipe-tunnel.mjs   隧道转发(loopback/命名管道 → 子进程)                │
│   │    ├─ lib/asset-mirror.mjs  资产镜像(1295 条精确路由 → 子进程)                   │
│   │    └─ lib/serve-dsh.mjs     web 侧:把 /code-server/* 挂到 DSH webServer          │
│   │                                                                                │
│   └─ 渲染进程(DSH 前端,dsh-app://app)                                             │
│        ├─ 插件 client 半部 lib/client.js(右侧栏标签 + 常驻 iframe)                  │
│        │    ├─ src/pipe-relay.js  父窗口中继:postMessage ↔ /api 隧道                │
│        │    └─ src/surface.js     iframe 常驻面(moveBefore 状态保持)                │
│        └─ iframe 内的 VS Code 工作台(文档=镜像 → 与 DSH 前端同源)                    │
│             └─ src/pipe-ws.js(launcher serve 时注入的裸字节 shim)                    │
│                                                                                    │
│  子进程:lib/launcher.mjs(node <app>\resources\runtime\node)                        │
│   └─ VS Code 服务端(import lib/vscode/out/server-main.js → createServer)          │
│        ├─ http 服务:默认 127.0.0.1:8090(web 模式改为命名管道)                      │
│        └─ 扩展宿主子进程(child.send(socket) 交接 —— Windows 上必须真 TCP socket)     │
└────────────────────────────────────────────────────────────────────────────────────┘
```

进程数为 3 层:host(含插件)→ IDE 子进程 → 扩展宿主子进程。**没有额外端口**:客户端侧零端口,
服务端侧一个仅本机监听(见 §6)。

## 3. 客户端的三条数据流

### 3.1 资产(文档 + 全部子资源)

```
iframe 文档 dsh-app://app/api/code-server/asset/index.html
  → host 路由(type=mirror) → 子进程监听器 GET /            ← 文档:模板渲染 + HTML 改写
  → host 路由 /api/code-server/asset/<路径> → 子进程 GET <路径>  ← out/**、extensions/**、_static/**…
```

- 镜像**原样保持 URL 空间**,所以工作台里的相对引用(`./_static/…`、`stable-<commit>/static/out/…`)
  无需重写即可命中;`_VSCODE_FILE_ROOT` 也解析到镜像源下。
- launcher 在返回响应时做两件事:**HTML** 改写(`?v=<每次启动标记>` 缓存击穿 + 注入页面错误上报)
  与 **workbench.js** 的 `webSocketFactory` 注入(仅隧道模式;带"标记命中 1 次"断言,不满足就原样透传)。
- 只注册合法路径:实测 1297 条枚举 / 1295 可注册 / 2 条非法(带空格与加号的语法文件名,走
  `/vscode-remote-resource` 查询端点)。注册耗时 1–3 ms。

### 3.2 WebSocket(IDE 的连接)

```
工作台 → __DSH_WS_FACTORY__.create() 的裸字节 shim(src/pipe-ws.js)
   │  postMessage(ArrayBuffer)          ← 消费 HTTP 101 后只做透传,不做任何分帧
   ▼
父窗口 src/pipe-relay.js → 同源 POST /api/code-server/tunnel(requestBody: 'streaming')
   ▼
host lib/pipe-tunnel.mjs → 子进程 POST /__dshcs/tunnel
   ▼
launcher:自建等价 upgrade 请求 → 连 IDE 自己的监听 socket → VS Code handleUpgrade
   ▼
真 TCP socket → 句柄可交给扩展宿主
```

关键约定:`skipWebSocketFrames=true`(两端都是裸字节);隧道带每次激活随机 token;
onOpen 之前 shim 会缓存待发数据(16 MiB 上限),因此重试安全。

### 3.3 打开文件(DSH → IDE)

```
DSH 前端(deliverables chip / 正文提及 / 任何 openResource(dsh-resource://file/…))
  → 我们的标签按 patterns+canOpen 认领地址(priority: extension)
  → 客户端解析地址 → POST /api/code-server/open-file {file, line?}
  → host 写信号文件 <user-data>/User/dshcs-open.json
  → IDE 内置扩展 dshcs-open-file 每 800ms 轮询 → showTextDocument(可带 Range) → 删除信号
```

## 4. 路由清单

**host(挂在 DSH Connection 的共享 `/api` 通道;web 与 desktop 同一套路径)**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/code-server/status` | 状态快照(含 `tunnel` / `assetMirror` 诊断字段) |
| POST | `/api/code-server/start` `stop` `setup` `ui-mode` `open-file` `diag` | 控制与诊断(buffered 体) |
| POST | `/api/code-server/tunnel` | **streaming** 体:一条 POST 承载一条 IDE 连接的两个方向 |
| GET/HEAD | `/api/code-server/asset/**` | 资产镜像(1295 条精确路由,只读) |

**子进程(launcher 自己的 http 服务)**

| 路径 | 说明 |
|---|---|
| `/healthz` | 就绪探针 + 诊断(`mode`/`tunnelMode`/`serveInjection`/`shimInjections`/`shimBytes`) |
| `/__dshcs/tunnel` | 隧道端点(token 校验 → 代理到自己的监听器) |
| `/__dshcs/report` | 页面错误上报(落 `<user-data>/page-errors.log`) |
| `/manifest.json` `/_static/**` `/proxy/**` | code-server 原本负责的少量 HTTP 面 |
| 其余 | 全部交给 VS Code 的 `handleRequest`;`upgrade` 先过 Origin 校验再 `handleUpgrade` |

## 5. web / desktop 的差异(同一份代码,按组合自适应)

| | web | desktop |
|---|---|---|
| 组合里有 `webServer`? | 有 | 没有 |
| IDE 资产路径 | DSH `webServer` 的 `/code-server/*` 同源挂载(prefix 路由 + 精确 upgrade 路由) | 资产镜像 `/api/code-server/asset/**` |
| IDE 连接路径 | 浏览器原生 WebSocket → DSH upgrade 路由 → 命名管道 | 裸字节 shim → DSH 隧道 → 子进程监听器 |
| 子进程监听 | 命名管道 | `127.0.0.1:<port>`(默认 8090) |
| 资产镜像 / shim 注入 | **关闭**(`DSHCS_TUNNEL_MODE` 不设) | 开启 |
| 客户端是否依赖端口 | 否(同源挂载) | 否(镜像 + 隧道) |

判定发生在插件激活时:`ctx.get('webServer')` 有值即 web 形态;若 `webServer` 晚到,
`ctx.inject(['webServer'], …)` 会关掉镜像并释放路由。

## 6. 端口与安全边界

- **唯一的监听**:子进程的 `127.0.0.1:<port>`(web 模式为命名管道)。绑本机、非 `0.0.0.0`;
  客户端不需要也不使用它 —— 它只服务两件事:镜像转发的 HTTP、以及**扩展宿主必须拿到真 TCP socket 句柄**
  (Windows 上 `child.send` 只支持 TCP 句柄:Duplex→`ERR_INVALID_HANDLE_TYPE`、命名管道→`ENOTSUP`)。
- **跨源防护**:upgrade 请求带 `Origin` 时其 host 必须等于 `Host`(反代语义见 `Forwarded`/`X-Forwarded-Host`),
  否则 `403`(实测伪造 Origin → 403);该检查挂在 upgrade 最前。
- **隧道鉴权**:每次激活随机 token,只经同源 `status` 下发给客户端;
  无效 token → `403`,IDE 未运行 → `503`。
- **镜像**:只读 `GET/HEAD`,路径原样转发,不做磁盘遍历服务(枚举只在启动时做一次)。
- **页面诊断**:可关闭/无害;上报只落本地文件。

## 7. 生命周期

1. 插件激活:读设置(仅 `keepResident` / `fileOpenScope`)→ `ensureRuntimeLayout()`(补齐精简树缺的
   `lib/vscode/node_modules` junction)→ `envCheck()` → 注册 `/api` 路由(含镜像)。
2. 按需/预启动子进程:`launcher.mjs --tree … --user-data-dir … --extensions-dir … --port|--pipe …`,
   注入 `DSHCS_*` 环境(信号文件路径、隧道 token、隧道日志、页面日志、HTML 标记、隧道模式)。
3. 就绪:轮询子进程 `/healthz`;失败按状态机(stopped/starting/running/stopping/error)上报。
4. 运行中:客户端每轮 status 都拿到 `tunnel`/`assetMirror` 快照;iframe 地址带 `?s=<pid|startedAt>`,
   **IDE 重启后 URL 变化 → 自动重新导航**。
5. 停止/退出:父进程消失 → 子进程自杀(watchdog);dispose 释放路由、镜像 disposer 与隧道。

## 8. 代码地图

| 文件 | 角色 |
|---|---|
| `lib/index.js` | host 半部:设置、进程生命周期、`/api` 路由、状态快照 |
| `lib/launcher.mjs` | 子进程:VS Code 服务端引导、HTTP/upgrade 分发、隧道端点、HTML/JS 改写、日志 |
| `lib/pipe-tunnel.mjs` | host 侧隧道转发(token、双向流、背压、统计) |
| `lib/asset-mirror.mjs` | 资产镜像(枚举、注册、转发、开关) |
| `lib/serve-dsh.mjs` | web 侧:`/code-server` prefix + 精确 upgrade 挂载与转发 |
| `lib/vendor.js` `lib/native.js` | 树/入口解析、依赖布局自愈、原生包校验 |
| `src/factory.js` | 客户端插件主体:标签注册、设置卡、URL 构建、各类 API 调用 |
| `src/surface.js` | 常驻 iframe(`moveBefore` 状态保持、停放区、缓存标记) |
| `src/pipe-relay.js` | 父窗口中继(postMessage ↔ 隧道) |
| `src/pipe-ws.js` | 裸字节 shim(随包发布为 `lib/pipe-ws.js`,serve 时注入) |
| `src/address.js` | `dsh-resource://` 地址解析与认领判定 |
| `assets/extensions/dshcs-open-file/` | IDE 内置扩展(信号文件 → `showTextDocument`) |

## 9. 自动化与排障

- **离线测试**:`scripts/test-plugin-apply.mjs`(桩 ctx 跑 apply;部署前置门禁)、
  `test-asset-mirror.mjs`(7)、`test-pipe-tunnel.mjs`(6,含防死锁)、`test-pipe-ws.mjs`(11)。
- **本地端到端**:`scripts/repro-tunnel.mjs` —— 用**真 launcher + 真 VS Code 树 + 真 shim** 跑通
  握手/注入/隧道字节,不需要桌面应用、不需要重启;`DSHCS_REPRO_PLUGIN=<工作区>` 可直接跑工作区副本,
  `DSHCS_REPRO_NO_TUNNEL=1` 模拟 web(验证"不注入")。
- **运行时日志**:`<user-data>/tunnel.log`(隧道事件 + 双向字节数)、`host-diag.log`(host 侧隧道错误)、
  `page-errors.log`(页面内错误)、`client-diag.log`(客户端中继信标);`/healthz` 的
  `tunnelMode`/`serveInjection`/`shimInjections`/`shimBytes`。
- **发布门禁**:`scripts/publish-plugin.mjs` 在发布前校验 9 个运行时文件存在且在 `files` 里
  (0.3.0 就漏过 `lib/pipe-ws.js`)。

## 10. 已知约束

1. **"进程内零监听"在 Windows 不可达**(扩展宿主句柄约束,§6)。客户端零端口已达成。
2. 固定端口默认 8090;要弱化指纹可改随机端口(launcher `--port 0` + host 从 `/healthz` 读真实端口)。
3. 工作台 bundle 的注入依赖一个 ASCII 标记(`remoteAuthority:location.host}`)必须命中 1 次;
   VS Code 升级后若标记消失,注入会**自动跳过并告警**(IDE 退回 loopback WS,不会变砖)。
4. 两个非法文件名(空格/加号)不走逐文件路由,依赖 `/vscode-remote-resource` 端点。
5. 自定义 scheme 下无 HTTP 缓存/CacheStorage/service worker,所有资产每次启动重新取
   (已用 `?v=` 标记 + 镜像转发应对;首屏体积仍受工作台 bundle 影响)。
