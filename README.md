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
原生模块(node-pty / @vscode/sqlite3 / spdlog …)由 `@jinsiyu/dshcs-*` 子包按**真名直接挂在插件依赖上**、按 os/cpu 自动选中 ——
**无需全局 npm 安装、无需配置 `bin`、无需改 profile 配置、无需第二条安装命令、无需 argon2/C++ 工具链**。

> **打包形态**:插件**不随包分发** argon2 与 code-server 的 136 个运行时依赖
> (express / proxy-agent / js-yaml / pem / limiter …);IDE 由插件自己的 launcher 拉起内置的 VS Code 树,
> 服务方式见下方「服务方式(serve)」。依据与实测证据见 `docs/analysis-code-server-as-dsh-plugin.md`。
>
> **「问 DSH」对话框**:面板是 `lib/client.js` 里手写的 React 组件,渲染器直接 require DSH 页面模块表里的
> `react-dom/client` 与 `@deepseek-ai/dsh-client-ui-primitives`(与界面同一份实例 ⇒ 排版、代码高亮、
> 公式都一致,而且**不可能**版本错配),授权也在同一个对话框里就地处理 —— 详见
> 「与 DSH 的协同:编辑器桥」。整条链上**没有任何构建步骤**。

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
- 设置卡片只有**四组设置**:「**认领类型**」「**打开即全屏**」「**FIM 补全(实验性,默认关;含停顿毫秒数 / 允许多行 / 按 glob 禁用三个子项)**」与「**后台常驻(切标签不重载)**」——没有其它行(0.2.7 起移除「入口」「依赖安装」「环境检测」)。
  打开 IDE 用右侧栏「开始」页的 **Code Server 入口框**,或直接点官方的产物 chip / 交付卡片 / 正文文件名;
  诊断看 DSH host 日志里的 `[code-server]` 输出(`/api/code-server/status` 仍返回 `env` 供脚本排查)。
  旧版的 `windowedOpen`(窗口化打开)、`reserveComposer` 已在 0.2.6 移除:旧设置文档里残留的这两个键不会报错,只是被忽略(不再出现在 schema 里)。
  需要在新标签页用 IDE 时,从设置卡/空态提示里**复制完整地址**(含路径令牌,`http://127.0.0.1:<port>/<token>/`;
  `serve: dsh` 时为 DSH 的 `/code-server/`)—— 少了令牌那一段会 404。

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
| `canOpen` | 见下 | 按「认领类型」设置否决,未认领的地址由官方预览兜底 |
| `title` | 地址末段(=文件名) | tab chip 显示文件名;页面 tab(`sidebar://code-server`)仍是 `Code Server` |

- **认领类型**(设置卡片里的文本框,`claimExtensions`,0.2.11 起):
  **不再区分作用域** —— `dsh-resource://file/session/…` 与 `…/file/absolute/…` 一视同仁,只看扩展名。
  文本框语法(分号分隔,`,`/空白/换行也认;写 `py`、`.py`、`*.py` 等价;大小写不敏感):
  - `*` = 其余类型也认领(兜底);
  - `py` = 认领 `.py`;
  - `!md` = 不认领 `.md`(**排除优先**于认领与 `*`);
  - **默认(0.3.51 起)** 排除三组:
    ① DSH 预览渲染得好的四类 —— `md markdown html htm png jpg jpeg gif webp bmp ico svg pdf`;
    ② **可执行文件与二进制产物** —— `exe com msi msix msixbundle appx appxbundle dll sys scr cpl ocx drv efi mui`、
    `obj o a lib pdb class jar pyc pyo wasm node`、`so dylib ko elf bin out`、`apk ipa deb rpm dmg iso img cab`;
    ③ **Office 与版式文档** —— `doc docx docm dot dotx dotm docb rtf odt`、`xls xlsx xlsm xlsb xlt xltx xltm xla xlam ods`、
    `ppt pptx pptm pot potx potm pps ppsx ppam odp`、`vsd vsdx vssx vstx vsdm vssm vstm one onetoc2 mpt mpp pub msg xps oxps odg`。
    其余(代码、json/yaml、txt、日志、无扩展名如 `Makefile`、未知扩展名)都进 IDE;清空文本框 = 不认领任何文件(只保留页面 tab)。
    - **判据是"进编辑器有没有意义",不是"能不能被执行"**:文本形态的脚本(`bat` `cmd` `ps1` `sh` `py` `js`…)
      与 `csv` / `tsv` **仍然进 IDE** —— 它们是可编辑的文本。
    - **想放开某一组**:把文本框换回短白名单 `*;!md;!markdown;!html;!htm;!png;!jpg;!jpeg;!gif;!webp;!bmp;!ico;!svg;!pdf`
      即可(Office 与可执行文件重新进 IDE,预览友好那几类仍留给 DSH)。
    - 三组清单是导出的常量(`PREVIEW_FRIENDLY_EXTENSIONS` / `EXECUTABLE_EXTENSIONS` / `OFFICE_EXTENSIONS`),
      默认值就是它们的并集;设置卡里的「实际规则」摘要会点名"含可执行文件、Office 文档"。
    - **控件形态(0.3.52)**:认领类型是**多行文本域**(按内容自动长高:默认值 542 字符 → 9 行,上限 12 行,可手动纵向拉伸);
      下面依次是语法提示、「实际规则」摘要、三组说明,以及**折成多行**的默认值代码块 ——
      换行与分号在解析器里等价,那段连换行一起复制回输入框,得到的策略与默认值逐字相同(有单测钉住)。
  - 三种实际形态:纯白名单(`py;ts`,无 `*` → 其余不认领)、兜底(`*`)、兜底加排除(默认)。
  - 语法、默认值与解析都在 `lib/claim-types.js`(host 的 `Config` 默认值与客户端 `canOpen` 共用同一份,
    随包发布,不会两边漂移);单测 `scripts/test-claim-types.mjs`。
- **tab body 怎么定位文件**:从 `useTabInfo().tab.navigation.address` 解析出会话与路径
  (`lib/client.js` 的"地址语法"段,与 DSH `parseFileAddress` 同语义),相对路径按该会话 cwd 展开成绝对路径,
  再把绝对路径 + 可选 `line` 交给 host 的 `/api/code-server/open-file`;内建扩展
  (`dshcs-open-file`)在 workbench 里 `showTextDocument`(带行号时定位到该行)。
- **只留一个 tab(0.3.57 起)**:官方语义本是"一个地址 = 一个 tab"(`contentId` 就是地址:同址幂等、
  异址必新开),而 `replaceTab` 只有**发起方**(产品自己的 `openFile`/`openResource`)能传 ——
  所以插件改成:新 tab 的 body 挂载时**把同窗格里旧的 code-server tab 关掉**。
  于是连点两个文件时,你看到的是**同一个 tab 在换内容**(chip 标题跟着变),而不是越开越多。
  两条刻意留的边界:① 只收**同窗格**的 —— 多窗格是用户主动切分的布局,官方自己也是"每窗格一份"
  (`SidebarRightTabDefinition.multiple` 的注释:"one page per kind in each pane");
  ② 只有"首次可见"的那个新 tab 负责收 —— 标签页恢复/激活顺序不可控,若每个可见的都收别人,
  关掉一个会让下一个变可见,互相收成乒乓(用 ref 钉住"每次挂载只收一次")。
  这些 tab 本来就共用**同一个常驻 workbench**(IDE 是单实例),关掉一个不会重载它:
  常驻 iframe 由 `lib/client.js` 的"常驻 IDE 面"段持有,tab 只是它的停靠宿主(`Element.moveBefore`)。
  回归:`scripts/test-client-bundle-tabs.mjs` —— 对**入口**渲染两个 tab,断言旧的被关、新的还在、
  跨窗格不动、不可见时不动、缺 `actions` 的老 DSH 也不崩(负向对照:摘掉合并调用 → 该用例 FAIL)。
- **为什么还留着那个内建扩展**:VS Code Web 没有"从外部打开文件"的官方 API(唯一入口是
  `?folder=` 指定工作区),所以"让 workbench 定位到某个文件"只能由树内的扩展完成;
  host 写信号文件、扩展轮询并 `showTextDocument`,失败保留重试(实例尚未就绪时也不会丢)。

## 为什么切标签不再重载(IDE 常驻)

**过去的坑**:DSH 的右侧栏(ui-dockkit)`TabPanel` **只渲染当前激活标签的 body**
(`TabPanel.tsx:412` → `renderTab(active)`)——切到别的标签 = React 卸载该 body = iframe 被移出文档 =
浏览上下文销毁,切回来就是一次完整的 VS Code 重载(未保存的缓冲区丢失)。把标签浮动成独立面板只是绕开它,
并没有解决。

**现在的做法(客户端 `lib/client.js` 的常驻面段,0.2.2)**:插件把 iframe **从 React 手里接管**,做成**单例常驻面**:

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
| **`loopback`(默认)** | 插件自己起一个回环端口(**默认 `port: 0` = 每次启动由系统分配随机端口**),右侧栏 iframe 跨源直连;**URL 带随机路径令牌**(`http://127.0.0.1:<port>/<token>/`,见下「回环端口的安全模型」);进程可被 adopt(DSH host 重启后接管) | 无 |
| **`dsh`** | IDE 挂到 **DSH 自己的 HTTP 端口**上的 `/code-server/*`(HTTP prefix 路由)+ `/code-server/<quality>-<commit>`(WS 精确路由),转发到 launcher 的**命名管道**;**没有额外端口**;每条请求(含 WS 握手)先过 `ctx.connection.requestRejection()` —— 与 `/api` 同一套 Host/Origin fence + 浏览器 cookie 认证 | DSH 提供 `webServer` 服务(web profile);desktop 无此服务 → 自动回退 loopback |

### 回环端口的安全模型(0.2.14 起)

`loopback` 是 desktop 端唯一的通路(无 webServer、无同源挂载),所以它单独加固了一层:

- **随机端口**:`port` 默认 `0` → 由系统分配空闲端口,launcher 把**实际**端口写进 `$DSH_HOME/code-server/endpoint.json`,
  host 读回(因此端口每次都变、也不存在"8090 被占用"这类冲突)。要固定地址就显式配 `port`。
- **路径令牌**:每次**新启动**生成 32 位随机令牌(`[0-9A-Za-z_-]`,24 字节随机),写在
  `$DSH_HOME/code-server/path-token`(用户 profile 下,默认 ACL 仅本人可读),成为 URL 的路径前缀。
  没有这个前缀的请求一律 **404**(不泄露"这里跑着 IDE"),前缀不带结尾斜杠会 302 补上。
- **为什么不用 VS Code 自带的 `connection-token`**:它靠 `?tkn=` → 302 + `Set-Cookie: vscode-tkn; SameSite=Lax`;
  而 desktop 的 iframe 是**跨源**的(`dsh-app://` → `127.0.0.1`),Lax cookie 在跨站子框架里不会被带上
  → 会让 IDE 直接打不开。路径前缀不需要 cookie:workbench 的资源与 WS 全部由 `location.pathname` 派生
  (`serve: dsh` 挂在 `/code-server/` 下已验证同一机制),前缀天然跟随每个子请求与 WS 握手。
  (已用真实 Edge + CDP 在**跨源 iframe** 里验证:随机端口 + 令牌下 workbench 正常渲染并建立 WS。)
- **Host 白名单**:回环模式只接受 `127.0.0.1 | localhost | [::1] : <实际端口>`。挡的是 DNS rebinding ——
  这类攻击构造的请求可以不带 `Origin`,只靠 `Origin == Host` 那条检查拦不住。
- **`Referrer-Policy: no-referrer`**:令牌在路径里,不能让它在加载站外资源时经 `Referer` 漏出去。
- **令牌不落 argv、不进日志**:命令行对本机任意进程可见,所以走文件传递;日志里只打印"已启用"。

边界(说清楚,不夸大):这一层挡的是"本机其它应用/端口扫描器/浏览器页面"顺手访问你的 IDE;
**同用户的本地恶意程序**本来就能直接读你的文件、也能读那个令牌文件 —— 那不在本插件的威胁模型内。

- 在 `cordis.patch.yml` 的 `config.serve`(或设置文档里的 `code-server.serve`)切换,下次启动生效 —— **设置卡片不提供这一行**(卡片只有认领类型/打开即全屏/后台常驻/FIM 补全四个设置)。
- `dsh` 模式的实际收益:单一 URL/单一端口(远程访问 DSH 即可用 IDE)、不再暴露额外回环端口、认证与 DSH 同级。
- `dsh` 模式的两点**已知取舍**:
  1. iframe 与 DSH **同源** → 该模式下不再挂 `sandbox`(同源 + `allow-same-origin` 可被 frame 自行摘除,属"看起来有防护");
     `loopback` 模式跨源,`sandbox` 保持原样作为真防护。剪贴板仍由 `allow="clipboard-read; clipboard-write"` 提供。
  2. 转发端口(Ports 面板)的 **WebSocket** 无法用精确升级路由覆盖(端口号在路径里)→ 该功能在 `dsh` 模式下不可用;
     HTTP 转发端口正常;需要端口转发 WS 时请用 `loopback` 模式。

- `loopback` 模式下 upgrade 会做 **code-server 同款 Origin 校验**(0.2.1 起):带 `Origin` 时其 host 必须等于 `Host`
  (含 `Forwarded: host=` / `X-Forwarded-Host` 的反代语义),否则回 `403`;缺 `Origin` 的非浏览器请求放行。
  没有这道检查时,本机任意浏览器页面都能对 `ws://127.0.0.1:<port>/stable-<commit>` 完成握手并驱动 IDE。

