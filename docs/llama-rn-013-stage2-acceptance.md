# Model resources Android acceptance

The explicit `inference` pack runs the existing CPU inference smoke first, then
`runtime-model-resources`. The second scenario uses the production download manager,
auxiliary selection service and the shared engine lifecycle. It never initializes a
separate QA context outside the resource owner.

## Pinned fixtures

| Resource | Identity |
|---|---|
| Chat A | Existing SmolLM2-135M-Instruct Q8 fixture from [stage 1 acceptance](llama-rn-013-stage1-acceptance.md) |
| Embedding B repository | `second-state/All-MiniLM-L6-v2-Embedding-GGUF` |
| B revision | `544f204f2eaa2d71361ffc74d6df7170285b286a` |
| B file | `all-MiniLM-L6-v2-Q8_0.gguf` |
| B bytes | `25008064` |
| B SHA-256 | `263215c3cadd6e16740741a7624ab4cbb6c8e777688bd5331ecfbf5681c2f8ed` |
| B expected embedding dimensions | `384` |

B is explicitly prepared through the ordinary queue, GGUF header verification,
expected size and upstream SHA-256 checks. Files may be reused only when the pinned
identity and integrity receipt match; the auxiliary service revalidates bytes before
native initialization. The scenario does not publish the embedding vector or input.

## Scenario and evidence

From the public repository root:

```sh
node scripts/android-scenarios.js --emulator --pack inference --isolated-qa-install --fail-on-skip
```

The isolated Release package and current source/APK provenance checks are required.
The pack is excluded from `all` and the default Android CI matrix. Both scenarios must
run in order in the same app process; stage 2 refuses to run without a passed baseline.

The stage 2 sequence loads A with CPU/context 512, generates real tokens, prepares B,
selects B for embedding without changing the chat selection, performs a real embedding
operation through the production service, confirms B's release and A's restoration,
then generates another real answer. It checks that the chat thread, its messages and
chat settings are identical across the B operation, the native context generation has
changed, and A still uses CPU/context 512. A short embedding output must have exactly
384 finite values. Counters and booleans are saved in
`artifacts/android-scenarios/model-resources-evidence.json`; vectors, prompts, answers,
private paths and raw native errors are excluded.

Native deadlines do not authorize another context. Failure stops the isolated QA
package, and uncertain native ownership skips in-app cleanup. Native operations have
a 120s scenario deadline; fixture download has a 300s deadline. Existing engine
watchdogs, fail-closed release handling and bounded operation drains remain active.

## Execution status

| Check | Status | Evidence / reason |
|---|---|---|
| Existing CPU inference smoke on stage 2 APK | not_run | Requires a new stage 2 APK and connected Android target |
| Native A → B → A sequence | not_run | Requires execution of the stage 2 scenario; stage 1 results are not substituted |
| Stage 2 APK / installed APK identity | not_run | Record source commit/tree and both hashes after building and installing |
| TTS synthesis / LoRA application | not_run | Outside this stage; companion readiness does not claim operation support |

Unit tests for the scenario and evidence validators check control flow and rejection
conditions. They are not native execution evidence. Update the execution table only
from the generated reports and verified installed binary identity.
