use std::collections::HashMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use serde_json::{Value, json};
use uuid::Uuid;

use crate::chunk::{CachedDocument, convert};
use crate::error::CoreError;
use crate::limits::{
    MAX_ASSET_BYTES, MAX_ASSET_DESCRIPTORS, MAX_CACHE_BYTES, MAX_CACHE_ENTRIES, MAX_CHUNKS,
    MAX_CONVERSION_MILLIS, MAX_EPUB_REPEATED_ITEMREFS, MAX_EPUB_SPINE_ITEMS,
    MAX_INTERNAL_TEXT_CHARS, MAX_MATERIALIZED_ASSET_BYTES, MAX_MATERIALIZED_ASSET_FILES,
    MAX_PDF_STREAM_BYTES, MAX_PDF_STREAMS, MAX_PDF_TOTAL_STREAM_BYTES, MAX_REQUEST_JSON_BYTES,
    MAX_RESPONSE_JSON_BYTES, MAX_SELECT_CHARS, MAX_SELECT_CHUNKS, MAX_SOURCE_BYTES,
    MAX_SPREADSHEET_CELLS, MAX_SPREADSHEET_MERGED_REGIONS, MAX_WORK_UNITS,
};
use crate::materialize::{cleanup_file, write_asset};
use crate::preflight::{checkpoint, read_and_validate};
use crate::schema::{
    CancelRequest, MaterializeRequest, PrepareRequest, ReleaseRequest, SelectRequest, failure,
    success,
};
use crate::select;
use crate::{
    ABI_SCHEMA_VERSION, ANYDOC_COMMIT, ANYDOC_VERSION, PATCH_REVISION, PDF_INSPECTOR_COMMIT,
};

static CONVERSION_GATE: Mutex<()> = Mutex::new(());

/// Process-local document engine. Conversion is serialized and all cached
/// documents are bounded by count and approximate retained text size.
pub struct PocketAnyDocEngine {
    active: Mutex<HashMap<String, Arc<ActiveRequest>>>,
    lifecycle: Mutex<()>,
    cache: Mutex<CacheState>,
}

impl Default for PocketAnyDocEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl PocketAnyDocEngine {
    /// Construct an empty engine.
    pub fn new() -> Self {
        Self {
            active: Mutex::new(HashMap::new()),
            lifecycle: Mutex::new(()),
            cache: Mutex::new(CacheState::default()),
        }
    }

    /// Safe, owned JSON entry point for the synthetic host benchmark runner.
    /// It deliberately exposes only the benchmark protocol operations and
    /// applies the same request/response bounds and panic containment as the
    /// C ABI without requiring benchmark code to manufacture foreign pointers.
    pub fn invoke_benchmark_json(&self, operation: &str, request_json: &str) -> String {
        const PANIC_FALLBACK: &str = r#"{"ok":false,"error":{"code":"native_failed","message":"The document engine failed safely","retryable":true}}"#;

        catch_unwind(AssertUnwindSafe(|| {
            let result = if request_json.is_empty() {
                Err(CoreError::InvalidRequest("request json"))
            } else if request_json.len() > MAX_REQUEST_JSON_BYTES {
                Err(CoreError::ResourceLimit("max_request_json_bytes"))
            } else {
                match operation {
                    "prepare" => self.prepare(request_json),
                    "select" => self.select(request_json),
                    "release" => self.release(request_json),
                    _ => Err(CoreError::InvalidRequest("benchmark operation")),
                }
            };
            let envelope = match result {
                Ok(value) => serde_json::to_value(success(value)),
                Err(error) => serde_json::to_value(failure(&error)),
            }
            .map_err(|_| CoreError::Internal)?;
            let mut bytes = serde_json::to_vec(&envelope).map_err(|_| CoreError::Internal)?;
            if bytes.len() > MAX_RESPONSE_JSON_BYTES {
                bytes = serde_json::to_vec(&failure(&CoreError::ResourceLimit(
                    "max_response_json_bytes",
                )))
                .map_err(|_| CoreError::Internal)?;
            }
            String::from_utf8(bytes).map_err(|_| CoreError::Internal)
        }))
        .ok()
        .and_then(Result::ok)
        .unwrap_or_else(|| PANIC_FALLBACK.to_string())
    }

