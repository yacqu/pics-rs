import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { ImageEntry, Transform } from "@/types/image";

/**
 * Typed wrappers around the Tauri commands exposed by the Rust backend
 * (src-tauri/src/commands). Keeping every `invoke` call in one module means the
 * command names and payload shapes live in a single place and the rest of the
 * app talks to plain typed functions.
 *
 * Note (spec §6, §8.4): large image bytes are NOT round-tripped through IPC.
 * On-disk files are loaded directly by the WebView via `assetUrl` (the Tauri
 * asset protocol / convertFileSrc); only metadata and small results cross IPC.
 */

/** Build a WebView-loadable URL for an on-disk image (asset protocol). */
export function assetUrl(path: string): string {
  return convertFileSrc(path);
}

/**
 * Drain the path the app was launched to open (CLI arg / OS "Open with" on cold
 * start). Returns null if there was none. Called once when the UI mounts.
 */
export function takePendingOpen(): Promise<string | null> {
  return invoke<string | null>("take_pending_open");
}

/** Read metadata for a single image file. */
export function readImageEntry(path: string): Promise<ImageEntry> {
  return invoke<ImageEntry>("read_image_entry", { path });
}

/** Scan a folder for supported image files (sibling navigation + gallery). */
export function scanFolder(path: string): Promise<ImageEntry[]> {
  return invoke<ImageEntry[]>("scan_folder", { path });
}

/**
 * Generate (or fetch from cache) a thumbnail for an image, returning the path
 * to the cached thumbnail file on disk. The WebView loads it via `assetUrl`.
 */
export function getThumbnail(path: string, size: number): Promise<string> {
  return invoke<string>("get_thumbnail", { path, size });
}

/**
 * Request payload for `export_image`. The backend rasterizes the source image
 * with the given non-destructive transform stack applied and writes the result
 * to `destPath` in the chosen format (spec §4.9). `quality` is 1-100 (ignored
 * for lossless PNG); `preserveMetadata` controls whether EXIF is carried over
 * (privacy-relevant, spec §4.9).
 */
export interface ExportRequest {
  sourcePath: string;
  destPath: string;
  transforms: Transform[];
  format: "jpeg" | "png" | "webp";
  quality: number;
  preserveMetadata: boolean;
}

/**
 * Rasterize + encode an image on the backend and write it to disk. Returns the
 * written destination path (spec §4.9). Image bytes never cross IPC — only the
 * request metadata and the resulting path do (spec §6, §8.4).
 */
export function exportImage(request: ExportRequest): Promise<string> {
  return invoke<string>("export_image", { request });
}

/**
 * Rasterize the current image (with its transform stack applied) and place it
 * on the system clipboard as an image (spec §4.6). Bytes are handled entirely
 * in Rust; nothing large crosses IPC.
 */
export function copyImageToClipboard(
  sourcePath: string,
  transforms: Transform[],
): Promise<void> {
  return invoke("copy_image_to_clipboard", {
    request: { sourcePath, transforms },
  });
}
