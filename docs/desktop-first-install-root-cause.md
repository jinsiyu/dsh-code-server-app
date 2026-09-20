# desktop 官方安装「第一次报 requires missing」——实测根因(2026-09-13)

> 结论:**不是我们包结构的问题,也不是注册表/24h 策略问题**;是 dsh-desktop 在
> `pnpm add`(增量、hoisted)**之后立刻做依赖图校验**,而 pnpm 的这次增量安装只链上了
> 聚合包 16 个别名目标中的 7 个。校验器报出的 `@microsoft/mxc-sdk` 只是**依赖表里排第一的
> 那个牺牲品**。重启后应用走「完整重装」路径,16 个全部就位 ⇒ 「重启就自己装好了」。
>
> **因此 `docs/plan-mxc-sdk-into-tree.md`(方案 A)不足以修复此问题**:把 mxc-sdk 搬进树包,
> 报错只会换成下一个牺牲品 `@parcel/watcher`。

## 一、复现(用 desktop 应用自带 node/pnpm,逐字复刻它的命令)

```powershell
$node = 'C:\Users\User\Desktop\harness\deepseek-harness\apps\desktop\.desktop-build\targets\win-arm64\artifacts\win-arm64-unpacked\resources\runtime\node\node.exe'
$pnpm = '...\resources\runtime\pnpm\bin\pnpm.cjs'          # pnpm 11.7.0
$d    = "$env:USERPROFILE\.dsh\desktop\pnpm"
$env:XDG_CACHE_HOME="$d\cache"; $env:XDG_CONFIG_HOME="$d\config"; $env:XDG_STATE_HOME="$d\state"
# .spike/repro-agg/ = desktop 新建 profile 的等价物(package.json + pnpm-workspace.yaml 逐字照抄)
& $node $pnpm --config.registry=https://registry.npmjs.org/ --config.store-dir="$d\store" `
  --config.enable-global-virtual-store=false --config.userconfig=<repro>\pnpmrc `
  add dsh-code-server-app@0.3.44 --save-exact --ignore-scripts
node .spike/repro-agg/probe.mjs .spike/repro-agg     # 复刻校验器的 packageFrom()
```

`probe.mjs` 逐字复刻 `apps/desktop/src/profile-packages.ts` 的 `packageFrom()`:
`createRequire(<聚合包>/package.json).resolve.paths(name)` → 逐个候选目录查 `<dir>/<name>/package.json`。

**实测结果(联网、离线各跑一次,结果完全一致)**:

```
MISS @microsoft/mxc-sdk          ← 校验器报的就是这一条(依赖表里排第一)
MISS @parcel/watcher
OK   @vscode/deviceid            -> <聚合包>/node_modules/@vscode/deviceid
MISS @vscode/fs-copyfile
OK   @vscode/native-watchdog     ...
MISS @vscode/proxy-agent
OK   @vscode/spdlog / sqlite3
MISS @vscode/windows-ca-certs
OK   @vscode/windows-process-tree / windows-registry
MISS cpu-features
OK   kerberos
MISS node-pty / ssh2 / koffi
-- 16 declared, 9 missing
```

pnpm 自己的账本 `node_modules/.modules.yaml` 的 `skipped` 列表(增量安装后 73 条)里,
这 9 个全在,并连带它们的传递依赖(`nan` / `nodecheck` / `node-addon-api@8.9.2` / `undici` / …)
一起被标记,而 x64 平台包本来就该在这台 arm64 机器上被跳过。

**完整安装则全部就位**(这就是「重启自愈」那一步):

```powershell
Remove-Item <repro>\node_modules -Recurse -Force
& $node $pnpm ... install --frozen-lockfile --ignore-scripts   # 8.5s,added 106
node .spike/repro-agg/probe.mjs <repro>
# -- 16 declared, 0 missing        (且全部拍平到 profile 根,聚合包下的嵌套 node_modules 消失)
```

对照实验(定位触发面):

| 实验 | 结构 | 结果 |
| --- | --- | --- |
| repro-agg | root → plugin(dep) → 聚合包(**optional**,depth 1) → 16 别名(depth 2) | **9 missing** = 用户看到的错误 |
| repro-agg2 | 同上,联网 | 9 missing(排除 `--offline` 干扰) |
| repro-agg3 | root → 聚合包(depth 0,optional),只声明 arm64 | 0 missing |
| repro-agg4 | root → 两个聚合包(depth 0,optional) | 0 missing |
| repro-direct | root → 3 个真名包(depth 0,`--save-exact --ignore-scripts`) | 全部装上 |

