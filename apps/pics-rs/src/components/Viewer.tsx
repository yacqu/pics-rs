import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type WheelEvent,
} from "react";
import { useViewerStore } from "@/stores/viewerStore";
import { assetUrl } from "@/lib/tauri";
import type { Transform } from "@/types/image";
import CropOverlay from "./CropOverlay";
import ResizePanel from "./ResizePanel";
import StraightenControl from "./StraightenControl";

/**
 * Live image preview. Per spec §6/§8.4, on-disk images are loaded directly by
 * the WebView via the asset protocol (never through IPC), and cheap live
 * transforms (rotate/flip/zoom/pan) are done with CSS transforms rather than
 * round-tripping pixels to Rust on every interaction. Crop/resize/straighten
 * still rasterize in the backend on export.
 */

/** Fold the rotate/flip parts of the transform stack into a CSS transform. */
function cssFromTransforms(transforms: Transform[]): string {
  let rotation = 0;
  let scaleX = 1;
  let scaleY = 1;
  for (const t of transforms) {
    if (t.kind === "rotate") rotation += t.degrees;
    else if (t.kind === "straighten") rotation += t.angle;
    else if (t.kind === "flip") {
      if (t.axis === "horizontal") scaleX *= -1;
      else scaleY *= -1;
    }
  }
  return `rotate(${rotation}deg) scale(${scaleX}, ${scaleY})`;
}

export default function Viewer() {
  const current = useViewerStore((s) => s.current);
  const transforms = useViewerStore((s) => s.transforms);
  const view = useViewerStore((s) => s.view);
  const zoomAtPoint = useViewerStore((s) => s.zoomAtPoint);
  const setOffset = useViewerStore((s) => s.setOffset);
  const activeTool = useViewerStore((s) => s.activeTool);
  const straightenPreview = useViewerStore((s) => s.straightenPreview);

  const containerRef = useRef<HTMLDivElement>(null);

  const editTransform = useMemo(
    () => cssFromTransforms(transforms),
    [transforms],
  );

  // A live straighten preview (spec §4.5) is folded in as an extra rotation on
  // top of the committed stack; it never enters the transform history.
  const previewTransform =
    straightenPreview != null ? ` rotate(${straightenPreview}deg)` : "";

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
      <div className="flex flex-1 items-center justify-center text-sm text-neutral-400 dark:text-neutral-500">
        Open an image to get started.
      </div>
    );
  }

  const src = assetUrl(current.path);
  const cursor = !canPan ? "default" : dragging ? "grabbing" : "grab";

  return (
    <div
      ref={containerRef}
      onWheel={onWheel}
      onMouseDown={onMouseDown}
      style={{ cursor }}
      className="relative flex flex-1 items-center justify-center overflow-hidden bg-neutral-100 dark:bg-neutral-950"
    >
      <img
        src={src}
        alt={current.name}
        draggable={false}
        style={{
          transform: `translate(${view.offsetX}px, ${view.offsetY}px) scale(${view.zoom}) ${editTransform}${previewTransform}`,
          transformOrigin: "center",
          maxWidth: view.fitToWindow ? "100%" : "none",
          maxHeight: view.fitToWindow ? "100%" : "none",
        }}
        className="select-none will-change-transform"
      />

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
