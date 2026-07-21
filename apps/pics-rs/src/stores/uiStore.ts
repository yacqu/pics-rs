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

  setViewMode: (mode: ViewMode) => void;
  setExportOpen: (open: boolean) => void;
}

export const useUiStore = create<UiState>((set) => ({
  viewMode: "viewer",
  exportOpen: false,

  setViewMode: (viewMode) => set({ viewMode }),
  setExportOpen: (exportOpen) => set({ exportOpen }),
}));
