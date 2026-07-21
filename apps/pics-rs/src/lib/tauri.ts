import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { ImageEntry } from "@/types/image";

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
