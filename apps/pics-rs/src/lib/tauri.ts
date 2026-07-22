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
 * Result of `get_thumbnail`: the cached thumbnail's on-disk path plus the
 * source image's pixel dimensions, folded in by the backend so callers don't
 * need a separate dimension probe once a tile's thumbnail has loaded (spec
 * §10 perf item "fold dimension-probing into thumbnail generation").
 */
export interface ThumbnailResult {
  thumbPath: string;
  width: number | null;
  height: number | null;
}

/**
 * Generate (or fetch from cache) a thumbnail for an image, returning the path
 * to the cached thumbnail file on disk plus its dimensions. The WebView loads
 * the thumbnail via `assetUrl`.
 */
export function getThumbnail(path: string, size: number): Promise<ThumbnailResult> {
  return invoke<ThumbnailResult>("get_thumbnail", { path, size });
}

/**
 * Best-effort, fire-and-forget thumbnail prewarm for an entire folder (spec
 * §10 "batch thumbnail prewarm"): rayon-parallelizes cold decodes across all
 * cores so the grid fills in without a per-tile IPC trickle. Errors are not
 * meaningful to the caller — `getThumbnail` remains the source of truth for
 * what a given tile actually shows.
 */
export function prewarmFolder(paths: string[], size: number): Promise<void> {
  return invoke("prewarm_folder", { paths, size });
}

/** Result of `get_preview`: the cached preview's on-disk path plus the
 * *source* image's true pixel dimensions (spec §10 "two-tier viewer image"). */
export interface PreviewResult {
  previewPath: string;
  width: number;
  height: number;
}

/**
 * Generate (or fetch from cache) a screen-resolution preview (longest edge
 * capped at `maxDim`) for an image, so the viewer doesn't have to decode the
 * full-resolution original just to show it at fit-to-window scale (spec §10
 * "two-tier viewer image"). Rejects with the same `E_DATALESS` sentinel as
 * `getThumbnail` for an un-downloaded iCloud placeholder.
 */
export function getPreview(path: string, maxDim: number): Promise<PreviewResult> {
  return invoke<PreviewResult>("get_preview", { path, maxDim });
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
