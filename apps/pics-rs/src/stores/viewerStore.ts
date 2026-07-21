import { create } from "zustand";
import type { ImageEntry, Transform } from "@/types/image";

/**
 * Viewer store (spec §4.1-4.5, §6). Owns the currently displayed image, the
 * live zoom/pan view state, and the non-destructive transform stack with
 * undo/redo. Transforms are applied to a working preview via CSS/Canvas in the
 * UI and only rasterized by the backend on export (spec §6 "Edit model").
 *
 * Undo/redo is session-only for now (kept in memory, not IndexedDB). See spec
 * §10 open decision on whether to persist edit history across restarts.
 */

export const MIN_ZOOM = 0.1; // 10%  (spec §4.2)
export const MAX_ZOOM = 16; // 1600%

interface ViewState {
  /** Current zoom factor (1 = 100%). */
  zoom: number;
  /** Pan offset in CSS pixels. */
  offsetX: number;
  offsetY: number;
  /** True = fit-to-window, false = actual-size/manual zoom. */
  fitToWindow: boolean;
}

interface ViewerState {
  current: ImageEntry | null;
  /** Applied transforms, oldest first. */
  transforms: Transform[];
  /** Transforms popped by undo, newest-undone last. */
  redoStack: Transform[];
  view: ViewState;

  openImage: (entry: ImageEntry) => void;
  closeImage: () => void;

  pushTransform: (transform: Transform) => void;
  undo: () => void;
  redo: () => void;
  resetEdits: () => void;

  setZoom: (zoom: number) => void;
  zoomBy: (factor: number) => void;
  setOffset: (offsetX: number, offsetY: number) => void;
  setFitToWindow: (fit: boolean) => void;
}

const INITIAL_VIEW: ViewState = {
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
  fitToWindow: true,
};

function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export const useViewerStore = create<ViewerState>((set, getState) => ({
  current: null,
  transforms: [],
  redoStack: [],
  view: INITIAL_VIEW,

  openImage: (entry) =>
    set({
      current: entry,
      transforms: [],
      redoStack: [],
      view: INITIAL_VIEW,
    }),

  closeImage: () =>
    set({ current: null, transforms: [], redoStack: [], view: INITIAL_VIEW }),

  pushTransform: (transform) =>
    set((state) => ({
      transforms: [...state.transforms, transform],
      redoStack: [], // a new edit clears the redo history
    })),

  undo: () => {
    const { transforms } = getState();
    if (transforms.length === 0) return;
    const next = transforms.slice(0, -1);
    const undone = transforms[transforms.length - 1]!;
    set((state) => ({
      transforms: next,
      redoStack: [...state.redoStack, undone],
    }));
  },

  redo: () => {
    const { redoStack } = getState();
    if (redoStack.length === 0) return;
    const restored = redoStack[redoStack.length - 1]!;
    set((state) => ({
      transforms: [...state.transforms, restored],
      redoStack: state.redoStack.slice(0, -1),
    }));
  },

  resetEdits: () => set({ transforms: [], redoStack: [] }),

  setZoom: (zoom) =>
    set((state) => ({
      view: { ...state.view, zoom: clampZoom(zoom), fitToWindow: false },
    })),

  zoomBy: (factor) =>
    set((state) => ({
      view: {
        ...state.view,
        zoom: clampZoom(state.view.zoom * factor),
        fitToWindow: false,
      },
    })),

  setOffset: (offsetX, offsetY) =>
    set((state) => ({ view: { ...state.view, offsetX, offsetY } })),

  setFitToWindow: (fit) =>
    set((state) => ({
      view: {
        ...state.view,
        fitToWindow: fit,
        ...(fit ? { zoom: 1, offsetX: 0, offsetY: 0 } : {}),
      },
    })),
}));
