# Local Document Processing

Last updated: 2026-10-01

Pocket AI processes supported document attachments entirely on the device. Structured
documents are copied into app-owned storage, parsed by the local `PocketAnyDoc` Expo
module, and reduced to question-relevant chunks before inference. Document bytes,
extracted text, and embedded images are not uploaded to a parsing service.

## Document search modes and preparation

Open **Document search → Search options** in the current chat. **Keywords** preserves the existing Unicode lexical and overview selection. **Hybrid** combines that ranking with local embeddings. **Local reranking** optionally applies a separate local cross-encoder to either mode. Select auxiliary embedding/reranker models in Models; they do not replace the chat model. New and legacy chats use Keywords with reranking off until explicitly changed.

The panel lists up to four ready document attachments committed to the current chat. Each shows **Not prepared**, **Needs preparation again**, **Preparing**, **Cancelling**, **Ready for hybrid search**, **Preparation failed** or **Preparation cancelled**. Choose **Prepare** after selecting Hybrid and a compatible embedding profile. Progress counts structural chunks; readiness appears only after all vectors and the private manifest commit. Cancel prevents subsequent work and shows Cancelling while waiting for actual native/source settlement before freeing ownership. Opening the panel and restoring history do not automatically prepare documents. Explicit expansion may read native AnyDoc version metadata through `getVersion`; it does not parse documents or load an auxiliary model. Unknown or changed extractor metadata cannot establish a compatible ready index. Ordinary document requests can prepare missing compatible indexes under their document-preparation owner. Tools use prepared indexes and never hide cold indexing inside their short action deadline.

The last search displays its actual mode, any fallback reason and whether an index could not be saved. An unsaved-cache notice is separate from the actual search mode: completed Hybrid retrieval remains Hybrid, including any completed local reranking. This status is process-local and is not reconstructed as a historical result after restart. A selected Hybrid mode does not itself prove that embeddings ran. A compatible ready manifest proves preparation identity, not ranking quality.

## Shared bounded retrieval

`DocumentRetrievalService` serves new attachment turns, follow-ups, editing/regeneration and local document-search tools. Hybrid preparation enumerates the full retained structural source in bounded pages, independently of the initial lexical shortlist. Keywords with optional reranking uses the existing bounded lexical candidates. Native AnyDoc keeps opaque handles; direct-text sources retain bounded structural chunks. No unbounded conversion is copied across the bridge.

Embedding inputs include the selected model's exact document/query prefixes before token counting. The admitted E5 artifact uses mean pooling, L2 normalization and 384 dimensions. Its complete input cap is 511 tokens, including automatic specials. Long prose is split at tokenizer-checked Unicode/prose boundaries while retaining the original structural ID and real source range. Atomic code, table, list and sheet chunks that exceed the character or model-token limit fail safely. Vectors must have the expected dimension, finite float32 values and a valid L2 norm.

Cosine selection keeps the strongest subchunk for each original structural chunk. Reciprocal rank fusion combines lexical and semantic positions, rather than adding incompatible scores. The optional BGE cross-encoder reranks a maximum of eight candidates, preserving each native original index. Its exact pair template is detokenized and retokenized natively before the call; the pinned bridge's extra BOS/EOS boundaries are included. Invalid indexes/scores and the native failure sentinel reject the ranking. The existing fair document allocation, real locators, untrusted-source boundaries, derived asset ownership and exact chat-token budget still apply to selected chunks. Missing page/slide/sheet locators are omitted.

## Private index identity and limits

Indexes are bounded derived private data in encrypted storage. They contain vectors, bounded embedding subchunks covering the complete structural source, and existing structural metadata; they are separate from persisted chat messages and process-local parser handles. Their compatibility fingerprint includes original document SHA-256, extraction processor/version/canonical format and native parser commit, source byte/chunk counts, chunking/preprocessing version, exact embedding SHA-256/revision/bytes, tokenizer and special-token policy, query/document prefixes, pooling, normalization, dimensions, vector format and runtime/source-patch identity.

