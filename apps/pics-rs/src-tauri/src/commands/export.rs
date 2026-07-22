//! Rasterization endpoints (spec §4.6, §4.9). The non-destructive edit stack is
//! only baked into pixels here: on export to disk, and on copy-to-clipboard.
//!
//! Both commands share the same pipeline — `load_oriented` (EXIF-upright decode,
//! spec §4.5/§8.6) -> `apply_transforms` -> encode/copy.

use std::borrow::Cow;
use std::io::Cursor;
use std::path::Path;

use image::{DynamicImage, ImageFormat};

use super::load_oriented;
use super::transform::{apply_transforms, Transform};
use crate::error::{Error, Result};

/// Request to rasterize the edit stack and write it to disk (spec §4.9).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub source_path: String,
    pub dest_path: String,
    pub transforms: Vec<Transform>,
    /// "jpeg" | "png" | "webp".
    pub format: String,
    /// 1..=100, JPEG/WebP only.
    pub quality: u8,
    pub preserve_metadata: bool,
}

/// Request to rasterize the edit stack into an in-memory bitmap (spec §4.6).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderRequest {
    pub source_path: String,
    pub transforms: Vec<Transform>,
}

/// Decode the source upright, apply the edit stack, and encode to `dest_path` in
/// the requested format. Returns `dest_path` on success (spec §4.9).
#[tauri::command]
pub fn export_image(request: ExportRequest) -> Result<String> {
    let log = logger_rs::scope!("export_image");
    let source = Path::new(&request.source_path);
    if !source.is_file() {
        log.warn(format!("not a file: {}", source.display()));
        return Err(Error::Message(format!("not a file: {}", source.display())));
    }

    let _t = log.timer(format!(
        "Export to {} (format={}, quality={})",
        request.dest_path, request.format, request.quality
    ));

    let img = log.time("decode", || load_oriented(source))?;
    let img = log.time("apply transforms", || apply_transforms(img, &request.transforms));
    let dest = Path::new(&request.dest_path);

    match request.format.to_ascii_lowercase().as_str() {
        "jpeg" | "jpg" => {
            encode_jpeg(&img, dest, request.quality)?;
            // Best-effort EXIF carry-over: JPEG source -> JPEG dest only. Any
            // failure leaves the (already-written) stripped file in place, which
            // is the safe privacy default (spec §4.9). Full preserve for
            // PNG/WebP is a v0.3 item.
            //
            // KNOWN LIMITATION (v0.3): the pixels have already been normalized
            // upright by `load_oriented`, but the copied EXIF still carries the
            // source's original Orientation tag. A viewer that honors EXIF would
            // therefore re-apply the rotation. `preserve_jpeg_exif` clears the
            // Orientation tag where it can to avoid this double-rotation.
            if request.preserve_metadata && is_jpeg_path(source) {
                let _ = preserve_jpeg_exif(source, dest);
            }
        }
        "png" => {
            // `image`'s default PNG encoding; quality is ignored (lossless).
            img.save_with_format(dest, ImageFormat::Png)?;
        }
        "webp" => {
            // `image` 0.25 ships a lossless-only WebP encoder, so `quality` is
            // ignored here. Encode via `DynamicImage::write_to`.
            let mut buf = Cursor::new(Vec::new());
            img.write_to(&mut buf, ImageFormat::WebP).map_err(|e| {
                Error::Message(format!("webp encode failed: {e}"))
            })?;
            std::fs::write(dest, buf.into_inner())?;
        }
        other => {
            return Err(Error::Message(format!("unsupported export format: {other}")));
        }
    }

    Ok(request.dest_path)
}

/// Rasterize the edit stack and place the result on the system clipboard as raw
/// RGBA (spec §4.6). Cross-platform clipboard image formats are normalized by
/// `arboard`.
#[tauri::command]
pub fn copy_image_to_clipboard(request: RenderRequest) -> Result<()> {
    let log = logger_rs::scope!("copy_image_to_clipboard");
    let source = Path::new(&request.source_path);
    if !source.is_file() {
        log.warn(format!("not a file: {}", source.display()));
        return Err(Error::Message(format!("not a file: {}", source.display())));
    }

    // Time the whole copy plus each stage — the notes call out copy latency
    // specifically (issue #3/#4). The stage timers pinpoint whether the cost is
    // decode, the RGBA conversion, or the platform clipboard handoff.
    let _total = log.timer("Copy to clipboard");

    let decode = log.timer("decode");
    let img = load_oriented(source)?;
    decode.done();

    let img = log.time("apply transforms", || apply_transforms(img, &request.transforms));

    let rgba = log.time("to rgba8", || img.to_rgba8());
    let (width, height) = (rgba.width() as usize, rgba.height() as usize);
    let bytes = rgba.into_raw();
    log.debug(format!("rasterized {width}x{height} ({} bytes)", bytes.len()));

    let clip = log.timer("clipboard set_image");
    let mut clipboard = arboard::Clipboard::new()
        .map_err(|e| Error::Message(format!("clipboard unavailable: {e}")))?;
    clipboard
        .set_image(arboard::ImageData {
            width,
            height,
            bytes: Cow::from(bytes),
        })
        .map_err(|e| Error::Message(format!("clipboard write failed: {e}")))?;
    clip.done();

    Ok(())
}

