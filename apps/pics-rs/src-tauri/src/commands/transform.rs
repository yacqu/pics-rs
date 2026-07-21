//! Non-destructive edit model (spec §4.9, §6 "Edit model").
//!
//! The frontend keeps an ordered stack of [`Transform`] operations and only
//! rasterizes on export/save. This module mirrors the TypeScript discriminated
//! union in `src/types/image.ts` (`serde(tag = "kind")`) and folds a stack onto
//! a decoded [`DynamicImage`] in order.

use image::imageops::FilterType;
use image::{DynamicImage, Rgba};
use imageproc::geometric_transformations::{rotate_about_center, Interpolation};

/// A single non-destructive transform. Deserialized from the frontend's
/// `Transform` union — the `kind` tag and camelCase fields must stay in lockstep
/// with `src/types/image.ts`.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Transform {
    /// Multiples of 90 (±90, 180). Non-multiples are ignored here — arbitrary
    /// angles are handled by [`Transform::Straighten`].
    Rotate { degrees: f64 },
    /// Mirror across the horizontal or vertical axis.
    Flip { axis: FlipAxis },
    /// Rectangle in the coordinate space of the image AFTER all prior
    /// transforms in the stack (pixels).
    Crop {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    },
    /// Resample to exact pixel dimensions (Lanczos3, spec §4.4).
    Resize { width: u32, height: u32 },
    /// Arbitrary-angle rotation for horizon correction (-45..45, spec §4.5).
    Straighten { angle: f64 },
}

#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FlipAxis {
    Horizontal,
    Vertical,
}

/// Fold an edit stack onto a decoded image, applying each op IN ORDER. Because
/// crop coordinates are expressed in the space produced by prior transforms,
/// order is significant and must not be reordered.
pub fn apply_transforms(img: DynamicImage, transforms: &[Transform]) -> DynamicImage {
    transforms.iter().fold(img, apply_one)
}

fn apply_one(img: DynamicImage, t: &Transform) -> DynamicImage {
    match t {
        Transform::Rotate { degrees } => {
            // Normalize to one of 0/90/180/270 (handles negatives, e.g. -90 ->
            // 270). Non-multiples of 90 are a no-op here (spec §4.5).
            let d = degrees.round() as i64;
            match ((d % 360) + 360) % 360 {
                90 => img.rotate90(),
                180 => img.rotate180(),
                270 => img.rotate270(),
                _ => img,
            }
        }
        Transform::Flip { axis } => match axis {
            FlipAxis::Horizontal => img.fliph(),
            FlipAxis::Vertical => img.flipv(),
        },
        Transform::Crop {
            x,
            y,
            width,
            height,
        } => {
            let (iw, ih) = (img.width(), img.height());
            if iw == 0 || ih == 0 {
                return img;
            }
            // Clamp origin inside the image, then clamp the extent to what
            // remains; guard against zero/negative/out-of-bounds rectangles.
            let cx = (x.max(0.0).round() as u32).min(iw - 1);
            let cy = (y.max(0.0).round() as u32).min(ih - 1);
            let cw = (width.max(0.0).round() as u32).min(iw - cx).max(1);
            let ch = (height.max(0.0).round() as u32).min(ih - cy).max(1);
            img.crop_imm(cx, cy, cw, ch)
        }
        Transform::Resize { width, height } => {
            // spec §4.4 mandates Lanczos3 as the single non-user-facing default.
            let w = (*width).max(1);
            let h = (*height).max(1);
            img.resize_exact(w, h, FilterType::Lanczos3)
        }
        Transform::Straighten { angle } => {
            // Arbitrary-angle rotation about the center with bilinear
            // interpolation, exposed corners filled transparent. The canvas
            // stays the same size — crop-to-fit / auto-expand is a follow-up
            // (spec §4.5); same-size canvas is acceptable for v1.
            let rgba = img.to_rgba8();
            let theta = (*angle as f32).to_radians();
            let rotated = rotate_about_center(
                &rgba,
                theta,
                Interpolation::Bilinear,
                Rgba([0, 0, 0, 0]),
            );
            DynamicImage::ImageRgba8(rotated)
        }
    }
}