⇒ 丢包只发生在 **depth ≥ 2 且父节点是 optional 子树** 时;真名直接依赖(depth 0/1)不受影响。

## 二、为什么「重启就好了」

`apps/desktop/src/project-manager.ts`:

- `mutate()`:改包前 `unlinkDesktopHostPackages()` → `applyMutation()`(`pnpm add … --save-exact --ignore-scripts`)
  → `reconcileProfile(…, packagesChanged=true)`;
- `reconcileProfile()`:第 371 行 `rebuild = (!packagesChanged && existsSync(pendingPackages)) || …`
  ⇒ 本次 `packagesChanged=true` ⇒ **rebuild=false** ⇒ 不做完整重装;
- `finishPackageOperation()`:第 385 行第一个动作就是 `prepareProfile()` → `validateDesktopPluginGraph()`
  ⇒ **在增量安装的残缺 node_modules 上校验 ⇒ 抛错**(错误文本与用户截图逐字一致);
- `runPnpm()` 会先写 `<profile>/desktop-packages-pending`,只有 `finishPackageOperation()` 末尾才删
  ⇒ 校验失败时该标记**残留**;
- 重启:第 326 行的快速返回条件不成立(标记在)⇒ `rebuild=true` ⇒
  第 377-378 行 **删掉整个 node_modules + `pnpm install --frozen-lockfile`** ⇒ 16 个全部就位 ⇒ 校验通过。

## 三、修法(两条路,需要选一条)

**① dsh-desktop 侧(根因,改动最小)** —— 让改包的 mutation 也走完整安装:
`reconcileProfile()` 里把 `rebuild` 在 `packagesChanged` 时置真(即复用第 377-378 行那条已被验证的路径),
或在第一次 `prepareProfile()` 之前补一次完整 `install`。代价:add/remove/update 各多一次全量重装
(实测 8.5s,store 已热)。收益:修掉**所有**「optional 子树里带 npm: 别名」的第三方插件,
不只我们这一家。

**② 我们这边(在已发布的 desktop 应用上也能装上)** —— 让依赖不再落在 optional 子树里:
把聚合包的别名表去掉,16 个重打包包改成插件自己的直接依赖(平台无关的 8 个 → `dependencies` 真名;
平台专属的 8 个 → `optionalDependencies` 真名 + 包自带 os/cpu),原名的目录链继续由
`lib/native.js` 的 junction 机制补(`ensureAliasLinks` 需要一张 alias→真名 映射表)。
代价:改 `scripts/vendor-repacks.mjs` + `lib/native.js`(+ 设置页/envCheck 文案与测试),
重发插件(重打包包本身不用重发)。**只搬 mxc-sdk 不行**(见开头的 9 条 MISS)。

实测依据:真名直接依赖在同一套 `--ignore-scripts` 设置下 100% 装上(repro-direct);
os/cpu 不匹配的 optional 真名依赖会被 pnpm 跳过,而校验器对 `optionalDependencies` 缺失是放行的
(`profile-packages.ts:219` `if (target === undefined && optional) continue`)。

## 四、复现脚本

`.spike/repro-agg/`(package.json / pnpm-workspace.yaml 逐字照抄 desktop profile)
+ `.spike/repro-agg/probe.mjs`(复刻 `packageFrom()`)。
`.spike/` 是工作区里的脚手架目录,不进发布物;上面的实验目录(repro-agg2/3/4/5、repro-direct)
可以删掉,只留 repro-agg 复现用。

## 五、0.3.45 的残留 +「has no manifest」卡死态(0.3.46 修,2026-09-15)

用户报的错:**`desktop project: installed package "dsh-code-server-app" has no manifest`**。
查下来是**两个独立故障**,都实测复现过:

### 5.1 0.3.45 仍丢包,只是丢到了下一层(平台专属包自己的依赖)

0.3.45 把 8 个平台专属重打包包放进插件 `optionalDependencies`(depth 1,optional)。
它们的**注册表依赖**落在 depth 2、父节点是 optional ⇒ 仍被 pnpm 的增量 hoisted 安装整支丢进
`node_modules/.modules.yaml` 的 `skipped`。在 win32-arm64 上实测首次 `pnpm add` 后仍缺:

```
@jinsiyu/dshcs-kerberos-win32-arm64   -> bindings@^1.5.0     MISSING(运行时 index.js 里 require('bindings'))
@jinsiyu/dshcs-vscode-spdlog-win32-arm64 -> bindings / mkdirp@^1.0.4  MISSING
@jinsiyu/dshcs-vscode-deviceid-win32-arm64 -> fs-extra@^11.2.0 / uuid@^14.0.0  MISSING
```

