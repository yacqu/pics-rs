import { Loader2 } from "lucide-react";
import { useUiStore } from "@/stores/uiStore";

/**
 * Toast stack for in-flight iCloud downloads (testing notes: opening a
 * not-yet-downloaded file must show visible progress rather than the app
 * silently stalling for a minute). Backed by `uiStore.downloads`, populated
 * from the backend's `icloud-download-progress` events (see App.tsx).
 */
export default function DownloadProgress() {
  const downloads = useUiStore((s) => s.downloads);
  const entries = Object.entries(downloads);
  if (entries.length === 0) return null;

  return (
    <div className="pointer-events-none absolute bottom-3 right-3 z-40 flex flex-col items-end gap-1.5">
      {entries.map(([path, percent]) => (
        <div
          key={path}
          className="flex items-center gap-2 rounded-md bg-black/75 px-3 py-1.5 text-xs text-white shadow-lg"
        >
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
          <span className="max-w-[220px] truncate">
            Downloading {path.split("/").pop()}…
          </span>
          <span className="tabular-nums text-white/70">{Math.round(percent)}%</span>
        </div>
      ))}
    </div>
  );
}
