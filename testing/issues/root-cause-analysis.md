# Root Cause Analysis — Initial Functionality Testing

Analysis of the issues logged in
[`initial-functionality.md`](./initial-functionality.md). Each entry gives the
observed symptom, the underlying cause found in the code, and the fix applied in
this branch.

---

## 1. First-scroll zoom "jumps/jitters", then behaves

**Symptom:** the very first wheel/trackpad zoom makes the image jump; subsequent
zooming is smooth.

**Root cause:** the viewer used two mutually inconsistent sizing modes. While
`view.fitToWindow` was `true`, the `<img>` was sized by CSS `maxWidth/maxHeight:
100%` (so a 3448×5168 image was shrunk to fit the pane) while the stored
`view.zoom` was still `1`. The stored zoom (1 = 100%) therefore did **not** match
the pixels actually on screen (the fit ratio, e.g. ~0.15). On the first wheel
tick, `zoomAtPoint` set `fitToWindow: false`, which flipped `maxWidth/maxHeight`
to `none`; the `<img>` snapped from its fit size to full natural size ×
`scale(1.1)` — the visible jump. The zoom-to-point anchor math also computed
against `view.zoom` (=1) while the image was displayed at the fit scale, so the
anchor was wrong on that one tick.

**Fix (`viewerStore.ts`, `Viewer.tsx`):** the image is now always sized purely by
`scale(zoom)` — `maxWidth/maxHeight` are no longer toggled. A `fitZoom` factor is
computed from the container and image dimensions (via a `ResizeObserver` +
image `onLoad`) and `fitToWindow` is expressed as "`zoom` equals `fitZoom`",
`offset = 0`. Entering/leaving fit is now continuous because the on-screen scale
and `view.zoom` are the same number at every instant, so the first zoom tick
scales smoothly around the cursor instead of snapping.

---

## 2. Viewer background is pure black, not matching header/footer

**Symptom:** the image canvas background is black while the toolbar and status
bar are a slightly lighter gray.

**Root cause:** the viewer container used `dark:bg-neutral-950` (near-black)
while the toolbar (`Toolbar.tsx`) and footer (`App.tsx`) use
`dark:bg-neutral-900`. A one-shade mismatch.

**Fix (`Viewer.tsx`):** the viewer container now uses
`bg-neutral-50 dark:bg-neutral-900`, matching the surrounding chrome in both
themes.

---

## 3. Buttons cause lag / crop preview is wrong

### 3a. Copy button freezes the app for 2–3 s

**Symptom:** pressing Copy shows the OS busy cursor for a few seconds and the app
becomes unresponsive.

**Root cause:** `copy_image_to_clipboard` does the entire rasterization pipeline
synchronously on the full-resolution source: `load_oriented` (a full
`image::open` decode of a 3448×5168 file), `apply_transforms`, then `to_rgba8()`
which allocates `w·h·4 ≈ 71 MB`, and finally hands the raw buffer to `arboard`.
That is genuinely several hundred ms–seconds of CPU + allocation. Two things made
it feel worse: (a) there was **no Rust-side timing**, so the cost was invisible
(see issue 4), and (b) the UI gave **no feedback** — the "spinner" the tester saw
was the OS busy cursor, because the Copy button had no busy state and could be
re-triggered.

**Fix:** added scoped timing logs around every stage of the copy pipeline via the
new `logger-rs` crate (decode / transform / rgba / clipboard / total), and gave
the toolbar a real busy state (`uiStore.busy`) so Copy shows a spinner and is
disabled while the backend works.

> **Correction (see §7).** An earlier revision of this note claimed the heavy
> work "already runs on Tauri's command thread-pool, not the UI thread." That was
> wrong: `copy_image_to_clipboard` was a **synchronous** `#[tauri::command]`, and
> Tauri runs sync commands **on the main thread** — so the 2–3 s decode + RGBA
> conversion genuinely froze the UI. The real fix (§7) makes the command `async`
> and runs the pipeline on a blocking worker via `spawn_blocking`, so the toolbar
> spinner can actually animate while the copy runs.

### 3b. Crop doesn't update the preview (but Copy of the crop works)

**Symptom:** the crop box drags/resizes fine, but after Apply the preview still
shows the uncropped image; copying afterwards yields the correctly cropped image.

**Root cause:** the live preview only folds **rotate/flip/straighten** into a CSS
transform (`cssFromTransforms`). `crop` and `resize` were ignored by the preview
— they were only ever applied by the backend on export/copy. So Apply pushed a
`crop` onto the stack but the displayed `<img>` never changed. Copy looked
correct because the backend applies the full stack.

