import { useEffect, useState } from "react";
import { getThumbnail, assetUrl } from "@/lib/tauri";

/**
 * Resolve an on-disk thumbnail for `path` at `size` px (spec §4.7, §8.3). The
 * backend generates/caches the thumbnail file and returns its path; we convert
 * that to a WebView-loadable asset URL for an `<img src>` — image bytes never
 * cross IPC (spec §6/§8.4).
 *
 * Gallery tiles recycle aggressively while scrolling, so this hook guards
 * against stale async results: each fetch is tagged with a request id and only
 * the latest, still-mounted request is allowed to commit. Nothing refetches
 * unless `path` or `size` actually changes.
 */
export function useThumbnail(
  path: string,
  size: number,
): { src: string | null; loading: boolean; error: boolean } {
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(false);
    setSrc(null);

    getThumbnail(path, size)
      .then((thumbPath) => {
        if (!active) return;
        setSrc(assetUrl(thumbPath));
        setLoading(false);
      })
      .catch(() => {
        if (!active) return;
        setError(true);
        setLoading(false);
      });

    // Ignore this request's result if the inputs change or we unmount.
    return () => {
      active = false;
    };
  }, [path, size]);

  return { src, loading, error };
}
