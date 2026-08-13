//! Hard process limits. Callers may request smaller values but never raise
//! these ceilings.

pub(crate) const MAX_REQUEST_JSON_BYTES: usize = 64 * 1024;
pub(crate) const MAX_RESPONSE_JSON_BYTES: usize = 512 * 1024;
pub(crate) const MAX_PATH_BYTES: usize = 4 * 1024;
pub(crate) const MAX_SOURCE_BYTES: u64 = 16 * 1024 * 1024;
pub(crate) const MAX_INTERNAL_TEXT_CHARS: usize = 1_000_000;
pub(crate) const MAX_CHUNK_CHARS: usize = 4_000;
pub(crate) const PROSE_CHUNK_OVERLAP_CHARS: usize = 256;
pub(crate) const MAX_CHUNKS: usize = 2_048;
pub(crate) const MAX_OUTLINE_ENTRIES: usize = 256;
pub(crate) const MAX_ASSET_DESCRIPTORS: usize = 128;
pub(crate) const MAX_ASSET_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const MAX_MATERIALIZED_ASSET_FILES: usize = 16;
pub(crate) const MAX_MATERIALIZED_ASSET_BYTES: usize = 16 * 1024 * 1024;
pub(crate) const MAX_WORK_UNITS: usize = 1_250_000;
pub(crate) const MAX_CONVERSION_MILLIS: u64 = 30_000;
pub(crate) const MAX_CACHE_ENTRIES: usize = 4;
pub(crate) const MAX_CACHE_BYTES: usize = 16 * 1024 * 1024;
pub(crate) const DEFAULT_SELECT_CHARS: usize = 48_000;
pub(crate) const MAX_SELECT_CHARS: usize = 64_000;
pub(crate) const DEFAULT_SELECT_CHUNKS: usize = 16;
pub(crate) const MAX_SELECT_CHUNKS: usize = 64;
pub(crate) const MAX_QUERY_UTF16_UNITS: usize = 16_384;
pub(crate) const MAX_QUERY_BYTES: usize = MAX_QUERY_UTF16_UNITS * 4;
pub(crate) const MAX_IDENTIFIER_BYTES: usize = 128;
pub(crate) const MAX_REASON_BYTES: usize = 256;
pub(crate) const MAX_EPUB_SPINE_ITEMS: usize = 2_048;
pub(crate) const MAX_EPUB_REPEATED_ITEMREFS: usize = 16;
pub(crate) const MAX_SPREADSHEET_CELLS: usize = 250_000;
pub(crate) const MAX_SPREADSHEET_MERGED_REGIONS: usize = 4_096;
pub(crate) const MAX_PDF_STREAM_BYTES: usize = 2 * 1024 * 1024;
pub(crate) const MAX_PDF_TOTAL_STREAM_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const MAX_PDF_STREAMS: usize = 4_096;

#[derive(Debug, Clone, Copy)]
pub(crate) struct EffectiveLimits {
    pub source_bytes: u64,
    pub text_chars: usize,
    pub chunks: usize,
    pub work_units: usize,
}

impl Default for EffectiveLimits {
    fn default() -> Self {
        Self {
            source_bytes: MAX_SOURCE_BYTES,
            text_chars: MAX_INTERNAL_TEXT_CHARS,
            chunks: MAX_CHUNKS,
            work_units: MAX_WORK_UNITS,
        }
    }
}
