# 分析:其他开源工具的幽灵补全都是怎么实现的(提示词形态 / 窗口 / 缓存)

> 触发问题:我们的 FIM 走"窗口滑动"时,DeepSeek 的 prompt cache 命中率掉到 **0%**
> (实测 2026-09-21:同 prompt 二次调用 89%;后缀变 89%;窗口滑 200 字符 **0%**;滑 1 字符 **0%**)。
> 于是要问:流行的开源工具是怎么处理这件事的?
>
> 姊妹文档:`docs/analysis-continuedev-reuse.md`(Continue 复用评估;B3/B6/B7 三节与本篇直接相关)。
>
> **一句话结论**:没有任何一个客户端项目试图让 prompt 在滑动时保持 KV 前缀稳定 ——
> 它们要么接受重算(Continue、Tabby),要么把复用**下移到推理服务端**(llama.cpp、vLLM/SGLang)。
> 唯一被普遍采用的**客户端**优化是"**缓存答案**"而不是"省 prefill":Continue 用前缀键的 LRU,
> Cody 用"热 streak"。**这一块我们目前没有**(我们是精确键,打字前进一步就必然 miss)。

---

## 一、逐项目事实

标注规则:**"读到"** = 本次会话实际取到并读过内容(给出文件/章节);
**"指针级"** = 只确认了官方文档/PR 存在,正文被工具链截断,未逐字核对;
**"未核实"** = 没拿到,只有文件名之类的间接线索,不作为结论依据。

### 1.1 Continue(continuedev/continue)—— 前缀键的结果缓存

**读到**:`core/autocomplete/lruCache.ts`、`core/config/sharedConfig.ts`(全文)、
`core/autocomplete/*` 目录清单(见姊妹文档附录 A)。上游修订 `5522c6f4`。

- `AutocompleteLruCache`:**SQLite 持久化**的 LRU,容量 **1000** 条,
  `flushInterval` **30000 ms**,**键 = prefix,值 = completion**,源码注释说明
  "Supports prefix matching"。
- 用户开关:`useAutocompleteCache` → 传给扩展的 `tabAutocompleteOptions.useCache`。
- 同一份配置里还有:`useAutocompleteMultilineCompletions`(`always|never|auto`)、
  `disableAutocompleteInFiles`(glob 列表)、`modelTimeout`、`debounceDelay`。
- **另有一个专门的复用组件**:`generation/GeneratorReuseManager.ts`(2598 B,
  见姊妹文档附录 A 的文件清单)—— 名字即用途:"同一次生成的结果复用"。
  **注意**:这个文件我只拿到文件清单级证据(大小 + blob sha),**没读过内容**,
  所以不描述它的具体算法;但它与 `AutocompleteLruCache` 一起说明
  "复用已生成的补全"在 Continue 里是**独立于 KV/prefix cache 的一等模块**。

**它是怎么用这个缓存的**:键是 prefix 而不是"prefix+suffix 的精确哈希",
配合"supports prefix matching",语义就是"**用户沿着同一个上下文继续往下打字时,
命中我们已经回答过的那个补全**"。注意它是**客户端结果缓存**,与 KV/prefix cache 无关:
省掉的是**整个请求**,不是 prefill。

**它不为 KV 稳定性做任何 prompt 整形**:模板(`constructPrompt`)按模型给 FIM 形态,
窗口有界,滑动就滑动 —— 和我们的选择一致。

### 1.2 Cody(sourcegraph/cody,公开快照 PR #2881)—— 超时分段 + "热 streak"

**读到**:PR #2881 的描述文本(含引号原文)。

- **异步流式 + 超时**:一旦拿到**一个完整行**,就**立刻**作为单行补全插入;
  剩下的继续在**后台流式**跑,跑完升级成多行补全。—— 一次请求、两段呈现,
  用户不必为一个长补全等到尾。
- 多行补全完成后**进缓存**,"for instant access if the user continues typing as suggested"
  —— 也就是**用户顺着建议往下打字时**该结果可直接复用(业界口语叫"热 streak")。
- 同一 PR 还统一了缩进处理与"插入文档"的逻辑。

**两个我们都没有的点**:(a) 长补全的**渐进呈现**;(b) 面向"用户顺着补全往下打"的**前向复用**。
(b) 和 Continue 的前缀 LRU 是同一个思想的两个实现。

### 1.3 Tabby(TabbyML/tabby)—— 有界窗口 + **保留尾部** + 按语言 stop words

**读到**:`crates/tabby-inference/src/code.rs`(全文,3570 B)。

- `CodeGenerationOptions { max_input_length: 1024, max_decoding_tokens: 256,
  sampling_temperature: 0.1, seed, language, mode }`。
