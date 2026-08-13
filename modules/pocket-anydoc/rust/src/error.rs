use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub(crate) enum CoreError {
    #[error("invalid request")]
    InvalidRequest(&'static str),
    #[error("unsupported format")]
    UnsupportedFormat,
    #[error("source is unavailable")]
    SourceUnavailable,
    #[error("source is outside private storage")]
    OutsidePrivateRoot,
    #[error("symbolic links are not accepted")]
    SymlinkRejected,
    #[error("source changed while being prepared")]
    SourceChanged,
    #[error("resource limit exceeded")]
    ResourceLimit(&'static str),
    #[error("request cancelled")]
    Cancelled,
    #[error("request id is already active")]
    DuplicateRequest,
    #[error("document handle is unavailable")]
    HandleNotFound,
    #[error("spreadsheet display semantics are unsupported")]
    SpreadsheetSemantics,
    #[error("document is encrypted")]
    Encrypted,
    #[error("document is malformed")]
    Malformed,
    #[error("document conversion failed")]
    ConversionFailed,
    #[error("document contains no extractable text")]
    NoExtractableText,
    #[error("internal error")]
    Internal,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApiError {
    pub code: &'static str,
    pub message: &'static str,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<&'static str>,
}

impl CoreError {
    pub(crate) fn api_error(&self) -> ApiError {
        match self {
            Self::InvalidRequest(_) => {
                ApiError::new("invalid_request", "The native request is invalid", false)
            }
            Self::UnsupportedFormat => ApiError::new(
                "unsupported_format",
                "This document format is not supported",
                false,
            ),
            Self::SourceUnavailable => ApiError::new(
                "native_failed",
                "The private source file is unavailable",
                true,
            ),
            Self::OutsidePrivateRoot => ApiError::new(
                "invalid_request",
                "The source is outside private app storage",
                false,
            ),
            Self::SymlinkRejected => ApiError::new(
                "invalid_request",
                "Symbolic-link sources are not accepted",
                false,
            ),
            Self::SourceChanged => ApiError::new(
                "native_failed",
                "The source changed while it was being prepared",
                true,
            ),
            Self::ResourceLimit(limit @ ("max_source_bytes" | "max_format_source_bytes")) => {
                ApiError {
                    code: "document_too_large",
                    message: "The document exceeds the local size limit",
                    retryable: false,
                    limit: Some(limit),
                }
            }
            Self::ResourceLimit(limit) => ApiError {
                code: "resource_limit",
                message: "The document exceeds a mobile safety limit",
                retryable: false,
                limit: Some(limit),
            },
            Self::Cancelled => ApiError::new("cancelled", "The request was cancelled", false),
            Self::DuplicateRequest => ApiError::new(
                "duplicate_request",
                "The request id is already active",
                true,
            ),
            Self::HandleNotFound => {
                ApiError::new("invalid_request", "The document handle has expired", true)
            }
            Self::SpreadsheetSemantics => ApiError::new(
                "semantic_spreadsheet",
                "Spreadsheet display formatting cannot be preserved safely",
                false,
            ),
            Self::Encrypted => ApiError::new(
                "encrypted_document",
                "Encrypted documents are not supported",
                false,
            ),
            Self::Malformed => {
                ApiError::new("corrupt_document", "The document is malformed", false)
            }
            Self::ConversionFailed => {
                ApiError::new("native_failed", "The document could not be converted", true)
            }
            Self::NoExtractableText => ApiError::new(
                "no_extractable_text",
                "The document has no extractable text",
                false,
            ),
            Self::Internal => {
                ApiError::new("native_failed", "The document engine failed safely", true)
            }
        }
    }
}

impl ApiError {
    fn new(code: &'static str, message: &'static str, retryable: bool) -> Self {
        Self {
            code,
            message,
            retryable,
            limit: None,
        }
    }
}

impl From<anydoc::ConvertError> for CoreError {
    fn from(value: anydoc::ConvertError) -> Self {
        match value {
            anydoc::ConvertError::Unsupported(_) => Self::UnsupportedFormat,
            anydoc::ConvertError::Malformed { .. } | anydoc::ConvertError::MissingPart { .. } => {
                Self::Malformed
            }
            anydoc::ConvertError::Encrypted => Self::Encrypted,
            anydoc::ConvertError::ResourceLimit {
                limit: "cancelled", ..
            } => Self::Cancelled,
            anydoc::ConvertError::ResourceLimit {
                limit: "unsupported_spreadsheet_format",
                ..
            } => Self::SpreadsheetSemantics,
            anydoc::ConvertError::ResourceLimit { limit, .. } => Self::ResourceLimit(limit),
            anydoc::ConvertError::Io(_) => Self::ConversionFailed,
            _ => Self::ConversionFailed,
        }
    }
}
