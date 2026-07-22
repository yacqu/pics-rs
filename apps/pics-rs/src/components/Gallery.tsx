import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowUpDown, ImageOff } from "lucide-react";
import { useGalleryStore } from "@/stores/galleryStore";
import { usePreferencesStore } from "@/stores/preferencesStore";
import { openImagePath } from "@/lib/actions";
import { rafThrottle } from "@/lib/rafThrottle";
import type { ImageEntry, SortKey } from "@/types/image";
import GalleryTile from "@/components/GalleryTile";

/**
 * Folder / gallery grid (spec §4.7). Renders the current folder's entries as a
 * responsive thumbnail grid with sort + extension-filter controls.
 *
 * Virtualization (spec §4.7, §8.10): folders can hold thousands of files, so we
 * hand-roll a windowed grid (no extra dependency) — columns are derived from the
 * measured container width, only the rows intersecting the viewport (plus a
 * small overscan) are rendered, and total scroll height is preserved by a
 * spacer so the scrollbar behaves normally. Tiles are absolutely positioned
 * within that spacer.
 */

// Layout constants (px). Kept here so the virtualization math has one source.
const PADDING = 16; // container inset (matches p-4)
const GAP = 12; // gap between cells (matches 0.75rem)
const MIN_TILE = 168; // target minimum cell width before adding a column
const LABEL_H = 24; // filename row under each thumbnail
const OVERSCAN = 2; // extra rows rendered above/below the viewport
// Fixed thumbnail request size, independent of on-screen cell width, so
// resizing the window never invalidates the backend thumbnail cache (spec §4.7).
const THUMB_SIZE = 256;

const SORT_LABELS: Record<SortKey, string> = {
  name: "Name",
  modified: "Date modified",
  dateTaken: "Date taken",
  size: "Size",
};

