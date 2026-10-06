# Privacy & Disclosures

Last updated: 2026-10-05

## Summary

Pocket AI is an offline-first mobile assistant built around local GGUF models. After a model has been downloaded and loaded, chat inference runs on-device instead of through a hosted chat-completion API.

This document summarizes the current behavior of the app as configured in this repository. It is intended as a product-facing disclosure summary, not a legal policy template.

## What stays on-device

- Chat prompts and generated responses stay on the device during local inference.
- Chat attachments selected from the device stay on the device during local inference. They are not uploaded to a hosted chat-completion API.
- Downloaded GGUF files, multimodal projector companions, optional MTP draft, TTS codec/vocoder and LoRA adapter companions, and copied chat attachments are stored in app-managed local storage. Android release builds disable OS auto-backup, and iOS release builds mark the downloaded-model and chat-attachment storage directories as excluded from device and iCloud backups.
- Conversation history is persisted locally on the device and encrypted at rest.
- Derived document indexes are sensitive private data stored locally in encrypted app storage; excerpts and vectors are not uploaded.
- While a response is generating, bounded encrypted recovery data for the active partial
  response may also be stored locally so a force-stop or crash can recover the last
  committed prefix without copying the complete conversation.
- System prompt presets, generation settings, and model-specific load profiles are persisted locally on the device and encrypted at rest.
- An optional Hugging Face access token can be stored locally in secure device storage for browsing and downloading gated or private models.
- Catalog metadata such as resolved GGUF file/variant size, selected file identity, access state, and local download status is cached locally only for app behavior and is not synced to a hosted account service.
- Recent first-page Hugging Face catalog results, GGUF variant metadata, and recently opened public model-detail snapshots are stored in a bounded on-device cache so the catalog can reopen quickly on this device.
- Hugging Face popularity metadata, tag summaries, and routed model-detail state are cached locally only to improve catalog browsing on this device.
- Storage cleanup controls are available in-app through `Storage Manager` and `All Conversations`, including model removal that can keep or reset saved per-model settings.

Auxiliary role selections, explicit companion source bindings, and local compatibility-check results stay in encrypted app storage. A selected role or installed companion does not establish native compatibility. Embedding/reranker load checks temporarily use the on-device runtime and restore a previously loaded chat model when one exists and its selection is still current; compatibility checks themselves do not upload chat content or enable a chat search mode or speech playback. Document search separately defaults to Keywords, with explicit Hybrid and optional independent local reranking. Hybrid prepares selected owned documents through Prepare or an ordinary document request; local reranking can run on Keywords without an embedding index.

Experimental [local speech](local-tts.md) requires an explicit editable-text preview or completed-assistant action. Synthesis, the supported offline phonemizer and playback stay on-device and do not add audio or latent arrays to chat history. Playback stores one unencrypted app-private temporary WAV, at most 1,536,044 bytes, and requires confirmed player disposal before deletion. Editing/changing the source, closing/leaving Chat, backgrounding or private-data reset invalidates speech and clears that clip after native drain; foregrounding does not resume it. Choosing a builtin voice or opening voice controls does not request microphone access or start synthesis.

Recording starts only after explicit Record. The app checks microphone permission and requests it
if needed before capture.
It can create a chat attachment or a temporary voice reference; neither is sent automatically.
Capture, sample preview and generated speech share one session, with background recording/playback
and automatic resume disabled. A voice reference requires explicit confirmation of ownership or
permission. This confirmation is not identity verification or a guarantee of rights.

References default to temporary app-private sources and are removed after owners drain. Explicit
Save voice stores the original source in the existing encrypted private store, in bounded shards,
plus a small name/language/consent configuration. The library permits four voices, at most 2 MiB
and eight seconds each, and at most 8 MiB of original audio in total. Handles, speaker embeddings,
reference PCM and native snapshots are never persisted. Cold opening restores the choice without
recording, preparing or synthesizing. Delete invalidates selection immediately and waits for
active leases/native drain before deleting its owned source; borrowed chat attachments are retained.

Native preprocessing and synthesis temporarily need bounded plaintext PCM/WAV derivatives in app-private cache
directories `audio-reference/`, `audio-preparation/` and `tts-clips/`. iOS caches are excluded from
backup, Android auto-backup is disabled, and cold-start/private-reset reconciliation covers the
reserved files. These temporary bytes and ordinary chat attachment files are not separately
encrypted. File leases and native users must drain before these owned temporary files are removed.
Native and speech-content/reference-conditioning acceptance are recorded separately.

