import { useEffect, useRef, useState } from "react";
import { assetUrl } from "@/lib/tauri";
import { requestThumbnail } from "@/lib/thumbnailQueue";
import { useGalleryStore } from "@/stores/galleryStore";
import { useUiStore } from "@/stores/uiStore";

/**
 * Resolve an on-disk thumbnail for `path` at `size` px (spec §4.7, §8.3). The
 * backend generates/caches the thumbnail file and returns its path; we convert
 * that to a WebView-loadable asset URL for an `<img src>` — image bytes never
 * cross IPC (spec §6/§8.4).
 *
 * Requests go through a bounded queue (`thumbnailQueue`) so scrolling/resizing a
 * large folder can't flood the backend. Two guards keep it cheap:
 *  - a short debounce, so a tile that scrolls past within a frame or two never
 *    fires a request at all;
 *  - an `AbortController`, so a request whose tile unmounted (or whose inputs
 *    changed) is dropped and its queue slot freed.
 *
 * A file that is an iCloud placeholder ("Optimize Mac Storage") isn't downloaded
 * to this Mac; the backend refuses to block on materializing it and returns the
 * `E_DATALESS` sentinel, which we surface as `dataless` so the tile can show a
 * distinct "in iCloud" state instead of a generic error.
 */

/** Delay before a mounted tile actually requests its thumbnail. Long enough that
 * fast-scrolled-past tiles never hit the backend, short enough to feel instant. */
const DEBOUNCE_MS = 90;

/** Backend sentinel prefix for an un-downloaded iCloud placeholder file. Kept in
 * sync with `DATALESS_SENTINEL` in `src-tauri/src/error.rs`. */
const DATALESS_PREFIX = "E_DATALESS";

function isDatalessError(err: unknown): boolean {
  return typeof err === "string" && err.startsWith(DATALESS_PREFIX);
}

export interface ThumbnailState {
  src: string | null;
  loading: boolean;
  error: boolean;
  /** The source is an iCloud placeholder that isn't downloaded to this Mac. */
  dataless: boolean;
}

export function useThumbnail(path: string, size: number): ThumbnailState {
  const [state, setState] = useState<ThumbnailState>({
    src: null,
    loading: true,
    error: false,
    dataless: false,
  });

  // Re-fetch once this file finishes downloading from iCloud — a click may
  // have triggered a real download via `previewImage`/`read_image_entry` —
  // so a tile that showed "in iCloud" doesn't keep showing it forever after
  // the file is actually materialized on disk.
  const [retryTick, setRetryTick] = useState(0);
  const downloading = useUiStore((s) => s.downloads[path] !== undefined);
  const wasDownloading = useRef(false);
  useEffect(() => {
    if (wasDownloading.current && !downloading) {
      setRetryTick((t) => t + 1);
    }
    wasDownloading.current = downloading;
  }, [downloading]);

  useEffect(() => {
    const controller = new AbortController();
    setState({ src: null, loading: true, error: false, dataless: false });

    const timer = setTimeout(() => {
      requestThumbnail(path, size, controller.signal)
        .then((result) => {
          if (controller.signal.aborted) return;
          setState({
            src: assetUrl(result.thumbPath),
            loading: false,
            error: false,
            dataless: false,
          });
          // Fold the dimensions the backend already computed into the
          // gallery entry, so opening this image later can skip a redundant
          // metadata read (spec §10 perf item, see actions.ts `previewImage`).
          if (result.width != null && result.height != null) {
            useGalleryStore
              .getState()
              .setEntryDimensions(path, result.width, result.height);
          }
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          const dataless = isDatalessError(err);
          setState({
            src: null,
            loading: false,
            error: !dataless,
            dataless,
          });
        });
    }, DEBOUNCE_MS);

    // Cancel the pending request when inputs change or the tile unmounts: clear
    // the debounce timer and abort so the queue slot is freed for a visible tile.
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [path, size, retryTick]);

  return state;
}
