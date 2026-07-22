use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use image::imageops::FilterType;
use rayon::prelude::*;
use serde::Serialize;
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

/// Result of `get_thumbnail`: the cached thumbnail file path plus the source
/// image's pixel dimensions, folded in here so the gallery/viewer don't need a
/// separate dimension probe once a tile's thumbnail has loaded (spec §10 perf
/// item "fold dimension-probing into thumbnail generation").
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailResult {
    pub thumb_path: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

fn as_result(dest: &Path, dims: (Option<u32>, Option<u32>)) -> ThumbnailResult {
    ThumbnailResult {
        thumb_path: dest.to_string_lossy().to_string(),
        width: dims.0,
        height: dims.1,
    }
}

/// Try to extract a JPEG's embedded EXIF preview (spec §10 perf item "EXIF-
/// embedded thumbnails"): most camera JPEGs carry a ~160-320px preview that
/// `kamadak-exif` can pull directly, skipping a full decode entirely. Returns
/// `None` if the file has no EXIF, no embedded preview, or the preview is too
/// small relative to the requested size to be worth using (avoids visible
/// upscaling blur in the grid).
fn embedded_preview(path: &Path, size: u32) -> Option<image::DynamicImage> {
    let file = std::fs::File::open(path).ok()?;
    let mut reader = std::io::BufReader::new(file);
    let exif = exif::Reader::new().read_from_container(&mut reader).ok()?;

    let offset = exif
        .get_field(exif::Tag::JPEGInterchangeFormat, exif::In::THUMBNAIL)?
        .value
        .get_uint(0)? as usize;
    let length = exif
        .get_field(exif::Tag::JPEGInterchangeFormatLength, exif::In::THUMBNAIL)?
        .value
        .get_uint(0)? as usize;
    let bytes = exif.buf().get(offset..offset.checked_add(length)?)?;

    let preview = image::load_from_memory(bytes).ok()?;
    if preview.width().min(preview.height()) < size / 2 {
        return None; // too small to be worth it at the requested size
    }

    let orientation = exif
        .get_field(exif::Tag::Orientation, exif::In::PRIMARY)
        .and_then(|f| f.value.get_uint(0))
        .unwrap_or(1);
    Some(crate::commands::apply_orientation(preview, orientation))
}

/// Decode (preferring a JPEG's embedded EXIF preview when it's large enough —
/// see [`embedded_preview`]), downscale, and cache a thumbnail at `dest`.
/// Returns the *source* image's pixel dimensions alongside, folded in for
/// free since a full decode already has them (or, for the embedded-preview
/// fast path, from the same cheap header probe `build_entry` would otherwise
/// do separately). Blocking — callers run this on a worker thread.
fn generate_and_cache(source: &Path, dest: &Path, size: u32) -> Result<(Option<u32>, Option<u32>)> {
    let is_jpeg = crate::commands::extension_of(source)
        .map(|e| e == "jpg" || e == "jpeg")
        .unwrap_or(false);

    if is_jpeg {
        if let Some(preview) = embedded_preview(source, size) {
            let thumb = preview.thumbnail(size, size);
            thumb.save_with_format(dest, image::ImageFormat::Png)?;
            let dims = crate::commands::dimensions_of(source).unwrap_or_default();
            return Ok((Some(dims.0), Some(dims.1)));
        }
    }

    let img = crate::commands::load_oriented(source)?;
    let (width, height) = (img.width(), img.height());
    let thumb = img.thumbnail(size, size); // preserves aspect ratio, fast
    thumb.save_with_format(dest, image::ImageFormat::Png)?;
    Ok((Some(width), Some(height)))
}

/// Best-effort thumbnail for a dataless iCloud placeholder via macOS's own
/// QuickLook thumbnailing (`qlmanage -t`) — the same mechanism Finder uses to
/// show a thumbnail for a file that hasn't been downloaded yet, since it can
/// read cached/lower-res preview data instead of forcing the full download
/// (testing notes: "does the OS get the thumbnails from somewhere else?").
/// Runs on a worker thread; returns `None` on any failure (missing `qlmanage`,
/// no cached preview available, decode failure, ...), in which case the
/// caller falls back to the existing "in iCloud, not downloaded" UI state.
#[cfg(target_os = "macos")]
fn quicklook_thumbnail(source: &Path, dest: &Path, size: u32) -> Option<ThumbnailResult> {
    let tmp_dir = std::env::temp_dir().join(format!("pics-rs-ql-{}", std::process::id()));
    std::fs::create_dir_all(&tmp_dir).ok()?;

    let output = std::process::Command::new("qlmanage")
        .args(["-t", "-s", &size.to_string(), "-o"])
        .arg(&tmp_dir)
        .arg(source)
        .output()
        .ok()?;

    let cleanup = |dir: &Path| {
        let _ = std::fs::remove_dir_all(dir);
    };

    if !output.status.success() {
        cleanup(&tmp_dir);
        return None;
    }

    // qlmanage writes `<original-file-name>.png` into the output dir.
    let file_name = source.file_name()?.to_str()?;
    let generated = tmp_dir.join(format!("{file_name}.png"));
    if !generated.is_file() {
        cleanup(&tmp_dir);
        return None;
    }

    let result = (|| -> Option<ThumbnailResult> {
        let img = image::open(&generated).ok()?;
        let (width, height) = (img.width(), img.height());
        let thumb = img.thumbnail(size, size);
        thumb.save_with_format(dest, image::ImageFormat::Png).ok()?;
        Some(as_result(dest, (Some(width), Some(height))))
    })();

    cleanup(&tmp_dir);
    result
}

#[cfg(not(target_os = "macos"))]
fn quicklook_thumbnail(_source: &Path, _dest: &Path, _size: u32) -> Option<ThumbnailResult> {
    None
}

/// Generate (or return the cached) thumbnail for an image, returning the path
/// to the thumbnail PNG on disk plus the source's pixel dimensions. The
/// WebView loads the thumbnail directly via the asset protocol — the bytes
/// never cross the IPC boundary (spec §6, §8.4).
///
/// This is `async` and does the decode/resize/encode on a blocking worker
/// (`spawn_blocking`) so the gallery flood never runs on the main thread. A
/// plain sync command would — and a single slow decode (or an iCloud download,
/// below) would freeze the entire window. The cheap parts (path checks, cache
/// lookup, the dataless `stat`) stay inline since they don't touch pixels.
#[tauri::command]
pub async fn get_thumbnail(app: AppHandle, path: String, size: u32) -> Result<ThumbnailResult> {
    let log = logger_rs::scope!("get_thumbnail");
    let source = PathBuf::from(&path);
    if !source.is_file() {
        log.warn(format!("not a file: {}", source.display()));
        return Err(Error::Message(format!("not a file: {}", source.display())));
    }

    let dest = cache_dir(&app)?.join(cache_key(&source, size)?);
    if dest.exists() {
        // Warm-cache path — this is why the second open of a folder is fast.
        log.debug(format!("cache hit ({size}px) for {}", source.display()));
        let dims = crate::commands::dimensions_of(&source).unwrap_or_default();
        return Ok(as_result(&dest, (Some(dims.0), Some(dims.1))));
    }

    // iCloud "Optimize Mac Storage" placeholder: the bytes aren't on disk, so a
    // decode here would block for tens of seconds while macOS downloads the file
    // (observed at 60–75 s). We refuse to auto-materialize during casual
    // browsing/scrolling. Try QuickLook's own thumbnail cache first; only show
    // the "in iCloud" state if that comes up empty too.
    if crate::commands::is_dataless(&source) {
        let source_for_ql = source.clone();
        let dest_for_ql = dest.clone();
        let ql_result = tauri::async_runtime::spawn_blocking(move || {
            quicklook_thumbnail(&source_for_ql, &dest_for_ql, size)
        })
        .await
        .unwrap_or(None);

        if let Some(result) = ql_result {
            log.debug(format!(
                "QuickLook thumbnail for iCloud placeholder {}",
                source.display()
            ));
            return Ok(result);
        }

        log.warn(format!(
            "iCloud placeholder not downloaded, skipping thumbnail: {}",
            source.display()
        ));
        return Err(Error::Dataless);
    }

    // Cold path: full-resolution decode dominates the cost here (issue #5), so
    // time it explicitly. Decode EXIF-upright (spec §4.5/§8.6), downscale with a
    // good default filter, and cache as PNG — all off the main thread.
    let dest_out = dest.clone();
    let dims = tauri::async_runtime::spawn_blocking(move || -> Result<(Option<u32>, Option<u32>)> {
        let log = logger_rs::scope!("get_thumbnail");
        let _t = log.timer(format!("Generating {size}px thumbnail for {}", source.display()));
        generate_and_cache(&source, &dest, size)
    })
    .await
    .map_err(|e| Error::Message(format!("thumbnail task panicked: {e}")))??;

    Ok(as_result(&dest_out, dims))
}

/// Best-effort thumbnail prewarm for a whole folder (spec §10 "batch
/// thumbnail prewarm"): fired once after `scan_folder` completes, this fans
/// the cold decodes out across all cores with rayon instead of the serial
/// one-thumbnail-per-scrolled-tile trickle, so a freshly opened folder's grid
/// fills in `total/num_cores` faster and without per-tile IPC latency.
///
/// Dataless (iCloud, not downloaded) files get the same QuickLook fallback
/// `get_thumbnail` uses (never a full decode/download) — earlier this skipped
/// them entirely, so a folder full of "Optimize Mac Storage" placeholders
/// (common for an iCloud Photos folder) barely benefited from prewarming at
/// all: each placeholder's QuickLook thumbnail was instead generated lazily,
/// one at a time, whenever its tile happened to mount, competing with
/// whatever the user was actively doing. Already-cached thumbnails are still
/// skipped; per-file errors are swallowed — `get_thumbnail` remains the
/// source of truth for what the UI actually shows a given tile.
#[tauri::command]
pub async fn prewarm_folder(app: AppHandle, paths: Vec<String>, size: u32) -> Result<()> {
    let log = logger_rs::scope!("prewarm_folder");
    let _t = log.timer(format!("Prewarming {} thumbnail(s) at {size}px", paths.len()));
    let dir = cache_dir(&app)?;

    tauri::async_runtime::spawn_blocking(move || {
        paths.par_iter().for_each(|path| {
            let source = PathBuf::from(path);
            if !source.is_file() {
                return;
            }
            let dest = match cache_key(&source, size) {
                Ok(key) => dir.join(key),
                Err(_) => return,
            };
            if dest.exists() {
                return;
            }
            if crate::commands::is_dataless(&source) {
                let _ = quicklook_thumbnail(&source, &dest, size);
                return;
            }
            let _ = generate_and_cache(&source, &dest, size);
        });
    })
    .await
    .map_err(|e| Error::Message(format!("prewarm task panicked: {e}")))?;

    Ok(())
}

/// Directory holding the persistent screen-resolution preview cache (spec §10
/// perf item "two-tier viewer image"), separate from the thumbnail cache.
fn preview_cache_dir(app: &AppHandle) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| Error::Message(format!("no cache dir: {e}")))?
        .join("previews");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Cache key mirrors `cache_key` (path, size, mtime, length) but is namespaced