    pub(crate) fn prepare(&self, request_json: &str) -> Result<Value, CoreError> {
        let request: PrepareRequest =
            serde_json::from_str(request_json).map_err(|_| CoreError::InvalidRequest("json"))?;
        let limits = request.validate()?;
        let active = self.register(&request.request_id)?;
        let _active_guard = ActiveGuard {
            engine: self,
            request_id: request.request_id.clone(),
        };
        checkpoint(&active.cancelled)?;
        let _serial = lock_recover(&CONVERSION_GATE);
        checkpoint(&active.cancelled)?;
        // The wall deadline starts only after admission to the serial
        // conversion gate, so queueing behind another document cannot spend
        // this request's parse budget.
        let duration = std::time::Duration::from_millis(MAX_CONVERSION_MILLIS);
        let _host_runtime = crate::runtime::install(duration);
        let _anydoc_runtime = anydoc::runtime::install(
            Arc::clone(&active.cancelled),
            Arc::clone(&active.parser_work),
            limits.work_units,
            duration,
        );
        let _pdf_runtime = pdf_inspector::runtime::install(
            Arc::clone(&active.cancelled),
            Arc::clone(&active.parser_work),
            limits.work_units,
            duration,
        );

        let source = read_and_validate(&request, limits, &active.cancelled)?;
        checkpoint(&active.cancelled)?;
        let document = Arc::new(convert(source, limits, &active.cancelled)?);
        checkpoint(&active.cancelled)?;
        let handle = format!("doc:{}", Uuid::new_v4().simple());
        let _lifecycle = lock_recover(&self.lifecycle);
        let evicted = {
            let mut cache = lock_recover(&self.cache);
            cache.insert(handle.clone(), Arc::clone(&document))?
        };
        self.finish_cleanup(evicted.files);
        if let Err(error) = checkpoint(&active.cancelled) {
            let removed = lock_recover(&self.cache).remove(&handle);
            self.finish_cleanup(removed.files);
            return Err(error);
        }
        serde_json::to_value(document.prepare_data(&handle)).map_err(|_| CoreError::Internal)
    }

    pub(crate) fn select(&self, request_json: &str) -> Result<Value, CoreError> {
        let request: SelectRequest =
            serde_json::from_str(request_json).map_err(|_| CoreError::InvalidRequest("json"))?;
        request.validate()?;
        let active = self.register(&request.request_id)?;
        let _active_guard = ActiveGuard {
            engine: self,
            request_id: request.request_id.clone(),
        };
        checkpoint(&active.cancelled)?;
        let document = lock_recover(&self.cache)
            .get(&request.handle)
            .ok_or(CoreError::HandleNotFound)?;
        let result = select::select(&document, &request, &active.cancelled)?;
        checkpoint(&active.cancelled)?;
        serde_json::to_value(result).map_err(|_| CoreError::Internal)
    }

    pub(crate) fn materialize(&self, request_json: &str) -> Result<Value, CoreError> {
        let request: MaterializeRequest =
            serde_json::from_str(request_json).map_err(|_| CoreError::InvalidRequest("json"))?;
        request.validate()?;
        let active = self.register(&request.request_id)?;
        let _active_guard = ActiveGuard {
            engine: self,
            request_id: request.request_id.clone(),
        };
        checkpoint(&active.cancelled)?;
        let _lifecycle = lock_recover(&self.lifecycle);
        checkpoint(&active.cancelled)?;

        let document = lock_recover(&self.cache)
            .get(&request.handle)
            .ok_or(CoreError::HandleNotFound)?;
        let payload = document
            .asset_payloads
            .iter()
            .find(|asset| asset.id == request.asset_id)
            .ok_or(CoreError::InvalidRequest("assetId"))?;
        lock_recover(&self.cache).ensure_materialization_capacity(payload.bytes.len())?;
        let materialized = write_asset(&request, payload, &active.cancelled)?;
        if let Err(error) = checkpoint(&active.cancelled) {
            self.finish_cleanup(vec![MaterializedFile::new(
                request.handle.clone(),
                materialized.destination,
                payload.bytes.len(),
            )]);
            return Err(error);
        }
        if let Err(error) = lock_recover(&self.cache).track_materialized(
            &request.handle,
            materialized.destination.clone(),
            payload.bytes.len(),
        ) {
            self.finish_cleanup(vec![MaterializedFile::new(
                request.handle.clone(),
                materialized.destination,
                payload.bytes.len(),
            )]);
            return Err(error);
        }
        if let Err(error) = checkpoint(&active.cancelled) {
            let removed = lock_recover(&self.cache)
                .untrack_materialized(&request.handle, &materialized.destination);
            self.finish_cleanup(removed);
            return Err(error);
        }
        serde_json::to_value(materialized.data).map_err(|_| CoreError::Internal)
    }