| Derived retrieval resource | Maximum |
| --- | ---: |
| Documents in one retrieval; globally committed index manifests | 4 |
| Structural chunks / embedding subchunks per document | 2,048 / 2,048 |
| One structural chunk / one embedding subchunk | 64,000 / 4,000 UTF-16 units |
| Serialized shard data per index / aggregate publication peak | 8 MiB / 32 MiB |
| Storage shard | 8 rows / 512 KiB |
| Fused candidates / cross-encoder candidates | 16 / 8 |

These ceilings are combined: a document may reach the byte limit before its row limit. The four-manifest limit is global across chats. The aggregate serialized-shard limit includes the old readable generation during replacement; encrypted-storage and manifest overhead are additional. Actual tokenizer/model limits and available memory can lower admission further. Memory fit reserves the selected model, work buffers, retained source/index buffers and restoration headroom; unknown fit is rejected. Only exact verified source profiles are admitted. See [model sources and limits](validation/llama-rn-stage5/model-sources.md).

Small shards yield between writes/reads. A final manifest makes a complete generation readable; cancelled or failed publication leaves no ready partial index. Reconciliation removes unpublished generations after restart. Once chat history has hydrated successfully, startup also removes ready indexes without a committed ready document owner, recovering deletion or attachment-drop crash windows. This check reads scope/manifest metadata without parsing files or starting inference. If chat ownership has not hydrated, startup does not infer that all owners disappeared. Draft attachment indexes publish only after real message ownership commits. On a compatible restart, currently owned attachment bytes are revalidated and vectors are reused without recomputing document embeddings. Source/extractor/model/prefix/runtime changes require preparation again. Opaque handles are never restored from disk.

When a draft index is published after its attachment has committed, a cache quota rejection or an ordinary encrypted-cache write failure can leave that index unsaved. If document ownership and source identity are still valid and any suspended chat model has been safely restored, the current response continues with the already-selected Hybrid context. It does not repeat embeddings or reranking solely because saving the index failed. Successfully published sibling indexes remain available; failed publication creates no ready partial index and does not undo the committed attachment or its bounded chat context. Later preparation can retry the unsaved index.

## Retrieval privacy, lifecycle and fallback

The original app-owned file remains governed by chat attachment ownership. Committed document removal, branch pruning, thread deletion and history clearing remove corresponding derived indexes; private-storage blocking invalidates active publication and drains temporary resources. A successful confirmed private-data reset removes encrypted derived data. Empty stopped/error branch replacement preserves the previous owners until an actual terminal commit. Parser sources and derived assets follow their existing explicit release/retry lifecycle.

With a loaded idle chat model A, one serial engine owner releases A, runs B for Hybrid and optionally C for reranking, then verifies and restores A's actual effective load profile, ordered LoRA bindings/scales and companion identity. Preparation can also run without a loaded A. Keywords with reranking uses C without an embedding model or index, restoring A when it was suspended. Empty/overview search queries preserve the existing overview selection without B or C. Stop blocks later phases and waits for the actual callback, including tokenization, source enumeration and the complete in-flight rerank batch; rc.3 has no operation-wide embedding/rerank cancellation API. After confirmed drain, Stop can restore an unchanged A selection without continuing the cancelled request. Changed chat/model/document/private-storage ownership discards late work. Uncertain native resources remain quarantined until actual drain or process restart.

Missing/unverified models, missing/stale indexes, retrieval input and resource limits and invalid vector/ranking results can use Keywords only when ownership is still valid and native work either did not start or has confirmed safe drain and a verified restoration receipt. Exact-A restoration is required when a loaded A was suspended. The actual lexical mode and reason are visible. Cancellation, ownership loss, unknown drain and failed restoration cannot silently fall back or continue a response. A restoration error requires recovery before another request.

A quota or ordinary cache-write failure after successful Hybrid selection is handled as the unsaved-cache outcome described above. Stop, changed ownership or source bytes, changed chat/model/permission selection, private-storage blocking/reset, uncertain drain and failed restoration still prevent stale answer continuation. Private-storage unavailability is not an ordinary cache-write failure.

## Supported formats

The lightweight direct-text processor remains the primary path for `.txt`, `.md`,
`.markdown`, `.json`, and `.tsv`. It avoids starting the native parser for formats that
only need a bounded local decode.

The native processor handles:

