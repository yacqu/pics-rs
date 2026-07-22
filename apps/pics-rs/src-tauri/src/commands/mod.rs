pub mod export;
pub mod gallery;
pub mod thumbnail;
pub mod transform;

use image::DynamicImage;
use serde::Serialize;
use std::path::Path;
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Emitter};

use crate::error::{Error, Result};

/// Image formats supported by the MVP viewer (spec §4.8, MVP tier). Kept in
/// sync with the frontend's `MVP_EXTENSIONS` and the `image` crate features.
pub const SUPPORTED_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp", "gif", "bmp"];

/// Metadata for a single image file. Serialized to camelCase to match the
/// `ImageEntry` interface on the TypeScript side.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageEntry {
    pub path: String,
    pub name: String,
    pub extension: String,
    pub size_bytes: u64,
    pub modified_ms: u64,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// Lowercase extension of a path without the leading dot.
pub fn extension_of(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
}

/// Whether a path has a supported image extension.
pub fn is_supported(path: &Path) -> bool {
    extension_of(path)
        .map(|ext| SUPPORTED_EXTENSIONS.contains(&ext.as_str()))
        .unwrap_or(false)
}

/// Whether `path` is an iCloud "dataless" placeholder — a file whose bytes have
/// been evicted from local disk by "Optimize Mac Storage". The *contents* aren't
/// present, so the first `read`/`open` blocks while macOS materializes the file
/// from iCloud (tens of seconds for a large image). Callers check this to avoid
/// stalling on a download they didn't ask for.
///
/// Detection uses the file's `st_flags` (a `stat`, which does NOT materialize
/// the file): macOS sets `SF_DATALESS` (0x4000_0000) on placeholder objects.
/// Non-macOS platforms have no such concept, so this is always `false`.
#[cfg(target_os = "macos")]
pub fn is_dataless(path: &Path) -> bool {
    use std::os::macos::fs::MetadataExt;
    // SF_DATALESS: "file is a dataless placeholder object" (sys/stat.h).
    const SF_DATALESS: u32 = 0x4000_0000;
    std::fs::metadata(path)
        .map(|m| m.st_flags() & SF_DATALESS != 0)
        .unwrap_or(false)
}

/// Non-macOS platforms have no iCloud dataless placeholders.
#[cfg(not(target_os = "macos"))]
pub fn is_dataless(_path: &Path) -> bool {
    false
}

/// Progress event payload emitted on the `icloud-download-progress` channel
/// while a dataless placeholder is being materialized (see
/// [`ensure_downloaded`]). The frontend listens for this to show download
/// feedback instead of the app appearing to silently stall (testing notes:
/// "no indication to the user that the image is being downloaded").
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    path: String,
    /// Best-effort estimate, 0.0..=100.0.
    percent: f32,
    complete: bool,
}

/// Materialize a dataless iCloud placeholder to local disk, emitting
/// `icloud-download-progress` events on `app` for the duration (testing
/// notes: a single click on an un-downloaded file should show progress and
/// then open automatically — no silent stall, no second click needed).
///
/// The actual download is triggered the same way it always was — reading the
/// file forces macOS to fetch it from iCloud — but now that read runs
/// alongside a polling loop that emits progress, instead of the caller simply
/// awaiting a black-box multi-second `read_image_entry` call.
///
/// Progress is a best-effort estimate from `st_blocks` (physical blocks
/// actually allocated on disk) against the placeholder's logical size: macOS
/// backfills a placeholder's blocks as iCloud streams bytes in, so this
/// tracks real download progress without any private API. On non-macOS
/// platforms `is_dataless` is always `false`, so this is never reached there.
pub async fn ensure_downloaded(app: &AppHandle, path: &Path) -> Result<()> {
    let path_str = path.to_string_lossy().to_string();
    let emit = |percent: f32, complete: bool| {
        let _ = app.emit(
            "icloud-download-progress",
            DownloadProgress {
                path: path_str.clone(),
                percent,
                complete,
            },
        );
    };
    emit(0.0, false);

    let total_blocks = expected_blocks(path);
    let read_path = path.to_path_buf();
    let handle = tauri::async_runtime::spawn_blocking(move || std::fs::read(&read_path));

    let poll_path = path.to_path_buf();
    while !handle.inner().is_finished() {
        emit(current_percent(&poll_path, total_blocks), false);
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }

    handle
        .await
        .map_err(|e| Error::Message(format!("download task panicked: {e}")))??;

    emit(100.0, true);
    Ok(())
}

#[cfg(target_os = "macos")]
fn expected_blocks(path: &Path) -> u64 {
    std::fs::metadata(path)
        .map(|m| m.len().div_ceil(512))
        .unwrap_or(0)
}