    pub(crate) fn cancel(&self, request_json: &str) -> Result<Value, CoreError> {
        let request: CancelRequest =
            serde_json::from_str(request_json).map_err(|_| CoreError::InvalidRequest("json"))?;
        request.validate()?;
        let active = lock_recover(&self.active);
        let count = match request.request_id {
            Some(request_id) => active.get(&request_id).map_or(0, |token| {
                token.cancelled.store(true, Ordering::Release);
                1
            }),
            None => {
                for token in active.values() {
                    token.cancelled.store(true, Ordering::Release);
                }
                active.len()
            }
        };
        Ok(json!({ "cancelledCount": count }))
    }

    pub(crate) fn release(&self, request_json: &str) -> Result<Value, CoreError> {
        let request: ReleaseRequest =
            serde_json::from_str(request_json).map_err(|_| CoreError::InvalidRequest("json"))?;
        request.validate()?;
        let _lifecycle = lock_recover(&self.lifecycle);
        let removed = {
            let mut cache = lock_recover(&self.cache);
            match request.handle {
                Some(handle) => cache.remove(&handle),
                None => cache.clear(),
            }
        };
        let cleanup = self.finish_cleanup(removed.files);
        Ok(json!({
            "releasedCount": removed.documents,
            "removedAssetFiles": cleanup.removed,
            "cleanupPendingFiles": cleanup.pending,
        }))
    }

    pub(crate) fn version() -> Value {
        json!({
            "moduleVersion": env!("CARGO_PKG_VERSION"),
            "parserId": "anydoc",
            "parserVersion": ANYDOC_VERSION,
            "exactAnyDocCommit": ANYDOC_COMMIT,
            "pdfInspectorCommit": PDF_INSPECTOR_COMMIT,
            "patchRevision": PATCH_REVISION,
            "abiSchemaVersion": ABI_SCHEMA_VERSION,
        })
    }

    pub(crate) fn capabilities() -> Value {
        json!({
            "available": true,
            "formats": [
                "csv", "doc", "docm", "docx", "epub", "odp", "ods", "odt", "pdf",
                "pot", "pps", "ppsm", "ppsx", "ppt", "pptm", "pptx", "rtf", "xls",
                "xlsb", "xlsm", "xlsx"
            ],
            "maxSourceBytes": MAX_SOURCE_BYTES,
            "maxSelectionChars": MAX_SELECT_CHARS,
            "maxSelectionChunks": MAX_SELECT_CHUNKS,
            "supportsAssets": true,
            "supportsAssetMaterialization": true,
            "materializableAssetMediaTypes": [
                "image/png", "image/jpeg", "image/gif", "image/webp"
            ],
            "supportsCancellation": true,
            "cacheAdmissionPolicy": "fail_closed",
            "cacheLeasePolicy": "explicit_release",
            "requestSchemaVersion": ABI_SCHEMA_VERSION,
            "canonicalPrepareFields": ["sourcePath", "privateRoot", "sourceIdentity"],
            "formatSourceBytes": {
                "csv": 2 * 1024 * 1024,
                "pdf": 8 * 1024 * 1024,
                "rtf": 8 * 1024 * 1024,
                "epub": 8 * 1024 * 1024,
                "document": 12 * 1024 * 1024,
                "presentation": 12 * 1024 * 1024,
                "spreadsheet": 12 * 1024 * 1024,
            },
            "limits": {
                "maxTextChars": MAX_INTERNAL_TEXT_CHARS,
                "maxChunks": MAX_CHUNKS,
                "maxWorkUnits": MAX_WORK_UNITS,
                "maxConversionMillis": MAX_CONVERSION_MILLIS,
                "maxCacheBytes": MAX_CACHE_BYTES,
                "maxCacheEntries": MAX_CACHE_ENTRIES,
                "maxAssetBytes": MAX_ASSET_BYTES,
                "maxAssetDescriptors": MAX_ASSET_DESCRIPTORS,
                "maxMaterializedAssetFiles": MAX_MATERIALIZED_ASSET_FILES,
                "maxMaterializedAssetBytes": MAX_MATERIALIZED_ASSET_BYTES,
                "maxEpubSpineItems": MAX_EPUB_SPINE_ITEMS,
                "maxEpubRepeatedItemrefs": MAX_EPUB_REPEATED_ITEMREFS,
                "maxSpreadsheetCells": MAX_SPREADSHEET_CELLS,
                "maxSpreadsheetMergedRegions": MAX_SPREADSHEET_MERGED_REGIONS,
                "maxPdfStreamBytes": MAX_PDF_STREAM_BYTES,
                "maxPdfTotalStreamBytes": MAX_PDF_TOTAL_STREAM_BYTES,
                "maxPdfStreams": MAX_PDF_STREAMS,
                "archiveEntryBytes": 8 * 1024 * 1024,
                "archiveTotalBytes": 32 * 1024 * 1024,
                "archiveEntries": 4096,
                "xmlDepth": 128,
                "xmlNodes": 100000,
                "expansionPositions": 100000,
                "binaryRecords": 500000,
            },
        })
    }

