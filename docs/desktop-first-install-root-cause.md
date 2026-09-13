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
