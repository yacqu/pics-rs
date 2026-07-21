import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { Check, X } from "lucide-react";
import {
  useViewerStore,
  effectiveDimensions,
} from "@/stores/viewerStore";
import type { AspectPreset } from "@/types/image";

/**
 * Crop tool overlay (spec §4.3). Renders a draggable crop rectangle with eight
 * resize handles, aspect-ratio presets, numeric x/y/width/height inputs and a
 * dimmed live preview, on top of the image inside the viewer.
 *
 * COORDINATE MODEL: the crop rect state (x/y/width/height) is kept in pixels of
 * the image *as it currently appears* — i.e. after the existing transform stack
 * (see `effectiveDimensions`). On Apply we push `{ kind: "crop", ... }` in that
 * same post-transform pixel space, which is exactly what the backend, applying
 * transforms in order, will crop. To keep the screen↔image mapping simple we
 * reset the view to fit-to-window when the tool opens (spec §4.3 note).
 */

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
type Handle = (typeof HANDLES)[number];

const MIN_SIZE = 8; // minimum crop extent, image px

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

/** Resolve a preset to an aspect ratio (w/h), or null for "free". */
function ratioOf(preset: AspectPreset, natW: number, natH: number): number | null {
  switch (preset) {
    case "1:1":
      return 1;
    case "4:3":
      return 4 / 3;
    case "16:9":
      return 16 / 9;
    case "original":
      return natH > 0 ? natW / natH : null;
    default:
      return null;
  }
}

/** Fit a rect to `ratio` anchored at its top-left, clamped to the bounds. */
function fitRatio(rect: Rect, ratio: number, W: number, H: number): Rect {
  let width = rect.width;
  let height = width / ratio;
  if (rect.y + height > H) {
    height = H - rect.y;
    width = height * ratio;
  }
  if (rect.x + width > W) {
    width = W - rect.x;
    height = width / ratio;
  }
  return { x: rect.x, y: rect.y, width, height };
}

/** Enforce `ratio` on a rect being resized by `handle`, keeping its anchor. */
function enforceRatio(
  rect: Rect,
  ratio: number,
  handle: Handle,
  W: number,
  H: number,
): Rect {
  const movesX = handle.includes("e") || handle.includes("w");
  const movesY = handle.includes("n") || handle.includes("s");
  const anchorLeft = !handle.includes("w"); // left edge fixed unless "w" moves it
  const anchorTop = !handle.includes("n");

  let width = rect.width;
  let height = rect.height;

  if (movesX && movesY) {
    // Corner: width drives, height follows.
    height = width / ratio;
  } else if (movesX) {
    // Vertical edge: width drives, grow height about the current centre.
    height = width / ratio;
  } else {
    // Horizontal edge: height drives, grow width about the current centre.
    width = height * ratio;
  }

  // Clamp to bounds respecting the anchor direction.
  const maxW = anchorLeft ? W - rect.x : rect.x + rect.width;
  if (width > maxW) {
    width = maxW;
    height = width / ratio;
  }
  const centreY = rect.y + rect.height / 2;
  const maxH =
    movesX && !movesY
      ? Math.min(centreY, H - centreY) * 2
      : anchorTop
        ? H - rect.y
        : rect.y + rect.height;
  if (height > maxH) {
    height = maxH;
    width = height * ratio;
  }

  const x = anchorLeft
    ? rect.x
    : rect.x + rect.width - width;
  let y: number;
  if (movesX && !movesY) {
    // edge drag: centre vertically
    y = centreY - height / 2;
  } else {
    y = anchorTop ? rect.y : rect.y + rect.height - height;
  }
  // Centre horizontally for a horizontal-edge drag.
  const finalX =
    !movesX && movesY ? rect.x + rect.width / 2 - width / 2 : x;

  return {
    x: clamp(finalX, 0, W - width),
    y: clamp(y, 0, H - height),
    width,
    height,
  };
}

interface DragState {
  mode: "move" | Handle;
  startRect: Rect;
  startClientX: number;
  startClientY: number;
}