- Word: `.doc`, `.docx`, and `.docm`
- PowerPoint: `.ppt`, `.pps`, `.pot`, `.pptx`, `.pptm`, `.ppsx`, and `.ppsm`
- Excel: `.xls`, `.xlsx`, `.xlsm`, and `.xlsb`
- OpenDocument: `.odt`, `.ods`, and `.odp`
- `.rtf`, `.epub`, `.csv`, and text-based `.pdf`

The picker MIME type is only an initial routing signal. Android providers sometimes
report `application/octet-stream` or another generic type, so native preparation also
checks the document signature and controlled filename hint. A signature that conflicts
with the filename or MIME hint is authoritative; preparation records a bounded
`format_hint_mismatch` warning. A strong signature that is itself unsupported is rejected,
and arbitrary ZIP files are not accepted as Office, OpenDocument, or EPUB files.

Scanned or image-only PDFs require OCR and therefore return a no-extractable-text error.
Pocket AI does not use cloud OCR. Encrypted or password-protected documents are also
rejected locally.

## Architecture

`modules/pocket-anydoc/` is an autolinked local Expo module. Kotlin and Swift perform
platform file checks and dispatch conversion away from the UI thread. They call a small
handwritten C ABI backed by a pinned Rust crate. JavaScript never receives an unbounded
Markdown conversion or a Base64 copy of the source document.

The conversion flow is:

1. The attachment service copies the picker result into `Documents/chat-attachments/`.
2. The platform module normalizes the file URL, verifies that it is a regular file under
   the attachment root, records its stable file identity, and queues the request.
3. Rust reopens and revalidates the canonical path, file identity, size, and hash before
   parsing. Symlinks, path escapes, directories, changed files, and external
   `content://` values are rejected.
4. One heavy conversion runs at a time. Native structural chunks and validated asset
   payloads are retained behind an opaque explicit-release handle. The cache is bounded
   to four handles / 16 MiB and never silently invalidates a returned lease; new
   preparation fails closed until capacity is released. Only metadata, an outline,
   asset descriptors, and selected chunks cross the native bridge.
5. Keywords uses Unicode lexical ranking for topical questions. Hybrid and optional
   reranking use the shared retrieval pipeline above. Overview requests retain the
   outline plus deterministic beginning, middle and end coverage.
6. `DocumentContextService` distributes a fair budget across all successful documents,
   adds source boundaries and an untrusted-data instruction, and uses the active model's
   exact tokenizer to remove whole chunks until the prompt fits.
7. After a successful attachment turn, the parsed-source session remains process-local.
   Separately prepared encrypted embedding indexes follow the identity and limits above. A follow-up question runs a new relevance
   selection against that source without reopening or reparsing the attachment. Native
   formats retain the opaque handle; direct-text formats retain their bounded structural
   chunks in JavaScript memory. The cache is global-LRU bounded to four documents;
   direct-text sources have an additional shared 1,000,000-character JS-heap ceiling,
   while the native four-handle / 16 MiB ceiling remains authoritative.
8. Cached sources and documents newly attached to a later question share one fair global
   selection and exact prompt budget. The new document is persisted once; reranked chunks
   from older documents remain transient. Editing a user question or regenerating the last
   answer performs the same session selection for every document still present on that
   branch.
9. Follow-up document chunks are transient prompt input: old persisted document parts and
   derived images are removed from that inference request, and the new selection is not
   copied into the new chat message. The initial attachment turn still keeps its bounded
   selected `contentParts` and derived images in encrypted private history as an app-restart
   or eviction fallback. Full parsed text is never persisted by the session cache.
10. A handle is released on LRU eviction, branch commit, retention pruning, thread deletion,
   history clearing, private-storage blocking/reset, a system memory warning, processing
   failure/cancellation, or process teardown. A failed release remains owned in a bounded
   pending-release queue and is retried
   by the next cache cleanup/admission operation; it continues to consume capacity until the
   release succeeds. Branch replacement does not evict tail handles until the terminal write
   commits, so an empty stopped/error result can restore the previous durable branch safely.
   When a multi-document preparation reaches native cache pressure, the oldest session handle
   is released and preparation is retried once per available slot; chunks already selected for
   the current send remain valid.

