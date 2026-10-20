# Stage 7 audio and reference-voice acceptance

## Current follow-up status

The [follow-up record](acceptance-followup.json) separates each source/APK and verification
scope. The committed decoder-repair tree passed 303 Jest suites / 7,095 tests,
Rust 68 unit plus 3 integration tests, TypeScript, lint and native configuration.
Published decoder-repair source `2ce8cbc` retains that exact gate; the 9fc7f4b gate
is historical. [Current source CI](https://github.com/Tah10n/pocket-ai/actions/runs/39505971231)
completed successfully: native scope, deterministic, iOS, Android API 32–35 and
aggregate verification passed; optional Android QA was skipped. PR Title and
Dependency Review also passed. Previous pending observations are retained. Historical
[9fc7f4b CI](https://github.com/Tah10n/pocket-ai/actions/runs/39494077396)
completed successfully after the addressed API 33 retry; all required jobs passed and
optional Android QA was skipped. Its first SDK archive-installation failure, before
app build or emulator startup, and the refused early retry remain historical.
This historical result remains separate from the successful current 2ce8cbc run. The earlier
`88125ab` and `2456272` gates retain their own source identities. Historical
[CI for `2456272`](https://github.com/Tah10n/pocket-ai/actions/runs/39479310782)
completed successfully, including Android API 32–35, iOS and final verification;
optional Android QA was skipped. Its Dependency Review and PR Title also passed.
A later report-only head needs its own CI check.
Stage 7 remains incomplete; memory admission and runtime limits were not waived.
Import remains bounded at 25 MiB; microphone preparation keeps 4 MiB/30 seconds,
and reference preparation keeps 2 MiB/8 seconds with native admission retained.

Managed WAV/MP3 import, cancellation rollback and cold byte/name preservation passed
through the storage harness on `2a40118`; ordinary picker/Attach/Send and inference
were not exercised by that harness. On `0663b5b`, four Qwen reference/no-reference/cold
clips passed fixed-target ASR. Both paired outputs ranked closer to their own reference
than to the other synthetic reference; this is limited conditioning evidence, not an
identity or naturalness threshold. On `5e926cd`, ordinary reference import retained the
editor, consent and Save worked, and Stop → drain → Delete followed by a cold launch
confirmed that the deleted voice did not return. These remain distinct tested builds.

The [resumed physical results](acceptance-resumed-20261020.json) retain source
`3b0e67e`, ARM64 APK SHA-256
`1fa2d0ac30794bd6a228e832f93a0e8685689199862382591b8c9aa01146583e`
and runtime patch SHA-256
`3e9f1d1f7098e46a8d92b5d3592a3d67ba1330a501137b42915c8c3ddc27391e`.
The original automated smoke command failed after successful installation; later
ordinary UI results do not rewrite that command's outcome.

Ordinary speakerless Oute TTS reached confirmed playback in 39.338 seconds on the
first in-process run and 38.604 seconds on repeat. Native generation took
16.274/16.356 seconds and decode 19.459/19.327 seconds. Both 3.306333-second WAVs
had identical bytes and independent fixed-target ASR WER 0. These are app-side
measurements, excluding host polling and ASR time. First-in-process is not OS cold
cache, and both runs initialized backbone and vocoder. Stop settled after native
completion during the post-completion/decode interval, with cancellation and no
resulting WAV; native generation/decoder preemption is not established. A fresh
retry took 38.671 seconds and matched the verified WAV hash. Ordinary chat A then
completed a response. These are baseline results, not timings for a later DAC change.

The ordinary microphone captured a controlled external synthetic phrase. Explicit
Stop produced 15.8824375 seconds of 16 kHz mono PCM16; Attach and exact-byte cold
retention passed. ASR had raw WER 1/9 (`7` versus `seven`) and numeric-normalized
WER 0. The automatic-cap case stopped at 29.35 seconds and passed preparation,
Attach and draft cleanup; its external playback was prevented by a UI XML error,
so it provides no acoustic-content evidence. Three ordinary WAV/MP3 imports
preserved their original filenames and bytes, including a 4,608,044-byte WAV.
MP3 and large-WAV draft removal preserved existing message-owned attachments.
Recorded audio and the 40-second imported WAV reached Send but failed with the
memory error; the other two Send cases were not repeated after that blocker.
Successful physical audio Send/inference and cold lifecycle following successful
inference remain unverified. The existing error-message attachment later passed
cold filename/byte retention on `9fc7f4b`, as recorded separately below. The later OS free-memory observation is not the exact app admission
snapshot. No admission limit was waived.

On source `2456272`, a fresh ARM64 build/install/smoke passed. Ordinary Oute first/repeat
playback latency was 28.457/28.670 seconds versus the 3b baseline's 39.338/38.604;
decode was 8.859/9.211 versus 19.459/19.327 seconds. First/repeat/retry WAV bytes exactly
matched the baseline ASR-checked output; no new ASR run is claimed. Stop settled with
no WAV; native completion had already finished, so preemptive interruption is not proven.
Fresh retry took 28.443 seconds and ordinary chat A then completed. Three OS memory
samples are reported as samples, not peaks or proof of memory reduction. Thermal state
and OS cache were uncontrolled. The post-run QA-only log snapshot had zero configured
candidates, with raw logs discarded; this is bounded screening, not universal privacy
acceptance. See [the exact-source comparison](acceptance-resumed-20261020.json).

On the separate `2456272` x86 APK, the fixed native audio-input scenario passed
on Android API 36 with 16 GiB RAM, CPU execution and unchanged admission policy.
Both the imported controlled fixture and the actual 15.8824375-second physical-phone
recording produced the expected bounded content, streamed callbacks and drained;
the prior chat profile was restored. The recording was captured on the phone, not
through an emulator microphone. The scenario took 616.237 seconds overall; per-input
native latency was not measured. These explicit input-step results are separate from
the generic TTS content-verification field, which remains not run.

Compilation and installation passed. The initial launcher-status smoke failed; later
independent inspection found a healthy QA Home, and the reused scenario smoke passed.
The original launch stdout was not retained, so no timeout cause is asserted. The separate ordinary emulator recording case completed an “Orange 7” response.
After a guarded cold reopen, the same messages and attachment bytes/hash/inode remained;
the displayed filename was still the managed basename instead of `recorded.wav`. The
encrypted store’s displayName was not directly read. This is an original-name rendering
failure alongside successful scoped inference and cold byte retention. After upgrading to `9fc7f4b` and another guarded cold launch, that same retained
message displayed `recorded.wav` in text and accessibility, with unchanged file
bytes/hash/inode. This recovers the stored original name through the fixed renderer
without raw encrypted-store extraction. No new inference was run; “Orange 7” remains
the `2456272` completion. The other three ordinary imports are reported below.
Neither emulator case establishes physical-phone Send.

The resumed record also identifies the shared Oute backbone, DAC codec and chat A
pins. Successful guarded application validation supports those identities; no separate
exported model-file hash receipt is claimed for these physical TTS attempts.

The renderer-only repair is published as `9fc7f4b`. Its three regressions failed
before the fix and the two focused suites passed 59 tests afterwards. The separate
x86 and ARM64 APKs built, installed with matching hashes and passed smoke. The x86
retained-recording name and cold check passed. On the phone, the existing
`forty-seconds.wav` message retained its full visible/accessibility name and identical
file bytes/hash/inode after cold launch. The initial post-cold observation was
interrupted by USB disconnect; a later reconnect completed the checks, while the
partial observation and screenshot/foreground errors remain recorded. No new Send,
inference, TTS or recording was run on the phone, and its earlier memory refusal
is unchanged. The existing DAC and native-input results retain their `2456272`
source/APK identities.

The three ordinary imports on `9fc7f4b` preserved their original names and complete
file bytes through Send and cold reopen. The 40-second mono WAV and MP3 completed
naturally. The MP3 answer matched orange/seven; the WAV answer appeared as a collapsed
Markdown list, so its full content remains unverified despite terminal completion.
The 4,608,044-byte, 24-second 48 kHz stereo WAV was accepted by the picker/storage but
Send failed with an unsupported-format alert. Its same error-message pair, attachment
name and bytes survived cold reopen. A host reproduction using the exact production decoder and pinned miniaudio found
that 48 kHz stereo to 16 kHz mono conversion estimated 384,001 output frames but
returned 384,000 at clean EOF, after consuming all source frames. The strict equality
check rejected valid output. The same investigation exposed a separate malformed-WAV
gap: removing four bytes without updating headers was accepted because the backend
clamped the input length. A bounded repair now passes 12 real host decoder cases,
after four relevant failures on the original implementation; two focused Jest suites
passed 128 tests, with TypeScript, scoped lint and independent review also passing.
The new patch identity and passing full release gate are recorded separately.
The published `2ce8cbc` ARM64 build, matching install and launch smoke passed
(12 minutes 46 seconds). APK SHA-256 is
`9227af2e57941fb68410290e4af9b9254948cca13bbfa936b05176e44953a913`
(145,823,813 bytes); build provenance digest is
`cd7ef6e8fc79f33547ce368a50b011c0092106523cd8f536bf1cc04537d7341f`.
This is not new physical inference. The x86 build/install/smoke also passed
(4 minutes 45 seconds), with APK SHA-256
`bd514de680ff52318d3d3dde5618220dda8f92776ed40d000ca7ed0b329b298e`
(92,329,054 bytes) and provenance digest
`355bde25d29e0d585b6ac75686ebb121708a94b2ffa51541f76035f3a3c04784`.
A single fresh ordinary Send of the unchanged large WAV then completed naturally,
without Stop, retry, observer timeout or admission waiver. The exact answer was
`Orange 7  The  The  The`: the fixed color and number were present, but extra
repeated words failed the strict answer format. Cold launch retained the original
filename, 4,608,044 bytes, SHA-256 and managed-file inode. UI TTFT was 458.274 seconds;
this is not native phase timing or TTS latency. No general speech or transcription
quality acceptance is claimed. The original 9fc device failure is retained; merely
relaxing the output comparison was insufficient. No fixture truncation or admission
waiver was used in these device cases. These results do
not constitute an overall four-case pass.

Cleanup verified removal of 27 exact task-owned output/cache targets after their
consumers stopped. Their pre-deletion logical sizes totalled 46,229,035,455 bytes;
this is not a physical disk-space saving measurement because the emulator image was
sparse. Source, both final APK/provenance archives, eSpeak preparation and small
verification evidence were retained; borrowed resources were preserved. At report
preparation the report-only commit was not yet published, so its CI was **not run**.
That later head requires its own check, separate from successful `2ce8cbc` source CI.

## Follow-up frontend diagnostic

The [Neu comparison on source `3b0e67e`](neu-frontend-diagnostic-3b0e67e.json) records
two actual x86 CPU synthesis runs with the same model, codec, Jo codes, seed and bounds.
The production frontend emitted 0.98 seconds and failed fixed-target ASR (WER 0.75).
Replacing both reference and target phonemes with the recorded canonical inputs emitted
2.72 seconds and passed that content check (WER 0). Both runs ended on the expected
speech-end token, decoded successfully and restored chat; the next chat completion passed.

This is diagnostic evidence, not production phonemizer acceptance. It does not isolate
reference versus target phonemes or establish a specific upstream defect. Stage 7 remains
incomplete. The record binds the exact tested source, APK, fixture and audio identities.
The phone results below retain their original identities and scope.

## Crossed frontend diagnostic

The [crossed Neu comparison on source `88125ab`](neu-frontend-diagnostic-88125ab.json)
separates reference and target inputs for the same fixed English case. Canonical reference
phonemes with production target phonemes failed ASR (WER 0.875; 5.74 seconds).
Recorded canonical target phonemes with the unchanged builtin Jo reference passed
(WER 0; 2.28 seconds). Both runs ended on expected speech-end, decoded successfully,
restored the original chat profile and were followed by a completed chat response.

For this case, target phonemes were sufficient; changing reference data alone was not.
The successful arm bypasses production target conversion, so this does not establish a
production frontend fix, general voice quality or a specific upstream defect. The record
keeps its exact source/APK identities separate from the preceding combined-input run.
Stage 7 remains incomplete.
The machine record includes reproduction through the existing isolated QA build and
**QA Stage 7 → QA diagnostic frontend A/B (not acceptance)** controls, including
the two clip-copy/continue gates and independent content checks.

## eSpeak integration preparation

A separate Windows host prototype compared the pinned eSpeak C API and canonical
frontend processing against bootphon 3.3.0/Neu's phonemes path. All 17 parity cases
passed, including punctuation, digits, Unicode, language-flag handling and the
240-unit boundary: 16 cases used the real API (41 calls), while punctuation-only
input required no C call. Scheduler tests used a blocking callback to verify
single-job ownership, cancellation/deadline settlement after drain, disposal and
bounded input/output. These scopes are distinct. The [resumed record](acceptance-resumed-20261020.json)
contains the pins and limitations.

This is host preparation only: no JNI/iOS implementation, mobile memory evidence
or Neu speech acceptance follows from text parity. The Windows binary is hash-pinned;
its independently reproducible relation to the separately pinned source was not
verified. The proposed native worker and source/data build remain future integration.
Existing MIT notices remain unchanged. A GPL-enabled combination, its Corresponding
Source/notices and distribution channel require a separate decision; bundled Neu/Jo
materials need their own rights/compatibility review. The licensing proposal has
not been applied to the product.

## Historical phone acceptance

The subsequent [audio interface handoff](ui-handoff.md) records the refreshed physical-device UI,
its separate APK and manual verification. It does not supersede the native limits below.

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

## Historical source verification

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
