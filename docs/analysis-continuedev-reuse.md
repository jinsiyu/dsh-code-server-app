# 分析:continuedev/continue 里有哪些东西能用到 dsh-code-server-app

> **本文只做判定与路线,不含任何代码改动。**
> 上游修订:`continuedev/continue@5522c6f44ca0ac3528b37244818fbfa39b5af470`(`refs/heads/main`,2026-09-21 取)。
> 本文引用的每个文件都带 path + 字节数(+ 关键文件带 blob sha),复核方式见附录 B。
>
> **许可(已核实)**:仓库 `license.spdx_id = apache-2.0`;根目录 `LICENSE` 11348 字节
> (sha `c25dc1768217ba50d454fcc06290d66886512872`);**根目录没有 `NOTICE` 文件**(逐条列过根目录清单);
> `extensions/vscode/LICENSE.txt` 548 字节,正文逐字为
> `Copyright 2023 Continue` + `Licensed under the Apache License, Version 2.0 …`。

## 一、一句话结论

Continue 是"**自带 agent 的 IDE 插件**";我们是"**把 IDE 搬进 agent 界面、并给 agent 装上编辑器感官**"。
两者的交集因此不在 agent 侧,而在 **IDE 侧**:

| 上游层次 | 我们这边对应的东西 | 判定 |
|---|---|---|
| `core/`(agent loop、工具、上下文、规则、模型适配、索引) | DSH 核心已有一整套(`dsh-agent-loop`、`dsh-tools`、`dsh-mcp-client`、`dsh-skill`、`dsh-llm*`、`dsh-tool-fs-search`/`dsh-tool-web`) | **不采用**(重复),其中 3 个模块**可借鉴** |
| `extensions/vscode/`(VS Code 扩展:补全、差异、上下文采集) | 我们的 `assets/extensions/dshcs-editor-bridge/**` + 桥 | **主战场**:补全子系统可整体移植;差异/上下文可借鉴 |
| `gui/`(webview 前端)、`binary/`(Rust CLI)、`extensions/cli`(CLI 入口)、`sync/`(Rust 同步 crate)、`docs-site/` | 我们的客户端半部 `lib/client.js`(手写、不打包)与 DSH 自身的 CLI/Web | **不采用**(与"无构建步骤、发布物不带前端 bundle"冲突) |
| `packages/`(config-yaml、openai-adapters、llm-info、fetch、continue-sdk、terminal-security) | DSH 的设置与模型层 | **不采用**,`terminal-security` 暂缓(前提未满足) |

