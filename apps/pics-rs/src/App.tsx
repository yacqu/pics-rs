import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import Toolbar from "@/components/Toolbar";
import Viewer from "@/components/Viewer";
import Gallery from "@/components/Gallery";
import ExportDialog from "@/components/ExportDialog";
import DownloadProgress from "@/components/DownloadProgress";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { openImagePath } from "@/lib/actions";
import { takePendingOpen } from "@/lib/tauri";
import { MVP_EXTENSIONS } from "@/types/image";
import { useViewerStore } from "@/stores/viewerStore";
import { useGalleryStore } from "@/stores/galleryStore";
import { useUiStore } from "@/stores/uiStore";

/** Lowercase extension (no dot) of a path, for drag-drop filtering. */
function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
}

/**
 * Root layout: toolbar + main pane (viewer or gallery) + status bar. Listens
 * for `open-image` events emitted by the Rust backend — this is how a file
 * opened via CLI arg / OS "Open with" or forwarded by the single-instance
 * plugin reaches the UI (spec §4.1, §4.10) — and for native drag-and-drop.
 */
export default function App() {
  useKeyboardShortcuts();

  const current = useViewerStore((s) => s.current);
  const zoom = useViewerStore((s) => s.view.zoom);

  const viewMode = useUiStore((s) => s.viewMode);
  const exportOpen = useUiStore((s) => s.exportOpen);
  const setExportOpen = useUiStore((s) => s.setExportOpen);

  const folder = useGalleryStore((s) => s.folder);
  const entryCount = useGalleryStore((s) => s.entries.length);
  const selectedPath = useGalleryStore((s) => s.selectedPath);

  // Gallery mode shows a live preview alongside the grid once something is
  // selected — like a slideshow you can scroll through — rather than closing
  // the gallery to show the image full-screen (testing notes #1). Before any
  // selection is made there's nothing to preview, so the grid takes the whole
  // pane.
  const showGalleryPreview = viewMode === "gallery" && current !== null && selectedPath !== null;

  const [dragOver, setDragOver] = useState(false);

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

  useEffect(() => {
    // Progress for an in-flight iCloud download of a dataless placeholder
    // (see `ensure_downloaded` in the backend), so opening a not-yet-
    // downloaded file shows feedback instead of appearing to silently stall
    // (testing notes: single click should download with visible progress).
    const unlisten = listen<{ path: string; percent: number; complete: boolean }>(
      "icloud-download-progress",
      (event) => {
        const { path, percent, complete } = event.payload;
        useUiStore.getState().setDownloadProgress(path, complete ? null : percent);
      },
    );
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    // Native drag-and-drop of an image file onto the window (spec §4.1). Tauri
    // delivers OS file paths (not browser File objects), so we open the first
    // supported one directly via the asset protocol.
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "over" || event.payload.type === "enter") {
        setDragOver(true);
      } else if (event.payload.type === "drop") {
        setDragOver(false);
        const first = event.payload.paths.find((p) =>
          (MVP_EXTENSIONS as readonly string[]).includes(extensionOf(p)),
        );
        if (first) void openImagePath(first);
      } else {
        setDragOver(false);
      }
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  return (
    <div className="relative flex h-full flex-col bg-white text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
      <Toolbar />
      <main className="flex flex-1 overflow-hidden">
        {viewMode === "gallery" ? (
          <>
            {/* Gallery's wrapper stays the same element across the preview
                toggle below (only its width class changes) so React patches
                it in place instead of unmounting/remounting Gallery — a
                remount here reset its scroll position and virtualization
                state and forced every visible tile to re-fetch its
                thumbnail, producing a visible jump on the first click. */}
            <div
              className={
                showGalleryPreview
                  ? "w-96 min-w-[280px] shrink-0 overflow-hidden border-r border-neutral-200 dark:border-neutral-800"
                  : "flex-1 overflow-hidden"
              }
            >
              <Gallery />
            </div>
            {showGalleryPreview && (
              <div className="min-w-0 flex-1 overflow-hidden">
                <Viewer />
              </div>
            )}
          </>
        ) : (
          <Viewer />
        )}
      </main>
      <footer className="flex items-center gap-3 border-t border-neutral-200 bg-neutral-50 px-3 py-1 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
        {viewMode === "gallery" ? (
          <>
            <span className="truncate" title={folder ?? undefined}>
              {folder ?? "No folder open"}
            </span>
            <span className="ml-auto tabular-nums">
              {entryCount} {entryCount === 1 ? "image" : "images"}
            </span>
          </>
        ) : current ? (
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

      {dragOver ? (
        <div className="pointer-events-none absolute inset-0 z-40 m-2 flex items-center justify-center rounded-xl border-2 border-dashed border-blue-400 bg-blue-500/10 text-sm font-medium text-blue-600 dark:text-blue-300">
          Drop an image to open
        </div>
      ) : null}

      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} />
      <DownloadProgress />
    </div>
  );
}
