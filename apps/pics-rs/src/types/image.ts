/**
 * Core domain types shared between the Zustand stores, React components, and
 * the Tauri command bridge. These mirror the data the Rust backend returns and
 * the non-destructive edit model described in docs/specs.md §6.
 */

/** File formats the MVP viewer is expected to open (spec §4.8, MVP tier). */
export const MVP_EXTENSIONS = [
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif",
  "bmp",
] as const;

export type SupportedExtension = (typeof MVP_EXTENSIONS)[number];

/** Metadata for a single image file on disk (returned by the backend). */
export interface ImageEntry {
  /** Absolute path on disk. */
  path: string;
  /** File name including extension. */
  name: string;
  /** Lowercase extension without the dot. */
  extension: string;
  /** File size in bytes. */
  sizeBytes: number;
  /** Last-modified time, epoch milliseconds. */
  modifiedMs: number;
  /** Pixel dimensions once decoded; null until known. */
  width: number | null;
  height: number | null;
}

/** Sort keys for the gallery (spec §4.7). */
export type SortKey = "name" | "modified" | "dateTaken" | "size";
export type SortDirection = "asc" | "desc";

export interface SortOrder {
  key: SortKey;
  direction: SortDirection;
}

/** Aspect-ratio presets for the crop tool (spec §4.3). */
export type AspectPreset = "free" | "1:1" | "4:3" | "16:9" | "original";

/**
 * Non-destructive transform operations. The viewer keeps an ordered stack of
 * these and only rasterizes on export/save (spec §4.9, §6 "Edit model").
 */
export type Transform =
  | { kind: "rotate"; degrees: number }
  | { kind: "flip"; axis: "horizontal" | "vertical" }
  | { kind: "crop"; x: number; y: number; width: number; height: number }
  | { kind: "resize"; width: number; height: number }
  | { kind: "straighten"; angle: number };

/** Export options passed to the backend at save time (spec §4.9). */
export interface ExportOptions {
  format: "jpeg" | "png" | "webp";
  /** JPEG quality 1-100; ignored for lossless formats. */
  quality: number;
  /** Whether to preserve EXIF/metadata (privacy-relevant, spec §4.9). */
  preserveMetadata: boolean;
}
