use std::fs::{self, File, OpenOptions};
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use crate::hash::sha256_hex;
use anydoc::Format;

use crate::error::CoreError;
use crate::limits::EffectiveLimits;
use crate::schema::{PrepareRequest, SourceIdentity};
use crate::xlsx::XlsxProjection;

const READ_BLOCK_BYTES: usize = 64 * 1024;

pub(crate) struct PreparedSource {
    pub bytes: Vec<u8>,
    pub sha256: String,
    pub format: Format,
    pub canonical_format: String,
    pub semantic_warning: bool,
    pub format_hint_mismatch: bool,
    pub xlsx_projection: Option<XlsxProjection>,
}

pub(crate) fn read_and_validate(
    request: &PrepareRequest,
    limits: EffectiveLimits,
    cancelled: &AtomicBool,
) -> Result<PreparedSource, CoreError> {
    checkpoint(cancelled)?;
    let raw_source = PathBuf::from(&request.source_path);
    let raw_root = PathBuf::from(&request.private_root);
    if raw_source.as_os_str().is_empty() || raw_root.as_os_str().is_empty() {
        return Err(CoreError::InvalidRequest("source path"));
    }
    if fs::symlink_metadata(&raw_source)
        .map_err(|_| CoreError::SourceUnavailable)?
        .file_type()
        .is_symlink()
    {
        return Err(CoreError::SymlinkRejected);
    }

    let root = fs::canonicalize(&raw_root).map_err(|_| CoreError::SourceUnavailable)?;
    if !fs::metadata(&root)
        .map_err(|_| CoreError::SourceUnavailable)?
        .is_dir()
    {
        return Err(CoreError::InvalidRequest("private root"));
    }
    let source = fs::canonicalize(&raw_source).map_err(|_| CoreError::SourceUnavailable)?;
    if source == root || !source.starts_with(&root) {
        return Err(CoreError::OutsidePrivateRoot);
    }

    let mut file = secure_open(&source)?;
    let before = file.metadata().map_err(|_| CoreError::SourceUnavailable)?;
    if !before.is_file() {
        return Err(CoreError::InvalidRequest("source is not a file"));
    }
    if before.len() == 0 {
        return Err(CoreError::NoExtractableText);
    }
    if before.len() > limits.source_bytes {
        return Err(CoreError::ResourceLimit("max_source_bytes"));
    }
    if request
        .source_size_bytes
        .is_some_and(|declared| declared != before.len())
    {
        return Err(CoreError::SourceChanged);
    }
    verify_declared_identity(request.source_identity.as_ref(), &before)?;

    let capacity =
        usize::try_from(before.len()).map_err(|_| CoreError::ResourceLimit("max_source_bytes"))?;
    let mut bytes = Vec::with_capacity(capacity);
    let mut block = [0_u8; READ_BLOCK_BYTES];
    loop {
        checkpoint(cancelled)?;
        let read = file
            .read(&mut block)
            .map_err(|_| CoreError::SourceUnavailable)?;
        if read == 0 {
            break;
        }
        if bytes.len().saturating_add(read) as u64 > limits.source_bytes {
            return Err(CoreError::ResourceLimit("max_source_bytes"));
        }
        bytes.extend_from_slice(&block[..read]);
    }
    let after_handle = file.metadata().map_err(|_| CoreError::SourceChanged)?;
    let after_path = fs::metadata(&source).map_err(|_| CoreError::SourceChanged)?;
    if before.len() != after_handle.len()
        || before.len() != after_path.len()
        || modified(&before) != modified(&after_handle)
        || modified(&before) != modified(&after_path)
        || !same_file(&before, &after_handle)
        || !same_file(&before, &after_path)
    {
        return Err(CoreError::SourceChanged);
    }
    checkpoint(cancelled)?;

    let (format, canonical_format, format_hint_mismatch) =
        resolve_format(request, &source, &bytes)?;
    if bytes.len() as u64 > format_source_limit(format) {
        return Err(CoreError::ResourceLimit("max_format_source_bytes"));
    }
    let (semantic_warning, xlsx_projection) = spreadsheet_semantics(
        &bytes,
        format,
        &canonical_format,
        request.allow_lossy_spreadsheet_formatting,
        cancelled,
        limits.work_units,
    )?;
    let sha256 = sha256_hex(&bytes);
    Ok(PreparedSource {
        bytes,
        sha256,
        format,
        canonical_format,
        semantic_warning,
        format_hint_mismatch,
        xlsx_projection,
    })
}

fn secure_open(path: &Path) -> Result<File, CoreError> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_FLAG_OPEN_REPARSE_POINT prevents a last-moment final-component
        // reparse from silently redirecting the file handle.
        options.custom_flags(0x0020_0000);
    }
    options.open(path).map_err(|_| CoreError::SourceUnavailable)
}

