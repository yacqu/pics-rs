import { ImageOff } from "lucide-react";
import { useThumbnail } from "@/hooks/useThumbnail";
import type { ImageEntry } from "@/types/image";

/**
 * A single gallery cell (spec §4.7): a square thumbnail with a skeleton
 * placeholder while the backend generates it, a broken-image fallback on error,
 * the truncated filename below, and a ring when selected. Purely presentational
 * — Gallery owns the data and the open action, passed in via `onOpen`.
 *
 * The tile fills its (absolutely-positioned) wrapper EXACTLY so the virtualized
 * grid stays aligned: it has no outer padding and no inter-element gap, its
 * thumbnail is a fixed `thumbHeight` px square, and its label is a fixed
 * `labelHeight` px row. This makes the invariant `wrapperHeight === thumbHeight
 * + labelHeight` hold, so Gallery's row math and this DOM can never disagree.
 */

interface GalleryTileProps {
  entry: ImageEntry;
  /** Thumbnail edge length in px requested from the backend cache. */
  size: number;
  /**
   * Rendered height of the square thumbnail in px. Equals the cell width, so
   * with `w-full` the thumbnail is a perfect square filling the cell.
   */
  thumbHeight: number;
  /** Fixed height of the filename row in px. */
  labelHeight: number;
  selected: boolean;
  onOpen: (path: string) => void;
}

export default function GalleryTile({
  entry,
  size,
  thumbHeight,
  labelHeight,
  selected,
  onOpen,
}: GalleryTileProps) {
  const { src, loading, error } = useThumbnail(entry.path, size);

  return (
    <button
      type="button"
      onClick={() => onOpen(entry.path)}
      title={entry.name}
      aria-label={entry.name}
      aria-pressed={selected}
      className={`group flex h-full w-full flex-col items-stretch rounded-md text-left transition-colors hover:bg-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-neutral-800 ${
        selected ? "bg-neutral-100 dark:bg-neutral-800" : ""
      }`}
    >
      <div
        style={{ height: thumbHeight }}
        className={`relative flex w-full items-center justify-center overflow-hidden rounded-md bg-neutral-100 dark:bg-neutral-800 ${
          selected
            ? "ring-2 ring-blue-500 ring-offset-2 ring-offset-white dark:ring-offset-neutral-900"
            : "ring-1 ring-neutral-200 dark:ring-neutral-700"
        }`}
      >
        {loading && (
          <div className="h-full w-full animate-pulse bg-neutral-200 dark:bg-neutral-700" />
        )}
        {error && (
          <ImageOff className="h-6 w-6 text-neutral-400 dark:text-neutral-500" />
        )}
        {!error && src && (
          <img
            src={src}
            alt={entry.name}
            draggable={false}
            loading="lazy"
            className={`h-full w-full select-none object-cover transition-opacity ${
              loading ? "opacity-0" : "opacity-100"
            }`}
          />
        )}
      </div>
      <div
        style={{ height: labelHeight }}
        className="flex items-center"
      >
        <span className="w-full truncate px-0.5 text-xs text-neutral-600 dark:text-neutral-300">
          {entry.name}
        </span>
      </div>
    </button>
  );
}