**能落地的只有三档**:A 档"只读补齐"(便宜、马上能做)、B 档"就地续写"(幽灵补全的子集 ——
**探针已实测:原生 FIM 端点 112–416ms,自动触发的延迟前提成立;但 DSH 的 `ctx.llm` 词汇表发不出这个请求**(见 B6/B7)、C 档"终端/命令风险"(前提条件尚未满足)。

## 二、采用 — A 档:零模型调用,只补"只有编辑器知道"的事实

我们桥的现状(`lib/bridge-tools.mjs:112-155` 的 `renderContext`):活动文件 + 选区正文、脏缓冲区清单
(只给"未保存行数"这个近似,见 `assets/extensions/dshcs-editor-bridge/extension.js:120-133`)、诊断。
下面三件事补的是同一类缺口,且**不引入任何模型流量**。

### A1 未保存缓冲区的正文(最值钱的一条)

- **上游依据**:`core/tools/definitions/readCurrentlyOpenFile.ts`(1078B,sha `87d1adc2…`)、
  `core/tools/implementations/readCurrentlyOpenFile.ts`(1141B,sha `02b7be11…`)。
- **我们的缺口**:`editor_context` 报"这个文件是脏的",但拿不到**用户此刻看到的正文**。agent 转而去读磁盘,
  读到的是过期内容 —— 这正是我们在提示词里反复警告的那件事(`lib/bridge-tools.mjs:44-46`)。
- **做法**:扩展侧新增有界读取(`doc.getText()`,上限沿用桥的 `MAX_BODY_BYTES` = 256 KB;
  超限只回"太大,未发送"而不是截断半份代码);宿主侧新增只读工具 `editor_read_open_file(path?)`。
- **不变量**:仍是**读**。不写文件、不执行命令、不进 `/api`。桥的四条路由性质不变。
- **回归**:`scripts/test-bridge-extension.mjs`、`scripts/test-bridge-routes.mjs`(二者都在 `scripts/run-all-tests.mjs:45,47` 的套件里)。

### A2 打开文件清单与最近编辑序列

- **上游依据**:`core/context/providers/OpenFilesContextProvider.ts`(1773B,sha `afc98ffe…`)、
  `extensions/vscode/src/autocomplete/recentlyEdited.ts`(5064B,sha `25791ffa…`)、
  `extensions/vscode/src/autocomplete/RecentlyVisitedRangesService.ts`(3570B,sha `3e9502c9…`)。
- **落点**:`editor_context` 增加 `openFiles`(可见顺序 / 是否活动 / dirty)与 `recentlyEdited`(最近 N 个文档 + 行区间)。
- **数据来源零新依赖**:`vscode.window.tabGroups`、`vscode.workspace.textDocuments`、`onDidChangeTextDocument`。
- **边界**:沿用已有的 `isInWorkspace()` 过滤(工作区外一律不报),列表有界(建议 ≤30)。

### A3 符号大纲(只借"仓库地图"的思路,实现改用编辑器自己的 LSP)

- **上游依据**:`core/context/providers/RepoMapContextProvider.ts`(2148B,sha `575e7af4…`)、
  `core/autocomplete/context/static-context/StaticContextService.ts`(26686B)、
  `core/indexing/chunk/{chunk.ts 2694B, code.ts 7373B, markdown.ts 4274B}`。
- **不搬 tree-sitter**:嵌进来的 VS Code 树里已经有**真实语言服务**
  ⇒ `vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri)` /
  `'vscode.executeWorkspaceSymbolProvider', query` 更准、零依赖、零语法包体积。
- **落点**:新工具 `editor_symbols(path?)`(层级 + 行号),可选 `editor_workspace_symbols(query)`。
- **注意**:符号名属于"发回模型的内容",与本插件已有的 `editor_diagnostics` 同类,要有条数/深度上限。

### A4(可选,小体量)CodeLens 作为"就地动作"入口

- **上游依据**:`extensions/vscode/src/lang-server/codeLens/providers/QuickActionsCodeLensProvider.ts`(4153B,
  sha `7b802648…`)、`.../SuggestionsCodeLensProvider.ts`(1350B)、`.../registerAllCodeLensProviders.ts`(4608B,
  sha `0488aa61…`)。
- **为什么值得看**:我们现在的入口只有右键菜单两条命令——而 VS Code 的**右键菜单不渲染命令图标**
  (这是本仓库已经踩过的硬事实)。CodeLens 是"贴在代码行上方"的就地入口,不受那条限制。
- **做法**:给"针对这段提问 / 解释这个诊断"加一条 CodeLens,命令体复用现有的 `askAboutSelection`。
- **风险**:CodeLens 会在每行渲染,必须限制触发条件(有选区 / 有诊断),否则干扰阅读。

## 三、采用 — B 档:幽灵补全(Continue 唯一能整体搬过来的子系统)

这是 Continue 与我们重合度最高、且**不依赖它 agent 侧任何东西**的一块:补全管线是纯逻辑 + VS Code API,
我们已有 `ctx.llm` 可发模型调用。

> **先读 B6**:模型侧已实测过(2026-09-21),结论是 B 档的**提示形态与触发方式都要改** ——
> FIM 模板表在这条路由上不可用、思考必须显式关掉、延迟地板 ~500ms 让"停下就自动补"不成立。

### B1 提示词模板表

- **上游**:`core/autocomplete/templating/AutocompleteTemplate.ts`(15318B,sha `c3c2ccee7192da5abb8379d8c2501b42b41529c6`)。
  已逐字读过:接口是 `{ compilePrefixSuffix?, template, completionOptions? }`,按模型族分发
  (stable-code、qwen-coder、qwen 多文件、granite4、seed-coder、codestral、codestral 多文件、mercury、
  codegemma、starcoder2、deepseek-coder `<｜fim▁begin｜>`…),每个模板自带 `completionOptions.stop`。
  配套:`templating/{constructPrefixSuffix.ts 1386B, formatting.ts 2582B, getStopTokens.ts 1106B, index.ts 7900B}`、
  `{filtering.ts 6746B, formatOpenedFilesContext.ts 5459B, validation.ts 854B}`。
- **落点**:宿主侧 `lib/autocomplete-prompt.mjs`(纯函数,可单测)。
- **实测提醒**:这张表在**当前路由上不可用**(B6 的案例 A:模型把 `<|fim_prefix|>` 当正文,回吐整个文件)。
  移植它只对"将来接进来的 FIM 能力模型"有意义;当前要用的是 B6 里那条指令式提示;若走 B7 的原生 FIM,连提示都不需要(端点直接收 `prompt`/`suffix`)。

### B2 结果过滤 / 后处理管线

- **上游**:`core/autocomplete/filtering/streamTransforms/lineStream.ts`(19249B,sha `380d5689…`)、
  `charStream.ts`(4925B,`9177a971…`)、`filterCodeBlock.ts`(4798B,`d9cb8e8a…`)、
  `StreamTransformPipeline.ts`(2754B,`c667b376…`);`filtering/BracketMatchingService.ts`(4326B,`da7d38e6…`);
  `postprocessing/index.ts`(5845B,`6ce3742d…`)、`prefiltering/index.ts`(2129B,`b322b9e2…`);
  `classification/shouldCompleteMultiline.ts`(1316B,`75cfdcd7…`);
  `constants/AutocompleteLanguageInfo.ts`(8520B,`1fdbd3e8…`,逐语言的行注释/块注释规则)。
- **落点**:宿主侧 `lib/autocomplete-filter.mjs`(纯函数:按 stop token 截断、去重复行、去多余代码围栏、单行化)。

### B3 防抖与缓存

- **上游**:`util/AutocompleteDebouncer.ts`(1058B,`90c436b8…`)、`util/AutocompleteLruCache.ts`(6760B,`5bb637fe…`)、
  `util/processSingleLineCompletion.ts`(2046B,`a8a3353c…`)、`generation/GeneratorReuseManager.ts`(2598B)。
- **落点**:扩展侧 `lib/inline-completion.js`(击键取消 + 静止窗口 + LRU)。
- **已落地**:0.3.63 起 FIM 走 `lib/fim-completion.js` 的 `createCompletionCache`
  (**严格精确键**,max 24 / TTL 120 s)。`AutocompleteLruCache` 是**前缀键**、`GeneratorReuseManager`
  是**同一次生成的复用** —— 这两块我们**还没做**,对照见 `docs/analysis-fim-prior-art.md` 第三节第 1 条。

### B4 片段选择(光标附近代码之外的上下文)

- **上游**:`snippets/getAllSnippets.ts`(7966B,`079127ab…`)、`context/ranking/index.ts`(4533B,`1064fd24…`)、
  `context/{ContextRetrievalService.ts 3201B, ImportDefinitionsService.ts 2856B}`。
- **我们的优势**:这些"片段"我们**不用自己找** —— 打开文件、最近编辑、诊断、符号大纲就在编辑器里(A1–A3 到手后可直接喂)。

### B5 VS Code 侧(内联补全 provider 本体)

- **上游**:`extensions/vscode/src/autocomplete/completionProvider.ts`(26847B,sha `498f971d…`,含取消/超时/LRU/降级)、
  `statusBar.ts`(7434B,`f4c74ec7…`)、`lsp.ts`(14280B,`32e8b03f…`)、
  `GhostTextAcceptanceTracker.ts`(4608B,`271e3342…`,接受率埋点)、`util/ideUtils.ts`(19820B,`5d42c06c…`)。
- **落点**:`assets/extensions/dshcs-editor-bridge/extension.js` 注册 `registerInlineCompletionItemProvider`
  + 新文件 `lib/inline-completion.js`;状态栏沿用已有的那一个(`$(plug) DSH`)。
- **契约变更(必须在动手时显式改写)**:`lib/bridge.mjs` 文件头"安全不变量 1"现在写的是
  **"四条路由,全部只读"**;补全需要第五条路由,它**不写文件、不执行命令**,但会发起一次有上限的模型调用 ⇒
  约束要改写为"四条只读 + 一条有界的补全调用",并把速率/长度/并发上限写进同一段注释,而不是悄悄加一条路由。

### B6 模型侧:探针已做(2026-09-21 实测)—— 结论:**B 档必须改形态**

**探针**:仓库根 `.tmp-fim-probe.mjs` / `.tmp-fim-probe2.mjs`(按 `.gitignore` 的 `.tmp-*` 忽略,不进库)。
直连 `https://api.deepseek.com/chat/completions`,**逐字复刻适配器的请求形状**(`thinking:{type}` + `reasoning_effort`
见 `dsh-llm-deepseek/lib/index.js:242-243`,`stop` 透传见 `:247`),模型 = 当前默认 `deepseek-flash`,
密钥从 `~/.dsh/.credentials.yaml` 读入、只存在于进程内(不落盘、不打印)。
*口径:探针走 Chat Completions,而适配器 `protocol` 默认 `messages`(`:2923`);同模型同主机,协议外壳不同,延迟量级可比,Messages 的延迟未单独测。*

| 观测 | 结果(15 次调用) |
|---|---|
| **FIM 原始模板**(qwen 式 `<|fim_prefix|>…<|fim_suffix|>…<|fim_middle|>`) | ❌ 被当成正文:回吐**整个文件**并套 ` ```typescript ` 围栏。**上游 FIM 模板表在这条路由上不可用** |
| **指令式提示**(system 声明"只输出插入文本") | ✅ 两次逐字相同:`readFileSync(join(extensionsDir, 'bridge.json'), 'utf8'),` —— 语义正确、`temperature:0` 下确定 |
| **首字延迟 TTFT** | 620–1007ms;提示从 761 缩到 322 字符几乎无改善;**40 字符、只要一个词也仍是 410/696/714/847ms** ⇒ **~500ms 是路由地板,不是提示长度造成的** |
| **思考开启**(设置里 `reasoningEffort: max`) | ❌ 774 字符思考 + `finish=length` + **正文 0 字符** ⇒ 补全**必须显式关思考**(`reasoningEffort:'off'`,或走 `purpose` 分支) |
| **假阳性**(函数已闭合、无可补内容) | ❌ 2/2 复现:臆造 `export function subtract(...)`;第一轮还吐出过控制标记 `<DSML 控制串>`(间歇性:第二轮未复现)。|
| **模型档位** | `DEFAULT_MODELS` 只有 `deepseek-flash` 与 `deepseek-v4-pro`(`index.js:2894-2905`)⇒ 这条路由上没有更快的小模型可换 |

**结论(B6 只覆盖 chat 路由;原生 FIM 端点改写了它 —— 见 B7)**

1. **在 chat 路由上不能做"停下就自动补"**:~500–700ms 是地板而非长尾,正好是幽灵补全预算(200–400ms)的两倍,
   而这条路由没有更快档位 ⇒ **自动触发在 chat 路由上不成立 —— 但原生 FIM 端点改写了这一条,见 B7**。
2. **能做"显式触发的就地续写"**:按一次键 / CodeLens 触发一次,~700ms 是人对主动请求的正常耐心;质量实测可用。
3. **FIM 模板表暂不移植**(当前路由用不上);指令式提示进 `lib/autocomplete-prompt.mjs`,
   将来接进 FIM 能力模型时再回头看 B1。**注意:走 B7 的原生 FIM 时,连模板表都不需要** —— 端点直接收 `prompt`/`suffix`。
4. 硬要求(两条在原生 FIM 上同样成立;chat 兜底路径还额外多一条"显式关思考"):**"该不该补"由编辑器侧判据兜**、**过滤管线必须剥特殊 token**。

### B7 原生 FIM 端点(官方通路;2026-09-21 实测)—— **模型侧成立,卡在 DSH 的请求词汇表**

> 出处:https://api-docs.deepseek.com/zh-cn/guides/fim_completion/ —— 第一轮探针漏了这条,只测了"拿 chat 路由硬凑 FIM"。
> 该文档:Beta 端点 `base_url = https://api.deepseek.com/beta` ⇒ `POST /beta/completions`,
> 参数 `prompt`(前缀)+ `suffix`(后缀),官方示例模型就是 **`deepseek-flash`**,最大补全 4K;
> 文档末段正是"配置 **Continue** 代码补全插件"—— 官方推荐的接法。

探针 `.tmp-fim-native.mjs`(同样只读凭据、不打印):

| 观测 | 结果 |
|---|---|
| 官方 fib 样例 | ✅ `if a == 0: return 0 … if a == 1: return 1` 逐字正确 |
| TS 补函数体(与 B6 同题) | ✅ `readFileSync(join(extensionsDir, 'bridge.json'), 'utf8')` |
| TS 停在 `&&` 中间 | ✅ `group.path !== args.file) {`(前导空格交给过滤管线 trim) |
| **总耗时(非流式)** | **112 / 209 / 363 / 416 ms** —— 比 chat 路由的 635–1054ms 快一个量级,**进入幽灵补全预算** |
| **流式** | ❌ 反而更差:首字 691–810ms、总 833–1045ms ⇒ 这条能力应当**用非流式**(整份答案一次到位) |
| `stop` | ✅ 被尊重(`stop:[","]` ⇒ 输出截到 `readFileSync(join(extensionsDir`) |
| 用量 | prompt 21–70 token、completion 7–24 token;响应带 `prompt_cache_hit_tokens` |
| 假阳性 | ❌ 与 chat 路由**一样**:函数已闭合处仍臆造 `subtract` ⇒ 这是模型特性,不是路由产物 |

**剩下的唯一阻塞点(已核实、可引用)**:`ctx.llm.stream(GenerateOptions)` **表达不了这个请求** ——
`GenerateOptions = {provider, model, reasoningEffort?, messages: Message[](必填), system?, tools?, temperature?, maxTokens?, stop?, signal?, sessionId?, purpose?}`
(`@deepseek-ai/dsh-llm/lib/types/types.d.ts:439-479`),其中 `purpose` 是**封闭联合** `'compaction' | 'session-title'`,
没有 `prompt`/`suffix`/completions 变体;`dsh-llm-deepseek` 的 `protocol` 只有 `chat-completions` 与 `messages`(`index.js:2923`);
`dsh-llm-pi-ai` 里 `/completions` 与 `suffix` **零命中**。⇒ **插件今天无法用 `ctx.llm` 发 FIM 请求。**

出路(按推荐度):

1. **DSH 侧开一条完成能力**(推荐):给 `GenerateOptions` 加 completions 变体或新的 `purpose` 值(携带 `prompt` + `suffix`),
   由 `dsh-llm-deepseek` 路由到 `${baseURL}/beta/completions`(注意 beta 与正式 base 不同,并沿用适配器现有的凭据解析与 attribution 头)。
   这一步落地后,幽灵补全在插件侧就只剩"provider + 过滤管线 + 该不该补的判据 + 缓存"。
2. **插件自己直连**(不推荐):宿主进程可以 `ctx.get('credentials')` 取同一份凭据直连 `/beta/completions`,
   但会绕开适配器层(用户自配的 `baseURL`/网关不生效)、缺 attribution 头,并把一条"会把代码发出去"的网络路径
   放进插件自己的爆炸半径 —— 而本插件的桥一直是按"最坏情况只泄露编辑器信息"设计的。
3. **chat 兜底**(B6 那套):不动 DSH,接受 ~700ms 与显式触发形态。

> **落地记录(0.3.61)**:采纳了**出路 1 的非改源码版本**(即方案 A)——插件自己 `ctx.llm.registerAdapter(['dshcs-fim'], adapter)`,
> 前缀/后缀走 `dshcs-fim/1 ` 信封进 `messages`,由适配器解出后打 `/beta/completions`。
> 实现:`lib/fim-adapter.mjs`(适配器 + 信封 + 互斥计量 + 速率闸)、宿主 `/complete` 路由与设置项
> (`lib/index.js`)、扩展侧 `lib/fim-completion.js` + 内联补全 provider 与状态栏用量、客户端设置卡那一行。
> 回归:`scripts/test-fim.mjs`(23 条)。默认关、标实验性;用量只在状态栏与 `/status` 的 `fim` 字段可见
> (这条调用不进 DSH 计量,原因见本节)。

## 四、只借鉴(不搬代码)

| 上游 | 字节数 | 借鉴什么 |
|---|---|---|
| `core/context/providers/TerminalContextProvider.ts` | 845 | "最近一条命令 + 它的输出"是 agent 最缺的编辑器官觉;实现要用 VS Code 的 shell 集成 API(先探针,见 C 档) |
| `core/context/providers/DiffContextProvider.ts` | 998 | 把"工作区未提交差异"当上下文;我们这边可以走内置 Git 扩展的 API —— 类型声明可以直接照抄语义:`extensions/vscode/src/otherExtensions/git.d.ts`(12358B,sha `15f48aaa…`),**不必**起 shell |
| `extensions/vscode/src/diff/{vertical/manager.ts 17723B, vertical/handler.ts 19770B, vertical/decorations.ts 5688B, processDiff.ts 3079B}` | — | ①左栏用**带语言的虚拟文档**(我们现在的 `dshcs-old:/<sha256>` 没有扩展名,大概率按纯文本渲染 ⇒ 无高亮,待实测确认);②"文件在观察期间被改动"的处理(对应我们"绝不覆盖未保存改动") |
| `core/edit/lazy/{unifiedDiffApply.ts 5064B, streamLazyApply.ts 4104B, deterministic.ts 12865B}`、`core/tools/implementations/viewDiff.ts` 1362B | — | "先出 unified diff、再落盘"的流程与"模型主动在编辑器里打开某个 diff"的工具形态;我们现在是**先写后审**(闸门在 DSH 授权),所以只留作将来的备选 |
| `core/autocomplete/filtering/test/testCases.ts` 50773B、`lineStream.vitest.ts` 40230B | — | 表驱动用例的写法:搬进我们 `scripts/test-*.mjs` 的补全过滤回归 |
| `core/indexing/{ignore.ts 5454B, shouldIgnore.ts 2012B, continueignore.ts 800B}` | — | 忽略规则语义;将来若要决定"哪些文件可以发给模型",这是现成参照 |
| `packages/terminal-security/src/evaluateTerminalCommandSecurity.ts` 30300B(其测试 60793B) | — | 命令风险分级;C 档前提满足后再谈(见下) |
| `extensions/vscode/src/webviewProtocol.ts` 5694B、`core/protocol/` | — | "协议形状两侧同一份定义";我们已经是这个做法(路由常量 + 两侧同名常量 + 脚本一致性断言),新增路由时沿用自己的写法即可 |
| `extensions/vscode/src/VsCodeIde.ts` 20792B | — | 一份"编辑器能力 → agent 能力"的完整清单,可当**核查表**用(它列出的能力我们哪些还没有) |

## 五、不采用(逐条给理由)

### 5.1 与 DSH 核心重复

- `core/core.ts`(46437B)+ `core/commands/` + `core/llm/` + `core/config/` + `core/tools/**` 全部工具实现
  (`runTerminalCommand` 19479B、`grepSearch` 4111B、`lsTool` 1853B、`editFile`、`multiEdit`、`singleFindAndReplace`…)
  + `core/tools/systemMessageTools/**`(给不支持 function call 的模型走代码块模拟工具调用)
  ⇒ DSH 已有 `dsh-agent-loop`、`dsh-tools`、`dsh-tool-bash/pwsh/fs/fs-search/web/str-replace-editor`。
- `core/context/mcp/{MCPConnection.ts 20767B, MCPManagerSingleton.ts 5707B, MCPOauth.ts 10515B}`、`core/rules.md`、
  `core/promptFiles/`、`skills/`(实测只有 1 个示例:`cn-check/SKILL.md` 5778B)
  ⇒ DSH 有 `dsh-mcp-client`、`dsh-mcp-resources`、`dsh-skill`、`dsh-skill-filesystem`、`dsh-agent-instructions`。
- `packages/{openai-adapters, llm-info, fetch, config-types, config-yaml}` + `extensions/cli` + `packages/continue-sdk`
  ⇒ DSH 有 `dsh-llm` + 适配器(`dsh-llm-deepseek`、`dsh-llm-pi-ai`)+ `dsh-settings`。
- `core/context/providers/**` 里面向外部服务的那些(Jira / GitLab / GitHub Issues / Discord / Postgres /
  Database / Google / URL / Web / Docs / Greptile / Clipboard / OS / DebugLocals)⇒ DSH 有 web 工具、MCP、
  附件与终端;在 IDE 里再实现一遍没有额外价值。
- `core/indexing/**`:`CodebaseIndexer.ts` 26300B、`LanceDbIndex.ts` 15511B、`FullTextSearchCodebaseIndex.ts` 5617B、
  `docs/DocsService.ts` 37958B + `docs/crawlers/ChromiumCrawler.ts` 6954B
  ⇒ 向量库 + 浏览器抓取 + 走树分块,与 DSH 的搜索工具重复,收益不抵依赖。

### 5.2 与硬约束冲突(我们"没有构建步骤、发布物不带前端 bundle、只有一个测试期依赖")

- `gui/`(webview 前端构建产物)、`extensions/vscode/src/{ContinueGUIWebviewViewProvider.ts 5932B, ContinueConsoleWebviewViewProvider.ts 6377B}`
  ⇒ 需要打包器与前端依赖。
- `binary/`(Rust CLI)、`sync/`(Rust crate:`Cargo.lock` 33448B、`src/sync/merkle.rs` 19767B)
  ⇒ 需要 Rust 工具链;而且它是给上游的团队/Hub 同步用的。
- `@continuedev/core@1.1.0` 作为依赖(`core/package.json`,逐字读过)⇒ 它的 `build` 是 `tsc -p tsconfig.npm.json`,
  `dependencies` 里有 `@xenova/transformers`、`onnxruntime-node`、`puppeteer` + `puppeteer-chromium-resolver`、
  `sqlite3`、`vectordb`(LanceDB)、`tree-sitter-wasms`、`web-tree-sitter`、`@aws-sdk/*`、`@octokit/rest`、`pg`、`jsdom` …
  **任何一条都足以否掉它**。
- `extensions/intellij/` ⇒ 我们是 VS Code 树。
- `actions/`(实测:目录里只有 `README.md` 3992B + `general-review/`,是他们的 CI action 定义)、`.github/`、
  `docs/` 与 `docs-site/`(上游的文档源与文档站点)、`manual-testing-sandbox/`、`media/`、
  `BUILD_DEPENDENCIES.md`(9488B)、`CONTRIBUTING.md`(14245B)、
  `TESTING.md`(2461B)、`CLA.md`(2039B)⇒ CI/文档/法务材料,与插件运行无关。
  **顺手更正一处容易想当然的地方:`eval/` 在这个修订上是空的** —— 目录里只有一个 5 字节的 `.gitignore`。
  上游可能曾经有评测集,但当前 `main` 上没有,所以"借他们的数据集评测自己的补全"这条路现在并不存在。

## 六、许可与归属(0.3.63 起**已落地**)

上游 **Apache-2.0**、我们 **MIT**。两条允许组合,但 Apache-2.0 有明确义务。**实际做法(已随包分发)**:

1. **`THIRD_PARTY_NOTICES.md`(新增,已进 `files`)** —— 逐处登记"参考了什么":
   `lib/fim-adapter.mjs` / `assets/extensions/dshcs-editor-bridge/lib/fim-completion.js` 的**设计**
   (停顿去抖、光标附近窗口、过滤/单行化、有界缓存、按文件禁用)与设置项划分对应上游
   `tabAutocompleteOptions` 的 `debounceDelay` / `useAutocompleteMultilineCompletions` / `disableInFiles`;
   并写明上游修订 sha `5522c6f4…`、许可、以及**上游没有 `NOTICE`**(已核对)。
2. **`LICENSE-Apache-2.0.txt`(新增,已进 `files`)** —— 标准 Apache-2.0 全文(11,357 字节,含 §9 与 APPENDIX;
   取自本机依赖 `@jinsiyu/dshcs-kerberos-*` 的 LICENSE,与上游同文同版本,不是抄上游那份文件)。
3. **源码头部标注**:那两个文件的首段注释已写明"**本文件为独立实现,不含 continuedev/continue 的源码**;
   设计参考该项目(Apache-2.0)",并指向 `THIRD_PARTY_NOTICES.md`。本仓库"文件头写清为什么这么写"的风格正好同一处。
4. **事实澄清(重要)**:本次落地**没有逐字复制上游代码** —— 补全走 DeepSeek 官方 FIM(Beta)端点,
   提示词形态由官方文档与本机实测确定;上游那张 FIM 模板表在本机路由上实测不可用(B6)。因此 Apache-2.0 的
   §4(a)"随分发附许可"严格说尚未触发;我们**仍然**把声明与许可文本一并放进包里,这样将来真移植代码片段时,
   义务已经就位(只需再做第 5 条)。
5. **将来移植必须补做的一件事**:**标注被改动的文件** —— 每个移植文件头部写
   `来源: continuedev/continue@<sha> <path> · Apache-2.0 · 已改动`。本文件第 1–2 条已覆盖其余义务。
6. **不含商标授权**:Apache-2.0 不授予商标权 —— 不得用 "Continue" 作为本插件的名字、包名或宣传语。
7. **发布物白名单是独立的一类回归**:新增文件(含 `*.md` / `*.txt`)都要进 `files`,否则用户装到的包里没有它;
   守卫是 `scripts/test-package-files.mjs`(已进 `scripts/run-all-tests.mjs`,并会反向校验幽灵条目)。

## 七、风险与待验证

| 编号 | 内容 | 处置 |
|---|---|---|
| B-R1 | ~~FIM 模板 vs chat 模型~~ **已实测关闭**:FIM 原始模板被当正文(回吐整个文件);指令式正确 | 用指令式提示;B1 那张表只对将来的 FIM 能力模型有意义 |
| B-R3 | ~~延迟地板 ~500–700ms~~ **已更正**:那是 **chat 路由**的地板;原生 FIM 端点 112–416ms(B7) | 自动触发的延迟前提成立;但请求发不出去 ⇒ 见 B-R5 |
| B-R5 | **DSH 词汇表缺口**:`GenerateOptions` 只有 `messages`,`purpose` 是封闭联合 ⇒ 插件无法发 FIM/completions 请求(B7) | 需要 DSH 侧加一条完成能力(或按 B7 出路 2/3 取舍) |
| B-R4 | 假阳性:不该补的位置臆造内容(2/2);曾吐出 `<DSML 控制串>` | 编辑器侧"该不该补"判据 + 过滤管线**剥特殊 token**(升级为硬要求) |
| R2 | diff 左栏 `dshcs-old:/<sha256>` 无扩展名 ⇒ 可能按纯文本渲染(高亮丢失) | **实测确认**(开一次 diff 看语言模式/是否有高亮),再决定是否把原文件名拼进 URI path |
| R3 | 补全要把光标附近代码发给模型 | 默认**关**、显式开关、有界(前后各 ≤ 数 KB)、静止窗口 + 击键取消;开关与上限进设置卡片 |
| B-R2 | 模型调用成本 | ~~与探针一起量~~ 已量:单次输出 25–65 字符(`max_tokens:64` 足够);`temperature:0` 下两次输出逐字相同 ⇒ 相同 prefix/suffix 可稳定命中 LRU |
| C-R1 | 授权卡片看不到命令原文 | 已核实:DSH 的审批事件体只有 `{id, toolName, callId?, reason?}`(`dsh-agent-presets` 的事件声明里 `'approval/asked'` 即此形状),`dsh-tool-bash` 的升级审批只带 `toolName/callId/justification`;我们自己的 `lib/bridge-approval.mjs:172-176` 也记着"审批事件没有 id"这件事。**要用命令风险分级,前提是把 `callId` 关联回 session 的 `tool/call` 参数** |

## 八、路线图(将来动手时按这个顺序)

- **A 档(建议先做,零模型流量)**
  1. 桥新增只读字段:未保存缓冲区正文(有界)、打开文件清单、最近编辑区间;
  2. `lib/bridge-tools.mjs` 新增 `editor_read_open_file` / `editor_symbols`(LSP 符号);
  3. (可选)CodeLens 入口;实测并修 R2 的 diff 左栏高亮;
  4. 回归:`test-bridge-routes` / `test-bridge-extension` / `test-package-files`。
- **B 档(要在 A 档之后;形态已按 B6 实测改写为"显式触发的就地续写")**
  0. **先定路线**:B7(原生 FIM:需要 DSH 侧先开一条 completion 能力;112–416ms,**自动触发可行**)
     还是 B6 兜底(chat + 指令式提示;~700ms、只能显式触发);下面 1–5 对两条路都成立。
  1. 宿主:`lib/autocomplete-prompt.mjs`(B6 走**指令式**提示;B7 走 `prompt`/`suffix` 直传,连模板都不需要)
     + `lib/autocomplete-filter.mjs`(移植 B2 管线并**加特殊 token 剥离**);请求里**显式关思考**;
  2. 桥:新增一条**有界的补全调用**路由,并改写 `lib/bridge.mjs` 文件头的不变量 1(见 B5);
  3. 扩展:注册 inline completion provider,但**只在 `context.triggerKind === Invoke`(手动触发:
     `editor.action.inlineSuggest.trigger`,可绑键位 / 挂 CodeLens)时才真的请求,`Automatic` 一律返回空**
     ⇒ 用户按 Tab 接受、Esc 丢弃,**扩展仍然是只读的**(不写文件、不应用编辑),不破不变量;
     自动触发形态留给"将来接进更快的完成路由"那一天;
  4. "该不该补"的判据放编辑器侧(有选区 / 在注释里 / 括号不平衡 / 文件太大 ⇒ 直接不请求);
  5. 测试:表驱动补全回归(用例写法借鉴上游 `filtering/test`);新文件同步 `package.json` 的 `files`。
- **C 档(不排期,前提未满足)**
  1. 终端读取:先探针 VS Code shell 集成 API 在当前树上的可用性;
  2. 命令风险分级:先解决 C-R1(`callId → tool/call` 关联),再谈移植 `packages/terminal-security`。

## 附录 A · 本文引用的上游文件(可逐条复核)

关键文件的 blob sha(其余文件的字节数与 sha 都可按附录 B 第 4 条逐目录取回):

| 上游路径 | 字节 | blob sha |
|---|---|---|
| `LICENSE` | 11348 | `c25dc1768217ba50d454fcc06290d66886512872` |
| `extensions/vscode/LICENSE.txt` | 548 | `a12f2a758059f459609322351507ffb058a1a2dc` |
| `core/autocomplete/templating/AutocompleteTemplate.ts` | 15318 | `c3c2ccee7192da5abb8379d8c2501b42b41529c6` |
| `core/autocomplete/filtering/streamTransforms/lineStream.ts` | 19249 | `380d568952d793ca12c46bee708c88df6df9d129` |
| `core/autocomplete/filtering/streamTransforms/charStream.ts` | 4925 | `9177a971632e3888bc5f13f456022d7d50cd58fa` |
| `core/autocomplete/filtering/streamTransforms/filterCodeBlock.ts` | 4798 | `d9cb8e8acbeae62be095e07c4e59c8bc6a7d089f` |
| `core/autocomplete/filtering/BracketMatchingService.ts` | 4326 | `da7d38e613139c7decfc16b3ef48b050a7eb842d` |
| `core/autocomplete/constants/AutocompleteLanguageInfo.ts` | 8520 | `1fdbd3e869b972b92f2f980b42c2bc4c0b5335fb` |
| `core/autocomplete/util/AutocompleteLruCache.ts` | 6760 | `5bb637fe6d76be88d4132b9658372e9451f7c184` |
| `core/autocomplete/context/static-context/StaticContextService.ts` | 26686 | `a756abc63cb24922623b5956dd260cee72c19898` |
| `core/context/providers/OpenFilesContextProvider.ts` | 1773 | `afc98ffea27217720c516d1a83df991abdddceea` |
| `core/context/providers/RepoMapContextProvider.ts` | 2148 | `575e7af4b6d7c2f74e7cdf63032f53bba6274367` |
| `core/context/providers/TerminalContextProvider.ts` | 845 | `d0f6e12b365aa42521e71a1b80ddac0d0c784071` |
| `core/context/providers/DiffContextProvider.ts` | 998 | `fae878242b772a9b1d7d0c8c61bd0bde09f19508` |
| `core/tools/definitions/readCurrentlyOpenFile.ts` | 1078 | `87d1adc222c70976f24de5d5e2e296d7c9fad29d` |
| `core/tools/implementations/readCurrentlyOpenFile.ts` | 1141 | `02b7be11433faa96c8067066e97b35de6e1d5662` |
| `extensions/vscode/src/autocomplete/completionProvider.ts` | 26847 | `498f971d05dd032e916461926b57d3f789461489` |
| `extensions/vscode/src/autocomplete/RecentlyVisitedRangesService.ts` | 3570 | `3e9502c94e37d6802bf9342a83b7c58119123712` |
| `extensions/vscode/src/autocomplete/recentlyEdited.ts` | 5064 | `25791ffa19994e34c7a1110d41567273c63a5e79` |
| `extensions/vscode/src/diff/vertical/manager.ts` | 17723 | `059efe0aee408e45696cfde60e83e94a1fbf9ba2` |
| `extensions/vscode/src/lang-server/codeLens/providers/QuickActionsCodeLensProvider.ts` | 4153 | `7b802648d86e0cdb8b45fa4ac9932df46fa80bab` |
| `extensions/vscode/src/otherExtensions/git.d.ts` | 12358 | `15f48aaa4e72301973343c6293231cbf780792d4` |
| `core/indexing/LanceDbIndex.ts` | 15511 | `e01518629a92ca8a345dcca0049fdfe36ab6e80a` |
| `packages/terminal-security/src/evaluateTerminalCommandSecurity.ts` | 30300 | `693eef25f9cfeba43f2cb7a2e39d3f132fc2e983` |

## 附录 B · 复核方式

本机 `raw.githubusercontent.com` 的 SSL 不通,但 `api.github.com` 可用(浏览器里 raw 页面可正常打开、可读)。
GitHub 的 contents API 对文件返回 base64(不便阅读),所以上面的事实是这样取的:

```powershell
# 1) 仓库元信息与许可
#    → license.spdx_id = apache-2.0,default_branch = main,size = 872398
Invoke-RestMethod https://api.github.com/repos/continuedev/continue | Select-Object license,default_branch,size

# 2) 上游修订(本文钉的就是这个 sha)
#    → 5522c6f44ca0ac3528b37244818fbfa39b5af470
Invoke-RestMethod https://api.github.com/repos/continuedev/continue/git/ref/heads/main

# 3) 根目录清单(git trees API 比 contents API 紧凑;可核对"没有 NOTICE")
Invoke-RestMethod 'https://api.github.com/repos/continuedev/continue/git/trees/5522c6f44ca0ac3528b37244818fbfa39b5af470'

# 4) 逐目录文件清单 + 字节数 + blob sha(本文所有 size/sha 都出自这里)
#    core/autocomplete、core/context、core/tools、core/edit、core/indexing、core/diff、
#    extensions/vscode/src 及其 autocomplete/diff/lang-server/util/otherExtensions、
#    packages/terminal-security、sync、skills —— 用 trees/<目录 sha>?recursive=1
```

要**读正文**时(例如核对 `AutocompleteTemplate.ts` 里到底有没有指令式兜底、
`extensions/vscode/LICENSE.txt` 的逐字正文),用浏览器打开 raw 地址即可:

```
https://raw.githubusercontent.com/continuedev/continue/main/<path>
```

DSH 侧的对照物(本机):

| 事实 | 位置 |
|---|---|
| `ctx.llm.stream({provider, model, messages, temperature/maxTokens/stop})`、`llm/stream` waterfall | `@deepseek-ai/dsh-llm` 的 `README.md` 与 `lib/types/index.d.ts` |
| 默认模型 `ctx.agentDefaultModel.currentSelection()` → `{provider, model, reasoningEffort?}`;设置命名空间 `agent-default-model` | `@deepseek-ai/dsh-agent-default-model/lib/types/index.d.ts` |
| 审批事件体只有 `{id, toolName, callId?, reason?}`;bash 升级审批只带 `toolName/callId/justification` | `@deepseek-ai/dsh-agent-presets/lib/typert.host.js` 的 `'approval/asked'` 声明、`@deepseek-ai/dsh-tool-bash/lib/index.js`(约 250–290 行) |
| 桥的四条只读路由与安全不变量 | `lib/bridge.mjs` 文件头 + `lib/bridge-ipc.mjs` |
| 现有两个编辑器工具与提示词段落 | `lib/bridge-tools.mjs` |
| diff 左栏的虚拟文档与缓存 | `assets/extensions/dshcs-editor-bridge/extension.js`(第 61–86、280–343 行) |