## 与 DSH 的协同:编辑器桥(0.3.0 起,默认开)

"IDE 就在旁边"和"agent 真的知道编辑器里发生了什么"是两件事。编辑器桥补的是后一半:**只读**地把
只有编辑器才知道的信息交给 agent,并让用户在编辑器里的动作能反过来驱动当前会话。

### 双向能力

| 方向 | 能力 | 落地方式 |
|---|---|---|
| 编辑器 → agent | **未保存缓冲区**(磁盘内容 ≠ 用户所见)、活动文件与选区、**语言服务器诊断**(含 file:line、来源、code) | agent 工具 `editor_context` / `editor_diagnostics`;写脏文件前额外附一条提醒 |
| 编辑器 → DSH | 选中代码 → 右键「DSH: 针对选中内容提问」→ DSH 页面右下角弹出**提问对话框**(标题栏带 `文件:行`);提问以**用户输入**进当前会话,该会话的**新内容**用 DSH 官方 markdown 渲染器显示在对话框里 | 命令 `dsh-code-server.askAboutSelection`(编辑器右键菜单**最上面两条**之一)→ 桥 `POST /event {kind:'ask-open'}` → 客户端半部 `POST /api/code-server/ask/send` |
| DSH → 编辑器(授权) | agent 要**写工作区外的文件 / 执行命令**时的授权请求 → 对话框里就地弹卡片(工具名 + 原因 + 倒计时),点「允许一次 / 拒绝」立刻生效 | `/api/code-server/ask/state` 的 `approvals` + `POST /api/code-server/ask/approve`(全插件**唯一**的写口令,约束见「安全模型」) |
| agent → 编辑器 | agent 改了哪个文件 → 开**原生 diff** 审阅(左 = **写前的完整原文**,右 = 磁盘现状);缓冲区有未保存改动时**告警而不覆盖** | host 在 `tools/post-execute` 取 `result.value.before`(完整写前全文)存入有界快照缓存 → `tools/result` 的事件带不透明 key → 扩展轮询后取回原文并开 diff + 非模态告警 |

- 工具只在桥就绪时注册(IDE 没起来时模型看不到"有个用不了的工具");提示词段落也只在桥存活时渲染。
- **提问对话框**:右键命令只向宿主上报意图,真正的对话框由 DSH 页面里的插件客户端弹出 ——
  **可拖动、可缩放**(右下角,✕ 关闭),不占编辑器版面;对话框开着的**同时**还能改选区再问。
  宿主证明不了对话框活着(页面没开 / 浏览器还缓存着旧客户端)时只给一条
  「请在 DSH 页面里打开(或刷新)Code Server 标签」的提示 —— 扩展里**没有第二套提问 UI**。
- **两个命令的意图分开记**:「针对选中内容提问」只有真的选了内容才带**行区间 + 选区正文**;
  「针对当前文件提问」**永远不带行号、不带选区** —— 光标停在哪一行跟问题无关,行号只会误导 agent;
  没选区时用选中命令提问也会退化成纯文件。上下文由宿主从它缓存的编辑器状态里取,扩展只上报意图。
- **追问跟着 DSH 自己的设置投递**:DSH 的 `ui-conversation.busyEnter`(设置 → 对话:「忙碌时按 Enter」)
  取值只有 `queue`(默认)与 `steer`。面板里按 Enter 与主界面里按 Enter 是同一个手势,所以读同一个值:
  `steer` ⇒ 宿主用 `agent.steer()`,追问在**当前轮的下一个步骤边界**被读到(当轮就能回应);
  `queue` ⇒ 宿主用 `agent.followup()`,排到**下一轮**、不打扰当前轮。读不到这个设置(命名空间未注册 /
  极简组合)· 老宿主上没有 `agent.steer` ⇒ 一律退回 `queue`,绝不因为设置而投不出去。
  面板状态行会**说清用的是哪种**(「已插入当前轮…」/「已排入下一轮…」)—— 因为 `queue` 期间
  **DSH 主界面看不到这条消息**:它进的是宿主侧待发队列(`next-turn`),而主界面客户端不渲染待发队列
  (只有它成为自己那一轮时才进聊天流)。这不是消息丢了。
- **注入的上下文是折叠的**:桥拼进消息的位置行 + 选区代码块会被拆出来,显示成一行默认收起的
  「上下文」(点开才看得到那段代码),气泡里只留你的原话 —— 与 DSH 界面处理注入上下文的方式一致。
- **正文就是 DSH 的渲染结果**:正文交给 DSH 官方的 markdown 渲染器
  (`@deepseek-ai/dsh-client-ui-primitives` 的 `MarkdownText`)—— 同一套 micromark/mdast 管线、
  同一个增量流式解析器、同一个 shiki 高亮(走 DSH 自己的懒加载语法集)、KaTeX 公式、
  同样的标题与表格排版。只渲染**新内容**(从对话框订阅那一刻起),**不重放历史**、没有"加载更早"。
  官方部件取不到时降级成纯文本 `<pre>`,不白屏。
- **思考过程也照官方显示**:助手的 reasoning 以「思考」行出现 —— **默认收起**、收起时显示首行
  (流式时显示最新一行)、点整行展开全文,用的就是官方 `DisclosureRow` + 官方的思考图标与排版语言。
- **授权就在对话框里处理**:对话框打开着的时候,该会话的授权请求**先问对话框**(5 分钟窗口),
  点「允许一次」/「拒绝」立刻生效;**关掉对话框**或等满窗口就把请求**原样交回官方链路**(DSH 界面照旧弹卡)。
  **永不自动放行** —— `allowed-once` 只能来自你的一次点击,对话框里没有"以后都允许"这种入口。
- 提问进 DSH 会话时是**普通用户消息**(`source: { kind: 'user' }`):来源信息靠正文首行
  `From the editor: <file>[:<行>]` 保留,面板把它折成「上下文」行。
- **桥完全只读**:不写文件、不改文档、不执行命令 —— 四条路由(`/health`、`/sync`、`/old`、`/event`)都是读的。
  唯一能改状态的是 DSH 同源的 `POST /api/code-server/ask/approve`,它只能**回答**已经存在的授权请求
  (见「安全模型」第 2 条)。agent 的写操作仍然全部走它自己的 `fs` 工具,桥只是"知道它写了什么"、
  并把你对授权的答复带回去。
- 编辑器侧的入口还有状态栏的 `$(plug) DSH`(连通时显示,点击打开日志),日志在输出面板
  「DSH Editor Bridge」里 —— 出问题时先看它。
- **扩展装在内置目录**:`dshcs-editor-bridge` 与 `dshcs-open-file` 一样装进 `<树>/lib/vscode/extensions/`
  —— 用户级目录里那个会被 VS Code 服务端标进 `.obsolete`(日志 `Marked extension as removed`)并永久跳过。
  要关掉桥请用插件设置 `editorBridge=false`(不挂桥、不注册工具),不要再指望在扩展视图里卸载它。

### 三条通道(0.3.13 起走**本机 IPC**:Windows 命名管道 / unix socket)

```
扩展 → host     POST /code-server-bridge/sync    一趟来回:上报编辑器状态 + 取回待处理事件与能力位
扩展 → host     GET  /code-server-bridge/health  无鉴权探活(便于重启后一眼确认)
扩展 → host     GET  /code-server-bridge/old     取一份"写前原文"快照(事件里只带不透明 key)
扩展 → host     POST /code-server-bridge/event   上报意图:请宿主打开对话框 / 打开·关闭文件等(进 host 日志尾)
host  → 扩展    <extensionsDir>/.dshcs-bridge/bridge.json  端点 + 令牌(扩展每 5s 重读)
                (同一份内容还会写到**内置扩展旁边** `<树>/lib/vscode/extensions/.dshcs-bridge/` ——
                 环境变量只在 host spawn IDE 时注入,而被**接管**的 IDE 是上一次启动的进程、拿不到它,
                 扩展得能只靠自身位置读到配置)
```

请求走 `http.request({ socketPath })`(`fetch` 不支持 socket),**不开任何端口**。
这四条**全部只读**;提问与授权答复不走桥,而在 DSH 同源的 `/api/code-server/ask/*` 上
(调用方是 DSH 页面里的插件客户端,吃 DSH 自己的 cookie/Origin 校验)。

对话框真正用到的四段状态(`GET /api/code-server/ask/state?rev=N`;没变化只回一个数字):

| 字段 | 内容 | 面板怎么用 |
|---|---|---|
| `entries` | 被对话框 `watch` 的会话的**新内容**条目(user / assistant / tool / approval),有界:每会话 ≤120 条、单条正文 ≤8000 字符、同时 watch ≤4 个会话 | 助手正文交给官方渲染器;工具与授权是紧凑摘要行 |
| `approvals` | 待决授权请求 `[{id, toolName, reason, at}]`(≤4 条) | 弹卡片 + 倒计时;点按后 `POST /ask/approve` |
| `approvalHoldMs` | 授权窗口长度(默认 300000ms = 5 分钟) | 倒计时基准 |
| `contextText` / `mode` | 标题栏那一行(来自宿主缓存的编辑器状态)+ 提问意图 | 标题栏文案;`mode` 决定发送时带不带行号/选区 |

> **为什么不是 HTTP(0.3.13 定论,三条都实测过)**
> 1. **desktop 根本没有 HTTP 面**:渲染进程经 Electron IPC 调 `host.fetch()`
>    (`apps/desktop-host/src/index.ts:308` 的 `createSharedFetchHandler('/api')`)—— 那是进程内函数调用,
>    进程外不可达;插件能挂 HTTP 的只有 web profile 的 `webServer`。
> 2. **`/api` 也不行**:Connection 给 `/api` 装了 Host/Origin/cookie fence
>    (`packages/client/connection/src/index.ts` 里 `requestRejection` → 无 cookie 即 401),而桥的客户端
>    是扩展宿主里的 **Node 进程** —— 它永远拿不到浏览器 cookie。实测(0.3.7):扩展按
>    `/api/code-server/bridge/sync` 轮询,要么 405(打到 launcher/VS Code)、要么 401(打到 /api fence),
>    **桥从来没有真正同步过**。
> 3. 桥的两端本来就是**同一台机器上的两个进程**(扩展宿主 ← 插件 spawn 的 IDE ← 插件)。
>    本机 IPC 比开端口更小:没有网络面、没有 Host/Origin 混淆代理问题,**web 与 desktop 走同一条路**。
>    令牌校验照旧保留(见下),Windows 管道名带随机后缀、POSIX socket 文件 `chmod 0600`。
>
> 历史:0.3.9–0.3.12 挂在 DSH 的 `webServer` 前缀下 —— 于是 desktop 永远休眠(没有 webServer)。

**为什么状态是"推"而不是"拉"**:扩展宿主是 VS Code server 的一个子进程,**不监听任何端口** ——
host 反向请求不到它。所以编辑器状态只能在扩展主动发起的那趟轮询里带上来,host 缓存后给工具读
(缓存滞后最多一个轮询周期 600ms,超过 10s 没更新就判为过期,工具会明说"状态已过期");

**为什么不用 SSE/WebSocket**:扩展宿主里没有 HTTP 服务器,而桥的形态是"每 600ms 一趟请求/响应"。
轮询给了两条好性质:幂等(丢一次事件只是少一次提示,数据本身永远在编辑器里),以及状态天然最新(每趟都刷新)。

**事件的送达契约(0.3.56 修正)**:`agent-edit` 这类提示走环形缓冲,靠 `since=<游标>` 取"比我新的那些";
**seq 在一次桥端点(宿主进程)生命周期内单调递增**,客户端游标只增不减,端点换了(管道名里带宿主 pid)
才用 `since=0` 重新对齐。0.3.9–0.3.55 的宿主在**每趟** `/sync` 后都调用 `reset()`,而它当时会把 seq 归零
⇒ 扩展第一次收到 `seq=1` 后,新事件又从 1 开始编号,`seq > since` 永远不成立 ⇒ **每个 IDE 会话最多只送达
第一条事件**(用户看到的现象就是"偶尔才有一条 diff,而那条还是空 old")。现在:`reset()` 只清缓冲、不回退
seq,并且 `/sync` 回应里带 `lastSeq`(高水位),扩展据此自查游标是否超前(超前就退回 0 重新对齐,自愈)。
回归:`scripts/test-bridge-routes.mjs` 里有一条按真实调用顺序复刻"推送→取→清空"两次的用例。
注意这仍是**提示通道**,不是可靠队列:缓冲 64 条,超出丢最旧,漏一次只是少一次提示。

### 安全模型(五条不变量,改 `lib/bridge.mjs` 之前先读)

桥的令牌写在 `<extensionsDir>/.dshcs-bridge/bridge.json`(**对本机同用户进程可读**),所以:

1. **`/code-server-bridge/*` 只读,只有 `/approve` 一个例外。** 没有写文件、改文档、执行命令、
   拉起进程的路由。令牌泄露的爆炸半径被封在"看到编辑器里的信息",**不会**变成任意文件写/任意命令执行。
   `scripts/test-bridge-routes.mjs` 里有一条白名单断言盯着这件事(未知后缀一律 404)。
   `/old`(0.3.55 新增)也在这条不变量里:它只能按**不透明 key** 读"最近几次 agent 写操作的写前副本"
   这一份有界缓存(条数 ≤8 / 单份 ≤1MB / 总量 ≤4MB / 5 分钟过期),取不到就 404;
   它不接受路径参数,所以读不到任意文件,也不消费(重复轮询拿到同一份)。