/// by its own function so a preview and a thumbnail for the same file never
/// collide even if `max_dim` happened to equal a thumbnail `size`.
fn preview_cache_key(path: &Path, max_dim: u32) -> Result<String> {
    let meta = std::fs::metadata(path)?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hasher);
    "preview".hash(&mut hasher);
    max_dim.hash(&mut hasher);
    mtime.hash(&mut hasher);
    meta.len().hash(&mut hasher);
    Ok(format!("{:016x}_{}.jpg", hasher.finish(), max_dim))
}

/// Result of `get_preview`: the cached preview's on-disk path plus the
/// *source* image's true pixel dimensions (not the preview's, which are
/// capped to `max_dim`) — the viewer sizes its layout off these regardless of
/// which tier is currently displayed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewResult {
    pub preview_path: String,
    pub width: u32,
    pub height: u32,
}

/// Generate (or return the cached) screen-resolution preview for an image
/// (spec §10 perf item "two-tier viewer image"): opening a large photo used to
/// load the full-resolution original straight into the WebView — an 18MP
/// image is ~72MB decoded RGBA and a heavy decode on every open, just to be
/// displayed at fit-to-window scale. This serves a capped-dimension JPEG
/// instead for that common case; the viewer swaps to the true original only
/// once the user zooms in past 100% (`Viewer.tsx`).
///
/// Dataless iCloud placeholders are refused here for the same reason as
/// thumbnails (`get_thumbnail`) — generating a preview must never silently
/// trigger a multi-second download the user didn't ask for. The viewer only
/// requests a preview for an already-open image, whose full download (with
/// progress) `read_image_entry` already handled.
#[tauri::command]
pub async fn get_preview(app: AppHandle, path: String, max_dim: u32) -> Result<PreviewResult> {
    let log = logger_rs::scope!("get_preview");
    let source = PathBuf::from(&path);
    if !source.is_file() {
        log.warn(format!("not a file: {}", source.display()));
        return Err(Error::Message(format!("not a file: {}", source.display())));
    }

    let dest = preview_cache_dir(&app)?.join(preview_cache_key(&source, max_dim)?);
    if dest.exists() {
        log.debug(format!("cache hit (preview {max_dim}px) for {}", source.display()));
        let (width, height) = crate::commands::dimensions_of(&source).unwrap_or_default();
        return Ok(PreviewResult {
            preview_path: dest.to_string_lossy().to_string(),
            width,
            height,
        });
    }

    if crate::commands::is_dataless(&source) {
        return Err(Error::Dataless);
    }

    tauri::async_runtime::spawn_blocking(move || -> Result<PreviewResult> {
        let log = logger_rs::scope!("get_preview");
        let _t = log.timer(format!("Generating {max_dim}px preview for {}", source.display()));

        let img = crate::commands::load_oriented(&source)?;
        let (width, height) = (img.width(), img.height());
        // Downscale only — never upscale a source already smaller than the cap.
        let preview = if width.max(height) > max_dim {
            img.resize(max_dim, max_dim, FilterType::Triangle)
        } else {
            img
        };

        let rgb = preview.to_rgb8();
        let file = std::fs::File::create(&dest)?;
        let mut writer = std::io::BufWriter::new(file);
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut writer, 85);
        encoder
            .encode_image(&rgb)
            .map_err(|e| Error::Message(format!("preview jpeg encode failed: {e}")))?;

        Ok(PreviewResult {
            preview_path: dest.to_string_lossy().to_string(),
            width,
            height,
        })
    })
    .await
    .map_err(|e| Error::Message(format!("preview task panicked: {e}")))?
}

/// Re-exported so callers can pick the display resample filter later; the
/// batch/full-quality path (export) should use Lanczos3 per spec §4.4.
#[allow(dead_code)]
pub const EXPORT_FILTER: FilterType = FilterType::Lanczos3;
