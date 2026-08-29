# dsh-code-server-app — Integrate code-server (VS Code in the browser) into DSH

> Source repository: see `repository` / `homepage` in `package.json`.

> ## ⚠️ Extension Marketplace Note (important)
>
> - **code-server's extension store is [Open VSX](https://open-vsx.org/), not the Microsoft Visual Studio Marketplace**;
> - Microsoft's Marketplace terms **prohibit third-party products (including code-server) from using its API**, so code-server cannot query Microsoft's extension list;
> - As a result, Microsoft **commercial/proprietary** extensions (e.g. **GitHub Copilot, the Remote series like Remote-SSH, Azure tools, IntelliCode**) are **not available** in the store — this is Microsoft's distribution policy, not a defect;
> - Microsoft **open-source** extensions (Python, TypeScript debugger, ESLint, …) are mirrored on Open VSX and install normally by search;
> - **If you need a proprietary Microsoft extension**: download the `.vsix` from the Marketplace page and install it manually with `code-server --install-extension <file>` (or drop it into `--extensions-dir`).

A static profile plugin (npm package with host + client bundle) that ships the latest [code-server](https://github.com/coder/code-server) **as a plugin dependency** (installed by the plugin's postinstall), auto-discovered and used on startup — no global npm install, no `bin` configuration.

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
- `node_modules` (dependencies, including code-server) is git-ignored; after cloning, follow "Install plugin (code-server self-installed in profile)" below — `pnpm pack` + `dsh plugin --profile web add`.

> Verified locally (BM: Windows 11 ARM64): `code-server@4.134.0` (with Code 1.135.0)
> shipped with the plugin, auto-discovered → started → healthz 200 → cwd switch restart while running → stopped → fully recycled.

## Install the plugin (code-server self-installed in profile; zero flags, zero errors)

```powershell
# 1) Pack (in the plugin workspace)
cd C:\Users\User\Desktop\dsh-code-server-app
# Fresh clone: install dev deps and generate the client bundle first (lib/client.js is not committed; built from src/factory.js)
pnpm install            # esbuild + motion (pack only)
pnpm run build:client   # src/factory.js → lib/client.js
pnpm pack

# 2) One-time: approve the plugin postinstall (pnpm only honors the host root config)
cd C:\Users\User\.dsh\profiles\web
pnpm approve-builds dsh-code-server-app   # interactive 'yes'; if it fails, edit pnpm-workspace.yaml manually
```

> If `approve-builds` rejects the `file:` spec (unknown), set the `dsh-code-server-app@file:...tgz` entry
> in `pnpm-workspace.yaml`'s `allowBuilds` to `true` (equivalent to interactive approval, once only).

```powershell
# 3) Install (published tarball; no --ignore-scripts / --allow-build needed)
dsh plugin --profile web add C:\Users\User\Desktop\dsh-code-server-app\dsh-code-server-app-0.1.20.tgz
```

### Install mechanism

- **code-server is not in `dependencies`** (pnpm never touches it; no script-approval issues);
- The plugin's `postinstall` (`scripts/setup-code-server.mjs`) installs **the latest** `code-server` **with npm into a dedicated profile directory**
  (version not pinned; npm `latest` is used at install time):
  - Install root: `<profile>\.code-server-app` (e.g. `C:\Users\User\.dsh\profiles\web\.code-server-app`),
    a standalone project isolated from the profile dependency tree (avoids ERESOLVE);
  - The install root carries its own `package.json` with `allowScripts`: `code-server: false` (skips the official `sh ./postinstall.sh`
    — Windows has no `sh`, it would fail; `argon2/unrs-resolver: true` builds native modules; both without version pins);
  - Afterwards it installs VS Code internal dependencies (144 packages) + `bin\code-server.cmd`;
- **code-server lands at** `<profile>\.code-server-app\node_modules\code-server\`;
  idempotent and self-healing (reinstalling the plugin → postinstall reruns → skips if already instantiated;
  **if the installed version differs from the latest, it auto-upgrades**).
- **Pin a version**: set the env var `DSHCS_CODE_SERVER_VERSION` (e.g. `4.134.0`) to freeze a specific release; unset it to follow latest.

> **Uninstall**: the code-server directory is independent of the plugin package — first
> `Remove-Item -Recurse -Force <profile>\.code-server-app`, then `dsh plugin --profile web remove dsh-code-server-app`.
> The settings card's "Environment check" section also shows this hint.

> After install/dependency changes, **restart `dsh web`** (the static plugin row and host probe paths load at startup).

### Development: install from source (changes take effect immediately)

```powershell
dsh plugin --profile web add C:\Users\User\Desktop\dsh-code-server-app
```

> A source path installs via `link:`; pnpm installs code-server into the **plugin workspace node_modules**;
> the layout differs from the profile-dir approach (the host supports both). First time also needs step 2 above.
>
> **Changing the client bundle**: edit `src/factory.js` then run `pnpm run build:client`
> to regenerate `lib/client.js` (that artifact is not tracked; a browser refresh picks it up — no host restart needed).
> Window animations are driven by the embedded `motion`; feel parameters live in `winPhysics` (one spot) in `src/factory.js`.

### Windows native build notes (verified locally, ARM64)

- **VS needs the Spectre-mitigated libraries** (MSB8040): Visual Studio Installer → Individual components →
  "MSVC v18x Spectre-mitigated libraries for ARM64" (same for x86/x64).
- **node-gyp 13.x** (9.x does not recognize VS 2026): `npm install -g node-gyp@latest`.
- Latest code-server requires **Node v24** (checked by postinstall; v24.13.1 verified here).
- If you don't need the self-contained install (e.g. a global code-server already exists), skip it:
  the plugin falls back to a configured/PATH `bin` (see the "Config" table).

### Upgrading the code-server version

- **Automatic by default**: postinstall does not pin the version — if the installed version differs from npm latest it reinstalls to latest (no manual edits).
- **To pin**: set the env var `DSHCS_CODE_SERVER_VERSION` (e.g. `4.134.0`); unset it to follow latest again.
- Re-run `pnpm pack` + `dsh plugin --profile web add <tgz>` to trigger the postinstall check (or delete `.code-server-app` and reinstall).

### Compatibility with the old runtime-directory install

`runtime/node_modules/code-server` (the earlier manual approach) is no longer supported —
host probe order: `<profile>\.code-server-app` (dedicated dir) > plugin-internal `node_modules` > PATH/config `bin`
(top-level hoisted is a historical layout and is no longer probed).

## Settings card (Settings → Plugins → Code Server)

Modeled after dsh-auto-open-web's custom card, registered on the `settings.plugin.item` slot,
persisted via the official settings domain (`settingsScope`, namespace `code-server`) into the official settings document:

| Key | Default | Description |
|---|---|---|
| `reserveComposer` | `true` | Whether the window **reserves space above the composer**: on, the window's initial/drag/resize/maximize stop above the composer (never covers it); off, it may cover the composer (maximize to viewport bottom) |
| `windowedOpen` | `false` | **Open in a window**: on, clicking the floating ball opens code-server in a browser **new tab** (auto-starts and follows the active workspace); off (default) uses the internal floating window |

> Card changes take effect immediately via `scope.watch` (the host status API returns `reserveComposer` and
> `windowedOpen`; the client applies them at once); no dsh restart needed. **After adding new setting keys, restart dsh web before first use**,
> so the host re-registers the settings namespace (schema includes the new key); otherwise save/validation of the new key won't work.

## Config (`config` in cordis.patch.yml; all have defaults)

| Key | Default | Description |
|---|---|---|
| `bin` | `code-server` (placeholder) | Launch priority: explicit `bin` in config > `<profile>\.code-server-app` (dedicated dir, auto-run with node) > plugin-internal `node_modules` > `code-server` on PATH. None present → startup error with install guidance |
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

## JSON API (same-origin fetch; shared by the overlay and the web page)

| Method | Path | Description |
|---|---|---|
| GET | `/code-server/status` | `{ ok, running, status, host, port, pid, cwd, url, version, error, logTail, adopted }` (also `env` environment check and `setup` install-task progress) |
| POST | `/code-server/start` | body `{ cwd? }` (omit cwd to keep the current workspace); idempotent |
| POST | `/code-server/stop` | Stop and recycle the process tree |
| POST | `/code-server/setup` | Run the environment install in the background (npm install code-server + native + VS Code internal deps); progress via `status.setup` polling |
| POST | `/code-server/open-file` | body `{ file }` — writes the signal consumed by the built-in `dshcs-open-file` extension to open the file in code-server (also auto-expands the window from the client side) |

## Artifact open buttons

Each produced file (written/edited) in a turn is shown as a chip with a **code-server icon button** next to it
in the conversation's turn tail; clicking either opens the file in code-server (and expands the floating window if collapsed).
The `dshcs-open-file` extension is installed as a **built-in** extension of code-server (in `lib/vscode/extensions`),
so users cannot remove it from the extensions panel.

## Known limitations

- **No sub-path**: the code-server front-end uses root paths/WebSocket/Service Worker, so it must be a direct iframe on its own port;
  no DSH webServer reverse proxy; `--base-path` is not officially supported.
- **Single instance across sessions**: one shared code-server per host; switching cwd requires a restart (the overlay handles it and hints).
- **Remote access**: default is loopback + no auth. Cross-machine access requires `host` + `auth: password` + `passwordToken`,
  and the browser must be able to reach that host directly (the plugin's "open in new tab" builds the URL from `host:port`).
