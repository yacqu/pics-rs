# pics-rs

Open source, lightweight photo viewer/editor built with **Rust + Tauri v2**.

A native-feel, fast-launching desktop app that replaces the OS default photo
viewer, with basic non-destructive editing (crop / resize / rotate) and a
folder gallery. See [`docs/specs.md`](docs/specs.md) for the full spec.

## Stack

- **Backend:** Rust · Tauri v2 · `image` crate
- **Frontend:** Vite · TypeScript · React · Zustand · Tailwind CSS · lucide-react
- **Persistence:** IndexedDB (`idb-keyval`) for preferences/UI state
- **Tooling:** Bun (package manager + script runner), monorepo via workspaces

## Layout

This is a Bun monorepo. The application lives in [`apps/pics-rs`](apps/pics-rs):

```
apps/pics-rs/
├── src/          # React frontend (stores, components, hooks, lib)
└── src-tauri/    # Rust backend (Tauri commands, config, capabilities)
```

## Getting started

Prerequisites: [Bun](https://bun.sh) ≥ 1.1, a Rust toolchain, and the
[Tauri v2 system dependencies](https://v2.tauri.app/start/prerequisites/) for
your OS. On Debian/Ubuntu:

```bash
sudo apt-get install libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev \
  libayatana-appindicator3-dev libssl-dev
```

Then, from the repo root:

```bash
bun install          # install workspace dependencies
bun run tauri:dev    # run the desktop app in development
```

### Common scripts

| Command | Description |
|---|---|
| `bun run dev` | Vite dev server (frontend only) |
| `bun run build` | Typecheck + build the frontend |
| `bun run typecheck` | Typecheck the frontend |
| `bun run tauri:dev` | Run the desktop app (dev) |
| `bun run tauri:build` | Build/bundle the desktop app |

## Status

Early scaffold. The MVP roadmap (single-image open, zoom/pan, rotate/flip,
crop, resize/export, copy-to-clipboard, folder view, file associations) is
tracked in [`docs/specs.md`](docs/specs.md) §9.

## License

MIT
