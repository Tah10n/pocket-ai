# Experimental local speech

Pocket AI has an explicit local speech preview for editable text and completed assistant replies. Stage 6 covers both llama.rn token and continuous-embedding synthesis. The exact English and Mandarin CPU pairs passed Android x86_64 emulator synthesis, decode, playback, lifecycle and independent local ASR content checks. The [acceptance report](validation/llama-rn-stage6/acceptance.md) binds each result to its source, APK, files and inputs, and separates current-source verification from earlier observations. Those results do not establish speed or compatibility on a physical ARM64 phone. Upstream examples, file checks and application tests do not establish intelligible speech on this app; actual listening, Russian speech and iOS/GPU/NPU execution remain unverified.

## Using the preview

1. The preferred voice configuration is OuteTTS 0.3 500M Q4_0 with its exact WavTokenizer large speech F16 codec. Open the voice chooser and select **Download recommended voice** to install both files (about 503 MiB) and select the completed pair. When already installed, **Use recommended voice** selects it. Reading settings never starts downloads or loads a context. An existing manual TTS choice is preserved until you explicitly choose another voice. Selecting or deselecting a model is explicit; deselecting also disables automatic selection. **Check files** verifies the selected file identities; it does not synthesize or prove model compatibility. TTS resources do not offer the embedding/reranker-only **Check load** action.
2. Open **Read aloud** in Chat, or the speech action on a completed assistant reply. The reply action captures that message and chat; it does not create another assistant turn.
3. Review or edit the text at the top. Tap the compact voice summary to change the admitted language or voice. **Exact synthesis input** reveals the complete input; structured output, code, tables and uncertain markup show it automatically and require explicit review. Ordinary prose has supported display markup removed.
4. Select **Create speech**. The resulting audio plays after native startup succeeds. Use the compact player to **Play**, **Pause** or **Replay**; Replay uses the existing clip and does not run inference again. **Stop** stays available during generation and playback. **Create new audio** starts a new synthesis.

Voice sample controls appear inside the voice chooser. Confirm permission explicitly before using a temporary sample. **Save this voice for later** reveals the optional name and save action; saving is never automatic. Voice preparation mode, file checks, memory estimates and third-party notices are grouped under **Advanced settings**. See the [manual audio check](audio-manual-check.md) for an end-to-end test.

Play first shows Starting. Playing appears only after native playback confirms the current request. A focus refusal or a 3-second unconfirmed-start deadline shows an explicit error; when cleanup succeeds, Play/Replay retries the retained clip without synthesis. Uncertain player disposal or file deletion blocks retry.

Input is limited to 240 characters. Formatted prompts are bounded to 512 tokens for the existing
profiles and Qwen, and 1,536 for OuteTTS 0.3 and NeuTTS Nano including their builtin reference codes. Entering longer
text preserves the whole draft and disables synthesis; the app does not silently shorten it.
Speech remains bounded to 16 seconds. A completion that reaches a generation limit, is interrupted,
or lacks natural end-of-sequence is rejected instead of playing partial speech.

Changing text, language, message, chat or model selection invalidates the request and clears its clip after native drain. Closing the preview, leaving Chat, backgrounding the app or resetting private data also stops and clears speech. Returning to the foreground does not resume playback. A cleanup failure remains visible and blocks unsafe reuse.

## Admitted profiles and requirements

The current profiles match exact backbone and codec SHA-256 identities, with revisions, sizes, metadata and licenses recorded in the [fixture manifest](validation/llama-rn-stage6/tts-fixtures.json) and [source record](validation/llama-rn-stage6/model-sources.md). Other filenames, quantizations or pairs do not inherit admission.

| Profile | Pipeline and application language | Decoder bound | Conservative peak-memory policy |
| --- | --- | --- | --- |
| OuteTTS 0.3 500M Q4_0 + WavTokenizer large speech F16 | `tokens`; English (`en`), builtin default (`en-us`) | One code per frame; 1,200 frames; mono 24 kHz; at most 384,000 samples | 2,020,891,040 bytes, about 2.0 GB |
| OuteTTS 1.0 0.6B Q4_K_M + DAC speech F16 | `tokens`; English (`en`) | Two codes per frame; 1,200 frames; mono 24 kHz; at most 384,000 samples | 2,677,219,552 bytes, about 2.7 GB |
| BlueMagpie Barbet 1B Q4_K_M + AudioVAE Q8_0 | `continuous_embd`; Taiwanese Mandarin (`zh-tw`) | 64 values per frame; four frames per generation step; 400 frames; mono 48 kHz; at most 768,000 samples | 9,066,120,384 bytes, about 9.1 GB |

