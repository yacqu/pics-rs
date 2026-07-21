use std::path::Path;

use super::{build_entry, is_supported, ImageEntry};
use crate::error::{Error, Result};

/// Scan a single folder (non-recursive) for supported image files and return
/// their metadata. Dimensions are left unresolved here to keep large-folder
/// scans fast (spec §4.7, §5); the frontend sorts the result and lazily
/// requests thumbnails/dimensions as tiles come into view.
#[tauri::command]
pub fn scan_folder(path: String) -> Result<Vec<ImageEntry>> {
    let dir = Path::new(&path);
    if !dir.is_dir() {
        return Err(Error::Message(format!(
            "not a directory: {}",
            dir.display()
        )));
    }

    let mut entries = Vec::new();
    for item in std::fs::read_dir(dir)? {
        let item = item?;
        let entry_path = item.path();
        if entry_path.is_file() && is_supported(&entry_path) {
            // Skip files whose metadata can't be read rather than failing the
            // whole scan (e.g. a file removed mid-scan).
            if let Ok(entry) = build_entry(&entry_path, false) {
                entries.push(entry);
            }
        }
    }
    Ok(entries)
}