    fn register(&self, request_id: &str) -> Result<Arc<ActiveRequest>, CoreError> {
        let token = Arc::new(ActiveRequest {
            cancelled: Arc::new(AtomicBool::new(false)),
            parser_work: Arc::new(AtomicUsize::new(0)),
        });
        let mut active = lock_recover(&self.active);
        if active.contains_key(request_id) {
            return Err(CoreError::DuplicateRequest);
        }
        active.insert(request_id.to_string(), Arc::clone(&token));
        Ok(token)
    }

    fn unregister(&self, request_id: &str) {
        lock_recover(&self.active).remove(request_id);
    }

    fn finish_cleanup(&self, files: Vec<MaterializedFile>) -> CleanupOutcome {
        let report = cleanup_materialized(files);
        let mut cache = lock_recover(&self.cache);
        cache.queue_cleanup(report.failed);
        CleanupOutcome {
            removed: report.removed,
            pending: cache.pending_cleanup.len(),
        }
    }
}

struct ActiveRequest {
    cancelled: Arc<AtomicBool>,
    parser_work: Arc<AtomicUsize>,
}

impl Drop for PocketAnyDocEngine {
    fn drop(&mut self) {
        let _lifecycle = lock_recover(&self.lifecycle);
        let removed = lock_recover(&self.cache).clear();
        let _ = cleanup_materialized(removed.files);
    }
}

struct ActiveGuard<'a> {
    engine: &'a PocketAnyDocEngine,
    request_id: String,
}

impl Drop for ActiveGuard<'_> {
    fn drop(&mut self) {
        self.engine.unregister(&self.request_id);
    }
}

#[derive(Default)]
struct CacheState {
    entries: HashMap<String, Arc<CachedDocument>>,
    approximate_bytes: usize,
    materialized: HashMap<String, Vec<MaterializedFile>>,
    pending_cleanup: Vec<MaterializedFile>,
    materialized_files: usize,
    materialized_bytes: usize,
}

impl CacheState {
    fn insert(
        &mut self,
        handle: String,
        document: Arc<CachedDocument>,
    ) -> Result<CacheRemoval, CoreError> {
        if document.approximate_bytes > MAX_CACHE_BYTES {
            return Err(CoreError::ResourceLimit("max_cache_bytes"));
        }
        if self.entries.contains_key(&handle) {
            return Err(CoreError::InvalidRequest("duplicate handle"));
        }
        // A returned handle is an explicit lease until release. Never make a
        // previously successful prepare/select/materialize contract fail by
        // silently evicting an unreleased handle. New preparation fails closed
        // when the bounded retained-document profile is full.
        if self.entries.len() >= MAX_CACHE_ENTRIES {
            return Err(CoreError::ResourceLimit("max_cache_entries"));
        }
        if self
            .approximate_bytes
            .saturating_add(document.approximate_bytes)
            > MAX_CACHE_BYTES
        {
            return Err(CoreError::ResourceLimit("max_cache_bytes"));
        }
        self.approximate_bytes = self
            .approximate_bytes
            .saturating_add(document.approximate_bytes);
        self.entries.insert(handle, document);
        Ok(CacheRemoval::default())
    }