fn modified(metadata: &fs::Metadata) -> Option<std::time::SystemTime> {
    metadata.modified().ok()
}

#[cfg(unix)]
fn verify_declared_identity(
    declared: Option<&SourceIdentity>,
    metadata: &fs::Metadata,
) -> Result<(), CoreError> {
    use std::os::unix::fs::MetadataExt;
    let Some(declared) = declared else {
        return Ok(());
    };
    if declared.device != metadata.dev()
        || declared.inode != metadata.ino()
        || declared.size != metadata.size()
        || declared.modified_seconds != metadata.mtime()
        || declared
            .modified_nanoseconds
            .is_some_and(|value| value != metadata.mtime_nsec())
    {
        Err(CoreError::SourceChanged)
    } else {
        Ok(())
    }
}

#[cfg(not(unix))]
fn verify_declared_identity(
    declared: Option<&SourceIdentity>,
    metadata: &fs::Metadata,
) -> Result<(), CoreError> {
    if declared.is_some_and(|value| value.size != metadata.len()) {
        Err(CoreError::SourceChanged)
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn same_file(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    left.dev() == right.dev() && left.ino() == right.ino()
}

#[cfg(windows)]
fn same_file(_left: &fs::Metadata, _right: &fs::Metadata) -> bool {
    // Android and iOS expose stable dev+inode and are verified above. Stable
    // Windows file IDs require an unsafe handle query; host tests retain the
    // already-open handle and compare size/mtime/path hash without expanding
    // the unsafe surface beyond ffi.rs.
    true
}

#[cfg(not(any(unix, windows)))]
fn same_file(_left: &fs::Metadata, _right: &fs::Metadata) -> bool {
    true
}

pub(crate) fn checkpoint(cancelled: &AtomicBool) -> Result<(), CoreError> {
    if cancelled.load(Ordering::Acquire) {
        Err(CoreError::Cancelled)
    } else {
        crate::runtime::checkpoint()
    }
}

fn resolve_format(
    request: &PrepareRequest,
    source: &Path,
    bytes: &[u8],
) -> Result<(Format, String, bool), CoreError> {
    let hint = request
        .format_hint
        .as_deref()
        .and_then(normalize_extension)
        .or_else(|| {
            request
                .display_name
                .as_deref()
                .and_then(extension_from_name)
        })
        .or_else(|| {
            source
                .extension()
                .and_then(|value| value.to_str())
                .and_then(normalize_extension)
        });
    let hinted_format = hint.as_deref().and_then(Format::from_extension);
    let detected = Format::from_bytes(bytes);
    if detected.is_none()
        && matches!(
            hinted_format,
            Some(Format::Docx | Format::Pptx | Format::Excel)
        )
        && anydoc::is_encrypted_ooxml_container(bytes)
    {
        return Err(CoreError::Encrypted);
    }
    match (detected, hinted_format) {
        // `Format::Excel` deliberately groups four parsers, but choosing the
        // wrong member changes both display-semantics reconstruction and the
        // calamine backend. Resolve this variant from the actual container.
        (Some(Format::Excel), hinted) => {
            let canonical = excel_container_variant(bytes).unwrap_or("xlsx");
            let mismatch = match (hint.as_deref(), hinted) {
                (Some(value), Some(Format::Excel)) => value != canonical,
                (Some(_), Some(_)) => true,
                _ => false,
            };
            Ok((Format::Excel, canonical.to_string(), mismatch))
        }
        // A strong signature/package result is authoritative. File-provider
        // display names and declared MIME-derived hints are untrusted hints;
        // keep the canonical detected format and surface the mismatch instead
        // of rejecting valid local content.
        (Some(format), Some(hinted)) if format != hinted => {
            Ok((format, format_name(format).to_string(), true))
        }
        (Some(format), _) => {
            let canonical = hint
                .as_ref()
                .filter(|_| hinted_format == Some(format))
                .cloned()
                .unwrap_or_else(|| format_name(format).to_string());
            Ok((format, canonical, false))
        }
        // CSV has no reliable magic. It is the only format allowed to rely on
        // an extension hint, and only after a strict bounded-text preflight.
        (None, Some(Format::Csv)) if looks_like_csv_text(bytes) => Ok((
            Format::Csv,
            hint.unwrap_or_else(|| "csv".to_string()),
            false,
        )),
        // Every other supported format has a signature or package structure.
        // A matching name alone must not route arbitrary bytes into a parser.
        (None, Some(_)) => Err(CoreError::Malformed),
        (None, None) => Err(CoreError::UnsupportedFormat),
    }
}

fn excel_container_variant(bytes: &[u8]) -> Option<&'static str> {
    const OLE_MAGIC: [u8; 8] = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
    const MAX_ARCHIVE_ENTRIES: usize = 4_096;
    const MAX_CONTENT_TYPES_BYTES: u64 = 64 * 1024;

    if bytes.starts_with(&OLE_MAGIC) {
        return Some("xls");
    }
    if !bytes.starts_with(b"PK\x03\x04") {
        return None;
    }

    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).ok()?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return None;
    }
    let mut workbook_xml = false;
    let mut workbook_bin = false;
    let mut vba_project = false;
    for index in 0..archive.len() {
        let name = archive
            .by_index(index)
            .ok()?
            .name()
            .replace('\\', "/")
            .to_ascii_lowercase();
        match name.as_str() {
            "xl/workbook.xml" => workbook_xml = true,
            "xl/workbook.bin" => workbook_bin = true,
            "xl/vbaproject.bin" => vba_project = true,
            _ => {}
        }
    }
    if workbook_bin {
        return Some("xlsb");
    }
    if !workbook_xml {
        return None;
    }

    let macro_content_type = archive
        .by_name("[Content_Types].xml")
        .ok()
        .and_then(|file| {
            if file.size() > MAX_CONTENT_TYPES_BYTES {
                return None;
            }
            let mut bytes = Vec::with_capacity(file.size() as usize);
            file.take(MAX_CONTENT_TYPES_BYTES + 1)
                .read_to_end(&mut bytes)
                .ok()?;
            (bytes.len() as u64 <= MAX_CONTENT_TYPES_BYTES).then_some(bytes)
        })
        .is_some_and(|types| {
            String::from_utf8_lossy(&types)
                .to_ascii_lowercase()
                .contains("macroenabled")
        });
    Some(if vba_project || macro_content_type {
        "xlsm"
    } else {
        "xlsx"
    })
}

