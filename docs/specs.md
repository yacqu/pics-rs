# Lightweight Photo Viewer/Editor — Spec & Requirements
Rust + Tauri v2 + Vite + TypeScript + React · Zustand + IndexedDB · Tailwind CSS · lucide-react · Bun

## 1. Overview
A native-feel, fast-launching desktop app that replaces the OS default photo viewer, with basic non-destructive editing (crop/resize/rotate) and a folder/gallery browsing mode. Positioning: lightweight (small binary, fast cold start) — this constrains format support and bundling decisions throughout (see §8).

## 2. Goals / Non-Goals
**Goals**
- Fast open of a single image (double-click / "Open with")
- View, zoom/pan, rotate, crop, resize
- Clipboard round-trip (copy image out, paste image in)
- Browse a folder like a lightweight gallery, jump to next/prev
- Small install size, fast startup — competitive with native viewers

**Non-goals (v1)**
- Full photo management (albums, tagging, face detection, cloud sync)
- Layers, filters/adjustments (exposure, curves), non-JPEG RAW workflow
- Mobile — Tauri v2 supports iOS/Android, but scope this as desktop-only initially

## 3. Target Platforms
Windows, macOS, Linux (X11 + Wayland). Each OS has different mechanics for "default app" registration and clipboard image handling — treat as three separate QA passes, not one (see §8).

## 4. Functional Requirements

### 4.1 Viewer / Navigation
- Open single file via: CLI arg (OS file-open), drag-and-drop, File > Open dialog
- Next/previous navigation cycles through sibling image files in the same folder (sorted by name/date, user-configurable)
- Keyboard shortcuts: arrow keys (prev/next), +/- (zoom), R (rotate), Esc (close/back to gallery), Ctrl/Cmd+C / V (clipboard)
- Fit-to-window and 100% view toggle
- Multiple images open at once: single-window-replaces-content for MVP; multi-tab and multi-window support planned for a later phase (see §9)

### 4.2 Zoom
- Mouse wheel zoom, trackpad pinch-zoom (macOS), on-screen +/- buttons, keyboard shortcuts
- Zoom-to-point (cursor position stays fixed under pointer while zooming), not just center-zoom
- Min/max zoom bounds (e.g. 10%–1600%)
- Smooth pan when zoomed in (click-drag, trackpad two-finger, space+drag)
- Display current zoom % in UI

### 4.3 Crop
- Draggable crop rectangle overlay with resize handles
- Fixed aspect-ratio presets (free, 1:1, 4:3, 16:9, original) + custom ratio input
- Numeric input for exact crop dimensions/position
- Preview updates live; commit on explicit action (not destructive until user confirms)

### 4.4 Resize
- Resize by pixel dimensions or percentage
- Lock/unlock aspect ratio toggle
- Choice of resample filter isn't usually user-facing — pick one good default (Lanczos3) rather than exposing it
- Applies at export/save time, not to the working preview

### 4.5 Rotate & Straighten
- Quick 90°-step rotate (left/right) and horizontal/vertical flip — lossless for JPEG when possible (see note below)
- Arbitrary-angle straighten (e.g. -45° to 45° slider) for horizon correction, with canvas auto-expand or crop-to-fit choice
- Respect and normalize EXIF orientation on load so rotation state is always explicit, not hidden in metadata

### 4.6 Clipboard
- **Copy image to clipboard** — from current view or a selected file in gallery
- **Paste image from clipboard** — creates a new "unsaved" image the user can then save/export
- **Open from clipboard** — same as paste, entry point via menu/shortcut
- Cross-platform image clipboard formats differ (Windows CF_DIB/PNG, macOS TIFF/PNG, Linux varies by X11 vs Wayland/compositor) — normalize to PNG or raw RGBA internally

