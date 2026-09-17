# Chaotic Addon Manager

A desktop GUI for browsing, installing, updating, and removing
[Elder Scrolls Online](https://www.elderscrollsonline.com/) add-ons, sourced from
[ESOUI](https://www.esoui.com/) / [MMOUI](https://www.mmoui.com/).

It is a port of the original `download_addon.py` CLI into a Tauri 2 + Vue 3 app:
all of the Python tool's logic (download filelist, search, download & extract
zips, track installed addons, dependency auto-install, update/remove) has been
rewritten in TypeScript and runs in the frontend, talking to the filesystem and
network through Tauri plugins.

> **Derived from:** This project is based on the
> [tauri-vue-template](https://github.com/Uninen/tauri-vue-template) by
> [@Uninen](https://github.com/Uninen). The Tauri 2 + Vue 3 + Pinia + Tailwind + Vite
> scaffolding, auto-import setup, CI workflows, and VS Code configuration come from
> that template; the addon-management logic and UI were added on top of it.

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
- **Settings backup & restore** — export the tracked-addon list, the entire
  `SavedVariables` folder, and `UserSettings.txt` into a single zip; importing
  wipes the AddOns folder, re-downloads every addon from the backup (with a
  progress bar), and restores the settings files (existing SavedVariables are
  moved to a timestamped backup folder first).
- **Elder Scrolls-inspired theme** — dark stone/leather UI with gold accents, Cinzel
  display headings, and addon thumbnails next to names.

## Tech stack

- **Tauri 2** — desktop shell (Rust backend, webview frontend)
- **Vue 3 + TypeScript** — type-safe frontend with Composition API
- **Pinia** — state management
- **Tailwind CSS v4** — styling
- **Vite** — dev server & bundler, with `unplugin-auto-import` / `unplugin-vue-components`
- **Vitest** — unit testing
- **fflate** — in-webview zip compression & decompression
- **Tauri plugins**: `http`, `fs`, `dialog`, `store` (all v2)

## Quick start

1. Install the [Tauri prerequisites](https://tauri.app/start/prerequisites/) (Rust
   toolchain + system webview libs).
2. Install dependencies and run:

```sh
pnpm i
pnpm tauri dev
```

> **pnpm note:** this repo uses pnpm. If `pnpm` is not on your PATH, enable it via
> corepack: `corepack enable pnpm && corepack prepare pnpm@latest --activate`.
> pnpm 11 requires build-script approval, configured in `pnpm-workspace.yaml`
> (`allowBuilds:`) — without it `pnpm i` exits with `ERR_PNPM_IGNORED_BUILDS` and
> native deps (esbuild, @swc/core, electron) won't postinstall.

On first launch the app opens with no AddOn folder set. Click **Set AddOn
folder…**, paste or browse to your ESO `…/live/AddOns` directory, and hit
**Save** — this downloads the addon catalog and reconciles the folder.

## Architecture

A Tauri app has [two processes](https://tauri.app/concept/process-model/):

- **Core Process** (Rust, `src-tauri/`) — minimal here: registers plugins and
  capabilities. There are **no custom Rust commands**; all addon logic is in the
  frontend and reaches the OS through Tauri plugin JS APIs.
- **WebView process** (TS/Vue, `src/`) — the entire application.

### Data layout

The app keeps its own data separate from the user's addon folder:

| What | Where | Notes |
| --- | --- | --- |
| `config.json` (addon path, deps toggle) | app data dir (`$APPDATA`) | via `tauri-plugin-store` |
| `installed.json` (tracked-addon DB) | app data dir | app-managed schema, not the Python tool's format |
| `filelist.json` (catalog cache) | app data dir | downloaded from `api.mmoui.com` |
| Addon folders | user-chosen AddOn dir | only extracted addon folders; the app never writes metadata here |

### Frontend layout

- **`src/lib/`** — the ported CLI logic, one module per concern:
  - `http.ts` — download the filelist; fetch addon zip bytes (with status/content-type checks)
  - `zip.ts` — `fflate` decompression + `plugin-fs` extraction, with path-traversal hardening (rejects absolute/`..` entries); `## DependsOn:` parsing
  - `backup.ts` — settings export/import: zips `manifest.json` + `installed.json` + `UserSettings.txt` + `SavedVariables/**` via `fflate`; import is split into `readBackup` (parse/validate, no side effects) and `restoreSettings` (move overwritten SavedVariables to `SavedVariables.bak-<timestamp>/`, write files, persist the actually-installed DB list)
  - `filelist.ts` — cache load, name search, UID lookup, thumbnail URL
  - `installed.ts` — installed DB load/save/upsert/remove
  - `config.ts` — persisted app config (plugin-store)
  - `paths.ts` — app-data path helpers + sync `join`/`dirname`/`safeRelative`
  - `addonManager.ts` — orchestrators: `installAddon`, `removeAddon`, `checkUpdates`, `updateAddon`, `updateAll`, `reinstallAddons` (folder wipe + sequential reinstall with progress, used by the settings import)
  - `import.ts` — `reconcileInstalledWithFolder` (prune + import on Save)
  - `types.ts` — `FileListEntry` (API shape), `InstalledAddon` (our schema)
- **`src/stores/addons.ts`** — Pinia store holding all reactive state and async actions.
- **`src/components/`** — `SettingsBar` (folder popup + refresh + deps toggle),
  `InstalledList`, `SearchPanel`, `AddonIcon`, and `App.vue`.

### Permissions, capabilities & CSP

- **`src-tauri/capabilities/default.json`** — grants `http`, `dialog`, `store`, and
  `fs` permissions. The `fs` scope is broad (`$APPDATA/**` + `$HOME/**`) because the
  whole point is "user picks an arbitrary folder". HTTP is allowlisted to
  `https://api.mmoui.com/*` and `https://www.esoui.com/*`.
- **`tauri.conf.json`** — `plugins.fs.requireLiteralLeadingDot: false` (see
  gotchas below); CSP `img-src` allows `https://cdn-eso.mmoui.com` for addon
  thumbnails, `font-src`/`style-src` allow Google Fonts (Cinzel / EB Garamond).

## Project structure and usage

Frontend code lives in `src/`; the Rust backend in `src-tauri/`. See `package.json`
for all scripts.

### Common commands

```sh
pnpm tauri dev      # run the app (backend + frontend + devtools)
pnpm build          # type-check (vue-tsc) + build the frontend (vite)
pnpm test           # run Vitest unit tests
pnpm type-check     # vue-tsc type-check only
pnpm tauri build    # build a distributable bundle
pnpm check          # cargo check the Rust backend
```

### Debugging

- The dev build opens devtools automatically (see `src-tauri/src/lib.rs`).
- `RUST_BACKTRACE=1` is set for the dev command; Rust backtraces print to the console.
- VS Code: debug Rust with the included **Debug Tauri** launch config.

## Building and releasing

### Building

GitHub Actions (`.github/workflows/`) automatically test and build on push/PR. To
build manually:

```sh
pnpm tauri build
```

### Linux packages

All Linux builds use Tauri/WebKitGTK. On Wayland, the app applies a built-in
WebKitGTK DMA-BUF fallback from `src-tauri/src/lib.rs`, so the same renderer fix
is used by AppImage, deb, rpm, and native Arch packages. To test the native
DMA-BUF renderer on systems where it is stable, start the app with
`CHAOTIC_ADDON_MANAGER_ENABLE_WEBKIT_DMABUF=1`.

Install the common build prerequisites first:

```sh
pnpm i
rustup default stable
```

#### AppImage (generic Linux)

Use AppImage when you want one portable file that can run on many Linux
distributions:

```sh
pnpm tauri build --bundles appimage
```

Output:

```text
src-tauri/target/release/bundle/appimage/Chaotic Addon Manager_1.0.0_amd64.AppImage
```

#### Arch / Manjaro / EndeavourOS

For Arch-based systems, prefer the native pacman package over the AppImage. It
uses the system WebKitGTK stack directly and integrates with the package manager.

Install build dependencies:

```sh
sudo pacman -S --needed base-devel rust nodejs pnpm webkit2gtk-4.1 gtk3 xdg-utils hicolor-icon-theme
```

Build and install:

```sh
cd packaging/arch
./build-package.sh
sudo pacman -U chaotic-addon-manager-1.0.0-1-x86_64.pkg.tar.zst
```

#### Debian / Ubuntu / Linux Mint

Install Tauri's Linux prerequisites, then build a `.deb` package:

```sh
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf build-essential curl wget file
pnpm tauri build --bundles deb
```

Output:

```text
src-tauri/target/release/bundle/deb/
```

Install the generated package with:

```sh
sudo apt install ./src-tauri/target/release/bundle/deb/*.deb
```

#### Fedora / Nobara / openSUSE / RHEL-like systems

Install Tauri's Linux prerequisites, then build an `.rpm` package. Package names
vary slightly by distribution; these Fedora/Nobara names are the known-good
baseline:

```sh
sudo dnf install webkit2gtk4.1-devel gtk3-devel libappindicator-gtk3-devel librsvg2-devel patchelf gcc gcc-c++ make curl wget file
pnpm tauri build --bundles rpm
```

Output:

```text
src-tauri/target/release/bundle/rpm/
```

Install the generated package with:

```sh
sudo dnf install ./src-tauri/target/release/bundle/rpm/*.rpm
```

To build all Tauri-provided Linux bundle formats in one run:

```sh
pnpm tauri build --bundles appimage,deb,rpm
```

### Releasing a new version

Release builds are automated by `.github/workflows/release.yml` when a tag that
starts with `v` is pushed. The workflow publishes AppImage, deb, rpm, native Arch
package, and Windows portable ZIP assets to a GitHub Release.

1. Bump the version: `pnpm bump [x.y.z]`
2. Update the lockfile: `pnpm check` (refreshes `Cargo.lock`)
3. Tag the release commit `vX.Y.Z`
4. Push the tag:

   ```sh
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

The GitHub Release is created automatically from the tag and includes generated
release notes plus all built package assets.

> Note: the `identifier` in `tauri.conf.json` (`com.eso.addonmanager`) defines the
> app-data directory path. Changing it will move your config/DB and make the app
> appear to lose its setup — keep it stable across releases.

### Cross-compiling for Windows (from Linux)

Tauri's Windows build uses the MSVC toolchain + WebView2, so cross-compiling from
Linux needs [`cargo-xwin`](https://github.com/rust-cross/cargo-xwin), which
auto-downloads the Windows SDK and provides the MSVC libs/linker. **Only the NSIS
installer (`.exe`) can be cross-compiled this way** — `.msi` output requires the
WiX Toolset, which only runs on Windows.

1. Install host prerequisites (Fedora/Nobara):

   ```sh
   sudo dnf install nsis lld llvm clang
   ```

   > Fedora's `nsis` package may need extra stubs/plugins that aren't shipped by
   > the distro — see the [Tauri Windows installer guide](https://v2.tauri.app/distribute/windows-installer/)
   > if the NSIS step fails. (On Ubuntu the equivalent is `sudo apt install nsis lld llvm clang`.)

2. Add the Windows Rust target and install `cargo-xwin`:

   ```sh
   rustup target add x86_64-pc-windows-msvc
   cargo install --locked cargo-xwin
   ```

   Optionally set `XWIN_CACHE_DIR` so the downloaded Windows SDK is shared across
   projects instead of re-fetched per build.

3. Build the NSIS installer for Windows:

   ```sh
   pnpm exec tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc
   ```

   The installer lands in `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`.
   For other architectures swap the target for `i686-pc-windows-msvc` (32-bit) or
   `aarch64-pc-windows-msvc` (ARM64, needs ARM64 C++ build tools).

**Known caveats** (as of 2025): `llvm-rc` can fail compiling the app's `.rc`
resource files when cross-compiling
([tauri#13829](https://github.com/tauri-apps/tauri/issues/13829)), and bundling
inside Docker can hit a cross-device link error
([tauri#10647](https://github.com/tauri-apps/tauri/issues/10647)). The most reliable
alternative — and the one the Tauri team recommends — is to build the Windows
release on a **Windows runner via GitHub Actions** (the repo already ships release
workflows in `.github/workflows/` that can be extended with a Windows job).

## Gotchas (non-obvious Tauri 2 quirks)

These bit development and are worth knowing before changing the plumbing:

- **`@tauri-apps/api/path`'s `sep` is a function**, not a string constant
  (`sep(): string`). Using it as a value silently concatenates the function's source
  text into paths (e.g. `AddOnsfunction sep()…AsylumNotifier`), which then fails the
  fs scope check. Always call `sep()`.
- **`tauri-plugin-store` v2.4 has no `init()`** — register with
  `tauri_plugin_store::Builder::default().build()`.
- **fs JS API names**: `mkdir` (not `createDir`), `remove` (not `removeDir`).
  `create()` is a file-handle opener, **not** mkdir.
- **Capability permission names are strict**: `fs:allow-remove-dir` does not exist
  (use `fs:allow-remove`); the build fails fast and lists every valid permission.
- **fs scope globs**: `*` matches a single path segment, `**` matches recursively —
  use `$HOME/**` to reach nested addon files.
- **`requireLiteralLeadingDot` defaults to `true` on Linux**, so `$HOME/**` will
  **not** match paths through dot-directories (e.g. Steam Proton compatdata under
  `~/.local/share/Steam/…`). Symptom: "forbidden path … not allowed on the scope for
  `allow-exists`". Fix: `plugins.fs.requireLiteralLeadingDot: false` (already set).
- **plugin-http fetch runs in Rust** and bypasses webview CSP, so `connect-src`
  changes are only defensive; the real network gate is the `http:default` URL
  allowlist in the capability.
- **AppImage bundling fails on modern Fedora/RHEL** with
  `failed to run linuxdeploy` / `strip: unknown type [0x13] section .relr.dyn`.
  Cause: Tauri downloads `linuxdeploy` (an AppImage) whose bundled `strip` is an
  old GNU binutils that can't parse the `.relr.dyn` ELF section used by current
  glibc-built system libraries. linuxdeploy honors `NO_STRIP=1` to skip that
  step, so the `tauri` script in `package.json` is wrapped with
  `cross-env NO_STRIP=1` — `pnpm tauri build` sets it for you. If you call
  `cargo tauri build` or the `tauri` CLI directly, export `NO_STRIP=1` first.
  (The AppImage's own binary is still stripped via the Rust release profile;
  only linuxdeploy's library-strip pass is skipped.)

## Contributing

Contributions are welcome. Please be nice when interacting with others.
