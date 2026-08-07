//! Safe, bounded materialization of one already-validated embedded raster.
//! Paths and bytes never enter a response envelope.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::AtomicBool;

#[cfg(unix)]
use std::fs::File;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

use serde::Serialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::chunk::{CachedAssetPayload, validate_asset};
use crate::error::CoreError;
use crate::limits::MAX_ASSET_BYTES;
use crate::preflight::checkpoint;
use crate::schema::MaterializeRequest;

const WRITE_BLOCK_BYTES: usize = 64 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MaterializedAssetData {
    pub handle: String,
    pub asset_id: usize,
    pub media_type: String,
    pub byte_length: usize,
    pub sha256: String,
    pub width: u32,
    pub height: u32,
}

pub(crate) struct MaterializedAsset {
    pub data: MaterializedAssetData,
    pub destination: PathBuf,
}

pub(crate) fn write_asset(
    request: &MaterializeRequest,
    payload: &CachedAssetPayload,
    cancelled: &AtomicBool,
) -> Result<MaterializedAsset, CoreError> {
    checkpoint(cancelled)?;
    let (width, height) =
        validate_asset(&payload.media_type, &payload.bytes).ok_or(CoreError::Internal)?;
    if payload.bytes.len() > MAX_ASSET_BYTES || width != payload.width || height != payload.height {
        return Err(CoreError::Internal);
    }
    let sha256 = format!("{:x}", Sha256::digest(&payload.bytes));
    if sha256 != payload.sha256 {
        return Err(CoreError::Internal);
    }
    let expected_extension =
        extension_for_media_type(&payload.media_type).ok_or(CoreError::Internal)?;
    let destination = validate_destination(
        Path::new(&request.destination_path),
        Path::new(&request.private_root),
        expected_extension,
    )?;
    checkpoint(cancelled)?;

    let parent = destination
        .parent()
        .ok_or(CoreError::InvalidRequest("destination parent"))?;
    let temporary = parent.join(format!(".pocket-anydoc-{}.tmp", Uuid::new_v4().simple()));
    let mut pending = PendingOutput::new(temporary, destination.clone());
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options
        .open(&pending.temporary)
        .map_err(|_| CoreError::ConversionFailed)?;

    for block in payload.bytes.chunks(WRITE_BLOCK_BYTES) {
        checkpoint(cancelled)?;
        file.write_all(block)
            .map_err(|_| CoreError::ConversionFailed)?;
    }
    file.flush().map_err(|_| CoreError::ConversionFailed)?;
    file.sync_all().map_err(|_| CoreError::ConversionFailed)?;
    drop(file);
    checkpoint(cancelled)?;

    match fs::hard_link(&pending.temporary, &pending.destination) {
        Ok(()) => pending.published = true,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            return Err(CoreError::InvalidRequest("destination exists"));
        }
        Err(_) => return Err(CoreError::ConversionFailed),
    }
    checkpoint(cancelled)?;
    fs::remove_file(&pending.temporary).map_err(|_| CoreError::ConversionFailed)?;
    pending.temporary_exists = false;
    sync_parent(parent)?;
    checkpoint(cancelled)?;
    pending.committed = true;

    Ok(MaterializedAsset {
        data: MaterializedAssetData {
            handle: request.handle.clone(),
            asset_id: payload.id,
            media_type: payload.media_type.clone(),
            byte_length: payload.bytes.len(),
            sha256,
            width,
            height,
        },
        destination,
    })
}

fn validate_destination(
    requested: &Path,
    requested_root: &Path,
    expected_extension: &str,
) -> Result<PathBuf, CoreError> {
    if !requested.is_absolute() || !requested_root.is_absolute() {
        return Err(CoreError::InvalidRequest("absolute destination"));
    }
    if requested
        .components()
        .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
    {
        return Err(CoreError::InvalidRequest("destination traversal"));
    }
    let root = fs::canonicalize(requested_root).map_err(|_| CoreError::SourceUnavailable)?;
    if !fs::metadata(&root)
        .map_err(|_| CoreError::SourceUnavailable)?
        .is_dir()
    {
        return Err(CoreError::InvalidRequest("private root"));
    }
    let requested_parent = requested
        .parent()
        .ok_or(CoreError::InvalidRequest("destination parent"))?;
    let parent = fs::canonicalize(requested_parent).map_err(|_| CoreError::SourceUnavailable)?;
    if !parent.starts_with(&root) {
        return Err(CoreError::OutsidePrivateRoot);
    }
    let file_name = requested
        .file_name()
        .filter(|name| !name.is_empty())
        .ok_or(CoreError::InvalidRequest("destination file"))?;
    let destination = parent.join(file_name);
    if destination.extension().and_then(|value| value.to_str()) != Some(expected_extension) {
        return Err(CoreError::InvalidRequest("asset extension"));
    }
    match fs::symlink_metadata(&destination) {
        Ok(_) => Err(CoreError::InvalidRequest("destination exists")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(destination),
        Err(_) => Err(CoreError::ConversionFailed),
    }
}

fn extension_for_media_type(media_type: &str) -> Option<&'static str> {
    match media_type {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        _ => None,
    }
}

