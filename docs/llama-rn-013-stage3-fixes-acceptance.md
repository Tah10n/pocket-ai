# Stage 3 review fixes: Android CPU acceptance

**2026-09-25: the final APK passed all 49 Android CPU native steps, Reset all
UI acceptance and unsupported-grammar editor recovery.** Historical binary results
remain separate; the [earlier Stage 3 report](llama-rn-013-stage3-acceptance.md)
continues to describe its original source and APK.

## Final identity

| Item | Verified value |
| --- | --- |
| Runtime | `llama.rn 0.13.0-rc.3`, core built from source |
| Public application Git tree | `5fecb7c4d78005d4849e88845db870431036ec4d` |
| APK and independently matched installed APK SHA-256 | `48508d4338366589193cd3215cfad3496af48eb80a971ad7a6634494634e35c7` |
| APK size | 81,978,382 bytes |
| Build provenance digest | `5e6193d42afe14a5f9c53d3d4f36b06ed85f7279f06e7025042183dd9c4ddc9c` |
| Patch file SHA-256, raw bytes | `11320e2db159d629ec017d6c9b927e4a00d4ab0cc7c17cc0dfa10014fe7265a5` |
| Patched `cpp/common/sampling.cpp` SHA-256, LF-normalized | `d68916d80be1f3e3b1dd8ec238ab77cc23b8056394f3db49991eb2739fd0a1c2` |
| Package / variant / ABI | `com.github.tah10n.pocketai.qa` / release with embedded JavaScript / x86_64 |
| Target | `sdk_gphone64_x86_64`, 8 GB CPU emulator |

