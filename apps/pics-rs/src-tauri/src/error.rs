use serde::Serialize;

/// Stable sentinel prefix marking an iCloud "dataless" placeholder error — a
/// file whose contents have been evicted from local disk by "Optimize Mac
/// Storage". Reading such a file blocks while macOS downloads it from iCloud
/// (observed at 60–75 s in the field), so the gallery refuses to auto-trigger
/// that and returns this instead. The frontend matches on this prefix to show a
/// distinct "in iCloud, not downloaded" tile state (see
/// `src/hooks/useThumbnail.ts` / `src/components/GalleryTile.tsx`).
pub const DATALESS_SENTINEL: &str = "E_DATALESS";

/// Errors surfaced to the frontend from Tauri commands. Serializes to a string
/// so the TypeScript side receives a plain message it can show to the user.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("image error: {0}")]
    Image(#[from] image::ImageError),

    /// The source is an iCloud placeholder that isn't downloaded to this Mac.
    /// Message starts with [`DATALESS_SENTINEL`] so the UI can special-case it.
    #[error("{sentinel}: file contents are not downloaded from iCloud", sentinel = DATALESS_SENTINEL)]
    Dataless,

    #[error("{0}")]
    Message(String),
}

impl Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;