#[cfg(unix)]
fn sync_parent(parent: &Path) -> Result<(), CoreError> {
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| CoreError::ConversionFailed)
}

#[cfg(not(unix))]
fn sync_parent(_parent: &Path) -> Result<(), CoreError> {
    Ok(())
}

pub(crate) fn cleanup_file(path: &Path) -> Result<bool, CoreError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(CoreError::ConversionFailed),
    }
}

struct PendingOutput {
    temporary: PathBuf,
    destination: PathBuf,
    temporary_exists: bool,
    published: bool,
    committed: bool,
}

impl PendingOutput {
    fn new(temporary: PathBuf, destination: PathBuf) -> Self {
        Self {
            temporary,
            destination,
            temporary_exists: true,
            published: false,
            committed: false,
        }
    }
}

impl Drop for PendingOutput {
    fn drop(&mut self) {
        if self.temporary_exists {
            let _ = fs::remove_file(&self.temporary);
        }
        if self.published && !self.committed {
            let _ = fs::remove_file(&self.destination);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    fn png() -> Vec<u8> {
        let mut bytes = vec![0_u8; 33];
        bytes[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        bytes[8..12].copy_from_slice(&13_u32.to_be_bytes());
        bytes[12..16].copy_from_slice(b"IHDR");
        bytes[16..20].copy_from_slice(&2_u32.to_be_bytes());
        bytes[20..24].copy_from_slice(&3_u32.to_be_bytes());
        bytes[24..29].copy_from_slice(&[8, 6, 0, 0, 0]);
        bytes
    }

    #[test]
    fn atomically_writes_exact_validated_bytes_without_path_in_data() {
        let root = tempfile::tempdir().unwrap();
        let destination = root.path().join("asset.png");
        let bytes = png();
        let sha256 = format!("{:x}", Sha256::digest(&bytes));
        let payload = CachedAssetPayload {
            id: 7,
            media_type: "image/png".to_string(),
            bytes: bytes.clone(),
            sha256,
            width: 2,
            height: 3,
        };
        let request = MaterializeRequest {
            schema_version: 1,
            request_id: "materialize-1".to_string(),
            handle: "doc:1".to_string(),
            asset_id: 7,
            destination_path: destination.to_string_lossy().into_owned(),
            private_root: root.path().to_string_lossy().into_owned(),
        };
        let result = write_asset(&request, &payload, &AtomicBool::new(false)).unwrap();
        assert_eq!(fs::read(&result.destination).unwrap(), bytes);
        let response = serde_json::to_value(&result.data).unwrap();
        assert!(response.get("destinationPath").is_none());
        assert_eq!(response["assetId"], 7);
    }

    #[test]
    fn rejects_existing_destination_without_overwrite() {
        let root = tempfile::tempdir().unwrap();
        let output = root.path().join("derived");
        fs::create_dir(&output).unwrap();
        let destination = output.join("asset.png");
        fs::write(&destination, b"owned").unwrap();
        let bytes = png();
        let payload = CachedAssetPayload {
            id: 1,
            media_type: "image/png".to_string(),
            sha256: format!("{:x}", Sha256::digest(&bytes)),
            bytes,
            width: 2,
            height: 3,
        };
        let request = MaterializeRequest {
            schema_version: 1,
            request_id: "materialize-2".to_string(),
            handle: "doc:1".to_string(),
            asset_id: 1,
            destination_path: destination.to_string_lossy().into_owned(),
            private_root: root.path().to_string_lossy().into_owned(),
        };
        assert!(matches!(
            write_asset(&request, &payload, &AtomicBool::new(false)),
            Err(CoreError::InvalidRequest(_))
        ));
        assert_eq!(fs::read(destination).unwrap(), b"owned");
    }
}
