# CLAUDE.md

Guidance for working in this repository.

## What this is

`pics-rs` is a lightweight, fast-launching desktop photo viewer/editor
(view, zoom/pan, crop, resize, rotate, folder gallery) built with **Rust +
Tauri v2**. The full product spec lives in [`docs/specs.md`](docs/specs.md) —
read it before making non-trivial changes; section references like "spec §4.2"
throughout the code point back to it.

## Repository layout (Bun monorepo)

```
pics-rs/                     # monorepo root (Bun workspaces)
├── package.json             # workspace root; scripts proxy into apps/pics-rs
├── tsconfig.base.json       # shared TS compiler options
├── docs/specs.md            # product spec & requirements (source of truth)
└── apps/
    └── pics-rs/             # the Tauri application
        ├── index.html
        ├── vite.config.ts
        ├── src/             # frontend (React + TS)
        │   ├── stores/      # Zustand: viewer / gallery / preferences
        │   ├── components/  # Toolbar, Viewer
        │   ├── hooks/       # keyboard shortcuts
        │   ├── lib/         # tauri bridge, persistence, actions
        │   └── types/       # shared domain types
        └── src-tauri/       # Rust backend
            ├── Cargo.toml
            ├── tauri.conf.json
            ├── capabilities/
            └── src/commands/  # read_image_entry, scan_folder, get_thumbnail
```

## Commands

All commands run from the repo root (Bun resolves the workspace):

| Task | Command |
|---|---|
| Install deps | `bun install` |
| Frontend dev server | `bun run dev` |
| Typecheck frontend | `bun run typecheck` |
| Build frontend | `bun run build` |
| Run the desktop app (dev) | `bun run tauri:dev` |
| Build the desktop app | `bun run tauri:build` |
| Check Rust backend | `cd apps/pics-rs/src-tauri && cargo check` |

**Toolchain:** Bun is the JS package manager/runner; the app binary is still
compiled by `cargo`/`rustc` via the Tauri CLI. On Linux, building the Rust side
needs the usual Tauri system deps (`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`,
`librsvg2-dev`, `libayatana-appindicator3-dev`).

## Architecture notes (see spec §6)

- **Heavy lifting stays in Rust** (decode/encode, resize, thumbnails, EXIF,
  clipboard, filesystem). The webview does live preview transforms with CSS.
- **Never push image bytes through IPC.** On-disk files load directly in the
  webview via the asset protocol (`convertFileSrc` / `assetUrl`). Only metadata
  and small results cross the IPC boundary.
- **Zustand stores are focused, not one global blob:** `viewerStore` (current
  image, transform stack, zoom), `galleryStore` (folder, entries, selection),
  `preferencesStore` (theme, sort, export defaults — persisted to IndexedDB).
- **Edits are non-destructive:** a transform stack (`Transform[]`) is kept in
  memory and only rasterized by the backend on export/save.
- **Theme** is a root `.dark` class on `<html>`, driven by `preferencesStore`
  and kept in sync with `prefers-color-scheme`; Tailwind's `dark:` variant keys
  off it.
- **IndexedDB is for low-stakes, regenerable state only** (spec §8.14) — never
  treat it as durable storage.

## Conventions

- Keep the frontend↔backend contract in one place: all `invoke` calls live in
  `src/lib/tauri.ts`; command payloads use camelCase (`serde(rename_all)` on the
  Rust structs mirrors the TS interfaces in `src/types/`).
- Tauri command errors return the `Error` type in `src-tauri/src/error.rs`,
  which serializes to a plain string for the UI.
- New Tauri commands: add the `#[tauri::command]` fn, register it in
  `generate_handler!` in `src-tauri/src/lib.rs`, and add a typed wrapper in
  `src/lib/tauri.ts`.
