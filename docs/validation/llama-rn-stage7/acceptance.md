# Stage 7 audio and reference-voice acceptance

Status: implementation source checks passed; new Android native/content/reference
acceptance has not yet run. This report will receive the published source, patch/APK identities
and actual results in a subsequent acceptance-report commit. Existing Stage 6 observations retain
their original scope and do not establish Stage 7 recording or reference conditioning.

Dependency base: Stage 6 public commit `fb970529608beeac90f272106f45ad7a97a330df`,
Draft [PR #185](https://github.com/Tah10n/pocket-ai/pull/185), branch `feat/local-tts-playback`.
Stage 7 is a separate dependent Draft PR on `feat/audio-input-and-reference-voices`.

The [audio fixture manifest](audio-input-fixtures.json), [TTS fixture manifest](tts-fixtures.json)
and [model/source notes](tts-model-sources.md) record exact selected artifacts and bounded policies.
Weights and personal recordings are not committed.
The [controlled synthetic inputs](synthetic-inputs.json) pin actual source hashes and sample counts.
An independent local tiny.en ASR recognized both reference sentences exactly after punctuation
normalization. It recognized the input as "The parcel is orange, and the code is 7."; the numeric
spelling difference is retained in the raw word-error result. This validates the fixture's content,
not app recording, model audio understanding or speaker conditioning.

## Independent evidence scopes

- Application/deferred tests and native source harnesses validate contracts and ownership.
- A fresh isolated Android CPU QA binary must establish actual capture, finalization,
  preprocessing, input_audio, builtin phonemization and speaker create/bake/format/decode/release.
- Imported controlled sound and emulator microphone injection remain distinct.
- Independent local ASR checks words, including novel target text; it does not establish resemblance.
- Two authorized synthetic references with one fixed target require a separate independent
  speaker comparison. Differing WAV hashes, callback success and rows/baked do not establish this.
- Physical acoustic recording, user USB device, Bluetooth and iOS execution are `not_run`.

No microphone request or recording starts before explicit Record. Background recording/playback
and automatic resume remain disabled. No paid build, self-hosted runner, merge, Ready, release,
deployment or Stage 8 is part of this acceptance.

## Source verification before the fresh binary

`npm run verify:release` passed: TypeScript, lint, AnyDoc/Rust, 291 Jest suites /
6,468 tests and native configuration. An earlier broad run found a QA text-color token
violation and a reference-preview cleanup error mapping regression; both were repaired
before the successful final run. The opt-in recorder Kotlin boundary harness passed
14 cases, including queued prepare/start cancellation with zero late captures. The
streaming PCM core's JVM tests passed downmix/resample and finite-input/duration bounds.
These host checks do not establish Android codec, microphone, speech content or voice similarity.
