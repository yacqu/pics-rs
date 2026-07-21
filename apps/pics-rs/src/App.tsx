import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import Toolbar from "@/components/Toolbar";
import Viewer from "@/components/Viewer";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { openImagePath } from "@/lib/actions";
import { takePendingOpen } from "@/lib/tauri";
import { useViewerStore } from "@/stores/viewerStore";

/**
 * Root layout: toolbar + viewer + status bar. Listens for `open-image` events
 * emitted by the Rust backend — this is how a file opened via CLI arg / OS
 * "Open with" or forwarded by the single-instance plugin reaches the UI
 * (spec §4.1, §4.10).
 */
export default function App() {
  useKeyboardShortcuts();

  const current = useViewerStore((s) => s.current);
  const zoom = useViewerStore((s) => s.view.zoom);

  useEffect(() => {
    // A running instance receives forwarded paths via the "open-image" event
    // (single-instance / second launch)...
    const unlisten = listen<string>("open-image", (event) => {
      void openImagePath(event.payload);
    });
    // ...while a cold start drains the path stashed by the backend at launch.
    void takePendingOpen().then((path) => {
      if (path) void openImagePath(path);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  return (
    <div className="flex h-full flex-col bg-white text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
      <Toolbar />
      <main className="flex flex-1 overflow-hidden">
        <Viewer />
      </main>
      <footer className="flex items-center gap-3 border-t border-neutral-200 bg-neutral-50 px-3 py-1 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
        {current ? (
          <>
            <span className="truncate" title={current.path}>
              {current.name}
            </span>
            {current.width && current.height ? (
              <span className="tabular-nums">
                {current.width}×{current.height}
              </span>
            ) : null}
            <span className="ml-auto tabular-nums">{Math.round(zoom * 100)}%</span>
          </>
        ) : (
          <span>No image open</span>
        )}
      </footer>
    </div>
  );
}
