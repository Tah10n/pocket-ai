# Audio interface handoff

The audio interface is installed on a physical OnePlus 9 Pro for manual testing. Chat has one
**Read aloud** entry. The recording sheet has one primary action for each phase, a visible timer,
and Preview / Record again / Attach after the file is ready. Read aloud starts with the text and
current voice summary; model details and voice preparation settings are under **Advanced settings**.

This is a UI handoff, not completed Stage 7 native voice acceptance. The earlier [acceptance
report](acceptance.md) retains its own APK, content checks, failures and not-run cases. The
[manual check](../../audio-manual-check.md) describes the remaining user flows.

## Binary and source

The tested source is `c6cbb5de27be493982da11201db1396ca3c5bcf4`, app tree
`73f7923a27f2461eba4d9a7f2afcebf8568def37`. The report is a subsequent documentation commit,
identified through Git history. The ARM64 APK is 145,676,133 bytes, SHA-256
`3c787a2e2d5ff2b6cfde672aa73c611c990e42091f8f12bb38c22b996b4bd3e0`.
The build-input digest is `9ab700da2ebceb51bfb7a19ec5568a2136acd024f22f7351f2f814e1b58422f6`.
[ui-handoff.json](ui-handoff.json) records the normalized source-patch digest and screenshot identities.

Compilation, required native-library packaging and a data-preserving `install -r` passed.
The package UID was unchanged. This manual QA binary uses
`EXPO_PUBLIC_ANDROID_QA_SHOW_CONTROLS=0` to hide technical test actions; evidence and admission
gates remain enabled. Automated QA keeps its normal default. No runtime version or safety limit changed.

## Physical observations on this APK

| Check | Observation and limit |
| --- | --- |
| Chat | Technical QA action block absent; ordinary composer and Read aloud visible. |
| Text | The complete controlled sentence “The blue door is open.” remained after dismissing the keyboard. The keyboard covers lower controls while open; Android Back exposes them again. |
| Recovery | Missing-model message opened Models. Downloaded Neu and its installed codec were explicitly selected through model resources. |
| Voice choice | English, Default, Dave and Jo appeared for Neu. Selecting Jo updated its radio card and the summary. This proves UI selection only. |
| Recording | Idle, explicit Record, Recording, Stop, Preparing compatible audio and Recording file ready were observed. The ready take showed 00:22. |
| Preview / retake | Preview showed a Stop action. Record again entered a new Recording state. Playing, audible content and file bytes were not independently verified in this follow-up. |
| Close | Closing during the second capture returned to the empty chat without an attachment. A final package-scoped Android appops query reported no active microphone. File deletion was not independently inspected on-device. |

These observations used the normal interface, not hidden QA action buttons. The microphone had
already been authorized. This follow-up does not re-prove first permission denial, background/cold
retention, audio content or speaker conditioning. No raw recording is included in these artifacts.
Physical UI checks used English; Russian screen appearance was not checked on this device.

Screenshots: [chat](ui-chat.png), [Read aloud](ui-read-aloud.png),
[voice choice](ui-voice-selection.png), [recording](ui-recording.png),
[ready take](ui-recording-ready.png). All show only the QA interface and controlled test state.

## Host verification and failures

The broad release verification passed 293 Jest suites / 6,749 tests, 68 Rust unit tests and
3 integration tests before the final small QA flag and voice UI fixes. The final changed-code
verification passed five suites / 422 tests, plus TypeScript, lint and native configuration.
The recorder suite passed 15 cases, including cancellation and retake races. These are host results.

Two compile attempts were interrupted by host-controller ownership-file errors: first an active
JSON file-sharing exception, then a denied atomic replacement during a read. Those are preserved
as failed attempts, not attributed to an established application Rust defect. The third compile
passed 615 tasks with stable source inputs and an append-only ownership journal.

Two phone UI screenshot sequences lost SDK USB transport after an input. The task-owned ADB
server was restarted under the existing authorization; completed screenshots were hash-checked.
At final shutdown, the controller failed on an optional missing property under strict mode after
draining the server. An independent audit confirmed the ADB server and harness absent and port
5037 released. This host bookkeeping failure is separate from the device UI results.

Source [CI run 37369429710](https://github.com/Tah10n/pocket-ai/actions/runs/37369429710), attempt 1,
failed because a job was not acquired by a hosted runner. A single failed-job rerun on the same
source passed deterministic, native scope and Android API 32 at the report snapshot; other native
jobs were still running and Android QA was skipped. Consult the run for its final result and
the PR checks for the subsequent report head. Cancelled, skipped and pending jobs are not passes.

## Native voice limit

The previous Neu/jo attempt refused synthesis at memory admission. Qwen's policy estimate exceeds
this phone's total RAM. Those are the limits described in the earlier acceptance report, not new
native outcomes for this APK. Native built-in voice output, phonemization, reference create/bake,
R1 → R2 → no reference, generated-word content, saved-voice cold use and A+LoRA restoration remain
unverified. A visible voice option or completed UI check does not establish any of those results.

Recording/input_audio and speaker/phonemizer acceptance must be reported separately. A memory
refusal is a refusal; decoder bounds and admission must stay enabled during manual testing.
