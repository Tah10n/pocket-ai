# Stage 6 local speech acceptance

This worksheet tracks app-specific acceptance of the bounded local speech implementation on llama.rn `0.13.0-rc.3`. At worksheet creation, all device and independent speech-content cases below are **not_run**. Source research and application implementation do not supply native or content results. Earlier Stage 1–5 acceptance keeps its original source/APK scope.

See [Local speech](../../local-tts.md), the [exact fixture manifest](tts-fixtures.json), and [model sources and upstream observations](model-sources.md). Do not store model weights, clips, private paths or raw native errors here.

## Required identity record

| Field | Current record |
| --- | --- |
| Public source revision and clean/dirty build state | `not_recorded` |
| APK SHA-256, package/install provenance and build variant | `not_recorded` |
| Device, Android version, total/available memory | `not_recorded` |
| llama.rn native source-patch identity | `not_recorded` |
| expo-audio native player-patch identity | `not_recorded` |
| Full local backbone and codec SHA-256 verification, both pairs | `not_run` |
| Generated recording/background permission configuration | `not_run` |

Fill these fields from the exact tested build and local full-file verification. Public Hub LFS identities and bounded header inspection in the source record do not replace full-file verification or APK provenance.

## Native, playback and content matrix

| Scenario | Tokens / English | Continuous / Mandarin | Evidence required |
| --- | --- | --- | --- |
| Exact files and separate Check files outcome | `not_run` | `not_run` | Full hashes, bytes, selected profile; no inference claim from a file check |
| CPU backbone and vocoder initialization | `not_run` | `not_run` | Actual backend and settled native operations |
| Capabilities and formatted flow | `not_run` | `not_run` | Family, prompt kind, phoneme requirement, returned flow and mode |
| Three short synthetic sentences | `not_run` | `not_run` | Natural EOS and complete bounded payload for every input |
| Decode sample rate, mono channels and finite PCM | `not_run` | `not_run` | Shape, frame count, sample count/rate and duration; no payload values |
| App-private WAV and native playback | `not_run` | `not_run` | Bounded file/header and actual player status |
| Play → Pause → Play → Stop → Replay | `not_run` | `not_run` | Confirmed player teardown; Replay starts no completion |
| Listening and independent local ASR | `not_run` | `not_run` | Per-sentence omissions/substitutions/early-stop review, ASR identity and local-only content comparison |
| Stop/drain → synthesize again | `not_run` | `not_run` | Cancelled completion settlement, codec release, repeat success |
| Unload → reload → synthesize | `not_run` | `not_run` | Confirmed releases and new native context/codec receipts |
| Loaded chat A + LoRA → TTS/codec → A → chat response | `not_run` | `not_run` | Effective A profile/ordered adapter restoration and successful ordinary generation |
| No loaded chat A | `not_run` | `not_run` | Independent TTS ownership without inventing a chat selection |
| Selection/text/language/source changes during work | `not_run` | `not_run` | Invalidation, actual native drain, no late playback or stale A restoration |
| Close, leave Chat, background and private-data reset | `not_run` | `not_run` | Player disposal and owned clip deletion; no foreground auto-resume |
| Init/decode/release failure and uncertain drain | `not_run` | `not_run` | Explicit sanitized error; native/file lease retained until safe settlement |
| Deletion while backbone/codec is leased | `not_run` | `not_run` | No deletion before confirmed release; shared-owner files retained |
| Measured peak memory and decoder bounds | `not_run` | `not_run` | Device measurements separate from conservative admission estimates |
| Synthetic canary logcat audit | `not_run` | `not_run` | No input, raw path, audio codes, latents or PCM in emitted logs |

Native `native_passed` establishes only the recorded protocol. Nonempty finite PCM, actual playback and a waveform duration do not establish that the requested words were spoken. Record content acceptance independently for every exported sentence. English receipts do not establish Russian support; Mandarin receipts do not establish all declared upstream languages or code switching.

## Ordinary interface and guard cases

| Case | Status | Required observation |
| --- | --- | --- |
| English and Russian UI, standalone preview and completed-assistant action | `not_run` | Real visible controls, localized states/errors, exact editable preview |
| Structured/code/table/uncertain-markup review | `not_run` | Reason visible, explicit confirmation and exact native text |
| Pasting more than 240 characters | `not_run` | Full draft preserved; synthesis disabled without silent truncation |
| Missing selection/files and Models navigation | `not_run` | Helpful preparation action after safe cleanup |
| Unknown pair, wrong codec, missing phonemizer and unsupported language | `not_run` | Fail closed before unsafe native work |
| Unknown/insufficient memory and concurrent chat/download/resource operations | `not_run` | Admission and busy guards hold; no parallel heavy contexts |
| Stale completion after edit/close/background | `not_run` | Cannot create or replay an invalidated clip |
| Player focus/route loss and confirmed cache cleanup | `not_run` | No unexpected resume; failure remains visible and ownership blocks reuse |
| Existing runtime, resource, Stage 3, local-tool and document-publication baselines | `not_run` | Exact current-source/APK baseline receipts |

Application tests, static/source checks, build/installation, ordinary UI observation, native execution and independent content review should each have their own result. Record unavailable cases with an exact reason; do not convert `not_run` into acceptance from an upstream report or another APK.

## Local-only clip handling

Use the command and `POCKET_AI_TTS_AUDIO_OUTPUT_DIR` instructions in [Local speech](../../local-tts.md#native-build-and-verification). The destination must be outside this checkout and published artifacts. Run independent ASR locally. Keep only compact sanitized counts, hashes, timings, model/build identities and content outcomes in public evidence. Do not upload weights or BlueMagpie speech, and remove task-owned local clips after evaluation.

## Result summary

Implementation: present. Exact device/native protocol: `not_run`. Ordinary interface observations: `not_run`. Independent English speech-content acceptance: `not_run`. Independent Mandarin speech-content acceptance: `not_run`. iOS and GPU/NPU TTS: `not_run`.
