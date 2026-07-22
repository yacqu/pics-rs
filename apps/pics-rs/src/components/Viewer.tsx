import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type WheelEvent,
} from "react";
import { useViewerStore } from "@/stores/viewerStore";
import { assetUrl, getPreview } from "@/lib/tauri";
import { rafThrottle } from "@/lib/rafThrottle";
import { VIEWER_PREVIEW_MAX_DIM, type ImageEntry, type Transform } from "@/types/image";
import CropOverlay from "./CropOverlay";
import ResizePanel from "./ResizePanel";
import StraightenControl from "./StraightenControl";

/**
 * Live image preview. Per spec §6/§8.4, on-disk images are loaded directly by
 * the WebView via the asset protocol (never through IPC), and cheap live
 * transforms are done with CSS rather than round-tripping pixels to Rust on
 * every interaction. Straighten still rasterizes in the backend on export.
 *
 * SIZING (fixes the first-scroll zoom jump): the image is sized purely by
 * `scale(view.zoom)`. `view.zoom` is always the true on-screen scale — while
 * fit-to-window is active it equals the computed fit factor — so entering and
 * leaving fit is continuous and the first wheel tick scales smoothly around the
 * cursor instead of snapping from "fit" to "actual size".
 *
 * CROP/RESIZE PREVIEW (fixes "crop doesn't change the preview"): the committed
 * transform stack is walked into a clip-viewport layout so crop and resize are
 * reflected live, matching what Copy/Export will produce.
 */

interface PreviewLayout {
  /** CSS transform applied to the <img> (rotate + flip + straighten). */
  imgTransform: string;
  /** Full *oriented* image size (px): the box the <img>'s paint fills. */
  contentW: number;
  contentH: number;
  /** Visible crop window within the oriented content, in content px. */
  viewport: { x: number; y: number; width: number; height: number };
  /** Final displayed size (px) after crop + resize (== effectiveDimensions). */
  displayW: number;
  displayH: number;
}

/**
 * Flatten the transform stack into a clip-viewport layout for the live preview.
 *
 * The common pipeline is orientation ops (rotate/flip/straighten) first, then
 * crop/resize. That is expressible as: paint the oriented full image, then clip
 * a window and scale it. If an orientation op appears AFTER a crop/resize the
 * single-viewport model can't represent it faithfully, so we fall back to an
 * un-cropped oriented preview (old behavior) rather than render something wrong.
 */
function previewLayout(
  current: ImageEntry | null,
  transforms: Transform[],
): PreviewLayout {
  const nw = current?.width ?? 0;
  const nh = current?.height ?? 0;

  // Orientation (rotate/flip/straighten) folded into one CSS transform.
  let rotation = 0;
  let scaleX = 1;
  let scaleY = 1;
  let sawClip = false; // a crop/resize has been seen
  let complex = false; // orientation change after a crop → not modelable here
  for (const t of transforms) {
    if (t.kind === "rotate") {
      rotation += t.degrees;
      if (sawClip) complex = true;
    } else if (t.kind === "straighten") {
      rotation += t.angle;
      if (sawClip) complex = true;
    } else if (t.kind === "flip") {
      if (t.axis === "horizontal") scaleX *= -1;
      else scaleY *= -1;
      if (sawClip) complex = true;
    } else if (t.kind === "crop" || t.kind === "resize") {
      sawClip = true;
    }
  }

  const normRot = (((Math.round(rotation) % 360) + 360) % 360) as number;
  const swap = normRot === 90 || normRot === 270;
  const orientedW = swap ? nh : nw;
  const orientedH = swap ? nw : nh;
  const imgTransform = `rotate(${rotation}deg) scale(${scaleX}, ${scaleY})`;

  // Degenerate or non-canonical stacks: show the whole oriented image.
  if (complex || orientedW <= 0 || orientedH <= 0) {
    const w = Math.max(1, orientedW);
    const h = Math.max(1, orientedH);
    return {
      imgTransform,
      contentW: w,
      contentH: h,
      viewport: { x: 0, y: 0, width: w, height: h },
      displayW: w,
      displayH: h,
    };
  }

  // Walk crop/resize in order, tracking the window in oriented-content px (ox,
  // oy, cw, ch) and the running displayed size (dispW, dispH). A crop's coords
  // are in the *current display* space, so convert through the running scale.
  let ox = 0;
  let oy = 0;
  let cw = orientedW;
  let ch = orientedH;
  let dispW = orientedW;
  let dispH = orientedH;
  for (const t of transforms) {
    if (t.kind === "crop") {
      const kx = cw / dispW;
      const ky = ch / dispH;
      const cropX = Math.max(0, Math.min(t.x, dispW));
      const cropY = Math.max(0, Math.min(t.y, dispH));
      const cropW = Math.max(1, Math.min(t.width, dispW - cropX));
      const cropH = Math.max(1, Math.min(t.height, dispH - cropY));
      ox += cropX * kx;
      oy += cropY * ky;
      cw = cropW * kx;
      ch = cropH * ky;
      dispW = cropW;
      dispH = cropH;
    } else if (t.kind === "resize") {
      dispW = Math.max(1, t.width);
      dispH = Math.max(1, t.height);
    }
  }

  return {
    imgTransform,
    contentW: orientedW,
    contentH: orientedH,
    viewport: { x: ox, y: oy, width: cw, height: ch },
    displayW: dispW,
    displayH: dispH,
  };
}

