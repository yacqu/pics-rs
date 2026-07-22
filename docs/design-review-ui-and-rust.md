# Design Review: UI Evaluation & Rust Optimization Audit

_Date: 2026-07-22 · Scope: frontend UI layer (`apps/pics-rs/src`) and Rust backend
(`apps/pics-rs/src-tauri/src`) on branch `claude/initial-functionality-fixes-ft558a`._

This document has two parts:

1. **UI evaluation** — does the current UI make sense, and are there immediate issues?
2. **Rust optimization audit** — is the backend properly optimized, and what should be fixed?

Each finding lists a severity (**High / Medium / Low**) and a concrete recommended fix.
Spec references (§n) point at [`docs/specs.md`](specs.md).

---

## Part 1 — UI evaluation

### Overall assessment

The UI is coherent and well-considered for a lightweight photo viewer/editor: a
compact icon toolbar, a CSS-transform live-preview canvas, a virtualized gallery grid
with an inline split-preview, and floating tool panels for crop/resize/straighten. The
code is unusually careful about the hard parts (virtualization math, fit-to-window
continuity, iCloud/dataless states, responsive toolbar collapse). The main problems
are in the **keyboard layer** — global shortcuts conflict with the spec's clipboard
bindings and leak through the export modal — plus a few missing states (image load
errors, focus handling) and small visual bugs.

### 1.1 UI coherence

The layout model makes sense: persistent toolbar (`src/App.tsx:108`), a main pane that
is either the full-width viewer, the full-width gallery, or a gallery-strip + viewer
split once a tile is selected (`App.tsx:109-136`), and a status bar
(`App.tsx:137-162`). Keeping the Gallery wrapper as the same element across the
preview toggle (`App.tsx:118-126`) to preserve scroll/virtualization state is correct
and well-documented. Tool panels (crop/resize/straighten) each self-gate on
`activeTool` and render `null` otherwise (`src/components/Viewer.tsx:443-445`), so
only one is ever visible. Empty/loading/error states are handled in the Gallery
(`Gallery.tsx:260-272`), the empty viewer (`Viewer.tsx:341-347`), and the status bar.
Dark mode is applied consistently via the root `.dark` class with paired `dark:`
utilities throughout. The interaction model is clear and internally consistent.

### 1.2 Immediate issues