- `clip_prompt(prompt, max_input_length)`,源码注释原文:
  "Clip prompt by options.max_input_length (**truncate from beginning**)"。
  **从开头截 ⇒ 保留靠近光标的尾部** —— 与我们的 `trimWindow` **同一方向**。
  它的默认预算是 **1024 token**,远小于我们的 6000 字符(≈2.3k token)。
- 停止条件:`StopConditionFactory` 组装**按语言**的 stop,外加模型级
  `additional_stop_words: Vec<String>`;流式输出在 stop 处截断。
- `mode == "next_edit_suggestion"` 走**另一条非流式**路径(`generate_sync`) —— 它也有 next-edit。
- 自建推理服务端,所以"滑动导致重算"这件事是**它自己的服务端**问题(见 1.4)。

### 1.4 llama.cpp(ggml-org/llama.cpp)—— 服务端**非前缀**复用(把问题解在 KV 层)

**读到**:PR #9866 "server : reuse context chunks" 的描述与参数语义。

- `llama-server --cache-reuse N`:在 prompt 里找长度 ≥ N 的**相同片段**,
  通过 **`llama_kv_cache_seq_add()` 平移它们的 KV 位置**来复用 —— 于是**滑动窗口不必整体重算**。
  需要请求里带 `"cache_prompt": true`。
- 档位:`--cache-reuse 0` = 只做前缀复用;**1** = 任意匹配片段都复用;
  **3** = 更高阈值、更粗的子集。

**这是行业里对"滑窗毁复用"的正面回答,但它在服务端。** 客户端照旧滑动,
服务端把 KV 记账做复杂。—— 托管 API(DeepSeek)不给这个旋钮,
所以我们实测到的"滑 200 字符 = 0%"是**托管服务的性质**,不是我们设计错了。

### 1.5 vLLM / SGLang —— 指针级(未逐字核对)