2. **`/approve` 的四条约束(缺一条就等于开了任意命令执行的后门,不许放宽)**:
   (a) 只能**回答**已经存在的授权请求,请求体只有 `{id, outcome}`,**不接受任何自由文本 / 路径 / 命令参数**
   —— 它只能"回答问题",不能"发起动作";(b) `id` 必须是本进程自己发起、且**仍未决**的请求(用后即废);
   (c) `outcome` 只接受 `allowed-once` / `rejected`,**没有"永久允许"**;
   (d) 没有面板在看 / 面板关掉 / 窗口超时(默认 5 分钟)→ **交回官方链路**,绝不自动放行
   (DSH 的 `approval/request` 本身 fail closed,这里只能把"没人答"保持成"没人答")。
   `pnpm test:ask-dialog` 里有针对这四条与宿主侧白名单的断言。
3. **带 `Origin` 的请求一律 403。** 浏览器发起必带 Origin(含沙箱 iframe 的 `Origin: null`),
   扩展宿主是 Node 进程、不带。判定顺序上 Origin **先于令牌** —— 否则等于给浏览器一个
   "令牌猜对没有"的 oracle。
   实现细节:Node 路由 → Fetch 适配器把**原始 headers** 挂在 request 上(`dshcsRawHeaders`),
   因为 undici 的 `Request` 构造器会把 `origin` 当 forbidden header 归一化掉 —— 读 `request.headers`
   会让这道 403 静默失效(测试里有这条实测记录)。
4. **路径收敛在编辑器当前工作区**(`workspaceFolder` 之外的诊断直接丢弃)。
5. **有界**:诊断默认 200 条 / 单条截断 500 字符 / 上报体上限 256KB / 事件环形缓冲 64 条 /
   对话流每会话 ≤120 条(单条正文 ≤8000 字符、同时 watch ≤4 个会话)/ 待决授权 ≤4 条 /
   写前原文快照 ≤8 份、单份 ≤1MB、总量 ≤4MB、5 分钟过期(见 `/old`)。

这一层挡的是"本机其它应用或浏览器页面拿到那个文件后乱调桥";**同用户的本地恶意程序**
本来就能直接读你的文件与令牌文件 —— 那不在本插件的威胁模型内(与「回环端口的安全模型」同一句话)。

### 开关与诊断

| 怎么关 | 效果 |
|---|---|
| `cordis.patch.yml` 的 `config.editorBridge: false` | 下次启动不写 bridge.json、不注册工具 |
| 设置文档里的 `code-server.editorBridge: false` | **即时生效**:删配置 + 注销工具,扩展随即休眠 |
| 在 IDE 里禁用扩展 `dshcs-editor-bridge` | 桥自然不可用(工具会注册但立刻报"状态未上报";IDE 侧无任何动作) |

诊断:`GET /api/code-server/status` 的 `bridge` 字段返回
`{ enabled, live, toolsRegistered, supported, url, file }` —— **不含令牌**(令牌只在那个文件里)。

## FIM 补全(实验性,0.3.61 起,**默认关**)

在编辑器里打字停顿时,光标后出现灰色续写(Tab 接受、Esc 丢弃)。**默认关闭**,在设置卡片里那一行开启,开启后即时生效(不用重启宿主、也不用重装插件)。

| 项 | 值 |
|---|---|
| 端点 | DeepSeek **FIM(Beta)**:`POST https://api.deepseek.com/beta/completions`,参数 `prompt`(前缀)+ `suffix`(后缀) |
| 模型 | `deepseek-flash`(官方 FIM 文档的示例模型,也就是本部署的默认模型) |
| 凭据 | 复用 DSH 里已有的 `DEEPSEEK_API_KEY`:`ctx.get('credentials').resolve(...)`,与官方适配器同一条路(取不到再退回启动环境变量) |
| 实测延迟 | **112–416 ms**(非流式;流式反而更慢 ⇒ 故意用非流式) |
| 触发条件 | 停顿 ≥250ms 且通过门控:有选区 / 非 `file` 文档 / 空上下文 / 文档 >2 万行 —— 这几种**根本不发请求** |

**它怎么接进来的(方案 A)**:FIM 走的是 Completions API,而 `ctx.llm.stream(GenerateOptions)` 的词汇表里
只有 `messages`(没有 `prompt`/`suffix`,`purpose` 还是封闭联合 `'compaction' | 'session-title'`)⇒ 插件
**自己注册一个 LLM 适配器路由** `dshcs-fim`:把前缀/后缀装进一条带固定前缀(`dshcs-fim/1 `)的 messages 信封,
适配器解出信封再打那个端点。这样这条调用**仍然走 DSH 的 LLM 服务** —— 取消、超时、终态 chunk、稳定错误码
都按服务契约走(而不是插件自己直连绕过服务层)。依据与实测数据见 `docs/analysis-continuedev-reuse.md` 的 B6/B7。

**三个可调项(0.3.62,都在设置卡里,即时生效)**:

| 设置 | 默认 | 作用 |
|---|---|---|
| 停顿毫秒数 | `250` | 打字停下多久才请求一次。范围 100–3000ms(保存时夹取);**实测端点往返 112–416ms**,所以停顿基本就是"感知到的延迟" |
| 允许多行补全 | 开 | 关掉后宿主只回第一行;首行是空白 ⇒ 这次不补。想更克制(少被打扰)就关掉它 |
| 按 glob 禁用 | 空 | 这些文件里**根本不发请求**。语义:`*` 不跨目录、`**` 跨目录、不含 `/` 的模式只匹配文件名、含 `/` 的模式按**路径尾段**匹配(所以 `vendor/**`、`src/*.ts` 在任何层级都生效)、`/` 结尾视作 `/**`。例:`*.md;vendor/**;**/dist/**` |

> 这三项的语义在**宿主与扩展各有一份实现**(扩展是随包分发的静态文件,不能 import 宿主代码),
> 一致性由 `scripts/test-fim.mjs` 用同一组(模式,路径)语料对两侧做等价断言钉住。

**安全与边界**(这是本插件唯一会把内容发出去的能力):

- **只读不变**:扩展仍然不写文件、不执行命令 —— 它只"提议"一段文本,插入由你按 Tab 完成;
- 只有开启后桥才有第五条路由 `POST /complete`(**唯一一条会发起模型调用**的);没开一律 403,不发任何请求;
- 有界:前后缀各 ≤6000/2000 字符(120/40 行,字符与行数取先到者)、输出 ≤2000 字符、单次 4s 超时、
  最小间隔 120ms、并发 1、每分钟 60 次;超限的请求被拒(409/429),扩展这一轮就当"这次没有补全";
- 扩展侧还有一层:关掉开关后立刻注销 provider(连请求都不发),相同前后文 2 分钟内直接命中本地缓存;

**用量只在两处可见**:这条调用**不是会话请求**,不写会话日志 ⇒ DSH 自己的 token 计量(逐轮用量、
上下文压力、遥测)**都不含它**。所以用量显示在:① IDE 状态栏的 DSH 项 —— 开启后多一格 `$(zap) 1.2k`,
悬停看输入 / 输出 / 缓存命中 / 最近耗时 / 最近错误;② `GET /api/code-server/status` 的 `fim` 字段(同一份快照)。

**已知限制**:模型偶尔会在"并不需要补"的位置硬凑一段(实测在不该补的位置 2/2 复现);过滤管线会剥掉代码围栏与
控制标记,但"该不该补"最终由你判断 —— Esc 或继续打字都会让它消失。更稳的形态要等更快的完成路由,
或者 DSH 把 completion 做成一等请求(那时把适配器里的取数换成新 API 即可,调用方一行不用改)。

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

- code-server 服务目录**跟随活动工作区/会话**:打开期间切换 DSH 会话/工作区,code-server 自动切到新目录
  (解析优先级:当前会话 cwd → 会话所属 `workspace.path` → 最近活跃会话所属 workspace → 首个 workspace.path;
  **"当前会话"的信源随 DSH 版本而变**:≥ 0.1.6-alpha.2 读会话作用域标准 prop `sessionId`,
  ≤ 0.1.6-alpha.1 退回会话列表快照上的 `current` —— 详见下面 0.3.48 那条;纯逻辑内联在 `lib/client.js`
  的"工作区解析"段,两版形状的契约由 `scripts/test-client-bundle-cwd.mjs` 直接对**入口**钉住);
  打开目录显示在 code-server 页面内(`?folder=<cwd>`,跟随切换时页面自动重新加载);
  实现要点:iframe src 必须带 `?folder=<cwd>`——code-server 前端会记住“最近工作区”并自行恢复,
  仅用裸根 URL 只会显示上一次打开的目录、不会跟随切换(本机实测确认)。
  **Windows 路径格式(实测)**:folder 参数必须以 `/` 开头且全部正斜杠,形如 `/C:/Users/User/Desktop/biss`;
  裸 Windows 路径(`C:\...`)会被前端当 URI scheme 而剥掉盘符(页面显示 `\Users\User\...` 且文件树为空),
  `file:///C:/...` 形式则报 “Workspace does not exist”。
- **0.3.48 修的是"打开 Code Server 不打开对应工作区"**:DSH **0.1.6-alpha.2** 把 `current` 从 `SessionListState`
  移出了会话列表 store(refactor 原话:view selection remains outside the Controller),而 0.3.46 及更早版本
  正是从 `useSessions(s => s).current` 里取"当前会话" ⇒ cwd 恒为 undefined ⇒ 客户端**不再向宿主发 cwd**
  ⇒ IDE 以**空工作区**启动(本机实测:`$DSH_HOME/code-server/pid.json` 里 `cwd`/`launchCwd` 双空,
  UI 上看不出任何报错)。0.3.48 起改读会话作用域标准 prop `sessionId`(与官方右侧栏标签
  `ui-deliverables` 的 ReviewTab 同一信源:`useSessions(s => s.byId[sessionId]?.cwd)`),旧的 `current`
  作为向后兼容兜底保留;两条信源都拿不到时**不猜目录**(不发 cwd,workbench 保持当前目录),
  并在控制台留一条 `[code-server] 未能解析当前工作区目录…` 警告 —— 这个坑当初就是"静默"才难查。
- **切换是"轻量"的(0.2.12 起)**:运行中切工作区**不重启 IDE 进程**,host 只把 `state.cwd` 改成新目录,
  由 workbench 拿新的 `?folder=` 重新导航(工作区目录本来就由客户端 URL 决定,进程 cwd 只影响它自己
  spawn 时的相对路径解析)。因此切换**不再丢**扩展宿主/后台任务/服务端状态,也快得多。
  - `status` 里 `cwd` = 当前 workbench 目录;`launchCwd` = **进程启动时**的目录(诊断用,不随切换变化)。
  - 代价(要说清楚):旧目录里**由 IDE 拉起的后台进程/终端不再被自动杀掉**(以前靠"整进程重启"顺带收走)——
    需要时手动收;这也是"不丢状态"的同一枚硬币。
  - 触发时机与本标签是否可见无关:**侧栏收起时标签 body 并不卸载**,所以后台也会跟随(0.2.12 明确保留此行为)。
  - 回归:`scripts/test-workspace-switch.mjs`(5 项:接管实例、切目录不改 pid/不换状态、进程存活、
    同目录幂等、无 cwd 不切换;改回旧行为必挂)。
- process 生命周期由 host 插件管理:启动写 `$DSH_HOME/code-server/pid.json`,停止树级终止(taskkill /T 或进程组 SIGKILL),
  崩溃/退出实时更新状态;DSH host 重启后自动 adopt 仍在运行的实例(校验 pid + /healthz),不重复启动、不误杀别的进程;
- `node_modules`、`vendor/` 与 `repack/` 已被 `.gitignore` 排除,推送/克隆仓库后按下方
  "打包(如何出包)"执行 `pnpm install` → `pnpm run vendor:vscode` →
  (发布预编译原生包)→ `pnpm pack` + `dsh plugin --profile web add` 即可
  (客户端半部与提问面板都是入库的手写源码 —— 整条链上**没有任何构建步骤**)。

> 本机(BM: Windows 11 ARM64)实测:树/依赖全链路是"平台子包直挂插件依赖"供给 ——
> 树包 `@jinsiyu/dshcs-vscode-server`(当前 4.138.0,50.9 MB tgz)、纯 JS 内部依赖与 8 个平台无关
> 重打包包直接进插件 `dependencies`、8 个平台专属重打包包按 win32-arm64/x64 进
> `optionalDependencies`(包自带 os/cpu 自动选),原始名字由 `lib/native.js` 补 junction 还原
> → healthz 200 → 停止 → 回收全链路验证。
> (0.1.37 时代的主包形态已废弃,见下方"升级 VS Code 树"。)

## 打包(如何出包)

```powershell
cd C:\Users\User\Desktop\dsh-code-server-app
pnpm install             # 开发依赖只剩 1 个(@deepseek-ai/schemastery);allowBuilds 已显式声明 → 不执行任何 postinstall
pnpm run vendor:check    # 可选:查看内置 VS Code 树版本 vs code-server 最新版
pnpm run vendor:vscode                            # ① 生成 vendor/vscode(精简 VS Code 树,≈197MB)
pnpm run repack:build -- --target win32-arm64,win32-x64 --pack   # ② 统一脚本产出全部子包(见下表)
pnpm run publish:repacks                         # ③ 发布全部 @jinsiyu/* 子包(默认 dist-tag = next)
pnpm pack                                        # ④ → dsh-code-server-app-<version>.tgz
pnpm run publish:plugin                          # ⑤ 发布插件本体(默认 dist-tag = next)
# 用户重启 dsh web 确认无误后,再把 latest 推进到该版本:
pnpm run promote -- <version>
```