The [identity receipt](validation/llama-rn-stage3-review-fixes/identity.json)
records application and binary identity plus native scenario durations. Later
report-only changes do not change the binary. The [guarded source patch](validation/llama-rn-stage3/native-probability-patch.md#unsupported-grammar-backend-recovery)
requires a rebuilt native runtime; an old library or JavaScript-only update is
not evidence of the disabled-backend correction.

Fixtures reuse the [pinned base/LoRA manifest](validation/llama-rn-stage3/lora-fixture.json)
and [recorded embedding revision and hashes](llama-rn-013-stage3-acceptance.md#reproducible-identities).
Managed QA preparation verifies those artifacts. No weights are committed.

## Regressions reproduced and corrected

Tests first reproduced leading `%llguidance` passing the real
`prepareStructuredOutput` boundary. Shared preparation now rejects the unsupported
backend selector, while `root ::= "%llguidance"` remains valid GBNF. Editor,
hydration, regeneration and engine-boundary coverage check rejection before
native completion. The native patch replaces only the disabled-backend abort
with a static recoverable exception, retaining sampler cleanup. Postinstall tests
verify idempotence and refusal of unknown source fingerprints before writes.

Behavioral tests also reproduced advanced load overrides surviving Reset all and
Apply, including Reset all followed by a context-size edit. Explicit replacement
now removes omitted overrides; partial patches preserve untouched fields. Tests
cross controller, transaction, settings and native-init boundaries, including
rollback and stale selection. Reset removes the confirmed LoRA configuration and
updates the current thread snapshot after successful application.

Manual UI testing of the intermediate APK then exposed a stale saved-profile
subscription. Two additional tests first reproduced that defect; the controller
now observes settings changes and refreshes the reopened sheet. The final focused
regression run passed **226 tests**.

Final `npm run verify:release` passed **243 Jest suites / 5,242 tests**, TypeScript,
lint, native configuration, and Rust **68 library + 3 host-benchmark tests**.
The earlier 243-suite / 5,240-test pass predates the UI subscription correction.
Hosted CI on the final published head is a separate gate.

## Final native and UI results

| Check | Result | Evidence |
| --- | --- | --- |
| Stage 1 lifecycle | **passed, 9/9** | [Lifecycle receipt](validation/llama-rn-stage3-review-fixes/inference-lifecycle-evidence.json): generation, stop, next generation, unload/reload and next generation. |
| Stage 2 resources | **passed, 9/9** | [Resource receipt](validation/llama-rn-stage3-review-fixes/model-resources-evidence.json): embedding and chat restoration. |
| Stage 3 inference | **passed, 31/31** | [Stage 3 receipt](validation/llama-rn-stage3-review-fixes/stage3-evidence.json): shared rejection, ordinary recovery, similar GBNF terminal, malformed grammar, direct disabled-backend recovery, LoRA apply/scale/remove and A+LoRA → B → A. |
| Reset all → Apply | **passed** | Requested/effective cache and memory readback confirmed reset; pending Apply footer disappeared. |
| Reset all → context-size change → Apply | **passed** | Actual context 512 tokens, zero GPU layers, K/V f16, requested overrides Default and effective extra-buffer restriction Off. |
| Cold restart | **passed** | Context 512, requested cache defaults, effective K/V f16 and extra-buffer restriction Off persisted. |
| Grammar/prompt literal log check | **passed within recorded scope** | [Privacy receipt](validation/llama-rn-stage3-review-fixes/log-privacy.json); numeric token IDs remain present. |
| Unsupported grammar in editor → error → next ordinary answer | **passed** | [Editor recovery receipt](validation/llama-rn-stage3-review-fixes/editor-recovery-receipt.json): visible rejection, explicit Text mode, complete nonempty assistant response in the same process. |

The direct native probe uses the existing exclusive auxiliary-context transaction.
It requires the exact disabled-backend error, real generation on the same context,
and confirmed release. An uncertain native operation retains ownership until
settlement or isolated process teardown.

### Reset all user-path evidence

The applied fixture had K cache f32, V cache f16 and extra-buffer restriction On.
The UI confirmed requested and effective values. Reset all followed by Apply
changed both requested caches to Default and effective caches to f16; requested
extra-buffer restriction became Default and effective Off. The pending Apply
footer disappeared. Reset all followed by changing context to 512 and applying
showed actual 512-token CPU runtime and K/V f16. Cold restart retained the reset.

The [UI assertions receipt](validation/llama-rn-stage3-review-fixes/reset-ui.json)
contains exact `load-effective-*` strings, runtime init readback and source XML
hashes. Representative screenshots show the
[applied cache overrides](validation/llama-rn-stage3-review-fixes/final-overrides-cache.png),
[applied memory flag](validation/llama-rn-stage3-review-fixes/final-overrides-memory.png),
[reset caches](validation/llama-rn-stage3-review-fixes/final-reset-cache.png),
[512-token reset runtime](validation/llama-rn-stage3-review-fixes/final-reset-context-runtime.png),
[cold-start caches](validation/llama-rn-stage3-review-fixes/final-cold-cache.png) and
[cold-start memory settings](validation/llama-rn-stage3-review-fixes/final-cold-memory.png).
RoPE fields were default in this manual run. Tests cover their removal; these
captures do not claim a non-default RoPE native reset experiment.

### Unsupported grammar editor recovery

Entering `%llguidance` displayed: “Value not saved. Check the format, range or
supported schema; the previous setting is still active.” After explicitly selecting
Text mode, a normal request produced a complete nonempty assistant response in the
same process (PID 9151 before and after). The
[editor error screenshot](validation/llama-rn-stage3-review-fixes/final-unsupported-editor.png)
and [following response screenshot](validation/llama-rn-stage3-review-fixes/final-normal-after-editor.png)
are separate from the native direct-branch probe. No grammar restriction was
silently removed to manufacture a successful constrained response.

The final isolated process log check found zero occurrences of the five recorded
grammar/prompt literals: `root ::=`, `%llguidance`, `A friendly dog`,
`Resource compatibility check.`, and `generation_prompt:`. Numeric token IDs were
present. This bounded check does not establish that all logs are content-free.

## Historical attempts remain distinct

| APK SHA-256 | Provenance digest | Recorded outcome |
| --- | --- | --- |
| `16f43d88644cd4c0f65a4c9d864c7a09d1a27a25d37d05aea72e6fea16866ff0` | `69072ced68f738f09574d0f16bd2c466a6ad9b002ea4e0f116e2aa04aeaa7fd6` | Two runs on the 4 GB emulator: Stage 1 passed 9/9; Stage 2 failed at `embedding_check`, `operation_failed`. The UI confirmed a memory-admission warning. Stage 3 did not run. |
| `e3adba926ffa441eb732ad9a42448f079467e08110419ff833811fffe7ac5914` | `22e4976b0b3e53ab60f1e7ba5b8694de8883f38f7988cdfdfd77a5be2570f095` | Intermediate 8 GB run passed all 49 native steps, but subsequent manual UI testing found the stale profile subscription. This pass is not final UI acceptance. |

The emulator allocation increased from 4 GB to 8 GB after memory-admission
failures; application memory-fit policy was not bypassed. The intermediate
privacy check also found zero checked literal occurrences with numeric token IDs
present. Historical failures and intermediate successes retain their own binary
identities and are not rewritten as final results.

## Remaining boundaries

GPU, NPU, iOS native inference and MTP execution are **not_run** for this Android CPU target.
All requested Android CPU native and UI checks above passed. State-cache budget stays 0,
checkpoint limit 8, `n_parallel: 1`, and parallel mode off. Memory admission,
file ownership and transactional rollback remain in force. No new grammar backend,
dependency upgrade or Stage 4 feature is included.
