# 第三方声明(Third-Party Notices)

本项目 `dsh-code-server-app` 自身以 **MIT** 许可发布(见 [`LICENSE`](LICENSE))。
在开发过程中**参考**过下列第三方开源项目,本文件登记参考范围、许可与本项目的处理方式。

---

## continuedev/continue —— Apache License 2.0

| 项 | 值 |
|---|---|
| 上游 | https://github.com/continuedev/continue |
| 参考时修订 | `5522c6f44ca0ac3528b37244818fbfa39b5af470`(`refs/heads/main`,2026-09-21 取) |
| 许可 | **Apache License 2.0**,Copyright 2023 Continue |
| 上游 `NOTICE` | **没有**(已核对根目录清单;将来若出现,按 Apache-2.0 一并保留) |
| 许可全文 | [`LICENSE-Apache-2.0.txt`](LICENSE-Apache-2.0.txt)(标准 Apache-2.0 文本,11,357 字节,含 §9 与 APPENDIX) |

### 参考了什么(逐处登记)

| 本项目位置 | 参考内容 | 是否含上游代码 |
|---|---|---|
| `lib/fim-adapter.mjs`、`assets/extensions/dshcs-editor-bridge/lib/fim-completion.js` | 实验性 **FIM(幽灵)补全**的**设计**:停顿去抖、只送光标附近的窗口、结果过滤与单行化、有界缓存、按文件禁用;以及**设置项划分**(对应上游 `tabAutocompleteOptions` 的 `debounceDelay` / `useAutocompleteMultilineCompletions` / `disableInFiles`) | **否**,独立实现 |
| `lib/index.js`、`lib/client.js`、`assets/extensions/dshcs-editor-bridge/extension.js` | 上述设计在本插件内的接线(桥的第五条路由、设置卡三行、内联补全 provider) | 否 |
| `docs/analysis-continuedev-reuse.md` | 对上游模块的**事实性描述与判定**(路径、字节数、blob sha、用途) | 否(事实与评述) |

**本项目的全部源码均为独立编写,不含 continuedev/continue 的任何源码片段、模板字符串或整份文件。**
补全请求走的是 DeepSeek 官方的 FIM(Beta)端点(`POST https://api.deepseek.com/beta/completions`,
参数 `prompt` + `suffix`),提示词形态由该官方文档与本机实测确定,与上游的 FIM 模板表无关
(那张表在本机路由上实测不可用,见 `docs/analysis-continuedev-reuse.md` 的 B6)。

### 将来若要移植上游代码片段,按 Apache-2.0 必须做到

1. **标注被改动的文件**:在每个移植文件头部写明 `来源: continuedev/continue@<sha> <path> · Apache-2.0 · 已改动`;
2. **保留版权与许可声明**:本文件 + `LICENSE-Apache-2.0.txt` 已经随包分发,移植时无需新增文件;
3. **上游 `NOTICE` 若出现则一并保留**;
4. **不含商标授权**:Apache-2.0 不授予商标权 —— 不得用 "Continue" 作为本项目的名称、包名或宣传语。

---

## 随包分发的第三方依赖

本包依赖的第三方包(`@jinsiyu/dshcs-*`、`@vscode/*`、`@xterm/*`、`zod` 等)各自带有许可与声明文件,
随 `node_modules` 一并分发,不在此重复登记;内嵌的 VS Code 树自带 `ThirdPartyNotices.txt`。

---

## English summary

`dsh-code-server-app` is MIT-licensed (see `LICENSE`). Its experimental **FIM completion** feature was
**designed with reference to** [continuedev/continue](https://github.com/continuedev/continue)
(Apache License 2.0, Copyright 2023 Continue) — specifically the settings taxonomy of upstream
`tabAutocompleteOptions` (`debounceDelay`, `useAutocompleteMultilineCompletions`, `disableInFiles`) and its
debounce / cursor-window / filter / bounded-cache approach.

**No source code, template strings, or files from continuedev/continue are included in this project**;
every implementation here is independently written, and the completion requests target DeepSeek's official
FIM (Beta) endpoint as documented by DeepSeek. The standard Apache License 2.0 text ships as
`LICENSE-Apache-2.0.txt` so that Apache-2.0's obligations (notices, marking modified files, preserving an
upstream `NOTICE` if one appears) are already satisfied should a code fragment ever be ported in.
Apache-2.0 grants no trademark rights: "Continue" must not be used as this project's name or in its promotion.