export default function Gallery() {
  const entries = useGalleryStore((s) => s.entries);
  const selectedPath = useGalleryStore((s) => s.selectedPath);
  const loading = useGalleryStore((s) => s.loading);
  const error = useGalleryStore((s) => s.error);
  const folder = useGalleryStore((s) => s.folder);
  const filterExtensions = useGalleryStore((s) => s.filterExtensions);
  const setFilter = useGalleryStore((s) => s.setFilter);
  const sortEntries = useGalleryStore((s) => s.sortEntries);

  const sortOrder = usePreferencesStore((s) => s.sortOrder);
  const setSortOrder = usePreferencesStore((s) => s.setSortOrder);

  // Extensions actually present in this folder, for the filter chips.
  const presentExtensions = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) set.add(e.extension.toLowerCase());
    return [...set].sort();
  }, [entries]);

  // Entries after the extension filter (mirrors store.visibleEntries()).
  const visible = useMemo<ImageEntry[]>(() => {
    if (filterExtensions === null || filterExtensions.length === 0) {
      return entries;
    }
    const allowed = new Set(filterExtensions.map((x) => x.toLowerCase()));
    return entries.filter((e) => allowed.has(e.extension.toLowerCase()));
  }, [entries, filterExtensions]);

  // Scroll container measurement + scroll position drive the virtual window.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = useState(0);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Coalesce resize callbacks to one per frame: a drag-resize fires the
    // observer continuously, and each measure re-renders the whole virtual grid.
    const measure = rafThrottle(() =>
      setSize({ width: el.clientWidth, height: el.clientHeight }),
    );
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
      measure.cancel();
    };
  }, []);

  // Scroll fires many times per frame; coalesce to one virtualization update per
  // paint. `scrollTop` is read synchronously (React event) before the rAF tick.
  const onScroll = useMemo(
    () => rafThrottle((top: number) => setScrollTop(top)),
    [],
  );
  useEffect(() => () => onScroll.cancel(), [onScroll]);

  // Grid geometry derived from measured width. The cell is a `cellWidth`-square
  // thumbnail stacked on a `LABEL_H` filename row (no tile padding, no internal
  // gap), so a cell's content height is exactly `cellWidth + LABEL_H`. GAP is
  // the space *between* cells; `rowHeight` is one cell plus that trailing gap.
  // These pieces are handed to GalleryTile verbatim (thumbHeight/labelHeight) so
  // the wrapper height below and the tile's DOM cannot disagree.
  const innerWidth = Math.max(0, size.width - PADDING * 2);
  const columns = Math.max(
    1,
    Math.floor((innerWidth + GAP) / (MIN_TILE + GAP)),
  );
  const cellWidth =
    columns > 0 ? (innerWidth - (columns - 1) * GAP) / columns : innerWidth;
  const cellHeight = cellWidth + LABEL_H; // thumbnail square + label row
  const rowHeight = cellHeight + GAP;
  const totalRows = Math.ceil(visible.length / columns);
  const totalHeight = totalRows * rowHeight;
  // Full scroll height of the spacer: N rows of `rowHeight` drop one trailing
  // GAP (the last row needs none) and add a PADDING inset top and bottom.
  const spacerHeight = totalHeight - GAP + PADDING * 2;

  // Visible row range (+ overscan) from the current scroll offset.
  const firstRow = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
  const lastRow = Math.min(
    totalRows - 1,
    Math.floor((scrollTop + size.height) / rowHeight) + OVERSCAN,
  );

  const windowed: { entry: ImageEntry; top: number; left: number }[] = [];
  if (cellWidth > 0 && totalRows > 0) {
    for (let row = firstRow; row <= lastRow; row++) {
      for (let col = 0; col < columns; col++) {
        const index = row * columns + col;
        if (index >= visible.length) break;
        const entry = visible[index];
        if (!entry) continue;
        windowed.push({
          entry,
          top: PADDING + row * rowHeight,
          left: PADDING + col * (cellWidth + GAP),
        });
      }
    }
  }

  // Reset scroll to top when the folder changes (a genuinely new folder starts
  // at the top). The selected-image effect below runs after this and wins when
  // a selection exists in the current folder.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setScrollTop(0);
  }, [folder]);

  // Scroll the selected image's row to the TOP of the viewport whenever the
  // selection changes (or the gallery/geometry becomes available) while showing
  // this folder (spec §4.7). We keep `scrollTop` state in sync so the
  // virtualization window recomputes for the new position.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !selectedPath || columns < 1 || rowHeight <= 0) return;
    const index = visible.findIndex((e) => e.path === selectedPath);
    if (index < 0) return; // stale selection not in the current visible list
    const row = Math.floor(index / columns);
    const maxScroll = Math.max(0, spacerHeight - size.height);
    const target = Math.min(PADDING + row * rowHeight, maxScroll);
    el.scrollTop = target;
    setScrollTop(target);
  }, [selectedPath, visible, columns, rowHeight, spacerHeight, size.height]);

  function changeSortKey(key: SortKey) {
    const next = { ...sortOrder, key };
    setSortOrder(next);
    sortEntries(next);
  }

  function toggleDirection() {
    const next = {
      ...sortOrder,
      direction: sortOrder.direction === "asc" ? "desc" : "asc",
    } as const;
    setSortOrder(next);
    sortEntries(next);
  }

  function toggleExtension(ext: string) {
    // Treat `null` as "all present extensions selected".
    const current = new Set(filterExtensions ?? presentExtensions);
    if (current.has(ext)) current.delete(ext);
    else current.add(ext);
    if (current.size === 0 || current.size === presentExtensions.length) {
      setFilter(null); // all (or none → all, avoids an empty grid dead-end)
    } else {
      setFilter([...current]);
    }
  }

  function isExtActive(ext: string): boolean {
    return filterExtensions === null || filterExtensions.includes(ext);
  }

  return (
    <div className="flex h-full flex-col bg-white text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
      {/* Header: sort + filter controls (spec §4.7) */}
      <div className="flex flex-wrap items-center gap-2 border-b border-neutral-200 px-4 py-2 dark:border-neutral-800">
        <label className="flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
          Sort
          <select
            value={sortOrder.key}
            onChange={(e) => changeSortKey(e.target.value as SortKey)}
            className="rounded-md border border-neutral-200 bg-white px-2 py-1 text-xs text-neutral-800 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
          >
            {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
              <option key={key} value={key}>
                {SORT_LABELS[key]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={toggleDirection}
          title={`Direction: ${sortOrder.direction === "asc" ? "ascending" : "descending"}`}
          aria-label="Toggle sort direction"
          className="inline-flex items-center gap-1 rounded-md border border-neutral-200 px-2 py-1 text-xs text-neutral-600 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          <ArrowUpDown className="h-3.5 w-3.5" />
          {sortOrder.direction === "asc" ? "Asc" : "Desc"}
        </button>

        {presentExtensions.length > 1 && (
          <div className="flex flex-wrap items-center gap-1">
            {presentExtensions.map((ext) => {
              const active = isExtActive(ext);
              return (
                <button
                  key={ext}
                  type="button"
                  onClick={() => toggleExtension(ext)}
                  aria-pressed={active}
                  className={`rounded-full border px-2 py-0.5 text-xs uppercase transition-colors ${
                    active
                      ? "border-blue-500 bg-blue-500 text-white"
                      : "border-neutral-200 text-neutral-500 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800"
                  }`}
                >
                  {ext}
                </button>
              );
            })}
          </div>
        )}

        <span className="ml-auto text-xs tabular-nums text-neutral-500 dark:text-neutral-400">
          {visible.length}
          {visible.length !== entries.length ? ` / ${entries.length}` : ""}{" "}
          {visible.length === 1 ? "image" : "images"}
        </span>
      </div>

      {/* Scrollable virtualized grid */}
      <div
        ref={scrollRef}
        onScroll={(e) => onScroll(e.currentTarget.scrollTop)}
        className="relative flex-1 overflow-y-auto"
      >
        {loading ? (
          <div className="flex h-full items-center justify-center text-sm text-neutral-400 dark:text-neutral-500">
            Loading folder…
          </div>
        ) : error ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-neutral-400 dark:text-neutral-500">
            <ImageOff className="h-6 w-6" />
            {error}
          </div>
        ) : visible.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-neutral-400 dark:text-neutral-500">
            No images in this folder
          </div>
        ) : (
          <div className="relative" style={{ height: spacerHeight }}>
            {/* This spacer carries the full scroll height; only the windowed
                tiles are mounted, absolutely positioned with a PADDING inset.
                The wrapper is exactly one cell (cellWidth × cellHeight) and the
                tile fills it, so the grid stays pixel-aligned. */}
            {windowed.map(({ entry, top, left }) => (
              <div
                key={entry.path}
                style={{
                  position: "absolute",
                  top,
                  left,
                  width: cellWidth,
                  height: cellHeight,
                }}
              >
                <GalleryTile
                  entry={entry}
                  size={THUMB_SIZE}
                  thumbHeight={cellWidth}
                  labelHeight={LABEL_H}
                  selected={entry.path === selectedPath}
                  onOpen={(path) => void openImagePath(path)}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
