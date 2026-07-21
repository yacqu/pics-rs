import { useEffect, useState } from "react";
import { X, Save, HardDriveDownload, AlertTriangle } from "lucide-react";
import type { ExportOptions } from "@/types/image";
import { useViewerStore } from "@/stores/viewerStore";
import { usePreferencesStore } from "@/stores/preferencesStore";
import { exportCurrentImage } from "@/lib/actions";

/**
 * Export dialog (spec §4.9). Lets the user pick output format, quality (for
 * lossy formats), and whether to preserve EXIF metadata, then either "Save
 * As…" (native Save dialog) or overwrite the original.
 *
 * Per the spec's "Save As by default / confirm before overwrite" principle,
 * overwriting the original is gated behind an inline confirm step because it
 * destroys the file the user opened (spec §4.9, §8.11).
 */

type Format = ExportOptions["format"];

const FORMATS: { value: Format; label: string }[] = [
  { value: "jpeg", label: "JPEG" },
  { value: "png", label: "PNG" },
  { value: "webp", label: "WebP" },
];

export default function ExportDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const hasImage = useViewerStore((s) => s.current !== null);
  const exportDefaults = usePreferencesStore((s) => s.exportDefaults);

  const [format, setFormat] = useState<Format>(exportDefaults.format);
  const [quality, setQuality] = useState<number>(exportDefaults.quality);
  const [preserveMetadata, setPreserveMetadata] = useState<boolean>(
    exportDefaults.preserveMetadata,
  );
  const [confirmingOverwrite, setConfirmingOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed fields from the persisted defaults each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setFormat(exportDefaults.format);
    setQuality(exportDefaults.quality);
    setPreserveMetadata(exportDefaults.preserveMetadata);
    setConfirmingOverwrite(false);
    setBusy(false);
    setError(null);
  }, [open, exportDefaults]);

  if (!open) return null;

  const isLossy = format === "jpeg" || format === "webp";
  const opts: ExportOptions = { format, quality, preserveMetadata };
  const disabled = !hasImage || busy;

  async function run(overwrite: boolean) {
    setBusy(true);
    setError(null);
    try {
      await exportCurrentImage({ ...opts, overwrite });
      onClose();
    } catch {
      setError("Export failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Export image"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg bg-white p-5 text-neutral-900 shadow-xl dark:bg-neutral-800 dark:text-neutral-100"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">Export image</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-200 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-700 dark:hover:text-neutral-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Format selector */}
        <div className="mb-4">
          <label className="mb-1.5 block text-xs font-medium text-neutral-600 dark:text-neutral-400">
            Format
          </label>
          <div className="inline-flex rounded-md border border-neutral-300 p-0.5 dark:border-neutral-600">
            {FORMATS.map((f) => (
              <button
                key={f.value}
                type="button"
                onClick={() => setFormat(f.value)}
                aria-pressed={format === f.value}
                className={
                  "rounded px-3 py-1 text-sm transition-colors " +
                  (format === f.value
                    ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                    : "text-neutral-600 hover:bg-neutral-200 dark:text-neutral-300 dark:hover:bg-neutral-700")
                }
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {/* Quality slider (lossy formats only; PNG is lossless) */}
        <div className="mb-4">
          <label className="mb-1.5 flex items-center justify-between text-xs font-medium text-neutral-600 dark:text-neutral-400">
            <span>Quality</span>
            {isLossy && (
              <span className="tabular-nums text-neutral-500 dark:text-neutral-400">
                {quality}
              </span>
            )}
          </label>
          {isLossy ? (
            <input
              type="range"
              min={1}
              max={100}
              value={quality}
              onChange={(e) => setQuality(Number(e.target.value))}
              className="w-full accent-neutral-900 dark:accent-neutral-100"
            />
          ) : (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              PNG is lossless — no quality setting.
            </p>
          )}
        </div>

        {/* Preserve metadata */}
        <div className="mb-5">
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={preserveMetadata}
              onChange={(e) => setPreserveMetadata(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-neutral-900 dark:accent-neutral-100"
            />
            <span className="text-sm">
              Preserve metadata (EXIF)
              <span className="mt-0.5 block text-xs text-neutral-500 dark:text-neutral-400">
                EXIF can include GPS location and other private data.
              </span>
            </span>
          </label>
        </div>

        {error && (
          <p className="mb-3 text-xs text-red-600 dark:text-red-400">{error}</p>
        )}

        {/* Actions */}
        {confirmingOverwrite ? (
          <div className="rounded-md border border-amber-400 bg-amber-50 p-3 dark:border-amber-600/60 dark:bg-amber-900/20">
            <p className="mb-3 flex items-start gap-2 text-xs text-amber-800 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                This overwrites the original file and cannot be undone. Continue?
              </span>
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmingOverwrite(false)}
                disabled={busy}
                className="rounded-md px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-200 disabled:opacity-40 dark:text-neutral-300 dark:hover:bg-neutral-700"
              >
                Back
              </button>
              <button
                type="button"
                onClick={() => void run(true)}
                disabled={disabled}
                className="rounded-md bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Overwrite
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setConfirmingOverwrite(true)}
              disabled={disabled}
              className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-40 dark:text-neutral-300 dark:hover:bg-neutral-700"
            >
              <HardDriveDownload className="h-4 w-4" />
              Overwrite original
            </button>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                className="rounded-md px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-200 disabled:opacity-40 dark:text-neutral-300 dark:hover:bg-neutral-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void run(false)}
                disabled={disabled}
                className="inline-flex items-center gap-1.5 rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
              >
                <Save className="h-4 w-4" />
                Save As…
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
