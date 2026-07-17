# Multimodal Attachment Architecture

Last updated: 2026-07-16

Pocket AI's multimodal attachment pipeline is designed to keep user files local while passing
supported media to the on-device `llama.rn` runtime. The current product surface uses one shared
attachment lifecycle for still images, audio files, and local documents. Availability in the
composer is capability-gated: the app exposes an attachment type only when the loaded model,
runtime state, and local processors can handle it safely. Video attachment processing is disabled;
old persisted video metadata may still be read for chat-history compatibility.

## Current Runtime Contract

The app pins `llama.rn` through `package.json` and validates the installed runtime declarations
before relying on native multimodal behavior. With `llama.rn@0.12.6`, the native chat message
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
- text, Markdown, JSON, CSV, TSV, and text-based PDF documents are locally extracted and injected as
  bounded text context
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

Audio attachments currently accept WAV and MP3 inputs selected from the document picker. The app
does not request microphone permission and does not record audio. Audio send remains disabled unless
the active runtime reports audio support.

Diagnostics must not include raw audio payloads. Structured `input_audio.data` values are dropped
from sanitized diagnostic objects, and local file URLs are redacted.

## Document Attachments

Document attachments use local processors before inference. Plain text family documents are decoded
as bounded text. Text-based PDFs are extracted locally. Unsupported, encrypted, malformed, binary, or
scanned documents resolve to deterministic user-facing errors instead of being silently dropped.

Extracted document text is not written into diagnostics or exported error reports. Prompt-window
logic can truncate or omit bounded extracted text according to context budget, but it must not
silently drop the attachment and send only the user's typed text.

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
