import { open } from "@tauri-apps/plugin-dialog";
import { MVP_EXTENSIONS } from "@/types/image";
import { readImageEntry } from "@/lib/tauri";
import { useViewerStore } from "@/stores/viewerStore";
import { useGalleryStore } from "@/stores/galleryStore";
import { usePreferencesStore } from "@/stores/preferencesStore";

/** Split an absolute path into its parent directory. */
function parentDir(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx > 0 ? path.slice(0, idx) : path;
}

/**
 * Open a single image via the native file dialog, load it into the viewer, and
 * scan its folder so prev/next navigation and the gallery are populated
 * (spec §4.1). This is the primary "File > Open" entry point.
 */
export async function openImageDialog(): Promise<void> {
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Images", extensions: [...MVP_EXTENSIONS] }],
  });
  if (typeof selected !== "string") return;
  await openImagePath(selected);
}

/** Open a specific image path (shared by dialog, CLI arg, and drag-drop). */
export async function openImagePath(path: string): Promise<void> {
  const entry = await readImageEntry(path);
  useViewerStore.getState().openImage(entry);
  useGalleryStore.getState().select(path);

  // Populate siblings for navigation and remember the folder.
  const folder = parentDir(path);
  const { sortOrder } = usePreferencesStore.getState();
  usePreferencesStore.getState().setLastFolder(folder);
  await useGalleryStore.getState().loadFolder(folder, sortOrder);
}

/** Open a folder in gallery mode via the native directory picker. */
export async function openFolderDialog(): Promise<void> {
  const selected = await open({ multiple: false, directory: true });
  if (typeof selected !== "string") return;
  const { sortOrder } = usePreferencesStore.getState();
  usePreferencesStore.getState().setLastFolder(selected);
  await useGalleryStore.getState().loadFolder(selected, sortOrder);
}
