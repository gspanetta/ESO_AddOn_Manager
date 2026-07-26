# Wolf's AddOn Manager

A desktop GUI for browsing, installing, updating, and removing
[Elder Scrolls Online](https://www.elderscrollsonline.com/) add-ons, sourced from
[ESOUI](https://www.esoui.com/) / [MMOUI](https://www.mmoui.com/).

It is a port of the original `download_addon.py` CLI into a Neutralinojs + Vue 3
app: all of the Python tool's logic (download filelist, search, download & extract
zips, track installed addons, dependency auto-install, update/remove) has been
rewritten in TypeScript and runs in the frontend, talking to the filesystem and
network through the Neutralinojs native APIs.

> **History:** this project was originally a Tauri 2 + Vue 3 app. Tauri was replaced
> with [Neutralinojs](https://neutralino.js.org/) to drop the Rust toolchain and
> the heavy native build while keeping the exact same JS/HTML/CSS frontend. The
> original scaffolding came from the
> [tauri-vue-template](https://github.com/Uninen/tauri-vue-template) by
> [@Uninen](https://github.com/Uninen); the addon-management logic and UI were
> added on top of it.

## Features

- **Configurable AddOn folder** — set once via a paste-or-browse popup; persisted
  across sessions.
- **Search & install** — search the full ESOUI catalog by name and install with one
  click (zips are downloaded from `www.esoui.com` and extracted in-memory).
- **Dependency auto-install** — parses each addon's `## DependsOn:` line and
  installs the required `Lib*` libraries; prompts with a choice modal when a
  dependency matches multiple addons.
- **Installed list** — shows every tracked addon with its icon, author, version, and
  download count; "update available" badges appear when the upstream version is newer.
- **Update & delete** — upgrade individual addons or all at once; remove an addon
  (deletes its folder and untracks it).
- **Folder reconciliation** — saving the AddOn folder scans it: addons already
  present on disk are added to the tracked list, and tracked addons no longer in
  the folder are removed.
- **Elder Scrolls-inspired theme** — dark stone/leather UI with gold accents, Cinzel
  display headings, and addon thumbnails next to names.

## Tech stack

- **Neutralinojs** — desktop shell (tiny C++ server + the OS webview, JS API for
  filesystem / network / dialogs). No Rust, no native compile step.
- **Vue 3 + TypeScript** — type-safe frontend with Composition API
- **Pinia** — state management
- **Tailwind CSS v4** — styling
- **Vite** — dev server & bundler, with `unplugin-auto-import` / `unplugin-vue-components`
- **fflate** — in-webview zip decompression
- **`@neutralinojs/lib`** — the Neutralinojs JS client (`filesystem`, `os`, `net`,
  `events`, `app`), bundled by Vite as a normal npm dependency

## Prerequisites

- **Node.js 20+** and **pnpm** (see Quick start).
- **`curl`** on `PATH` — used to download addon zips (Neutralinojs has no
  binary-safe HTTP API; see Architecture). `curl` ships with Windows 10 1803+,
  macOS, and all Linux distros, so this is almost always already satisfied.
- A system webview: WebView2 (Windows 10/11, preinstalled), WebKitGTK (Linux), or
  WebKit (macOS). Neutralinojs uses whichever the OS provides.

## Quick start

1. Install dependencies and fetch the Neutralinojs host binaries:

```sh
pnpm i
pnpm neu:update     # one-time: downloads the prebuilt binaries into bin/
```

2. Run the app:

```sh
pnpm dev            # = neu run: starts the Vite dev server + opens the Neutralino window
```

> **pnpm note:** this repo uses pnpm. If `pnpm` is not on your PATH, enable it via
> corepack: `corepack enable pnpm && corepack prepare pnpm@latest --activate`.
> pnpm 11 requires build-script approval, configured in `pnpm-workspace.yaml`
> (`allowBuilds:`) — without it `pnpm i` exits with `ERR_PNPM_IGNORED_BUILDS` and
> native deps (esbuild, @swc/core) won't postinstall.

On first launch the app opens with no AddOn folder set. Click **Set AddOn
folder…**, paste or browse to your ESO `…/live/AddOns` directory, and hit
**Save** — this downloads the addon catalog and reconciles the folder.

## Architecture

The app is a Neutralinojs window app. Neutralinojs runs a small local C++ server
that hosts the webview and exposes native APIs over a WebSocket; the frontend talks
to it through `@neutralinojs/lib`. There is **no custom native code** — all addon
logic is in the frontend and reaches the OS through the Neutralinojs JS APIs.

### Why two HTTP paths

Neutralinojs' `net.request` returns the response body as a **string** over the
WebSocket bridge — fine for text, but it corrupts binary bytes (there is no
binary/arraybuffer mode). So:

- **Filelist (text/JSON)** — downloaded with `net.request`, which runs natively and
  bypasses browser CORS. Cached as `filelist.json` in the app data dir.
- **Addon zips (binary)** — downloaded with `curl` (`os.execCommand`) into a temp
  file, read back with `filesystem.readBinaryFile` (base64-decoded, binary-safe),
  validated by the `PK` zip magic bytes, then extracted in-memory with `fflate`.

### Data layout

The app keeps its own data separate from the user's addon folder:

| What | Where | Notes |
| --- | --- | --- |
| `config.json` (addon path, deps toggle) | app data dir | plain JSON file |
| `installed.json` (tracked-addon DB) | app data dir | app-managed schema, not the Python tool's format |
| `filelist.json` (catalog cache) | app data dir | downloaded from `api.mmoui.com` |
| Addon folders | user-chosen AddOn dir | only extracted addon folders; the app never writes metadata here |

The app data dir is the platform data home (`os.getPath('data')`:
`~/.local/share` on Linux, `%APPDATA%` on Windows, `~/Library/Application Support`
on macOS) joined with the subfolder **`com.eso.addonmanager`** — the same folder the
old Tauri build used, so existing users keep their config/DB/cache after upgrading.
(Changing `applicationId` in `neutralino.config.json` moves this folder and makes
the app appear to lose its setup — keep it stable across releases.)

### Frontend layout

- **`src/lib/`** — the ported CLI logic, one module per concern:
  - `http.ts` — download the filelist (`net.request`); fetch addon zip bytes
    (curl → temp file → `readBinaryFile`, with `PK` magic validation)
  - `zip.ts` — `fflate` decompression + `filesystem` extraction, with path-traversal
    hardening (rejects absolute/`..` entries); `## DependsOn:` parsing
  - `filelist.ts` — cache load, name search, UID lookup, thumbnail URL
  - `installed.ts` — installed DB load/save/upsert/remove
  - `config.ts` — persisted app config (plain `config.json` file)
  - `paths.ts` — app-data path helpers + sync `join`/`dirname`/`safeRelative` +
    `pathExists` (wraps `getStats`)
  - `addonManager.ts` — orchestrators: `installAddon`, `removeAddon`, `checkUpdates`, `updateAddon`, `updateAll`
  - `import.ts` — `reconcileInstalledWithFolder` (prune + import on Save)
  - `types.ts` — `FileListEntry` (API shape), `InstalledAddon` (our schema)
- **`src/stores/addons.ts`** — Pinia store holding all reactive state and async actions.
- **`src/components/`** — `SettingsBar` (folder popup + refresh + deps toggle),
  `InstalledList`, `SearchPanel`, `AddonIcon`, and `App.vue`.
- **`src/main.ts`** — calls `Neutralino.init()`, registers the `windowClose` →
  `app.exit()` handler, and mounts Vue.

### Permissions

Native API access is locked down via `nativeAllowList` in `neutralino.config.json`
to exactly the methods the app uses: `app.exit`, `os.getPath`, `os.execCommand`,
`os.showFolderDialog`, a handful of `filesystem.*` methods, and `net.request`.

## Project structure and usage

Frontend code lives in `src/`; the Neutralino config at the project root; the Vite
build output in `dist/`. See `package.json` for all scripts.

### Common commands

```sh
pnpm dev          # run the app (Vite dev server + Neutralino window, with HMR)
pnpm build:fe     # type-check (vue-tsc) + build the frontend (vite) into dist/
pnpm build        # build:fe + package the Neutralino distribution (neu build)
pnpm type-check   # vue-tsc type-check only
pnpm neu:update   # (re)fetch the Neutralino host binaries into bin/
```

### Debugging

- Dev builds open the webview inspector (`modes.window.enableInspector: true` in
  `neutralino.config.json`).
- `@vue/devtools` is connected in development (see `src/main.ts`); run the
  standalone devtools server separately if you want the external panel.

## Building and releasing

### Building

GitHub Actions (`.github/workflows/`) automatically test and build on push/PR. To
build manually:

```sh
pnpm neu:update   # once, to populate bin/
pnpm build        # produces dist/wolfs-addon-manager/ with per-platform binaries
```

`neu build` packages **all platforms in a single run** (it doesn't compile anything
— it copies the prebuilt Neutralino binaries already in `bin/` and patches the
Windows executable metadata). The output lands in `dist/wolfs-addon-manager/`:

- `wolfs-addon-manager-linux_x64` (and `_arm64`, `_armhf`)
- `wolfs-addon-manager-mac_x64`, `_arm64`, `_universal`
- `wolfs-addon-manager-win_x64.exe`
- `resources.neu` (the bundled frontend + config)

Users run the binary for their platform directly; it's portable (no install step).

### Releasing a new version

1. Bump the version: `pnpm bump [x.y.z]` (updates `package.json` and
   `neutralino.config.json`).
2. Tag the release commit `vX.Y.Z`.
3. Push the tag — the release workflow builds and uploads every platform binary to a
   draft GitHub release; publish when ready.

> Note: the `applicationId` in `neutralino.config.json` (`com.eso.addonmanager`)
> defines the app-data directory subfolder. Changing it will move your config/DB and
> make the app appear to lose its setup — keep it stable across releases.

## Gotchas (non-obvious Neutralinojs quirks)

These are worth knowing before changing the plumbing:

- **`net.request` is text-only.** Its `body` is a UTF-8 string over the WebSocket
  bridge — bytes 0x80–0xFF that aren't valid UTF-8 get corrupted. That's why binary
  zip downloads go through `curl` + `filesystem.readBinaryFile` instead of `net.request`.
  If you add another binary download, don't reach for `net.request`.
- **No `exists` in the filesystem API.** Use `filesystem.getStats(path)` in a
  try/catch — `paths.pathExists` wraps this.
- **`filesystem.remove` is recursive by default** (it calls `remove_all`), so it
  replaces Tauri's `remove(path, { recursive: true })` directly.
- **`filesystem.createDirectory` is recursive by default** (creates parents), so it
  replaces Tauri's `mkdir(path, { recursive: true })`.
- **`writeBinaryFile` takes an `ArrayBuffer`, not a `Uint8Array`.** When writing
  fflate's decompressed bytes, pass `data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)`
  to avoid shared-buffer offset issues.
- **`readDirectory` returns `{ entry, path, type }`** where `type` is the string
  `'FILE'` / `'DIRECTORY'` / `'OTHER'` (not a boolean `isDirectory`). Filter on
  `type === 'DIRECTORY'` and read the name from `entry`.
- **The OS path separator** is derived from the runtime `window.NL_OS` global in
  `paths.ts` (`\\` on Windows, `/` elsewhere), since the zip-extraction hot loop
  needs a synchronous join and `filesystem.getJoinedPath` is async.
- **`neu update` does not download the client library** when you use `@neutralinojs/lib`
  from npm (it prints a note and skips it). That's expected — Vite bundles the npm
  package. Don't add a `cli.clientLibrary` path.
- **`neu build` needs `cli.resourcesPath`/`extensionsPath`** set in
  `neutralino.config.json`, even with the Vite `frontendLibrary` integration; without
  them the build fails with `ENOENT: no such file or directory, stat './undefined'`.

### Dev mode (`neu run`) gotchas

- **`frontendLibrary.projectPath` is required.** Without it neu silently skips the
  `devCommand` (Vite never starts) and `neu run` times out with
  `Timeout exceeded while waiting till local TCP port: 1420`. It's set to `"."` here.
- **Vite must bind IPv4.** Vite v8 defaults to binding IPv6 `[::1]` only, but neu's
  port-wait probe (and the Neutralino webview) resolve the dev host to IPv4
  `127.0.0.1` — so the probe never connects and times out. `vite.config.ts` sets
  `server.host: '127.0.0.1'` and `neutralino.config.json` uses
  `devUrl: "http://127.0.0.1:1420"` (not `localhost`) to avoid the ambiguity.
- **neu patches `index.html` on disk at startup and reverts it on graceful exit.**
  While `neu run` is active the `<script src="__neutralino_globals.js">` tag is
  rewritten to point at the neu server. Stop neu with **Ctrl+C (SIGINT)** so the
  cleanup runs and the file is restored. If you kill it with `SIGKILL`/`kill -9` or
  a hard `timeout`, the patch is left in place — just restore the tag to
  `<script src="__neutralino_globals.js"></script>` (it's gitignored-safe to revert
  since the clean version is what's committed).

## Contributing

Contributions are welcome. Please be nice when interacting with others.