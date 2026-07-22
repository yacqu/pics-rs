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
  /** Current zoom factor (1 = 100%). Always the TRUE on-screen scale, so the
   * status bar and the zoom-to-point math agree with the rendered pixels even
   * while fit-to-window is active (fixes the first-scroll jump — the image is
   * sized purely by `scale(zoom)`, never by toggling CSS max-width/height). */
  zoom: number;
  /** Pan offset in CSS pixels. */
  offsetX: number;
  offsetY: number;
  /** True = fit-to-window, false = actual-size/manual zoom. */
  fitToWindow: boolean;
  /** The zoom factor that makes the (effective) image exactly fit the viewport.
   * Recomputed from the container + image dimensions; while `fitToWindow` is
   * true, `zoom` tracks this value. */
  fitZoom: number;
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

  /**
   * Last measured size of the viewer container (CSS px). The `Viewer` pushes
   * this on mount / resize so the store can compute the fit-to-window zoom
   * without reaching into the DOM.
   */
  containerSize: { width: number; height: number };
  /** Record the viewer container size and refit if fit-to-window is active. */
  setContainerSize: (width: number, height: number) => void;

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
  fitZoom: 1,
};

function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/**
 * Zoom factor that makes the effective (post-transform) image exactly fit the
 * container. Falls back to the current zoom when dimensions aren't known yet.
 */
function computeFitZoom(
  current: ImageEntry | null,
  transforms: Transform[],
  containerSize: { width: number; height: number },
  fallback: number,
): number {
  const { width, height } = effectiveDimensions(current, transforms);
  const { width: cw, height: ch } = containerSize;
  if (!width || !height || !cw || !ch) return fallback;
  return clampZoom(Math.min(cw / width, ch / height));
}

/**
 * Rebuild the view for a (possibly new) transform stack. When fit-to-window is
 * active the zoom is re-derived so it keeps tracking the fit factor and the
 * image stays centred; otherwise the manual zoom/offset are left untouched.
 */
function refitView(
  view: ViewState,
  current: ImageEntry | null,
  transforms: Transform[],
  containerSize: { width: number; height: number },
): ViewState {
  const fitZoom = computeFitZoom(current, transforms, containerSize, view.zoom);
  if (!view.fitToWindow) return { ...view, fitZoom };
  return { ...view, fitZoom, zoom: fitZoom, offsetX: 0, offsetY: 0 };
}

export const useViewerStore = create<ViewerState>((set, getState) => ({
  current: null,
  transforms: [],
  redoStack: [],
  view: INITIAL_VIEW,
  activeTool: "none",
  straightenPreview: null,
  containerSize: { width: 0, height: 0 },

  openImage: (entry) =>
    set((state) => ({
      current: entry,
      transforms: [],
      redoStack: [],
      // Seed the fit zoom immediately (the container size persists across
      // images) so the first paint is already fitted — no scale(1) flash.
      view: refitView(INITIAL_VIEW, entry, [], state.containerSize),
      activeTool: "none",
      straightenPreview: null,
    })),

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
    set((state) => {
      const transforms = [...state.transforms, transform];
      return {
        transforms,
        redoStack: [], // a new edit clears the redo history
        // A crop/resize/rotate changes the effective size, so refit.
        view: refitView(state.view, state.current, transforms, state.containerSize),
      };
    }),

  undo: () => {
    const { transforms } = getState();
    if (transforms.length === 0) return;
    const next = transforms.slice(0, -1);
    const undone = transforms[transforms.length - 1]!;
    set((state) => ({
      transforms: next,
      redoStack: [...state.redoStack, undone],
      view: refitView(state.view, state.current, next, state.containerSize),
    }));
  },

  redo: () => {
    const { redoStack } = getState();
    if (redoStack.length === 0) return;
    const restored = redoStack[redoStack.length - 1]!;
    set((state) => {
      const transforms = [...state.transforms, restored];
      return {
        transforms,
        redoStack: state.redoStack.slice(0, -1),
        view: refitView(state.view, state.current, transforms, state.containerSize),
      };
    });
  },

  resetEdits: () =>
    set((state) => ({
      transforms: [],
      redoStack: [],
      view: refitView(state.view, state.current, [], state.containerSize),
    })),

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

  setContainerSize: (width, height) =>
    set((state) => {
      const containerSize = { width, height };
      return {
        containerSize,
        view: refitView(state.view, state.current, state.transforms, containerSize),
      };
    }),

  setFitToWindow: (fit) =>
    set((state) => {
      if (!fit) return { view: { ...state.view, fitToWindow: false } };
      // Refit against the current container + effective image size.
      return {
        view: refitView(
          { ...state.view, fitToWindow: true },
          state.current,
          state.transforms,
          state.containerSize,
        ),
      };
    }),

  setActiveTool: (tool) => set({ activeTool: tool }),

  flip: (axis) =>
    set((state) => {
      const transforms: Transform[] = [
        ...state.transforms,
        { kind: "flip", axis },
      ];
      return {
        transforms,
        redoStack: [],
        view: refitView(state.view, state.current, transforms, state.containerSize),
      };
    }),

  setStraightenPreview: (angle) => set({ straightenPreview: angle }),
}));