### 4.7 Folder / Gallery View
- Grid of thumbnails for the current folder, virtualized (only render visible tiles) since folders can have thousands of files
- Async thumbnail generation off the UI thread, with a persistent on-disk cache keyed by (path, size, mtime) so re-opening a folder doesn't regenerate everything
- Click thumbnail → open full view; folder updates live if files are added/removed/renamed externally (filesystem watch)
- Sort by name / date modified / date taken (EXIF) / file size; basic filter by extension

### 4.8 File Format Support
- **MVP tier (must-have):** JPEG, PNG, WebP (static), GIF (static frame), BMP
- **v2 tier:** TIFF, animated GIF/WebP playback, AVIF
- **Stretch/optional, flag clearly as complex:** HEIC/HEIF (iPhone default format — see §8), camera RAW (CR2/NEF/ARW/DNG — likely out of scope, see §8)

### 4.9 Save / Export
- "Save" (overwrite) vs "Save As" (new file/format) — default to Save As or an explicit confirm-overwrite to avoid silently destroying originals, since this app opens files the user didn't create in-app
- Export format/quality choice (JPEG quality slider, PNG compression)
- Preserve or strip EXIF/metadata on export — make this an explicit toggle (privacy-relevant: GPS location in EXIF)
- Undo/redo for the edit session (crop/resize/rotate stack), not full pixel history

### 4.10 System Integration ("replace the native viewer")
- Register file associations for supported extensions so "Open with" / double-click works
- Set app as launchable target from OS "Open With" menu; becoming the *default* still requires explicit user action per OS (no app can silently hijack this — see §8)
- Single-instance behavior: opening a second image while the app is running should route to the existing instance/window, not spawn a duplicate process
- App icon, correct file-type icons in OS file browsers (platform-specific, optional polish)

