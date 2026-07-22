import { create } from "zustand";
import type { ImageEntry, SortOrder } from "@/types/image";
import { GALLERY_THUMB_SIZE } from "@/types/image";
import { scanFolder, prewarmFolder } from "@/lib/tauri";

/**
 * Gallery store (spec §4.7). Owns the current folder, its image entries, the
 * selection, and load state. Sorting is derived here so the grid and prev/next
 * navigation share one ordered list. Thumbnail bytes live on disk (backend
 * cache), not in this store, to respect the memory constraints in spec §5/§8.3.
 */

interface GalleryState {
  folder: string | null;
  entries: ImageEntry[];
  selectedPath: string | null;
  loading: boolean;
  error: string | null;
  /**
   * Active extension filter (spec §4.7 "basic filter by extension"). `null`
   * means show every entry; otherwise only entries whose lowercase extension is
   * in this set are visible. Stored as an array so it round-trips cleanly.
   */
  filterExtensions: string[] | null;

  loadFolder: (path: string, sort: SortOrder) => Promise<void>;
  setEntries: (entries: ImageEntry[]) => void;
  /**
   * Fold in pixel dimensions the backend already computed while generating a
   * tile's thumbnail (spec §10 perf item "fold dimension-probing into
   * thumbnail generation"), so opening that image later can skip a redundant
   * `read_image_entry` round-trip. No-op if the entry isn't in the current
   * list or already has these dimensions.
   */
  setEntryDimensions: (path: string, width: number, height: number) => void;
  select: (path: string | null) => void;
  sortEntries: (sort: SortOrder) => void;
  /** Set (or clear, with `null`) the extension filter. */
  setFilter: (exts: string[] | null) => void;
  /**
   * Entries after applying `filterExtensions`, in sorted order. The grid and
   * sibling navigation both read this so a filtered gallery stays consistent.
   */
  visibleEntries: () => ImageEntry[];
  /** Path of the sibling relative to the current selection (prev/next nav). */
  siblingPath: (delta: number) => string | null;
  clear: () => void;
}

/** Apply the extension filter to a list of entries (null = pass-through). */
function applyFilter(
  entries: ImageEntry[],
  filter: string[] | null,
): ImageEntry[] {
  if (filter === null || filter.length === 0) return entries;
  const allowed = new Set(filter.map((e) => e.toLowerCase()));
  return entries.filter((entry) => allowed.has(entry.extension.toLowerCase()));
}

function sortEntriesBy(entries: ImageEntry[], sort: SortOrder): ImageEntry[] {
  const dir = sort.direction === "asc" ? 1 : -1;
  const sorted = [...entries].sort((a, b) => {
    switch (sort.key) {
      case "modified":
      case "dateTaken":
        // dateTaken falls back to mtime until EXIF wiring lands (spec §4.7).
        return (a.modifiedMs - b.modifiedMs) * dir;
      case "size":
        return (a.sizeBytes - b.sizeBytes) * dir;
      case "name":
      default:
        return a.name.localeCompare(b.name, undefined, { numeric: true }) * dir;
    }
  });
  return sorted;
}

export const useGalleryStore = create<GalleryState>((set, getState) => ({
  folder: null,
  entries: [],
  selectedPath: null,
  loading: false,
  error: null,
  filterExtensions: null,

  loadFolder: async (path, sort) => {
    set({ loading: true, error: null, folder: path });
    try {
      const entries = await scanFolder(path);
      set({ entries: sortEntriesBy(entries, sort), loading: false });
      // Fire-and-forget: rayon-parallelized cold thumbnail decodes across all
      // cores so the grid fills in without a per-tile IPC trickle (spec §10
      // "batch thumbnail prewarm"). Errors here don't affect the UI —
      // `get_thumbnail` remains the source of truth for each tile.
      if (entries.length > 0) {
        void prewarmFolder(
          entries.map((e) => e.path),
          GALLERY_THUMB_SIZE,
        );
      }
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  setEntries: (entries) => set({ entries }),

  setEntryDimensions: (path, width, height) =>
    set((state) => {
      const index = state.entries.findIndex((e) => e.path === path);
      if (index === -1) return state;
      const entry = state.entries[index]!;
      if (entry.width === width && entry.height === height) return state;
      const entries = state.entries.slice();
      entries[index] = { ...entry, width, height };
      return { entries };
    }),

  select: (path) => set({ selectedPath: path }),

  sortEntries: (sort) =>
    set((state) => ({ entries: sortEntriesBy(state.entries, sort) })),

  setFilter: (exts) => set({ filterExtensions: exts }),

  visibleEntries: () => {
    const { entries, filterExtensions } = getState();
    return applyFilter(entries, filterExtensions);
  },

  siblingPath: (delta) => {
    const { entries, selectedPath, filterExtensions } = getState();
    // Navigate within the currently visible (filtered) set so prev/next in the
    // gallery matches what the user actually sees.
    const visible = applyFilter(entries, filterExtensions);
    if (visible.length === 0) return null;
    const index = visible.findIndex((e) => e.path === selectedPath);
    if (index === -1) return visible[0]?.path ?? null;
    // Cycle through siblings (spec §4.1).
    const nextIndex = (index + delta + visible.length) % visible.length;
    return visible[nextIndex]?.path ?? null;
  },

  clear: () =>
    set({
      folder: null,
      entries: [],
      selectedPath: null,
      error: null,
      filterExtensions: null,
    }),
}));
