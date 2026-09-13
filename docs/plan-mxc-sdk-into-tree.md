# 计划:mxc-sdk 搬进"树包",聚合包不再用 `npm:` 别名(方案 A)

> **状态:已作废(2026-09-13 实测推翻),不要按本文实施。**
> 用 desktop 自带 pnpm 逐字复刻 `pnpm add` 后测得:聚合包 16 个别名目标里有 **9 个没被链上**
> (mxc-sdk 只是依赖表里排第一的那个),它们的传递依赖也一起被 pnpm 标成 `skipped`;
> 完整重装才会全部就位。所以只搬 mxc-sdk,报错只会换成 `@parcel/watcher`。
> 根因、复现命令与两条修法见 **`docs/desktop-first-install-root-cause.md`**。
>
> 状态:**未执行**,待新一轮实施。目标是把 desktop 官方安装报的那条错根除掉:
> `desktop profile: dsh-code-server-app -> @jinsiyu/dsh-code-server-runtime-win32-arm64 requires missing @microsoft/mxc-sdk@npm:@jinsiyu/dshcs-microsoft-mxc-sdk@0.8.0`

## 一、依据(都已实测,不是推断)

1. **运行期布局**(web profile 实测):
   - `<profile>/node_modules/@jinsiyu/dshcs-microsoft-mxc-sdk` ← 真包(pnpm 按别名目标安装);
   - `<profile>/node_modules/@jinsiyu/dshcs-vscode-server/vscode/lib/vscode/node_modules/@microsoft/mxc-sdk`
     ← **我们启动时建的 junction**(`lib/native.js` 的 `ensureRuntimeLayout()`);
   - `<profile>/node_modules/@microsoft/mxc-sdk` ← **不存在**。
2. **desktop 校验器按"别名键"找包**(`@microsoft/mxc-sdk`),找不到就 fail closed ⇒ 事务回滚、`~/.dsh/desktop/staging/<id>` 为空目录。
3. 其余 15 个别名键(`kerberos`/`node-pty`/`ssh2`/`koffi`/`@vscode/spdlog`/`@vscode/windows-registry` …)在公共 npm
   上**都有同名包**,按名字找得到 ⇒ 只有 `@microsoft/mxc-sdk` 被点名。
4. 与"24h 供应链策略"无关:desktop profile 的 `pnpm-workspace.yaml` 里 **`minimumReleaseAge: 0`**;且
   该 profile 的 `pnpm-lock.yaml` **已经包含** `@jinsiyu/dshcs-microsoft-mxc-sdk@0.8.0`(解析成功)。
5. 发布物本身没问题:mxc-sdk 0.8.0 `fileCount 101 / unpackedSize 68.4MB / integrity 有`,与本地
   `repack/build/microsoft-mxc-sdk`(101 文件,65.2MB)一致。

## 二、改动点

1. `scripts/vendor-repacks.mjs`
   - **聚合包依赖表**(约 609 行 `for (const [name] of repack) deps[name] = \`npm:...\``):把 mxc-sdk 排除,
     不进 `dependencies`;
   - **树包构建**(`buildVscodeServerPackage()` 或树包 staging 阶段):把
     `repack/build/microsoft-mxc-sdk/**` 复制到树包的 `lib/vscode/node_modules/@microsoft/mxc-sdk/`,
     并**从该子树里删掉 `package.json` 的 `dependencies` 别名改写**(第 558–563 行那段只对"要发布成包"的目录跑,
     树内直接放文件,不需要 manifest 改写);
   - 交叉平台(x64/arm64)注意:该包**平台无关**(内含多架构预编译产物),只需放一次。
2. `lib/native.js`
   - `ensureRuntimeLayout()` 现在按别名目标名在 profile 的 `node_modules` 里找包再建 junction;改为:
     **若 `<tree>/lib/vscode/node_modules/<原名>` 已存在就跳过**(树包自带),找不到才回落到 profile。
3. `package.json`
   - 聚合包版本 +1(例如 `0.3.11`),插件 `optionalDependencies` 的范围同步(仍是 `^0.3.x`);
   - 插件自身版本 +1(发 `next`)。

## 三、执行步骤(含需要 2FA 的节点)

```powershell
# 0) 先确认树上没有历史遗留(可选)
node scripts/vendor-repacks.mjs --reuse --target win32-arm64,win32-x64 --pack      # 重打树包+聚合包(复用已编原生)
node -e "const j=require('./repack/aggregator/win32-arm64/package.json');console.log(JSON.stringify(j.dependencies,null,1))"
#    ↑ 验证标准 1:输出里**不再出现** "@microsoft/mxc-sdk"
tar -tzf repack/tgz/jinsiyu-dshcs-vscode-server-<树版本>.tgz | Select-String "mxc-sdk" | Select-Object -First 3
#    ↑ 验证标准 2:树包 tarball 里**有** lib/vscode/node_modules/@microsoft/mxc-sdk/
pnpm run publish:repacks            # ← 需要 2FA(动 registry:树包 + 聚合包)
pnpm pack; pnpm run publish:plugin  # ← 发 next
```

## 四、验证

- npm 侧:`npm view @jinsiyu/dsh-code-server-runtime-win32-arm64@<新版本> dependencies --json` ⇒ 无别名行;
- desktop 侧:官方安装方式重装插件 ⇒ **不应再报** `requires missing @microsoft/mxc-sdk@npm:…`;
- 运行时:启动后 `<tree>/lib/vscode/node_modules/@microsoft/mxc-sdk/package.json` 存在(树包自带,不再靠 junction);
- 回归:`pnpm test:bridge-routes` / `test:bridge-extension` / `test:webview` 全绿(与本改动无关,但发版前照跑)。

## 五、回退

- 聚合包/树包都带版本号:回退 = 把插件 `optionalDependencies` 指回上一版聚合包(`0.3.10`),重发 `next`;
- desktop 侧若装了新版出问题:卸载后装回上一版插件(其依赖闭包仍指向 `0.3.10`)。

## 六、附:为什么不再用"文件级覆盖安装"

`.spike/install-desktop-0313.mjs` 那套会绕开 desktop 自己的安装事务与校验,把真实缺陷掩盖成"装上了但行为怪"。
2026-09-13 起约定:**desktop 只打包上传**(见 README「dist-tag 政策」下一段)。