The C15 physical Android API 34 recorder run passed all seven lifecycle cases, including
background interruption without automatic resume; imported and recorded audio-input content
also passed. The bounded C15 privacy audit inspected 1,687 application records / 256,959 bytes,
found zero candidates, retained no raw logs and confirmed capture drain. Device records cover
2026-10-05 14:45:38.274280–15:59:54.542422 UTC; host capture ran 14:43:19.194–16:02:39.496 UTC.
Those windows are distinct. Earlier forbidden diagnostic candidates remain recorded, and this
result does not establish unobserved device routes. Recorder/content success and cleanup alone
are not privacy-audit proof; see the [Stage 7 report](validation/llama-rn-stage7/acceptance.md).

## Chat attachments

When a user adds an attachment to a chat:

- The app uses system picker flows so the user can choose files to attach. Depending on the attachment kind and platform, this may use the photo-library picker or document picker. On Android API 32 and lower, the app keeps the legacy read-only media permission available for gallery-picker compatibility; it is capped to those older OS versions.
- Explicit audio recording requests the microphone just before capture. Stop/finalization, bounded local decoding and an explicit Attach action precede sending. The original temporary recording and its prepared draft are removed only after the relevant native/file owners drain.
- Selected files are copied into app-managed local storage under `Documents/chat-attachments/` so the conversation can reopen the attachment later.
- Chat history stores attachment metadata needed to render and manage the attachment, such as its local file reference, media type, dimensions or duration when available, file size, processor metadata, and the draft, message, or conversation it belongs to.
- Raw attachment files are local app-managed files. This document does not claim those attachment bytes are separately encrypted beyond the device and platform storage protections in use.
- The app attempts to clean up attachments when the related draft is discarded, the related message or chat history is deleted, or the user resets private app storage. Cleanup failures are logged without exposing raw file paths.
- Image inference uses the local model on the device when the active model and projector support vision. Audio inference uses the local model only when runtime audio support is confirmed. Document text extraction runs locally.
- Office, OpenDocument, RTF, EPUB, CSV, and text-based PDF processing runs inside the
  app's native Rust module. Documents are not sent to Firecrawl or another parsing,
  OCR, analytics, or telemetry service. External links and images referenced by a
  document are not fetched.
- The document cache is memory-bounded and limited to the current app session. It can
  retain up to four parsed document sources so follow-up questions can select new relevant
  chunks without reparsing. Full parsed text is not persisted by this cache. The initial
  attachment turn keeps only bounded selected prompt context and processor metadata in
  encrypted private chat history; later session selections are transient prompt input and
  are not copied into each follow-up message. Cache entries are released on eviction,
  deletion, private-storage reset/blocking, memory warning, or process exit. Temporary
  derived assets remain app-managed and are removed when released or reconciled.
- Prepared document embedding indexes are separate bounded encrypted derived data. They
  contain sensitive source excerpts, vectors and compatibility identities, and can be reused after
  restart only while the original document remains committed to the chat and the source,
  extractor, embedding model and runtime identities still match. Compatible vectors are
  reused; opaque parser handles remain process-local. Reopening an owned file can require
  local parsing and byte revalidation. Opening search options or restoring history does
  not automatically prepare indexes or run a search.
- Video attachment processing is disabled. The app does not accept new video attachments, sample video frames, claim direct-video understanding, or extract video audio tracks.
- Backup behavior follows the app's platform configuration: Android release builds disable OS auto-backup, and iOS release builds exclude downloaded model files and local chat attachments from device and iCloud backups.

## When the app uses the network

Pocket AI uses the network only for model-management flows:

- Hugging Face model catalog search
- Optional metadata, repository file lists, README summary, and config fetches used for model hints, GGUF variant lists, popularity sorting, size recovery, context-window recovery, and gated-model access checks
- Model file downloads for selected chat, embedding or reranker GGUF variants and any compatible multimodal projector or optional MTP draft companion from remote hosting endpoints
- Optional TTS codec/vocoder and LoRA adapter downloads from HTTPS GGUF URLs explicitly supplied by the user. The hosting service receives these file requests. Hugging Face credentials are sent only to trusted Hugging Face resolve URLs, not arbitrary companion hosts.
- If a Hugging Face access token is configured, the app attaches it to Hugging Face API requests as needed to surface gated or private repositories (including catalog browsing). Some endpoints are still probed anonymously first and retried with auth only when required.
- When a user taps through to Hugging Face from the token screen or a model detail view, the app opens the public Hugging Face site in the device browser
- Generated Markdown images are rendered as text labels and are never fetched automatically, including HTTP(S), data, relative, protocol-relative, linked-image, and reference-image syntax. Ordinary HTTP(S) text links open only after a user taps them.