fn looks_like_csv_text(bytes: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return false;
    };
    !text.is_empty()
        && !text.chars().any(|character| {
            character == '\0'
                || (character.is_control() && !matches!(character, '\r' | '\n' | '\t'))
        })
        && text.contains(['\n', '\r'])
        && text.contains([',', ';', '\t'])
}

fn extension_from_name(name: &str) -> Option<String> {
    Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .and_then(normalize_extension)
}

fn normalize_extension(value: &str) -> Option<String> {
    let extension = value.trim().trim_start_matches('.').to_ascii_lowercase();
    Format::from_extension(&extension).map(|_| extension)
}

pub(crate) fn format_name(format: Format) -> &'static str {
    match format {
        Format::Doc => "doc",
        Format::Docx => "docx",
        Format::Odt => "odt",
        Format::Pdf => "pdf",
        Format::Ppt => "ppt",
        Format::Pptx => "pptx",
        Format::Rtf => "rtf",
        Format::Epub => "epub",
        Format::Excel => "xlsx",
        Format::Ods => "ods",
        Format::Odp => "odp",
        Format::Csv => "csv",
    }
}

fn spreadsheet_semantics(
    bytes: &[u8],
    format: Format,
    canonical_format: &str,
    allow_lossy: bool,
    cancelled: &AtomicBool,
    max_work_units: usize,
) -> Result<(bool, Option<XlsxProjection>), CoreError> {
    if format == Format::Ods {
        // Calamine preserves the producer-rendered ODS strings, including
        // locale separators, but does not expose row/column visibility or a
        // provable numeric-style reconstruction contract to this layer.
        return Ok((true, None));
    }
    if format != Format::Excel {
        return Ok((false, None));
    }
    match canonical_format {
        "xlsx" | "xlsm" => {
            let projection = crate::xlsx::project(bytes, allow_lossy, cancelled, max_work_units)?;
            let warning = projection.lossy_fallback_used;
            Ok((warning, Some(projection)))
        }
        // The vendored calamine patch preserves common binary workbook
        // display styles and emits a fail-closed sentinel for unsupported
        // used numeric formats. Row/column visibility is not exposed by its
        // binary readers, so callers receive explicit partial-content metadata.
        "xls" | "xlsb" => Ok((true, None)),
        _ => Err(CoreError::SpreadsheetSemantics),
    }
}