These estimates are deliberately conservative, low-confidence admission policies, not measured resident memory or a guarantee that a device fits. The guarded native build avoids an unused second decoder owner only when nonempty metadata confirms a plain DAC or WavTokenizer large without any codec LM keys. The Oute policies still reserve stored codec weights plus full-file F32 casts, the unchanged 768 MiB graph reserve, exact F16 KV dimensions, the complete global payload/player allowance and 256 MiB workspace headroom. OuteTTS 0.3 has 24 layers, two KV heads and key/value widths 64; OuteTTS 1.0 has 28 layers, eight KV heads and key/value widths 128. The exact default OuteTTS 0.3 CPU profile sets `no_extra_bufts: true`, `use_mmap: true`, `use_mlock: false` and `n_gpu_layers: 0`. The pinned runtime wraps the existing CPU weight mapping and disables the extra repacking buffer, so its estimate reserves one backbone-file equivalent. Removing that flag restores two equivalents; OuteTTS 1.0 and all other profiles retain their prior two-copy policies. This option may slow prompt processing and does not establish measured speed. After the previous chat context drains, TTS checks the OS-reported allocatable memory minus its low-memory threshold and any process headroom. Raw free-page caps remain active under low or critical memory pressure. Unknown or insufficient memory blocks native initialization. The policy table uses decimal GB; the interface memory estimate uses GiB.

All profiles use CPU for the backbone and codec with one heavy context. OuteTTS 0.3 uses a 3,840-token context containing its complete 1,536-token builtin prompt and 2,304-step generation allowances. OuteTTS 1.0 uses 2,816 tokens for its complete 512-token prompt and 2,304-step generation allowances. Both use a 128-token batch and `embedding: false`: sampled codes need no retained backbone hidden states. Other profiles retain their 4,096-token context and hidden-state initialization. This is separate from document `embedding()` calls. Parallel mode remains disabled, `n_parallel: 1`, `state_cache_budget_mb: 0` and `state_cache_max_checkpoints: 8` remain unchanged. GPU/NPU TTS execution is not admitted by these profiles.

