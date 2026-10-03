# Multimodal Attachment Architecture

Last updated: 2026-10-03

Pocket AI's multimodal attachment pipeline is designed to keep user files local while passing
supported media to the on-device `llama.rn` runtime. The current product surface uses one shared
attachment lifecycle for still images, audio files, and local documents. Availability in the
composer is capability-gated: the app exposes an attachment type only when the loaded model,
runtime state, and local processors can handle it safely. Video attachment processing is disabled;
old persisted video metadata may still be read for chat-history compatibility.

## Current Runtime Contract

The app pins `llama.rn` through `package.json` and validates the installed runtime declarations
before relying on native multimodal behavior. With exactly pinned `llama.rn@0.13.0-rc.3`, the native chat message
contract accepts:

- plain text message content
- structured `image_url` content parts with a local file URL or path
- structured `input_audio` content parts with `format: "wav"` or `format: "mp3"` plus exactly one
  of `url` or `data`

The app-level inference type keeps durable chat text separate from structured runtime media parts.
Persisted chat messages can carry attachment metadata, while the native adapter validates structured
media payloads before calling `llama.rn`.

Model chat modality metadata uses `text`, `vision`, and `audio`. Documents are intentionally not a
native model modality because document files are processed locally and injected as bounded text.

## Attachment Domain Contract

The shared attachment contract separates user-facing attachment kinds from runtime inputs:

- `image` maps to native vision input.
- `audio` maps to native audio input.
- `document` maps to locally extracted text.
- `video` is retained only as a legacy persisted metadata kind. It maps to no runtime input.

All selected files are copied into app-managed storage before durable persistence. The app stores
message-owned metadata and derived attachment links instead of keeping external picker URIs.

## Input Capability Layers

Input support is tracked in separate layers:

- declared capability from catalog metadata, tags, model architecture, and repository tree evidence
- artifact readiness for required projector files
- runtime support confirmed by the active `llama.rn` context
- app-derived support from local processors such as document text extraction
- effective capability for the current composer state

Catalog evidence can mark image, audio, or video as likely supported, but it is not enough to send
native media. Image and audio sending require an active model, a ready projector, and runtime
confirmation for the matching modality. Audio-only model metadata is allowed: the app still resolves
and initializes the projector path, then enables audio only if the runtime confirms audio support.
Document support depends on local processors and does not require a projector. Video declarations are
retained as catalog metadata only; composer video attachment, sampled-frame processing, and direct
video input are disabled.

When a model declares multiple native media modalities, runtime readiness can be partial. For
example, a model may remain ready for vision if the active runtime confirms vision but not audio. In
that state image sends remain available and audio sends stay disabled.

## Model Artifact Manifest

Model metadata can expose an artifact manifest alongside the legacy main-model fields and existing
projector candidates. The manifest currently represents:

- the main GGUF artifact required for text chat
- multimodal projector artifacts required for image and audio inputs
- optional speculative-draft GGUF artifacts used by MTP models such as Gemma

Legacy fields such as the selected GGUF filename, model URL, local path, integrity marker, and
download progress remain the compatibility source for current download code. The manifest is a
typed bridge for multi-artifact download, cleanup, storage accounting, and readiness work. Existing
projector candidate IDs are reused for projector artifacts so selected-projector state and runtime
readiness can be matched without inventing a second identity system.

MTP speculative decoding is text-only. A compatible embedded-MTP GGUF is initialized directly;
Gemma repositories may instead provide a separate draft GGUF that is downloaded, verified, and
loaded beside the main model. Media requests explicitly disable speculative decoding, and failure
to initialize or run MTP falls back to ordinary generation without blocking the base model.

## Attachment Lifecycle

Attachments are copied from the system picker into app-managed local storage under
`Documents/chat-attachments/`. Chat history stores only metadata needed to render, process, and
clean up those attachments, including local file reference, media type, dimensions or duration when
available, size, processing state, derived attachment IDs, and ownership fields.

Before inference:

- images are passed as `image_url` parts only when the active model has a ready multimodal projector
  and runtime support confirms vision capability
- audio attachments are passed as `input_audio` parts only when runtime audio capability is confirmed
- text, Markdown, JSON, and TSV files use the lightweight direct-text processor
- Word, PowerPoint, Excel, OpenDocument, RTF, EPUB, CSV, and text-based PDF files use the
  serial native document processor and question-aware bounded context selection described in
  [`document-processing.md`](./document-processing.md)
- video attachments are not accepted for new sends and legacy video metadata is not converted into
  inference content

Text-only chat remains available when projector setup is missing, ambiguous, failed, or unsupported.

## Startup Cleanup

Attachment cleanup reconciles durable chat references with files in `Documents/chat-attachments/`.
Fresh app-generated draft files are preserved during startup reconciliation while the UI and stores
settle. Draft file names use the `draft-<timestamp>-<random>` prefix, with optional `-thumb` and a
bounded extension. This policy protects image, document, and audio drafts created by the app; it is
not used as MIME validation for user-selected files.

## Audio Attachments

Audio attachments accept WAV and MP3 imports and explicit microphone recording from the existing
composer: Record → Recording → Stop → Preview → Attach/Discard → Send. Opening the chat or
recording sheet requests no permission. Record requests microphone permission, then waits for
native preparation and actual capture status. Granted permission alone is not Recording. Stop
awaits native finalization before a file becomes available. Attach creates an ordinary managed
audio draft; sending remains an explicit action and requires the active model/projector's confirmed
audio capability. The flow never selects or loads another chat model.