Filesystem existence checks may run with bounded concurrency, but native Office/EPUB/PDF
conversion is globally serialized. Request IDs and chat/model generation revisions prevent
a late result from being attached to a different message. Large direct-text session reranks
yield to the React Native event loop at bounded chunk checkpoints, allowing cancellation and
input events to be observed before the complete retained source has been rescored.

## Structural context

Native chunks preserve headings, paragraphs, list items, code blocks, tables, worksheet
names, and slide boundaries. Table rows, list items, and code blocks are atomic; when a
large table is split, its header row is repeated. Chunks use UTF-16-aware limits and never
split a surrogate pair.

Each document section in the inference prompt includes a sanitized display name, format,
document number, structural labels, explicit `BEGIN`/`END` boundaries, and a truncation
marker when the full document was not selected. The prompt tells the model to treat the
document body as untrusted source data, not as system or developer instructions.

For multiple documents, the context service first reserves a useful minimum for every
successful attachment, then spends remaining budget by relevance. A failed document is
reported by filename without discarding successful siblings or changing attachment order.

## Mobile safety profile

Callers may lower these ceilings but cannot raise them:

| Resource | Hard ceiling |
| --- | ---: |
| Source file, platform boundary preflight | 32 MiB |
| Source file, Rust parser outer guard | 16 MiB |
| CSV source | 2 MiB |
| PDF, RTF, or EPUB source | 8 MiB |
| Office/OpenDocument source | 12 MiB |
| One decompressed archive entry | 8 MiB |
| Total decompressed archive data | 32 MiB |
| Archive entries | 4,096 |
| XML nesting depth | 128 |
| XML nodes in one part | 100,000 |
| Repeat-expanded cells | 100,000 |
| Repeat-expanded text | 8 MiB |
| Legacy binary record depth / count | 64 / 500,000 |
| Retained embedded image data | 8 MiB total, at most 128 assets |
| Spreadsheet used-cell extent / merged regions | 250,000 / 4,096 |
| One decoded PDF stream / decoded total / stream count | 2 MiB / 8 MiB / 4,096 |
| Extracted text | 1,000,000 UTF-16 units |
| Structural chunks | 2,048, at most 4,000 UTF-16 units each |
| One bridge selection | 64 chunks / 64,000 UTF-16 units |
| Explicit-release document leases | 4 handles / 16 MiB approximate retained data; fail-closed admission |
| Global conversion work budget | 1,250,000 charged operations |
| One conversion wall-clock deadline | 30 seconds |
| EPUB spine / repeated references to one part | 2,048 / 16 |
| Materialized derived assets | 16 files / 16 MiB total, 8 MiB each |

These values are intentionally below desktop/server ingestion profiles so a loaded local
LLM retains memory headroom. The source limits reflect the synthetic mobile corpus: CSV
needs the smallest allowance, PDF/RTF/EPUB can expand significantly while parsing, and
compressed Office/OpenDocument files need a modestly larger source allowance. Limits are
also enforced inside archive, XML, repeat-expansion, binary-record, asset, chunking, and
selection loops. Exceeding any ceiling fails with a stable resource-limit result instead
of returning partial data as if it were complete.

## Spreadsheet semantics

Visible worksheet data is kept separate by workbook and sheet. Hidden rows and columns are
excluded and produce warning metadata. XLSX/XLSM display formats reconstruct common
percent, currency, accounting, date, time, and numeric representations. Unsupported custom
formats are rejected unless the converter can mark the result explicitly as lossy; Pocket
AI never silently presents a raw value as though it were the displayed value.

Macros, formulas as executable code, OLE objects, embedded executables, and nested
documents are never run. Formula results are treated as document data.

## Embedded images

The converter keeps a stable `Inline::Image` to asset ID relationship and inserts an
explicit placeholder in text. It accepts only bounded PNG, JPEG, GIF, or WebP raster data
whose declared media type, file signature, dimensions, hash, and pixel count agree.
External URLs, missing data, oversized images, unknown types, embedded executables, and
recursive documents are not fetched or executed.