export default function Viewer() {
  const current = useViewerStore((s) => s.current);
  const transforms = useViewerStore((s) => s.transforms);
  const view = useViewerStore((s) => s.view);
  const zoomAtPoint = useViewerStore((s) => s.zoomAtPoint);
  const setOffset = useViewerStore((s) => s.setOffset);
  const setContainerSize = useViewerStore((s) => s.setContainerSize);
  const activeTool = useViewerStore((s) => s.activeTool);
  const straightenPreview = useViewerStore((s) => s.straightenPreview);

  const containerRef = useRef<HTMLDivElement>(null);

  // Two-tier image (spec §10 perf item): loading the full-resolution original
  // straight into the WebView forces a heavy decode just to show it at
  // fit-to-window scale. Fetch a capped-dimension preview instead and use it
  // by default; only swap to the true original once the user zooms in past
  // 100%, where the preview's resolution would actually show.
  const [preview, setPreview] = useState<{ path: string; src: string } | null>(null);
  useEffect(() => {
    const path = current?.path ?? null;
    if (!path) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    void getPreview(path, VIEWER_PREVIEW_MAX_DIM)
      .then((result) => {
        if (cancelled) return;
        setPreview({ path, src: assetUrl(result.previewPath) });
      })
      .catch(() => {
        // Fall back to the full-res asset (below) — most commonly a dataless
        // placeholder, which shouldn't happen here since opening an image
        // already downloads it first, but fail open rather than blocking.
      });
    return () => {
      cancelled = true;
    };
  }, [current?.path]);

  const layout = useMemo(
    () => previewLayout(current, transforms),
    [current, transforms],
  );

  // A live straighten preview (spec §4.5) is folded in as an extra rotation on
  // top of the committed stack; it never enters the transform history.
  const imgTransform =
    layout.imgTransform +
    (straightenPreview != null ? ` rotate(${straightenPreview}deg)` : "");

  // crop → resize scale for the content-scaler box.
  const scaleCX = layout.viewport.width > 0 ? layout.displayW / layout.viewport.width : 1;
  const scaleCY = layout.viewport.height > 0 ? layout.displayH / layout.viewport.height : 1;

  // Keep the store's container size in sync so it can compute fit-to-window.
  // Coalesced to one update per frame — a window drag-resize fires the observer
  // continuously, and each `setContainerSize` refits + re-renders the viewer.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = rafThrottle(() =>
      setContainerSize(el.clientWidth, el.clientHeight),
    );
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
      measure.cancel();
    };
  }, [setContainerSize]);

  // --- Pan (spec §4.2): click-drag and space+drag. Disabled while cropping. ---
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [dragging, setDragging] = useState(false);
  // Drag anchor: pointer + offset at mousedown.
  const dragStart = useRef<{
    pointerX: number;
    pointerY: number;
    offsetX: number;
    offsetY: number;
  } | null>(null);

  // Space toggles a pan-cursor affordance and enables panning without a button.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.code === "Space") {
        const target = e.target as HTMLElement | null;
        if (
          target &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.isContentEditable)
        ) {
          return;
        }
        setSpaceHeld(true);
      }
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.code === "Space") setSpaceHeld(false);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  const canPan = activeTool !== "crop";

  const onMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!canPan || e.button !== 0) return;
      dragStart.current = {
        pointerX: e.clientX,
        pointerY: e.clientY,
        offsetX: view.offsetX,
        offsetY: view.offsetY,
      };
      setDragging(true);
    },
    [canPan, view.offsetX, view.offsetY],
  );

  // Track the drag on the window so it continues outside the container bounds.
  useEffect(() => {
    if (!dragging) return;
    function onMove(e: MouseEvent) {
      const start = dragStart.current;
      if (!start) return;
      setOffset(
        start.offsetX + (e.clientX - start.pointerX),
        start.offsetY + (e.clientY - start.pointerY),
      );
    }
    function onUp() {
      dragStart.current = null;
      setDragging(false);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging, setOffset]);

  function onWheel(event: WheelEvent<HTMLDivElement>) {
    if (!current) return;
    // Wheel/trackpad zoom-to-point (spec §4.2): the point under the cursor
    // stays fixed while the image scales around it.
    event.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
    zoomAtPoint(factor, event.clientX, event.clientY, rect);
  }

  if (!current) {
    return (
      <div className="flex flex-1 items-center justify-center bg-neutral-50 text-sm text-neutral-400 dark:bg-neutral-900 dark:text-neutral-500">
        Open an image to get started.
      </div>
    );
  }

  // Actual-pixel viewing (zoom > 100%) needs the true original; otherwise
  // prefer the lighter preview tier once it's loaded for this exact image.
  const usePreview = view.zoom <= 1 && preview?.path === current.path;
  const src = usePreview ? preview.src : assetUrl(current.path);
  const cursor = !canPan ? "default" : dragging ? "grabbing" : "grab";

  return (
    <div
      ref={containerRef}
      onWheel={onWheel}
      onMouseDown={onMouseDown}
      style={{ cursor }}
      className="relative flex flex-1 items-center justify-center overflow-hidden bg-neutral-50 dark:bg-neutral-900"
    >
      {/* Assembly: sized to the displayed (post-crop/resize) image and scaled by
          zoom. Fit-to-window keeps zoom == fitZoom, so this is continuous. */}
      <div
        className="relative will-change-transform"
        style={{
          width: layout.displayW,
          height: layout.displayH,
          transform: `translate(${view.offsetX}px, ${view.offsetY}px) scale(${view.zoom})`,
          transformOrigin: "center",
        }}
      >
        {/* Clip viewport — the box CropOverlay measures. Axis-aligned in
            effective image space, so screen↔image mapping stays a plain scale. */}
        <div
          data-viewer-image
          style={{
            position: "relative",
            width: layout.displayW,
            height: layout.displayH,
            overflow: "hidden",
          }}
        >
          {/* Content scaler folds the crop→resize scale (top-left origin). */}
          <div
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              transform: `scale(${scaleCX}, ${scaleCY})`,
              transformOrigin: "top left",
            }}
          >
            {/* Oriented full image, shifted so the crop origin sits at (0,0). */}
            <div
              style={{
                position: "absolute",
                left: -layout.viewport.x,
                top: -layout.viewport.y,
                width: layout.contentW,
                height: layout.contentH,
              }}
            >
              <img
                src={src}
                alt={current.name}
                draggable={false}
                style={{
                  position: "absolute",
                  left: "50%",
                  top: "50%",
                  width: current.width ?? undefined,
                  height: current.height ?? undefined,
                  transform: `translate(-50%, -50%) ${imgTransform}`,
                  transformOrigin: "center",
                  maxWidth: "none",
                  maxHeight: "none",
                }}
                className="select-none"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Tool overlays / panels — each renders null unless its tool is active. */}
      <CropOverlay containerRef={containerRef} />
      <ResizePanel />
      <StraightenControl />

      {spaceHeld && canPan && (
        <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-md bg-black/60 px-2 py-1 text-xs text-white">
          Space held — drag to pan
        </div>
      )}
    </div>
  );
}
