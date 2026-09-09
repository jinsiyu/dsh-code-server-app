# dsh-code-server-app — Integrate code-server (VS Code in the browser) into DSH

> Source repository: see `repository` / `homepage` in `package.json`.

> ## ⚠️ Extension Marketplace Note (important)
>
> - **code-server's extension store is [Open VSX](https://open-vsx.org/), not the Microsoft Visual Studio Marketplace**;
> - Microsoft's Marketplace terms **prohibit third-party products (including code-server) from using its API**, so code-server cannot query Microsoft's extension list;
> - As a result, Microsoft **commercial/proprietary** extensions (e.g. **GitHub Copilot, the Remote series like Remote-SSH, Azure tools, IntelliCode**) are **not available** in the store — this is Microsoft's distribution policy, not a defect;
> - Microsoft **open-source** extensions (Python, TypeScript debugger, ESLint, …) are mirrored on Open VSX and install normally by search;
> - **If you need a proprietary Microsoft extension**: download the `.vsix` from the Marketplace page and install it manually with `code-server --install-extension <file>` (or drop it into `--extensions-dir`).

A static profile plugin (npm package with host + client bundle) that ships [code-server](https://github.com/coder/code-server) as a **platform-specific sub-package dependency** (a pack-time artifact at `vendor/code-server` → `@jinsiyu/dshcs-code-server-<platform>-<arch>`, with no install scripts and no postinstall) and runs it outside the plugin directory. VS Code's inner dependencies and the prebuilt native modules are **all installed by the package manager together with the plugin** — no global npm install, no `bin` configuration, no profile config changes, no second install command.

## UI carrier (chosen by the DSH version, feature-detected at runtime)

| DSH version | Carrier | Entry points |
|---|---|---|
| **>= 0.1.5-alpha.1** (has `sidebarRight` / `sidebarRightTabs`) | **Right-sidebar tab** (kind `code-server`, chip `Code Server`); the floating window is **no longer used** | ① the **Code Server box** on the sidebar's guide ("开始") page; ② the icon button beside each turn's artifacts; ③ Settings → Plugins → Code Server → **"Open in right sidebar"** |
| older (no sidebar service) | floating ball + internal floating window (unchanged) | the bottom-right floating ball |

- Detection: `ctx.inject(['sidebarRightTabs','sidebarRight'], …)` registers the tab type only when the services are ready; if they never appear (or registration fails) nothing is registered and the floating ball fallback stays in place. No version comparison, and the plugin's own activation is never blocked.
- The sidebar tab hosts the code-server page (iframe) and follows the current session workspace; the panel can be collapsed/split/floated/fullscreened by DSH's right sidebar.
- **Known trade-off**: DSH renders only the active tab's body, so switching away and back remounts the iframe (a full code-server reload; unsaved editor buffers are lost). Float the tab into its own panel or keep it active for long-running sessions.
- In sidebar mode the settings card hides "Reserve space above the composer" (floating-window geometry only). "Open in a window (new tab)" still applies to every entry point.
- `windowedOpen` has the highest priority: when on, entry buttons always open a browser tab.

## Floating ball / window (legacy-DSH fallback path only)

- **Floating ball** (bottom-right, official code-server icon, above the composer): click to **expand the floating window and light it up** (blue glow), click again to **collapse**; **drag to any position** (remembered across refreshes; no accidental click after drag);
  no sidebar button, no window control button group (the ball is the only entry/toggle); the ball carries a status dot (green = running / amber = starting / red = error);
- Window is an **internal floating window** (modeled on dsh-univer-office's WorktreeWindow): fixed-position overlay + an inert root container, the window takes over pointer events,
  **no title bar / buttons** — drag the top strip to move (hover shows a faint hint; **drag to the top of the screen and release = maximize**,
  **grab the top strip downward while maximized = restore** and keep dragging), double-click to maximize, 8-direction resize, Esc to close (same as collapsing the ball),
  initial position above the composer, maximized/resized dimensions stop above the input bar (never cover the composer);
- The window hosts the code-server page directly (iframe); shows status/error info when not running or failed to start;
- code-server's workspace **follows the active DSH session/workspace**: switching sessions/workspaces while the overlay is open restarts code-server to the new directory
  (resolution order: current session cwd → session's workspace.path → recentWorkspace.path → first workspace.path);
  the opened directory is shown inside code-server (`?folder=<cwd>`, the page reloads when following a switch);
  implementation note: the iframe `src` must carry `?folder=<cwd>` — code-server's front-end remembers the "last workspace" and restores it by itself;
  a bare root URL only shows the previously opened directory and does not follow switches (verified locally).
  **Windows path format (verified)**: the `folder` parameter must start with `/` and use forward slashes only, e.g. `/C:/Users/User/Desktop/biss`;
  a bare Windows path (`C:\...`) is parsed as a URI scheme and the drive letter is stripped (page shows `\Users\User\...` with an empty file tree),
  while `file:///C:/...` reports "Workspace does not exist".
- Process lifecycle is managed by the host plugin: startup writes `$DSH_HOME/code-server/pid.json`, stop kills the tree (`taskkill /T` or process-group SIGKILL),
  crash/exit updates status live; after a DSH host restart the plugin **adopts** a still-running instance (verifies pid + `/healthz`), without duplicate start or killing unrelated processes;
- `node_modules` and the pack-time artifact `vendor/` are git-ignored; after cloning, follow
  "Install the plugin (script-free install; code-server bundled)" below — `pnpm install` → `pnpm run build:client` →
  `pnpm run vendor:code-server` → `pnpm pack` + `dsh plugin --profile web add`.

> Verified locally (BM: Windows 11 ARM64): `code-server@4.136.2` (with Code 1.136.1) bundled in the plugin,
> placed offline at activation → VS Code internal deps installed → started → healthz 200 →
> cwd switch restart while running → stopped → fully recycled.

## Packaging (how to build the tarball)

```powershell
cd C:\Users\User\Desktop\dsh-code-server-app
pnpm install             # dev deps (esbuild + motion); allowBuilds is explicit → no postinstall runs
pnpm run build:client    # src/factory.js → lib/client.js (not committed; must be built first)
pnpm run vendor:check    # optional: show the bundled code-server version vs npm latest
pnpm run vendor:code-server                     # ① produce vendor/code-server (code-server + its own deps)
pnpm run repack:code-server -- --target win32-arm64,win32-x64 --pack   # ② platform sub-packages (incl. argon2)
node scripts/vendor-repacks.mjs --target win32-arm64,win32-x64 --pack   # ③ build/repack the VS Code natives
pnpm run publish:repacks                        # ④ publish every @jinsiyu/* sub-package
pnpm pack                                       # ⑤ → dsh-code-server-app-<version>.tgz (~105KB)
npm publish dsh-code-server-app-<version>.tgz --access public   # ⑥ publish the plugin itself (same verified tarball)
```

| Goal | Command |
|---|---|
| **Build the latest code-server from npm** | `pnpm run vendor:latest` (= `--force`): snapshots `code-server@latest` into `vendor/code-server`; afterwards you **must** re-run `repack:code-server` (republish the sub-packages) and `vendor-repacks.mjs` (the inner dependency versions change) |
| **Pin a version** | `pnpm run vendor:code-server -- --version 4.136.2` |
| **Snapshot from an existing tree** | `pnpm run vendor:code-server -- --from <code-server dir>` (seconds) |
| **Rebuild the code-server sub-packages** | `pnpm run repack:code-server -- --target win32-arm64,win32-x64 --pack` (x64 compiles argon2 and checks the PE machine type) |
| **Rebuild prebuilt natives** | `node scripts/vendor-repacks.mjs [--from <existing full install>] --target win32-arm64,win32-x64 --pack` (without `--from` it npm-installs and compiles the source tree itself — slow) |
| **Publish sub-packages** | `pnpm run publish:repacks` (`--dry-run` to preview; `--only <substr>` to filter; `--otp <code>` / `--limit N` for 2FA) |
| **Publish the plugin itself** | `npm publish dsh-code-server-app-<version>.tgz --access public` (publishes the exact tarball that was verified; no re-packing) |
| **Just report versions** | `pnpm run vendor:check` |

> `pnpm pack`'s `prepack` runs the vendor-code-server script once; when `vendor/code-server` already exists it is
> a **no-op that takes seconds**, so after ordinary code changes you can just run `pnpm pack` (it will never
> silently upgrade code-server). Upgrading code-server requires an explicit `pnpm run vendor:latest`
> (or `--force` / `--version`) **plus** republishing the sub-packages.

## Install the plugin (one command; all dependencies installed by the package manager)

```powershell
# no postinstall in the package → no pnpm approve-builds / allowBuilds; one command installs everything
dsh plugin --profile web add dsh-code-server-app@0.1.37
# a local tarball works the same way:
dsh plugin --profile web add C:\Users\User\Desktop\dsh-code-server-app\dsh-code-server-app-0.1.37.tgz
```

Ready to use immediately — **no second step, no "Install environment", no install-guide modal**.
Since 0.1.37 the main package is only **~105KB** (the plugin's own code); everything else is dependencies:

- **the code-server tree** (`lib/vscode` 196.9MB + its own 136 runtime dependencies) ships as a **platform-specific
  sub-package** `@jinsiyu/dshcs-code-server-<platform>-<arch>@<code-server version>` (gated by `os`/`cpu`, listed in
  the plugin's `optionalDependencies`) → pnpm picks the right one for the architecture; it runs from
  `<profile>\node_modules\@jinsiyu\dshcs-code-server-win32-arm64\code-server`;
- the **pure-JS part** of VS Code's inner dependencies (35 packages: xterm / katex / typescript / ws / tar …) is
  declared in the plugin's `dependencies` and installed by pnpm into the profile's `node_modules` (hoisted);
- the **packages that need compiling** (node-pty / @vscode/sqlite3 / kerberos / koffi / ssh2 / cpu-features /
  @parcel/watcher / @vscode/windows-* … 16 in total) are provided as prebuilt `@jinsiyu/dshcs-*` packages,
  pulled back under their **original names** by the **platform aggregator**
  `@jinsiyu/dsh-code-server-runtime-<platform>-<arch>` using `npm:` aliases;
- consequently the dependency graph contains **no package with pre/install/postinstall or a `binding.gyp`** →
  no profile `allowBuilds`, no build script ever runs, and **the user machine needs no C++ toolchain**;
- **upgrading the plugin no longer re-downloads code-server**: the sub-package is cached by version, so only a
  code-server version change pulls those ~58MB again.

### Install mechanism (why it is built this way)

- **The pnpm 11 hard constraint**: any package in the dependency graph whose manifest has
  `preinstall|install|postinstall` (or whose tarball contains `binding.gyp`/`.hooks`) is treated as
  "requires build" and must be approved through the **host profile's** `pnpm-workspace.yaml` (`allowBuilds`),
  otherwise `dsh plugin add` exits 1 with `[ERR_PNPM_IGNORED_BUILDS]`. A dependency's own `pnpm.allowBuilds`,
  `.npmrc`, the `patch:` protocol and `optionalDependencies` are all ineffective (measured 2026-09, pnpm 11.25);
- **the code-server tree** is prepared at pack time with `npm install code-server@<version> --ignore-scripts`
  (skips the official `sh ./postinstall.sh` — there is no `sh` on Windows and the script only accepts npm/yarn
  user agents, so it always fails under pnpm) → supply the argon2 native binary (no Windows prebuild exists;
  compile with `node-gyp-build`, or reuse an existing `argon2.node` via `DSHCS_ARGON2_BINARY`) → strip leftover
  install scripts → snapshot to `vendor/code-server/`;
- `scripts/vendor-code-server-pkg.mjs` then turns it into **platform sub-packages**: the tree lives in an inner
  `code-server/` directory (npm/pnpm packing **always excludes the package root's `node_modules`**; a subdirectory
  covered by `files` is included), and the sub-package declares **no `dependencies`** (those 136 packages are
  already files inside `code-server/node_modules`; declaring them would make pnpm install a second copy).
  `os`/`cpu` gated, each with its own compiled argon2 (arm64 0xaa64 / x64 0x8664);
- **packages that need compiling** are repacked by `scripts/vendor-repacks.mjs` into `@jinsiyu/dshcs-*`:
  copy the already-compiled package directory → **delete `scripts` / `files` / `binding.gyp` / `.hooks` /
  `.npmignore`** (keeping the compiled `.node` and every runtime file) → rewrite dependencies that belong to the
  same set to `npm:` aliases → platform-specific ones get an `os`/`cpu` pair and a `-<platform>-<arch>` suffix;
- **the platform aggregator** maps those repacks back to their original names (e.g.
  `"node-pty": "npm:@jinsiyu/dshcs-node-pty@1.2.0-beta.15"`), so VS Code's `require('node-pty')` needs no change.
  The aggregator itself is `os`/`cpu` gated, and the plugin declares both win32-arm64 and win32-x64 in
  `optionalDependencies` → one command picks the right one automatically;
- **resolution path**: the host resolves the runtime root with
  `require.resolve('@jinsiyu/dshcs-code-server-<platform>-<arch>/package.json')` (then the inner `code-server/`
  directory) and launches `code-server/out/node/entry.js`; VS Code's inner dependencies are resolved upward from
  there: `code-server/node_modules` → the sub-package's `node_modules` → `<profile>/node_modules` (hoisted
  layout), exactly what the runtime sees. The in-package `vendor/code-server` is only a development/legacy
  fallback.

> **Size note**: the plugin tarball is **~105KB**; each `@jinsiyu/dshcs-code-server-win32-*` sub-package is
> **~58–60MB** (249MB unpacked); the inner dependencies and prebuilt natives add ~250MB. A full install downloads
> roughly 310MB. Neither `vendor/` nor `repack/` is tracked by git (see `.gitignore`).

> **Upgrading from ≤ 0.1.36**: the in-package `vendor/code-server/` moved into the platform sub-packages and the
> main package shrank to ~105KB. The upgrade command is unchanged
> (`dsh plugin --profile web add dsh-code-server-app@<version>`); the old `vendor/` disappears with the old
> package directory.

> **Upgrading from ≤ 0.1.35**: the old install root `<profile>\.code-server-app` (with ~1.4GB of inner
> dependencies) and the "Install environment" step are gone. The new version detects the old root and logs that it
> can be safely deleted: `Remove-Item -Recurse -Force <profile>\.code-server-app`. Old
> `dsh-code-server-app: false` entries in the profile's `pnpm-workspace.yaml` can be removed too (no build
> approval is needed any more).

> **Uninstall**: `dsh plugin --profile web remove dsh-code-server-app` is enough; the code-server sub-package and
> the natives are separate dependencies, so to remove everything run e.g.
> `dsh plugin --profile web remove @jinsiyu/dshcs-code-server-win32-arm64` (or `pnpm remove` inside the profile);
> if an old install root is still around, delete `<profile>\.code-server-app` manually.

> After install/dependency changes, **restart `dsh web`** (the static plugin row and host probe paths load at startup).

### Development: install from source (changes take effect immediately)

```powershell
dsh plugin --profile web add C:\Users\User\Desktop\dsh-code-server-app
```

> A source path installs via `link:`. On a dev machine without `vendor/code-server`, run
> `pnpm run vendor:code-server` first. Dependencies (inner JS deps + the platform aggregator) are installed by pnpm
> too — but the not-yet-published local `@jinsiyu/*` packages must either be published first, or the
> `repack/tgz/*.tgz` files must be installed into the profile as `file:` dependencies.
>
> **Changing the client bundle**: edit `src/factory.js` then run `pnpm run build:client`
> to regenerate `lib/client.js` (that artifact is not tracked; a browser refresh picks it up — no host restart needed).
> Window animations are driven by the embedded `motion`; feel parameters live in `winPhysics` (one spot) in `src/factory.js`.

### Pack-machine environment (the user machine needs nothing)

**A toolchain is needed at pack time only — never on the user machine.**

| Env | Version / requirement | User machine | Pack machine |
|---|---|---|---|
| Node.js | **v24.x** (latest code-server requirement; v24.13.1 here) | required | required |
| npm / pnpm | npm ships with Node; pnpm comes from DSH | required (installs deps) | required |
| **MSVC build tools** | **VS Community 2026 + C++ desktop workload** | ❌ **not needed** | pack time (16 native packages + argon2) |
| **VS Spectre-mitigated libs** | one set for ARM64 **and** one for x86/x64 ("MSVC v14x Spectre-mitigated libs") | ❌ not needed | pack time (otherwise MSB8040) |
| Python | **3.13.x** | ❌ not needed | pack time (node-gyp) |
| node-gyp | **13.x** (older versions don't recognize VS 2026) | ❌ not needed | pack time |

> **Packing still works without the Spectre libs**: when a package fails to compile, `vendor-repacks.mjs` downgrades
> `SpectreMitigation` to `false` in that architecture's `*.gyp` files and retries (only the Spectre hardening is
> lost, functionality is unaffected) and says so in the log.

### Windows native build notes (pack time, verified locally ARM64)

- **VS needs the Spectre-mitigated libraries** (MSB8040): Visual Studio Installer → Individual components →
  "MSVC v14x Spectre-mitigated libs" — **install the ARM64 and the x86/x64 sets separately**.
- **node-gyp 13.x** (9.x does not recognize VS 2026): `npm install -g node-gyp@latest`.
- **x64 cross-compiling**: `vendor-repacks.mjs` uses `npm install --os=win32 --cpu=x64 --ignore-scripts` to fetch
  the packages, then `npm rebuild --arch=x64` per package; the resulting PE machine types were verified
  (kerberos / sqlite3 / spdlog …).
- Latest code-server requires **Node v24**.
- If you don't need the self-contained install (e.g. a global code-server already exists), skip it:
  the plugin falls back to a configured/PATH `bin` (see the "Config" table).

### Upgrading the code-server version

- **The version is decided at pack time**: `pnpm run vendor:latest` (= `--force`) rebuilds with the npm
  **latest** version; or use `pnpm run vendor:code-server -- --version 4.136.2` / `DSHCS_CODE_SERVER_VERSION`.
  With an existing `vendor/code-server`, a plain `pnpm pack` never upgrades (it is a no-op).
- **Check first**: `pnpm run vendor:check` prints the bundled version / npm latest.
- **A version bump requires republishing two kinds of sub-packages** (the inner dependency versions change with
  code-server):
  1. `pnpm run repack:code-server -- --target win32-arm64,win32-x64 --pack` → the new code-server sub-packages;
  2. `node scripts/vendor-repacks.mjs --target win32-arm64,win32-x64 --pack` → the prebuilt natives (also rewrites
     the plugin's pure-JS `dependencies` and both aggregator versions);
  3. `pnpm run publish:repacks` → publish; then bump the plugin version → `pnpm pack` → publish the plugin.
- **No runtime auto-upgrade anymore**: nothing fetches latest at startup; the version is fully determined by the bundled artifact.
- Bundled locally right now: `code-server@4.136.2` (with Code 1.136.1).

### Compatibility with the old install locations

Host probe order: `@jinsiyu/dshcs-code-server-<platform>-<arch>/code-server` (**the real layout since 0.1.37**) >
the in-package `vendor/code-server` (0.1.36 and earlier / development) > the old install root
`<profile>\.code-server-app\node_modules\code-server` (0.1.35 and earlier) > plugin-internal
`node_modules/code-server` (development) > PATH/config `bin`. The old root is only mentioned in a startup log
line; nothing writes to it any more.

## Settings card (Settings → Plugins → Code Server)

Modeled after dsh-auto-open-web's custom card, registered on the `settings.plugin.item` slot,
persisted via the official settings domain (`settingsScope`, namespace `code-server`) into the official settings document:

| Key | Default | Description |
|---|---|---|
| `reserveComposer` | `true` | Whether the window **reserves space above the composer**: on, the window's initial/drag/resize/maximize stop above the composer (never covers it); off, it may cover the composer (maximize to viewport bottom). **Applies to the legacy floating window only** — hidden in sidebar mode |
| `windowedOpen` | `false` | **Open in a window**: on, every entry point (artifact button / settings card / floating ball) opens code-server in a browser **new tab** (auto-starts and follows the active workspace); off (default) uses the right-sidebar tab (or the internal floating window on older DSH) |

> Card changes take effect immediately via `scope.watch` (the host status API returns `reserveComposer` and
> `windowedOpen`; the client applies them at once); no dsh restart needed. **After adding new setting keys, restart dsh web before first use**,
> so the host re-registers the settings namespace (schema includes the new key); otherwise save/validation of the new key won't work.

The bottom of the card is **Environment check** (click "Check environment" to read the host `status.env`): entry,
`native` (argon2), VS Code inner dependencies, and **prebuilt native packages** (platform aggregator name +
resolved module count). Since 0.1.36 there is no "Install environment" button — dependencies are installed by the
package manager, and the card only reports the result.

## Config (`config` in cordis.patch.yml; all have defaults)

| Key | Default | Description |
|---|---|---|
| `bin` | `code-server` (placeholder) | Launch priority: explicit `bin` in config > the platform sub-package `@jinsiyu/dshcs-code-server-<platform>-<arch>/code-server/out/node/entry.js` > the in-package `vendor/code-server` > the old install root `.code-server-app` > plugin-internal `node_modules` > `code-server` on PATH. None present → startup error with troubleshooting hints |
| `host` | `127.0.0.1` | Bind address; `auth: none` only allows loopback (localhost/127.0.0.1/::1) |
| `port` | `8090` | Port; on conflict startup fails with diagnostics (no automatic port change) |
| `auth` | `none` | `none` \| `password`; non-loopback host automatically requires password |
| `passwordToken` | `''` | Token for password mode (passed to code-server via the `PASSWORD` env var) |
| `userDataDir` | `$DSH_HOME/code-server/user-data` | User-data isolation directory |
| `extensionsDir` | `$DSH_HOME/code-server/extensions` | Extensions directory |
| `readyTimeoutMs` | `60000` | `/healthz` readiness probe timeout |

User-level override example (write in `$DSH_HOME/profiles/web/cordis.patch.yml`, using the `- id: code-server` row):

```yaml
- id: code-server
  config:
    port: 8091
    # Explicit (overrides dependency-install probing): a globally installed shim, or any entry.js
    bin: C:\Users\User\AppData\Roaming\npm\code-server.cmd
```

## JSON API (same-origin fetch; identical paths in web and desktop)

**No `webServer` dependency**: the host half registers its routes on DSH Connection's shared `/api` channel through
`ctx.connection.fetch.register`. In the web profile Connection mounts the `/api` prefix on webServer itself (with the
Host/Origin fence and browser auth); in the desktop profile `apps/desktop-host` feeds `/api/*` into the same
`createSharedFetchHandler('/api')` (IPC framed pipe, no HTTP server). The client only writes relative paths
(`fetch('/api/code-server/<op>')`), so both carriers behave identically.

| Method | Path | Description |
|---|---|---|
| GET | `/api/code-server/status` | `{ ok, running, status, host, port, pid, cwd, url, version, error, logTail, adopted }` (also `env` environment check and the `setup` compatibility field) |
| POST | `/api/code-server/start` | body `{ cwd? }` (omit cwd to keep the current workspace); idempotent |
| POST | `/api/code-server/stop` | Stop and recycle the process tree |
| POST | `/api/code-server/setup` | **Compatibility no-op**: since 0.1.36 dependencies are installed by the package manager, so this only re-runs the env self-check and returns |
| POST | `/api/code-server/open-file` | body `{ file }` — writes the signal consumed by the built-in `dshcs-open-file` extension to open the file in code-server |

> The plugin no longer registers `/code-server/*` webServer-only routes, and the code-server icon is inlined as a data URI
> in the client bundle — the client requests no plugin-owned HTTP resource at all.

## DSH Desktop (no webServer)

- The host half is `inject = ['connection', 'settings']` (**no `webServer`**) — the desktop profile disables webserver/web-runtime
  and the plugin still works: `/api/*` requests travel Electron `dsh-app://` protocol handler → IPC framed pipe → `createSharedFetchHandler('/api')`.
- The right-sidebar tab, guide entry box, artifact button, and settings card behave the same as in web (code-server remains an
  iframe to the local `http://127.0.0.1:<port>`; the desktop renderer uses `webSecurity: true` with no CSP, so the cross-origin iframe loads).
- Install into the desktop profile with `dsh plugin --profile desktop add dsh-code-server-app@<version>` (or the desktop plugin manager).

## Artifact open buttons

Each produced file (written/edited) in a turn is shown as a chip with a **code-server icon button** next to it
in the conversation's turn tail; clicking either opens the file in code-server — in the right-sidebar tab on
DSH >= 0.1.5-alpha.1 (opening/expanding the column and focusing the tab), or in the floating window on older hosts
(when `windowedOpen` is on, both open a browser tab instead).
The `dshcs-open-file` extension is installed as a **built-in** extension of code-server (in `lib/vscode/extensions`),
so users cannot remove it from the extensions panel.

## Known limitations

- **No sub-path**: the code-server front-end uses root paths/WebSocket/Service Worker, so it must be a direct iframe on its own port;
  no DSH webServer reverse proxy; `--base-path` is not officially supported.
- **Single instance across sessions**: one shared code-server per host; switching cwd requires a restart (the sidebar tab / floating window handles it and hints).
- **Sidebar tab switching reloads**: DSH's right sidebar renders only the active tab's body, so switching away and back remounts the iframe (a full code-server reload); keep the tab active or float it for long-running sessions.
- **Remote access**: default is loopback + no auth. Cross-machine access requires `host` + `auth: password` + `passwordToken`,
  and the browser must be able to reach that host directly (the plugin's "open in new tab" builds the URL from `host:port`).