#[cfg(target_os = "macos")]
fn current_percent(path: &Path, total_blocks: u64) -> f32 {
    use std::os::macos::fs::MetadataExt;
    if total_blocks == 0 {
        return 0.0;
    }
    let blocks = std::fs::metadata(path).map(|m| m.st_blocks()).unwrap_or(0);
    // Cap below 100 while still polling — 100 is reserved for the final,
    // definitely-complete event so the UI doesn't flash "done" early.
    ((blocks as f32 / total_blocks as f32) * 100.0).min(99.0)
}

#[cfg(not(target_os = "macos"))]
fn expected_blocks(_path: &Path) -> u64 {
    0
}

#[cfg(not(target_os = "macos"))]
fn current_percent(_path: &Path, _total_blocks: u64) -> f32 {
    0.0
}

/// Read the EXIF orientation tag (values 1-8, spec §4.5/§8.6). Returns `1`
/// (normal) when the file has no EXIF, isn't readable, or lacks the tag.
pub fn exif_orientation(path: &Path) -> u32 {
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return 1,
    };
    let mut reader = std::io::BufReader::new(file);
    let exif = match exif::Reader::new().read_from_container(&mut reader) {
        Ok(e) => e,
        Err(_) => return 1,
    };
    exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY)
        .and_then(|f| f.value.get_uint(0))
        .unwrap_or(1)
}

/// Apply an EXIF orientation (1-8) so the returned image is visually upright.
/// The eight cases are the standard rotate/flip combinations.
pub fn apply_orientation(img: DynamicImage, orientation: u32) -> DynamicImage {
    match orientation {
        2 => img.fliph(),
        3 => img.rotate180(),
        4 => img.flipv(),
        5 => img.rotate90().fliph(),
        6 => img.rotate90(),
        7 => img.rotate270().fliph(),
        8 => img.rotate270(),
        _ => img, // 1 (normal) or unknown
    }
}

/// Decode an image and normalize its EXIF orientation so the result is upright
/// (spec §4.5, §8.6). This is the canonical decode entry point for
/// rasterization, export, and thumbnailing — anything that touches pixels.
pub fn load_oriented(path: &Path) -> Result<DynamicImage> {
    let img = image::open(path)?;
    Ok(apply_orientation(img, exif_orientation(path)))
}

/// Probe a file's pixel dimensions via a header-only read (no full decode —
/// `image::image_dimensions` parses just enough to find the size) and swap
/// width/height for EXIF orientations 5-8 so the result matches the visually
/// upright image (spec §4.5). Returns `None` if the header can't be parsed.
pub fn dimensions_of(path: &Path) -> Option<(u32, u32)> {
    let (w, h) = image::image_dimensions(path).ok()?;
    if (5..=8).contains(&exif_orientation(path)) {
        Some((h, w))
    } else {
        Some((w, h))
    }
}

/// Build an [`ImageEntry`] from a path, reading filesystem metadata. Pixel
/// dimensions are decoded lazily via `image::image_dimensions` only when
/// `with_dimensions` is set, since probing every file in a large folder would
/// be wasteful (spec §5, §8.3).
pub fn build_entry(path: &Path, with_dimensions: bool) -> Result<ImageEntry> {
    let meta = std::fs::metadata(path)?;
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| Error::Message("invalid file name".into()))?
        .to_string();

    let (width, height) = if with_dimensions {
        match dimensions_of(path) {
            Some((w, h)) => (Some(w), Some(h)),
            None => (None, None),
        }
    } else {
        (None, None)
    };

    Ok(ImageEntry {
        path: path.to_string_lossy().to_string(),
        name,
        extension: extension_of(path).unwrap_or_default(),
        size_bytes: meta.len(),
        modified_ms,
        width,
        height,
    })
}

/// Read metadata (including pixel dimensions) for a single image file.
///
/// This is an explicit, single-file action (the user opened this image), so
/// unlike thumbnail generation it's allowed to trigger an iCloud download for
/// a dataless placeholder — but it now does so via [`ensure_downloaded`],
/// which reports progress instead of leaving the caller awaiting a silent
/// multi-second promise (testing notes: single click should download with
/// visible progress and open automatically, no second click required). The
/// dimension probe + metadata read runs on a blocking worker via
/// `spawn_blocking` so the UI thread never freezes on it.
#[tauri::command]
pub async fn read_image_entry(app: AppHandle, path: String) -> Result<ImageEntry> {
    let path = std::path::PathBuf::from(&path);
    if !path.is_file() {
        let log = logger_rs::scope!("read_image_entry");
        log.warn(format!("not a file: {}", path.display()));
        return Err(Error::Message(format!("not a file: {}", path.display())));
    }

    if is_dataless(&path) {
        ensure_downloaded(&app, &path).await?;
    }

    tauri::async_runtime::spawn_blocking(move || {
        let log = logger_rs::scope!("read_image_entry");
        let _t = log.timer(format!("Read image entry {}", path.display()));
        build_entry(&path, true)
    })
    .await
    .map_err(|e| Error::Message(format!("read task panicked: {e}")))?
}
