import { create } from "zustand";
import type { ImageEntry, SortOrder } from "@/types/image";
import { scanFolder } from "@/lib/tauri";

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

  loadFolder: (path: string, sort: SortOrder) => Promise<void>;
  setEntries: (entries: ImageEntry[]) => void;
  select: (path: string | null) => void;
  sortEntries: (sort: SortOrder) => void;
  /** Path of the sibling relative to the current selection (prev/next nav). */
  siblingPath: (delta: number) => string | null;
  clear: () => void;
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

  loadFolder: async (path, sort) => {
    set({ loading: true, error: null, folder: path });
    try {
      const entries = await scanFolder(path);
      set({ entries: sortEntriesBy(entries, sort), loading: false });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  setEntries: (entries) => set({ entries }),

  select: (path) => set({ selectedPath: path }),

  sortEntries: (sort) =>
    set((state) => ({ entries: sortEntriesBy(state.entries, sort) })),

  siblingPath: (delta) => {
    const { entries, selectedPath } = getState();
    if (entries.length === 0) return null;
    const index = entries.findIndex((e) => e.path === selectedPath);
    if (index === -1) return entries[0]?.path ?? null;
    // Cycle through siblings (spec §4.1).
    const nextIndex = (index + delta + entries.length) % entries.length;
    return entries[nextIndex]?.path ?? null;
  },

  clear: () =>
    set({ folder: null, entries: [], selectedPath: null, error: null }),
}));
