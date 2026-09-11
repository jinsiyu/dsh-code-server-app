# dsh-code-server-app — Integrate code-server (VS Code in the browser) into DSH

> Source repository: see `repository` / `homepage` in `package.json`.

> ## ⚠️ Extension Marketplace Note (important)
>
> - **code-server's extension store is [Open VSX](https://open-vsx.org/), not the Microsoft Visual Studio Marketplace**;
> - Microsoft's Marketplace terms **prohibit third-party products (including code-server) from using its API**, so code-server cannot query Microsoft's extension list;
> - As a result, Microsoft **commercial/proprietary** extensions (e.g. **GitHub Copilot, the Remote series like Remote-SSH, Azure tools, IntelliCode**) are **not available** in the store — this is Microsoft's distribution policy, not a defect;
> - Microsoft **open-source** extensions (Python, TypeScript debugger, ESLint, …) are mirrored on Open VSX and install normally by search;
> - **If you need a proprietary Microsoft extension**: download the `.vsix` from the Marketplace page and install it manually with `code-server --install-extension <file>` (or drop it into `--extensions-dir`).

A static profile plugin (npm package with host + client bundle) that ships the **VS Code server tree** from a [code-server](https://github.com/coder/code-server) release as a **platform-independent dependency package** (pack-time artifact `vendor/vscode` → `@jinsiyu/dshcs-vscode-server`, no install scripts, no postinstall). The code-server **Node service layer is replaced by the plugin's own `lib/launcher.mjs`**: it drives `<tree>/lib/vscode/out/server-main.js` (`loadCodeWithNls()` / `createServer()` / `handleRequest()` / `handleUpgrade()`) directly and re-adds the few HTTP endpoints code-server used to provide (`/healthz`, `/manifest.json`, `/_static/*`, `/proxy/:port`). The 16 native modules (node-pty / @vscode/sqlite3 / spdlog / …) come from `@jinsiyu/dshcs-*-win32-<arch>` platform packages selected automatically per architecture by the platform aggregator. VS Code's inner dependencies and the prebuilt native modules are **all installed by the package manager together with the plugin** — no global npm install, no `bin` configuration, no profile config changes, no second install command, **no argon2/C++ toolchain**.

## UI carrier and required DSH version (0.2.3: right-sidebar DSH only)

| DSH version | Carrier | Entry points |
|---|---|---|
| **>= 0.1.5-alpha.1** (has `sidebarRight` / `sidebarRightTabs`) | **Right-sidebar tab** (kind `code-server`, chip `Code Server`), which also **claims file addresses** (see below) | ① DSH's own **produced-file chips / presented-file card previews / inline file names in prose** (since 0.2.5, via the official `openFile` → file address → this tab); ② the **Code Server box** on the sidebar's guide ("开始") page; ③ Settings → Plugins → Code Server → **"Open in right sidebar"** |
| older (no sidebar service) | **Unsupported**: nothing but one notice on the settings page | none (Settings → Plugins → Code Server shows an upgrade notice) |

- Detection: first a synchronous `ctx.get('sidebarRightTabs') / ctx.get('sidebarRight')` probe; because the services may come up after this plugin, `ctx.inject(['sidebarRightTabs','sidebarRight'], …)` is awaited and a **2.5 s timeout marks the DSH as legacy** (no version comparison, and the plugin's own activation is never blocked).
  Since 0.2.4 that verdict is **reversible** and registration no longer relies on `ctx` property access (which on desktop silently skipped registration — the symptom was "settings card looks normal but the sidebar has no entry"):
  - services are looked up as `ctx.<name>` first and `ctx.get(name)` second, so either context shape registers;
  - when the sync probe already sees the services but `inject` never calls back, registration falls back to the sync services after **1.5 s**;
  - at 2.5 s only the settings notice appears; only after **10 s** does the client tell the host to recycle/stop prestarting (so a slow host is not punished);
  - services arriving late automatically revoke the legacy verdict, register the sidebar, and report `{sidebar:true}` so the host re-enables;
  - a failed registration is no longer silent: it logs an error and the card's entry row says "right-sidebar services were found but the tab could not be registered".
- **0.2.3 dropped legacy-DSH compatibility**: the floating ball and the internal floating window are **deleted**. When the DSH is detected as legacy the plugin
  - registers only the settings card (an upgrade notice) — no ball, no floating window, **no file-address claim**, no IDE preload;
  - reports `/api/code-server/ui-mode { sidebar:false }` to the host (after the 10 s grace above); the host then **recycles an instance it auto-prestarted** and stops prestarting (a user-started/adopted instance is never touched), and `{sidebar:true}` reverses that if the services show up later;
  - upgrading DSH needs **no reinstall** — refresh the page and the card turns back into the full settings card.
- The sidebar tab hosts the code-server page (iframe) and follows the current session workspace; the panel can be collapsed/split/floated/fullscreened by DSH's right sidebar.
- **Fullscreen on open (0.2.9, on by default)**: opening the Code Server tab (including clicking a produced-file chip / delivered-file preview / inline file name) switches the right sidebar from "side by side with the conversation" to **fullscreen** (fills the window) — an IDE is cramped in a narrow column.
  It only affects that moment of opening: clicking the sidebar's own "Exit fullscreen" is never fought back; switching away and back, or opening another file tab, goes fullscreen again.
  Turn it off in the settings card (`fullscreenOnOpen=false`) to stay side by side.
  - How it is done: DSH does **not** expose the mode to plugins — `ctx.sidebarRight` only has `isExpanded`/`toggleExpanded`
    (expand/collapse), while push ⟷ fullscreen is recorded in `ui-sidebar-right`'s own store (`actions.setMode`, handed only to
    its own seat components). `ctx.layout.openRightbar(track, fullscreen)` is not a control either: it is the channel the seat
    **reports** its presentation through (upstream comment: *the occupant reports it; nothing else writes it*).
    So the plugin performs the user's own gesture: it locates its own panel with `closest('[data-sidebar-right-panel]')` and
    clicks the panel chrome's `[data-sidebar-right-mode="fullscreen"]` button (the exact same path as a manual click, including
    the narrow-viewport handling). When the button is missing it keeps the current mode and logs one `console.warn` — panel
    rendering is never affected.
