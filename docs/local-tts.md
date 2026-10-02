# Experimental local speech

Pocket AI has an explicit local speech preview for editable text and completed assistant replies. The Stage 6 implementation covers both llama.rn token and continuous-embedding synthesis. These are implemented pipelines; the selected English and Mandarin model pairs still require app-specific device and speech-content acceptance. See the [acceptance worksheet](validation/llama-rn-stage6/acceptance.md). Upstream examples, file checks and application tests do not establish intelligible speech on this app.

## Using the preview

1. In model resources, select a TTS backbone and its matching codec, then prepare both files through the existing download manager. **Check files** verifies the selected file identities; it does not synthesize or prove model compatibility.
2. Open **Local speech** in Chat, or the speech action on a completed assistant reply. The reply action captures that message and chat; it does not create another assistant turn.
3. Review or edit the text and choose the admitted profile's language. The preview displays the exact text sent to synthesis. Ordinary prose has supported display markup removed. Structured output, code, tables and uncertain markup require explicit review and can be edited before synthesis.
4. Select **Synthesize**, then **Play**, **Pause**, **Stop** or **Replay**. Replay uses the existing clip and does not run inference again. Stop releases the player and retains that clip until it is cleared.

Input is limited to 240 characters and the formatted native prompt to 512 tokens. Pasting longer text preserves the whole draft and disables synthesis; the app does not silently shorten it. Speech is bounded to 16 seconds. A completion that reaches a generation limit, is interrupted, or lacks natural end-of-sequence is rejected instead of playing partial speech.

Changing text, language, message, chat or model selection invalidates the request and clears its clip after native drain. Closing the preview, leaving Chat, backgrounding the app or resetting private data also stops and clears speech. Returning to the foreground does not resume playback. A cleanup failure remains visible and blocks unsafe reuse.

## Admitted profiles and requirements

The current profiles match exact backbone and codec SHA-256 identities, with revisions, sizes, metadata and licenses recorded in the [fixture manifest](validation/llama-rn-stage6/tts-fixtures.json) and [source record](validation/llama-rn-stage6/model-sources.md). Other filenames, quantizations or pairs do not inherit admission.

| Profile | Pipeline and application language | Decoder bound | Conservative peak-memory policy |
| --- | --- | --- | --- |
| OuteTTS 1.0 0.6B Q4_K_M + DAC speech F16 | `tokens`; English (`en`) | Two codes per frame; 1,200 frames; mono 24 kHz; at most 384,000 samples | 3,441,568,640 bytes, about 3.4 GB |
| BlueMagpie Barbet 1B Q4_K_M + AudioVAE Q8_0 | `continuous_embd`; Taiwanese Mandarin (`zh-tw`) | 64 values per frame; four frames per generation step; 400 frames; mono 48 kHz; at most 768,000 samples | 9,066,120,384 bytes, about 9.1 GB |

These estimates are deliberately conservative, low-confidence admission policies, not measured resident memory or a guarantee that a device fits. They include duplicated codec loading, potential dequantization, per-family graph reserves of 768 MiB and 1,536 MiB respectively, KV/hidden states, native/JS payloads, WAV and player copies, and workspace headroom. Unknown pairs receive no estimate. Unknown or insufficient available memory blocks native initialization. Displayed GB values use decimal units.

Both profiles use CPU for the backbone and codec, one heavy context, a 4,096-token context and `embedding: true` for TTS hidden states. This is separate from document `embedding()` calls. Parallel mode remains disabled, `n_parallel: 1`, `state_cache_budget_mb: 0` and `state_cache_max_checkpoints: 8` remain unchanged. GPU/NPU TTS execution is not admitted by these profiles.

The selected speakerless paths need no external phonemizer, reference recording or microphone. `getTTSCapabilities().requiresPhonemes` is checked for the actual model. A model that requires phonemes is rejected with a missing-prerequisite error because this implementation installs no phonemizer; this is not a universal restriction on every TTS family.

`getTTSVoice`, `listTTSVoices` and `listTTSLanguages` are upstream reference-payload helpers. Their contents or empty lists do not establish supported languages or prohibit a native speakerless path. The app omits speaker for these profiles; OuteTTS 1.0 must not receive the legacy Oute default word/code payload. Reference-audio voices, `createSpeaker`, baking and speaker-handle release remain Stage 7 work.

The interface is localized in English and Russian. Russian speech is not admitted or verified. The wider language declarations in upstream cards do not extend these application profiles.

