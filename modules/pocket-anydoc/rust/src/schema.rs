use serde::{Deserialize, Serialize};

use crate::ABI_SCHEMA_VERSION;
use crate::error::{ApiError, CoreError};
use crate::limits::{
    EffectiveLimits, MAX_CHUNKS, MAX_IDENTIFIER_BYTES, MAX_INTERNAL_TEXT_CHARS, MAX_PATH_BYTES,
    MAX_REASON_BYTES, MAX_SELECT_CHARS, MAX_SELECT_CHUNKS, MAX_SOURCE_BYTES, MAX_WORK_UNITS,
};

fn default_schema_version() -> u32 {
    ABI_SCHEMA_VERSION
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PrepareRequest {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    pub request_id: String,
    #[serde(alias = "path")]
    pub source_path: String,
    #[serde(alias = "allowedRoot")]
    pub private_root: String,
    #[serde(default)]
    pub source_identity: Option<SourceIdentity>,
    #[serde(default)]
    pub source_size_bytes: Option<u64>,
    #[serde(default)]
    pub format_hint: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub declared_mime_type: Option<String>,
    #[serde(default)]
    pub limits: RequestedLimits,
    #[serde(default)]
    pub allow_lossy_spreadsheet_formatting: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(not(unix), allow(dead_code))]
pub(crate) struct SourceIdentity {
    pub device: u64,
    pub inode: u64,
    pub size: u64,
    pub modified_seconds: i64,
    #[serde(default)]
    pub modified_nanoseconds: Option<i64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RequestedLimits {
    pub max_source_bytes: Option<u64>,
    pub max_text_chars: Option<usize>,
    pub max_chunks: Option<usize>,
    pub max_work_units: Option<usize>,
}

impl PrepareRequest {
    pub(crate) fn validate(&self) -> Result<EffectiveLimits, CoreError> {
        validate_schema(self.schema_version)?;
        validate_identifier(&self.request_id)?;
        validate_path(&self.source_path)?;
        validate_path(&self.private_root)?;
        if self
            .display_name
            .as_ref()
            .is_some_and(|value| value.len() > 512)
            || self
                .declared_mime_type
                .as_ref()
                .is_some_and(|value| value.len() > 256)
        {
            return Err(CoreError::InvalidRequest("source metadata"));
        }
        Ok(EffectiveLimits {
            source_bytes: clamp_positive(self.limits.max_source_bytes, MAX_SOURCE_BYTES)?,
            text_chars: clamp_positive(self.limits.max_text_chars, MAX_INTERNAL_TEXT_CHARS)?,
            chunks: clamp_positive(self.limits.max_chunks, MAX_CHUNKS)?,
            work_units: clamp_positive(self.limits.max_work_units, MAX_WORK_UNITS)?,
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MaterializeRequest {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    pub request_id: String,
    pub handle: String,
    pub asset_id: usize,
    pub destination_path: String,
    pub private_root: String,
}

impl MaterializeRequest {
    pub(crate) fn validate(&self) -> Result<(), CoreError> {
        validate_schema(self.schema_version)?;
        validate_identifier(&self.request_id)?;
        validate_identifier(&self.handle)?;
        validate_path(&self.destination_path)?;
        validate_path(&self.private_root)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SelectRequest {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    pub request_id: String,
    pub handle: String,
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub max_chars: Option<usize>,
    #[serde(default)]
    pub max_chunks: Option<usize>,
    #[serde(default)]
    pub cursor: Option<String>,
}

impl SelectRequest {
    pub(crate) fn validate(&self) -> Result<(), CoreError> {
        validate_schema(self.schema_version)?;
        validate_identifier(&self.request_id)?;
        validate_identifier(&self.handle)?;
        if self.query.len() > crate::limits::MAX_QUERY_BYTES
            || self.query.encode_utf16().count() > crate::limits::MAX_QUERY_UTF16_UNITS
        {
            return Err(CoreError::ResourceLimit("max_query_bytes"));
        }
        if self.max_chars == Some(0) || self.max_chars.is_some_and(|v| v > MAX_SELECT_CHARS) {
            return Err(CoreError::InvalidRequest("maxChars"));
        }
        if self.max_chunks == Some(0) || self.max_chunks.is_some_and(|v| v > MAX_SELECT_CHUNKS) {
            return Err(CoreError::InvalidRequest("maxChunks"));
        }
        if let Some(cursor) = &self.cursor {
            validate_identifier(cursor)?;
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CancelRequest {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
}

impl CancelRequest {
    pub(crate) fn validate(&self) -> Result<(), CoreError> {
        validate_schema(self.schema_version)?;
        validate_reason(self.reason.as_deref())?;
        match (&self.request_id, self.scope.as_deref()) {
            (Some(id), None) => validate_identifier(id),
            (None, Some("all")) => Ok(()),
            _ => Err(CoreError::InvalidRequest("cancel target")),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReleaseRequest {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    #[serde(default)]
    pub handle: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
}

impl ReleaseRequest {
    pub(crate) fn validate(&self) -> Result<(), CoreError> {
        validate_schema(self.schema_version)?;
        validate_reason(self.reason.as_deref())?;
        match (&self.handle, self.scope.as_deref()) {
            (Some(handle), None) => validate_identifier(handle),
            (None, Some("all_cached")) => Ok(()),
            _ => Err(CoreError::InvalidRequest("release target")),
        }
    }
}

#[derive(Debug, Serialize)]
pub(crate) struct SuccessEnvelope<T: Serialize> {
    pub ok: bool,
    pub data: T,
}

#[derive(Debug, Serialize)]
pub(crate) struct ErrorEnvelope {
    pub ok: bool,
    pub error: ApiError,
}

pub(crate) fn success<T: Serialize>(data: T) -> SuccessEnvelope<T> {
    SuccessEnvelope { ok: true, data }
}

pub(crate) fn failure(error: &CoreError) -> ErrorEnvelope {
    ErrorEnvelope {
        ok: false,
        error: error.api_error(),
    }
}

fn validate_schema(version: u32) -> Result<(), CoreError> {
    if version == ABI_SCHEMA_VERSION {
        Ok(())
    } else {
        Err(CoreError::InvalidRequest("schemaVersion"))
    }
}

fn validate_identifier(value: &str) -> Result<(), CoreError> {
    if value.is_empty()
        || value.len() > MAX_IDENTIFIER_BYTES
        || value.chars().any(|c| c.is_control())
    {
        Err(CoreError::InvalidRequest("identifier"))
    } else {
        Ok(())
    }
}

fn validate_reason(reason: Option<&str>) -> Result<(), CoreError> {
    if reason.is_some_and(|value| value.len() > MAX_REASON_BYTES) {
        Err(CoreError::InvalidRequest("reason"))
    } else {
        Ok(())
    }
}

fn validate_path(value: &str) -> Result<(), CoreError> {
    if value.is_empty()
        || value.len() > MAX_PATH_BYTES
        || value
            .chars()
            .any(|character| character == '\0' || character.is_control())
    {
        Err(CoreError::InvalidRequest("path"))
    } else {
        Ok(())
    }
}

fn clamp_positive<T>(requested: Option<T>, maximum: T) -> Result<T, CoreError>
where
    T: Copy + Ord + From<u8>,
{
    match requested {
        Some(value) if value < T::from(1) => Err(CoreError::InvalidRequest("limit")),
        Some(value) => Ok(value.min(maximum)),
        None => Ok(maximum),
    }
}