The one local preparation module checks actual container bytes, decodes supported PCM WAV,
AAC/M4A or MP3, downmixes at most two channels and resamples bounded frames into real mono
PCM16 WAV. It streams work off the UI thread. A renamed compressed file is decoded according
to its content rather than treated as WAV. Chat sources are limited to 4 MiB and 30 seconds;
reference sources to 2 MiB and 8 seconds. Input rates are bounded to 192 kHz and output to 48 kHz;
chat preparation uses 16 kHz, the admitted Qwen reference uses 24 kHz. Native decoder buffers,
actual frame counts and a 30-second processing deadline are bounded, and admission reserves
64 MiB of current available memory. This is a conservative reserve, not a measured peak.

Native recorder duration/file limits stop real capture. Backgrounding stops and finalizes a
started recording without automatic resume; cancelled preparation or permission requests cannot
start capture later. A finished interrupted draft can be explicitly reviewed on return. Cancel,
unmount and chat changes drain native work before deleting their own files. Capture, sample
preview and TTS playback share one audio-session owner and wait for confirmed disposal on handoff.

Prepared drafts retain source SHA-256, preprocessing identity, actual rate/sample count and
duration in bounded metadata. Only the prepared managed file enters the ordinary message
attachment lifecycle; no PCM arrays or Base64 enter chat history. Empty branch/regenerate rollback
keeps prior committed attachments. Closing recording preview cannot delete an already committed
message's copied file. Audio input passes sound to a compatible model; asking that model for a
transcript is not a separate universal ASR service.

The exact Ultravox fixture and native verification status are recorded in the
[Stage 7 manifest](validation/llama-rn-stage7/audio-input-fixtures.json) and
[acceptance report](validation/llama-rn-stage7/acceptance.md). Importing a fixture, controlled
emulator microphone injection and physical acoustic capture have separate evidence scopes.

Diagnostics must not include raw audio payloads. Structured `input_audio.data` values are dropped
from sanitized diagnostic objects, and local file URLs are redacted.

## Document Attachments

Document attachments use local processors before inference. Plain text family documents are decoded
directly. Structured formats are parsed by the local Rust module outside the JS/UI thread, and only
bounded selected chunks cross the bridge. Text-based PDFs are extracted locally. Unsupported,
encrypted, malformed, binary, or scanned documents resolve to deterministic user-facing errors
instead of being silently dropped.

Extracted document text is not written into diagnostics or exported error reports. Prompt-window
logic can truncate or omit bounded extracted text according to context budget, but it must not
silently drop the attachment and send only the user's typed text.

After a successful attachment turn, the parsed source can remain in a bounded, process-local
session cache for follow-up questions. A follow-up reranks that retained source without reopening
or reparsing the attachment; the newly selected chunks and any rematerialized derived images are
transient inference input and are not duplicated in chat history. The initial turn keeps only its
bounded selected context in encrypted private history as a restart or eviction fallback. LRU
eviction, memory pressure, attachment or conversation deletion, private-storage reset, and process
exit release the cached source. This cache is not a durable full-document index; see
[`document-processing.md`](./document-processing.md) for exact limits and cleanup semantics.

Document search defaults to Keywords and the existing lexical/overview selection. The user can
explicitly select Hybrid and optional independent local reranking for the current chat. Auxiliary
embedding/reranker models are selected separately from the chat model; Keywords with reranking
does not require an embedding model or index. Prepare selected committed documents explicitly,
or let an ordinary Hybrid document request prepare missing compatible indexes.

Prepared indexes are bounded sensitive derived data in encrypted private storage, separate from
the process-local parsed-source cache. They retain bounded embedding subchunks, vectors and exact
source/extractor/model/tokenizer/runtime compatibility identities. Compatible document vectors
can be reused after restart by reopening and revalidating only files still owned by the chat;
opaque parser handles are never restored from disk. Source or profile changes require preparation
again. Draft indexes publish only after the attachment's real message ownership commits. Opening
search options or restoring history does not automatically prepare documents.

Committed attachment/message removal, branch pruning, thread deletion and history clearing
invalidate corresponding derived indexes. Startup reconciliation recovers orphaned generations
once chat ownership has hydrated. Private-storage blocking invalidates active publication epochs
and retains temporary resources until actual work drains; a successful confirmed private-data
reset clears encrypted derived data. These index rules do not change image/audio/video inputs.
The [Stage 5 acceptance report](./llama-rn-013-stage5-acceptance.md) records Android CPU
retrieval, LoRA/Hybrid-tool continuation, Stop and cold reuse/deletion on fixed direct-text
English/Russian fixtures. Ordinary control checks and other document-format retrieval
matrices retain separate verification scope.

## Video Attachments

Video attachment processing is currently disabled. The composer does not expose a video picker, the
app does not copy new videos for chat messages, no native frame-sampler module is installed, and
`video` attachments map to no runtime input.

Legacy chat history can still contain video metadata and derived-frame metadata from older local
builds. Persistence sanitization keeps that metadata bounded so old conversations can render and be
cleaned up, but regeneration and new inference requests do not send video bytes, sampled frames, or
video audio tracks.

## Privacy And Logging

The app must not log raw prompts, extracted document text, private file paths, image bytes, audio
bytes, legacy video bytes, picker URIs, or base64 media payloads. Error reports may include non-sensitive
readiness and capability state, attachment counts, byte counts, processor IDs, and error codes, but
media paths and structured media payloads must be redacted before export or logging.
Derived-index excerpts, vectors and reconstructible compatibility identities must also stay out of diagnostics and exported error reports.
