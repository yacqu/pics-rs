import { useEffect, useState } from "react";
import { Check, X, Link, Unlink } from "lucide-react";
import { useViewerStore, effectiveDimensions } from "@/stores/viewerStore";

/**
 * Resize tool panel (spec §4.4). A small floating panel to set a target
 * width/height in pixels or by percentage, with an aspect-ratio lock. The
 * resize is non-destructive: Apply pushes `{ kind: "resize", width, height }`
 * onto the transform stack and the backend rasterises it at export time.
 */
export default function ResizePanel() {
  const activeTool = useViewerStore((s) => s.activeTool);
  const current = useViewerStore((s) => s.current);
  const transforms = useViewerStore((s) => s.transforms);
  const pushTransform = useViewerStore((s) => s.pushTransform);
  const setActiveTool = useViewerStore((s) => s.setActiveTool);

  const active = activeTool === "resize";
  const { width: srcW, height: srcH } = effectiveDimensions(
    current,
    transforms,
  );

  const [width, setWidth] = useState(srcW);
  const [height, setHeight] = useState(srcH);
  const [locked, setLocked] = useState(true);

  // Prefill from the current effective dimensions whenever the tool opens.
  useEffect(() => {
    if (active) {
      setWidth(srcW);
      setHeight(srcH);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  if (!active || !current || srcW <= 0 || srcH <= 0) return null;

  const aspect = srcW / srcH;
  const percent = srcW > 0 ? Math.round((width / srcW) * 100) : 100;

  function changeWidth(value: number) {
    const w = Math.max(1, Math.round(value));
    setWidth(w);
    if (locked) setHeight(Math.max(1, Math.round(w / aspect)));
  }

  function changeHeight(value: number) {
    const h = Math.max(1, Math.round(value));
    setHeight(h);
    if (locked) setWidth(Math.max(1, Math.round(h * aspect)));
  }

  function changePercent(value: number) {
    const p = Math.max(1, value) / 100;
    setWidth(Math.max(1, Math.round(srcW * p)));
    setHeight(Math.max(1, Math.round(srcH * p)));
  }

  function apply() {
    pushTransform({ kind: "resize", width, height });
    setActiveTool("none");
  }

  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      className="absolute right-3 top-3 z-20 flex w-56 flex-col gap-3 rounded-lg border border-neutral-200 bg-white/95 p-3 text-xs text-neutral-800 shadow-lg backdrop-blur dark:border-neutral-700 dark:bg-neutral-800/95 dark:text-neutral-100"
    >
      <div className="flex items-center justify-between">
        <span className="font-medium">Resize</span>
        <span className="text-neutral-500 dark:text-neutral-400">
          {srcW} × {srcH}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-neutral-500 dark:text-neutral-400">Width</span>
          <input
            type="number"
            value={width}
            min={1}
            onChange={(e) => changeWidth(Number(e.target.value) || 0)}
            className="w-full rounded border border-neutral-300 bg-white px-1.5 py-1 tabular-nums dark:border-neutral-600 dark:bg-neutral-900"
          />
        </label>
        <button
          type="button"
          title={locked ? "Aspect ratio locked" : "Aspect ratio unlocked"}
          onClick={() => setLocked((v) => !v)}
          className="mt-4 inline-flex h-7 w-7 items-center justify-center rounded text-neutral-500 hover:bg-neutral-200 dark:hover:bg-neutral-700"
        >
          {locked ? (
            <Link className="h-4 w-4" />
          ) : (
            <Unlink className="h-4 w-4" />
          )}
        </button>
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-neutral-500 dark:text-neutral-400">Height</span>
          <input
            type="number"
            value={height}
            min={1}
            onChange={(e) => changeHeight(Number(e.target.value) || 0)}
            className="w-full rounded border border-neutral-300 bg-white px-1.5 py-1 tabular-nums dark:border-neutral-600 dark:bg-neutral-900"
          />
        </label>
      </div>

      <label className="flex items-center gap-2">
        <span className="text-neutral-500 dark:text-neutral-400">Scale</span>
        <input
          type="number"
          value={percent}
          min={1}
          onChange={(e) => changePercent(Number(e.target.value) || 0)}
          className="w-16 rounded border border-neutral-300 bg-white px-1.5 py-1 tabular-nums dark:border-neutral-600 dark:bg-neutral-900"
        />
        <span className="text-neutral-500 dark:text-neutral-400">%</span>
      </label>

      <div className="flex items-center justify-end gap-1">
        <button
          type="button"
          onClick={apply}
          className="inline-flex items-center gap-1 rounded bg-blue-600 px-2 py-1 text-white hover:bg-blue-500"
        >
          <Check className="h-3.5 w-3.5" /> Apply
        </button>
        <button
          type="button"
          onClick={() => setActiveTool("none")}
          className="inline-flex items-center gap-1 rounded px-2 py-1 hover:bg-neutral-200 dark:hover:bg-neutral-700"
        >
          <X className="h-3.5 w-3.5" /> Cancel
        </button>
      </div>
    </div>
  );
}
