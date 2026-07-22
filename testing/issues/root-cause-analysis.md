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
disabled while the backend works. The heavy work already runs on Tauri's command
thread-pool, not the UI thread; the freeze perception was the missing feedback +
invisible cost, both now addressed. Timing data will pinpoint any remaining
platform-specific `arboard` cost.

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