The app can display public, token-required, and access-denied Hugging Face repositories in the same catalog. When a token is configured, token-scoped catalog state is kept only in memory and is cleared when the token is updated or removed; the on-disk catalog cache stores only anonymous/public results. Saving or clearing a token clears the local Hugging Face catalog cache so stale access labels are not reused. When the network is available, cached first-page catalog results are revalidated against Hugging Face on reopen.

The current release flow in this repository does not send chat prompts to a hosted chat-completion API.

## Local data controls

Users can manage local data directly in the app:

- offload downloaded models and associated multimodal projector, MTP draft, TTS codec/vocoder or LoRA adapter artifacts while keeping or resetting saved per-model settings
- prepare, pause, retry, cancel or remove optional companion resources; shared installed files are retained while another resource still owns them
- unload the active model
- clear persisted chat history, including active-response recovery artifacts and derived document indexes
- discard attachment drafts and delete messages or conversations, which attempts to remove their associated local attachment files when cleanup runs
- explicitly save, select or delete local reference voices; deletion clears owned originals/configuration after active use drains
- reset settings
- reset private app storage, including a best-effort cleanup of local chat attachments
- manage retention for older conversations

Committed attachment/message removal, branch pruning, conversation deletion and history
clearing invalidate the corresponding derived document indexes and trigger cleanup. Startup
reconciliation retries orphan cleanup after durable chat ownership is established. Private-storage
blocking invalidates active publication epochs, cancels work and retains temporary resources until
the actual parser/native work settles; blocking itself is not a completed data reset. A successful,
confirmed private-data reset clears the encrypted derived indexes along with the private stores.

## Device and resource limits

Local inference is constrained by the device:

- large GGUF models can exceed available RAM
- large downloads can exceed available storage
- sustained inference can increase thermal pressure and reduce responsiveness
- the maximum context window exposed in model controls can be reduced by verified model limits and estimated RAM headroom on the current device

The app includes warnings for risky operations such as low-disk downloads, cellular downloads, and models that may not fit into available memory. If the safest available load profile still exceeds the estimated RAM budget (or a model only fits at the minimum context window of 512 tokens), the app marks it as `Won't fit RAM` and blocks the load instead of attempting the native model initialization. When required, the app can unload the active model to protect stability.

## Release configuration in this repository

For the release configuration currently committed here:

- Android package name: `com.github.tah10n.pocketai`
- Android auto-backup is disabled to avoid backing up local chat and model state
- iOS excludes downloaded model files and multimodal projector, MTP draft, TTS codec/vocoder or LoRA adapter artifacts under the app-managed `Documents/models/` directory, plus local chat attachments under `Documents/chat-attachments/`, from device and iCloud backups
- Android permissions include:
  - `INTERNET` (Hugging Face catalog and model downloads)
  - `VIBRATE` (UI haptics)
  - `RECORD_AUDIO` (explicit bounded chat or voice-reference recording)
  - `POST_NOTIFICATIONS` (Android 13+ notifications for download/inference status)
  - `FOREGROUND_SERVICE` and `FOREGROUND_SERVICE_DATA_SYNC` (keep long-running downloads/inference alive in the background via a foreground service)
  - `READ_EXTERNAL_STORAGE` with `android:maxSdkVersion="32"` (legacy Android gallery-picker compatibility for selected media)
- Android gallery attachment support is configured for picker-based selection only. The app blocks merged `CAMERA` and `WRITE_EXTERNAL_STORAGE` permissions. Microphone permission is present for explicit recording; no microphone foreground service, background recording/playback, always-listening or hidden automatic restart is enabled. iOS provides a localized `NSMicrophoneUsageDescription` for the same explicit action.

## Scope note

This document describes the behavior of the code in this repository at the time of writing. If the product's privacy or networking behavior changes, this file should be updated alongside [`README.md`](../README.md) and [`app.json`](../app.json).