两个项目都提供**自动前缀缓存**作为一等服务端特性;我确认了官方文档页存在
([vLLM latest](https://docs.vllm.ai/en/latest/design/prefix_caching/)、
[v0.8.4](https://docs.vllm.ai/en/v0.8.4/design/automatic_prefix_caching.html)、
[中文镜像](https://docs.vllm.com.cn/en/latest/design/prefix_caching/)),
但**正文被我的抓取工具截断**,所以这里不写实现细节(块级哈希之类的说法未经我核对)。
搜索还命中一个 SGLang PR 的片段
([#30722](https://github.com/sgl-project/sglang/pull/30722/files/4bc3c9c19332ba94eaa1d504ba0b3d3633ab6298)),
其中出现 `reprefill_tail = tree_cache`,像是"部分命中时只重算尾部"的路径 —— 同样在服务端。

**能确定的只有一件事**:前缀复用在这些项目里是**服务端**特性,粒度比"整段前缀"细。
客户端怎么摆 prompt,只决定**能命中多少**,不决定服务端有没有这个能力。

### 1.6 Zed —— 未核实

`crates/zeta_prompt/src/zeta_prompt.rs` 有 **243430 B**,超出我这边可读范围;
同目录只有文件名可供参考:`excerpt_ranges.rs`(14697 B)、`hashed_regions.rs`(48061 B)、
`multi_region.rs`(62585 B)、`udiff.rs`(47268 B)。
从名字看像"多段 excerpt + 区域哈希 + diff 驱动编辑",但**我没读到内容,不作为依据**。

---

## 二、横切对比

| 维度 | Continue | Cody | Tabby | llama.cpp / vLLM / SGLang |
| --- | --- | --- | --- | --- |
| 窗口 | 有界(按模型模板 + trim) | 有界(excerpt) | **有界 1024 tok,从开头截→留尾部** | 不关心 |
| prompt 形态 | 按模型的 FIM 模板 | FIM / excerpt | FIM 模板 + stop words | 任意 |
| 长补全呈现 | 一次性 | **先给第一行,后台补齐多行** | 流式 + stop 截断 | — |
| **结果缓存** | ✅ 前缀键 SQLite LRU(1000) | ✅ 热 streak | ✗ | ✗ |
| 按 glob 禁用 | ✅ `disableAutocompleteInFiles` | — | — | — |
| 多行开关 | ✅ `always/never/auto` | 自动 | — | — |
| 为 KV 稳定而整形 prompt | ✗ | ✗ | ✗ | ✗(复用交给服务端) |
| KV 复用归谁 | 不处理 | 不处理 | 不处理(自建时可开) | ✅ **服务端块/树级** |

**三条共识**:

1. **窗口一定有界,且都留尾部**(Tabby 明确"truncate from beginning")—— 我们 6000/2000 字符
   的双侧预算与"留尾部"方向正确,只是比 Tabby 宽。
2. **没有客户端项目为 KV 前缀稳定去改 prompt 形态**。滑动就是滑动,重算就重算。
3. **能省请求就省请求**:真正被产品化的是"结果缓存 + 前向复用"(Continue、Cody),
   不是"prefill 省钱"。

---

## 三、给我们项目的建议(按 收益/成本 排序)

现状:`lib/fim-adapter.mjs`(宿主侧:窗口、限流、单飞)+
`assets/extensions/dshcs-editor-bridge/lib/fim-completion.js` 的 `createCompletionCache`
(**max 24 / TTL 120 s / 严格精确键**:`fingerprint(窗口化 prompt, suffix, language)`)。
因为键含**窗口化之后**的文本,文件一旦超过窗口,每敲一个字符键都会变 ——
和 prompt cache 一样,滑窗时必然 miss。

1. **【建议做】把结果缓存从"精确键"改成"前向可复用"**(借 Continue 的前缀语义 + Cody 的热 streak)。
   做法:命中查找时,除了精确键,再尝试"**本请求的窗口化 prompt 以某个已存条目为前缀**"
   (反向也成立:用户按退格回退到已答过的位置)。命中则返回该补全**去掉已经打进去的那段**之后的剩余。
   收益:打字过程中反复发请求的问题被直接消掉,且**不需要模型配合、不需要 DSH 改词表**。
   成本:纯客户端改动 + 可测(现有 `scripts/test-fim.mjs` 已有缓存测试骨架)。
   **注意**:`suffix` 也参与语义,前向复用时 suffix 已经变了,所以要限定
   "只复用**多行/明确以换行结束**的补全"或"被复用部分的长度远大于后续 diff",否则会给出错补全。
   —— 这一条**必须先做实测**再落地(见第四节)。
2. **【备选】Cody 的渐进呈现**:先给第一行、后台补多行。我们目前**非流式**、`max_tokens=128`、
   4 s 超时,而实测 FIM 延迟只有 **112–416 ms**,所以现在收益有限;
   只有当"允许多行"打开且长补全明显变慢时才值得做。
   前置未知:**DeepSeek 的 `/beta/completions` 是否支持 `stream`** —— 未测,别先假设。
3. **【备选】Tabby 的按语言 stop words**:我们现在**不发 stop**(依赖端点自然停止,4/4 实测),
   且有 2000 字符硬截断兜底。Tabby 的做法更可移植。换模型或出现啰嗦输出时再加。
4. **【不建议改】窗口大小**:Tabby 默认 1024 token 比我们小,但**窗口越大 → 触发裁剪的文件越少
   → 前缀锚点越稳(缓存越友好)**;我们单次成本很低(≤2.3k token)。
   维持 6000/2000 字符。
5. **【不做】不要为了 KV 命中率去优化 prompt 形态**。托管 API 不给我们 `--cache-reuse`
   这类旋钮(1.4/1.5),在客户端折腾形态对命中率没有可测量的帮助。

---

## 四、待实测(落地第 1 条之前)

- [ ] 前向复用导致的**错补全率**:构造"打一个字后复用缓存"的场景,统计补全是否仍然正确。
- [ ] 复用时的**延迟收益**:命中缓存 vs 发一次真请求(实测 FIM 为 112–416 ms,
      所以"省一次请求"的收益量级就是几百毫秒 + 一次限流额度)。
- [ ] **限流交互**:宿主侧 `createFimBudget`(120 ms 最小间隔 / 1 并发 / 60 次每分钟)下,
      缓存命中率对 `callsLastMinute` 的实际影响。
- [ ] `/beta/completions` 是否支持 `stream`(为备选第 2 条铺路)。

---

## 附录 · 本篇的取证边界

| 项目 | 取证方式 | 置信度 |
| --- | --- | --- |
| Continue | 读源码文件(见姊妹文档附录 A,钉 sha `5522c6f4`);`GeneratorReuseManager` 仅文件清单级 | 高(除已注明处) |
| Cody | 读 PR #2881 描述文本(含直接引用) | 中高(PR 描述,非源码) |
| Tabby | 读 `crates/tabby-inference/src/code.rs` 全文 | 高 |
| llama.cpp | 读 PR #9866 描述与参数语义 | 中高(PR 描述,非源码) |
| vLLM / SGLang | 仅确认官方文档页/PR 存在,**正文未读到** | **低 —— 只作方向指针** |
| Zed | 仅拿到文件清单与字节数 | **无 —— 不作依据** |

凡上表置信度 ≤ 中高的,都只用于"行业大致怎么做"的定性判断,
**不用于任何具体数值或实现细节的断言**。
