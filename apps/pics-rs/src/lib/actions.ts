import { open, save } from "@tauri-apps/plugin-dialog";
import { MVP_EXTENSIONS } from "@/types/image";
import type { ExportOptions, ImageEntry } from "@/types/image";
import {
  assetUrl,
  readImageEntry,
  exportImage,
  copyImageToClipboard,
} from "@/lib/tauri";
import { useViewerStore } from "@/stores/viewerStore";
import { useGalleryStore } from "@/stores/galleryStore";
import { usePreferencesStore } from "@/stores/preferencesStore";
import { useUiStore } from "@/stores/uiStore";

/** File extension the backend writes for each export format. */
const FORMAT_EXTENSION: Record<ExportOptions["format"], string> = {
  jpeg: "jpg",
  png: "png",
  webp: "webp",
};

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
  // Opening an image brings the viewer pane to the front (spec §4.1).
  useUiStore.getState().setViewMode("viewer");

  // Populate siblings for navigation and remember the folder.
  const folder = parentDir(path);
  const { sortOrder } = usePreferencesStore.getState();
  usePreferencesStore.getState().setLastFolder(folder);
  await useGalleryStore.getState().loadFolder(folder, sortOrder);
  prefetchSiblings();
}

/** Warm the WebView's HTTP cache for a sibling's full-res asset so stepping to
 * it paints instantly instead of decoding cold (spec §10 perf item "prefetch
 * next/prev entry"). Fire-and-forget; a failed/irrelevant prefetch is harmless. */
function prefetchAsset(path: string | null): void {
  if (!path) return;
  const img = new Image();
  img.src = assetUrl(path);
}

/** Prefetch both neighbors of the current gallery selection. */
function prefetchSiblings(): void {
  const { siblingPath } = useGalleryStore.getState();
  prefetchAsset(siblingPath(1));
  prefetchAsset(siblingPath(-1));
}

/**
 * Load `path` into the viewer's preview state and select it in the gallery,
 * WITHOUT touching `viewMode`. Used by the gallery grid (spec §4.7 testing
 * notes): clicking a tile must not close gallery mode — it just fills the
 * preview area and the grid stays open so the user can keep browsing.
 *
 * Skips the `read_image_entry` round-trip when the gallery already has full
 * dimensions for this path — folded in by `get_thumbnail`/`prewarm_folder`
 * once its thumbnail has loaded (spec §10 perf item "fold dimension-probing
 * into thumbnail generation") — since at that point every other `ImageEntry`
 * field is already known from the folder scan too.
 */
export async function previewImage(path: string): Promise<void> {
  const cached = useGalleryStore.getState().entries.find((e) => e.path === path);
  const entry: ImageEntry =
    cached && cached.width != null && cached.height != null
      ? cached
      : await readImageEntry(path);
  useViewerStore.getState().openImage(entry);
  useGalleryStore.getState().select(path);
  prefetchSiblings();
}

/**
 * Open the sibling image (prev/next) relative to the current selection,
 * cycling within the loaded folder (spec §4.1). Unlike `openImagePath` this
 * does NOT re-scan the folder — the sibling list is already loaded — so
 * arrow-key navigation stays snappy. No-op when there is no sibling.
 */
export async function showSibling(delta: number): Promise<void> {
  const path = useGalleryStore.getState().siblingPath(delta);
  if (!path) return;
  await previewImage(path);
}

/** Open a folder in gallery mode via the native directory picker. */
export async function openFolderDialog(): Promise<void> {
  const selected = await open({ multiple: false, directory: true });
  if (typeof selected !== "string") return;
  const { sortOrder } = usePreferencesStore.getState();
  usePreferencesStore.getState().setLastFolder(selected);
  // Opening a folder drops the user into the gallery grid (spec §4.7).
  useUiStore.getState().setViewMode("gallery");
  await useGalleryStore.getState().loadFolder(selected, sortOrder);
}

/** Replace a path's file extension with the one for the chosen export format. */
function swapExtension(path: string, format: ExportOptions["format"]): string {
  const ext = FORMAT_EXTENSION[format];
  const dot = path.lastIndexOf(".");
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  // Only treat the dot as an extension separator if it's in the file name.
  if (dot > slash) return `${path.slice(0, dot)}.${ext}`;
  return `${path}.${ext}`;
}

/**
 * Copy the current image to the system clipboard with its transform stack
 * applied (spec §4.6). No-op when nothing is open. Errors are reported to the
 * console rather than thrown — there is no toast system yet.
 */
export async function copyCurrentToClipboard(): Promise<void> {
  const { current, transforms } = useViewerStore.getState();
  if (!current) return;
  // Show a busy state: the backend rasterizes the full-resolution image (decode
  // + transform + RGBA), which can take a noticeable moment for large photos
  // (spec §4.6). The button reflects this and blocks re-entry until it's done.
  const { setBusy } = useUiStore.getState();
  if (useUiStore.getState().busy) return; // a copy is already in flight
  setBusy("Copying…");
  try {
    await copyImageToClipboard(current.path, transforms);
  } catch (err) {
    console.error("Failed to copy image to clipboard", err);
  } finally {
    setBusy(null);
  }
}

/**
 * Export (save) the current image with its transform stack rasterized by the
 * backend (spec §4.9).
 *
 * Follows the spec's "Save As by default / confirm before overwrite"
 * principle: overwriting the original is opt-in via `opts.overwrite`.
 * Otherwise a native Save dialog picks the destination, defaulting to the
 * source path with its extension swapped to the chosen format.
 *
 * On success the chosen format/quality/preserveMetadata are persisted as the
 * new export defaults. No-op when no image is open or the user cancels the
 * Save dialog.
 */
export async function exportCurrentImage(
  opts: ExportOptions & { overwrite?: boolean },
): Promise<void> {
  const { current, transforms } = useViewerStore.getState();
  if (!current) return;

  let destPath: string;
  if (opts.overwrite) {
    destPath = current.path;
  } else {
    const selected = await save({
      defaultPath: swapExtension(current.path, opts.format),
      filters: [
        { name: opts.format.toUpperCase(), extensions: [FORMAT_EXTENSION[opts.format]] },
      ],
    });
    if (typeof selected !== "string") return; // user cancelled
    destPath = selected;
  }

  try {
    await exportImage({
      sourcePath: current.path,
      destPath,
      transforms,
      format: opts.format,
      quality: opts.quality,
      preserveMetadata: opts.preserveMetadata,
    });
  } catch (err) {
    console.error("Failed to export image", err);
    throw err;
  }

  // Remember the user's export choices for next time (spec §4.9, §4.11).
  usePreferencesStore.getState().setExportDefaults({
    format: opts.format,
    quality: opts.quality,
    preserveMetadata: opts.preserveMetadata,
  });
}