> **这条链上没有构建步骤**:`lib/client.js` —— 包含「问 DSH」对话框的面板 —— 就是入库的手写源码,
> 扩展也是纯 JS。所以 `prepack` 只剩 `vendor:vscode` 一步,发布包里没有任何前端产物,
> `devDependencies` 只剩一个(`@deepseek-ai/schemastery`,测试用)。
> 面板与 DSH 页面的历史分析(按版本分段)见 `docs/analysis-code-server-as-dsh-plugin.md`。

> **dist-tag 政策(必须遵守)**:发布一律发到 **`next`**,**不动 `latest`**;
> `latest` 只保留「最近一个确认无 bug 的版本」,由 `pnpm run promote -- <version>`
> (= `npm dist-tag add dsh-code-server-app@<version> latest`)在**用户重启 dsh web 确认无误后**才推进。
> 这样 `dsh plugin add dsh-code-server-app`(不带版本)和任何按 latest 安装的流程都不会拿到未验证的版本。
> 子包(`@jinsiyu/dshcs-*`)被依赖以**精确版本**引用(平台专属的按目标各钉一份),dist-tag 不影响解析,但同样默认发 `next`。
> 查看当前标签:`npm dist-tag ls dsh-code-server-app`。
>
> **desktop profile 不走命令行安装**(2026-09-13 起的约定):对 desktop 只做 `pnpm pack` + `publish:plugin`(发 `next`),
> 由用户在 DSH Desktop 里用**官方安装方式**自行安装;不要再把 tarball 文件级覆盖进 `~/.dsh/profiles/desktop` ——
> 那条路会绕过 desktop 应用自己的依赖闭包检查,把真实的解析问题掩盖成"装上了但行为怪"。
> web profile 仍可照旧安装验证。
>
> **0.3.45 起没有平台聚合包**,`requires missing @microsoft/mxc-sdk@npm:…` 那类报错不会再出现。根因(实测):
> pnpm 的**增量 hoisted 安装**会漏链「可选子树里的 `npm:` 别名包」,16 个里漏 9 个(第一个就是 mxc-sdk),而
> dsh-desktop 在 `pnpm add` 之后**立刻**校验依赖图 ⇒ 首次安装必失败;重启后应用走「删 node_modules + 完整安装」
> 才补齐 ⇒ 就是你看到的"重启自己装好了"。复现命令与两条修法见 `docs/desktop-first-install-root-cause.md`。

`repack:build`(`scripts/vendor-repacks.mjs`)是**唯一的子包产出脚本**,一次生成:

| 子包 | 内容 | os/cpu |
|---|---|---|
| `@jinsiyu/dshcs-vscode-server@<code-server 版本>` | 精简 VS Code 树(`lib/vscode` + `out/browser` + `src/browser`,**不含** code-server 的 `out/node` 与 136 个运行时依赖) | 平台无关 |
| `@jinsiyu/dshcs-<名字>[-win32-<arch>]` ×16 | VS Code 内部依赖里需要构建的原生包(node-pty / @vscode/sqlite3 / kerberos / koffi / ssh2 / spdlog / …) | 平台专属带 os/cpu |
| `lib/vendored.json`(**不是包**) | 「原名 → 重打包子包」表,随插件发布;运行时由 `lib/native.js` 据此补 junction。0.3.45 起**不再产出平台聚合包** | — |

> argon2 已随 code-server 服务层一起移除(0.2.0):`auth` 固定 `none`,需要对外访问请用 `serve: dsh`。

| 目标 | 命令 |
|---|---|
| **打最新版(上游 code-server 发行版)** | `pnpm run vendor:latest`(= `--force`):从 registry 取 `code-server@latest` 的树到 `vendor/vscode`;之后**必须**重跑 `repack:build` 并重发全部子包 |
| **指定版本** | `pnpm run vendor:vscode -- --version 4.138.0` |
| **从已装好的树快照** | `pnpm run vendor:vscode -- --from <code-server 目录>`(秒级) |
| **开发期让树可直接跑** | `pnpm run vendor:vscode -- --dev-links`(额外把 `lib/vscode/node_modules` 用 junction 补上) |
| **完整重打子包** | `pnpm run repack:build -- --target win32-arm64,win32-x64 --pack`(不给 `--from` 会自动 npm install 解包 + 编译,耗时)。`--target` 只决定**本次在这台机器上构建哪些目标**(原生包要现编,所以 Linux 目标在 Linux 机器或 `repacks.yml` 的 Linux 腿上构建);产品覆盖哪些目标、每模块在哪些目标上有子包,由 `scripts/repack-platforms.json` 决定 |
| **只重打树包 + 依赖表** | `node scripts/vendor-repacks.mjs --reuse --target win32-arm64,win32-x64 --pack`(复用 `repack/build` 里已有的原生包,不重新分析源树;顺带重写 `lib/vendored.json` 与插件依赖表) |
| **发布子包** | 推荐用 CI:`.github/workflows/repacks.yml`(Actions → repacks → Run workflow,勾 `publish`);本地等价命令 `pnpm run publish:repacks`(`--dry-run` 预览;`--only <子串>` 过滤;`--otp <code>` / `--limit N` 应对 2FA;默认跳过已存在的版本,可反复重跑) |
| **发布插件本体** | `pnpm run publish:plugin`(发布**已验证过的那份 tarball**,不会重新打包;默认 dist-tag = `next`) |
| **推进 latest** | `pnpm run promote -- <version>`(用户重启确认无误后;`--dry-run` 先看当前标签) |
| **只报告版本** | `pnpm run vendor:check` |

> `pnpm pack` 的 `prepack` 会自动跑一次 `vendor-vscode-server` 脚本;`vendor/vscode` 已存在时它是
> **秒级 no-op**,所以日常只改插件代码的话直接 `pnpm pack` 即可(不会偷偷升级 VS Code)。
> 升级树必须显式 `pnpm run vendor:latest`(或 `--force`/`--version`),并重发子包。

### 回归脚本(改完跑一遍)

```powershell
pnpm test                    # 一次跑完下面全部(scripts/run-all-tests.mjs;CI 与发布前用的也是它)
# ↑ 是唯一清单:新增回归脚本只改 scripts/run-all-tests.mjs,CI/README 都跟着它走
pnpm test:apply              # 桩 ctx 下跑通 apply(回归:apply 期的 ReferenceError)
pnpm test:claim-types        # 认领类型语法与默认值
pnpm test:bridge-routes      # 编辑器桥:路由表白名单(只读 + /approve + /old)/ Origin 与令牌的判定顺序 / 令牌头三处一致
pnpm test:edit-snapshot      # 写前原文快照:从 tools/post-execute 的 value 取完整 before / 路径按会话 cwd 绝对化 / 缓存三重有界 / /old 的 400-404-200
pnpm test:bridge-extension   # 编辑器桥扩展侧纯逻辑:未保存缓冲区上报、诊断排序截断、diff 判据(old 侧优先级)、投递降级、提问意图与"对话框不可用给提示"
pnpm test:ask-dialog         # 「问 DSH」对话框的接线:没有产物/构建链了、宿主 4 条 ask 路由、扩展只上报编辑器状态、授权四条、桥的安全不变式
pnpm test:launcher-routes    # launcher 的 HTTP 面(起真进程,较慢)
pnpm test:workspace-switch   # 切工作区不重启进程
pnpm test:workspace-cwd      # "当前工作区目录"解析:DSH 0.1.6-alpha.2(sessionId)与旧版(current)两套形状
pnpm test:client-cwd         # 同一件事但直接对**客户端入口** lib/client.js 验(注册出来的 body 真发不发 cwd、URL 带不带 folder)
pnpm test:client-tabs        # "DSH 侧只留一个 code-server 标签页":新标签挂载时收掉同窗格旧标签(跨窗格/不可见时不动)
pnpm test:client-entry       # 客户端入口守卫:经典脚本+工厂包装、require 白名单(= DSH 模块表种子词)、src/ 已消失、与 lib/claim-types.js 逐字一致
pnpm test:ask-panel          # 「问 DSH」对话框面板(0.3.59 起手写):注入机制已下线、视图白名单、注入 CSS 的选择器/var() 安全、六种条目与授权卡片、三条消息落点、拿不到官方部件时的降级
pnpm test:client-seat        # 设置卡住哪个座位:插件页 plugins.bundle.config(DSH ≥ 0.1.6-alpha.2)vs settings.plugin.item(≤ alpha.1;新版已退役)
pnpm test:fullscreen         # 打开标签即全屏
pnpm test:vendored           # 重打包表 ↔ 插件依赖表一致(无 npm: 别名 / 无聚合包 / vendored.json 进了 files)
pnpm test:dsh-resolve        # 部署位置表:各平台全局装布局(npm --prefix / nvm / pnpm global / %APPDATA%)都能找到 DSH 部署
pnpm test:child-node         # Electron 宿主(桌面版)下给 IDE 子进程挑真 Node:候选顺序 / 剥离 ELECTRON_RUN_AS_NODE / 找不到时如实退回
pnpm test:package-files      # 发布物白名单守卫:files 里的模块**递归**import 到的本地文件也必须在 files 里(0.3.53 漏 lib/child-node.mjs 的事故)
                             # 以及反向:files 每条都得存在 —— **打包期生成物除外**(vendor/VENDOR.json 在
                             # .gitignore 里,由 prepack 的 vendor:vscode 生成;ci.yml 不下树,干净克隆上它必然不存在)
pnpm test:installed          # 安装冒烟:对**已装进 profile 的产物**做断言(默认 <DSH_HOME>/profiles/web)
                             # files 白名单每条都在 / 重打包包在当前平台齐全 / 原生模块无缺失 /
                             # 已安装副本能 import / 树在位 —— 仓库回归看不出这一类
```

> `test:bridge-routes` 会把 `DSH_HOME` 指向临时目录(否则它会 adopt 开发机上正在跑的那个实例,
> 并改写真实的 `bridge.json`);脚本最后有一条"隔离自检"断言真实配置一字未动。
> `pnpm test` 失败也继续跑完其余脚本(一次看到全部坏点);有的脚本在环境不满足时自己 SKIP 并
> exit 0(如 `test:launcher-routes` 找不到"内部依赖已建链接"的 VS Code 树),属于通过。
> `@deepseek-ai/schemastery` 是 **devDependency(钉 3.18.2,与部署同版本)**:`lib/index.js` 本来
> 从 DSH 部署里取它(生产里就是 profile 中 hoist 的那一份),而干净 clone / CI runner 上没有 DSH,
> 不钉一份的话 `apply` 类测试会直接抛 `schemastery not found`。它不进发布物(devDependencies
> 不会给使用者安装)。
> **反过来在"已安装副本"里就取不到了**(那不是仓库目录):`lib/dsh-resolve.mjs` 的部署位置表
> 得把用户真实布局都覆盖上 —— 0.3.49 起包括"正在跑的部署(`argv[1]`/`execPath` 向上解析)、
> `%APPDATA%\npm`、`npm --prefix`(`~/.npm-global`)、pnpm global、nvm、系统 `/usr/local|/usr`、
> 以及 `$DSH_HOME` 的 profile 层"。0.3.48 的 Linux 安装冒烟腿(CLI 装到 `~/.npm-global`)就是
> 栽在这张表太窄上(冒烟 ④ 抛 `schemastery not found`,publish 被 skip);回归见
> `scripts/test-dsh-resolve.mjs`(造一整套临时布局逐个验,本机不会自然碰到那些布局)。

## GitHub Actions(CI + 打 tag 发布)

两个工作流都在 `.github/workflows/`,回归清单只有一份(`scripts/run-all-tests.mjs`,即 `pnpm test`):

| 工作流 | 触发 | 做什么 |
|---|---|---|
| `ci.yml` | push `main` / PR / 手动 | `ubuntu-latest` + `windows-latest` 双平台:`pnpm install --frozen-lockfile` → `pnpm test`(全套回归;0.3.59 起**前面没有任何构建步骤**)→ `vendor:check` 只报告版本差 |
| `release.yml` | 推 `v<version>` 标签 / 手动(演练,不发布) | 按 `dependencies` 钉的版本准备 `vendor/vscode` → 全套回归 → `pnpm pack` → 校验 tarball 清单 → **真装两遍**(windows-latest 验 win32 的 16 个子包、ubuntu-latest 验 Linux 的 10 个:各部署一份真 DSH,走官方路径 `dsh plugin --profile web add <tgz>`,再跑 `test:installed` + `dump-config` 断言;两条腿都过才允许发布)→ 发 npm **`next`** → 建 GitHub Release(附 tgz) |
| `repacks.yml` | 手动(`publish` / `probe_oidc` 默认 **false**,四条腿的 `build_*` 默认 **true**)/ push 本文件 / push `.github/oidc-probe.enabled` | **平台专属子包(`@jinsiyu/dshcs-*`)的构建与发布**:同架构宿主 runner 各打一条(`win32-x64` → `windows-latest`、`win32-arm64` → `windows-11-arm`、`linux-x64` → `ubuntu-latest`、`linux-arm64` → `ubuntu-24.04-arm`),默认只构建 + 传 `repack/tgz/*.tgz`(**不发布**,所以它同时就是 Linux 可行性验证的正式位置);勾上 `publish` 才发 npm(默认 `next`)。发布归属与顺序(**五条腿、集合不相交**):**先跑** `independent`(windows-latest,产 **VS Code 树包 + 8 个平台无关重打包包** —— 它们在四个目标上是同一份产物,所以只发这一次);四条平台专属腿 `needs: independent`、构建带 `--skip-independent`、发布带 `--only <自己的目标>` ⇒ 基础层出问题时后面不会发出"半套"子包,也不会有人重复发同一个包名。**认证**:没配 `NPM_TOKEN` 就走 OIDC(per-package Trusted Publisher,workflow 都填 `repacks.yml`,见下)。Linux 腿还会顺带校验「Linux 上生成的 `lib/vendored.json` / `package.json` 与仓库里的一致」(平台政策应当宿主无关)。额外有一个 `probe-oidc` job:对几个真实子包名做**只暂存、不发正式版**的巡检,用来证明这条 OIDC 通道真的可用 |