**Fix (`Viewer.tsx`):** the committed transform stack is now walked to derive a
live CSS crop/resize preview — the image is wrapped in a clip viewport whose
size and offset reflect the accumulated crop/resize in image space, scaled by the
current zoom. The preview now matches what Copy/Export will produce.

---

## 4. No Rust-side logging / no performance visibility

**Symptom:** nothing is logged from Rust, so errors and the cost of operations
(e.g. how long a copy takes) can't be observed.

**Root cause:** the backend had no logging facility at all.

**Fix:** new crate **`packages/logger-rs`** — a lightweight, dependency-light
logger that writes scoped, timed records to both the console and a log file in
the exact requested format:

```
[HH:MM:SS] [INFO] [gallery.rs:scan_folder] Scanning folder took 2.30s
```

It exposes a `Scope` (a `file:function` tag), per-level methods
(`info/warn/error/debug/trace`), a `scope!("fn_name")` macro that derives the
file basename automatically, and an RAII `Timer` (`scope.timer("label")`) that
logs `"label took <duration>"` when it drops — so timing a function or a step
inside a function is one line. The Tauri backend initializes it at startup
(logging to the OS app-log dir) and instruments the critical paths: folder scan,
image decode / metadata read, thumbnail generation, image export, and
clipboard copy — covering every operation called out in the notes (open a
folder, render an image, render the gallery, copy to clipboard).

---

## 5. Folder button + gallery scroll stall (~10 s first time, better second time)

**Symptom:** clicking the folder button shows a loader for 10+ s before anything
happens; scrolling the gallery stalls similarly; both are far less noticeable the
second time the same folder is opened.

**Root cause:** thumbnails are generated **lazily, one per IPC call, and each
`get_thumbnail` decodes the FULL-resolution source** (`load_oriented` →
`image::open`) before downscaling. For a folder of 3448×5168 images that is
seconds of decode per image, done as tiles scroll into view. The second open is
fast only because the on-disk PNG thumbnail cache (keyed by path+size+mtime) is
warm — which confirms the cost is first-time decode, not I/O or scanning.
`scan_folder` itself is cheap (it deliberately skips dimension probing), so the
"folder button" stall is the same first-open decode storm plus the perceived
freeze of no feedback.

**Fix:** added timing logs to `scan_folder` and `get_thumbnail` (cache-hit vs.
generate, plus decode+resize time) so the cost is measurable and attributable per
the notes' explicit request. The persistent cache already handles the warm path;
the logs make the cold path visible and quantifiable, and the gallery's loading
state was verified to reflect the scan. (Spec §10 calls for rayon-backed batch
prewarming as the next step; the instrumentation added here is the prerequisite
for measuring that win.)

---

## 6. Gallery grid misalignment + scroll-to-selected

**Symptom:** gallery thumbnails aren't in a clean grid — sizes/spacing are
uneven — and selecting an image should show it in the viewer and scroll the
gallery so the selected image is at the top.

