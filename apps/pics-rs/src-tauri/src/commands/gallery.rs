use std::path::{Path, PathBuf};

use rayon::prelude::*;

use super::{build_entry, is_supported, ImageEntry};
use crate::error::{Error, Result};

/// Scan a single folder (non-recursive) for supported image files and return
/// their metadata. Dimensions are left unresolved here to keep large-folder
/// scans fast (spec §4.7, §5); the frontend sorts the result and lazily
/// requests thumbnails/dimensions as tiles come into view.
///
/// `async` + `spawn_blocking` keeps the (N `stat()` calls) work off the main
/// thread, and `rayon`'s `par_iter` fans those stats out across all cores
/// instead of doing them one at a time — a 5k-file folder no longer blocks
/// the UI for a noticeable beat (spec §10 "async / threading — what's left").
#[tauri::command]
pub async fn scan_folder(path: String) -> Result<Vec<ImageEntry>> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<ImageEntry>> {
        let log = logger_rs::scope!("scan_folder");
        let _t = log.timer(format!("Scanning folder {path}"));

        let dir = Path::new(&path);
        if !dir.is_dir() {
            log.warn(format!("not a directory: {}", dir.display()));
            return Err(Error::Message(format!(
                "not a directory: {}",
                dir.display()
            )));
        }

        // Enumerate directory entries first — a single sequential `readdir` —
        // then parallelize the per-file `stat` calls (`build_entry`) with rayon.
        let paths: Vec<PathBuf> = std::fs::read_dir(dir)?
            .filter_map(|item| item.ok())
            .map(|item| item.path())
            .filter(|p| p.is_file() && is_supported(p))
            .collect();

        // Skip files whose metadata can't be read rather than failing the
        // whole scan (e.g. a file removed mid-scan).
        let entries: Vec<ImageEntry> = paths
            .par_iter()
            .filter_map(|p| build_entry(p, false).ok())
            .collect();

        log.info(format!("found {} supported image(s)", entries.len()));
        Ok(entries)
    })
    .await
    .map_err(|e| Error::Message(format!("scan task panicked: {e}")))?
}