### Linux 适配(x64 / arm64):改了什么、还差什么

支持 Linux 的关键不是「多编几个包」,而是**把平台政策从"宿主扫描"改成"显式声明"**:

- 上游包基本不写 `os`/`cpu`(实测 16 个模块里只有 `@vscode/windows-ca-certs` 写了),而树清单把这 8 个
  原生模块全放在普通 `dependencies` ⇒ Linux 上照样会装出 Windows-only 的包;`analyze()` 又是按
  「宿主有没有 `.node`」分类的 ⇒ **换宿主平台,分类会漂移**(Linux 上 `windows-registry` 会被判成
  平台无关、写进 `dependencies`,于是 Windows 运行时反而找不到 `-win32-*` 子包)。
- 所以新增 `scripts/repack-platforms.json` 作为**人工评审的唯一声明**:每个模块的 `platform`(要不要按平台
  分包)与 `targets`(在哪些目标上有子包)。生成器只读不写,并据此产出:
  `lib/vendored.json` 的每模块 `targets`(运行时 `lib/native.js` 据此**跳过本平台不适用的模块**,
  不再把 `dshcs-vscode-windows-registry-linux-x64` 这种永远不会存在的包报成缺包)、以及插件
  `optionalDependencies`(不再盲目 × 全部目标)。
- 生成器同时:保留本次分析看不到的条目(用 `--target` 只构建本机目标时,别的平台的模块必须原样留下)、
  平台专属包在该目标上编不出 `.node` 时**跳过而不是发空壳**、Linux 目标补 ELF `e_machine` 校验
  (与 win32 的 PE machine 校验对称)。
- **版本政策(宿主与时点都无关)**:`lib/vendored.json` 里每个模块的版本 = **registry 上我们已经发布的那个号**,
  上游版本漂移**不会**自动改它。实测两例:同一个 `code-server@4.137.0`,`kerberos` 源树里是上游 `2.1.1`
  而我们发布的是 `2.1.1-dshcs.1`(聚合包时代的后缀);`@vscode/proxy-agent` 维护者当时装到 `0.44.0`、
  今天全新装到 `0.45.0`(依赖范围允许漂移,而 `0.45.0` 这个子包我们根本没发过)。照源树写,换个宿主平台
  或换一天重跑,插件依赖就会指向不存在的版本号、装上去直接解析失败。
  **要让插件升到新的上游版本**:在 `scripts/repack-platforms.json` 里给该模块钉 `"version"` → 重跑
  `vendor-repacks.mjs` → 发布新子包 → 刷新依赖表与 `pnpm-lock.yaml`。生成器每次都会把漂移打出来
  (`· <模块>:沿用表里已发布的版本 …(源树里是 …)`),照着那行做即可。
  > 要区分两类依赖:上面这条只管**我们自己的重打包子包**(`@jinsiyu/dshcs-*`,版本必须是发布过的号);
  > 而**上游纯 JS 直装依赖**(`declare` 那批:`cookie` / `ws` / `@vscode/proxy-agent` …)的版本取自源树
  > —— 树里的版本一定来自 npm,跟着树走是安全的。所以后者的差异是**时间**相关(同一 commit 换一天
  > 全新装就可能不同),CI 的「生成表与仓库一致吗」把它当 notice 报,不当 warning。
- **Linux 上构建原生包的系统依赖**:`kerberos` 要 GSSAPI 头(`gssapi/gssapi.h`)⇒ 两条 Linux 腿都会先
  跑 `sudo apt-get install -y libkrb5-dev` 并校验头文件在位。缺它时 `make` 直接失败、`kerberos` 的子包
  产不出来(2026-09-16 第一次跑硬闸门时暴露)。本地在 Linux 上重打时同样要先装它。
- **Linux 上实测**(`linux-x64` / `linux-arm64` 两条腿各真编译一遍,结论行:
  `[repack] linux-x64: 平台专属产出 5 个(…)`):这 5 个模块编出了 `.node` ——
  `@vscode/deviceid` / `@vscode/native-watchdog` / `@vscode/spdlog` / `@vscode/sqlite3` / `kerberos`;
  `windows-ca-certs` / `windows-process-tree` / `windows-registry` 是 Windows-only(白名单里只给 win32),
  在 Linux 上被白名单排除(一次运行里报「白名单排除 N 个」)。
  早先那个手工探针 `linux-repack-probe.yml` **已删除**:它的职责(不发布地试编)现在由这两条腿承担,
  而它按模块发 notice 会撞上「每个 check run 约 20 条 annotation」的上限、结论只能读到尾部。

**Linux 上线现状(2026-09-17 更新)**:

1. ✅ **10 个 Linux 子包已首发**(5 个模块 × x64/arm64)。新包名没法预先建 Trusted Publisher,
   所以首发由维护者本机带 2FA 完成(`npm login --auth-type=web` → 逐个 `npm publish <tgz>`),
   版本与 `lib/vendored.json` 逐字一致,`os=linux` / `cpu=x64|arm64` 都在 registry 上核对过。
2. ⏳ **给这 10 个新包名各加一条信任关系**(一条命令一条,浏览器确认即可,**不需要 OTP**):

   ```powershell
   $env:npm_config_auth_type = 'web'; npm login     # 已登录可跳过
   $names = @(
     '@jinsiyu/dshcs-kerberos-linux-arm64','@jinsiyu/dshcs-kerberos-linux-x64',
     '@jinsiyu/dshcs-vscode-deviceid-linux-arm64','@jinsiyu/dshcs-vscode-deviceid-linux-x64',
     '@jinsiyu/dshcs-vscode-native-watchdog-linux-arm64','@jinsiyu/dshcs-vscode-native-watchdog-linux-x64',
     '@jinsiyu/dshcs-vscode-spdlog-linux-arm64','@jinsiyu/dshcs-vscode-spdlog-linux-x64',
     '@jinsiyu/dshcs-vscode-sqlite3-linux-arm64','@jinsiyu/dshcs-vscode-sqlite3-linux-x64')
   foreach ($n in $names) {
     npm trust github $n --file repacks.yml --repo jinsiyu/dsh-code-server-app --allow-publish -y
   }
   ```
   加完就可以把仓库 Secrets 里的 **`NPM_TOKEN` 删掉** —— CI 之后走 OIDC,不会再撞
   "token 没勾 bypass 2FA ⇒ EOTP" 那个坑(它只在首发新包名时才是必需的)。
3. ✅ **依赖表已接线**:`scripts/repack-platforms.json` 的 `publishedTargets` 已含 `linux-*`;
   `package.json` 的 `optionalDependencies` 现在是 **26 项**(16 win32 + 10 linux,由
   「每模块白名单 ∩ 已发布目标」公式决定,`test-vendored-table.mjs` 会逐项校验);
   `pnpm-lock.yaml` 已刷新(只新增 10 条,无其它改动);`pnpm-workspace.yaml` 的
   `minimumReleaseAgeExclude` 也补了这 10 个 `@版本`(新发布的包会被供应链冷却期挡住)。

   > 再下一步就是我们自己的发版流程:bump 插件版本 → `pnpm pack` → 本机 `dsh plugin --profile web add <tgz>`
   > 确认 → 打 tag 走 `release.yml`。Linux 用户装到这个版本后,`lib/native.js` 会自动把
   > `-linux-*` 子包按原名补成 junction(与 Windows 同一条路径)。

**dist-tag 政策不变**:`release.yml` 只发 `next`,绝不碰 `latest`;`latest` 仍由 `pnpm run promote -- <version>`
在重启 dsh web 确认无误后手动推进(README 上方「打包」一节)。

发布流程(现在只差打一个 tag):

```powershell
# 1) bump package.json 的 version → 提交到 main → 等 ci.yml 绿
# 2) 本机照「打包」在 web profile 装一次、重启 DSH 确认无误(desktop 仍只发包、不命令行安装)
git tag v0.3.47; git push origin v0.3.47   # 3) release.yml 自动:重建 tarball → 发 next → 建 Release
pnpm run promote -- 0.3.47                 # 4) 确认无误后推 latest(手动,不经 CI)
```

一次性配置(仓库 / 账号侧,非文件改动):