The recommended 0.3 pair pins [OuteTTS-0.3-500M-Q4_0.gguf](https://huggingface.co/OuteAI/OuteTTS-0.3-500M-GGUF/blob/ae0577d4386cfb6f442a610a1ec5f2a27d935fc4/OuteTTS-0.3-500M-Q4_0.gguf) and [wavtokenizer-large-speech-75tokens.gguf](https://huggingface.co/BricksDisplay/codec.cpp-gguf/blob/4cd6ecf17367ebc03bba4b2ce8186268a6ce7436/wavtokenizer-large-speech-75tokens.gguf). Its legacy builtin default is a bounded word/code payload, separate from native reference-speaker handles. F16 KV and `top_k: 4` retain the pinned upstream legacy synthesis settings. Physical speed and intelligibility require their own native acceptance; changing the recommended profile is not that evidence.

The existing speakerless paths need no phonemizer, reference recording or microphone.
`getTTSCapabilities().requiresPhonemes` is checked for the actual model. Stage 7 adds an explicit
offline English phonemizer for the exact NeuTTS Nano profile. An unsupported required-phoneme
profile remains a missing-prerequisite error; the app never passes ordinary text in place of phonemes.

`getTTSVoice`, `listTTSVoices` and `listTTSLanguages` are upstream reference-payload helpers.
Their contents or empty lists do not establish supported languages or prohibit a native speakerless
path. OuteTTS 1.0 must not receive the legacy Oute default word/code payload. The existing preview
now separates the admitted speakerless, builtin and reference modes. It never silently replaces a
missing named voice with the first catalog entry.

## Builtin voices and temporary or saved references

The [Stage 7 source manifest](validation/llama-rn-stage7/tts-fixtures.json) pins two additional
CPU configurations. NeuTTS Nano Q4_K_M + NeuCodec Q8_0 selects an actual helper payload from
`default`, `dave` or `jo`. Its model synthesis language is `en`, while its catalog and phonemizer
keys are `en-us`; those keys retain separate meanings. German/French catalog entries do not extend
this English model's language admission. The exact `phonemize@2.0.1` implementation uses bundled
English IPA data without network, Python or another language model. Input is bounded to 240
characters and output to 4,096 phoneme characters. Lazy module initialization has a two-second
budget; conversion and validation retain a separate one-second budget, allowing at most three
seconds for an admitted cold result. Cancellation is checked before and after each stage.
Over-budget synchronous calls are rejected after they settle. A synchronous JS operation must settle
before ownership is released. Applicable builtin reference text is phonemized explicitly because
the upstream handle and payload branches differ. Third-party notices are available in the preview.

Qwen3-TTS 0.6B Q4_K_M + its tokenizer Q8_0 admits speakerless English or a reference. Import a
short local sample or explicitly Record with the same bounded recorder used by Chat. Recording a
voice reference does not require an audio-capable chat model. Preview, replace or remove the sample,
then confirm that it is your voice or you have permission to use it. This confirmation is not
identity verification. Reference input is limited to eight seconds/2 MiB and is prepared as real
24 kHz mono PCM, at most 192,000 samples. Qwen's actual speaker encoder uses this PCM; the pinned
family does not use `refText` or emotion, so those controls are omitted.

Each synthesis creates a real context-owned `LlamaSpeaker`. Eager mode creates with `bake: false`
then explicitly bakes once; lazy mode lets the formatter bake once. A guarded native formatter
receipt confirms rows/baked for lazy preparation without a second encode. The handle is passed
to the real formatter and never fabricated or reused in a later context. Speaker release precedes
codec/context release and chat restoration. Late create/bake/format/decode calls keep their owners
until actual settlement; cancellation invalidates publication and cannot carry reference state
into the next request. Qwen's native `talker_embd` flow uses completion hidden states internally
and returns bounded audio tokens for decoding; the pinned TypeScript flow union omits this value.

References are temporary by default and never added to chat automatically. **Save voice** stores
the original source and a small consent/name/config record in the existing encrypted private store:
four voices, at most 2 MiB/eight seconds each, at most 8 MiB total. It stores no handles, embeddings or PCM
snapshot. Cold opening restores the saved choice without native initialization or capture.
Deletion invalidates selection and waits for active leases/native drain; it removes owned source
copies and preserves borrowed chat files. Temporary decoded/reference PCM and WAV derivatives
are plaintext only in bounded app-private cache excluded from backup, then removed after the
active file leases and native owners drain.

Neu's output is one codebook with at most 800 frames, 480 samples per frame at 24 kHz. Qwen's
output is 16 codebooks with at most 200 frames, 1,920 samples per frame at 24 kHz. The 16-second
decode bound is retained. Conservative admission includes duplicated codec loading, graph/KV
reserves, reference PCM/bridge copies and native speaker state; these estimates are not measured
device fit. Neu's corrected 576-wide, 24-layer geometry estimates 3,346,420,096 bytes; Qwen's
estimate remains 8,837,808,576 bytes. In the C15 physical Android API 34 ARM64 CPU voice run,
the first Neu/jo case failed `memory_insufficient` at `tts_admission`, with zero completed steps
or clip exports. Qwen was not reached. Neither estimate is a measured peak.

[Stage 7 acceptance](validation/llama-rn-stage7/acceptance.md) keeps native, spoken content and
reference-conditioning evidence separate. The chat recorder's seven-step physical microphone
result and recorded-input ASR do not establish generated speech or reference conditioning. Rows,
baked and differing WAV hashes are not evidence of voice resemblance. Russian speech, reference
microphone conditioning, Bluetooth/USB and iOS/GPU/NPU execution require separate verification.

The interface is localized in English and Russian. Russian speech is not admitted or verified. The wider language declarations in upstream cards do not extend these application profiles.

OuteTTS 0.3 weights declare CC-BY-SA-4.0 and the selected WavTokenizer conversion declares MIT. OuteTTS 1.0 declares Apache-2.0; the underlying DAC speech weights declare CDLA-Permissive-2.0. BlueMagpie's conversion card and base-model license disagree: the base card restricts use to research/evaluation and limits redistribution pending rights and consent. Keep BlueMagpie weights and generated speech in local evaluation; do not publish either. The pinned source record preserves the precise notices.

## Runtime and storage contract

The synthesis runtime initializes the vocoder, obtains capabilities, calls `getFormattedAudioCompletion`, and uses the returned prompt, grammar, embedding mode and flow together in normal `completion`. Token flow decodes final `audio_tokens` with `decodeAudioTokens`; continuous flow decodes final `embeddings` with its actual `embedding_dim` using `decodeAudioEmbeddings`. It does not use deprecated `generateAudioCodes`, parse text into codes, or normalize audio latents as retrieval vectors.

Validation requires natural EOS, a complete nonempty payload, the expected codebook or latent shape, finite mono PCM, the actual codec sample rate and bounded output. Application and guarded native checks bound frames multiplied by the actual decoder hop before decoder graph allocation, then validate decoded PCM before returning it. The continuous caller supplies frame-major latents; native code performs its own transpose.

Native decoders return floating-point audio, whose finite peaks can exceed the PCM16 range. Before writing a TTS WAV, the service attenuates the complete clip proportionally when its absolute peak exceeds one. It does not amplify quieter output, change samples in the decoder result, or alter sample count, rate, duration and file limits. The strict PCM16 encoder used by other callers keeps its original input validation.

The existing engine owner serializes chat A → TTS backbone/codec → A. Synthesis can also run without a loaded chat model. Restoration requires the original current selection, effective profile and ordered LoRA bindings to remain valid; a stale request cannot restore an earlier selection over a newer one. No speech text, audio buffers or latents are added to chat history or persisted application state.

`stopCompletion` requests interruption and the completion promise must settle. `initVocoder`, decoding and release have no public cancellation API in the pinned runtime: cancellation invalidates the request and waits for the actual call before releasing its resources. Timeout alone cannot release ownership. Uncertain native drain, vocoder release or chat restoration leaves an explicit error and blocks another job. There is no queued TTS work.

Playback owns one app-private, unencrypted ephemeral cache WAV. It is 16-bit mono PCM with a 44-byte header, bounded to 1,536,044 bytes (about 1.536 MB). The service retains only one clip. Clearing requires confirmed native player disposal, shared-object release and confirmed file deletion, in that order. Cold-start cleanup covers this owned clip; cache storage should not be treated as encrypted chat history.

The Expo configuration includes microphone permission solely for explicit bounded recording.
Background recording/playback and automatic resume remain disabled. One shared session serializes
recorder, sample preview and TTS playback, awaiting confirmed native disposal before handoff.
Local synthesis, recording, preprocessing and playback use no cloud service. Preparing missing
model files still uses the existing explicit download flow.

## Native build and verification

The app pins llama.rn `0.13.0-rc.3` and expo-audio `55.0.18`. Postinstall applies guarded source
patches in `patches/llama-rn-0.13.0-rc.3.js` and `patches/expo-audio-55.0.18.js`, including the
recorder helper. Existing decode/privacy and player focus/request/deadline/disposal protections
are retained. Stage 7 adds a native speaker bake receipt and opt-in asynchronous recorder
preparation/start/finalization/disposal, native duration/byte limits and foreground resume guard.
Legacy recorder/player behavior remains outside the opt-in changes. A fresh native APK or iOS
build is required. A JS update against an older binary cannot supply these native contracts.

Expo autolinking explicitly builds `expo-audio` from its installed source on both platforms. SDK 55 can otherwise substitute an unpatched prebuilt module. Keep this source-build admission when editing autolinking options; installed source hashes alone do not prove that a binary contains the player patch. Android acceptance must include the `expo-audio` source compilation tasks, and iOS acceptance must compile the patched Swift sources.

The audio package's `expo-asset` peer is explicitly pinned to the installed SDK 55 version, `55.0.20`. Leaving its wildcard peer unresolved can install a newer incompatible native AssetModule at the top level even while Expo retains a compatible nested copy. Native configuration verification checks the top-level manifest, lockfile and installed peer.

Run the explicit Android TTS pack only with a disposable isolated QA install and an absolute local audio-output directory outside this checkout and any published artifact directory:

```powershell
$env:POCKET_AI_TTS_AUDIO_OUTPUT_DIR = 'D:\LocalSpeechQa'
node scripts/android-scenarios.js --emulator --pack tts --apk-variant release --isolated-qa-install --fail-on-skip
```

The pack retains baseline scenarios and adds `runtime-local-tts-tokens` and `runtime-local-tts-continuous`. The QA surface is available only in the existing flagged QA build. TTS acceptance explicitly enables `POCKET_AI_QA_PRIVATE_FILE_ACCESS=1` for the isolated `.qa` application, so Android `run-as` can read synthetic app-private WAVs and verify their deletion. This makes that disposable release-variant QA APK debuggable while retaining its embedded release JS bundle and release native libraries. The guarded option rejects the production application ID and requires the QA and local debug-signing opt-ins. Normal release artifacts remain non-debuggable. The runner verifies affirmative private-file access before synthesis; an access error is never evidence of file absence.

Native receipts and local clip exports are separate from content acceptance. The runner copies synthetic clips locally for independent ASR; it does not upload speech or establish transcript correctness. Use actual listening or a local independent ASR transcript to compare each clip with the exact synthetic input, recording omissions, substitutions and early stopping. No cloud ASR or reference recording is needed. Delete owned clips when that local evaluation finishes; publish only compact sanitized receipts, never weights or BlueMagpie audio.

The [playback admission report](validation/llama-rn-stage6/playback-admission.md) records the new guarded contract, deterministic Kotlin focus-boundary tests and one fresh tokens-TTS/player/restored-chat run. For this narrow check, use `node scripts/android-scenarios.js --emulator --scenario runtime-local-tts-playback --apk-variant release --isolated-qa-install --fail-on-skip` with the same flagged private-file-access QA build; it performs one synthesis and needs no speech export directory.

The [Stage 6 acceptance report](validation/llama-rn-stage6/acceptance.md) records fresh native/content, no-loaded-chat synthesis and background clear/no-autoplay separately. Completed-answer Speak, EN/RU structured review and 241-character device entry retain their earlier APK scope. The separate clip synthesized without a loaded chat model has no content acceptance. Builds, nonempty PCM and player motion remain separate from intelligibility.
