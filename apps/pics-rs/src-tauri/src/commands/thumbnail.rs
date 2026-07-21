use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use image::imageops::FilterType;
use tauri::{AppHandle, Manager};

use crate::error::{Error, Result};

/// Directory holding the persistent thumbnail cache, under the OS app-cache dir.
fn cache_dir(app: &AppHandle) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| Error::Message(format!("no cache dir: {e}")))?
        .join("thumbnails");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Stable cache key derived from (path, size, mtime) so a thumbnail is
/// regenerated only when the source file changes (spec §4.7, §8.10).
fn cache_key(path: &Path, size: u32) -> Result<String> {
    let meta = std::fs::metadata(path)?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hasher);
    size.hash(&mut hasher);
    mtime.hash(&mut hasher);
    meta.len().hash(&mut hasher);
    Ok(format!("{:016x}_{}.png", hasher.finish(), size))
}

/// Generate (or return the cached) thumbnail for an image, returning the path
/// to the thumbnail PNG on disk. The WebView loads it directly via the asset
/// protocol — the bytes never cross the IPC boundary (spec §6, §8.4).
#[tauri::command]
pub fn get_thumbnail(app: AppHandle, path: String, size: u32) -> Result<String> {
    let source = Path::new(&path);
    if !source.is_file() {
        return Err(Error::Message(format!("not a file: {}", source.display())));
    }

    let dest = cache_dir(&app)?.join(cache_key(source, size)?);
    if dest.exists() {
        return Ok(dest.to_string_lossy().to_string());
    }

    // Decode, downscale with a good default filter, and cache as PNG.
    let img = image::open(source)?;
    let thumb = img.thumbnail(size, size); // preserves aspect ratio, fast
    thumb.save_with_format(&dest, image::ImageFormat::Png)?;

    Ok(dest.to_string_lossy().to_string())
}

/// Re-exported so callers can pick the display resample filter later; the
/// batch/full-quality path (export) should use Lanczos3 per spec §4.4.
#[allow(dead_code)]
pub const EXPORT_FILTER: FilterType = FilterType::Lanczos3;
