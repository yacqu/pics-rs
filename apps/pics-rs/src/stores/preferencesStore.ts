import { create } from "zustand";
import { loadState, saveState } from "@/lib/persistence";
import type { ExportOptions, SortOrder } from "@/types/image";

/**
 * Preferences store (spec §4.11, §6). Holds persistent, low-stakes user
 * settings backed by IndexedDB. Kept separate from viewer/gallery state because
 * preferences outlive any single image or folder session.
 */

export type ThemeChoice = "light" | "dark" | "system";

interface PersistedPreferences {
  theme: ThemeChoice;
  sortOrder: SortOrder;
  lastFolder: string | null;
  exportDefaults: ExportOptions;
}

interface PreferencesState extends PersistedPreferences {
  hydrated: boolean;
  setTheme: (theme: ThemeChoice) => void;
  setSortOrder: (sortOrder: SortOrder) => void;
  setLastFolder: (path: string | null) => void;
  setExportDefaults: (options: Partial<ExportOptions>) => void;
  /** Load persisted values from IndexedDB and apply the theme. */
  hydrate: () => Promise<void>;
}

const STORAGE_KEY = "preferences";

const DEFAULTS: PersistedPreferences = {
  theme: "system",
  sortOrder: { key: "name", direction: "asc" },
  lastFolder: null,
  exportDefaults: {
    format: "jpeg",
    quality: 90,
    // Default to stripping metadata is a stronger privacy stance, but the spec
    // wants this to be an explicit user choice; preserve by default and expose
    // the toggle in the export UI (spec §4.9).
    preserveMetadata: true,
  },
};

/** Resolve a theme choice to a concrete light/dark value. */
function resolveTheme(theme: ThemeChoice): "light" | "dark" {
  if (theme === "system") {
    const prefersDark =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;
    return prefersDark ? "dark" : "light";
  }
  return theme;
}

/** Toggle the root `.dark` class that Tailwind's dark variant keys off. */
function applyTheme(theme: ThemeChoice): void {
  if (typeof document === "undefined") return;
  const resolved = resolveTheme(theme);
  document.documentElement.classList.toggle("dark", resolved === "dark");
}

export const usePreferencesStore = create<PreferencesState>((set, getState) => {
  // Keep `system` theme in sync with OS changes for the lifetime of the app.
  if (typeof window !== "undefined") {
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", () => {
        if (getState().theme === "system") applyTheme("system");
      });
  }

  function persist(patch: Partial<PersistedPreferences>): void {
    const { theme, sortOrder, lastFolder, exportDefaults } = getState();
    void saveState<PersistedPreferences>(STORAGE_KEY, {
      theme,
      sortOrder,
      lastFolder,
      exportDefaults,
      ...patch,
    });
  }

  return {
    ...DEFAULTS,
    hydrated: false,

    setTheme: (theme) => {
      applyTheme(theme);
      set({ theme });
      persist({ theme });
    },

    setSortOrder: (sortOrder) => {
      set({ sortOrder });
      persist({ sortOrder });
    },

    setLastFolder: (lastFolder) => {
      set({ lastFolder });
      persist({ lastFolder });
    },

    setExportDefaults: (options) => {
      const exportDefaults = { ...getState().exportDefaults, ...options };
      set({ exportDefaults });
      persist({ exportDefaults });
    },

    hydrate: async () => {
      const stored = await loadState<PersistedPreferences>(
        STORAGE_KEY,
        DEFAULTS,
      );
      applyTheme(stored.theme);
      set({ ...stored, hydrated: true });
    },
  };
});
