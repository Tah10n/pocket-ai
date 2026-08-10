# Local Document Processing

Last updated: 2026-08-10

Pocket AI processes supported document attachments entirely on the device. Structured
documents are copied into app-owned storage, parsed by the local `PocketAnyDoc` Expo
module, and reduced to question-relevant chunks before inference. Document bytes,
extracted text, and embedded images are not uploaded to a parsing service.

## Supported formats

The lightweight direct-text processor remains the primary path for `.txt`, `.md`,
`.json`, and `.tsv`. It avoids starting the native parser for formats that only need a
bounded local decode.

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
5. Native Unicode lexical ranking selects whole structural chunks for a topical
   question. An overview request uses the outline plus deterministic beginning, middle,
   and end coverage.
6. `DocumentContextService` distributes a fair budget across all successful documents,
   adds source boundaries and an untrusted-data instruction, and uses the active model's
   exact tokenizer to remove whole chunks until the prompt fits.
7. After a successful attachment turn, the complete parsed source remains available only
   through a process-local session cache. A follow-up question runs a new relevance
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
ordinary follow-ups use the bounded encrypted context from the original attachment turn;
editing/regenerating that attachment turn can safely reparse the original app-owned file.

## Known limitations

- Image-only PDFs are not OCR'd.
- Password-protected documents cannot be processed.
- Unsupported spreadsheet custom formats fail safely or carry an explicit lossy warning.
- Embedded media other than validated raster images remains represented by a placeholder.
- Context selection can be incomplete when a document is larger than the active model's
  available prompt budget; the message metadata and prompt both mark this condition.
- Session retrieval lasts only for the current app process and may end earlier after memory
  pressure or LRU eviction. It does not create a durable full-document index.

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