### 4.11 Theming & Preferences
- Light/dark mode, responsive to OS-level `prefers-color-scheme`, plus a manual override (light / dark / system) in-app
- Preferences (theme choice, last-used folder, sort order, keyboard shortcut overrides, default export format/quality) persist across restarts
- Preferences and lightweight app state (e.g. window layout, last session's open files) stored client-side in IndexedDB rather than round-tripped through Rust — keeps reads/writes fast and off the IPC boundary for things that don't need filesystem access

## 5. Non-Functional Requirements
- Cold start to visible image: target well under 1s for typical JPEG/PNG sizes
- Memory: don't hold multiple full-resolution decoded bitmaps in memory simultaneously in gallery mode — decode on demand, keep only thumbnails resident
- UI stays responsive during thumbnail generation, decode, and export (all off the main/UI thread)
- Should work fully offline, no network dependency

## 6. Suggested Architecture
- **Frontend (Vite + TS + React):** rendering, zoom/pan/crop UI interaction, gallery grid virtualization. Do live preview transforms (pan/zoom/crop-rect) with CSS transforms or Canvas2D — cheap, GPU-accelerated, avoids round-tripping to Rust on every mouse-move.
- **State management (Zustand):** current image, edit/transform stack, gallery selection, UI state (active panel, theme). Keep Zustand stores focused (e.g. a `viewerStore`, `galleryStore`, `preferencesStore`) rather than one global blob, since gallery state and preferences have very different lifetimes.
- **Persistence (IndexedDB):** preferences, theme, last-used folder, thumbnail-cache metadata (not the thumbnail bytes themselves — those are cheaper to keep as files on disk via Rust, see §7/§8). Wrap raw IndexedDB with a small library rather than the native API directly (see §7).
- **Styling (Tailwind CSS):** utility-first, pairs well with a `dark:` variant strategy driven off a root `class="dark"` toggle that Zustand's theme state controls — straightforward to keep in sync with `prefers-color-scheme` on first load.
- **Icons (lucide-react):** consistent icon set for toolbar/menu actions (crop, rotate, zoom, etc.) — tree-shakeable, so bundle size stays proportional to icons actually used.
- **Rust backend (Tauri commands):** actual image decode/encode, resize, rotate, crop rasterization, EXIF read/write, thumbnail generation, clipboard I/O, filesystem walking/watching. Keep the "heavy lifting" out of the webview.
- **Data transfer:** avoid pushing large image bytes through default Tauri IPC (it JSON/base64-serializes, which is slow for multi-MB images). Use the Tauri asset protocol (`convertFileSrc`) to let the webview load images directly from disk, or a custom protocol handler / raw byte-channel command for clipboard-sourced or in-memory images. This matters a lot for perceived performance.
- **Edit model:** non-destructive transform stack (list of {crop, resize, rotate} ops) applied to a working copy; rasterize only on export/save.
- **Tooling/runtime (Bun):** use Bun as the package manager and script runner for the frontend (`bun create tauri-app`, `bun install`, `bun tauri dev`, `bun tauri build`) — this is a first-class supported path in `create-tauri-app`, not a workaround. Bun only replaces Node for the JS tooling layer; the actual app binary is still compiled by `cargo`/`rustc` via the Tauri CLI, so this choice doesn't affect the Rust side at all.

## 7. Crate / Plugin Shortlist

| Purpose | Option(s) | Notes |
|---|---|---|
| Core image decode/encode | `image` | Covers JPEG/PNG/WebP/GIF/BMP/TIFF; good default |
| Fast resize | `fast_image_resize` or `pic-scale` | SIMD-accelerated; much faster than `image`'s built-in resize on large images |
| Geometric ops (arbitrary rotate, crop helpers) | `imageproc` | Interpolated rotation, affine transforms |
| EXIF read | `kamadak-exif` or `rexif` | Orientation, date-taken, GPS |
| EXIF write/preserve | `little_exif` or `img-parts` | Needed if you want metadata to survive edits/export |
| HEIC/HEIF decode | `libheif-rs` (bindings to system `libheif`) **or** `heic` (pure-Rust, Imazen) | See §8 — real complexity/licensing tradeoffs either way |
| Thumbnail generation parallelism | `rayon` | CPU-bound thumbnail batch work |
| Fast directory traversal | `jwalk` or `walkdir` | Gallery folder scanning |
| Filesystem watching | `notify` | Live-update gallery on external file changes |
| Clipboard (image) | `@tauri-apps/plugin-clipboard-manager` (official) | Confirmed to support `readImage`/`writeImage` as `Uint8Array` on desktop (not mobile) — start here |
| Clipboard fallback | `tauri-plugin-clipboard` (community, CrossCopy) or `arboard` (Rust-native) | Keep as backup if the official plugin's Linux image interop has gaps in testing |
| File dialogs | `@tauri-apps/plugin-dialog` | Open/Save native dialogs |
| Filesystem access | `@tauri-apps/plugin-fs` | Scoped read access; see capabilities note in §8 |
| Single-instance | `tauri-plugin-single-instance` | Prevents duplicate windows on repeated "Open with" |
| CLI arg parsing | `@tauri-apps/plugin-cli` or manual `std::env::args` | Capture the file path the OS launched you with |
| Gallery grid virtualization (frontend) | e.g. `@tanstack/virtual` or hand-rolled windowing | Needed once folders exceed a few hundred images |

### Frontend Package Shortlist

| Purpose | Package | Notes |
|---|---|---|
| UI framework | `react` / `react-dom` | Confirmed choice |
| State management | `zustand` | Small, no boilerplate, plays well with Tauri's async command calls |
| IndexedDB wrapper | `idb-keyval` (simple key/value) or `dexie` (more structure/querying) | Raw IndexedDB API is painful directly — `idb-keyval` is enough for flat preferences; reach for `dexie` if thumbnail-cache metadata or edit history needs querying |
| Styling | `tailwindcss` | Use the `dark:` variant + a root class toggle for light/dark, driven by Zustand theme state |
| Icons | `lucide-react` | Tree-shakeable, matches the "lightweight" goal |
| Build tool | `vite` | Already decided; works the same under Bun or Node |
| Package manager / runner | `bun` | `bun create tauri-app`, `bun install`, `bun tauri dev` — officially supported by `create-tauri-app`, no special config needed |

## 8. Key Considerations, Limitations & Difficulties

1. **HEIC/HEIF is the hardest format decision.** It's the default format for iPhone photos, so "replace the native viewer" pressure will push you toward supporting it — but:
   - `libheif-rs` wraps the C `libheif` library — real, mature, but adds a system dependency you must bundle/link per-OS (macOS can lean on system frameworks; Windows/Linux need you to ship libheif + its codec deps, which works against the "lightweight" goal).
   - The newer pure-Rust `heic` crate (Imazen) avoids the C dependency and is SIMD-accelerated, but is decode-only and currently reports partial real-world file compatibility (~118/162 test files as of its last update), and its own docs flag that HEVC/HEIF decoding may be subject to third-party patents depending on your jurisdiction and distribution model — worth a conscious decision (and maybe a lawyer's five minutes) before you ship it in an OSS project, not something to silently ignore.
   - Recommendation: treat HEIC as a post-MVP feature flag, not a v1 requirement.

2. **RAW camera formats** (CR2/NEF/ARW/DNG) are a much bigger undertaking than HEIC — sensor-specific demosaicing, inconsistent crate maintenance in the Rust ecosystem. Realistically out of scope for a "lightweight" viewer; call it explicitly out-of-scope rather than letting it linger as implied scope.

3. **Large image memory pressure.** A 45MP photo decoded to RGBA8 is ~180MB in memory. Don't decode full-res images just to show a fit-to-window preview — decode at a downsampled scale for display, only touch full-res for the actual crop/resize/rotate/export operation.

4. **IPC overhead for image bytes.** Passing multi-MB images through Tauri's default command serialization is slow. Use the asset protocol / `convertFileSrc` for on-disk files, and a raw-bytes channel or custom protocol for clipboard-sourced in-memory images. This is one of the more common "why is my Tauri image app janky" mistakes.

5. **Color management is a rabbit hole you can legitimately skip in v1.** Wide-gamut (Display P3) images and embedded ICC profiles require real work to render pixel-accurately. Document it as a known limitation (assume sRGB) rather than trying to solve it up front.

6. **EXIF orientation and metadata preservation.** Must normalize orientation on load (many decoders don't auto-rotate). On save, decide explicitly whether to preserve EXIF (camera info, GPS) — GPS-in-photo is a privacy-relevant default, worth exposing as a toggle rather than a silent choice either way.

7. **"Default app" registration is genuinely OS-specific busywork, not a config flag:**
   - **macOS:** declare `CFBundleDocumentTypes` / `LSHandlerRank` via `tauri.conf.json`'s `bundle.fileAssociations` — but the user still has to manually choose your app in Finder ("Get Info → Open With → Change All"); Apple deliberately blocks apps from silently becoming the default.
   - **Windows:** Tauri's `fileAssociations` config alone does *not* fully wire up "set as default" — you need a custom NSIS installer hook (`bundle.windows.nsis.installerHooks`) to register the registry entries, and the user still confirms via Windows Settings → Default Apps.
   - **Linux:** `.desktop` file + `xdg-mime default`, and behavior varies by desktop environment.
   - Budget real time for this — it's packaging/installer work, not app code, and needs testing on real installs (a Windows Sandbox VM is a good loop for iterating on the NSIS hook without repeatedly dirtying your main machine).

8. **Single-instance + "open with" wiring.** Without `tauri-plugin-single-instance`, every double-clicked file spawns a new app process. Wire the plugin so a second launch forwards its file path to the already-running window instead.

9. **Clipboard image support is uneven across Linux setups.** The official `@tauri-apps/plugin-clipboard-manager` does support image read/write via `Uint8Array` on desktop, but Linux clipboard interop (X11 vs Wayland, presence/absence of a clipboard manager) is historically the flakiest part of this — plan explicit Linux testing against real apps (browser, GIMP) and keep a fallback plugin in your back pocket.

10. **Gallery performance at scale.** A camera-roll-style folder can hold thousands of files. You need: virtualized grid rendering, async off-thread thumbnail generation (rayon), a persistent thumbnail cache (keyed by path+size+mtime so you don't regenerate on every folder open), and filesystem watching (`notify`) instead of full re-scans when files change externally.

11. **Destructive vs non-destructive editing.** Because this app opens files the user didn't create in it (unlike a typical "editor" workflow), an accidental silent overwrite is a worse failure mode than in most editors. Recommend defaulting to "Save As" / explicit overwrite confirmation, and keeping edits as a transform stack until export.

12. **Tauri v2's capability/permission model.** v2 requires explicit scoped filesystem capabilities per window rather than a blanket "fs access" flag. Since this app needs to browse arbitrary user-chosen folders (not just an app-data directory), plan to grant fs scope dynamically based on what the user opens via the dialog plugin, rather than trying to pre-declare a static wildcard scope. Worth reading the Tauri v2 capabilities docs before wiring file access, since the model is meaningfully different from v1.

13. **"Lightweight" vs format breadth is a direct tradeoff.** Every optional codec (HEIC, AVIF, animated WebP, RAW) adds binary size and per-OS build complexity. Decide your MVP format set explicitly (§4.8) and treat everything else as an opt-in feature behind a flag, rather than scope creeping toward "supports everything."

14. **IndexedDB lives inside the OS webview, not a browser you control.** Tauri renders through WebView2 (Windows), WKWebView (macOS), and WebKitGTK (Linux) — each has its own storage location and quirks (e.g. WebView2's data folder can be cleared by certain "clean up" utilities users run; behavior isn't identical to Chrome/Firefox IndexedDB). Treat IndexedDB as fine for preferences/cache metadata (low-stakes, regenerable), but don't treat it as guaranteed-durable storage for anything the user would be upset to lose — if undo history or preferences ever need to feel "permanent," a small file under the Tauri app-data directory (via `@tauri-apps/plugin-fs`) is more predictable than IndexedDB.

15. **Bun is a safe, supported choice here — low risk.** `create-tauri-app` and the Tauri CLI officially support Bun as the package manager/script runner (`bun create tauri-app`, `bun tauri dev`, `bun tauri build`); this is distinct from (and simpler than) the more exotic pattern of running Bun as an actual sidecar server process alongside the Rust backend, which you don't need here. The Rust build itself is untouched by this choice.

## 9. Suggested Phased Roadmap

**MVP (v0.1)**
Open single image (JPEG/PNG/WebP/BMP/static GIF) via file-open/CLI/drag-drop · zoom/pan · 90°-step rotate + flip · basic rectangular crop · resize + export · copy-to-clipboard · basic folder view with prev/next · file associations registered (macOS/Linux easy path; Windows NSIS hook)

**v0.2**
Paste-from-clipboard · arbitrary-angle straighten · EXIF-aware orientation normalization · thumbnail cache + virtualized gallery grid · undo/redo · single-instance wiring · Windows default-app installer polish

**v0.3+**
HEIC support (behind a feature flag) · TIFF/AVIF · animated GIF/WebP playback · EXIF preserve/strip toggle on export · basic color-profile awareness · batch export

**v0.4+**
Multi-tab support (several images open in one window) · multi-window support (separate OS windows, e.g. drag a tab out) · per-window/tab independent zoom/edit state via scoped Zustand stores

## 10. Open Decisions (need your call before/while building)
- MVP format list — confirm §4.8 tier split matches what you actually need on day one
- Non-destructive editing scope: is undo/redo persisted across app restarts, or session-only? (affects whether it belongs in IndexedDB or stays in-memory)
- HEIC: in scope for MVP or explicitly deferred? (Recommend deferred — see §8.1)
- IndexedDB wrapper: `idb-keyval` (simpler) vs `dexie` (more structure) — lean toward `idb-keyval` unless you already know you'll want querying over cached thumbnail metadata