    fn get(&mut self, handle: &str) -> Option<Arc<CachedDocument>> {
        self.entries.get(handle).cloned()
    }

    fn remove(&mut self, handle: &str) -> CacheRemoval {
        let documents = match self.entries.remove(handle) {
            Some(document) => {
                self.approximate_bytes = self
                    .approximate_bytes
                    .saturating_sub(document.approximate_bytes);
                1
            }
            None => 0,
        };
        let mut files = self.take_materialized(handle);
        files.append(&mut self.take_pending_cleanup(Some(handle)));
        CacheRemoval { documents, files }
    }

    fn clear(&mut self) -> CacheRemoval {
        let documents = self.entries.len();
        self.entries.clear();
        self.approximate_bytes = 0;
        let mut files: Vec<MaterializedFile> = self
            .materialized
            .drain()
            .flat_map(|(_, files)| files)
            .collect();
        files.append(&mut self.take_pending_cleanup(None));
        self.materialized_files = 0;
        self.materialized_bytes = 0;
        CacheRemoval { documents, files }
    }

    fn ensure_materialization_capacity(&self, bytes: usize) -> Result<(), CoreError> {
        if bytes > MAX_ASSET_BYTES
            || self.materialized_files >= MAX_MATERIALIZED_ASSET_FILES
            || self.materialized_bytes.saturating_add(bytes) > MAX_MATERIALIZED_ASSET_BYTES
        {
            Err(CoreError::ResourceLimit("max_materialized_asset_bytes"))
        } else {
            Ok(())
        }
    }

    fn track_materialized(
        &mut self,
        handle: &str,
        path: PathBuf,
        bytes: usize,
    ) -> Result<(), CoreError> {
        if !self.entries.contains_key(handle) {
            return Err(CoreError::HandleNotFound);
        }
        self.ensure_materialization_capacity(bytes)?;
        if self
            .materialized
            .values()
            .flatten()
            .any(|file| file.path == path)
            || self.pending_cleanup.iter().any(|file| file.path == path)
        {
            return Err(CoreError::InvalidRequest("duplicate destination"));
        }
        self.materialized
            .entry(handle.to_string())
            .or_default()
            .push(MaterializedFile::new(handle.to_string(), path, bytes));
        self.materialized_files += 1;
        self.materialized_bytes = self.materialized_bytes.saturating_add(bytes);
        Ok(())
    }

    fn untrack_materialized(&mut self, handle: &str, path: &PathBuf) -> Vec<MaterializedFile> {
        let Some(files) = self.materialized.get_mut(handle) else {
            return Vec::new();
        };
        let Some(index) = files.iter().position(|file| &file.path == path) else {
            return Vec::new();
        };
        let file = files.remove(index);
        self.materialized_files = self.materialized_files.saturating_sub(1);
        self.materialized_bytes = self.materialized_bytes.saturating_sub(file.bytes);
        if files.is_empty() {
            self.materialized.remove(handle);
        }
        vec![file]
    }

    fn take_materialized(&mut self, handle: &str) -> Vec<MaterializedFile> {
        let files = self.materialized.remove(handle).unwrap_or_default();
        self.materialized_files = self.materialized_files.saturating_sub(files.len());
        let bytes = files.iter().map(|file| file.bytes).sum::<usize>();
        self.materialized_bytes = self.materialized_bytes.saturating_sub(bytes);
        files
    }

    fn take_pending_cleanup(&mut self, handle: Option<&str>) -> Vec<MaterializedFile> {
        let mut selected = Vec::new();
        let mut retained = Vec::new();
        for file in self.pending_cleanup.drain(..) {
            if handle.is_none_or(|candidate| candidate == file.owner) {
                selected.push(file);
            } else {
                retained.push(file);
            }
        }
        self.pending_cleanup = retained;
        self.materialized_files = self.materialized_files.saturating_sub(selected.len());
        let bytes = selected.iter().map(|file| file.bytes).sum::<usize>();
        self.materialized_bytes = self.materialized_bytes.saturating_sub(bytes);
        selected
    }