When the active model has verified vision support, only assets linked to selected chunks
are materialized into app-private temporary files. Existing user image attachments consume
the shared four-image input limit first. Derived assets are selected deterministically,
passed through the same local image validation lifecycle, and removed on release,
cancellation, failure, or reconciliation. Assets rematerialized for a cached follow-up or
regeneration are prompt-only temporary inputs and are discarded after that completion instead
of being duplicated in chat history. Without vision readiness or a remaining slot,
the text placeholder remains and warning metadata states that the image was skipped; the
prompt never claims that the image was analyzed.

## Stable errors and warnings

Native failures contain a bounded code and public-safe message, never a private path or
document text. The app maps them to localized English and Russian messages for:

- unsupported format or unavailable processor
- corrupt/malformed or encrypted document
- no extractable text
- source-size, archive, work, memory, or context limit
- unsupported spreadsheet display semantics
- native conversion failure or cancellation
- skipped/unsupported embedded assets
- truncated document context

Warnings are stored as bounded processor metadata so persisted version-2 direct-text
attachments and newer native attachments can coexist without rewriting chat history.

## Privacy and cleanup

Processing is offline. The module does not call Firecrawl Parse API, fetch linked assets,
start a local server, use a WebView, or emit document telemetry. Logs and diagnostic
artifacts may contain processor versions, format, counts, timings, limits, and error codes,
but not full paths, source text, prompts, or image bytes.

The original app-owned attachment remains governed by the existing chat attachment
lifecycle. Session caches, native handles, and derived asset files are temporary. Startup
reconciliation removes unreferenced generated files. After an app restart or LRU eviction,
Keywords follow-ups retain the bounded encrypted context fallback from the original
attachment turn. Hybrid can reopen currently owned files and reuse compatible prepared
vectors without recomputing document embeddings. Editing/regenerating the attachment
turn can safely reparse the original app-owned file.

## Known limitations

- Image-only PDFs are not OCR'd.
- Password-protected documents cannot be processed.
- Unsupported spreadsheet custom formats fail safely or carry an explicit lossy warning.
- Embedded media other than validated raster images remains represented by a placeholder.
- Context selection can be incomplete when a document is larger than the active model's
  available prompt budget; the message metadata and prompt both mark this condition.
- Parsed-source session handles remain process-local and can end on eviction or memory
  pressure. Prepared encrypted embedding indexes survive restart only while source,
  extractor, model and runtime identities remain compatible. Readiness does not guarantee
  recall or answer correctness.
- The admitted artifacts and native corpus cover English/Russian. Other models, languages,
  formats and backends require their own evidence. The pinned BGE native pair layout
  differs from its upstream Hugging Face layout; measured results determine its effect.

## Retrieval verification

The [Stage 5 Android CPU protocol](llama-rn-013-stage5-acceptance.md) passed the fixed
English/Russian corpus, actual LoRA and Hybrid-only tool continuation, preparation/search
Stop, cold reuse and persistent deletion on the recorded source/APK. Tool+C within the
ten-second tool budget remains unverified. Separate ordinary EN/RU control captures and
measured touch bounds record explicit capture and answer-quality limits. Earlier parser and all-format checks retain their own scope.

The later [index-publication correction](llama-rn-013-stage5-index-publication-fix.md) has separate source/APK evidence for four global indexes plus a fifth accepted Hybrid document turn, explicit unsaved-cache status, Stop and cold retention.

## Updating anydoc

The exact upstream source and local patch inventory are recorded in
`modules/pocket-anydoc/rust/UPSTREAM.md`. To update it:

1. Review the new release and pin an exact upstream commit.
2. Recheck upstream correctness and security reports, including archive/EPUB expansion,
   slide boundaries, spreadsheet display values, escaping, and embedded assets.
3. Refresh the vendored source and reapply the smallest auditable Pocket AI patch set.
4. Run the complete synthetic and upstream fixture corpus and compare deterministic
   outputs and error classes.
5. Build Android arm64-v8a/x86_64 and iOS device/arm64 simulator/Intel simulator
   artifacts from clean native inputs.
6. Run attachment integration scenarios, cancellation/race checks, and native artifact
   inspection on release builds.
7. Compare conversion timings, peak memory, per-ABI library size, and APK/AAB/IPA size
   before committing the updated lockfile and provenance metadata.

The reproducible synthetic Android QA and host/device benchmark protocol is documented in
[`document-qa-benchmarks.md`](./document-qa-benchmarks.md).