- **Resident IDE (0.2.2, on by default)**: switching to another tab or collapsing the sidebar and coming back **no longer reloads** code-server — unsaved editor buffers, terminals and debug sessions all stay put (see "Why switching tabs no longer reloads" below).
- The settings card has exactly **three settings**: "**Claim types**", "**Fullscreen on open**" and "Resident in background" — no other rows (0.2.7 removed the "Entry", "dependency install" and "environment check" rows).
  Open the IDE from the **Code Server box** on the sidebar's guide page, or by clicking DSH's own produced-file chips / delivered-file previews / inline file names;
  diagnostics stay out of the UI — the `[code-server]` lines in the DSH host log are the place to look (`/api/code-server/status` still returns `env` for scripts).
  The old `windowedOpen` (open in a window) and `reserveComposer` were **removed in 0.2.6**: leftover keys in an old settings document neither fail nor apply (they are no longer part of the schema).
  To use the IDE in a browser tab, visit the loopback address `http://127.0.0.1:<port>/` (or DSH's `/code-server/` under `serve: dsh`).

## Opening files (official entry points since 0.2.5)

DSH names files with **resource addresses**; `openFile` only hands the address to the right sidebar, which decides who draws it:

```
DSH's produced-file chip / presented-file card preview / inline prose mention
      → openFile(path, { line? })                      (provided by ui-chat)
      → dsh-resource://file/session/<sessionId>/<path> (or …/file/absolute/<path>)
      → ctx.sidebarRight.openResource(address)
      → claimed by the tab type whose patterns match (band extension(3) > builtin(2) > fallback(1),
        then the longest matching pattern, then registration order)
```

This plugin registers:

| Field | Value | Effect |
|---|---|---|
| `patterns` | `['dsh-resource://file/**']` | claims file addresses (a pattern containing `:` is matched against the **whole address**) |
| `priority` | `'extension'` | beats the built-in plain-text preview, which sits in `fallback` on purpose — DSH's own comment calls that band "the position VS Code's text editor holds among its editors", i.e. one any more specific type should beat |
| `canOpen` | see below | vetoes by the "claim types" setting; unclaimed addresses fall back to DSH's built-in preview |
| `title` | last address segment (= file name) | the tab chip shows the file name; a page tab (`sidebar://code-server`) still reads `Code Server` |

- **Claim types** (a text box in the settings card, `claimExtensions`, since 0.2.11):
  **scope is no longer a thing** — `dsh-resource://file/session/…` and `…/file/absolute/…` are treated alike,
  and only the extension decides. Text-box grammar (semicolon-separated; `,`/whitespace/newlines also work;
  `py`, `.py` and `*.py` are equivalent; case-insensitive):
  - `*` — claim every other type too (catch-all);
  - `py` — claim `.py`;
  - `!md` — do **not** claim `.md` (**exclusion wins** over both an explicit claim and `*`);
  - **default** `*;!md;!markdown;!html;!htm;!png;!jpg;!jpeg;!gif;!webp;!bmp;!ico;!svg;!pdf`
    — the four categories DSH's own preview renders well (markdown / html / images / PDF) stay with it, everything
    else (code, json/yaml, txt, logs, extension-less files such as `Makefile`, unknown extensions) goes to the IDE;
    an empty box claims no files at all (page tabs only).
  - Three practical shapes: a plain whitelist (`py;ts`, no `*` → nothing else is claimed), catch-all (`*`),
    and catch-all plus exclusions (the default).
  - Grammar, default and parsing all live in `lib/claim-types.js` (the host's `Config` default and the client's
    `canOpen` share that single file, shipped in the package, so the two cannot drift apart);
    unit tests: `scripts/test-claim-types.mjs`.
- **How the tab body locates the file**: it parses `useTabInfo().tab.navigation.address`
  (`src/address.js`, same grammar as DSH's `parseFileAddress`), expands a workspace-relative path with that
  session's cwd, and posts the absolute path (plus optional `line`) to the host's
  `/api/code-server/open-file`; the bundled extension (`dshcs-open-file`) then calls `showTextDocument`
  (positioned at the line when given).
- **One address = one tab** (DSH semantics: `contentId` *is* the address): three files mean three chips, but they
  share the single resident workbench — switching tabs just re-aims the workbench at the corresponding file.
- **Why the bundled extension stays**: VS Code Web has no official "open this file from outside" API (the only
  entry is `?folder=`, which picks the workspace), so aiming the workbench at a file has to be done by an
  extension inside the tree. The host writes a signal file, the extension polls it and calls
  `showTextDocument`, keeping the signal for retry when no window is connected yet.

## Why switching tabs no longer reloads (resident IDE)

**The old trap**: DSH's right sidebar (ui-dockkit) renders **only the active tab's body**
(`TabPanel.tsx:412` → `renderTab(active)`) — switching to another tab unmounts that body in React, which moves the
iframe out of the document and destroys its browsing context; switching back is a full VS Code reload (unsaved buffers
lost). Floating the tab into its own panel only worked around it.

**What it does now (`src/surface.js` in the client, 0.2.2)**: the plugin takes the iframe **away from React** and turns
it into a **singleton resident surface**:

| Situation | Action | Result |
|---|---|---|
| tab becomes active | `host.moveBefore(frame, null)` into the visible dock slot | state-preserving atomic move, **no reload** |
| tab deactivates / sidebar collapses | move back into a document-level park container (offscreen, keeps last docked size, `inert` + `aria-hidden`) | never destroyed, keeps running in the background |
| workspace / port changes | assign `src` explicitly | the only normal "reload" entry point |

- **Why `moveBefore`**: measured in a real browser (Edge/Chromium 151), a plain `appendChild` move resets the iframe's
  internal timers (i.e. reloads it), while `Element.moveBefore()` (Chromium ≥133) preserves state (a probe counter keeps
  counting 1→2).
- **Degradation is never silent**: when `moveBefore` is missing, or the host was already detached by React and it throws
  `HierarchyRequestError: invalid hierarchy` (passive effect cleanup runs after DOM removal), the code falls back to
  `appendChild` — one reload, but the frame is **never lost** — and reports `degraded` / `lastMoveError` so the UI can
  say "residency unavailable".
- **Repaint fallback (measured)**: in the real GUI the surface was seen once with correct size, hit testing and
  `visibility` that simply **stopped repainting** (a fully white panel, byte-identical screenshots proving no new frame).
  `translateZ(0)` and `opacity` nudges did nothing; `display:none → forced reflow → restore` inside a single JS task
  restored it without reloading the iframe document, without losing internal state and without a visible flash.
  **The trigger could not be reproduced**: in a probe page an offscreen `moveBefore` park of 337 s (past Chrome's
  ~5 min cross-origin throttle window) followed by a dock with the fallback disabled still painted normally. It is
  therefore kept as a **fallback**: every park→dock transition runs one `nudgeRepaint()` (counted as
  `surfaceSnapshot().nudgeCount`; `setNudgeEnabled(false)` A/Bs it live).
- **Warm-up**: with `keepResident` (default `true`) the host builds the surface right after plugin start and leaves it
  parked, so the first tab open needs no cold start; preloading never yanks a surface that is currently docked.
- **Debug handle**: `window.__dshcsSurface` (`snapshot()`, `setParkStrategy('offscreen'|'behind')`, `dock()`, `park()`,
  `nudge()`, `setNudgeEnabled(false)`, `destroy()`).

**Measured** (DSH web GUI, real mouse clicks between sidebar tabs): switching away → `docked:false`, same iframe node,
in-frame probe still alive, `degraded:false`; switching back → `docked:true`, unchanged `src`, IDE pixels and editing
state preserved (no full reload). Full evidence and probe scripts: `docs/analysis-code-server-as-dsh-plugin.md`.

## Serving mode (`serve`)

| Mode | What it does | Requires |
|---|---|---|
| **`loopback` (default)** | the plugin listens on its own loopback port (`host:port`) and the sidebar iframe connects cross-origin; the process can be adopted after a DSH host restart | nothing |
| **`dsh`** | the IDE is mounted on **DSH's own HTTP port** at `/code-server/*` (HTTP prefix route) plus `/code-server/<quality>-<commit>` (exact WebSocket route), forwarded to the launcher's **named pipe**; **no extra port**; every request (including the WS handshake) first passes `ctx.connection.requestRejection()` — the same Host/Origin fence and browser-cookie authentication as `/api` | DSH providing `webServer` (web profile); desktop falls back to loopback automatically |

- Switch it in `config.serve` in `cordis.patch.yml` or in Settings → Plugins → Code Server (takes effect on the next start).
- Benefits of `dsh`: a single URL/port (remote access to DSH gives you the IDE), no extra loopback listener, authentication on par with DSH.
- Two **known trade-offs** of `dsh`: the iframe shares DSH's origin, so `sandbox` is dropped there (same-origin plus
  `allow-same-origin` is escapable by the frame itself; in `loopback` mode the iframe is cross-origin and `sandbox` stays
  as real protection — clipboard is still granted via `allow="clipboard-read; clipboard-write"`); and forwarded-port
  **WebSockets** cannot be routed because `registerUpgrade` matches exact paths while `/proxy/:port` carries the port in
  the path (HTTP forwarding works; use `loopback` when you need WS forwarding).

- In `loopback` mode every upgrade passes a **code-server-equivalent Origin check** (since 0.2.1): when an `Origin`
  header is present its host must equal `Host` (honouring `Forwarded: host=` / `X-Forwarded-Host`, like code-server),
  otherwise the handshake gets `403`; non-browser requests without `Origin` are allowed. Without that check any local
  browser page could complete a handshake against `ws://127.0.0.1:<port>/stable-<commit>` and drive the IDE.


## Legacy DSH (unsupported since 0.2.3)

**Behaviour**: when `sidebarRightTabs` / `sidebarRight` cannot be found, the plugin registers a single settings card:

> **Code Server** — this DSH version is unsupported (no right-sidebar service)
> Since 0.2.3 this plugin no longer supports older DSH versions.
> The right-sidebar plugin services `sidebarRightTabs` / `sidebarRight` were not detected, so the plugin exposes no
> entry point at all (the old floating ball and floating window have been removed) and will not start the IDE in the
> background. Upgrade DSH to a version with the right sidebar (>= 0.1.5-alpha.1): Code Server then appears as a
> right-sidebar tab, this page shows the full settings again, and no reinstall is needed — a page refresh is enough.

- **No other UI**: no `shell.overlay` registration (floating ball), no file-address claim, no resident preload.
- **Host side**: the client posts `/api/code-server/ui-mode { sidebar:false }`; the host then ① stops auto-prestarting
  the IDE (`maybePrestart` returns immediately) and ② **recycles** an instance it had just auto-prestarted (unless it
  was adopted), so no unusable IDE process or port is left behind. A user-started/adopted instance is never stopped.
- **Why delete instead of keeping**: the internal floating window was a stopgap from the era of early-2026 DSH builds
  without right-sidebar services. The resident surface, clipboard handling, shortcuts and panel collapsing all build on
  DSH's right sidebar, so maintaining two carriers costs more than it is worth. Older-DSH users should stay on `0.2.2`
  (`dsh plugin --profile web add dsh-code-server-app@0.2.2`).

## code-server workspace and process lifecycle

- code-server's workspace **follows the active DSH session/workspace**: switching sessions/workspaces while the IDE is open restarts code-server to the new directory
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
  `pnpm run vendor:vscode` → `pnpm pack` + `dsh plugin --profile web add`.

> Verified locally (BM: Windows 11 ARM64): `code-server@4.136.2` (with Code 1.136.1) bundled in the plugin,
> placed offline at activation → VS Code internal deps installed → started → healthz 200 →
> cwd switch restart while running → stopped → fully recycled.

## Packaging (how to build the tarball)

```powershell
cd C:\Users\User\Desktop\dsh-code-server-app
pnpm install             # dev deps (esbuild + motion); allowBuilds is explicit → no postinstall runs
pnpm run build:client    # src/factory.js → lib/client.js (not committed; must be built first)
pnpm run vendor:check    # optional: show the bundled tree version vs the latest code-server release
pnpm run vendor:vscode                            # ① produce vendor/vscode (the trimmed VS Code tree, ~197MB)
pnpm run repack:build -- --target win32-arm64,win32-x64 --pack   # ② one script builds every sub-package
pnpm run publish:repacks                         # ③ publish every @jinsiyu/* sub-package (default dist-tag: next)
pnpm pack                                        # ④ → dsh-code-server-app-<version>.tgz (~107KB)
pnpm run publish:plugin                          # ⑤ publish the plugin itself (default dist-tag: next)
# once the user has restarted dsh web and confirmed it works, promote latest:
pnpm run promote -- <version>
```

> **dist-tag policy (mandatory)**: every release goes to **`next`** and **never touches `latest`**;
> `latest` always points at the most recent *confirmed bug-free* version and is only moved by
> `pnpm run promote -- <version>` (= `npm dist-tag add dsh-code-server-app@<version> latest`)
> **after the user restarts `dsh web` and confirms it works**. That way
> `dsh plugin add dsh-code-server-app` (no version) — and anything else resolving `latest` — never picks up an
> unverified build. Sub-packages (`@jinsiyu/dshcs-*`, the aggregators) are referenced by exact/caret versions,
> so their dist-tags do not affect resolution, but they default to `next` as well.
> Inspect the current tags with `npm dist-tag ls dsh-code-server-app`.

`repack:build` (`scripts/vendor-repacks.mjs`) is the **single script that produces every sub-package**:

| Sub-package | Content | os/cpu |
|---|---|---|
| `@jinsiyu/dshcs-vscode-server@<code-server version>` | the trimmed VS Code tree (`lib/vscode` + `out/browser` + `src/browser`; **without** code-server's `out/node` and its 136 runtime deps) | platform-independent |
| `@jinsiyu/dshcs-<name>[-win32-<arch>]` ×24 | the VS Code inner packages that need building (node-pty / @vscode/sqlite3 / kerberos / koffi / ssh2 / …) | gated when platform-specific |
| `@jinsiyu/dsh-code-server-runtime-win32-<arch>` | platform aggregator: its `dependencies` map those 16 natives back to their original names via `npm:` aliases | win32-<arch> |

| Goal | Command |
|---|---|
| **Build from the latest upstream release** | `pnpm run vendor:latest` (= `--force`): pulls `code-server@latest`'s tree into `vendor/vscode`; afterwards you **must** re-run `repack:build` and republish every sub-package |
| **Pin a version** | `pnpm run vendor:vscode -- --version 4.136.2` |
| **Snapshot from an existing tree** | `pnpm run vendor:vscode -- --from <code-server dir>` (seconds) |
| **Rebuild every sub-package** | `pnpm run repack:build -- --target win32-arm64,win32-x64 --pack` (without `--from` it npm-installs and compiles the source tree itself — slow) |
| **Rebuild only the tree/aggregator packages** | `node scripts/vendor-repacks.mjs --reuse --target win32-arm64,win32-x64 --pack` (reuses the natives already in `repack/build`) |
| **Publish sub-packages** | `pnpm run publish:repacks` (`--dry-run` to preview; `--only <substr>` to filter; `--otp <code>` / `--limit N` for 2FA) |
| **Publish the plugin itself** | `pnpm run publish:plugin` (publishes the exact tarball that was verified; no re-packing; default dist-tag `next`) |
| **Promote `latest`** | `pnpm run promote -- <version>` (only after the user restarted and confirmed; `--dry-run` shows the current tags first) |
| **Just report versions** | `pnpm run vendor:check` |

> `pnpm pack`'s `prepack` runs the vendor-code-server script once; when `vendor/code-server` already exists it is
> a **no-op that takes seconds**, so after ordinary code changes you can just run `pnpm pack` (it will never
> silently upgrade code-server). Upgrading code-server requires an explicit `pnpm run vendor:latest`
> (or `--force` / `--version`) **plus** republishing the sub-packages.

## Install the plugin (one command; all dependencies installed by the package manager)

```powershell
# no postinstall in the package → no pnpm approve-builds / allowBuilds; one command installs everything
dsh plugin --profile web add dsh-code-server-app@0.2.1
# a local tarball works the same way:
dsh plugin --profile web add C:\Users\User\Desktop\dsh-code-server-app\dsh-code-server-app-0.2.1.tgz
```

Ready to use immediately — **no second step, no "Install environment", no install-guide modal**.
The main package is only **~110KB** (the plugin's own code plus the launcher); everything else is dependencies:

- **the VS Code tree** (`lib/vscode` 196.9MB + `out/browser` + `src/browser`) is a **platform-independent package**
  `@jinsiyu/dshcs-vscode-server@<code-server version>` declared in the plugin's `dependencies`; it runs from
  `<profile>\node_modules\@jinsiyu\dshcs-vscode-server\vscode` (the legacy full tree at
  `@jinsiyu/dshcs-code-server/code-server` is still recognised as a fallback);
- the **pure-JS part** of VS Code's inner dependencies (35 packages: xterm / katex / typescript / ws / tar …) is
  declared in the plugin's `dependencies` and installed by pnpm into the profile's `node_modules` (hoisted);
- the **binary part** comes entirely from `@jinsiyu/dshcs-*` platform packages: 16 native packages mapped back to their
  **original names** (`node-pty` / `@vscode/sqlite3` / `@vscode/spdlog` / …) by the **platform aggregator**
  `@jinsiyu/dsh-code-server-runtime-win32-<arch>` using `npm:` aliases; the aggregators sit in the plugin's
  `optionalDependencies`, so pnpm auto-selects the right platform;
- consequently the dependency graph contains **no package with pre/install/postinstall or a `binding.gyp`** →
  no profile `allowBuilds`, no build script ever runs, and **the user machine needs no C++ toolchain**;
- **upgrading the plugin no longer re-downloads the tree**: the tree package is cached by version
  (~60MB, ~197MB unpacked).

### Install mechanism (why it is built this way)

- **The pnpm 11 hard constraint**: any package in the dependency graph whose manifest has
  `preinstall|install|postinstall` (or that ships a `binding.gyp`/`.hooks`) counts as "needs building" and must be
  approved by the **host profile's** `pnpm-workspace.yaml` via `allowBuilds`, otherwise `dsh plugin add` exits 1 with
  `[ERR_PNPM_IGNORED_BUILDS]`. A dependency's own `pnpm.allowBuilds`, `.npmrc`, `patch:` protocol and
  `optionalDependencies` do not help (measured 2026-09, pnpm 11.25);
- **the tree** is prepared at pack time with `npm install code-server@<version> --ignore-scripts` (skipping the official
  `sh ./postinstall.sh`, which cannot run on Windows), then `scripts/vendor-vscode-server.mjs` keeps **only the VS Code
  tree**: `lib/vscode/**`, `out/browser/**`, `src/browser/**` plus the license files are copied to `vendor/vscode/`, and a
  generated root `package.json` records the upstream code-server version. code-server's own `out/node/**` and its 136
  runtime dependencies **no longer ship** — they are replaced by `lib/launcher.mjs`;
- **the packages that need a toolchain** are repacked into `@jinsiyu/dshcs-*` by `scripts/vendor-repacks.mjs`:
  the compiled package directory is copied and its `scripts` / `files` / `binding.gyp` / `.hooks` / `.npmignore` are
  **removed** (the built `.node` and every runtime file stay) → sibling packages in its dependency list become `npm:`
  aliases → platform-specific ones get `os`/`cpu` plus a `-<platform>-<arch>` suffix. For win32 targets the script also
  verifies each `.node` PE machine (0x8664=x64 / 0xaa64=arm64) so a cross-compiled artifact cannot ship the wrong arch;
- **the platform aggregator** maps those repacks back to their original names (e.g.
  `"node-pty": "npm:@jinsiyu/dshcs-node-pty@1.2.0-beta.15"`), so VS Code's `import('node-pty')` needs no change; the
  aggregator is itself `os`/`cpu` gated, and the plugin declares both win32-arm64 and win32-x64 in
  `optionalDependencies`, so one command picks the right one;
- **resolution path**: the host finds the tree with `require.resolve('@jinsiyu/dshcs-vscode-server/package.json')`
  (then the inner `vscode/` directory) and the entry is `vscode/lib/vscode/out/server-main.js`; VS Code's inner deps are
  resolved upwards from that root (`vscode/lib/vscode/node_modules` → package `node_modules` → `<profile>/node_modules`).
  The legacy full tree (`@jinsiyu/dshcs-code-server/code-server`) is still recognised as a fallback;
- **runtime layout self-healing** (`ensureRuntimeLayout()` in `lib/native.js`, idempotent, run **at activation before
  `envCheck` and again before every start**): the host adds two kinds of **junctions** (Windows junctions / POSIX dir
  symlinks) into the tree:
  1. `ensureAliasLinks()`: re-links the native aliases the aggregator carries into `<tree>/node_modules` — pnpm nests
     `os`/`cpu`-gated packages under the aggregator's own `node_modules`, and `lib/vscode/out/server-main.js` uses
     **ESM imports** (ESM ignores `NODE_PATH`), so a missing link means an immediate 500;
  2. `ensureInnerModuleLinks()`: restores VS Code's **inner dependency directories**
     `lib/vscode/node_modules` and `lib/vscode/extensions/node_modules` from the two `package.json` files — the trimmed
     tree ships neither, and code that builds dependency paths explicitly (e.g. the bundled TypeScript extension looking
     for `<ext>/../node_modules/typescript/lib/tsserver.js`) otherwise reports
     "VS Code's tsserver was deleted by another application…" (measured with 1.136.1).
> **Size note**: the plugin tarball is **~110KB**; `@jinsiyu/dshcs-vscode-server` is **~60MB** (~197MB unpacked);
> the 16 native packages add ~250MB. A full install downloads roughly 310MB. Neither `vendor/` nor `repack/` is committed to git (see `.gitignore`).

> **Upgrading from ≤ 0.1.43**: the tree package changed from `@jinsiyu/dshcs-code-server` (the full code-server tree with
> `out/node` and 136 runtime deps) to `@jinsiyu/dshcs-vscode-server` (the trimmed tree). **The new code defaults to
> `serve: loopback`, which behaves exactly like 0.1.43**; switch to `serve: dsh` for same-origin mounting. The install
> command is unchanged (`dsh plugin --profile web add dsh-code-server-app@<version>`), and pnpm drops the old
> `dshcs-code-server` sub-package.
### Development: install from source (changes take effect immediately)

```powershell
dsh plugin --profile web add C:\Users\User\Desktop\dsh-code-server-app
```

> A source path installs via `link:`. On a dev machine without `vendor/code-server`, run
> `pnpm run vendor:vscode -- --dev-links` first. Dependencies (inner JS deps + the platform aggregator) are installed by pnpm
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
| **MSVC build tools** | **VS Community 2026 + C++ desktop workload** | ❌ **not needed** | pack time (16 native packages) |
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

### Upgrading the VS Code tree (upstream = a code-server release)

- **The version is decided at pack time**: `pnpm run vendor:latest` (= `--force`) pulls the tree of the npm **latest**
  release; or use `pnpm run vendor:vscode -- --version 4.136.2` / `DSHCS_CODE_SERVER_VERSION`.
  With an existing `vendor/vscode`, a plain `pnpm pack` never upgrades (it is a no-op).
- **Check first**: `pnpm run vendor:check` prints the bundled version / upstream latest.
- **A version bump means rebuilding and republishing the sub-packages** (all with the same script):
  1. `pnpm run repack:build -- --target win32-arm64,win32-x64 --pack` → the new tree package
     (`@jinsiyu/dshcs-vscode-server@<new version>`) and the natives rebuilt against the new inner dependencies (the
     script also rewrites the plugin's pure-JS `dependencies` and both aggregator versions);
  2. `pnpm run republish:repacks` (`pnpm run publish:repacks`) → publish; then bump the plugin version → `pnpm pack`
     → publish the plugin.
- `productPath` (`<quality>-<commit>`, part of the client WebSocket path) is **computed from `lib/vscode/product.json`**,
  so upgrading the tree needs no code change — but the routes are registered at activation, so restart `dsh web` afterwards.
- **No runtime auto-upgrade anymore**: nothing fetches latest at startup; the version is fully determined by the bundled artifact.
- Bundled locally right now: the tree of `code-server@4.136.2` (VS Code 1.136.1, `productPath=stable-8d5f383f…`).

### Compatibility with the old install locations

Host probe order: `@jinsiyu/dshcs-vscode-server/vscode` (**the real layout since 0.2.0**) >
`@jinsiyu/dshcs-code-server/code-server` (the full tree, 0.1.40–0.1.43) >
`@jinsiyu/dshcs-code-server-<platform>-<arch>/code-server` (the 0.1.37 platform sub-packages) >
the in-package `vendor/vscode` > the in-package `vendor/code-server` (development). The old install root
`<profile>\.code-server-app` is only mentioned in a startup log line; nothing writes to it any more.
## Settings card (Settings → Plugins → Code Server)

Modeled after dsh-auto-open-web's custom card, registered on the `settings.plugin.item` slot,
persisted via the official settings domain (`settingsScope`, namespace `code-server`) into the official settings document:

| Key | Default | Description |
|---|---|---|
| `claimExtensions` | `*;!md;!markdown;!html;!htm;!png;!jpg;!jpeg;!gif;!webp;!bmp;!ico;!svg;!pdf` | **Claim types** (0.2.11, replaces 0.2.5's `fileOpenScope`): decides by extension which files go to VS Code, semicolon-separated; `*` claims every other type, `!ext` excludes (exclusion wins). The default leaves the four categories DSH's preview renders well (markdown/html/images/PDF) to DSH and sends everything else to the IDE; an empty value claims nothing. **Scope (session vs absolute) is no longer distinguished** |
| `fullscreenOnOpen` | `true` | **Fullscreen on open** (0.2.9): opening the Code Server tab (including clicking a file) switches the right sidebar to fullscreen (fills the window); off keeps DSH's default push mode (side by side with the conversation). Only the moment of opening is affected — a manual "Exit fullscreen" is never fought back |
| `keepResident` | `true` | **Resident in background**: on, the host preloads the IDE into a parked surface right after start — switching tabs or collapsing the sidebar never reloads it and the first open needs no cold start; off loads it only when the panel is opened (saves memory) |

(Since 0.2.9 the card keeps only those three settings; `windowedOpen` and `reserveComposer` are gone — leftover keys in an old
settings document neither fail nor apply. `serve` remains a key in the settings namespace (usable from a settings document) but
has **no card row** — see "Serving mode".)

> Card changes take effect immediately via `scope.watch` (the host status API returns `keepResident`, `claimExtensions` and
> `fullscreenOnOpen`; the client applies them at once); no dsh restart needed. **After adding new setting keys, restart dsh web before first use**,
> so the host re-registers the settings namespace (schema includes the new key); otherwise save/validation of the new key won't work.

Since 0.2.7 the card has **no** "Entry", "dependency install" or "environment check" rows: the entry lives in the sidebar's
guide page (and in DSH's own file clicks), and diagnostics stay out of the UI — the `/api/code-server/status` `env` field still
reports the tree version / `productPath` / server entry, VS Code inner dependencies and **prebuilt native packages**
(platform aggregator name + resolved module count) for scripts, and the DSH host log carries the `[code-server]` lines.

## Config (`config` in cordis.patch.yml; all have defaults)

| Key | Default | Description |
|---|---|---|
| `bin` | `code-server` (placeholder) | Launch priority: explicit `bin` in config > the tree package `@jinsiyu/dshcs-code-server/code-server/out/node/entry.js` > the old platform sub-packages `@jinsiyu/dshcs-code-server-<platform>-<arch>` > the in-package `vendor/code-server` > the old install root `.code-server-app` > plugin-internal `node_modules` > `code-server` on PATH. None present → startup error with troubleshooting hints |
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
- The right-sidebar tab, guide entry box, file-address claim, and settings card behave the same as in web (code-server remains an
  iframe to the local `http://127.0.0.1:<port>`; the desktop renderer uses `webSecurity: true` with no CSP, so the cross-origin iframe loads).
  The desktop build ships `dsh-client-ui-sidebar-right` in its seed package set as well, so the 0.2.3 "right-sidebar DSH only" rule is
  not a regression for desktop; the only difference is the missing `webServer`, where `serve: dsh` falls back to loopback.
- Install into the desktop profile through the **desktop plugin manager** (not the CLI, see below).
- **Desktop installs face a 24-hour supply-chain policy (measured 2026-09-10; this is how 0.2.4 got installed)**:
  - the CLI path is unavailable: `dsh plugin --profile desktop …` is rejected (*"profile "desktop" is managed exclusively by the
    Electron application"*), so desktop installs only go through the app's package transaction (`pnpm add <spec> --save-exact`,
    executed in `~/.dsh/desktop/staging/<uuid>/profile` before activation);
  - that transaction's pnpm (the app bundles **11.7.0**, patched by DeepSeek) runs a **lockfile supply-chain verification** before
    `add` ("Verifying lockfile against supply-chain policies (717 entries)") which requires packages to be **at least 24 h old**,
    otherwise `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`;
  - **the two stages behave differently (measured)**:
    - verifying an **existing lockfile**: `minimumReleaseAgeExclude` is *not* honoured (exact versions and bare package names
      were both tried);
    - **resolution** (no lockfile to verify, e.g. after `pnpm clean --lockfile`): the list *is* honoured, and pnpm even appends
      entries itself (the install log prints *"Added N entries to minimumReleaseAgeExclude…"*);
  - so the working recipe for a **just-published** (<24 h) version on desktop is to start from a clean, lockfile-free profile:
    1. `pnpm clean --lockfile` (**note: it also deletes `node_modules`**, leaving the profile to be reinstalled);
    2. with the app's bundled runtime, run `add <spec> --save-exact --trust-lockfile` in the profile directory
       (runtime/store/config live under `~/.dsh/desktop/pnpm/{store,cache,state,config,home}`,
       `--config.userconfig=…/config/npmrc`, otherwise pnpm fails with `ERR_PNPM_UNEXPECTED_STORE` /
       `…UNEXPECTED_VIRTUAL_STORE`);
    3. the app's boot command (`install --offline --frozen-lockfile --trust-lockfile`) then passes (lockfile matches
       package.json, packages are in the store); if the plugin name is already in `dsh.profile.bundles` nothing else is needed.
  - do **not** try to bypass it with `minimumReleaseAge: 0`: it does clear the check, but that key is **not** one of the policy
    sections the app tolerates (`project-manager.ts` ignores only `minimumReleaseAgeExclude:` / `trustPolicyExclude:` and validates
    the manifest before every `mutate()`), so persisting it makes the app fail with
    *"core package mapping does not match desktop-packages.json"*.
  - Alternatively **wait out the 24 h** and install normally from the plugin manager. The web profile is unaffected: its
    `pnpm-workspace.yaml` sets `minimumReleaseAge: false`.
  - this plugin's closure contains platform native sub-packages (`@jinsiyu/dsh-code-server-runtime-win32-*`) published together with
    the plugin itself, so every new version hits that policy on desktop.
- **Desktop client bundles are cached by Electron; restarting the app does not guarantee a new one** (measured 2026-09, hit while shipping 0.2.5):
  - symptom: `lib/client.js` in the profile is the new version, yet the renderer keeps running the old code —
    `%APPDATA%\@deepseek-ai\dsh-desktop\Code Cache\js` only contains strings unique to the old version (e.g. `dshcs-artifacts`)
    and none unique to the new one (`claimExtensions` / `fullscreenOnOpen`), and `Cache\` still holds an old response body referencing
    `dsh-code-server-app`. The same applies to first-party plugins (the cached `ui-deliverables` even lacks the current
    `data-presented-files-row` marker);
  - diagnosis (byte level — do **not** use `Select-String`, which reads files with the console encoding and gives false
    negatives on non-ASCII markers): search `Code Cache\js` for an **ASCII** marker unique to the new version
    (since 0.2.11 ours is `claimExtensions`); a hit proves the new bundle really was compiled;
  - fix: fully close the app, delete the `Cache`, `Code Cache` and `GPUCache` directories, then start it (cache only —
    profiles, sessions and settings are untouched):
    ```powershell
    Remove-Item -Recurse -Force "$env:APPDATA\@deepseek-ai\dsh-desktop\Cache","$env:APPDATA\@deepseek-ai\dsh-desktop\Code Cache","$env:APPDATA\@deepseek-ai\dsh-desktop\GPUCache"
    ```
  - scope: this is not specific to this plugin — **any** client plugin may keep running old code after an upgrade;
    after a release, confirm with the marker trick above that the renderer actually swapped bundles.

## File-open plumbing (what the plugin itself still does)

DSH's own chips and preview buttons are what users click (see "Opening files" above); this plugin adds no row of its own.
What remains on the plugin side:

- the tab body parses `navigation.address` and posts the absolute path (plus an optional `line`) to
  `/api/code-server/open-file`, which writes a signal file;
- the bundled `dshcs-open-file` extension polls that file and calls `showTextDocument` — VS Code Web has no official
  "open this file from outside" API, so this is the only way to aim the workbench at a file. It is installed as a
  **built-in** extension (in `lib/vscode/extensions`), so users cannot remove it from the extensions panel, and the
  installer re-syncs it whenever its content changes.

## Known limitations

- ~~No sub-path~~ **no longer true (corrected with measurements in 0.2.0)**: the workbench HTML VS Code renders references
  **only relative URLs** (9 references measured, 0 absolute; `serverBasePath="."`, `rootEndpoint="."`), and the client
  builds its WebSocket path from `location.pathname + join(serverBasePath ?? '/', <quality>-<commit>)`. The IDE can
  therefore be mounted directly under DSH's own `/code-server/*` (`serve: dsh`) — no second port, no HTML rewriting.
  Item-by-item evidence: `docs/analysis-code-server-as-dsh-plugin.md`.
- **`serve: dsh` cannot proxy forwarded-port WebSockets**: `registerUpgrade` matches exact paths while `/proxy/:port`
  carries the port in the path, so WebSocket forwarding for the Ports panel is unavailable in that mode (HTTP forwarding
  works). Use `serve: loopback` when you need it.
- **`serve: dsh` shares DSH's origin**, so the iframe is not sandboxed there (same-origin plus `allow-same-origin` is
  escapable by the frame itself); in `loopback` mode the iframe is cross-origin and `sandbox` stays as real protection.
- **Single instance across sessions**: one shared IDE per host; switching cwd requires a restart (the sidebar tab
  handles it and hints).
- **Older DSH versions are unsupported (since 0.2.3)**: on a DSH without `sidebarRightTabs` / `sidebarRight` the plugin
  offers nothing but an upgrade notice on the settings page; older-DSH users should stay on `0.2.2`
  (`dsh plugin --profile web add dsh-code-server-app@0.2.2`).
- **Sidebar tab switching** (no longer reloads since 0.2.2): DSH's right sidebar renders only the active tab's body, and
  a React unmount moves the iframe away; the plugin keeps it as a singleton resident surface and shuttles it between the
  dock slot and a document-level park container with `Element.moveBefore()` (a state-preserving atomic move), so
  switching tabs or collapsing the sidebar and back **does not reload** it. Browsers without `moveBefore` fall back to
  the old behaviour (`appendChild` → full reload), reported as `degraded`; see "Why switching tabs no longer reloads".
- **Remote access**: with `serve: dsh` the browser only needs to reach DSH itself (one port, protected exactly like `/api`);
  `serve: loopback` stays loopback-only with `auth: none`, and 0.2.0 no longer supports `auth: password`.