OuteTTS declares Apache-2.0; the underlying DAC speech weights declare CDLA-Permissive-2.0. BlueMagpie's conversion card and base-model license disagree: the base card restricts use to research/evaluation and limits redistribution pending rights and consent. Keep BlueMagpie weights and generated speech in local evaluation; do not publish either. The pinned source record preserves the precise notices.

## Runtime and storage contract

The synthesis runtime initializes the vocoder, obtains capabilities, calls `getFormattedAudioCompletion`, and uses the returned prompt, grammar, embedding mode and flow together in normal `completion`. Token flow decodes final `audio_tokens` with `decodeAudioTokens`; continuous flow decodes final `embeddings` with its actual `embedding_dim` using `decodeAudioEmbeddings`. It does not use deprecated `generateAudioCodes`, parse text into codes, or normalize audio latents as retrieval vectors.

Validation requires natural EOS, a complete nonempty payload, the expected codebook or latent shape, finite mono PCM, the actual codec sample rate and bounded output. Application and guarded native checks bound frames multiplied by the actual decoder hop before decoder graph allocation, then validate decoded PCM before returning it. The continuous caller supplies frame-major latents; native code performs its own transpose.

The existing engine owner serializes chat A → TTS backbone/codec → A. Synthesis can also run without a loaded chat model. Restoration requires the original current selection, effective profile and ordered LoRA bindings to remain valid; a stale request cannot restore an earlier selection over a newer one. No speech text, audio buffers or latents are added to chat history or persisted application state.

`stopCompletion` requests interruption and the completion promise must settle. `initVocoder`, decoding and release have no public cancellation API in the pinned runtime: cancellation invalidates the request and waits for the actual call before releasing its resources. Timeout alone cannot release ownership. Uncertain native drain, vocoder release or chat restoration leaves an explicit error and blocks another job. There is no queued TTS work.

Playback owns one app-private, unencrypted ephemeral cache WAV. It is 16-bit mono PCM with a 44-byte header, bounded to 1,536,044 bytes (about 1.536 MB). The service retains only one clip. Clearing requires confirmed native player disposal, shared-object release and confirmed file deletion, in that order. Cold-start cleanup covers this owned clip; cache storage should not be treated as encrypted chat history.

The playback-only Expo configuration disables microphone/recording permissions and background recording/playback. Local synthesis and playback use no cloud service. Preparing missing model files still uses the existing explicit download flow.

## Native build and verification

The app pins llama.rn `0.13.0-rc.3` and expo-audio `55.0.18`. Postinstall applies guarded source patches in `patches/llama-rn-0.13.0-rc.3.js` and `patches/expo-audio-55.0.18.js`. The first adds decode bounds and removes sensitive native text/path logging; the second adds confirmed asynchronous player disposal and an opt-in guard against automatic resume. A fresh native APK or iOS build is required. A JS update against an older binary cannot supply these native contracts.

Expo autolinking explicitly builds `expo-audio` from its installed source on both platforms. SDK 55 can otherwise substitute an unpatched prebuilt module. Keep this source-build admission when editing autolinking options; installed source hashes alone do not prove that a binary contains the player patch. Android acceptance must include the `expo-audio` source compilation tasks, and iOS acceptance must compile the patched Swift sources.

The audio package's `expo-asset` peer is explicitly pinned to the installed SDK 55 version, `55.0.20`. Leaving its wildcard peer unresolved can install a newer incompatible native AssetModule at the top level even while Expo retains a compatible nested copy. Native configuration verification checks the top-level manifest, lockfile and installed peer.

Run the explicit Android TTS pack only with a disposable isolated QA install and an absolute local audio-output directory outside this checkout and any published artifact directory:

```powershell
$env:POCKET_AI_TTS_AUDIO_OUTPUT_DIR = 'D:\LocalSpeechQa'
node scripts/android-scenarios.js --emulator --pack tts --apk-variant release --isolated-qa-install --fail-on-skip
```

The pack retains baseline scenarios and adds `runtime-local-tts-tokens` and `runtime-local-tts-continuous`. The QA surface is available only in the existing flagged QA build. Native receipts and local clip exports are separate from content acceptance. The runner copies synthetic clips locally for independent ASR; it does not upload speech or establish transcript correctness. Listen to each clip and compare a local, independent multilingual ASR transcript with the exact synthetic input, recording omissions, substitutions and early stopping. No cloud ASR or reference recording is needed. Delete owned clips when that local evaluation finishes; publish only compact sanitized receipts, never weights or BlueMagpie audio.

The [Stage 6 worksheet](validation/llama-rn-stage6/acceptance.md) records native, playback, lifecycle, ordinary UI and content results independently. Builds, API availability, nonempty PCM and upstream observations are separate evidence categories.
