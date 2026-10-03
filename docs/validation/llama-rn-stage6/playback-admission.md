# Playback admission acceptance

This follow-up to Draft PR [#185](https://github.com/Tah10n/pocket-ai/pull/185) fixes a rejected or unconfirmed initial Play being reported as Playing. It keeps base `feat/semantic-document-retrieval`, dependency PR [#183](https://github.com/Tah10n/pocket-ai/pull/183), llama.rn `0.13.0-rc.3`, expo-audio `55.0.18`, the existing profiles and memory/duration limits. Synthesis and decode are unchanged.

The [earlier Stage 6 report](acceptance.md) retains its original source/APK/content identities. Its ASR, continuous-flow and retrieval results are historical evidence, separate from the new admission build.

## Start and cancellation contract

The opt-in native `playAsync(requestId)` reports command admission, not actual playback. Android rejects `AUDIOFOCUS_REQUEST_FAILED` and `AUDIOFOCUS_REQUEST_DELAYED` with distinct errors. A delayed request is defensively abandoned even when focus was never acquired. The existing default-player path remains separate.

The controller publishes Starting while it awaits both successful admission and a matching current-player/current-request native `playing: true` snapshot. Android uses actual `ExoPlayer.isPlaying`; iOS uses its actual playing state. Focus or loaded-file status alone cannot publish Playing. Confirmation arriving before the service's start drain settles remains observable; old player/request/failure events are rejected. Older paused/seek snapshots do not reject a newer start.

A 3,000 ms startup deadline rejects an admitted command with no playing confirmation. Rejection/timeout cancels the owned focus request and awaits real player disposal. A safe existing WAV remains available for explicit Play/Replay without inference. Disposal or deletion failures retain ownership and block unsafe reuse; timeout alone never proves disposal.

Stop, clear, preview closure, background and owner invalidation cancel pending starts before waiting for drains. Late GAIN cannot start a cancelled owner or resume a stopped player. Pause/Replay stays serialized, at most one player is owned, and WAV deletion follows confirmed disposal/shared-object release. Recording/background audio permissions and automatic resume remain disabled.

## Regression evidence

The initial integration run used the real service and playback controller with a loaded clip and a mock whose Play never emits synchronous `playing: true`. Both initial FAILED/DELAYED cases and GRANTED-without-confirmation failed against the old implementation: the request resolved and/or Playing was published instead of rejection. The first native branch run had eight failures and one pass; the new contract was absent. These were deliberate red regressions.

Final service/player/UI checks passed 78 tests. Deferred promises and fake timers cover explicit focus rejection, confirmation during start drain, delayed true confirmation, deadline, same-WAV retry without synthesis, old seek snapshots, stale player/request/failure events, Stop/clear during startup, interruption after playing, disposal failure and private/background clear. Preview tests verify localized Starting/refusal copy and an explicit retry with a retained clip.

The native harness `node scripts/test-expo-audio-focus-android.js` passed **14/14** cases. It compiles the guarded installed Kotlin request/release/play/listener/status bodies on the host JVM and substitutes AudioManager, Expo scheduling and player boundaries. It checks FAILED, DELAYED cancellation with acquired=false, GRANTED without playing, queued late GAIN after Stop/disposal/background, interruption/no-resume, retry, pre-O cancellation, stale playing transitions and coexistence with default players. This is executed Kotlin with native-boundary mocks, not Android instrumentation or a physical audio-route test.

Pristine apply, repeat apply, known-legacy migration and repeat migration passed. Unknown source bytes failed before any writes. All nine patched files matched the expected guarded hashes. `npm run verify:release` passed TypeScript, lint, **281 Jest suites / 6,330 tests**, AnyDoc/Rust and native configuration.

## New binary identity

The implementation source was published before building this fresh isolated QA APK. The later documentation commit does not change embedded/native build inputs.

| Field | Identity |
| --- | --- |
| Published implementation source | `4ae1bd34638a533c1b2be248e9166c1b77c0701d` |
| expo-audio patch script, canonical LF SHA-256 | `6b836ce0cefd3c9a81932edcdcc68d856d292bac1fc64535db036eeef05cac1c` |
| Windows CRLF script fingerprint in build provenance | `177e89182e154f13f32ac761fde0d62a9374079db0812a68bc303ccfdbfeb8b3` |
| llama.rn patch script, canonical LF SHA-256 | `ba414bf20cf41297c1f96252cd5d73cb6a18e9e59e1efe1138297204ce819a52` |
| Clean-input provenance digest | `e6b1ec986387e6fad57c18f82d1e3cc59222a64ec4bb77f18860c66d7de0d79c` |
| APK SHA-256 / bytes | `bf1542e1a1946efef8e3144cbd212ee1cb2f26e3918ba5fa23d633cf4b876788` / 88,990,094 |
| Install | `com.github.tah10n.pocketai.qa`, release, x86_64; installed full SHA-256 matches the APK |
| Fresh source compilation | 15m 54s; 594 tasks executed, including expo-audio Kotlin and llama.rn C++ |
| Device readback | Android 16 / SDK 36, x86_64 emulator; 16,384 MiB CLI RAM over the same isolated userdata |
| Permissions | No RECORD_AUDIO or media-playback foreground-service permission; existing data-sync service remains |
| Native/UI receipt SHA-256 | `09d73ba868aa26025b90be298cf26400ba0199541f39abf2a0fe8e90a7bb64c0` |
| Host scenario report SHA-256 | `3051e2fee814954e0f199db521b0266d298bf46738b07444b3c484ad9a7816b6` |
| Seven-screenshot/receipt archive manifest SHA-256 | `58e664dd6c819edf2592be0aad1647e0f81c8702e4f4861606a6798122e3f3e6` |
| Separate screenshot review SHA-256 | `a1fd0e9bc220cc946ee2d244c7e978ba6a3493170ff68fdeb82218505aa836db` |

The two expo-audio script hashes distinguish canonical source from Windows file bytes; the difference is line endings. Native source-build autolinking, fresh compilation and actual `playAsync` execution jointly support patched Android linkage.

## One real tokens-TTS flow

`runtime-local-tts-playback` passed on 2026-10-03 at 10:20:14 UTC. It performed exactly one synthesis using the existing second English fixture, OuteTTS/DAC CPU profile and an A profile with the existing ordered Stage 3 LoRA at scale 0.5. No new model family was downloaded.

Full hashes/sizes of all four installed files were independently read back after QA with the isolated app stopped: OuteTTS and DAC match [Stage 6 fixtures](tts-fixtures.json); SmolLM2-135M Q8 and its 4,899,520-byte adapter match [Stage 3 fixtures](../llama-rn-stage3/lora-fixture.json). The service also validates selected file identities before native init.

| Real emulator observation | Result |
| --- | --- |
| Synthesis → natural EOS → bounded decode | Passed; 472 codes, 75,512 mono samples at 24 kHz, 3.146333 seconds |
| Exact A + ordered LoRA restoration and unchanged chat history after synthesis | Passed |
| Initial Play | Passed; first host hierarchy observation was natural EOF, then rendered Replay/Pause established motion |
| Rendered Pause → Play/resume → Stop → Replay | Passed; observed paused positions 1.003 / 1.776 / 0.738 seconds |
| Same private WAV before/after controls | Both SHA-256 `43098b50ce73816e458b32c38ceda2d1882706d3c18152e0c2fab07362129e73`; synthesisCount remained 1 |
| Actual Playing → Android Home → return | Passed; native AppState observation required current Playing and clip availability |
| Background cleanup | Preview closed, clip removed, state cleared, no autoplay on return |
| Next ordinary engine chat request with restored A + LoRA | Passed; token callbacks/nonempty response and exact effective profile checked, without persisting a QA answer |
| Final cleanup and used-codec deletion refusal | Passed |
| Screenshot review | Seven fresh PNGs inspected; Playing and moving positions, launcher, closed preview and terminal cleanup agreed with receipts |

The deterministic refused-focus retry is covered by the Kotlin AudioManager boundary harness and real-controller/service integration tests; the emulator exercised successful playback of the same WAV. No refused system focus or physical route was induced on the emulator/USB device. The identical historical fixture WAV hash is a deterministic output match, not reuse of an old synthesis or content assessment.

## Failed attempts and not_run

- The first fresh smoke helper reported unsuccessful launcher status after a successful build/install. The app was actually running; a same-APK smoke retry confirmed its JS surface. The initial smoke failure remains failed.
- The first narrow native attempt on 8,192 MiB RAM rejected before synthesis with `memory_insufficient`, synthesisCount=0 and cleanup passed. The 16,384 MiB same-APK/same-files retry passed without changing memory admission. A MemFree readback after rejection is not an admission-time measurement or peak estimate.
- One retry was started before the emulator transport was ready and failed before native execution. It remains a transport failure. The successful retry waited for boot completion.
- UI hierarchy collection retried one transient dump failure during the successful run; the raw report retains it.
- Actual listening, new independent ASR/content assessment, continuous/BlueMagpie rerun, six-clip ASR pack, 36-case retrieval rerun, physical focus/headphone/Bluetooth tests, iOS execution and ordinary UI chat Send are `not_run`. This narrow change needs no synthesis/decode/profile reacceptance. Historical results retain their original identities.
- Initial test/build tooling failures from excessive host workers/heap reservation are separate from product behavior; the final bounded JVM native branch harness and complete release verification passed.

[Implementation-source CI](https://github.com/Tah10n/pocket-ai/actions/runs/37114247874) is separate from local emulator execution. The exact final report head, remote equality and completed hosted checks are recorded with [PR #185](https://github.com/Tah10n/pocket-ai/pull/185) at handoff; iOS build success does not claim iOS playback execution.

Stage 7, merge, Ready, release and deploy remain outside this change.
