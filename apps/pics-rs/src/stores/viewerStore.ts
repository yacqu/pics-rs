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

/** Which in-viewer editing tool is currently active (spec §4.3-4.5). */
export type ActiveTool = "none" | "crop" | "resize" | "straighten";

/**
 * Effective (post-transform) natural dimensions of the image after the given
 * transform stack is applied, in image pixels. CropOverlay/ResizePanel need
 * this to map their pixel-space inputs onto the image as it currently appears
 * (spec §4.3, §4.4). Pure helper — no store access.
 *
 * The backend applies transforms in order, so we walk the stack in order:
 * 90°/270° rotations swap width/height, crop/resize set new dimensions, and
 * flip/straighten leave the pixel extent unchanged (straighten is crop-to-fit).
 */
export function effectiveDimensions(
  current: Pick<ImageEntry, "width" | "height"> | null,
  transforms: Transform[],
): { width: number; height: number } {
  let width = current?.width ?? 0;
  let height = current?.height ?? 0;
  for (const t of transforms) {
    if (t.kind === "rotate") {
      const normalized = ((t.degrees % 360) + 360) % 360;
      if (normalized === 90 || normalized === 270) {
        [width, height] = [height, width];
      }
    } else if (t.kind === "crop") {
      width = t.width;
      height = t.height;
    } else if (t.kind === "resize") {
      width = t.width;
      height = t.height;
    }
    // flip and straighten do not change the pixel extent.
  }
  return { width, height };
}

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
  /** Active in-viewer editing tool (spec §4.3-4.5). */
  activeTool: ActiveTool;
  /**
   * Ephemeral straighten-angle preview (degrees) while the straighten slider is
   * being dragged, or null when not previewing (spec §4.5). Purely visual — it
   * is folded into the live CSS transform but never into the committed stack.
   */
  straightenPreview: number | null;

  openImage: (entry: ImageEntry) => void;
  closeImage: () => void;

  pushTransform: (transform: Transform) => void;
  undo: () => void;
  redo: () => void;
  resetEdits: () => void;

  setZoom: (zoom: number) => void;
  zoomBy: (factor: number) => void;
  /**
   * Zoom by `factor` toward a pointer position so the point under the cursor
   * stays fixed (spec §4.2 zoom-to-point). `pointerX/Y` are client coords and
   * `rect` is the container's bounding rect.
   */
  zoomAtPoint: (
    factor: number,
    pointerX: number,
    pointerY: number,
    rect: DOMRect,
  ) => void;
  setOffset: (offsetX: number, offsetY: number) => void;
  setFitToWindow: (fit: boolean) => void;

  setActiveTool: (tool: ActiveTool) => void;
  /** Convenience: push a horizontal/vertical flip transform (spec §4.5). */
  flip: (axis: "horizontal" | "vertical") => void;
  /** Set/clear the live straighten preview angle (spec §4.5). */
  setStraightenPreview: (angle: number | null) => void;
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
  activeTool: "none",
  straightenPreview: null,

  openImage: (entry) =>
    set({
      current: entry,
      transforms: [],
      redoStack: [],
      view: INITIAL_VIEW,
      activeTool: "none",
      straightenPreview: null,
    }),

  closeImage: () =>
    set({
      current: null,
      transforms: [],
      redoStack: [],
      view: INITIAL_VIEW,
      activeTool: "none",
      straightenPreview: null,
    }),

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

  zoomAtPoint: (factor, pointerX, pointerY, rect) =>
    set((state) => {
      const { zoom, offsetX, offsetY } = state.view;
      const newZoom = clampZoom(zoom * factor);
      // Effective factor after clamping keeps the anchor exact at the bounds.
      const effFactor = newZoom / zoom;
      // Pointer position relative to the container centre (the transform origin).
      const px = pointerX - rect.left - rect.width / 2;
      const py = pointerY - rect.top - rect.height / 2;
      // Keep the point under the cursor fixed: offset' = p - factor*(p - offset).
      return {
        view: {
          ...state.view,
          zoom: newZoom,
          offsetX: px - effFactor * (px - offsetX),
          offsetY: py - effFactor * (py - offsetY),
          fitToWindow: false,
        },
      };
    }),

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

  setActiveTool: (tool) => set({ activeTool: tool }),

  flip: (axis) =>
    set((state) => ({
      transforms: [...state.transforms, { kind: "flip", axis }],
      redoStack: [],
    })),

  setStraightenPreview: (angle) => set({ straightenPreview: angle }),
}));
