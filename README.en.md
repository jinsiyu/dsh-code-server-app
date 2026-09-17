# dsh-code-server-app — Integrate code-server (VS Code in the browser) into DSH

> Source repository: see `repository` / `homepage` in `package.json`.

> ## ⚠️ Extension Marketplace Note (important)
>
> - **code-server's extension store is [Open VSX](https://open-vsx.org/), not the Microsoft Visual Studio Marketplace**;
> - Microsoft's Marketplace terms **prohibit third-party products (including code-server) from using its API**, so code-server cannot query Microsoft's extension list;
> - As a result, Microsoft **commercial/proprietary** extensions (e.g. **GitHub Copilot, the Remote series like Remote-SSH, Azure tools, IntelliCode**) are **not available** in the store — this is Microsoft's distribution policy, not a defect;
> - Microsoft **open-source** extensions (Python, TypeScript debugger, ESLint, …) are mirrored on Open VSX and install normally by search;
> - **If you need a proprietary Microsoft extension**: download the `.vsix` from the Marketplace page and install it manually with `code-server --install-extension <file>` (or drop it into `--extensions-dir`).

A static profile plugin (npm package with host + client bundle) that ships the **VS Code server tree** from a [code-server](https://github.com/coder/code-server) release as a **platform-independent dependency package** (pack-time artifact `vendor/vscode` → `@jinsiyu/dshcs-vscode-server`, no install scripts, no postinstall). The code-server **Node service layer is replaced by the plugin's own `lib/launcher.mjs`**: it drives `<tree>/lib/vscode/out/server-main.js` (`loadCodeWithNls()` / `createServer()` / `handleRequest()` / `handleUpgrade()`) directly and re-adds the few HTTP endpoints code-server used to provide (`/healthz`, `/manifest.json`, `/_static/*`, `/proxy/:port`). The 16 native modules (node-pty / @vscode/sqlite3 / spdlog / …) come from `@jinsiyu/dshcs-*` sub-packages declared **directly on the plugin's dependency table** under their real names (os/cpu-gated per target), with the original import names restored by runtime junctions. VS Code's inner dependencies and the prebuilt native modules are **all installed by the package manager together with the plugin** — no global npm install, no `bin` configuration, no profile config changes, no second install command, **no argon2/C++ toolchain**.

> Since 0.3.22 the ask panel renders the session's new content with **DSH's own Markdown renderer** (the same
> renderer and design tokens as the DSH UI; new content only) and can **answer approval requests in place**
> (writing outside the workspace / running commands). See "Working with DSH: the editor bridge" and section 21 of
> `docs/analysis-code-server-as-dsh-plugin.md`.

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
  To use the IDE in a browser tab, **copy the full address** from the settings card / empty-state hint (it contains the
  path token: `http://127.0.0.1:<port>/<token>/`; under `serve: dsh` it is DSH's `/code-server/`) — dropping the token
  segment yields a 404.

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
| **`loopback` (default)** | the plugin listens on its own loopback port (**`port: 0` by default = a random port assigned per start**), the sidebar iframe connects cross-origin, and the URL carries a **random path token** (`http://127.0.0.1:<port>/<token>/`, see "Security model of the loopback port" below); the process can be adopted after a DSH host restart | nothing |
| **`dsh`** | the IDE is mounted on **DSH's own HTTP port** at `/code-server/*` (HTTP prefix route) plus `/code-server/<quality>-<commit>` (exact WebSocket route), forwarded to the launcher's **named pipe**; **no extra port**; every request (including the WS handshake) first passes `ctx.connection.requestRejection()` — the same Host/Origin fence and browser-cookie authentication as `/api` | DSH providing `webServer` (web profile); desktop falls back to loopback automatically |

### Security model of the loopback port (since 0.2.14)

`loopback` is the only transport desktop has (no webServer, no same-origin mount), so it is hardened on its own:

- **Random port**: `port` defaults to `0` → the OS assigns a free port and the launcher writes the **actual** one to
  `$DSH_HOME/code-server/endpoint.json`, which the host reads back. The port therefore changes on every start and the old
  "8090 is busy" class of conflicts is gone. Pin `port` explicitly if you need a fixed address.
- **Path token**: a fresh 32-character token (`[0-9A-Za-z_-]`, 24 random bytes) is generated on every **new start**, stored in
  `$DSH_HOME/code-server/path-token` (inside the user profile, readable only by the owner under the default ACL), and becomes
  the URL path prefix. Requests without that prefix get a plain **404** (nothing reveals that an IDE lives there); a prefix
  without the trailing slash is answered with a 302.
- **Why not VS Code's own `connection-token`**: it works through `?tkn=` → 302 + `Set-Cookie: vscode-tkn; SameSite=Lax`.
  The desktop iframe is **cross-origin** (`dsh-app://` → `127.0.0.1`), and a Lax cookie is not sent from a cross-site
  subframe — the IDE would simply fail to load. A path prefix needs no cookie at all: the workbench derives every asset and
  WebSocket URL from `location.pathname` (the same mechanism already proven by mounting under `/code-server/` in `serve: dsh`),
  so the prefix rides along on every subrequest and on the WS handshake. (Verified with a real Edge + CDP run: with a random
  port and a token, the workbench renders **inside a cross-origin iframe** and establishes its WebSocket.)
- **Host allowlist**: in loopback mode only `127.0.0.1 | localhost | [::1] : <actual port>` is accepted. This is what stops
  DNS rebinding, whose requests can arrive without an `Origin` header and therefore slip past the `Origin == Host` check.
- **`Referrer-Policy: no-referrer`**: the token lives in the path, so it must not leak through `Referer` when external resources load.
- **The token never reaches argv or the logs**: command lines are readable by any local process, so it travels through a file;
  the log only says "enabled".

Boundary, stated plainly: this layer stops other local applications, port scanners and browser pages from casually reaching
your IDE. A **malicious program running as the same user** can already read your files and that token file — that is outside
this plugin's threat model.

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


## Working with DSH: the editor bridge (since 0.3.0, on by default)

Having the IDE next to DSH and having the agent **know what is going on in the editor** are two different
things. The editor bridge covers the second half: it is a **read-only** channel that hands the agent what
only the editor knows, and lets editor gestures drive the current session.

| Direction | Capability | Mechanism |
|---|---|---|
| editor → agent | **unsaved buffers** (disk ≠ what the user sees), active file and selection, **language-server diagnostics** with `file:line`, source and code | agent tools `editor_context` / `editor_diagnostics`; plus a notice attached before writing a dirty file |
| editor → DSH | select code → context menu **"DSH: ask about selection"** → an **ask panel** opens (carrying `file:line` and the selection); the question enters the current session as **user input**, and that session's **new content** is rendered in the panel by DSH's own Markdown renderer | extension command `dsh-code-server.askAboutSelection` (one of the **top two** editor context-menu items) + a webview panel + `POST /ask` + the `thread` field of `/sync` |
| DSH → editor (approval) | when the agent wants to **write outside the workspace or run a command**, the approval request shows up as a card in the panel (tool, reason, countdown); "allow once" / "reject" takes effect immediately | the `approvals` field of `/sync` + `POST /approve` (the bridge's **only** non-read-only route; constraints under "Security model") |
| agent → editor | the agent changed a file → a **native diff** opens; if that buffer has unsaved changes you get a warning and **no overwrite** | host watches `tools/result`, the extension polls and opens the diff |

- The tools are only registered while the bridge is live (so the model never sees an unusable tool), and the
  system-prompt section renders only then too.
- **Ask panel** (extension 0.2.0; the official renderer since 0.2.3; a **floating dialog over the DSH UI since
  0.2.5**): the context-menu command no longer opens a panel inside the editor (that is always a tab or a column,
  never a dialog) — the plugin's client half pops up a draggable, resizable floating chat window in the DSH page
  itself (bottom-right, ✕ closes it), leaving the editor layout alone. Hosts without that capability fall back to
  the in-editor webview panel. The selection can still be changed while the dialog stays open.
  The two commands **remember their intent** (0.3.21): "ask about selection" carries a **line range + selection text**
  only when something is actually selected, while "ask about file" **never carries line numbers or a selection** — the
  cursor line is irrelevant to the question and only misleads the agent. With no selection, the selection command also
  degrades to the plain file.
- **Injected context is collapsed** (0.3.24): the location line plus the selection code block the bridge adds to the
  message are split out into a collapsed Context row (click it to see the code), while the bubble keeps only the user's
  own words — the same treatment the DSH UI gives injected context.
- **The panel renders exactly what DSH renders** (0.3.22): the panel bundles DSH's official Markdown renderer
  (`MarkdownText` from `@deepseek-ai/dsh-client-ui-primitives`) plus the official design tokens — the same
  micromark/mdast pipeline, the same incremental streaming parser, the same shiki highlighting (boot set:
  typescript / shellscript / json), KaTeX math and the same heading/table typography. Only **new content** is
  rendered (from the moment the panel subscribes); history is **not replayed** and there is no "load earlier".
- **Thinking shows up like in DSH** (0.3.23): assistant reasoning becomes a Think row — **collapsed by default**,
  showing its first line (or the latest line while streaming) and expanding on a row click, built from the official
  `DisclosureRow` plus the official think icon and typography language.
- **Approvals are handled right in the panel** (0.3.22; window fixed in 0.3.23): while the panel is open, that
  session's approval requests ask the panel first (5 minutes by default). Clicking "allow once" / "reject" settles it
  immediately; **closing the panel** or letting the window expire hands the request back **unchanged** to the official
  path (the DSH UI shows the same card). 0.3.22's 8-second window was far too short for a human — the buttons went
  grey before anyone could click (reported as "the approval box stopped working"); the window is now 5 minutes and
  closing the panel hands off immediately instead of waiting it out.
  **Nothing is ever auto-approved** — `allowed-once` can only come from a click, and there is no "always allow".
- The question enters the DSH session as a **plain user message** (`source: { kind: 'user' }`, host 0.3.19): earlier
  versions used `{kind:'plugin'}`, which DSH renders as a *context update* — it did not look like something the user
  said. Provenance stays in the first line of the text: `From the editor: <file>[:<line>]`.
- **Read-only with one constrained exception**: the bridge never writes files, applies edits, or runs commands; the
  single non-read-only route is `POST /approve`, which can only **answer an approval request that already exists**
  (see invariant 2 below). The agent's writes still go through its own `fs` tools; the bridge only *knows about* them
  and carries your answer back.
- Status bar shows `$(plug) DSH` while connected (click it for the log in the "DSH Editor Bridge" output channel).
- **The extension ships as a built-in** (fixed in 0.3.12): `dshcs-editor-bridge` is installed into
  `<tree>/lib/vscode/extensions/` next to `dshcs-open-file`. 0.3.0–0.3.11 installed it as a *user* extension
  instead, and the VS Code server marks any extension that sits in the user extensions folder but in no profile
  manifest as removed (`.obsolete`, log line `Marked extension as removed`) and then skips it forever — re-marked on
  every start, so **the bridge never reported any state**. To turn the bridge off use the plugin setting
  `editorBridge=false` (no mount, no tools) rather than uninstalling the extension from the Extensions view.

### The channels (since 0.3.13 over **local IPC**: a Windows named pipe / unix socket)

```
extension → host   POST /code-server-bridge/sync    one round trip: push editor state (+ which session the panel watches) + take events and thread deltas
extension → host   POST /code-server-bridge/ask     push an editor question into the current session
extension → host   POST /code-server-bridge/approve answer an approval request that **already exists** (the only non-read-only route)
extension → host   GET  /code-server-bridge/health  unauthenticated liveness probe
extension → host   POST /code-server-bridge/event   extension reports open/close etc. (host log tail)
host → extension   <extensionsDir>/.dshcs-bridge/bridge.json   endpoint + token, re-read every 5s
                   (the same content is also written **next to the built-in extension** in
                   `<tree>/lib/vscode/extensions/.dshcs-bridge/` — the env var is only injected when the host
                   spawns the IDE, and an **adopted** IDE is a process from an earlier start that never saw it,
                   so the extension must be able to find the config from its own location alone)
```

Requests use `http.request({ socketPath })` (`fetch` has no socket support) and **no port is ever opened**.

The three `/sync` fields the panel actually consumes (0.3.22):

| Field | Content | How the panel uses it |
|---|---|---|
| `thread` | **new content** entries (user / assistant / tool / approval) of the session the panel watches; bounded: ≤120 entries per session, ≤8000 chars per body, ≤4 watched sessions | assistant bodies go to the official renderer; tools and approvals become compact summary rows |
| `approvals` | pending approval requests `[{id, toolName, reason, at}]` (≤4) | renders the card with a countdown; a click posts `/approve` |
| `approvalHoldMs` / `uiVersion` | the approval window (300000 ms = 5 minutes by default) / the DSH UI version | countdown basis; a renderer-version mismatch is surfaced in the panel |

> **Why not HTTP (settled in 0.3.13, all three measured)**
> 1. **Desktop has no HTTP surface at all**: the renderer calls `host.fetch()` through Electron IPC
>    (`createSharedFetchHandler('/api')` in `apps/desktop-host/src/index.ts:308`) — an in-process call, unreachable
>    from another process; the only HTTP a plugin can mount is the web profile's `webServer`.
> 2. **`/api` cannot carry it either**: Connection puts a Host/Origin/cookie fence on `/api`
>    (`requestRejection` in `packages/client/connection/src/index.ts` → 401 without a cookie), while the bridge's
>    client is a **Node process inside the extension host** — it can never hold a browser cookie. Measured on 0.3.7:
>    polling `/api/code-server/bridge/sync` returned either 405 (it reached the launcher/VS Code) or 401 (the fence)
>    — the bridge had never actually synced.
> 3. The two ends are **processes on the same machine** anyway (extension host ← the IDE the plugin spawned ← the
>    plugin). Local IPC is strictly smaller than a port: no network surface, no Host/Origin confused-deputy path, and
>    **web and desktop share one path**. Token auth stays (see below); the Windows pipe name carries a random suffix
>    and the POSIX socket file is `chmod 0600`.
>
> History: 0.3.9–0.3.12 mounted it on DSH's `webServer` prefix — which left desktop permanently dormant.

**Why state is pushed, not pulled**: the extension host is a child process of the VS Code server and **listens on
no port** — the host cannot call into it. Editor state therefore rides the extension's own polling request, and
the host caches it for the tools (at most one 600 ms cycle behind; older than 10 s and the tool says so instead
of passing stale data off as fresh).

**Why no SSE/WebSocket**: the extension host has no HTTP server of its own; the bridge's shape is one
request/response round trip every 600 ms. Polling also buys two useful properties: it is idempotent (a dropped event
only costs one notification — the data always lives in the editor) and the cached state is inherently fresh.

### Security model (five invariants; read before touching `lib/bridge.mjs`)

The token lives in `<extensionsDir>/.dshcs-bridge/bridge.json`, **readable by any process of the same local
user**, so:

1. **`/code-server-bridge/*` is read-only, with `/approve` as the single exception.** No route writes files,
   edits documents, runs commands, or spawns processes. A leaked token is therefore bounded to "sees information
   that is in the editor" and **can never** become arbitrary file writes or command execution. A whitelist
   assertion in `scripts/test-bridge-routes.mjs` guards this.
2. **The four constraints on `/approve`** (drop one and it becomes an arbitrary-command-execution back door):
   (a) it can only **answer** an approval request that already exists — the body is exactly `{id, outcome}`, with
   **no free text, paths, or command arguments**, so it can answer questions but never start an action;
   (b) `id` must belong to a request this process created and that is **still pending** (single use);
   (c) `outcome` accepts only `allowed-once` / `rejected` — there is **no "always allow"**;
   (d) when no panel is watching, the panel is closed, or the window (5 minutes by default) expires, the request goes
   **back to the official
   path** — never auto-approved (DSH's `approval/request` itself fails closed; this bridge can only keep
   "nobody answered" as "nobody answered"). `pnpm test:webview` asserts these four plus the host-side whitelist.
3. **Any request carrying `Origin` gets 403.** Browsers always send one (including a sandboxed iframe's literal
   `Origin: null`); the Node extension host never does. Origin is checked **before** the token — otherwise the
   bridge would be a "did you guess the token right" oracle for a web page.
4. **Paths are confined to the editor's current workspace folders.**
5. **Everything is bounded**: 200 diagnostics, 500-char messages, 256 KB request bodies, a 64-entry event ring,
   ≤120 thread entries per session (≤8000 chars each, ≤4 watched sessions) and ≤4 pending approvals.

This layer stops "another local app or a browser page that got hold of the file". A malicious program running as
the same user could read your files and the token anyway — that is outside this plugin's threat model, exactly
as stated for the loopback port.

### Turning it off / diagnostics

| How | Effect |
|---|---|
| `config.editorBridge: false` in `cordis.patch.yml` | next start writes no `bridge.json` and registers no tools |
| `code-server.editorBridge: false` in the settings document | **immediate**: config removed, tools unregistered, the extension goes dormant |
| disable the `dshcs-editor-bridge` extension inside the IDE | the bridge simply becomes unavailable |

Diagnostics: `GET /api/code-server/status` exposes
`bridge: { enabled, live, toolsRegistered, supported, url, file }` — **never the token** (that only exists in the file).

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

- code-server's workspace **follows the active DSH session/workspace**: switching sessions/workspaces while the IDE is open moves code-server to the new directory
  (resolution order: current session cwd → session's `workspace.path` → workspace of the most recently active session → first workspace.path;
  **where "the current session" comes from depends on the DSH version**: ≥ 0.1.6-alpha.2 reads the session-scoped standard prop `sessionId`,
  ≤ 0.1.6-alpha.1 falls back to `current` on the session-list snapshot — see the 0.3.48 bullet below; the logic lives in `src/workspace.js`
  and the contract for both shapes is pinned by `scripts/test-client-bundle-cwd.mjs` directly against the built bundle);
  the opened directory is shown inside code-server (`?folder=<cwd>`, the page reloads when following a switch);
  implementation note: the iframe `src` must carry `?folder=<cwd>` — code-server's front-end remembers the "last workspace" and restores it by itself;
  a bare root URL only shows the previously opened directory and does not follow switches (verified locally).
  **Windows path format (verified)**: the `folder` parameter must start with `/` and use forward slashes only, e.g. `/C:/Users/User/Desktop/biss`;
  a bare Windows path (`C:\...`) is parsed as a URI scheme and the drive letter is stripped (page shows `\Users\User\...` with an empty file tree),
  while `file:///C:/...` reports "Workspace does not exist".
- **0.3.48 fixes "opening Code Server no longer opens the matching workspace"**: DSH **0.1.6-alpha.2** removed `current`
  from `SessionListState` (upstream refactor: view selection remains outside the Controller), while 0.3.46 and earlier read
  the current session from `useSessions(s => s).current` — so the cwd was always undefined, the client **stopped sending `cwd`**
  to the host, and the IDE started with an **empty workspace** (measured locally: `cwd`/`launchCwd` both empty in
  `$DSH_HOME/code-server/pid.json`, with nothing visible in the UI). Since 0.3.48 it reads the session-scoped standard prop
  `sessionId` (the same source DSH's own right-sidebar tab uses — `ui-deliverables`' ReviewTab does
  `useSessions(s => s.byId[sessionId]?.cwd)`), keeping the old `current` as a backward-compatible fallback; when neither
  source resolves, it **does not guess a directory** (no cwd is sent, the workbench keeps its current one) and logs a
  `[code-server] 未能解析当前工作区目录…` warning — the silence is exactly what made this bug hard to find.
- **The switch is lightweight (since 0.2.12)**: a running instance is **not restarted** when the workspace changes — the host
  only updates `state.cwd` and the workbench re-navigates with the new `?folder=` (the workspace directory was always the
  client URL's business; the process cwd only affects the server's own relative-path resolution at spawn time). The switch is
  much faster and no longer throws away the extension host, background tasks or server-side state.
  - In `status`, `cwd` is the current workbench directory; `launchCwd` is the directory the **process was started with**
    (diagnostics only; it does not change on a switch).
  - The trade-off, stated plainly: background processes/terminals started by the IDE in the **old** directory are no longer
    killed automatically (a full restart used to take them with it) — clean them up yourself if needed. That is the same coin
    as "nothing is lost".
  - The trigger does not depend on the tab being visible: **the tab body is not unmounted while the sidebar is collapsed**,
    so it also follows in the background (behaviour deliberately kept in 0.2.12).
  - Regression: `scripts/test-workspace-switch.mjs` (5 assertions: adopting an instance, cwd change keeps pid/status, the
    process stays alive, same-directory idempotence, no-cwd does not switch; it fails again if the old behaviour returns).
- Process lifecycle is managed by the host plugin: startup writes `$DSH_HOME/code-server/pid.json`, stop kills the tree (`taskkill /T` or process-group SIGKILL),
  crash/exit updates status live; after a DSH host restart the plugin **adopts** a still-running instance (verifies pid + `/healthz`), without duplicate start or killing unrelated processes;
- `node_modules` and the pack-time artifact `vendor/` are git-ignored; after cloning, follow
  "Install the plugin (script-free install; code-server bundled)" below — `pnpm install` → `pnpm run build:client` →
  `pnpm run vendor:vscode` → `pnpm pack` + `dsh plugin --profile web add`.

> Verified locally (BM: Windows 11 ARM64): the whole tree/dependency chain hangs directly off the plugin's
> dependency table — the tree package `@jinsiyu/dshcs-vscode-server` (currently 4.137.0, a 50.8 MB tarball),
> the pure-JS inner dependencies plus the 8 platform-independent repacks in `dependencies`, and the 8
> platform-specific repacks (win32-arm64 / win32-x64) in `optionalDependencies` with their own os/cpu gates;
> the original names are restored by junctions created at runtime (`lib/native.js`)
> → healthz 200 → stopped → fully recycled.
> (The 0.1.37-era "one big platform package" layout is gone — see "Upgrading the VS Code tree" below.)

## Packaging (how to build the tarball)

```powershell
cd C:\Users\User\Desktop\dsh-code-server-app
pnpm install             # dev deps (esbuild + the official-renderer bundling deps); allowBuilds is explicit → no postinstall runs
pnpm run build:client    # src/factory.js → lib/client.js (not committed; must be built first)
pnpm run build:webview   # ask panel: official Markdown renderer + panel shell → webview/thread.{js,css} (not committed; must be built first)
pnpm run vendor:check    # optional: show the bundled tree version vs the latest code-server release
pnpm run vendor:vscode                            # ① produce vendor/vscode (the trimmed VS Code tree, ~197MB)
pnpm run repack:build -- --target win32-arm64,win32-x64 --pack   # ② one script builds every sub-package
pnpm run publish:repacks                         # ③ publish every @jinsiyu/* sub-package (default dist-tag: next)
pnpm pack                                        # ④ → dsh-code-server-app-<version>.tgz (~750KB, including the panel renderer assets)
pnpm run publish:plugin                          # ⑤ publish the plugin itself (default dist-tag: next)
# once the user has restarted dsh web and confirmed it works, promote latest:
pnpm run promote -- <version>
```

> **dist-tag policy (mandatory)**: every release goes to **`next`** and **never touches `latest`**;
> `latest` always points at the most recent *confirmed bug-free* version and is only moved by
> `pnpm run promote -- <version>` (= `npm dist-tag add dsh-code-server-app@<version> latest`)
> **after the user restarts `dsh web` and confirms it works**. That way
> `dsh plugin add dsh-code-server-app` (no version) — and anything else resolving `latest` — never picks up an
> unverified build. Sub-packages (`@jinsiyu/dshcs-*`) are referenced by exact versions,
> so their dist-tags do not affect resolution, but they default to `next` as well.
> Inspect the current tags with `npm dist-tag ls dsh-code-server-app`.

> `build:webview` bundles DSH's **official** Markdown renderer and design tokens into the panel assets
> (~1.34MB: 996KB JS + 87KB CSS + 254KB KaTeX fonts), so it needs a local DSH deployment: the script reads the
> `@deepseek-ai/dsh-web-frontend` version from that deployment and compares it with the renderer version pinned in
> devDependencies — a mismatch **fails the build** (unless `--allow-version-mismatch`). Same convention as
> `lib/client.js`: the artifacts are not committed and `prepack` rebuilds them.
> Rationale (why not an iframe, where the tokens come from, size trade-offs) is section 21 of
> `docs/analysis-code-server-as-dsh-plugin.md`.

`repack:build` (`scripts/vendor-repacks.mjs`) is the **single script that produces every sub-package**:

| Sub-package | Content | os/cpu |
|---|---|---|
| `@jinsiyu/dshcs-vscode-server@<code-server version>` | the trimmed VS Code tree (`lib/vscode` + `out/browser` + `src/browser`; **without** code-server's `out/node` and its 136 runtime deps) | platform-independent |
| `@jinsiyu/dshcs-<name>[-win32-<arch>]` ×16 | the VS Code inner packages that need building (node-pty / @vscode/sqlite3 / kerberos / koffi / ssh2 / …) | gated when platform-specific |
| `lib/vendored.json` (**not** a package) | the "original name → repack sub-package" table shipped inside the plugin; `lib/native.js` uses it to create the junctions. Since 0.3.45 there is **no platform aggregator** | — |

| Goal | Command |
|---|---|
| **Build from the latest upstream release** | `pnpm run vendor:latest` (= `--force`): pulls `code-server@latest`'s tree into `vendor/vscode`; afterwards you **must** re-run `repack:build` and republish every sub-package |
| **Pin a version** | `pnpm run vendor:vscode -- --version 4.137.0` |
| **Snapshot from an existing tree** | `pnpm run vendor:vscode -- --from <code-server dir>` (seconds) |
| **Rebuild every sub-package** | `pnpm run repack:build -- --target win32-arm64,win32-x64 --pack` (without `--from` it npm-installs and compiles the source tree itself — slow) |
| **Rebuild only the tree + dependency table** | `node scripts/vendor-repacks.mjs --reuse --target win32-arm64,win32-x64 --pack` (reuses the natives already in `repack/build`; also rewrites `lib/vendored.json` and the plugin dependency table) |
| **Publish sub-packages** | `pnpm run publish:repacks` (`--dry-run` to preview; `--only <substr>` to filter; `--otp <code>` / `--limit N` for 2FA) |
| **Publish the plugin itself** | `pnpm run publish:plugin` (publishes the exact tarball that was verified; no re-packing; default dist-tag `next`) |
| **Promote `latest`** | `pnpm run promote -- <version>` (only after the user restarted and confirmed; `--dry-run` shows the current tags first) |
| **Just report versions** | `pnpm run vendor:check` |

> `pnpm pack`'s `prepack` runs the vendor-code-server script once; when `vendor/code-server` already exists it is
> a **no-op that takes seconds**, so after ordinary code changes you can just run `pnpm pack` (it will never
> silently upgrade code-server). Upgrading code-server requires an explicit `pnpm run vendor:latest`
> (or `--force` / `--version`) **plus** republishing the sub-packages.

## GitHub Actions (CI + tag-triggered release)

Both workflows live in `.github/workflows/`, and the regression list exists exactly once
(`scripts/run-all-tests.mjs`, i.e. `pnpm test`):

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | push to `main` / PR / manual | `ubuntu-latest` + `windows-latest` matrix: `pnpm install --frozen-lockfile` → `build:client` → `build:webview` → `pnpm test` (the whole suite) → `vendor:check` (report only) → upload `lib/client.js` and the panel assets |
| `release.yml` | push a `v<version>` tag / manual (rehearsal, never publishes) | prepares `vendor/vscode` **at the version pinned in `dependencies`** → builds → full suite → `pnpm pack` → verifies the tarball manifest → **really installs it twice** (windows-latest proves the 16 win32 sub-packages, ubuntu-latest the 10 Linux ones: each deploys a real DSH, installs via the official path `dsh plugin --profile web add <tgz>`, then runs the `test:installed` + `dump-config` assertions; both legs must pass before anything is published) → publishes to npm **`next`** → creates a GitHub Release with the tgz attached |
| `linux-repack-probe.yml` | push to this file / manual | **feasibility probe (never publishes; superseded by the Linux legs of `repacks.yml`)**: on Linux, builds the platform-specific repack packages per target (`linux-x64` → `ubuntu-latest`, `linux-arm64` → `ubuntu-24.04-arm`) and reports which modules really produce a `.node` and which are Windows-only. It runs the existing `vendor-repacks.mjs` itself; all writes happen in a copy of the repo under `$RUNNER_TEMP`. **Note**: it emits one notice per module, which hits GitHub's ~20-annotations-per-check-run cap and leaves only the tail; for the full verdict use the Linux legs of `repacks.yml` (one summary line per target) |
| `repacks.yml` | manual (`publish` and `probe_oidc` both default to **false**, the four `build_*` legs default to **true**) / push to this file / push `.github/oidc-probe.enabled` | **builds and publishes the platform-specific sub-packages** (`@jinsiyu/dshcs-*`): one host-architecture runner per target (`win32-x64` → `windows-latest`, `win32-arm64` → `windows-11-arm`, `linux-x64` → `ubuntu-latest`, `linux-arm64` → `ubuntu-24.04-arm`); by default it only builds and uploads `repack/tgz/*.tgz`, and only publishes to npm (default `next`) when `publish` is checked. Ownership and ordering (**five legs, disjoint sets**): the `independent` leg runs **first** (windows-latest; it produces the **VS Code tree package + the 8 platform-independent repacks**, which are the same artifact for all four targets and are therefore published only once); the four platform-specific legs `needs: independent`, build with `--skip-independent` and publish with `--only <their own target>` ⇒ a broken base layer blocks the rest (no half-published state) and no package name is ever published twice. **Auth**: with no `NPM_TOKEN` it uses OIDC (per-package trust entries, all with workflow `repacks.yml` — see below). The Linux legs additionally verify that the `lib/vendored.json` / `package.json` they generate match the committed ones (the platform policy is meant to be host-independent). A `probe-oidc` job additionally does a **staged-only** probe of that OIDC route, so the channel can be proven without publishing anything real |

### Linux support (x64 / arm64): what changed, what is still missing

Supporting Linux is not mainly about "compiling a few more packages" — it is about replacing
**host scanning** with an **explicit platform policy**:

- Upstream packages barely declare `os`/`cpu` (of the 16 modules, only `@vscode/windows-ca-certs` does),
  and the tree manifest lists all 8 native modules as ordinary `dependencies` — so on Linux npm installs
  the Windows-only ones anyway. `analyze()` classifies by "does this host have a `.node`", so **the
  classification drifts with the host**: on Linux `windows-registry` looks platform-independent and would be
  written into `dependencies`, which then makes the Windows runtime look for a `-win32-*` sub-package that
  is not there.
- Therefore `scripts/repack-platforms.json` is the single, human-reviewed declaration: each module's
  `platform` (does it need per-platform packaging) and `targets` (which targets have a sub-package). The
  generator only reads it, and derives from it: the per-module `targets` in `lib/vendored.json` (at runtime
  `lib/native.js` uses them to **skip modules that do not apply to this platform**, instead of reporting
  `dshcs-vscode-windows-registry-linux-x64` — a name that can never exist — as missing) and the plugin's
  `optionalDependencies` (no longer blindly module × every target).
- The generator also now: keeps table entries it cannot see on this host (building only the host target with
  `--target` must not drop the other platforms' modules), **skips** a per-platform package when no `.node`
  was produced for that target (rather than publishing an empty shell), and validates ELF `e_machine` for
  Linux targets (mirroring the PE machine check for win32).
- **Version policy (independent of host *and* of when you run it)**: the version recorded for each module in
  `lib/vendored.json` is **the one we have actually published to the registry**; upstream drift never changes
  it silently. Two measured cases with the same `code-server@4.137.0`: `kerberos` resolves to upstream `2.1.1`
  while we published `2.1.1-dshcs.1`, and `@vscode/proxy-agent` resolved to `0.44.0` for the maintainer but to
  `0.45.0` on a fresh install today (the dependency range allows drift, and `0.45.0` was never published for
  our sub-package). Writing the tree's version would point the plugin's dependency at a version that does not
  exist — an install that simply fails, on a different host or another day.
  **To adopt a newer upstream version**: pin `"version"` for that module in `scripts/repack-platforms.json`,
  re-run `vendor-repacks.mjs`, publish the new sub-packages, then refresh the dependency table and
  `pnpm-lock.yaml`. The generator always prints such drift (`· <module>: 沿用表里已发布的版本 …`), so follow
  that line.
  > Keep the two dependency classes apart: the rule above governs **our own repack sub-packages**
  > (`@jinsiyu/dshcs-*`, whose version must be one we published). **Upstream pure-JS direct dependencies**
  > (the `declare` set: `cookie`, `ws`, `@vscode/proxy-agent`, …) take their version from the source tree —
  > whatever the tree installed came from npm, so following the tree is safe. Differences there are
  > **time**-related (a fresh install of the same commit on another day can differ), which is why
  > `repacks.yml` reports them as a notice rather than a warning.
- **System headers needed to build the native packages on Linux**: `kerberos` needs the GSSAPI headers
  (`gssapi/gssapi.h`), so both Linux legs run `sudo apt-get install -y libkrb5-dev` and assert the header is
  present. Without it `make` fails outright and the `kerberos` sub-package cannot be produced (exposed by the
  hard gate on 2026-09-16). Do the same before re-packing locally on Linux.
- **Measured on Linux** (both legs really compile; the verdict line reads
  `[repack] linux-x64: 平台专属产出 5 个(…)`): five modules produce a `.node` —
  `@vscode/deviceid`, `@vscode/native-watchdog`, `@vscode/spdlog`, `@vscode/sqlite3`, `kerberos`;
  `windows-ca-certs` / `windows-process-tree` / `windows-registry` are Windows-only (whitelisted for
  `win32-*` and reported as "excluded by the whitelist" on Linux). The earlier manual probe
  `linux-repack-probe.yml` has been **removed**: its job (build without publishing) is now done by these two
  legs, and its per-module notices hit GitHub's ~20-annotations-per-check-run cap, so only the tail was
  readable.

**Linux go-live status (updated 2026-09-17)**:

1. ✅ **The 10 Linux sub-packages are published** (5 modules × x64/arm64). A trust entry cannot exist before
   the package does, so the maintainer did the first publish locally with 2FA (`npm login --auth-type=web`,
   then one `npm publish <tgz>` per package). Versions match `lib/vendored.json` exactly, and
   `os=linux` / `cpu=x64|arm64` were verified against the registry.
2. ⏳ **Add one trust entry per new package name** (one command each; browser confirmation is enough,
   **no OTP needed**):

   ```powershell
   $env:npm_config_auth_type = 'web'; npm login     # skip if already logged in
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
   Afterwards you can **delete `NPM_TOKEN`** from the repository secrets — CI then uses OIDC and will no
   longer hit the "token without bypass 2FA ⇒ EOTP" trap (which only mattered for first-publishing a name).
3. ✅ **The dependency table is wired up**: `publishedTargets` in `scripts/repack-platforms.json` now includes
   `linux-*`; `package.json` has **26** `optionalDependencies` (16 win32 + 10 linux, derived from
   "per-module whitelist ∩ published targets", verified item by item by `test-vendored-table.mjs`);
   `pnpm-lock.yaml` was refreshed (10 additions, nothing else changed); and the 10 `@version` pairs were
   added to `minimumReleaseAgeExclude` in `pnpm-workspace.yaml` (freshly published packages are held back
   by the supply-chain cooldown otherwise).

   > What remains is our own release flow: bump the plugin version → `pnpm pack` → install once locally via
   > `dsh plugin --profile web add <tgz>` → tag it and let `release.yml` publish. On Linux, `lib/native.js`
   > then links the `-linux-*` sub-packages back to their original names through the same junction path
   > Windows already uses.

The regression suite (also the single list CI uses) is:

```powershell
pnpm test                    # runs them all: scripts/run-all-tests.mjs
pnpm test:apply              # apply() under a stub ctx
pnpm test:claim-types        # claim-type syntax and defaults
pnpm test:bridge-routes      # bridge route whitelist / Origin-vs-token order / token header agreement
pnpm test:bridge-extension   # extension-side pure logic (dirty buffers, diagnostics, diff, delivery, panel state)
pnpm test:webview            # panel bundle: official renderer + tokens, version match, the four /approve constraints
pnpm test:launcher-routes    # launcher HTTP surface (spawns a real process; slow)
pnpm test:workspace-switch   # switching workspaces does not restart the process
pnpm test:fullscreen         # opening the tab goes fullscreen
pnpm test:vendored           # repack table ↔ plugin dependency table (no npm: aliases, no aggregator)
pnpm test:installed          # install smoke: assert on what was **installed into a profile**
                             # (default <DSH_HOME>/profiles/web): every `files` entry present, repack
                             # packages complete for this platform, no missing natives, the installed
                             # copy imports, the tree is in place — nothing the repo suite can see
```

**The dist-tag policy is unchanged**: `release.yml` only publishes `next` and never touches `latest`; `latest` is
still moved by hand with `pnpm run promote -- <version>` after a restart of `dsh web` confirms the build is good.

Release flow (now it is just a tag):

```powershell
# 1) bump package.json's version → commit to main → wait for ci.yml to go green
# 2) install it locally into the web profile, restart DSH, confirm it works
git tag v0.3.47; git push origin v0.3.47   # 3) release.yml rebuilds the tarball, publishes next, opens a Release
pnpm run promote -- 0.3.47                 # 4) promote latest by hand once confirmed
```

One-time setup (repository / account side, no files involved):

- **npm trusted publishing (recommended, no long-lived credential)** — two equivalent routes to create a trust
  relationship that lets **only this workflow** publish the package:
  - **CLI (one command, dry-run verified locally)**:

    ```
    npm login                                   # already jinsiyu? skip
    npm trust github dsh-code-server-app --file release.yml \
      --repo jinsiyu/dsh-code-server-app --allow-publish
    ```

    `--allow-publish` is **required** (without it the entry is created but cannot publish);
    `--file` takes the bare filename (`release.yml`), npm expands it to
    `.github/workflows/release.yml`; the command itself **requires 2FA** (it will ask for an OTP).
    In a sandboxed shell, an `EPERM … npm-cache` error means the npm cache is not writable —
    point it at a writable directory with `npm_config_cache`, and do **not** put `--cache` before
    `trust` (that breaks npm's subcommand parsing with `Unknown positional argument: github`).
    Verify with `npm trust list dsh-code-server-app` (that endpoint can return 403 for older tokens —
    then check the Trusted Publisher list on the npm website instead).
  - **Web UI**: npmjs.com → `dsh-code-server-app` → Settings → Trusted Publisher → GitHub Actions:
    Organization/user = `jinsiyu`, repository = `dsh-code-server-app`, workflow filename = `release.yml`,
    **environment name left empty** (the release job declares no `environment:`).
  - Semantics: this trust relationship means "**anyone with write access to this repository can publish
    this package**" (npm's own wording).
  - Alternative: add an `NPM_TOKEN` repository secret and set the repository variable
    `NPM_AUTH_MODE=token` (that mode does not attach provenance). Note npm is restricting legacy
    2FA-bypassing tokens, so OIDC is the durable option — once it works, delete the token.

**Authentication for `repacks.yml` (the platform-specific sub-packages)** — two routes; the workflow picks
one itself (with no `NPM_TOKEN` it uses OIDC):

- **A. `NPM_TOKEN` (least friction today)**
  1. npmjs.com → avatar → **Access Tokens** → **Generate New Token** → **Granular Access Token**;
  2. any name (e.g. `github-actions-repacks`) and an expiry (90 days is fine);
  3. **Packages and scopes** = **Read and write**, tick only the **`@jinsiyu`** scope (not "All packages");
  4. you **must** tick **"Bypass two-factor authentication (2FA)"** — otherwise an unattended publish
     stalls waiting for a one-time password;
  5. the token is shown **once** — copy it immediately;
  6. GitHub repository → Settings → Secrets and variables → **Actions** → **New repository secret**,
     the name **must** be `NPM_TOKEN` (that is what the workflow reads).
  ⚠️ Per npm's announcements: since 2026-07-31 bypass-2FA tokens can no longer perform account/package
  management, and **from January 2027 they lose direct publish** (only reading private packages plus staging
  a publish, which a maintainer approves with 2FA) — so plan to move to B.
  - **How to read a failed publish** (`publish-repacks.mjs` first runs a token health check: it prints only
    the token's length and shape, never its content, then uses `npm whoami` to prove it authenticates):
    · `E401` / `ENEEDAUTH` ⇒ **the token value is wrong**: surrounding quotes or a trailing newline, a
    truncated paste, or a revoked token ⇒ generate a fresh one and paste it again (a granular token looks
    like `npm_…` followed by a long random string; a classic one is a 36-character UUID);
    · `npm whoami` succeeds but publishing returns **`EOTP` (This operation requires a one-time password)**
    ⇒ **the value is fine**, what is missing is a permission attribute: the token does not have step 4's
    **"Bypass two-factor authentication (2FA)"** ticked. npm also requires 2FA for the **first publish of a
    new package name**, and a trust entry cannot exist before the package does ⇒ the first publish has to be
    done locally with `npm publish <tgz> --access public --tag next` and an OTP (publish only that target's
    own `-<target>` packages; do not re-publish the already-published tree package), after which one trust
    entry per new name switches those packages to OIDC.
- **B. per-package trusted publishing (the durable route)**: npm trust entries are **per package**
  (since 2026-09 a package may have several, but there is **no scope-level** entry), so these 25 packages
  need 25 entries. Generate the commands, then run them one by one after a single browser authorization:
  ```powershell
  node -e "const t=require('./lib/vendored.json');const p=require('./package.json');const tree=Object.keys(p.dependencies).find(n=>n.endsWith('/dshcs-vscode-server'));const names=[tree,t.modules.flatMap(m=>m.platform?t.targets.map(x=>m.package+'-'+x):m.package)];require('fs').writeFileSync('trust-all.txt',names.flat().map(n=>'npm trust github '+n+' --file repacks.yml --allow-publish -y').join('\n')+'\n')"
  Get-Content trust-all.txt | ForEach-Object { Invoke-Expression $_ }
  ```
  Afterwards delete `NPM_TOKEN` (the workflow then uses OIDC). npm also lets each entry be **staging-only**
  (a version only goes live after you approve it with 2FA) — safer, but each batch then needs manual
  approvals for several versions.
  Verify with `npm trust list <package>`, which should show `file: repacks.yml` and
  `repository: jinsiyu/dsh-code-server-app` (all 25 packages are required — a missing one fails at publish
  time with "no matching trust configuration", and that line shows up as an annotation in the run without
  needing a token).
- **Verifying that route (without waiting for a real publish)**: `repacks.yml` has a `probe-oidc` job that does a
  **staged** publish for four real sub-package names (`vscode-fs-copyfile`, `node-pty`,
  `kerberos-win32-arm64`, `vscode-server`), with versions like `2.0.1-oidc-probe.<run>`.
  This only works from CI: OIDC tokens are minted at run time, and a trust entry matches on
  repository + **workflow filename** + package name — which is also why the probe has to live in
  `repacks.yml` itself. `npm stage publish` follows exactly the same auth path as `npm publish`, but the
  version lands in the staging queue and **never in the registry's published version list** (the script
  re-checks that with `npm view <pkg> versions`), so no version number is consumed and no dependency
  resolution changes. Trigger it either from Actions → repacks → Run workflow with `probe_oidc` checked, or
  token-free by committing the sentinel `.github/oidc-probe.enabled` and pushing. Results are emitted as
  `::notice::` / `::error::` annotations, readable on a public repo without logging in
  (`GET /repos/jinsiyu/dsh-code-server-app/check-runs/<id>/annotations`). Afterwards **reject** the staged
  probe versions (`npm stage list`, then `npm stage reject <id>`; needs 2FA on your machine) — do **not**
  approve, since approving is what would turn a probe into a real version. Delete the sentinel file to
  return to "no automatic probe".
- **Optional** repository variable `DSH_UI_VERSION` = the version of `@deepseek-ai/dsh-web-frontend` in the current
  deployment: when set, `release.yml` enforces that the panel renderer matches the deployed UI (the local
  `build:webview` always checks this; a runner has no DSH deployment).

Things you must know:

- **`release.yml` rebuilds the tarball on the runner; it does not upload the file built on your machine.** Same
  commit + same pinned tree version ⇒ same content, the only differences being the `platform` / `preparedAt` /
  `sizeMB` metadata in `vendor/VENDOR.json` (at runtime only `codeServerVersion` and `productPath` are read).
  That is why step 4 above still installs into the web profile before promoting `latest`.
- **CI never runs `pnpm pack`**: on a fresh clone its `prepack` pulls `code-server@latest` from the registry, which
  does not match the tree version pinned in `dependencies` (it would break the "tree package is pinned exactly"
  assertion). Packing happens only in `release.yml`, after
  `node scripts/vendor-vscode-server.mjs --version <pinned>`.
- **Release gates** (any failure stops the run; `next` is never advanced): tag ≠ `package.json.version`, the
  version already exists on npm, the tree version does not match (`test:vendored`), the suite fails, or
  `DSH_UI_VERSION` mismatches.
- `@deepseek-ai/schemastery` is a **devDependency** (pinned to 3.18.2, the version the deployment uses):
  `lib/index.js` normally takes it from the DSH deployment (in production, the copy hoisted inside the
  profile), and a clean clone / CI runner has no DSH at all — without this devDependency the `apply`-style
  tests throw `schemastery not found`. It never ships to users (devDependencies are not installed for a
  dependency). A CI job that actually deploys DSH is possible (`@deepseek-ai/dsh` is public on npm), but it
  pulls the whole harness (~1.3GB profile), so it belongs in a slower job, not on every push.
- The first release must use a **version that has never been published** (npm versions are immutable).
  `release.yml` supports a `workflow_dispatch` **rehearsal** (full pipeline, nothing published) — run it once
  before pushing a real tag.
- `pnpm-lock.yaml` is **committed** now (CI installs with `--frozen-lockfile` and the cache key is derived from
  it); it is not in `package.json`'s `files` allow-list, so it never ships in the npm package.

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
- the **binary part** comes entirely from `@jinsiyu/dshcs-*` sub-packages, declared **directly on the plugin's own
  dependency table** (since 0.3.45): the 8 platform-independent repacks (`node-pty` / `koffi` / `ssh2` /
  `cpu-features` / `@parcel/watcher` / `@vscode/fs-copyfile` / `@vscode/proxy-agent` / `@microsoft/mxc-sdk`) go into
  `dependencies` under their real names; the 8 platform-specific ones (`@vscode/sqlite3` / `spdlog` / `kerberos` /
  `deviceid` / `native-watchdog` / `windows-registry` / `windows-process-tree` / `windows-ca-certs`) go into
  `optionalDependencies` once per target (real names + their own os/cpu gates), so one command picks the right arch;
  the **original names** are restored at runtime by junctions created from `lib/vendored.json`;
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
- **how the original names come back** (since 0.3.45): a repack's real name is `@<scope>/dshcs-<name>` while VS Code
  imports `node-pty` / `@vscode/sqlite3`; pack time writes the "original name → real name" table into
  `lib/vendored.json` (shipped with the plugin) and `lib/native.js` creates `<tree>/node_modules/<original name>`
  junctions to the real directories (idempotent, self-healing).
  **Why the old "platform aggregator + `npm:` aliases" is gone**: pnpm's incremental hoisted install drops those
  aliased packages when they sit inside an **optional subtree** (measured: 9 of 16 missing) while dsh-desktop
  validates the dependency graph right after the install ⇒ the first install always failed with `requires missing`;
  with real-name direct dependencies the same install command plus the validator's own predicate passes end to end
  (reproduction in `docs/desktop-first-install-root-cause.md`);
- **resolution path**: the host finds the tree with `require.resolve('@jinsiyu/dshcs-vscode-server/package.json')`
  (then the inner `vscode/` directory) and the entry is `vscode/lib/vscode/out/server-main.js`; VS Code's inner deps are
  resolved upwards from that root (`vscode/lib/vscode/node_modules` → package `node_modules` → `<profile>/node_modules`).
  The legacy full tree (`@jinsiyu/dshcs-code-server/code-server`) is still recognised as a fallback;
- **runtime layout self-healing** (`ensureRuntimeLayout()` in `lib/native.js`, idempotent, run **at activation before
  `envCheck` and again before every start**): the host adds two kinds of **junctions** (Windows junctions / POSIX dir
  symlinks) into the tree:
  1. `ensureAliasLinks()`: links the 16 **original names** listed in `lib/vendored.json` into `<tree>/node_modules`
     — the real-name packages live in the plugin's dependency graph, and `lib/vscode/out/server-main.js` uses
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
> **Changing the ask panel**: edit `assets/extensions/dshcs-editor-bridge/webview/src/*` then run
> `pnpm run build:webview` (same convention: generated, not tracked; the IDE must be restarted once to pick it up,
> because the extension host caches the webview resources).

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
  release; or use `pnpm run vendor:vscode -- --version 4.137.0` / `DSHCS_CODE_SERVER_VERSION`.
  With an existing `vendor/vscode`, a plain `pnpm pack` never upgrades (it is a no-op).
  **Source-tree precedence (fixed in 0.2.13)**: an explicit `--from` uses that tree, while an explicit
  `--force`/`--version` now **always goes to the registry** — before the fix a local source tree won
  (`defaultSourceTree()` hit `vendor/code-server` or an installed profile tree first), so the documented
  "`vendor:latest` takes latest from the registry" silently kept the old version (hit while upgrading to 0.2.13:
  the bundled tree stayed at 4.136.2). A run with neither flag still reuses a local tree to save the download.
- **Sync the inner dependency pins when the tree changes**: in `--reuse` mode the pure-JS install set is read from
  the **plugin's package.json**, so update those pins from the new tree's `lib/vscode/package.json` first
  (this time: 10 `@xterm/*` beta bumps). The rule is "only move a pin that no longer satisfies the new range",
  which keeps already-newer pins such as `cookie`/`ws`/`tar`/`node-addon-api` from being downgraded.
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
- Bundled locally right now: the tree of `code-server@4.137.0` (VS Code 1.137.0, `productPath=stable-b11dabda…`).

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
| `port` | `0` | Port for loopback mode; **`0` = a random free port assigned per start** (the actual one is written to `endpoint.json` and read back by the host). Give an explicit port to pin it; when that port is taken and no valid `pid.json` exists, startup fails with diagnostics instead of killing a stranger |
| `auth` | `none` | `none` \| `password`; non-loopback host automatically requires password |
| `passwordToken` | `''` | Token for password mode (passed to code-server via the `PASSWORD` env var) |
| `userDataDir` | `$DSH_HOME/code-server/user-data` | User-data isolation directory |
| `extensionsDir` | `$DSH_HOME/code-server/extensions` | Extensions directory |
| `readyTimeoutMs` | `60000` | `/healthz` readiness probe timeout |
| `editorBridge` | `true` | **Editor bridge** (since 0.3.0): the read-only channel between the in-tree `dshcs-editor-bridge` extension and the host (see "Working with DSH"). Off = no `bridge.json`, no `editor_context`/`editor_diagnostics`, the extension stays dormant. `code-server.editorBridge` in the settings document toggles it **live** |

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
| POST | `/api/code-server/start` | body `{ cwd? }` (omit cwd to keep the current workspace); idempotent; changing cwd while running only **switches the directory, without restarting the process** (0.2.12) |
| POST | `/api/code-server/stop` | Stop and recycle the process tree |
| POST | `/api/code-server/setup` | **Compatibility no-op**: since 0.1.36 dependencies are installed by the package manager, so this only re-runs the env self-check and returns |
| POST | `/api/code-server/open-file` | body `{ file }` — writes the signal consumed by the built-in `dshcs-open-file` extension to open the file in code-server |
| GET | `/code-server-bridge/health` | editor-bridge liveness (**unauthenticated**; no editor data). Runs over **local IPC** (named pipe / unix socket), not under `/api`, and needs no `webServer` |
| POST | `/code-server-bridge/sync` | editor bridge: the extension pushes state (`{context, diagnostics, workspace, at}`) and takes back events; `?since=<seq>` is the event cursor. Requires `x-dshcs-bridge-token`, and **any Origin header is 403** |
| POST | `/code-server-bridge/ask` | editor bridge: push an editor question into the current session (`{text, file?, lineStart?, lineEnd?, selection?, languageId?}`); **409** when no session can receive it |
| POST | `/code-server-bridge/event` | editor bridge: extension reports open/close and similar (host log tail). Requires the token |

> All four bridge routes carry their own token check — they **cannot** rely on DSH's cookie fence, because the
> extension host has no browser cookie — and they are read-only by construction. See "Working with DSH" above.

> The plugin no longer registers `/code-server/*` webServer-only routes, and the code-server icon is inlined as a data URI
> in the client bundle — the client requests no plugin-owned HTTP resource at all.

## DSH Desktop (no webServer)

- The host half is `inject = ['connection', 'settings']` (**no `webServer`**) — the desktop profile disables webserver/web-runtime
  and the plugin still works: `/api/*` requests travel Electron `dsh-app://` protocol handler → IPC framed pipe → `createSharedFetchHandler('/api')`.
- The right-sidebar tab, guide entry box, file-address claim, and settings card behave the same as in web (code-server remains an
  iframe to the local `http://127.0.0.1:<port>`; the desktop renderer uses `webSecurity: true` with no CSP, so the cross-origin iframe loads).
  The desktop build ships `dsh-client-ui-sidebar-right` in its seed package set as well, so the 0.2.3 "right-sidebar DSH only" rule is
  not a regression for desktop; the only difference is the missing `webServer`, where `serve: dsh` falls back to loopback (that path
  genuinely needs a webServer).
- **The editor bridge works on desktop since 0.3.13**: it runs over local IPC (named pipe) and does not involve `webServer` at all —
  the extension host is a child of the IDE the plugin itself spawned, so both ends are on the same machine. The host injects
  `DSHCS_EXTENSIONS_DIR`, the extension finds `bridge.json`, and `/status` reports `bridge.supported=true` with the pipe name.
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

- **~~The editor bridge needs DSH to provide `webServer`~~ no longer true (fixed in 0.3.13)**: the bridge now runs
  over **local IPC** (Windows named pipe / unix socket via `http.request({ socketPath })`), so **web and desktop share
  one path**, with no `webServer` and no open port. History: 0.3.9–0.3.12 mounted it under DSH's webServer prefix
  (⇒ desktop stayed dormant); up to 0.3.7 it was registered under `/api/code-server/bridge/*` and was killed by
  Connection's cookie fence (401). **File opening** was never affected (it uses the signal file).
- **`/code-server-bridge/health`'s `bridge` field does not mean the extension is running** (clarified in 0.3.12):
  it only says the bridge *target* is configured. Whether the extension actually runs shows up in the exthost log
  or by simply calling `editor_context` — 0.3.0–0.3.11 sat in the state "health says bridge:true, extension never
  loaded" (cause above: the user-level install was marked `.obsolete`).
- **Bridged state can lag by up to 600 ms**, and the tools say "stale" rather than serving data older than 10 s.
- **The ask panel renders only "new content" (0.3.22)**: the subscription starts when the panel opens, the history
  `records` from `follow`'s opening frame are discarded, and the panel has **no "load earlier"** (the history-paging
  API `sessionController.page()` is deliberately not called in this version). Switch to the DSH UI for older content.
- **Panel highlighting ships only DSH's boot grammar set** (typescript / shellscript / json): the rest of the
  official grammars load lazily through `import()` (~1.6MB total), and the panel is a single-file IIFE with no
  lazy loading, so those languages render as plain text (exactly like DSH's own first render, no errors).
  For the full set: `node scripts/build-webview.mjs --all-grammars`.
- **Panel assets are pinned to the DSH version**: the renderer is bundled against the UI version of the deployed
  DSH, so after upgrading DSH you must rebuild the panel (`pnpm run build:webview`; the build fails loudly on a
  version mismatch). The panel also shows a mismatch notice at runtime instead of silently using the wrong renderer.
- **The approval window in the panel is 5 minutes**: while the panel is open, approvals ask the panel first (the card
  shows a countdown); **closing the panel** or letting the 5 minutes run out hands the request back to the DSH UI —
  after that, that request can **only** be answered there (the card disappears from the panel and the thread keeps an
  audit row).
- **Unsaved buffers are reported, not taken over.** The agent still edits via its own `fs` tools, i.e. against
  disk. What the bridge adds is a notice *before* writing a dirty file, a diff *after*, and a warning instead of
  an overwrite. It does not decide whether the user saves — that would mean changing the agent's read path,
  which is out of scope for this version.

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
- **Single instance across sessions**: one shared IDE per host; switching cwd only re-navigates the workbench (since 0.2.12 no process restart, so the old directory's background terminals are not collected).
- **Older DSH versions are unsupported (since 0.2.3)**: on a DSH without `sidebarRightTabs` / `sidebarRight` the plugin
  offers nothing but an upgrade notice on the settings page; older-DSH users should stay on `0.2.2`
  (`dsh plugin --profile web add dsh-code-server-app@0.2.2`).
- **Sidebar tab switching** (no longer reloads since 0.2.2): DSH's right sidebar renders only the active tab's body, and
  a React unmount moves the iframe away; the plugin keeps it as a singleton resident surface and shuttles it between the
  dock slot and a document-level park container with `Element.moveBefore()` (a state-preserving atomic move), so
  switching tabs or collapsing the sidebar and back **does not reload** it. Browsers without `moveBefore` fall back to
  the old behaviour (`appendChild` → full reload), reported as `degraded`; see "Why switching tabs no longer reloads".
- **Remote access**: with `serve: dsh` the browser only needs to reach DSH itself (one port, protected exactly like `/api`);
  `serve: loopback` binds to loopback only (random port + path token + Host allowlist — see "Security model of the loopback
  port"), so use `serve: dsh` for cross-machine access (0.2.0 no longer supports `auth: password`).
- **The loopback token rotates per instance**: port and token change on every new start; adoption after a host restart
  matches the live instance through the `endpoint.json` and `path-token` files, so **do not delete those two files**
  (without them the host cannot recognise the old instance and treats the port as foreign).