- **npm trusted publishing(推荐,无长期凭据)**:两条路都行,结果一样 —— 给包建一条"只允许本仓库
  这个 workflow 发布"的信任关系。
  - **CLI(一条命令,本机实测 dry-run 通过)**:

    ```powershell
    npm login                                   # 已是 jinsiyu 可跳过
    npm trust github dsh-code-server-app --file release.yml `
      --repo jinsiyu/dsh-code-server-app --allow-publish
    ```

    - `--allow-publish` **必须显式给**,否则信任关系建了也不能发布;
    - `--file` 只写文件名(`release.yml`),npm 会自己拼成 `.github/workflows/release.yml`;
    - 这条命令**要求 2FA**(会要一次 OTP;`npm trust` 属于账号变更类操作);
    - 沙箱/受限 shell 里若报 `EPERM … npm-cache`,把缓存挪到可写目录即可:
      `$env:npm_config_cache='<可写目录>'`(**不要**把 `--cache` 写在 `trust` 前面 ——
      会干扰 npm 的子命令解析,报 `Unknown positional argument: github`);
    - 核对:`npm trust list dsh-code-server-app`(该接口对旧式 token 可能返回 403,
      以 npm 网页上的 Trusted Publisher 列表为准)。
  - **网页**:npmjs.com → `dsh-code-server-app` → Settings → Trusted Publisher → GitHub Actions:
    Organization/user = `jinsiyu`,Repository = `dsh-code-server-app`,Workflow filename = `release.yml`,
    **Environment name 留空**(本仓库 release job 没有 `environment:`,填了就对不上)。
  - 语义提醒:这条信任关系等于"**任何对本仓库有写权限的人都能发布这个包**"(npm 的原文:
    "Anyone with GitHub repository write access can publish")。
  - 备选:仓库 Secrets 加 `NPM_TOKEN`,并设仓库 Variables `NPM_AUTH_MODE=token`(该模式不发
    provenance)。注意 npm 正在收紧"绕过 2FA 的旧式 token"(见 registry 的
    bypass2fa-deprecation 提示),所以 OIDC 是更长期的做法;它一旦可用就该把 NPM_TOKEN 删掉。
- **`repacks.yml`(平台专属子包)的认证** —— 两条路,workflow 自己判断(没配 `NPM_TOKEN` 就走 OIDC):
  - **A. `NPM_TOKEN`(目前最省事)**
    1. npmjs.com → 头像 → **Access Tokens** → **Generate New Token** → **Granular Access Token**;
    2. 名字随意(如 `github-actions-repacks`),给一个有效期(如 90 天);
    3. **Packages and scopes** 选 **Read and write**,只勾 **`@jinsiyu`** 作用域(别选 All packages);
    4. **必须勾 "Bypass two-factor authentication (2FA)"** —— 否则无人值守发布会卡在要一次性口令;
    5. 生成后令牌**只显示一次**,立刻复制;
    6. GitHub 仓库 → Settings → Secrets and variables → **Actions** → **New repository secret**,
       名字**必须**是 `NPM_TOKEN`(workflow 里读的就是它),值粘贴令牌。
    ⚠️ npm 官方已公告:2026-07-31 起 bypass-2FA 令牌**不能再做账号/包管理类操作**,并且
    **2027-01 起将失去直接发布**(只剩读取私有包 + 暂存发布,要维护者用 2FA 批准)⇒ 长期请迁到 B。
    - **发布失败怎么读**(`publish-repacks.mjs` 会先做一次 token 体检:只打印长度与形状、绝不打印内容,
      再用 `npm whoami` 确认能不能认证):
      · `E401` / `ENEEDAUTH` ⇒ **token 值不对**:带了引号或末尾换行、复制被截断、或已被撤销 ⇒ 重新生成再粘贴
      (Granular token 形如 `npm_…`,长随机串;classic token 是 36 位 UUID);
      · `npm whoami` 通过、但发布报 **`EOTP`(This operation requires a one-time password)** ⇒ **值是对的**,
      缺的是权限属性:该 token 没勾第 4 步的 **"Bypass two-factor authentication (2FA)"**;
      另外 npm 对**首次发布一个新包名**本身就要求 2FA,而新包名没法预先建 Trusted Publisher
      ⇒ 首发只能本机 `npm publish <tgz> --access public --tag next` 带 OTP 走一次(只发该目标自己的
      `-<目标>` 包,别重发已存在的树包),之后给这些包名各加一条信任关系即可转 OIDC。
  - **B. per-package trusted publishing(长期方案)**:npm 的信任关系是**按包**配的(2026-09 起一个包
    可以配多条,但**没有作用域级**),有多少个子包就要多少条(win32 阶段是 25 条;Linux 上线后按
    `lib/vendored.json` 里每模块的 `targets` 增加)。先生成命令,再在浏览器授权一次后逐条执行:
    ```powershell
    node -e "const t=require('./lib/vendored.json');const p=require('./package.json');const tree=Object.keys(p.dependencies).find(n=>n.endsWith('/dshcs-vscode-server'));const names=[tree,...t.modules.flatMap(m=>m.platform?m.targets.map(x=>m.package+'-'+x):[m.package])];require('fs').writeFileSync('trust-all.txt',names.map(n=>'npm trust github '+n+' --file repacks.yml --allow-publish -y').join('\n')+'\n')"
    Get-Content trust-all.txt | ForEach-Object { Invoke-Expression $_ }
    ```
    > 注意这里用的是**每模块**的 `targets`(不是「模块 × 全部目标」):`@vscode/windows-registry`
    > 只在 `win32-*` 有子包,`-linux-*` 的包名永远不会存在 —— 给不存在的包建信任关系只会白跑一遍。
    配完把 `NPM_TOKEN` 删掉即可(workflow 会自动走 OIDC)。npm 也允许把每条配置设成**只允许暂存发布**
    (版本要你 2FA 批准才生效)—— 更安全,但每批子包都要你手动批准多个版本,按需取舍。
    核对:对任意子包执行 `npm trust list <包名>`,应显示 `file: repacks.yml` 与
    `repository: jinsiyu/dsh-code-server-app`(25 个子包一个都不能少 —— 漏掉的那个包发布时会报
    "没有匹配的信任配置",而那一行会以 annotation 出现在 run 里,不需要 token 就能读)。
  - **验证这条通道(不必等真发布)**:`repacks.yml` 里有一个 `probe-oidc` job ——
    对 4 个真实子包名(`vscode-fs-copyfile` / `node-pty` / `kerberos-win32-arm64` / `vscode-server`)
    各做一次 **staged(暂存)发布**,版本形如 `2.0.1-oidc-probe.<run>`。
    为什么必须放 CI 里:OIDC 令牌只在运行时签发,信任关系按「仓库 + **workflow 文件名** + 包名」匹配 ⇒
    离线验证不了;也正因为后者,巡检只能由 `repacks.yml` 这个文件发起(换个文件名就会被 npm 拒)。
    为什么用 `npm stage publish` 而不是 `npm publish`:`npm stage` 走的是**同一条**认证路径,但版本进的是
    暂存队列,**不进** registry 的正式版本列表(脚本自己会用 `npm view <pkg> versions` 复核一遍),
    所以不会占用任何版本号、也不影响依赖解析。
    触发方式(两种,第二种不需要任何令牌):
    ```powershell
    # ① Actions → repacks → Run workflow,勾上 probe_oidc
    # ② 提交哨兵文件后 push(工作流会跑一遍构建演练 + 巡检)
    New-Item .github/oidc-probe.enabled -ItemType File -Force
    git add .github/oidc-probe.enabled; git commit -m "chore: OIDC 通道巡检"; git push
    ```
    结果怎么读:每个包成功/失败都会发 `::notice::` / `::error::` annotation,公开仓库**不需要登录**
    就能读(`GET /repos/jinsiyu/dsh-code-server-app/check-runs/<id>/annotations`);job 摘要里也有一张表。
    收尾:把暂存的探针版本**reject** 掉(`npm stage list` 看 id、`npm stage reject <id>`,需要你本机的 2FA;
    npm 网页上也有对应的 staged 列表)——**不要 approve**,approve 才会让它变成正式版本。
    验证完删掉哨兵文件,工作流就恢复"不自动巡检"。

几条必须知道的:

- **`release.yml` 是在 runner 上重建 tarball,发的不是本机那份文件**:同一 commit + 同一个钉死的树版本
  ⇒ 内容一致,唯一差异是 `vendor/VENDOR.json` 里的 `platform` / `preparedAt` / `sizeMB` 元数据(运行时只读
  `codeServerVersion` 与 `productPath`)。所以第 4 步 promote 之前,照旧在 web profile 装一次验证。
- **CI 不打 `pnpm pack`**:全新 clone 上 prepack 会去 npm 取 `code-server@latest`,与 `dependencies` 里钉的
  树版本不同步(反而会把「树包精确钉版本」搞挂)。打包只在 `release.yml` 里做,且显式
  `node scripts/vendor-vscode-server.mjs --version <pinned>`。
- **发布门禁**(任一不过即中止,`next` 不会被推进):tag ≠ `package.json.version`、该版本已存在于 npm、
  树包版本不一致(`test:vendored` 的「树包精确钉版本」断言)、回归失败、tarball 清单与两条真装腿的断言。
- 首次发布必须用一个**没发过的版本号**(npm 版本不可变);`release.yml` 支持 `workflow_dispatch` **演练**
  (完整跑一遍但不发布、不建 Release),建议先演练一次再打真 tag。
- 锁文件 `pnpm-lock.yaml` **已入库**(CI 用 `--frozen-lockfile` 做可复现安装,缓存 key 也靠它);它不在
  `package.json` 的 `files` 白名单里,不会进 npm 发布物。
- 本地非交互环境跑 `pnpm install` 若报 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`(要求重建
  `node_modules` 却无人确认),按提示设 `CI=true` 再跑;GitHub Actions 上 `CI=true` 是默认的。

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
- **二进制部分**全部由 `@jinsiyu/dshcs-*` 子包提供,且**直接挂在插件依赖上**(0.3.45 起):
  平台无关的 8 个(`node-pty` / `koffi` / `ssh2` / `cpu-features` / `@parcel/watcher` /
  `@vscode/fs-copyfile` / `@vscode/proxy-agent` / `@microsoft/mxc-sdk`)写进插件 `dependencies`(真名);
  平台专属的 8 个(`@vscode/sqlite3` / `spdlog` / `kerberos` / `deviceid` / `native-watchdog` /
  `windows-registry` / `windows-process-tree` / `windows-ca-certs`)**按 `scripts/repack-platforms.json`
  里每模块的 `targets`** 写进 `optionalDependencies`(真名 + 包自带 os/cpu)→ 一条命令自动选对架构。
  其中 `windows-*` 三个是 Windows-only(只发 `win32-*`),其余五个目标里包含 `linux-x64` / `linux-arm64`
  —— **哪个模块在哪些目标上有子包,只认这份声明**(上游不写 os/cpu,宿主扫描会漂移,详见「Linux 适配」一节);
  **原始名字**由 `lib/native.js` 运行时补 junction 还原(见下「运行时布局自愈」);
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
  (0x8664=x64 / 0xaa64=arm64)、Linux 目标校验 ELF `e_machine`(0x3e=x86-64 / 0xb7=AArch64),
  防交叉编译/串架构的产物被发出去;平台专属包在该目标上**没有编出 `.node` 就不产出**
  (宁可在结论行里报出来,也不发一个装不起来的空壳);
- **原始名字怎么还原**(0.3.45 起):重打包包的真名是 `@<scope>/dshcs-<名字>`,而 VS Code `import` 的是
  `node-pty` / `@vscode/sqlite3` 这类**原名**;打包期把「原名 → 真名」写进 `lib/vendored.json`(随插件发布),
  运行时由 `lib/native.js` 在 `<树>/node_modules/<原名>` 补 junction 指向真名包(幂等、可自愈)。
  **为什么不再用「平台聚合包 + `npm:` 别名」**:pnpm 的增量 hoisted 安装会漏链**可选子树**里的别名包
  (实测 16 个漏 9 个),而 dsh-desktop 安装后立刻校验依赖图 ⇒ 首次安装必报 requires missing;
  改成真名直接依赖后,同一条安装命令 + 校验器判据实测全部通过(复现见 `docs/desktop-first-install-root-cause.md`);
- **解析路径**:host 用 `require.resolve('@jinsiyu/dshcs-vscode-server/package.json')` 找到运行根
  (包内子目录 `vscode/`),入口 `vscode/lib/vscode/out/server-main.js`;VS Code 内部依赖从该运行根向上查找
  (`vscode/lib/vscode/node_modules` → 包 `node_modules` → `<profile>/node_modules`)。
  (旧全量树 `@jinsiyu/dshcs-code-server/code-server` 仍作为回退被识别。)
- **运行时布局自愈**(`lib/native.js` 的 `ensureRuntimeLayout()`,**激活时(先于 envCheck)与每次启动前**幂等执行):
  host 会在 VS Code 树里补两类 **junction**(Windows junction / POSIX 目录软链):
  1. `ensureAliasLinks()`:按 `lib/vendored.json` 把 16 个**原始名字**补到 `<树>/node_modules`
     —— 真名子包装在插件依赖图里,而 VS Code 的 `lib/vscode/out/server-main.js` 用 **ESM import**
     (ESM 不认 `NODE_PATH`),缺了就直接 500;
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

### 客户端半部:为什么没有构建步骤

**`lib/client.js` 就是源码** —— 手写、入库、不压缩。它同时是:右侧栏标签里的常驻 IDE 面、
「问 DSH」对话框的面板、设置卡/设置页。整条链上没有中间产物、没有构建器,也不会"忘了重建"。

为什么可以这样:DSH 用经典 `<script src>` 加载客户端入口(`/plugins/<包名>/client.js`),它**只能是**
一个文件、且必须是 `window.__ModuleLoader__.load({id, factory})` 形态(不能是 ES module;包内分块只能
`require.async('client.*.js')`,本插件用不到),而它需要的一切(React、官方 UI 部件)都能从
DSH 自己的模块表里 `require` 到。

代价与约束(改 `lib/client.js` 前先读):

| 约束 | 为什么 | 谁守着 |
|---|---|---|
| 顶层不许 `import`/`export`/`await` | 经典脚本里它们是语法错误 ⇒ 整个客户端半部不加载(界面全空) | `pnpm test:client-entry` 的 E1 + harness 真加载(E3) |
| `require(...)` 只能是 DSH 模块表的种子词(`react` / `react/jsx-runtime` / `react-dom/client` / `@deepseek-ai/dsh-client-ui-primitives`) | DSH 冻结模块表,别的会抛"未知模块" | E1(有本机 DSH 安装时还会拿它真实的 `staticModules` 逐词核对) |
| 各段落的顶层标识符共享同一作用域 | `var`/`function` 撞名是**静默覆盖**(面板与常驻面都叫过 `state`,已改名 `surfaceState`) | 无自动守卫 ⇒ 新增顶层名字前先搜一遍 |
| `lib/claim-types.js` 的那份是**副本** | 客户端拿不到 host 模块(经典脚本 + 冻结模块表) | E2 逐字比对四组样例 |
| 面板段的额外约束(选择器、`var()` fallback、hook 组件写法、降级路径) | 见下一节 | `pnpm test:ask-panel` 的 P1–P6 |

体积:未压缩 ~145 KB —— 一次下载,rev 机制与缓存策略不变。
测试钩子:入口在 `window.__dshcsTestHooks === true` 时额外导出 `__internals`(供
`test-workspace-cwd.mjs` / `test-sidebar-fullscreen.mjs` / `test-ask-panel-inline.mjs` 直接调内部函数),
DSH 永不设置该标志。

### 「问 DSH」对话框:为什么没有构建步骤

对话框的面板(对话流 / 思考折叠行 / 授权卡片 / 输入框)就在 `lib/client.js` 里 —— 手写、入库、
没有产物、没有 `/ask/bundle`、不往页面注入 `<script>`、也不需要假的 `acquireVsCodeApi`。

它凭什么能不打包:对话框本来就跑在 **DSH 页面里**,而壳的模块表(`dsh-web-frontend` 的
`staticModules`)已经冻结了 `react` / `react/jsx-runtime` / `react-dom` / `react-dom/client` /
`@deepseek-ai/dsh-client-ui-primitives` / … —— 面板直接 `require` 它们:

- 渲染器、设计令牌、KaTeX 样式、shiki 语法集**全部由页面提供**(与 DSH 界面**同一份实例**)
  ⇒ 排版与界面一致,而且**不可能**版本错配;
- 面板用 `require('react-dom/client')` 给自己的容器建 React 根(容器是对话框自己的 div);
- 打开对话框没有"取文本 + 解析 + 执行"这一等 —— 没有产物可等。

代价与约束:

| 约束 | 为什么 | 谁守着 |
|---|---|---|
| 注入页面的 CSS **只能**挂 `.dshcs-*` 选择器 | 样式注入进的是 DSH 自己的文档,碰 `:root`/`body` 会改掉整个界面 | `pnpm test:ask-panel` 的 P3(逐条选择器 + 禁用 at 规则) |
| 每个 `var(--vscode-*)` 都要带 fallback | DSH 页面里没有 `--vscode-*`,裸 `var()` 是"计算值无效"⇒ 按钮/输入框透明 | P3 |
| 带 hook 的组件只能写成 `React.createElement(Name, …)` | 手写没有 JSX;`Name({…})` 会把子组件的 `useState` 算进父组件的 hook 链,分支一变就抛 "Rendered more hooks than during the previous render" | P4(源码级后顾正则) |
| 官方部件要按"函数**或** `{$$typeof}` 对象"取 | `MarkdownText` 是 `React.memo` 的产物(**对象**),按 `typeof === 'function'` 判可用性会让正文静默退成 `<pre>` | P4 的 `askComponent` 用例 |
| 取不到种子词/官方部件时必须降级 | 面板是主路径,白屏等于提问功能没了 | P5(正文退 `<pre>`、按钮退原生 `button`)+ 错误边界 |
| 通知/提问/授权三条消息的路由 | 面板与外壳在同一个 window(不走 postMessage),消息必须落到 `/ask/send|approve|close` | P6 |

编辑器侧同样没有构建步骤:扩展是纯 JS(`extension.js` + `lib/*.js`),提问只上报意图。
这两条"没有构建步骤"的守卫分别在 `pnpm test:client-entry` / `pnpm test:ask-panel`(面板本体)与
`pnpm test:ask-dialog`(接线 + "产物与构建链一处都不许残留")里。

### 开发期:源码目录安装(改动即时生效)

```powershell
dsh plugin --profile web add C:\Users\User\Desktop\dsh-code-server-app
```

