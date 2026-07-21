import { useEffect, useState } from "react";
import { Check, X } from "lucide-react";
import { useViewerStore } from "@/stores/viewerStore";

/**
 * Straighten tool panel (spec §4.5). A -45°..45° slider for horizon correction
 * with a numeric readout. The angle live-previews via `straightenPreview` in
 * the viewer store (folded into the CSS transform by Viewer); Apply commits it
 * as a `{ kind: "straighten", angle }` transform.
 */
export default function StraightenControl() {
  const activeTool = useViewerStore((s) => s.activeTool);
  const current = useViewerStore((s) => s.current);
  const pushTransform = useViewerStore((s) => s.pushTransform);
  const setActiveTool = useViewerStore((s) => s.setActiveTool);
  const setStraightenPreview = useViewerStore((s) => s.setStraightenPreview);

  const active = activeTool === "straighten";
  const [angle, setAngle] = useState(0);

  // Reset and start previewing when the tool opens; clear preview on close.
  useEffect(() => {
    if (active) {
      setAngle(0);
      setStraightenPreview(0);
    } else {
      setStraightenPreview(null);
    }
    return () => setStraightenPreview(null);
  }, [active, setStraightenPreview]);

  if (!active || !current) return null;

  function change(value: number) {
    setAngle(value);
    setStraightenPreview(value);
  }

  function apply() {
    if (angle !== 0) pushTransform({ kind: "straighten", angle });
    setStraightenPreview(null);
    setActiveTool("none");
  }

  function cancel() {
    setStraightenPreview(null);
    setActiveTool("none");
  }

  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      className="absolute bottom-4 left-1/2 z-20 flex w-72 -translate-x-1/2 flex-col gap-2 rounded-lg border border-neutral-200 bg-white/95 p-3 text-xs text-neutral-800 shadow-lg backdrop-blur dark:border-neutral-700 dark:bg-neutral-800/95 dark:text-neutral-100"
    >
      <div className="flex items-center justify-between">
        <span className="font-medium">Straighten</span>
        <span className="tabular-nums text-neutral-500 dark:text-neutral-400">
          {angle.toFixed(1)}°
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-neutral-400">-45</span>
        <input
          type="range"
          min={-45}
          max={45}
          step={0.5}
          value={angle}
          onChange={(e) => change(Number(e.target.value))}
          className="flex-1 accent-blue-600"
        />
        <span className="text-neutral-400">45</span>
      </div>
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => change(0)}
          className="rounded px-2 py-1 text-neutral-500 hover:bg-neutral-200 dark:hover:bg-neutral-700"
        >
          Reset
        </button>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={apply}
            className="inline-flex items-center gap-1 rounded bg-blue-600 px-2 py-1 text-white hover:bg-blue-500"
          >
            <Check className="h-3.5 w-3.5" /> Apply
          </button>
          <button
            type="button"
            onClick={cancel}
            className="inline-flex items-center gap-1 rounded px-2 py-1 hover:bg-neutral-200 dark:hover:bg-neutral-700"
          >
            <X className="h-3.5 w-3.5" /> Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