    fn queue_cleanup(&mut self, files: Vec<MaterializedFile>) {
        for file in files {
            if self
                .pending_cleanup
                .iter()
                .any(|pending| pending.path == file.path)
            {
                continue;
            }
            self.materialized_files = self.materialized_files.saturating_add(1);
            self.materialized_bytes = self.materialized_bytes.saturating_add(file.bytes);
            self.pending_cleanup.push(file);
        }
    }
}

#[derive(Default)]
struct CacheRemoval {
    documents: usize,
    files: Vec<MaterializedFile>,
}

struct MaterializedFile {
    owner: String,
    path: PathBuf,
    bytes: usize,
}

impl MaterializedFile {
    fn new(owner: String, path: PathBuf, bytes: usize) -> Self {
        Self { owner, path, bytes }
    }
}

struct CleanupReport {
    removed: usize,
    failed: Vec<MaterializedFile>,
}

struct CleanupOutcome {
    removed: usize,
    pending: usize,
}

fn cleanup_materialized(files: Vec<MaterializedFile>) -> CleanupReport {
    let mut removed = 0_usize;
    let mut failed = Vec::new();
    for file in files {
        match cleanup_file(&file.path) {
            Ok(was_removed) => removed += usize::from(was_removed),
            Err(_) => failed.push(file),
        }
    }
    CleanupReport { removed, failed }
}