> 源码路径以 `link:` 安装。开发机上没有 `vendor/vscode` 时先 `pnpm run vendor:vscode -- --dev-links`;
> 没有平台子包时 host 会回退到包内 `vendor/code-server`(两种布局都支持)。
> 依赖(内部 JS 依赖 + 重打包子包)同样由 pnpm 安装 —— 本地未发布的 `@jinsiyu/*` 需先发布,
> 或把 `repack/tgz/*.tgz` 以 `file:` 依赖临时装进 profile(见 `.tmp-verify.mjs`)。
>
> **改动客户端半部 / 提问对话框**:直接编辑 `lib/client.js`(它是**手写源码**:没有构建步骤、
> 也没有 `src/**` 中间层;格式约束见该文件头部注释,`pnpm test:client-entry` 与 `pnpm test:ask-panel`
> 守着它们)。装进 profile 后浏览器硬刷即生效。
> **改动扩展**:编辑 `assets/extensions/dshcs-editor-bridge/{extension.js,lib/*.js}`(纯 JS、无构建);
> IDE 侧要重启一次才会加载新扩展代码 —— 扩展宿主会缓存已加载的扩展。

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

- **MSVC 平台工具集必须齐**(MSB8020 `无法找到 v145 的生成工具`):VS Code 那批 `@vscode/*` 原生包在
  binding.gyp 里写死了工具集版本,机器上的 VS 缺那一套就直接报 `npm error … MSB8020`,而**整条链以前
  会带着这个错跑完并"成功"**(见下「硬闸门」)。装法(需要管理员;ARM64 主机加 `VC.v145.ARM64`,
  x64/x86 主机加 `VC.v145.x86.x64`):
  ```pwsh
  $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  $vc = & $vswhere -products * -latest -property installationPath
  & "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vs_installer.exe" modify `
    --installPath $vc --add Microsoft.VisualStudio.Component.VC.v145.ARM64 `
    --add Microsoft.VisualStudio.Component.VC.v145.x86.x64 --quiet --norestart --nocache
  ```
  先看看装了什么:`Get-ChildItem "$vc\VC\Tools\MSVC"`。**CI 上不需要这一步** —— runner 镜像里工具集是齐的
  (`repacks.yml` 四条腿本来就编得出 `sqlite3 / spdlog / native-watchdog / …`);
- **硬闸门(0.3.48 起)**:`vendor-repacks.mjs` 收尾会核对「`scripts/repack-platforms.json` 里承诺的
  『模块×目标』是否都真的产出了子包」,缺一个就抛错退出。以前它是**静默退化**的:`npm rebuild` 的失败
  被容错吞掉 ⇒ 那些模块被判成"平台无关"、打成不带目标后缀的包,而依赖表里照旧写着「每目标一份」⇒
  CI 绿着发出去一套装不起来的东西(2026-09-16 由"为什么日志里有 npm error 仍然通过"暴露)。
  现在原生包是**逐个 rebuild** 的(整树 rebuild 会在第一个失败处中断、级联坑掉后面的包),失败的包
  逐条打印;若本机确实编不出来,就用 CI 腿或修工具集,别让它带着缺口发出去;
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
  也可 `pnpm run vendor:vscode -- --version 4.138.0` 或设 `DSHCS_CODE_SERVER_VERSION`。
  已有 `vendor/vscode` 时,不带 `--force`/`--version` 不会升级(日常 `pnpm pack` 是 no-op)。
  **源树优先级(0.2.13 修正)**:显式 `--from` 用给定树;显式 `--force`/`--version` **一定走 registry**
  —— 修正前它们会被"本机已有源树"抢走(`defaultSourceTree()` 先命中 `vendor/code-server` 或 profile 里的旧树),
  于是 README 写的"`vendor:latest` 从 registry 取 latest"实际拿不到新版本(0.2.13 升级时踩到:内置树一直停在 4.136.2);
  只有既没 `--force` 也没 `--version` 时才复用本机源树省一次下载。
- **换版本时同步树内依赖 pin**:`--reuse` 模式下纯 JS 直装集是从**插件 package.json 现读**的,
  所以要先按新树的 `lib/vscode/package.json` 更新 pin(本次 10 个 `@xterm/*` 的 beta 跳号;
  判定规则是"现有 pin 不满足新范围才动",避免把 `cookie`/`ws`/`tar`/`node-addon-api` 这类已有更高版本降级)。
- **先查再升**:`pnpm run vendor:check` 打印「内置版本 / 上游 latest」。
- **换版本后重新出子包并发布**(全部由同一个脚本):
  1. `pnpm run repack:build -- --target win32-arm64,win32-x64 --pack` → 新的树包
     (`@jinsiyu/dshcs-vscode-server@<新版本>`)以及按新内部依赖重建的原生包
     (脚本会把新的「纯 JS 直装集」写进插件 `dependencies`,并把 16 个重打包包按真名写进
     `dependencies` / `optionalDependencies`、重写 `lib/vendored.json`);
  2. `pnpm run publish:repacks` → 发布;然后 bump 插件版本 → `pnpm pack` → 发布插件。
- `productPath`(`<quality>-<commit>`,客户端 WS 路径的组成)**从 `lib/vscode/product.json` 现算**,
  升级树后无需改代码 —— 但也意味着切版本后必须重启 dsh web(路由在激活期注册)。
- **不再有运行期自动升级**:不会在启动时联网取 latest;版本完全由内置产物决定。
- 本机当前内置:`code-server@4.138.0` 的树(VS Code 1.138.0,`productPath=stable-59c988c7…`)。

### 兼容旧安装位

host 探测顺序:`@jinsiyu/dshcs-vscode-server/vscode`(**0.2.0+ 正式布局**)> `@jinsiyu/dshcs-code-server/code-server`
(0.1.40–0.1.43 全量树)> `@jinsiyu/dshcs-code-server-<平台>-<架构>/code-server`(0.1.37 平台专属子包)>
插件包内 `vendor/vscode` > 插件包内 `vendor/code-server`(开发期)。旧安装根
`<profile>\.code-server-app` 只在启动日志里提示可删除,不再被使用。

## 设置卡片(0.3.50 起:插件页;更早:设置 → 插件 → Code Server)

**位置随 DSH 版本而变**(两条腿都注册,谁被声明谁生效,不会出现两份):

| DSH | 座位 | 长什么样 |
|---|---|---|
| **≥ 0.1.6-alpha.2** | `plugins.bundle.config`,**键 = 包名** `dsh-code-server-app` | 插件页 → 找到 `dsh-code-server-app` → 打开该插件页面,设置区在**描述与各行之间**(页面自己画标题/图标/面包屑,我们只出表单 + 保存控件) |
| ≤ 0.1.6-alpha.1 | `settings.plugin.item`(key `code-server`) | 设置 → 插件 → Code Server 的自绘可折叠卡片(该插槽在新版**已退役**) |

> 为什么必须跟着搬:上游 agent note《插件页上的插件配置》把配置从设置页搬到插件页,并**删掉了
> `settings.plugin.item`**;插件页只在 `ledger.bundles.has(包名)` 时才渲染那块区域 —— 键写错或还用旧座位,
> 表现是**设置卡静默消失**(无报错、无日志)。回归:`pnpm test:client-seat`(对构建产物验两个座位与两种视图)。

数据经官方 settings 域(`settingsScope`,命名空间 `code-server`)持久化到官方 settings 文档:

| 键 | 默认 | 说明 |
|---|---|---|
| `claimExtensions` | `*` + 三组排除(预览友好 / 可执行文件 / Office 文档;完整清单见「认领类型」一节) | **认领类型**(0.2.11,取代 0.2.5 的 `fileOpenScope`):按扩展名决定哪些文件交给 VS Code,分号分隔;`*` = 其余类型也认领,`!ext` = 不认领(排除优先)。默认把 DSH 预览渲染得好的四类(markdown/html/图片/PDF)**以及可执行文件(0.3.51)与 Office 文档(0.3.51)**留给 DSH,其余全进 IDE;清空 = 不认领任何文件。**不再区分 session/absolute 作用域** |
| `fullscreenOnOpen` | `true` | **打开即全屏**(0.2.9):打开 Code Server 标签(含点开文件)时自动把右侧栏切到全屏(铺满窗口);关闭则保持 DSH 默认的 push(与对话并排)。只影响打开那一刻,用户点「退出全屏」不会被抢回去 |
| `keepResident` | `true` | **后台常驻**:开启后宿主启动即把 IDE 预加载到"停放区",切标签/收起侧栏不重载、首次打开免等待;关闭则只在打开面板时加载(省内存) |
| `fim` | `false` | **FIM 补全(实验性,0.3.61)**:开启后编辑器里打字停顿会出现灰字续写(Tab 接受 / Esc 丢弃)。**默认关闭** —— 它是本插件唯一会把内容发出去的能力(每次补全把光标附近有上限的一小段代码交给模型),而且这条调用**不进 DSH 的 token 计量**,用量只在 IDE 状态栏可见。详见「FIM 补全」一节 |
| `fimDebounceMs` | `250` | **FIM · 停顿毫秒数**(0.3.62):打字停下多久才发一次补全请求。有效范围 **100–3000ms**,保存时按它夹取(与宿主同一套规则);空/非法值回落 250 |
| `fimMultiline` | `true` | **FIM · 允许多行补全**(0.3.62):关掉后宿主只回第一行(首行为空 = 这次不补)。实测模型在不该补的位置会硬凑,多行会放大这种噪声 |
| `fimDisableGlobs` | 空 | **FIM · 按 glob 禁用**(0.3.62):分号/换行分隔。`*` 不跨目录、`**` 跨目录、不含 `/` 的模式只匹配文件名、含 `/` 的模式按路径尾段匹配、`/` 结尾视作 `/**`。例:`*.md`、`vendor/**`、`**/dist/**`。**两边都判**:扩展侧先判(根本不发请求),宿主侧再判一遍 |

(0.2.9 起卡片只留上面这些设置(0.3.61 加 FIM 补全,0.3.62 加它的三个子项);`windowedOpen` 与 `reserveComposer` 已移除 —— 旧设置文档里残留的键既不报错也不生效。
`serve` 仍是设置命名空间里的键(便于用设置文档切换),但**没有卡片行**,见「服务方式」。)

0.2.7 起卡片**没有**「入口」「依赖安装」「环境检测」三行:入口在右侧栏「开始」页的 Code Server 入口框(或官方的文件点击),
诊断信息不再进 UI —— `/api/code-server/status` 的 `env` 字段仍返回
树版本 / `productPath` / server 入口、VS Code 内部依赖、**预编译原生包**(重打包子包名 + 已解析模块数),需要时用脚本查或看 host 日志。

> 卡片改动经 `scope.watch` 实时生效(host 端 status API 同步返回 `keepResident`、`claimExtensions` 与
> `fullscreenOnOpen`,客户端立即生效);无需重启 dsh。**新增设置键后首次使用前需重启 dsh web**,
> 让 host 重新注册设置命名空间(schema 含新键),否则新键的保存与校验不生效。

## 配置(cordis.patch.yml 的 `config`,均有默认值)

| 键 | 默认 | 说明 |
|---|---|---|
| `serve` | `loopback` | 服务方式:`loopback`(独立回环端口,iframe 跨源)→ `dsh`(挂到 DSH 自身端口的 `/code-server/*`,转发到命名管道,复用 DSH 的 Host/Origin + cookie 防护)。需 DSH 提供 `webServer`,缺失时自动回退 loopback |
| `bin` | `''`(空 = 用自带 launcher) | 逃生舱:显式指定外部 code-server 可执行文件 / `out/node/entry.js` 时退回旧模型(不经 `lib/launcher.mjs`) |
| `host` | `127.0.0.1` | loopback 模式的绑定地址(仅允许回环) |
| `port` | `0` | loopback 模式的端口;**`0` = 每次启动由系统分配随机端口**(实际端口写在 `endpoint.json`,host 读回)。显式给端口则固定使用;该端口被占用且无有效 `pid.json` 时报错并给诊断(拒绝误杀) |
| `auth` | `none` | 固定 `none`(0.2.0 起 argon2 已移除);回环模式的访问控制由**随机端口 + 路径令牌 + Host 白名单**承担(见「回环端口的安全模型」),对外访问请用 `serve: dsh` |
| `userDataDir` | `$DSH_HOME/code-server/user-data` | 用户数据隔离目录 |
| `extensionsDir` | `$DSH_HOME/code-server/extensions` | 扩展目录 |
| `locale` | `''` | 界面语言(空 = 跟随浏览器),如 `zh-cn` |
| `readyTimeoutMs` | `60000` | `/healthz` 就绪探测超时(TCP 或命名管道) |
| `editorBridge` | `true` | **编辑器桥**(0.3.0 起):树内扩展 `dshcs-editor-bridge` 与 host 之间的只读通道(见「与 DSH 的协同」)。关掉 = 不写 `bridge.json`、不注册 `editor_context`/`editor_diagnostics`、扩展休眠。设置文档里的 `code-server.editorBridge` 可**即时**开关 |

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
| GET | `/api/code-server/status` | `{ ok, running, status, host, port, pid, cwd, launchCwd, url, version, error, logTail, adopted }`(另含 `env` 环境检测与 `setup` 兼容字段;`cwd` = 当前 workbench 目录,`launchCwd` = 进程启动目录,loopback 下 `port` = **实际**端口、`url` = 含路径令牌的完整地址) |
| POST | `/api/code-server/start` | body `{ cwd? }`(省略 cwd 不切换工作目录);幂等;运行中切 cwd = **只换目录不重启进程**(0.2.12);loopback 新启动会**轮换端口与路径令牌**(0.2.14) |
| POST | `/api/code-server/stop` | 停止并回收进程树 |
| POST | `/api/code-server/setup` | **兼容空操作**:0.1.36 起依赖由包管理器安装,调用只重新自检 `env` 并返回 |
| POST | `/api/code-server/open-file` | body `{ file }` — 写信号文件,由内置扩展 `dshcs-open-file` 在 code-server 中打开 |
| GET | `/code-server-bridge/health` | 编辑器桥探活(**无鉴权**;只回答"桥活着吗",不含任何编辑器数据)。走**本机 IPC**(命名管道 / unix socket),不在 `/api` 下、也不需要 `webServer` |
| POST | `/code-server-bridge/sync` | 编辑器桥:扩展上报状态(`{context, diagnostics, workspace, at}`)并取回事件;`?since=<seq>` 是事件游标。需 `x-dshcs-bridge-token`,**带 Origin 一律 403** |
| POST | `/code-server-bridge/ask` | 编辑器桥:把编辑器里的提问投进当前会话(`{text, file?, lineStart?, lineEnd?, selection?, languageId?}`);没有可投递的会话时回 **409** |
| POST | `/code-server-bridge/event` | 编辑器桥:扩展上报打开/关闭文件等(进 host 日志尾)。需令牌 |

