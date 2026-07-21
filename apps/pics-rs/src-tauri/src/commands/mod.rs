pub mod export;
pub mod gallery;
pub mod thumbnail;
pub mod transform;

use image::DynamicImage;
use serde::Serialize;
use std::path::Path;
use std::time::UNIX_EPOCH;

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
fn apply_orientation(img: DynamicImage, orientation: u32) -> DynamicImage {
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

    // Reported dimensions reflect EXIF orientation: for orientations 5-8 the
    // image is rotated a quarter turn, so width/height are swapped (spec §4.5).
    let (width, height) = if with_dimensions {
        match image::image_dimensions(path) {
            Ok((w, h)) => {
                if (5..=8).contains(&exif_orientation(path)) {
                    (Some(h), Some(w))
                } else {
                    (Some(w), Some(h))
                }
            }
            Err(_) => (None, None),
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
#[tauri::command]
pub fn read_image_entry(path: String) -> Result<ImageEntry> {
    let path = Path::new(&path);
    if !path.is_file() {
        return Err(Error::Message(format!("not a file: {}", path.display())));
    }
    build_entry(path, true)
}