/// Encode `img` as JPEG at `dest` with the given quality (1..=100). JPEG has no
/// alpha channel, so the image is flattened to Rgb8 first.
fn encode_jpeg(img: &DynamicImage, dest: &Path, quality: u8) -> Result<()> {
    use image::codecs::jpeg::JpegEncoder;
    use std::fs::File;
    use std::io::BufWriter;

    let quality = quality.clamp(1, 100);
    let rgb = img.to_rgb8();
    let file = File::create(dest)?;
    let mut writer = BufWriter::new(file);
    let mut encoder = JpegEncoder::new_with_quality(&mut writer, quality);
    encoder
        .encode_image(&rgb)
        .map_err(|e| Error::Message(format!("jpeg encode failed: {e}")))?;
    Ok(())
}

/// Whether a path looks like a JPEG by extension.
fn is_jpeg_path(path: &Path) -> bool {
    super::extension_of(path)
        .map(|e| e == "jpg" || e == "jpeg")
        .unwrap_or(false)
}

/// Copy the EXIF segment from `source` JPEG onto the already-written `dest`
/// JPEG using the pure-Rust `img-parts` crate. Best-effort: any error is
/// returned so the caller can ignore it and keep the stripped output.
fn preserve_jpeg_exif(source: &Path, dest: &Path) -> Result<()> {
    use img_parts::jpeg::Jpeg;
    use img_parts::{Bytes, ImageEXIF};

    let src = Jpeg::from_bytes(Bytes::from(std::fs::read(source)?))
        .map_err(|e| Error::Message(format!("read source exif: {e}")))?;
    let exif = match src.exif() {
        Some(exif) => exif,
        None => return Ok(()), // source has no EXIF; nothing to carry over
    };
    // Pixels are already upright (`load_oriented`), so neutralize the copied
    // Orientation tag to avoid a viewer re-applying the rotation.
    let exif = Bytes::from(reset_exif_orientation(exif.to_vec()));

    let mut out = Jpeg::from_bytes(Bytes::from(std::fs::read(dest)?))
        .map_err(|e| Error::Message(format!("read dest jpeg: {e}")))?;
    out.set_exif(Some(exif));

    let file = std::fs::File::create(dest)?;
    let mut writer = std::io::BufWriter::new(file);
    out.encoder()
        .write_to(&mut writer)
        .map_err(|e| Error::Message(format!("write dest exif: {e}")))?;
    Ok(())
}

/// Set the EXIF Orientation tag (0x0112) to 1 (Normal) in a raw TIFF/EXIF blob,
/// since the exported pixels are already upright. Best-effort: if the structure
/// can't be parsed the bytes are returned unchanged (the caller accepts the
/// limitation rather than corrupting metadata). The blob starts with the TIFF
/// byte-order marker ("II"/"MM"), as returned by `img_parts`' `exif()`.
fn reset_exif_orientation(mut data: Vec<u8>) -> Vec<u8> {
    // Endianness from the byte-order marker.
    let le = match data.get(0..2) {
        Some(b"II") => true,
        Some(b"MM") => false,
        _ => return data,
    };
    let u16_at = |d: &[u8], i: usize| -> Option<u16> {
        let b = d.get(i..i + 2)?;
        Some(if le {
            u16::from_le_bytes([b[0], b[1]])
        } else {
            u16::from_be_bytes([b[0], b[1]])
        })
    };
    let u32_at = |d: &[u8], i: usize| -> Option<u32> {
        let b = d.get(i..i + 4)?;
        Some(if le {
            u32::from_le_bytes([b[0], b[1], b[2], b[3]])
        } else {
            u32::from_be_bytes([b[0], b[1], b[2], b[3]])
        })
    };

    // IFD0 offset lives at bytes 4..8 (after the "II 2A 00" / "MM 00 2A" header).
    let ifd_off = match u32_at(&data, 4) {
        Some(o) => o as usize,
        None => return data,
    };
    let count = match u16_at(&data, ifd_off) {
        Some(c) => c as usize,
        None => return data,
    };

    for n in 0..count {
        let entry = ifd_off + 2 + n * 12; // each IFD entry is 12 bytes
        match u16_at(&data, entry) {
            Some(0x0112) => {
                // SHORT value stored inline in the first 2 bytes of the value
                // field (entry + 8). Overwrite it with 1 (Normal).
                if let Some(slot) = data.get_mut(entry + 8..entry + 10) {
                    let one = if le { 1u16.to_le_bytes() } else { 1u16.to_be_bytes() };
                    slot.copy_from_slice(&one);
                }
                break;
            }
            Some(_) => continue,
            None => break,
        }
    }

    data
}