> 桥的四条路由都自带令牌鉴权(它们**不依赖** DSH 的 cookie fence —— 扩展宿主拿不到浏览器 cookie),
> 且永远只读。传输是本机 IPC(0.3.13 起),所以 **web 与 desktop 同一套**:
> 端点由 host 写在 `bridge.json` 的 `pipe` 字段里,扩展用 `http.request({ socketPath })` 访问。

> 除桥之外,插件不再注册任何插件自有 HTTP 路由;code-server 图标已内联为 data URI(client bundle 内),
> 因此客户端不请求任何插件自有 HTTP 资源。

## DSH Desktop(无 webServer)

- **IDE 子进程必须用真 Node 跑(0.3.53 起;桌面版特有的硬约束)**:DSH Desktop 的宿主进程是
  **Electron 的 Node 模式**(`ELECTRON_RUN_AS_NODE=1`,`process.execPath` = Electron 二进制)。VS Code 的
  `server-main.js` 会注册一段**只在 Electron / `ELECTRON_RUN_AS_NODE` 下生效**的 asar 解析钩子:凡是解析结果
  落在"应用根"之外的包,它就去 `node_modules.asar` 里找,找不到直接抛
  `Cannot find package 'X' within the application resources`。本插件的原生包都是**树外**的 pnpm 目录,
  所以启动路径上的 `@vscode/spdlog` / `@vscode/deviceid` / `@vscode/windows-registry` 三个 ESM import 必被拒
  ⇒ launcher 打 `FATAL 加载 VS Code server 失败` ⇒ 面板显示「**code-server 意外退出(exit 2)**」(界面上的
  报错只有栈尾,首行被日志尾部截断,所以看不出是哪个包)。修法:`lib/child-node.mjs` 检测到 Electron 宿主时,
  改用**应用自带的真 Node**(`resources/runtime/primary-runtime/dependencies/node/bin/node.exe`,实测 v24.21.0),
  并把 `ELECTRON_RUN_AS_NODE` 从子进程环境里剥掉;web/CLI 的普通 node 宿主行为一字不变。
  - 试过但不能用的兜底:`VSCODE_DEV=1`(绕过了钩子,却切到 dev 引导路径 → 报 `<树>/lib/vscode/out/bootstrap-import.js` 缺失);
    往树里补 junction(Node 的 ESM 解析会 realpath,链接建在树里也仍被判为"应用根之外")。
  - 回归:`pnpm test:child-node`(9 项)。
  - **与端口冲突的区别**:端口冲突的签名是 `FATAL 监听失败({...}): listen EADDRINUSE`(发生在**加载成功之后**
    绑端口阶段),而上面这个是加载阶段就死 —— 用随机端口(随机端口也会炸)即可区分。
- host 半部 `inject = ['connection', 'settings']`(**不含 `webServer`**)——desktop profile 关掉了 webserver/web-runtime,
  本插件照常工作;`/api/*` 请求由 Electron `dsh-app://` 协议处理器 → IPC 帧管道 → `createSharedFetchHandler('/api')`。
- 右侧栏标签、guide 入口框、文件地址认领、设置卡片在 desktop 下与 web 相同(code-server 仍是本机 `http://127.0.0.1:<port>` 的 iframe;
  桌面端 `webSecurity: true` 且页面无 CSP 限制,跨源 iframe 正常加载)。
  桌面端同样自带 `dsh-client-ui-sidebar-right`(见 desktop 构建 seed 包列表),因此 0.2.3 的
  "只支持带右侧栏的 DSH" 对 desktop 不构成降级;`serve: dsh` 会自动回退 loopback(那条路确实需要 webServer)。
- **编辑器桥在 desktop 下可用(0.3.13 起)**:桥走本机 IPC(命名管道),与 `webServer` 无关 ——
  扩展宿主是插件自己 spawn 的 IDE 的子进程,两端都在同一台机器上。host 注入 `DSHCS_EXTENSIONS_DIR` 后
  扩展即可找到 `bridge.json`;`/status` 的 `bridge.supported/endpoint` 在 desktop 下同样是 `true`/管道名。
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
    里只有旧版本独有的字符串(如 `dshcs-artifacts`),新版本独有的字符串(如 `claimExtensions` / `fullscreenOnOpen`)一个都没有;
    `Cache\` 里也存着一份引用 `dsh-code-server-app` 的旧响应体。官方插件同理(缓存里那份 `ui-deliverables`
    连当前的 `data-presented-files-row` 都没有)。
  - 诊断手法(字节级,注意别用按控制台编码读文件的 `Select-String`,中文标记会假阴性):
    在 `Code Cache\js` 里搜本版本独有的**ASCII** 标记(0.2.11 起用 `claimExtensions`),命中即说明新 bundle 真的被编译过。
  - 修法:完全关闭应用后删 `Cache`、`Code Cache`、`GPUCache` 三个目录再启动(只清缓存,不动 profile/会话/设置):
    ```powershell
    Remove-Item -Recurse -Force "$env:APPDATA\@deepseek-ai\dsh-desktop\Cache","$env:APPDATA\@deepseek-ai\dsh-desktop\Code Cache","$env:APPDATA\@deepseek-ai\dsh-desktop\GPUCache"
    ```
  - 影响面:不只本插件——**任何**客户端插件升级后都可能继续跑旧代码;发布后请按上面的标记法确认渲染器真的换了 bundle。

## 第三方与许可

本项目自身以 **MIT** 发布(见 [`LICENSE`](LICENSE))。实验性 **FIM 补全**的设计**参考**了
[continuedev/continue](https://github.com/continuedev/continue)(Apache License 2.0,Copyright 2023 Continue)——
具体是它 `tabAutocompleteOptions` 的设置项划分(`debounceDelay` / `useAutocompleteMultilineCompletions` /
`disableInFiles`)与停顿去抖、光标附近窗口、过滤、有界缓存的思路。

**本项目不含 continuedev/continue 的任何源码片段、模板字符串或整份文件**(补全请求走 DeepSeek 官方
FIM(Beta)端点,提示词形态由其官方文档与本机实测确定)。标准 Apache-2.0 全文随包分发
([`LICENSE-Apache-2.0.txt`](LICENSE-Apache-2.0.txt)),逐处参考登记见
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) —— 将来若真移植代码片段,Apache-2.0 的义务
(声明、标注被改动文件、保留上游 NOTICE)已经就位。Apache-2.0 不含商标授权,本项目不使用 "Continue" 作名称或宣传。

## 已知限制

- **~~编辑器桥需要 DSH 提供 `webServer`~~ 已不成立(0.3.13 修正)**:桥改走**本机 IPC**
  (Windows 命名管道 / unix socket,`http.request({ socketPath })`),**web 与 desktop 同一套**,
  不需要 `webServer`、也不开端口。历史:0.3.9–0.3.12 挂在 DSH 的 webServer 前缀下 ⇒ desktop 永远休眠;
  0.3.7 及以前挂在 `/api/code-server/bridge/*` ⇒ 被 Connection 的 cookie fence 401 挡死。
  **文件打开**从来不受影响(它走信号文件)。
- **`/code-server-bridge/health` 的 `bridge` 字段不代表扩展在跑**(0.3.12 澄清):它只表示"桥的目标已就绪"。
  扩展是否真的在跑,看 exthost 日志里有没有它的激活记录,或直接用 `editor_context` 试一次 ——
  0.3.0–0.3.11 就是"health 说 bridge:true、扩展却从没被加载"的状态(原因见上:用户级安装被标 `.obsolete`)。
- **桥的状态有最多 600ms 滞后**:扩展每 600ms 推一次;超过 10s 没更新时工具会明说"状态已过期"
  而不是拿旧数据当新数据(例如用户在 IDE 里关掉面板之后)。
- **未保存缓冲区是"上报"而不是"接管"**:agent 仍然通过它自己的 `fs` 工具按磁盘内容编辑。
  桥能做的是**在写之前提醒**、**写之后给 diff**、**冲突时告警而不覆盖** ——
  它不能替用户决定保存与否(那需要改动 agent 的读路径,不在本版本范围内)。
- **diff 的左栏是"写前的磁盘内容"(0.3.55 起)**:值取自 `tools/post-execute` 的 `result.value.before`
  (`write`/`edit` 都给整份文件文本),所以**文件没在编辑器里打开也能给出完整左栏** ——
  0.3.54 及以前只有"编辑器缓冲区 / 扩展自己的缓存"两条来源,都没命中时左栏是空文本 + 标题写"没有改动前的内容"。
  仍然拿不到的情形有两种,标题会如实说明:`str_replace_editor` 这类 output 是纯字符串的工具(没有 `value`),
  以及写前内容 >1MB(不塞进缓存)。**注意** `value` 是 execution-local:它不进会话日志,宿主重启后旧的 diff 不会重放。
- **对话框只渲染"新内容"**:订阅从对话框建立那一刻开始,`follow` 开帧里的历史 `records` 被丢弃,
  面板里**没有"加载更早"**(历史分页 API `sessionController.page()` 在这个版本里刻意不调用)。
  想看更早的内容请回 DSH 界面。
- **代码高亮跟着 DSH 的懒加载语法集走**:面板用的是页面里那一份渲染器,所以不存在
  "产物里只带哪几套语法"的限制。
- **渲染器版本不可能错配**:面板 `require` 的就是界面自己用的那一份实例。
- **面板里的授权窗口是 5 分钟**:面板打开着的时候授权先问面板(卡片上有倒计时);**关掉面板**或等满 5 分钟
  就交回 DSH 界面 —— 交回之后这一条**只能**在 DSH 界面里处理(卡片从面板消失,对话流里留一行授权审计)。

- ~~子路径不支持~~ **已不成立(0.2.0 实测更正)**:VS Code 渲染出的 workbench HTML 里
  **资源引用全是相对路径**(实测 9 条引用中绝对路径 0 条,`serverBasePath="."`、`rootEndpoint="."`),
  客户端 WebSocket 路径由 `location.pathname + join(serverBasePath ?? '/', <quality>-<commit>)` 拼成,
  因此可以直接挂在 DSH 自身的 `/code-server/*` 下(`serve: dsh`),不需要独立端口、
  也不需要改写 HTML。逐项证据见 `docs/analysis-code-server-as-dsh-plugin.md`。
- **`serve: dsh` 的端口转发 WS 不可用**:`registerUpgrade` 是精确路径匹配,而 `/proxy/:port` 的端口号在路径里
  → 该模式下 Ports 面板的 **WebSocket** 转发不可用(HTTP 转发正常);需要时用 `serve: loopback`。
- **`serve: dsh` 的 iframe 与 DSH 同源** → 该模式不挂 `sandbox`(同源 + `allow-same-origin` 可被 frame 自行摘除);
  `loopback` 模式跨源,`sandbox` 作为真防护保留。
- **跨会话单实例**:host 级共享一份 IDE;切换 cwd 只换 workbench 目录(0.2.12 起不重启进程,旧目录的后台终端不会被收走)。
- **旧版 DSH 不受支持(0.2.3 起)**:没有 `sidebarRightTabs`/`sidebarRight` 的 DSH 上,除设置页一条升级提示外无任何入口;
  旧版用户请留在 `0.2.2`(`dsh plugin --profile web add dsh-code-server-app@0.2.2`)。
- **侧栏标签切换**(0.2.2 起不再重载):DSH 右侧栏只渲染当前激活标签的 body,React 卸载会移走 iframe;
  插件把 iframe 收成单例常驻面,用 `Element.moveBefore()`(状态保持型原子移动)在停靠位与文档级停放区之间搬,
  切标签/收起侧栏再回来**不重载**。不支持 `moveBefore` 的浏览器退回旧行为(`appendChild` → 整页重载),
  状态里以 `degraded` 明示;详见下方「为什么切标签不再重载」。
- **远程访问**:`serve: dsh` 下浏览器只需能到达 DSH 本身(单一端口,认证与 `/api` 同级);
  `serve: loopback` 仅回环绑定(随机端口 + 路径令牌 + Host 白名单,见「回环端口的安全模型」),
  跨机访问请改用 `serve: dsh`(0.2.0 起不再支持 `auth: password`)。
- **回环模式的令牌会随实例轮换**:每次新启动端口与令牌都变;`adopt`(host 重启后接管存活实例)靠
  `endpoint.json` + `path-token` 两个文件对上,所以**别手动删**这两个文件(删了 host 认不出旧实例,
  会当成陌生端口占用处理)。
