# Stage 7 audio and reference-voice acceptance

Stage 7 remains incomplete. On one physical Android API 34 ARM64 device using CPU execution,
the recorder lifecycle, imported and recorded audio input, and recorded words passed. The first
Neu/jo voice case stopped at memory admission before synthesis. A separate manual ordinary capture
reached Attach and Send, with completed user/assistant messages and an observed audio attachment.
That capture has no controlled-content oracle; Playing was not observed. The same chat, complete
messages and audio attachment were retained after a cold reopen; file bytes and cold playback were
not checked. Reference conditioning remains unverified. Privacy results apply only to their respective
captured windows; the second manual window timed out, while the third completed across Send and
cold reopen with zero candidates and confirmed cleanup.

Dependency base: Stage 6 public commit `fb970529608beeac90f272106f45ad7a97a330df`,
Draft [PR #185](https://github.com/Tah10n/pocket-ai/pull/185), branch `feat/local-tts-playback`.
Stage 7 is a separate dependent Draft [PR #186](https://github.com/Tah10n/pocket-ai/pull/186)
on `feat/audio-input-and-reference-voices`.

The [audio fixture manifest](audio-input-fixtures.json), [TTS fixture manifest](tts-fixtures.json)
and [model/source notes](tts-model-sources.md) record exact selected artifacts and bounded policies.
The [controlled synthetic inputs](synthetic-inputs.json) pin actual source hashes and sample counts.
These locally generated Windows SAPI fixtures contain no user voice. The initial independent
tiny.en ASR check matched both reference sentences after punctuation normalization; the input's
numeric spelling difference remains part of its original word-error result. This establishes
fixture content only. Physical recording verification uses the controlled input played externally
and the actual microphone; its captured WAV has a separate identity from the source fixture.
Weights, raw recordings and ASR transcript artifacts are not committed with this report.
[outcomes.json](outcomes.json) is the
compact machine-readable record; it preserves the same incomplete scope and historical failures.

## Tested build and report identity

The tested APK comes from source `6457bb2b970d1b1c7c62d98c745394ec4308c956`, app tree
`ad17183d607086555f0e9abd6bfc7f6c75674ef9`. Its SHA-256 is
`587bf83581ef548dc6f50995c929c6bd46150a04a1d62f8dcb29db10a5c88f95` and its size is
145,674,409 bytes. Compilation and installation passed. Build-input digest:
`3444c67ecf234af68a8c2f17165a57b9c3964f8b71d91c8cadb068cdc81de9ed`.
The report identity is the Git commit that adds or last updates this report revision, resolved
from repository history rather than embedding its own SHA. That report commit is distinct from
the source that produced the tested APK.

The current normalized source patch SHA-256 is
`ac6071d8d49228d6f1473cffe1c0ccdbfe5a0733d32f33924225447d9eb57d28`.
Neu's corrected 576-wide, 24-layer geometry estimates 3,346,420,096 bytes; Qwen remains at
8,837,808,576 bytes. Qwen's estimate exceeds the test phone's entire 7,618,306,048-byte RAM,
making it incompatible with the current admission policy; this is not an observed Qwen load failure.
Both estimates are low-confidence policy values, not measured peaks. No memory, timeout, runtime,
profile or acceptance limit was waived.

## Independent evidence scopes

| Case | Actual outcome | Scope and limit |
| --- | --- | --- |
| Recorder lifecycle | Passed 7/7 | Start, finalize, prepare, preview, discard, retry, and background interruption with no automatic resume. |
| Imported audio input | Passed | Native CPU completion matched controlled content and drained. |
| Recorded audio input | Passed | Native CPU completion understood the actual microphone capture and drained. |
| Recorded word content | Passed | Independent ASR: 0 errors / 9 reference words, WER 0, exact normalized numeric match, complete input/model hashes before and after. |
| Neu/jo voice flow | Failed at admission | `memory_insufficient` / `tts_admission`, zero steps and zero clip exports. |
| Qwen voice flow | Not reached | The earlier Neu/jo admission failure stopped the flow; no Qwen failure or peak was observed. |
| Reference voices and generated speech content | Not run | No conditioning, create/bake speaker, saved-voice cold reuse, generated-word or speaker-similarity proof. |
| Ordinary composer | Incomplete | The first attempt failed host metadata collection (`ENOBUFS`) after explicit Record, with no sound, Attach, Send or Regenerate; it auto-stopped to Ready at about 29.5 seconds and actual Discard passed. A later manual Record was visually confirmed in two screenshots and auto-stopped to Ready at about 29.5 seconds. Its controlled-sound handoff missed the 15-second host guard, so no PC sound was played. Preview was invoked (Preparing then Ready; Playing unobserved), Attach and Send passed, and complete user/assistant messages with an audio attachment were observed. This capture has no controlled-content oracle. Regenerate was not run and was not needed for the bounded persistence check. |
| Ordinary cold attachment retention | Passed within UI identity scope | After exact app force-stop, confirmed process absence and a new app process generation, the same Home thread, complete user/assistant messages and audio attachment identities reopened. Eight fresh UI observations showed no recording sheet, Stop control or Recording phase, consistent with the pinned source foreground predicate. The final screenshot was reviewed and host cleanup passed. Native owner identity, recorded-file byte identity and cold playback were not checked. |
| Bounded privacy audit | Passed within the captured window | 1,687 application records / 256,959 bytes, zero candidates, no raw logs retained, and confirmed owned capture drain. Earlier failures and unobserved windows remain separate. |
| Manual follow-up privacy window | Incomplete | The second window timed out after 408 application records, with zero forbidden candidates, no raw logs retained, and confirmed cleanup. This is not a privacy pass. |
| Latest manual privacy window | Passed within the captured window | The third bounded continuous application-scoped capture covered manual Send and cold reopen: 478 records / 75,191 bytes, zero candidates, no raw logs retained, explicit audit-stop request observed and confirmed host/remote capture drain. Its device window was 17:02:52.129559–17:25:00.626501 UTC on 2026-10-05; its host window was 17:02:04.332–17:26:27.995 UTC. It does not cover the earlier manual recording capture, whose second window timed out. |

The recorder produced canonical mono PCM16 at 16 kHz: 331,766 samples, 663,576 WAV bytes and
20.735375 seconds of decoded audio. Capture wall duration was 20.850 seconds. The captured WAV
SHA-256 is `c10dfb7a106ce97e62161bd920a6902c12ae0a4ee80a14dfcce5fd08e111c907`.
The controlled native recorded-word result does not establish generated-speech quality or speaker
identity. The later ordinary Attach/Send observation is separate and has no controlled-content
oracle; its cold-retention proof covers reopened UI identities rather than file bytes or playback.
Imported controlled sound, emulator
injection and physical acoustic capture remain separate evidence scopes. Two authorized synthetic
references with one fixed target still require an independent speaker comparison; differing hashes, callback success and
rows/baked do not establish resemblance.

The first cold-check helper failed host admission before any device action; it does not establish a
device or cold-retention failure. The later bounded cold check passed without changing the tested
source, tree, APK or build-input digest.

The privacy audit covers device records from 2026-10-05 14:45:38.274280 UTC through
15:59:54.542422 UTC. Host capture ran from 14:43:19.194 UTC through 16:02:39.496 UTC; these are
distinct windows. Zero detected candidates establishes only this bounded captured scope and does
not retroactively accept earlier audits or guarantee every device route.

Saved reference originals and configuration are encrypted and bounded to four voices, at most
2 MiB/eight seconds each and 8 MiB total. Handles, embeddings and PCM snapshots are not saved.
Temporary decoded/reference PCM and WAV derivatives are plaintext only in bounded app-private
cache, with leases, drain-before-delete cleanup and backup exclusion. Ordinary chat attachments
follow their existing storage policy and are not separately encrypted by the saved-reference store.

No microphone request or recording starts before explicit Record. Background recording/playback
and automatic resume remain disabled. No paid build, self-hosted runner, merge, Ready, release,
deployment or Stage 8 is part of this acceptance.

Russian speech, Bluetooth/USB audio routes, iOS, GPU/NPU execution, generated speech content,
reference conditioning, restore proof and saved-reference cold reuse remain outside the demonstrated
scope. Existing Stage 6 observations retain their original scope and do not establish these cases.

## Current source verification

The final local release verification passed 293 Jest suites and 6,738 tests, 68 Rust unit tests and
3 integration tests, TypeScript, lint and native configuration checks. The first broad C15 attempt
failed and remains recorded separately. Local verification, source CI, compilation, installation
and device inference are separate proof categories.

The first C15 source-CI attempt passed API 34/35, iOS and deterministic jobs; API 32/33 failed on
native-glass UI locator timeouts. The one [failed-job rerun, attempt 2](https://github.com/Tah10n/pocket-ai/actions/runs/37323380729)
finished with API 32 passed and [API 33 failed](https://github.com/Tah10n/pocket-ai/actions/runs/37323380729/job/111847689200)
in `native-glass-theme-matrix`. API 33 compilation, installation, bootstrap and six preceding
scenarios passed. The host scenario's theme-restoration error masks the original failure; the
actual application cause remains unknown. No source fix or further CI rerun was performed.
Deterministic, native-scope, iOS and API 34/35 passed; Android QA was skipped and aggregate
verification failed. These source-CI results remain separate from Stage 7 device acceptance.

## Historical outcomes

Earlier native build and host-controller failures, startup/ANR and UI-producer failures,
phonemizer deadlines, incomplete voice/reference cases, an incompatible update signature, and
emulator/privacy interruptions remain recorded. C12 established imported-input content but did
not complete recording acceptance and reported two forbidden synthetic-prompt privacy candidates.
C13's broad verification failure and successful targeted SDK resolution check remain distinct.
C14 established four recorder steps and a separately recovered recorded-word result with 0/9
errors; its original export failure and incomplete seven-step lifecycle remain historical. C15's
new 7/7 and bounded privacy outcomes do not rewrite those attempts or their failed audits.

## Initial source verification before the fresh binary

`npm run verify:release` passed: TypeScript, lint, AnyDoc/Rust, 291 Jest suites /
6,468 tests and native configuration. An earlier broad run found a QA text-color token
violation and a reference-preview cleanup error mapping regression; both were repaired
before the successful final run. The opt-in recorder Kotlin boundary harness passed
14 cases, including queued prepare/start cancellation with zero late captures. The
streaming PCM core's JVM tests passed downmix/resample and finite-input/duration bounds.
These host checks do not establish Android codec, microphone, speech content or voice similarity.
