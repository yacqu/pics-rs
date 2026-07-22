import { create } from "zustand";

/**
 * UI shell store. Holds transient, view-level UI state that isn't image data,
 * gallery data, or persisted preferences — kept separate so those stores stay
 * focused (spec §6). Currently: which pane fills the main content area
 * (viewer vs. gallery grid) and whether the export modal is open.
 */

export type ViewMode = "viewer" | "gallery";

interface UiState {
  /** Which pane fills the main content area. */
  viewMode: ViewMode;
  /** Whether the export modal is open. */
  exportOpen: boolean;
  /**
   * A short label for a backend operation in flight (e.g. "Copying…"), or null
   * when idle. Lets the toolbar show a spinner and disable re-entry while a
   * potentially slow rasterization runs in Rust (spec §4.6 copy/clipboard).
   */
  busy: string | null;
  /**
   * In-flight iCloud downloads: path -> percent complete (0-100). Populated by
   * the backend's `icloud-download-progress` events, so opening a
   * not-yet-downloaded file shows visible progress instead of appearing to
   * silently stall (testing notes: single click should download with
   * feedback, then auto-open once complete).
   */
  downloads: Record<string, number>;

  setViewMode: (mode: ViewMode) => void;
  setExportOpen: (open: boolean) => void;
  setBusy: (busy: string | null) => void;
  /** Set a path's download percent, or clear it entirely with `null` (done). */
  setDownloadProgress: (path: string, percent: number | null) => void;
}

export const useUiStore = create<UiState>((set) => ({
  viewMode: "viewer",
  exportOpen: false,
  busy: null,
  downloads: {},

  setViewMode: (viewMode) => set({ viewMode }),
  setExportOpen: (exportOpen) => set({ exportOpen }),
  setBusy: (busy) => set({ busy }),

  setDownloadProgress: (path, percent) =>
    set((state) => {
      if (percent === null) {
        if (!(path in state.downloads)) return state;
        const downloads = { ...state.downloads };
        delete downloads[path];
        return { downloads };
      }
      return { downloads: { ...state.downloads, [path]: percent } };
    }),
}));