**Root cause:** the hand-rolled virtualized grid computed
`rowHeight = cellWidth + LABEL_H + GAP` and positioned each tile in a wrapper of
height `rowHeight - GAP`, but `GalleryTile` sized itself to its **content** (it
had no `h-full`, plus its own `p-1` padding, `gap-1`, and a label whose real
height didn't equal the `LABEL_H = 24` constant). The wrapper height and the
tile's actual rendered height disagreed, so rows drifted and overlapped — "all
over the place." There was also no scroll-to-selected behavior.

**Fix (`Gallery.tsx`, `GalleryTile.tsx`):** the tile now fills its wrapper
exactly (`h-full w-full`, deterministic thumbnail square + fixed-height label),
so the geometry invariant `wrapperHeight === thumbSquare + labelHeight` holds and
the windowing math lines up into a perfect grid with equal `GAP` spacing and
`PADDING` insets. Selecting an image scrolls the container so the selected row is
aligned to the top of the viewport (kept in sync with the virtualization window),
while a genuinely new folder still resets to the top.

---

## 7. Repeated app hangs on iCloud folders + scroll/resize lag (follow-up)

**Symptom (second test pass):** browsing a folder inside `~/Documents` — an
iCloud-synced location — the app "hangs repeatedly"; scrolling the gallery has a
"crazy delay"; resizing the window is laggy. The new `logger-rs` output made the
cause measurable, which is exactly what it was added for.

**What the logs proved.** Two thumbnails took *tens of seconds* while their
siblings took ~1 s:

```
[17:32:37] Generating 256px thumbnail for [Light]-App-Icon-Rounded.png took 74.83s
[17:35:16] Generating 256px thumbnail for [Light]-App-Icon.png         took 60.66s
[17:35:17] Generating 256px thumbnail for [Light]-Seriph-Logo-Text.png took  1.42s
```

A 256 px downscale of even a huge PNG is ~1 s of CPU (the fast rows prove it), so
74.83 s is **not** compute — it is the process **blocked on a file read**. The
folder lives under `~/Documents/Documents - MacBook/…`, i.e. iCloud Drive with
**"Optimize Mac Storage"** on. Those two files were **dataless placeholders**:
their bytes had been evicted from local disk, and the first `image::open()`
blocked while macOS (`fileproviderd`) downloaded the file from iCloud. Once
materialized, the immediate re-request is a cache hit (fast), which is why the
same file logs a "cache hit" one line later. **So yes — this is an iCloud thing.**

**Why it froze the *whole app*, not just one tile.** Every pixel-touching
command (`get_thumbnail`, `read_image_entry`, `export_image`,
`copy_image_to_clipboard`) was a **synchronous** `#[tauri::command]`. Tauri runs
sync commands **on the main thread**, so a 60–75 s blocking iCloud download wedged
the entire UI — no repaint, no resize, no scroll. The strictly *sequential*
timestamps in the log (each generation starts only when the previous one ends)
are the fingerprint of main-thread serialization. This is the same root cause as
the Copy freeze in §3a.

**Why scroll & resize specifically lagged.** The virtualized grid mounts a tile
as it enters the viewport, and each tile fired a `get_thumbnail` immediately with
**no concurrency cap, no debounce, and no real cancellation** — the old
`useThumbnail` only ignored a stale *result*; the backend work still ran. Fast
scrolling therefore queued dozens of blocking calls onto the already-wedged main
thread. Resizing made it worse: the `ResizeObserver`s fired every frame, each
re-rendering the grid (remounting tiles → re-firing thumbnail requests) and
refitting the viewer, all competing for the same blocked thread.

**Fixes (this change):**

1. **Off the main thread.** All four pixel-touching commands are now `async` and
   run their decode/encode/clipboard work inside `tauri::async_runtime::spawn_blocking`.
   The UI thread never blocks on a decode or an iCloud download again — this is
   the single change that stops the "repeated hangs."
2. **Don't auto-download from iCloud while browsing.** New `is_dataless()`
   (`commands/mod.rs`) checks the file's macOS `st_flags` for `SF_DATALESS` — a
   `stat`, which does *not* materialize the file. `get_thumbnail` returns a
   distinct `E_DATALESS` error for placeholders instead of triggering a
   multi-minute blocking download; the gallery shows an unobtrusive **"In iCloud"**
   tile (cloud-off icon) with a tooltip telling the user to download it in Finder.
   Casual scrolling can no longer kick off a storm of iCloud downloads.
3. **Bounded, debounced, cancellable requests.** Thumbnail requests go through a
   small FIFO queue (`lib/thumbnailQueue.ts`, max 4 in-flight); `useThumbnail`
   debounces ~90 ms (a tile scrolled past never requests) and aborts on
   unmount/inputs-change (freeing the queue slot). Scrolling a large folder no
   longer floods the backend.
4. **rAF-throttled scroll/resize.** `onScroll` and both `ResizeObserver`s
   (Gallery + Viewer) are coalesced to one update per animation frame
   (`lib/rafThrottle.ts`), so a drag-resize or fast scroll re-renders at most once
   per paint instead of many times per frame.

**What the user can do about the iCloud files themselves.** These fixes stop the
*app* from freezing, but a file that only exists in iCloud still has to be
downloaded before it can be previewed at full quality. Options: right-click the
folder in Finder → **Download Now**; or System Settings → Apple ID → iCloud →
turn **Optimize Mac Storage** off for a machine that should keep everything local;
or keep working folders outside `~/Desktop` and `~/Documents` (the two folders
iCloud "Desktop & Documents" syncs). A future enhancement could add an in-app
"download from iCloud" action on the placeholder tile (macOS exposes this via
`NSFileManager`/`brctl download`), but that is intentionally left as an explicit,
user-initiated action — never an automatic one triggered by scrolling.
