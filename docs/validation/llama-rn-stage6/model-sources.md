# Stage 6 TTS fixture sources

This is a source and acceptance-input record for llama.rn `0.13.0-rc.3`. Exact remote file identities are in [tts-fixtures.json](./tts-fixtures.json). Their SHA-256 values come from public Hub LFS metadata. A bounded GGUF header inspection confirmed the architecture and codec fields. It did not download or hash the complete weights, and it does not prove loading, memory admission, synthesis, playback, or content correctness on this app.

All app-native and independent content acceptance results remain **not_run** here. Store compact results separately after running the exact app build and file identities. Synthetic acceptance sentences contain no user content. Do not store model files or audio in this directory.

## Tokens fixture

Use [OuteTTS 1.0 0.6B Q4_K_M](https://huggingface.co/OuteAI/OuteTTS-1.0-0.6B-GGUF/blob/7e8de3b4d95e100812fd7e6f4372510d0830a798/README.md) with `ibm-research--DAC.speech.gguf` from the pinned codec conversion repository. The backbone is 401,741,952 bytes and codec 147,786,400 bytes. The codec is F16, despite its unqualified filename. The [base Oute card](https://huggingface.co/OuteAI/OuteTTS-1.0-0.6B/blob/e7bcd87b0ca47fd8c46317c8f745a5e4e19c7b5c/README.md) declares Apache-2.0 and fourteen languages. This acceptance plan covers English only; Russian and other declarations are not app verification.

The underlying [DAC speech weights](https://huggingface.co/ibm-research/DAC.speech.v1.0/blob/1ea7f64cd0678415e2d8c32d67b190722cb9b149/README.md) declare CDLA-Permissive-2.0. A conversion repository's general MIT label is not a replacement for that weight license.

The pair needs two files and no external phonemizer or tokenizer. Omit speaker for the native speakerless path. Oute 1.0 must not receive the legacy Oute default-voice payload. Its source card recommends temperature 0.4, top-k 40, top-p 0.9, min-p 0.05, repetition penalty 1.1 and a 64-token repetition window. A longer penalty window can disrupt the generated sequence.

[DAC decoding](https://github.com/mybigday/llama.rn/blob/v0.13.0-rc.3/cpp/codec/src/models/dac.cpp) consumes two integer codes per frame, each in 0–1023, and emits mono Float32 PCM at 24 kHz, 320 samples per frame. Reject incomplete frames and out-of-range codes before decoding: native code can drop a partial frame or clamp a code. A policy cap of 1,200 frames therefore bounds the decoder input to 2,400 codes and nominal output to 384,000 samples, or 16 seconds. Generation token count also includes nonaudio grammar/text tokens.

## Continuous fixture

Use the two files in [BricksDisplay/BlueMagpie-TTS-GGUF](https://huggingface.co/BricksDisplay/BlueMagpie-TTS-GGUF/blob/1f195f06506314c1de4a4d35cad2e77b28cfe7db/README.md): `BlueMagpie-Barbet-1B-q4_k_m.gguf` (693,008,608 bytes) and `BlueMagpie-AudioVAE-q8_0.gguf` (1,089,523,904 bytes). This is the verified repository spelling. The Barbet hidden width is 1,536, matching `codec.lm.hidden_dim`. The backbone includes its GPT2-family BPE tokenizer. The codec includes the continuous LM adaptor, FSQ, RALM, LocEnc, LocDiT/CFM, projections, AudioVAE decoder and stop head. No user reference, speaker file or phonemizer is required for this speakerless research path.

The conversion card labels the weights Apache-2.0, but the pinned [base model card](https://huggingface.co/OpenFormosa/BlueMagpie-TTS/blob/4c2c5bcb7e87041a8eaba9df5821ec7a3e1d0c6c/README.md) labels its license `other`, limits intended use to research/evaluation, and restricts redistribution of weights or generated speech pending rights and consent. Keep this fixture and its generated clips in local evaluation. Do not publish audio or weights. The upstream intended languages are Mandarin and mixed Mandarin/English; this acceptance plan uses Taiwanese Mandarin only.

[The tagged AudioVAE decoder](https://github.com/mybigday/llama.rn/blob/v0.13.0-rc.3/cpp/codec/src/models/bluemagpie_audiovae.cpp) accepts frame-major latent vectors of dimension 64. Native code transposes to channel-major internally; callers must not transpose or normalize audio latents. One generation step emits four frames, 256 latent elements and 7,680 samples at 48 kHz (0.16 seconds). Output uses `codec.decode_hop_size=1920`; `codec.hop_size=640` belongs to the 16 kHz encoder. A 100-step/400-frame policy cap bounds input to 25,600 latent elements and output to 768,000 samples (16 seconds). Native CFM uses cfg 2.8 and nine timesteps in this tag.

The [upstream verification script](https://github.com/mybigday/llama.rn/blob/v0.13.0-rc.3/scripts/verify_tts.py) observes unstable very short prompts. Use the synthetic complete Mandarin sentences in the JSON. Upstream tagged README observations about Android CPU output and content checks are useful selection evidence, but are not results for this app, APK, devices or exact candidate files.

## Contract and termination

Use the [tagged JS API](https://github.com/mybigday/llama.rn/blob/v0.13.0-rc.3/src/index.ts), [types](https://github.com/mybigday/llama.rn/blob/v0.13.0-rc.3/src/types.ts), [speaker formatting](https://github.com/mybigday/llama.rn/blob/v0.13.0-rc.3/src/tts.ts) and [voice registry](https://github.com/mybigday/llama.rn/blob/v0.13.0-rc.3/src/tts-voices.ts), together with installed package sources. `TTSCapabilities` has only `type`, `promptKind`, `family`, `requiresPhonemes` and `defaultLanguage`. It does not list all languages, codecs, memory requirements or working backends.

Initialize the backbone with `embedding: true` for codec-LM/continuous hidden states. Treat formatted `prompt`, `grammar`, `embedding` and `flow` as one result. `tokens` uses `result.audio_tokens` and `decodeAudioTokens`; `continuous_embd` uses `result.embeddings`, `result.embedding_dim` and `decodeAudioEmbeddings`. Obtain rate from `getAudioSampleRate`. Do not parse text for codes, use chat templates, or normalize latents as retrieval vectors. `generateAudioCodes` remains deprecated compatibility API.

Empty voice/language lists do not prohibit speakerless synthesis. Explicit `speaker: "default"` can throw, including Oute 1.0, while omission activates native formatting. A `requiresPhonemes` configuration without a suitable phonemizer is a missing prerequisite.

[Native completion](https://github.com/mybigday/llama.rn/blob/v0.13.0-rc.3/cpp/rn-completion.cpp) can stop a failing codec-LM step and return partial arrays without a rejected promise. Continuous natural stop sets `stopped_eos`; exhaustion does not reliably set `stopped_limit` on every path. Require a natural `stopped_eos` and reject interruption, truncation, context exhaustion or truthy limit flags. JSI actually returns boolean limit/word flags even where TS types differ. A decoded nonempty waveform alone does not establish completion or text correctness.

`stopCompletion` marks interruption; drain the completion promise. `initVocoder`, decode and release have no public cancellation API. Invalidate the request and await the call before release. `releaseVocoder` nulls native ownership; context destruction also releases any remaining vocoder. Serial confirmed release then context release is safe. Failed or uncertain cleanup must retain the native/file lease. See [bridge task ownership](https://github.com/mybigday/llama.rn/blob/v0.13.0-rc.3/cpp/jsi/RNLlamaJSI.cpp) and [vocoder ownership](https://github.com/mybigday/llama.rn/blob/v0.13.0-rc.3/cpp/rn-llama.cpp).

## Memory and private diagnostics

The [native wrapper](https://github.com/mybigday/llama.rn/blob/v0.13.0-rc.3/cpp/rn-tts.cpp) loads the same codec twice through codec and audio_lm. Backbone plus two codec file lengths are 697,314,752 bytes for Oute and 2,872,056,416 bytes for BlueMagpie. These are file-size accounting baselines, not measured resident memory. [Default matrix preparation](https://github.com/mybigday/llama.rn/blob/v0.13.0-rc.3/cpp/codec/src/runtime/tensor_utils.cpp) may materialize F32 codec matrices from quantized storage. Full-clip decoder graphs, KV/hidden states, native and JS arrays, encoding copies and player buffers add memory. Unknown memory costs must not be treated as zero. Device admission and peak measurements are pending.

The guarded package patch removes Chatterbox's first-40-character text log, backbone load-failure paths, and the audio_lm raw error warning that can include a codec path. It preserves fingerprinted source preflight and accepted earlier migrations. Host-only TTS runners that print input are excluded from Android's codec source list. No PCM/latent/code values were found in the selected DAC/Blue decoder diagnostic paths; this source audit does not replace native logcat acceptance with synthetic canaries.

## Playback dependency

[Expo SDK 55 audio documentation](https://docs.expo.dev/versions/v55.0.0/sdk/audio/) and installed Expo agree on `expo-audio ~55.0.18`; the installed package is 55.0.18. Plugin defaults enable Android recording permission and background playback. Playback-only configuration needs `microphonePermission: false`, `recordAudioAndroid: false`, `enableBackgroundRecording: false` and `enableBackgroundPlayback: false`, followed by inspection of generated Android/iOS configuration. Explicitly dispose the player, stop on backgrounding, and never auto-resume. The package describes stopping when headphones or Bluetooth disconnect.

## Pending acceptance

For each selected fixture, independently verify the downloaded full-file SHA, native load, formatted flow, natural completion, payload shape, nonempty finite decode, actual sample rate and channels, temporary WAV sizes, and real playback. Listen to every short synthetic input and compare an independent local ASR transcript to it; record omissions, substitutions or early stopping. No cloud ASR, microphone or reference recording is needed.

Run stop/drain/retry, release/reload, A→TTS+codec→A with full profile restoration, deletion leases, error cleanup and player controls. Keep upstream observations, source-contract checks, JS regressions and real-device/content evidence separate. Language/backend claims remain unverified until those exact scenarios pass.
