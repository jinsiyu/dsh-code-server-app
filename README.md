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
**以平台专属子包的形式随插件依赖安装**(打包期产物 `vendor/code-server` → `@jinsiyu/dshcs-code-server-<平台>-<架构>`,
无安装脚本、无 postinstall),插件目录外就地运行;
VS Code 内部依赖与预编译原生模块**全部由包管理器随插件一起装好** —— 无需全局 npm 安装、无需配置 `bin`、
无需改 profile 配置、无需第二条安装命令。

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
- `node_modules`、`vendor/` 与 `repack/` 已被 `.gitignore` 排除,推送/克隆仓库后按下方
  "打包(如何出包)"执行 `pnpm install` → `pnpm run build:client` → `pnpm run vendor:code-server` →
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
pnpm run vendor:check    # 可选:查看内置 code-server 版本 vs npm 最新版
pnpm run vendor:code-server                      # ① 生成 vendor/code-server(code-server 本体 + 自身依赖)
pnpm run repack:code-server -- --target win32-arm64,win32-x64 --pack   # ② 打成平台专属子包(含 argon2 原生)
node scripts/vendor-repacks.mjs --target win32-arm64,win32-x64 --pack   # ③ 生成/重打包 VS Code 原生包
pnpm run publish:repacks                         # ④ 发布全部 @jinsiyu/* 子包(需 npm 登录)
pnpm pack                                        # ⑤ → dsh-code-server-app-<version>.tgz(约 105KB)
npm publish dsh-code-server-app-<version>.tgz --access public   # ⑥ 发布插件本体(同一次验证的 tarball)
```

| 目标 | 命令 |
|---|---|
| **打 npm 最新版 code-server** | `pnpm run vendor:latest`(= `--force`):从 registry 取 `code-server@latest` 快照到 `vendor/code-server`;之后**必须**重跑 `repack:code-server`(重发子包)与 `vendor-repacks.mjs`(内部依赖版本会变) |
| **指定版本** | `pnpm run vendor:code-server -- --version 4.136.2` |
| **从已装好的树快照** | `pnpm run vendor:code-server -- --from <code-server 目录>`(秒级) |
| **重打 code-server 子包** | `pnpm run repack:code-server -- --target win32-arm64,win32-x64 --pack`(x64 会现编 argon2 并校验 PE) |
| **重建预编译原生包** | `node scripts/vendor-repacks.mjs [--from <已完整安装的树>] --target win32-arm64,win32-x64 --pack`(不给 `--from` 会自己 npm install 解包 + 编译,耗时) |
| **发布子包** | `pnpm run publish:repacks`(`--dry-run` 预览;`--only <子串>` 过滤;`--otp <code>` / `--limit N` 应对 2FA) |
| **发布插件本体** | `npm publish dsh-code-server-app-<version>.tgz --access public`(发布**已验证过的那份 tarball**,不会重新打包) |
| **只报告版本** | `pnpm run vendor:check` |

> `pnpm pack` 的 `prepack` 会自动跑一次 `vendor-code-server` 脚本;`vendor/code-server` 已存在时它是
> **秒级 no-op**,所以日常只改插件代码的话直接 `pnpm pack` 即可(不会偷偷升级 code-server)。
> 升级 code-server 必须显式 `pnpm run vendor:latest`(或 `--force`/`--version`),并重发子包。

## 安装插件(一条命令;依赖全部由包管理器装好)

```powershell
# 包内无 postinstall → 无需 pnpm approve-builds / allowBuilds;一条命令装完
dsh plugin --profile web add dsh-code-server-app@0.1.37
# 本地 tarball 同理:
dsh plugin --profile web add C:\Users\User\Desktop\dsh-code-server-app\dsh-code-server-app-0.1.37.tgz
```

装完即用,**没有第二步、没有「安装环境」、不弹安装指引**。0.1.37 起主包只有 **~105KB**(插件自身代码),
其余全部是依赖:

- **code-server 本体**(含 `lib/vscode` 196.9MB + 它自带的 136 个运行时依赖)打成**平台专属子包**
  `@jinsiyu/dshcs-code-server-<platform>-<arch>@<code-server 版本>`(os/cpu 限定,
  挂在插件 `optionalDependencies`)→ pnpm 按架构自动选中,运行根在
  `<profile>\node_modules\@jinsiyu\dshcs-code-server-win32-arm64\code-server`;
- VS Code 内部依赖里**纯 JS 的部分**(35 个:xterm / katex / typescript / ws / tar …)写在插件
  `dependencies`,由 pnpm 装到 profile 的 `node_modules`(hoisted);
- **需要编译的原生包**(node-pty / @vscode/sqlite3 / kerberos / koffi / ssh2 / cpu-features /
  @parcel/watcher / @vscode/windows-* …共 16 个)由 `@jinsiyu/dshcs-*` 预编译包提供,
  经**平台聚合包** `@jinsiyu/dsh-code-server-runtime-<platform>-<arch>` 用 `npm:` 别名装回**原始名字**;
- 因此依赖图里**没有任何带 pre/install/postinstall 或 binding.gyp 的包** →
  不需要 profile 的 `allowBuilds`、不执行任何构建、**使用者机器不需要 C++ 工具链**;
- **升级插件不再重下 code-server**:子包版本按 code-server 版本缓存,pnpm 会直接复用;
  只有 code-server 版本变化时才重新下载那 ~58MB。

### 安装机制(为什么这样设计)

- **pnpm 11 的硬约束**:依赖树里任何带 `preinstall|install|postinstall`(或包内含 `binding.gyp`/`.hooks`)
  的包都被判定"需要构建",必须由**宿主 profile** 的 `pnpm-workspace.yaml` 用 `allowBuilds` 批准,
  否则 `dsh plugin add` 直接 `[ERR_PNPM_IGNORED_BUILDS]` exit 1。依赖包自己的 `pnpm.allowBuilds`、
  `.npmrc`、`patch:` 协议、`optionalDependencies` 全都不起作用(实测 2026-09,pnpm 11.25);
- **code-server 本体**打包期用 `npm install code-server@<版本> --ignore-scripts`(跳过官方
  `sh ./postinstall.sh`:Windows 无 sh,且它只认 npm/yarn 的 user-agent)拿到树 → 补齐 argon2 native
  (win32-arm64 上游无预编译;可复用本机已有 `argon2.node`,见 `DSHCS_ARGON2_BINARY`)→
  剥掉残留安装脚本 → 快照到 `vendor/code-server/`;
- 随后 `scripts/vendor-code-server-pkg.mjs` 把它打成**平台子包**:树放在包内子目录 `code-server/`
  (npm/pnpm 打包**永远排除包根目录的 node_modules**,放在被 `files` 覆盖的子目录里才会随包发布),
  子包**不写 `dependencies`**(那 136 个依赖已经作为文件打包在 `code-server/node_modules` 里,
  写成 dependencies 会让 pnpm 再装一份);`os`/`cpu` 限定 + 各自编译好的 argon2(arm64 0xaa64 / x64 0x8664);
- **需要编译的包**由 `scripts/vendor-repacks.mjs` 重打包成 `@jinsiyu/dshcs-*`:
  复制已编译的包目录 → **删除 `scripts` / `files` / `binding.gyp` / `.hooks` / `.npmignore`**
  (保留编译好的 `.node` 与全部运行时文件)→ 依赖里的同集包改成 `npm:` 别名 → 平台专属的加
  `os`/`cpu` 与 `-<platform>-<arch>` 后缀;
- **平台聚合包**把重打包包按原始名字装回去(如 `"node-pty": "npm:@jinsiyu/dshcs-node-pty@1.2.0-beta.15"`),
  于是 VS Code 内部代码 `require('node-pty')` 不用改;聚合包本身 `os`/`cpu` 限定,
  插件 `optionalDependencies` 同时声明 win32-arm64 与 win32-x64 两份 → 一条命令自动选对;
- **解析路径**:host 用 `require.resolve('@jinsiyu/dshcs-code-server-<平台>-<架构>/package.json')`
  找到运行根(子目录 `code-server/`),入口 `code-server/out/node/entry.js`;
  VS Code 内部依赖从该运行根向上查找:`code-server/node_modules` → 子包 `node_modules` →
  `<profile>/node_modules`(hoisted 布局),与运行时完全一致。包内 `vendor/code-server` 仅作
  开发期/兼容回退。

> **体积提示**:插件 tarball 约 **105KB**;`@jinsiyu/dshcs-code-server-win32-*` 子包各约 **58–60MB**
> (解包 ~249MB);内部依赖与预编译原生包约 250MB。全部合计安装下载约 310MB。
> `vendor/` 与 `repack/` 都不入 git(见 `.gitignore`)。

> **从 ≤ 0.1.36 升级**:插件包内的 `vendor/code-server/` 已移出到平台子包,主包瘦身到 ~105KB;
> 升级命令不变(一条 `dsh plugin --profile web add dsh-code-server-app@<版本>`),
> 旧的 `vendor/` 会随旧版本包目录一起被 pnpm 清掉。

> **从 ≤ 0.1.35 升级**:旧版的安装根 `<profile>\.code-server-app`(含约 1.4GB 内部依赖)与
> 「安装环境」步骤都不再需要 —— 新版本会检测到它并打一条日志提示可安全删除:
> `Remove-Item -Recurse -Force <profile>\.code-server-app`。profile 的 `pnpm-workspace.yaml` 里
> 若还留着 `dsh-code-server-app: false` 之类的旧条目,也可以删掉(新版不再需要任何构建许可)。

> **卸载**:`dsh plugin --profile web remove dsh-code-server-app` 即可;code-server 子包与原生包
> 是独立依赖,若要彻底清干净可再 `dsh plugin --profile web remove @jinsiyu/dshcs-code-server-win32-arm64`
> (或直接在 profile 里 `pnpm remove`);若还残留旧安装根,再手动删除 `<profile>\.code-server-app`。

> 安装/依赖变化后请**重启 `dsh web`**(静态插件行与 host 探测路径在启动时加载)。

### 开发期:源码目录安装(改动即时生效)

```powershell
dsh plugin --profile web add C:\Users\User\Desktop\dsh-code-server-app
```

> 源码路径以 `link:` 安装。开发机上没有 `vendor/code-server` 时先 `pnpm run vendor:code-server`;
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
| **MSVC 构建工具** | **VS Community 2026 + C++ 桌面负载** | ❌ 不需要 | 打包期需要(编译 16 个原生包 + argon2) |
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

### 升级 code-server 版本

- **打包期决定版本**:`pnpm run vendor:latest`(= `--force`)取 npm **最新版**并重建 `vendor/code-server`;
  也可 `pnpm run vendor:code-server -- --version 4.136.2` 或设 `DSHCS_CODE_SERVER_VERSION`。
  已有 `vendor/code-server` 时,不带 `--force`/`--version` 不会升级(日常 `pnpm pack` 是 no-op)。
- **先查再升**:`pnpm run vendor:check` 打印「内置版本 / npm latest」。
- **换版本后要重发两类子包**(内部依赖版本会跟着 code-server 变):
  1. `pnpm run repack:code-server -- --target win32-arm64,win32-x64 --pack` → 新版本号的 code-server 平台子包;
  2. `node scripts/vendor-repacks.mjs --target win32-arm64,win32-x64 --pack` → 预编译原生包(并把新的
     「纯 JS 直装集」写进插件 `dependencies`、更新两个聚合包版本);
  3. `pnpm run publish:repacks` → 发布;然后 bump 插件版本 → `pnpm pack` → 发布插件。
- **不再有运行期自动升级**:不会在启动时联网取 latest;版本完全由内置产物决定。
- 本机当前内置:`code-server@4.136.2`(with Code 1.136.1)。

### 兼容旧安装位

host 探测顺序:`@jinsiyu/dshcs-code-server-<平台>-<架构>/code-server`(**0.1.37+ 正式布局**)> 插件包内
`vendor/code-server`(0.1.36 及更早 / 开发期)> 旧版安装根
`<profile>\.code-server-app\node_modules\code-server`(兼容 0.1.35 及更早)> 插件包内
`node_modules/code-server`(开发期)> PATH/配置 `bin`。旧安装根只在启动日志里提示可删除,不再被写入。

## 设置卡片(设置 → 插件 → Code Server)

参照 dsh-auto-open-web 的自绘卡片模式,注册在 `settings.plugin.item` 插槽,
数据经官方 settings 域(`settingsScope`,命名空间 `code-server`)持久化到官方 settings 文档:

| 键 | 默认 | 说明 |
|---|---|---|
| `reserveComposer` | `true` | 窗口是否**保留输入框上方空间**:开启时窗口初始/拖动/缩放/最大化都止于输入栏上方(不遮挡 composer);关闭后允许盖住输入框(最大化到视口底)。**仅对旧版 DSH 的浮窗生效**——右侧栏模式下该行隐藏 |
| `windowedOpen` | `false` | **窗口化打开**:开启后各入口(产物按钮 / 设置卡 / 悬浮球)在浏览器**新标签页**打开 code-server(自动启动并跟随当前工作区目录);关闭(默认)使用右侧栏标签(旧版 DSH 为内部浮动窗口) |

卡片底部是**环境检测**(点「检测环境」读取 host `status.env`):
入口、`native`(argon2)、VS Code 内部依赖、**预编译原生包**(平台聚合包名 + 已解析模块数)。
0.1.36 起没有「安装环境」按钮 —— 依赖由包管理器安装,卡片里只显示结果。

> 卡片改动经 `scope.watch` 实时生效(host 端 status API 同步返回 `reserveComposer` 与
> `windowedOpen`,客户端立即生效);无需重启 dsh。**新增设置键后首次使用前需重启 dsh web**,
> 让 host 重新注册设置命名空间(schema 含新键),否则新键的保存与校验不生效。

## 配置(cordis.patch.yml 的 `config`,均有默认值)

| 键 | 默认 | 说明 |
|---|---|---|
| `bin` | `code-server`(占位) | 启动优先级:本配置显式 `bin` > 平台子包 `@jinsiyu/dshcs-code-server-<平台>-<架构>/code-server/out/node/entry.js` > 包内 `vendor/code-server` > 旧安装根 `.code-server-app` > 插件包内 `node_modules` > PATH 中的 `code-server`。都不存在时启动报错并给出排查提示 |
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
- 右侧栏标签、guide 入口框、产物按钮、设置卡片在 desktop 下与 web 相同(code-server 仍是本机 `http://127.0.0.1:<port>` 的 iframe;
  桌面端 `webSecurity: true` 且页面无 CSP 限制,跨源 iframe 正常加载)。
- 安装到 desktop profile:`dsh plugin --profile desktop add dsh-code-server-app@<版本>`(或桌面端插件管理窗)。

## 已知限制

- **子路径不支持**:code-server 前端使用根路径/WebSocket/Service Worker,因此必须独立端口
  iframe 直连,不做 DSH webServer 反向代理;`--base-path` 官方不支持。
- **跨会话单实例**:host 级共享一份 code-server;切换 cwd 需重启实例(右侧栏标签/浮窗自动处理并提示)。
- **侧栏标签切换重载**:DSH 右侧栏只渲染当前激活标签的 body,切走再切回会重挂 iframe(code-server 整页重载);
  长驻会话请保持该标签激活或将其浮动为独立面板。
- **远程访问**:默认仅回环 + 无认证。跨机访问需改 `host` + `auth: password` + `passwordToken`,
  且浏览器必须能直接到达该主机(本插件的“在新标签打开”按 `host:port` 拼 URL)。