⇒ dsh-desktop 装完立刻校验,报
`desktop profile: dsh-code-server-app -> @jinsiyu/dshcs-kerberos-win32-arm64 requires missing bindings@^1.5.0`,
profile 停在「已声明依赖 + 校验失败」的半装状态。

**与 0.3.44 那次的区别**:这次 `pnpm install --frozen-lockfile` 会打印 «Already up to date» 并退出 0
(锁文件里也没有这些条目),**修不好**;只有「删掉整个 node_modules + 全量 frozen 安装」才能补齐
(实测 7s,blocking 问题 5 → 0)。所以「重启自愈」这条退路在这一层只剩一半。

### 5.2 「has no manifest」是怎么冒出来的(卡死态,不自愈)

`project-manager.ts` 里 `inspectPlugin()`(第 200 行)对「声明了依赖但
`<profile>/node_modules/<name>/package.json` 不存在」是**硬失败**,而 `pluginRecords()` 会在这些地方
被**提前求值**:

- `listPlugins()`(第 240 行)⇒ 插件页渲染;
- `reconcileProfile()` 的 `rebuild` 表达式(第 365 行 `pluginRecords(projectDir).length > 0`)⇒ **应用启动**就抛,
  而且是在任何修复动作**之前**;
- `plugin-remove` / `plugin-update` / `plugin-toggle`(第 405/418/427 行)。

于是只要 profile 里留着一条「声明在、目录没了」的依赖(装到一半被关掉、校验失败后又被
`removeOwnedDirectory(node_modules)` 清过、或手工删过),插件页/启动/卸载任何一步都会显示
**installed package "dsh-code-server-app" has no manifest**,且**永远不会自愈**。

实测(用桌面版自己的源码跑,`node --experimental-transform-types`):

```
listPlugins() (插件页渲染)              -> THROW installed package "dsh-code-server-app" has no manifest
applyRelease() (应用启动,同一 profile)  -> THROW 同一句
```

### 5.3 0.3.46 的修法

平台专属包的注册表依赖**提成插件自己的直接依赖**(depth 0 ⇒ 落到 profile 根 `node_modules`,
校验器与运行时都能解析到):

```jsonc
// package.json
"bindings": "1.5.0", "mkdirp": "1.0.4", "fs-extra": "11.4.0", "uuid": "14.0.2"
```

- `scripts/vendor-repacks.mjs` 里是 `OPTIONAL_SUBTREE_DEPS` 表,写依赖表时自动并入;
- 新增 `verifyOptionalSubtreeDeps()`:**构建期闸门** —— 平台专属重打包清单里出现不在表内的注册表依赖
  就直接报错(避免将来又静默丢包);
- `scripts/test-vendored-table.mjs` 加回归(从 `repack/build/<平台包>/package.json` 反查,断言每个
  非 `npm:` 别名依赖都在插件 `dependencies` 里)。

验收(全新 profile + 桌面版自带 node/pnpm 逐字复刻 `pnpm add`,再跑桌面版自己的
`validateDesktopPluginGraph`):

```
exit=0, node_modules/dsh-code-server-app/package.json 存在(0.3.46)
VALIDATOR: PASS        ⇐ dsh-desktop 会接受这个 profile
完整图 probe: visited 109, blocking 0
kerberos-arm64 / spdlog-arm64 / deviceid-arm64 三个锚点都能解析到 bindings / mkdirp / uuid
```

### 5.4 桌面侧仍建议修(没变,同第三节 ①)

1. `reconcileProfile()` 在 `packagesChanged` 时也走一次完整安装(否则 mutation 永远在增量树上校验);
2. `pluginRecords()` 不要放进 `rebuild` 表达式的求值链,或把「声明在、目录没了」当成 `rebuild=true` 的
   触发条件(现在它是硬失败 ⇒ 卡死);
3. 报错文案带上「请删掉 `<profile>/node_modules` 后重试」,别只给一句 has no manifest。

### 5.5 profile 卡死时的手工恢复

```powershell
# 关掉 DSH Desktop 后:
Remove-Item "$env:USERPROFILE\.dsh\profiles\desktop\desktop-packages-pending" -Force  # 清掉未完成标记
Remove-Item "$env:USERPROFILE\.dsh\profiles\desktop\node_modules" -Recurse -Force      # 让下次启动全量重装
# 重启应用:会走「删 node_modules + pnpm install --frozen-lockfile」⇒ 依赖补齐、校验通过
```
(profile 里若残留一条「声明在、目录没了」的依赖,也可以直接把该条从
`~/.dsh/profiles/desktop/package.json` 的 `dependencies` 里删掉再重启。)