pub(crate) fn format_source_limit(format: Format) -> u64 {
    match format {
        Format::Csv => 2 * 1024 * 1024,
        Format::Pdf => 8 * 1024 * 1024,
        Format::Rtf | Format::Epub => 8 * 1024 * 1024,
        Format::Doc | Format::Docx | Format::Odt => 12 * 1024 * 1024,
        Format::Ppt | Format::Pptx | Format::Odp => 12 * 1024 * 1024,
        Format::Excel | Format::Ods => 12 * 1024 * 1024,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    #[test]
    fn sha256_is_stable() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn format_limits_are_narrower_than_the_outer_source_cap() {
        assert_eq!(format_source_limit(Format::Csv), 2 * 1024 * 1024);
        assert_eq!(format_source_limit(Format::Pdf), 8 * 1024 * 1024);
        assert!(format_source_limit(Format::Docx) < crate::limits::MAX_SOURCE_BYTES);
    }

    fn request(display_name: &str) -> PrepareRequest {
        serde_json::from_value(serde_json::json!({
            "schemaVersion": 1,
            "requestId": "format-test",
            "sourcePath": "C:/private/source",
            "privateRoot": "C:/private",
            "displayName": display_name,
        }))
        .unwrap()
    }

    #[test]
    fn strong_content_detection_wins_over_wrong_extension_hint() {
        let bytes = fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("fixtures/pocket-ai/office/multilingual.docx"),
        )
        .unwrap();
        let (format, canonical, mismatch) = resolve_format(
            &request("provider-renamed.pdf"),
            Path::new("C:/private/provider-renamed.pdf"),
            &bytes,
        )
        .unwrap();
        assert_eq!(format, Format::Docx);
        assert_eq!(canonical, "docx");
        assert!(mismatch);
    }

    #[test]
    fn excel_container_variant_wins_over_same_family_hint() {
        for (fixture, misleading_name, expected) in [
            ("multilingual.xlsx", "provider.xlsb", "xlsx"),
            ("multilingual.xlsm", "provider.xlsx", "xlsm"),
            ("multilingual.xlsb", "provider.xlsx", "xlsb"),
            ("multilingual.xls", "provider.xlsx", "xls"),
        ] {
            let bytes = fs::read(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("fixtures/pocket-ai/office")
                    .join(fixture),
            )
            .unwrap();
            let (format, canonical, mismatch) = resolve_format(
                &request(misleading_name),
                Path::new("C:/private/provider-workbook"),
                &bytes,
            )
            .unwrap_or_else(|error| panic!("{fixture}: {error:?}"));
            assert_eq!(format, Format::Excel, "{fixture}");
            assert_eq!(canonical, expected, "{fixture}");
            assert!(mismatch, "{fixture}");
        }
    }

    #[test]
    fn encrypted_ooxml_ole_reaches_stable_encrypted_error() {
        let mut compound = cfb::CompoundFile::create(Cursor::new(Vec::new())).unwrap();
        compound
            .create_stream("EncryptionInfo")
            .unwrap()
            .write_all(b"bounded-test")
            .unwrap();
        compound
            .create_stream("EncryptedPackage")
            .unwrap()
            .write_all(b"opaque")
            .unwrap();
        let bytes = compound.into_inner().into_inner();

        for name in ["protected.docx", "protected.xlsx", "protected.pptx"] {
            assert!(matches!(
                resolve_format(
                    &request(name),
                    Path::new("C:/private/protected-container"),
                    &bytes,
                ),
                Err(CoreError::Encrypted)
            ));
        }
        assert!(matches!(
            resolve_format(
                &request("mislabelled.pdf"),
                Path::new("C:/private/mislabelled.pdf"),
                &bytes,
            ),
            Err(CoreError::Malformed)
        ));
    }

    #[test]
    fn names_do_not_route_random_or_malformed_bytes_into_signature_parsers() {
        assert!(matches!(
            resolve_format(
                &request("random.docx"),
                Path::new("C:/private/random.docx"),
                b"not an office document",
            ),
            Err(CoreError::Malformed)
        ));
        assert!(matches!(
            resolve_format(
                &request("broken.docx"),
                Path::new("C:/private/broken.docx"),
                b"PK\x03\x04broken package",
            ),
            Err(CoreError::Malformed)
        ));
    }

    #[test]
    fn csv_hint_requires_bounded_delimited_utf8_text() {
        assert!(
            resolve_format(
                &request("valid.csv"),
                Path::new("C:/private/valid.csv"),
                b"name,value\nalpha,1\n",
            )
            .is_ok()
        );
        assert!(matches!(
            resolve_format(
                &request("binary.csv"),
                Path::new("C:/private/binary.csv"),
                b"\0\xFF\x00",
            ),
            Err(CoreError::Malformed)
        ));
    }

    #[test]
    fn declared_source_identity_mismatch_is_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("identity.csv");
        fs::write(&source, b"name,value\nalpha,1\n").unwrap();
        let metadata = fs::metadata(&source).unwrap();
        let declared: SourceIdentity = serde_json::from_value(serde_json::json!({
            "device": 0,
            "inode": 0,
            "size": metadata.len() + 1,
            "modifiedSeconds": 0,
        }))
        .unwrap();
        assert!(matches!(
            verify_declared_identity(Some(&declared), &metadata),
            Err(CoreError::SourceChanged)
        ));
    }
}