fn lock_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunk::{CachedAssetPayload, ContentChunk};
    use lopdf::{Document, Object, Stream, dictionary};
    use sha2::{Digest, Sha256};
    use std::fs;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    fn cached(size: usize) -> Arc<CachedDocument> {
        Arc::new(CachedDocument {
            canonical_format: "csv".to_string(),
            source_byte_count: size,
            source_char_count: size,
            content_sha256: "0".repeat(64),
            chunks: vec![ContentChunk {
                index: 0,
                text: "x".to_string(),
                kind: "paragraph".to_string(),
                asset_ids: Vec::new(),
                heading: None,
                page_number: None,
                slide_number: None,
                sheet_name: None,
            }],
            outline: Vec::new(),
            assets: Vec::new(),
            asset_payloads: Vec::new(),
            warnings: Vec::new(),
            slide_count: None,
            sheet_count: None,
            page_count: None,
            approximate_bytes: size,
        })
    }

    fn cached_png(size: usize) -> Arc<CachedDocument> {
        let mut bytes = vec![0_u8; 33];
        bytes[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        bytes[8..12].copy_from_slice(&13_u32.to_be_bytes());
        bytes[12..16].copy_from_slice(b"IHDR");
        bytes[16..20].copy_from_slice(&2_u32.to_be_bytes());
        bytes[20..24].copy_from_slice(&3_u32.to_be_bytes());
        bytes[24..29].copy_from_slice(&[8, 6, 0, 0, 0]);
        let mut document = (*cached(size)).clone();
        document.asset_payloads.push(CachedAssetPayload {
            id: 7,
            media_type: "image/png".to_string(),
            sha256: format!("{:x}", Sha256::digest(&bytes)),
            bytes,
            width: 2,
            height: 3,
        });
        Arc::new(document)
    }

    #[test]
    fn cache_preserves_all_unreleased_handle_leases_and_fails_closed() {
        let mut cache = CacheState::default();
        for value in 0..MAX_CACHE_ENTRIES {
            cache.insert(format!("h{value}"), cached(1)).unwrap();
        }
        cache.get("h0").unwrap();
        assert!(matches!(
            cache.insert("new".to_string(), cached(1)),
            Err(CoreError::ResourceLimit("max_cache_entries"))
        ));
        for value in 0..MAX_CACHE_ENTRIES {
            assert!(cache.entries.contains_key(&format!("h{value}")));
        }
    }

    #[test]
    fn four_unreleased_handles_remain_materializable_until_explicit_release() {
        let root = tempfile::tempdir().unwrap();
        let engine = PocketAnyDocEngine::new();
        {
            let mut cache = lock_recover(&engine.cache);
            cache.insert("h0".to_string(), cached_png(1)).unwrap();
            for value in 1..MAX_CACHE_ENTRIES {
                cache.insert(format!("h{value}"), cached(1)).unwrap();
            }
            assert!(matches!(
                cache.insert("h4".to_string(), cached(1)),
                Err(CoreError::ResourceLimit("max_cache_entries"))
            ));
        }

        let destination = root.path().join("asset.png");
        let materialized = engine
            .materialize(
                &json!({
                    "schemaVersion": 1,
                    "requestId": "materialize-retained-h0",
                    "handle": "h0",
                    "assetId": 7,
                    "destinationPath": destination,
                    "privateRoot": root.path(),
                })
                .to_string(),
            )
            .unwrap();
        assert_eq!(materialized["assetId"], 7);
        assert!(destination.exists());

        let released = engine
            .release(r#"{"schemaVersion":1,"handle":"h0"}"#)
            .unwrap();
        assert_eq!(released["releasedCount"], 1);
        assert_eq!(released["removedAssetFiles"], 1);
        assert!(!destination.exists());
        let cache = lock_recover(&engine.cache);
        for value in 1..MAX_CACHE_ENTRIES {
            assert!(cache.entries.contains_key(&format!("h{value}")));
        }
    }

    #[test]
    fn version_and_capabilities_publish_exact_provenance_and_asset_contract() {
        let version = PocketAnyDocEngine::version();
        assert_eq!(version["exactAnyDocCommit"], ANYDOC_COMMIT);
        assert_eq!(version["exactAnyDocCommit"].as_str().unwrap().len(), 40);
        let capabilities = PocketAnyDocEngine::capabilities();
        assert_eq!(capabilities["supportsAssets"], true);
        assert_eq!(capabilities["supportsAssetMaterialization"], true);
        assert_eq!(capabilities["cacheAdmissionPolicy"], "fail_closed");
        assert_eq!(capabilities["cacheLeasePolicy"], "explicit_release");
        assert_eq!(
            capabilities["limits"]["maxConversionMillis"],
            MAX_CONVERSION_MILLIS
        );
        assert_eq!(
            capabilities["limits"]["maxSpreadsheetCells"],
            MAX_SPREADSHEET_CELLS
        );
        assert_eq!(
            capabilities["limits"]["maxPdfStreamBytes"],
            pdf_inspector::MAX_PDF_STREAM_BYTES
        );
        assert_eq!(
            capabilities["limits"]["maxPdfTotalStreamBytes"],
            pdf_inspector::MAX_PDF_TOTAL_STREAM_BYTES
        );
    }

    #[test]
    fn cancellation_token_is_observable_and_counted() {
        let engine = PocketAnyDocEngine::new();
        let token = engine.register("request-1").unwrap();
        let response = engine
            .cancel(r#"{"schemaVersion":1,"requestId":"request-1"}"#)
            .unwrap();
        assert_eq!(response["cancelledCount"], 1);
        assert!(token.cancelled.load(Ordering::Acquire));
        engine.unregister("request-1");
    }

    #[test]
    fn prepare_hashes_and_selects_private_csv() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("sample.csv");
        fs::write(&source, "name,value\nalpha,1\nbeta,2\n").unwrap();
        let request = json!({
            "schemaVersion": 1,
            "requestId": "prepare-1",
            "sourcePath": source,
            "privateRoot": directory.path(),
            "sourceSizeBytes": fs::metadata(&source).unwrap().len(),
            "displayName": "sample.csv"
        });
        let engine = PocketAnyDocEngine::new();
        let prepared = engine.prepare(&request.to_string()).unwrap();
        assert_eq!(prepared["canonicalFormat"], "csv");
        assert_eq!(prepared["exactAnyDocCommit"], ANYDOC_COMMIT);
        assert_eq!(prepared["exactAnyDocCommit"].as_str().unwrap().len(), 40);
        assert_eq!(prepared["contentSha256"].as_str().unwrap().len(), 64);
        let selection = engine
            .select(
                &json!({
                    "schemaVersion": 1,
                    "requestId": "select-1",
                    "handle": prepared["handle"],
                    "query": "beta",
                    "maxChunks": 4,
                    "maxChars": 1000
                })
                .to_string(),
            )
            .unwrap();
        assert!(
            selection["chunks"].as_array().unwrap()[0]["text"]
                .as_str()
                .unwrap()
                .contains("beta")
        );
    }

    #[test]
    fn caller_can_lower_source_limit() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("large.csv");
        fs::write(&source, "1234567890").unwrap();
        let request = json!({
            "schemaVersion": 1,
            "requestId": "prepare-limit",
            "sourcePath": source,
            "privateRoot": directory.path(),
            "sourceSizeBytes": 10,
            "displayName": "large.csv",
            "limits": { "maxSourceBytes": 5 }
        });
        assert!(matches!(
            PocketAnyDocEngine::new().prepare(&request.to_string()),
            Err(CoreError::ResourceLimit("max_source_bytes"))
        ));
    }

    #[test]
    fn cleanup_attempts_every_file_and_retains_failures_for_retry() {
        let directory = tempfile::tempdir().unwrap();
        let failing = directory.path().join("temporarily-a-directory.png");
        let removable = directory.path().join("removable.png");
        fs::create_dir(&failing).unwrap();
        fs::write(&removable, b"asset").unwrap();
        let engine = PocketAnyDocEngine::new();

        let first = engine.finish_cleanup(vec![
            MaterializedFile::new("doc:cleanup".to_string(), failing.clone(), 5),
            MaterializedFile::new("doc:cleanup".to_string(), removable.clone(), 5),
        ]);
        assert_eq!(first.removed, 1);
        assert_eq!(first.pending, 1);
        assert!(!removable.exists());

        fs::remove_dir(&failing).unwrap();
        fs::write(&failing, b"asset").unwrap();
        let retry = lock_recover(&engine.cache).take_pending_cleanup(Some("doc:cleanup"));
        let second = engine.finish_cleanup(retry);
        assert_eq!(second.removed, 1);
        assert_eq!(second.pending, 0);
        assert!(!failing.exists());
    }

    fn write_long_pdf(path: &std::path::Path) {
        let mut document = Document::with_version("1.4");
        let pages_id = document.new_object_id();
        let font_id = document.add_object(dictionary! {
            "Type" => "Font",
            "Subtype" => "Type1",
            "BaseFont" => "Helvetica",
        });
        let mut operations = String::from("BT /F1 12 Tf 10 700 Td ");
        for _ in 0..100_000 {
            operations.push_str("(ORCHID-742) Tj ");
        }
        operations.push_str("ET");
        let content_id = document.add_object(Stream::new(dictionary! {}, operations.into_bytes()));
        let page_id = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => Object::Reference(pages_id),
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
            "Resources" => dictionary! {
                "Font" => dictionary! { "F1" => Object::Reference(font_id) },
            },
            "Contents" => Object::Reference(content_id),
        });
        document.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![Object::Reference(page_id)],
                "Count" => 1,
            }),
        );
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => Object::Reference(pages_id),
        });
        document.trailer.set("Root", Object::Reference(catalog_id));
        document.save(path).unwrap();
    }

    #[test]
    fn active_cancel_is_observed_inside_long_pdf_operator_loop() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("long.pdf");
        write_long_pdf(&source);
        assert!(fs::metadata(&source).unwrap().len() < 8 * 1024 * 1024);
        let request_id = "cancel-long-pdf";
        let request = json!({
            "schemaVersion": 1,
            "requestId": request_id,
            "sourcePath": source,
            "privateRoot": directory.path(),
            "sourceSizeBytes": fs::metadata(directory.path().join("long.pdf")).unwrap().len(),
            "displayName": "long.pdf",
        })
        .to_string();
        let engine = Arc::new(PocketAnyDocEngine::new());
        let worker_engine = Arc::clone(&engine);
        let (sender, receiver) = mpsc::sync_channel(1);
        let worker = std::thread::spawn(move || {
            sender.send(worker_engine.prepare(&request)).unwrap();
        });

        let wait_until = Instant::now() + Duration::from_secs(10);
        loop {
            let progress = lock_recover(&engine.active)
                .get(request_id)
                .map(|active| active.parser_work.load(Ordering::Acquire))
                .unwrap_or(0);
            if progress >= 1_000 {
                break;
            }
            assert!(
                Instant::now() < wait_until,
                "PDF parser never reached operator-loop work"
            );
            assert!(matches!(
                receiver.try_recv(),
                Err(mpsc::TryRecvError::Empty)
            ));
            std::thread::yield_now();
        }
        let cancelled = engine
            .cancel(&json!({"schemaVersion":1,"requestId":request_id}).to_string())
            .unwrap();
        assert_eq!(cancelled["cancelledCount"], 1);
        assert!(matches!(
            receiver.recv_timeout(Duration::from_secs(10)).unwrap(),
            Err(CoreError::Cancelled)
        ));
        worker.join().unwrap();
    }
}