export default function CropOverlay({
  containerRef,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
}) {
  const activeTool = useViewerStore((s) => s.activeTool);
  const current = useViewerStore((s) => s.current);
  const transforms = useViewerStore((s) => s.transforms);
  const pushTransform = useViewerStore((s) => s.pushTransform);
  const setActiveTool = useViewerStore((s) => s.setActiveTool);
  const setFitToWindow = useViewerStore((s) => s.setFitToWindow);

  const active = activeTool === "crop";

  const { width: natW, height: natH } = effectiveDimensions(
    current,
    transforms,
  );

  const [preset, setPreset] = useState<AspectPreset>("free");
  const [rect, setRect] = useState<Rect>({ x: 0, y: 0, width: 0, height: 0 });
  const [box, setBox] = useState<Box | null>(null);
  const drag = useRef<DragState | null>(null);

  const ratio = ratioOf(preset, natW, natH);

  // On open: reset the view so the image is fit-to-window and centred, which
  // makes the screen↔image mapping a plain uniform scale.
  useEffect(() => {
    if (!active) return;
    setFitToWindow(true);
    // Start with the full image selected.
    setRect({ x: 0, y: 0, width: natW, height: natH });
    setPreset("free");
    // natW/natH are stable for a given image+stack; only re-init on (re)open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Measure the rendered image box (in container-local px) so we can map the
  // crop rect between image pixels and the screen.
  const measure = useCallback(() => {
    if (!active) return;
    const container = containerRef.current;
    const img = container?.querySelector("img");
    if (!container || !img) return;
    const c = container.getBoundingClientRect();
    const r = img.getBoundingClientRect();
    setBox({
      left: r.left - c.left,
      top: r.top - c.top,
      width: r.width,
      height: r.height,
    });
  }, [active, containerRef]);

  useLayoutEffect(() => {
    measure();
  }, [measure, transforms, natW, natH]);

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(container);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [active, containerRef, measure]);

  // Global drag tracking (continues outside the overlay bounds).
  useEffect(() => {
    if (!drag.current && !active) return;
    function onMove(e: MouseEvent) {
      const d = drag.current;
      const b = box;
      if (!d || !b) return;
      const sx = b.width / natW || 1;
      const sy = b.height / natH || 1;
      const dxImg = (e.clientX - d.startClientX) / sx;
      const dyImg = (e.clientY - d.startClientY) / sy;

      if (d.mode === "move") {
        const nx = clamp(d.startRect.x + dxImg, 0, natW - d.startRect.width);
        const ny = clamp(d.startRect.y + dyImg, 0, natH - d.startRect.height);
        setRect({ ...d.startRect, x: nx, y: ny });
        return;
      }

      const h = d.mode;
      let left = d.startRect.x;
      let top = d.startRect.y;
      let right = d.startRect.x + d.startRect.width;
      let bottom = d.startRect.y + d.startRect.height;
      if (h.includes("w")) left = d.startRect.x + dxImg;
      if (h.includes("e")) right = d.startRect.x + d.startRect.width + dxImg;
      if (h.includes("n")) top = d.startRect.y + dyImg;
      if (h.includes("s")) bottom = d.startRect.y + d.startRect.height + dyImg;

      left = clamp(left, 0, right - MIN_SIZE);
      right = clamp(right, left + MIN_SIZE, natW);
      top = clamp(top, 0, bottom - MIN_SIZE);
      bottom = clamp(bottom, top + MIN_SIZE, natH);

      let next: Rect = {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
      };
      if (ratio) next = enforceRatio(next, ratio, h, natW, natH);
      setRect(next);
    }
    function onUp() {
      drag.current = null;
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [active, box, natW, natH, ratio]);

  if (!active || !current || natW <= 0 || natH <= 0 || !box) return null;

  const sx = box.width / natW;
  const sy = box.height / natH;

  const screen = {
    left: box.left + rect.x * sx,
    top: box.top + rect.y * sy,
    width: rect.width * sx,
    height: rect.height * sy,
  };

  function startDrag(mode: "move" | Handle, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    drag.current = {
      mode,
      startRect: rect,
      startClientX: e.clientX,
      startClientY: e.clientY,
    };
  }

  function choosePreset(p: AspectPreset) {
    setPreset(p);
    const r = ratioOf(p, natW, natH);
    if (r) setRect((cur) => fitRatio(cur, r, natW, natH));
  }

  function updateField(field: keyof Rect, value: number) {
    setRect((cur) => {
      const next = { ...cur, [field]: value };
      // Basic clamping to keep the rect inside the image.
      next.width = clamp(next.width, MIN_SIZE, natW);
      next.height = clamp(next.height, MIN_SIZE, natH);
      if (ratio) {
        if (field === "height") next.width = next.height * ratio;
        else next.height = next.width / ratio;
        next.width = clamp(next.width, MIN_SIZE, natW);
        next.height = clamp(next.height, MIN_SIZE, natH);
      }
      next.x = clamp(next.x, 0, natW - next.width);
      next.y = clamp(next.y, 0, natH - next.height);
      return next;
    });
  }

  function apply() {
    pushTransform({
      kind: "crop",
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
    setActiveTool("none");
  }

  const handleCursor: Record<Handle, string> = {
    nw: "nwse-resize",
    n: "ns-resize",
    ne: "nesw-resize",
    e: "ew-resize",
    se: "nwse-resize",
    s: "ns-resize",
    sw: "nesw-resize",
    w: "ew-resize",
  };

  function handleStyle(h: Handle): React.CSSProperties {
    const half = { x: 0.5, y: 0.5 };
    const fx = h.includes("w") ? 0 : h.includes("e") ? 1 : half.x;
    const fy = h.includes("n") ? 0 : h.includes("s") ? 1 : half.y;
    return {
      left: `${fx * 100}%`,
      top: `${fy * 100}%`,
      cursor: handleCursor[h],
    };
  }

  return (
    <div className="absolute inset-0 z-10 select-none">
      {/* Crop rectangle with a dimmed surround via a huge box-shadow. */}
      <div
        onMouseDown={(e) => startDrag("move", e)}
        style={{
          position: "absolute",
          left: screen.left,
          top: screen.top,
          width: screen.width,
          height: screen.height,
          cursor: "move",
          boxShadow: "0 0 0 9999px rgba(0,0,0,0.5)",
        }}
        className="border border-white/90 outline outline-1 outline-black/40"
      >
        {/* Rule-of-thirds guides. */}
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute left-1/3 top-0 h-full w-px bg-white/40" />
          <div className="absolute left-2/3 top-0 h-full w-px bg-white/40" />
          <div className="absolute left-0 top-1/3 h-px w-full bg-white/40" />
          <div className="absolute left-0 top-2/3 h-px w-full bg-white/40" />
        </div>
        {HANDLES.map((h) => (
          <div
            key={h}
            onMouseDown={(e) => startDrag(h, e)}
            style={handleStyle(h)}
            className="absolute -ml-1.5 -mt-1.5 h-3 w-3 rounded-sm border border-neutral-700 bg-white shadow"
          />
        ))}
      </div>

      {/* Controls: presets + numeric inputs + apply/cancel. */}
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="absolute left-1/2 top-3 z-20 flex -translate-x-1/2 flex-col gap-2 rounded-lg border border-neutral-200 bg-white/95 p-2 text-xs text-neutral-800 shadow-lg backdrop-blur dark:border-neutral-700 dark:bg-neutral-800/95 dark:text-neutral-100"
      >
        <div className="flex items-center gap-1">
          {(["free", "1:1", "4:3", "16:9", "original"] as AspectPreset[]).map(
            (p) => (
              <button
                key={p}
                type="button"
                onClick={() => choosePreset(p)}
                className={`rounded px-2 py-1 transition-colors ${
                  preset === p
                    ? "bg-blue-600 text-white"
                    : "hover:bg-neutral-200 dark:hover:bg-neutral-700"
                }`}
              >
                {p}
              </button>
            ),
          )}
        </div>
        <div className="flex items-center gap-2">
          {(
            [
              ["X", "x"],
              ["Y", "y"],
              ["W", "width"],
              ["H", "height"],
            ] as [string, keyof Rect][]
          ).map(([label, field]) => (
            <label key={field} className="flex items-center gap-1">
              <span className="text-neutral-500 dark:text-neutral-400">
                {label}
              </span>
              <input
                type="number"
                value={Math.round(rect[field])}
                onChange={(e) =>
                  updateField(field, Number(e.target.value) || 0)
                }
                className="w-16 rounded border border-neutral-300 bg-white px-1 py-0.5 tabular-nums dark:border-neutral-600 dark:bg-neutral-900"
              />
            </label>
          ))}
          <div className="ml-1 flex items-center gap-1">
            <button
              type="button"
              onClick={apply}
              title="Apply crop"
              className="inline-flex items-center gap-1 rounded bg-blue-600 px-2 py-1 text-white hover:bg-blue-500"
            >
              <Check className="h-3.5 w-3.5" /> Apply
            </button>
            <button
              type="button"
              onClick={() => setActiveTool("none")}
              title="Cancel"
              className="inline-flex items-center gap-1 rounded px-2 py-1 hover:bg-neutral-200 dark:hover:bg-neutral-700"
            >
              <X className="h-3.5 w-3.5" /> Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
