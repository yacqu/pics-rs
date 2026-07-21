import { useMemo, useRef, type WheelEvent } from "react";
import { useViewerStore } from "@/stores/viewerStore";
import { assetUrl } from "@/lib/tauri";
import type { Transform } from "@/types/image";

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
  const zoomBy = useViewerStore((s) => s.zoomBy);

  const containerRef = useRef<HTMLDivElement>(null);

  const editTransform = useMemo(
    () => cssFromTransforms(transforms),
    [transforms],
  );

  function onWheel(event: WheelEvent<HTMLDivElement>) {
    if (!current) return;
    // Wheel/trackpad zoom (spec §4.2). Zoom-to-point refinement is a follow-up.
    event.preventDefault();
    zoomBy(event.deltaY < 0 ? 1.1 : 1 / 1.1);
  }

  if (!current) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-neutral-400 dark:text-neutral-500">
        Open an image to get started.
      </div>
    );
  }

  const src = assetUrl(current.path);

  return (
    <div
      ref={containerRef}
      onWheel={onWheel}
      className="relative flex flex-1 items-center justify-center overflow-hidden bg-neutral-100 dark:bg-neutral-950"
    >
      <img
        src={src}
        alt={current.name}
        draggable={false}
        style={{
          transform: `translate(${view.offsetX}px, ${view.offsetY}px) scale(${view.zoom}) ${editTransform}`,
          transformOrigin: "center",
          maxWidth: view.fitToWindow ? "100%" : "none",
          maxHeight: view.fitToWindow ? "100%" : "none",
        }}
        className="select-none will-change-transform"
      />
    </div>
  );
}