1. **Shortcuts ignore modifier keys, so `Ctrl/Cmd+C` and `Ctrl/Cmd+V` are hijacked —
   High.** `src/hooks/useKeyboardShortcuts.ts:37-96` switches on bare `event.key`
   with no `ctrlKey`/`metaKey` guard. `c` toggles the crop tool (`:72-78`), `v` flips
   vertical (`:68-71`), `f` flips horizontal (`:64-67`), and `event.preventDefault()`
   runs at `:96`. Pressing Ctrl+C (spec §4.1's "copy to clipboard") toggles the crop
   tool and suppresses native copy; Ctrl+V flips the image vertically. Both a
   functional conflict and a spec violation.

2. **Global shortcuts stay live while the Export modal is open — High.**
   `src/components/ExportDialog.tsx:75-82` renders a modal but installs no keydown
   capture, and `useKeyboardShortcuts` is mounted app-wide (`App.tsx:30`). With focus
   on a dialog button, arrow keys navigate to sibling images and `r`/`c`/`f`/`v`
   mutate the image behind the modal.

3. **Export dialog can't be dismissed with Escape — and Escape mutates the background
   — Medium.** No Escape handler anywhere in `ExportDialog.tsx`; it closes only via
   backdrop click (`:81`), the X (`:89-96`), or Cancel (`:213-219`). Escape falls
   through to the global handler (`useKeyboardShortcuts.ts:79-92`), which switches to
   gallery mode or closes the underlying image while the dialog stays open.

4. **Viewer has no image `onError` state — Medium.** The main `<img>`
   (`Viewer.tsx:419-436`) has only `onLoad` (`:423`). A corrupt file, revoked asset
   URL, or missing file leaves the blurred thumbnail placeholder up indefinitely
   (`showThumbPlaceholder`, `:218`/`:367`) or a blank pane, with no error affordance —
   unlike the gallery tile, which has an `ImageOff` fallback.

5. **The "Copying…" busy spinner never spins — Low.** `Toolbar.tsx:219` swaps the
   Copy icon to `Loader2` when busy, but it renders without an `animate-spin` class
   (`:401`, `:442`), so the loading indicator is a static spinner glyph.

6. **Toolbar buttons lack a visible keyboard-focus indicator — Low (a11y).**
   `Toolbar.tsx:53-70` (`ToolButton`) styles hover/active/disabled but has no
   `focus-visible:` ring, unlike `GalleryTile.tsx:66` which does. Same for the Export
   dialog's buttons.

7. **Export dialog does no focus management — Low (a11y).** `ExportDialog.tsx:75-86`
   sets `role="dialog"`/`aria-modal="true"` but has no autofocus on open and no focus
   trap, so Tab can reach controls behind the modal.

### 1.3 Spec mismatches

1. **Clipboard shortcuts (Ctrl/Cmd+C copy, Ctrl/Cmd+V paste) are unimplemented** —
   spec §4.1 lists them explicitly; `useKeyboardShortcuts.ts` has neither (and per
   issue 1.2.1 actively binds those chords to other actions). Copy exists only as a
   toolbar button (`Toolbar.tsx:216-222`). Paste-from-clipboard is absent from the UI
   entirely — acceptable for MVP since §9 defers paste to v0.2, but §4.1 still lists
   the binding.
2. **No custom aspect-ratio input in the crop tool** — spec §4.3 wants presets *plus*
   a custom ratio input; `CropOverlay.tsx:404` offers only
   free / 1:1 / 4:3 / 16:9 / original. Minor.
3. **Straighten has no auto-expand vs. crop-to-fit choice** — spec §4.5;
   `StraightenControl.tsx` exposes only the angle slider, with crop-to-fit hard-coded
   (see comment at `viewerStore.ts:28-29`). Minor.
4. **No explicit "100% / actual size" control** — spec §4.1 asks for a fit-to-window
   *and* 100% toggle; only fit exists (`Toolbar.tsx:377-383`, key `0` at
   `useKeyboardShortcuts.ts:54-55`). Minor.

### 1.4 Minor polish suggestions

- Drag-drop silently ignores unsupported files/folders after showing the "Drop an
  image to open" overlay (`App.tsx:91-97`) — a brief "unsupported file" hint would
  close the loop.
- `index.html:5` still points the favicon at the default `/vite.svg`.
- The straighten and export-quality range sliders lack `aria-label`s
  (`StraightenControl.tsx:63-71`, `ExportDialog.tsx:135-141`).
- `copyCurrentToClipboard` reports failures only to `console.error`
  (`src/lib/actions.ts:151-153`) — clipboard failures are invisible to the user; a
  lightweight toast system would surface these (the code comments note its absence
  repeatedly).

### UI priority order

| # | Finding | Severity | Effort |
|---|---|---|---|
| 1.2.1 | Modifier-key guard + real Ctrl/Cmd+C copy binding | High | Small |
| 1.2.2 | Suspend global shortcuts while a modal is open | High | Small |
| 1.2.3 | Escape closes the Export dialog | Medium | Trivial |
| 1.2.4 | `onError` state for the viewer image | Medium | Small |
| 1.2.5–7 | Spinner class, focus rings, dialog focus trap | Low | Small each |
| 1.3.x | Spec gaps (custom ratio, 100% toggle, straighten choice) | Low | Per-feature |

---

## Part 2 — Rust backend optimization audit

### Overall assessment

The backend is architecturally sound: heavy work is consistently pushed off the main
thread with `spawn_blocking`, image bytes never cross the IPC boundary (asset protocol
only), thumbnails/previews are disk-cached with mtime-keyed invalidation, and folder
scans and prewarms fan out with rayon. The big structural decisions match spec §5/§6.

What's left are targeted issues: a release profile that de-optimizes the hottest code,
unbounded parallel decode memory that violates spec §5, redundant file I/O on warm
paths, non-atomic cache writes, and a few avoidable full-image copies.

### 2.1 Release profile de-optimizes the image pipeline — **High**

`Cargo.toml` sets `opt-level = "s"` for release (`src-tauri/Cargo.toml:73`). Size
optimization is the right call for the app shell (fast cold start, spec §5), but it
also applies to `image`, `imageproc`, and the JPEG/PNG codecs — the single hottest CPU
in the app. Decode/resize inner loops lose vectorization at `-Os`; decode-bound
operations (thumbnails, previews, export) can slow down 1.5–3×.

**Fix:** keep `"s"` for the app crate but override the pixel-crunching dependencies:

```toml
[profile.release.package.image]
opt-level = 3
[profile.release.package.imageproc]
opt-level = 3
[profile.release.package.zune-jpeg]
opt-level = 3
[profile.release.package.png]
opt-level = 3
[profile.release.package.fdeflate]
opt-level = 3
```

Binary size impact is small (only those crates grow); decode throughput is where the
user feels it.

### 2.2 `prewarm_folder` can hold N full-resolution bitmaps at once — **High**

`prewarm_folder` (`commands/thumbnail.rs:263-292`) runs `generate_and_cache` under
`par_iter()` on rayon's default pool (one thread per core). Each cold, non-JPEG (or
preview-less JPEG) file does a **full-resolution decode**, so on an 8–16 core machine
the app can hold 8–16 decoded bitmaps simultaneously — for 24–50 MP photos that is
easily several GB, directly against spec §5 ("don't hold multiple full-resolution
decoded bitmaps in memory simultaneously in gallery mode").

**Fix:** cap the decode parallelism independently of core count, e.g. run the prewarm
in a dedicated `rayon::ThreadPoolBuilder::new().num_threads(2..4)` pool, or chunk the
work. This also stops the prewarm from starving interactive `get_thumbnail` calls and
the UI-facing decodes on the shared blocking pool (see 2.3).

### 2.3 Prewarm has no cancellation and races on-demand thumbnails — **Medium**

Once fired, `prewarm_folder` runs to completion even if the user immediately opens a
different folder — the old folder's decodes keep burning CPU that the new folder's
tiles need. Separately, a tile that scrolls into view mid-prewarm triggers
`get_thumbnail` for a file the prewarm is also processing: both generate the same
thumbnail and both write to the same `dest` path concurrently (wasted decode, and a
torn read is possible since the webview may load `dest` while the other writer is
mid-write).

**Fix:** give the prewarm a generation token (an `AtomicU64` in managed state, bumped
per `scan_folder`) checked in the `for_each` body so a stale prewarm drains quickly;
atomic cache writes (2.4) close the torn-read window; an in-flight set (`Mutex<HashSet
<PathBuf>>`) would eliminate the duplicated decode.

### 2.4 Cache writes are not atomic — **Medium**

`generate_and_cache` (`thumbnail.rs:101-120`), `quicklook_thumbnail` (`:159-165`), and
the preview encoder (`:376-402`) all write directly to the final cache path. A crash,
power loss, or full disk mid-write leaves a truncated PNG/JPEG at `dest`, and every
future run treats it as a valid cache hit (`dest.exists()`), permanently showing a
broken tile for that image.

**Fix:** write to `dest.with_extension("tmp")` (or a unique temp name) and
`std::fs::rename` into place. Rename is atomic on the same filesystem, which the cache
dir guarantees. This also makes the concurrent-writer race in 2.3 harmless.

### 2.5 Warm cache hits still open and parse the source file twice — **Medium**

The hot path — every tile of an already-visited folder — is `get_thumbnail`'s cache
hit (`thumbnail.rs:196-201`), which calls `dimensions_of(&source)`; that is one file
open for the header probe (`image::image_dimensions`) plus a second open + full EXIF
container parse (`exif_orientation`) — per tile, per app run, purely to re-derive
dimensions that were already known when the thumbnail was generated. `get_preview`'s
cache hit (`thumbnail.rs:362-370`) does the same. These also run inline on the async
runtime thread, not on a blocking worker — thousands of synchronous `open`s on a slow
or network volume will stall the async runtime.

**Fix:** persist the dimensions with the cache entry so a hit is zero-I/O beyond the
`stat` in `cache_key` — e.g. encode `{w}x{h}` into the cache filename
(`{hash}_{size}_{w}x{h}.png`, parsed on hit) or store a tiny sidecar. At minimum, move
the probe into the `spawn_blocking` closure.

### 2.6 `dimensions_of` failure is reported as `Some(0×0)` — **Low**

Both cache-hit paths use `.unwrap_or_default()` on `dimensions_of`
(`thumbnail.rs:199`, `:364`), converting "unknown" into `width: Some(0), height:
Some(0)` / `width: 0`. The frontend then sees fake 0×0 dimensions instead of the
`None` the API shape was designed to express.

**Fix:** map failure to `(None, None)` for thumbnails; for `get_preview` (non-optional
fields) return an error or fall back to decoding the cached preview's own dimensions.

### 2.7 Redundant EXIF re-parsing in the decode paths — **Low**

- `load_oriented` (`commands/mod.rs:196-199`) decodes via `image::open`, then
  `exif_orientation` re-opens the file and parses the EXIF container again.
- `generate_and_cache`'s embedded-preview path (`thumbnail.rs:106-113`) parses EXIF in
  `embedded_preview`, then calls `dimensions_of`, which opens the file twice more
  (header probe + another full EXIF parse).

Each extra parse is an open + buffered read of the entire EXIF segment. Individually
cheap, but this sits inside the thumbnail flood and prewarm loops.

**Fix:** parse EXIF once per operation and thread the `orientation` value (and the
already-read `exif::Exif`) through — e.g. `load_oriented` takes an optional
pre-fetched orientation, `embedded_preview` returns `(preview, orientation)` so the
caller can reuse it for the dimension swap.

### 2.8 Avoidable full-image copies (`to_*` vs `into_*`) — **Low**

Three call sites use the borrowing conversion, which clones the entire buffer even
when the image is already in the target format:

- `copy_image_to_clipboard`: `img.to_rgba8()` (`export.rs:138`) — after a Straighten
  the image *is* already `ImageRgba8`, so this clones tens of MB before the clipboard
  handoff that was already flagged as slow (issue #3).
- `get_preview`: `preview.to_rgb8()` (`thumbnail.rs:389`).
- `Transform::Straighten`: `img.to_rgba8()` (`transform.rs:97`).

**Fix:** use the consuming `into_rgba8()` / `into_rgb8()` — same semantics, no copy
when the representation already matches.

### 2.9 `scan_folder` runs its per-file `stat`s sequentially before rayon — **Low**

The comment on `scan_folder` (`gallery.rs:33-38`) says the per-file stats are
parallelized, but the *filter* stage — `p.is_file()`, a `stat` per directory entry —
runs in the sequential collect loop; rayon only parallelizes the second `stat` in
`build_entry`. On a cold 5k-file network folder the serial half is the bottleneck the
parallelism was meant to remove.

**Fix:** use `DirEntry::file_type()` in the sequential loop (free on most platforms —
it comes from `readdir` without an extra `stat`) and move any remaining
`is_file`-style checks into the rayon stage, or `par_bridge()` the whole pipeline.

### 2.10 Thumbnails are cached as PNG — **Low**

`generate_and_cache` saves thumbnails as PNG (`thumbnail.rs:109`, `:118`). For
photographic content PNG is the slowest encoder in the pipeline and produces ~3–5×
larger files than JPEG at grid sizes — more disk, more asset-protocol bytes for the
webview to decode per tile. The preview cache already made the right call with JPEG
q85 (`thumbnail.rs:392`).

**Fix:** encode thumbnails as JPEG (quality ~80–85). If alpha matters for the rare
transparent PNG/GIF source, branch on `img.color().has_alpha()` and keep PNG only for
those.

### 2.11 `ensure_downloaded` buffers the whole file to trigger the download — **Low**

The iCloud materializer (`commands/mod.rs:116`) uses `std::fs::read`, allocating the
entire file (potentially hundreds of MB) in memory only to throw it away — the read
exists solely to force macOS to download the bytes.

**Fix:** stream instead of buffering: `std::io::copy(&mut File::open(path)?, &mut
std::io::sink())` materializes the file with a fixed-size buffer.

### 2.12 Cache keys use `DefaultHasher`, which is not stable across Rust releases — **Low**

`cache_key` / `preview_cache_key` (`thumbnail.rs:34`, `:318`) hash with
`std::collections::hash_map::DefaultHasher`, whose algorithm is explicitly not
guaranteed stable across Rust versions. A toolchain upgrade can silently invalidate
every user's thumbnail cache (a full regeneration storm on next launch, not a
correctness bug).

**Fix:** use a stable, explicit hasher — e.g. `twox-hash` (XXH3) or FNV-1a hand-rolled
over the same fields.

### 2.13 Spec-suggested SIMD resize is not used — **Low (deferred is fine)**

Spec §7 shortlists `fast_image_resize` (SIMD) because `image`'s resampler is scalar
and slow on large inputs; export uses `resize_exact(..., Lanczos3)`
(`transform.rs:90`) and previews use `resize(..., Triangle)` (`thumbnail.rs:384`).
With 2.1 fixed this is much less pressing — treat as a follow-up if export latency on
40 MP+ images still bothers, and prefer wiring it into the export path first (where
Lanczos3 is mandated by §4.4 and most expensive).

### Priority order

| # | Finding | Severity | Effort |
|---|---|---|---|
| 2.1 | Per-package `opt-level = 3` for codec crates | High | Trivial |
| 2.2 | Cap prewarm decode parallelism (memory, spec §5) | High | Small |
| 2.4 | Atomic temp-file + rename cache writes | Medium | Small |
| 2.5 | Zero-I/O warm cache hits (persist dimensions) | Medium | Small |
| 2.3 | Prewarm cancellation + in-flight dedup | Medium | Medium |
| 2.6–2.12 | Remaining Low items | Low | Small each |
| 2.13 | `fast_image_resize` for export | Low | Medium |

Items 2.1 + 2.4 + 2.5 together are roughly an afternoon and address the most
user-visible costs (decode throughput, cache integrity, warm-folder tile latency).
