# llama.rn Stage 3 Android CPU acceptance

On 2026-09-24, the isolated Android QA application passed the Stage 1 lifecycle,
Stage 2 resources and Stage 3 inference packs on the same installed source-built
**llama.rn 0.13.0-rc.3** binary. This is Android x86_64 CPU evidence, not acceptance
of every model, advanced parameter combination or accelerator.

## Reproducible identities

| Item | Verified value |
| --- | --- |
| Public app source Git tree | `54432c35b0614511c88af839c63d98be4cd8188c` |
| APK and installed APK SHA-256 | `a6f83939059db6b7e3334067c78cf832c5bdf3522667f20d532dcf70104de786` |
| APK size | 82,006,154 bytes |
| Build provenance digest | `fb8940ce1def0ae36f761d32107b41f320bd4e927942b35b182c5356c491829d` |
| Package / variant | `com.github.tah10n.pocketai.qa` / release with embedded bundle |
| Device / packaged ABI | `sdk_gphone64_x86_64` emulator / x86_64 |
| Effective backend | CPU, zero GPU layers, no GPU acceleration |

The source tree identifies the application files built into this APK; later
acceptance-document edits do not change that binary. The [identity receipt](validation/llama-rn-stage3/cpu-evidence/identity.json)
records scenario durations and independently matched installed APK hash. The
[pinned corrections](validation/llama-rn-stage3/native-probability-patch.md) require
a native source build; no RC, Expo, React Native or Rust upgrade is involved.

Fixtures were downloaded through the existing managed artifact path and verified
against their pinned bytes. No weights or training outputs are committed.

| Fixture | Repository and revision | File / bytes | SHA-256 |
| --- | --- | --- | --- |
| Chat base A | `Mungert/SmolLM2-135M-Instruct-GGUF`, `980b4318b34b2f20e60c89d8f8a98283ec83cbd6` | `SmolLM2-135M-Instruct-q8_0.gguf`, 144,811,552 | `bc64cce8e1c11e4ed870633b557e04af718249c817c4cf8a6784116144ec3e28` |
| BehaviorTree LoRA | `unileon-robotics/SmolLM2-135M-Instruct-BehaviorTree-LoRA-GGUF`, `e211f41133cf7c6da0ae80b3a08f0ffbfd0653e9` | `f16.gguf`, 4,899,520 | `4c171a4599f159dc85dd904ea5fd73e91db11e1052e9106783fdd044b521b653` |
| Embedding B | `second-state/All-MiniLM-L6-v2-Embedding-GGUF`, `544f204f2eaa2d71361ffc74d6df7170285b286a` | `all-MiniLM-L6-v2-Q8_0.gguf`, 25,008,064 | `263215c3cadd6e16740741a7624ab4cbb6c8e777688bd5331ecfbf5681c2f8ed` |

Base and adapter declare Apache-2.0; the adapter's declared training dataset is
CC-BY-4.0. See [fixture sources and conditions](validation/llama-rn-stage3/lora-fixture.md)
and [Stage 2 embedding provenance](llama-rn-013-stage2-acceptance.md). Metadata
alone was not treated as native compatibility evidence.

## Passed native scenarios

- **Stage 1: 9/9.** Backend discovery, CPU loading, generation, stop after a token,
  generation after stop, new-chat isolation, unload, CPU reload and generation
  after reload. [Lifecycle receipt](validation/llama-rn-stage3/cpu-evidence/inference-lifecycle-evidence.json).
- **Stage 2: 9/9.** Response before auxiliary loading, finite 384-dimensional
  embedding, restoration of chat/settings, response after restoration, deletion
  of the unused embedding file without replacing the active context, and another
  response. [Resource receipt](validation/llama-rn-stage3/cpu-evidence/model-resources-evidence.json).
- **Stage 3: 27/27.** All steps in the [Stage 3 receipt](validation/llama-rn-stage3/cpu-evidence/stage3-evidence.json)
  passed. The grouped behavior and evidence limits follow below.

Ordinary generation and stopping passed. JSON object and a small schema with
required fields and enum were independently validated after native completion;
a simple GBNF result matched its exact constraint. Invalid schema and grammar
were rejected. Token-limited JSON was marked incomplete, not a validated result.
Structured cancellation recorded actual native `interrupted: true`, at least one
callback and drained completion ownership, with `structuredIncomplete: true`.
An ordinary request after those failures/cancellation completed successfully.

Custom Jinja template, kwargs, frozen `now` and prefill shared the exact prepared
prompt: token count, prefill `tokens_evaluated` and generation `tokens_evaluated`
were all **16**. Prefill predicted zero tokens and left history unchanged.
Tokenize/detokenize diagnostics passed for the fixture; this does not promise a
byte-for-byte round trip for special or media tokens.

Real `n_probs: 10` returned exactly one finite probability record for each
one-token probe, including repeated requests, adapter changes and restoration.
A selected numeric logit bias changed its observed probability from
**0.4091731011867523 to 1**. EOS suppression, invalid vocabulary ID rejection
and the following unbiased/default reset passed. These are token-distribution
measurements, not confidence in the correctness of a response.

## LoRA effect and restoration

The fixed behavior-tree instruction uses the same prepared prompt and sampling
configuration for every comparison: `temperature: 1`, `top_k: 0`, `top_p: 1`,
`min_p: 0`, repeat penalty 1, seed 42, `n_predict: 1`, `n_probs: 10`.
Each probe is a real bounded native completion. This protocol tests application
of the adapter, not the quality of generated behavior trees.

| Comparison | Shared observed tokens | Maximum absolute probability delta |
| --- | ---: | ---: |
| Repeated base baseline | 10 | 0 |
| Base → adapter scale 1 | 6 | 0.9160223230719566 |
| Base → adapter scale 0.5 | 9 | 0.7900679334998131 |
| Remove adapter → base baseline | 10 | 0 |
| A + adapter 0.5 → embedding B → restored A + adapter 0.5 | 10 | 0 |

The acceptance threshold was **0.000001**, exceeding measured baseline variation
of zero. Changing scale also changed observed probabilities: maximum scale delta
**0.12595438957214355**. Missing top-10 entries are censored, never assigned zero
probability. Only shared token identities support effect comparisons; restoration
additionally requires identical observed token support. No full-distribution
distance is inferred from truncated top-10 data.

`applyLoraAdapters`, `getLoadedLoraAdapters`, scale change and
`removeLoraAdapters` each had confirmed loaded-list readback. Removal restored
baseline probabilities. Auxiliary B produced 384 finite dimensions; restored A
retained the adapter at scale 0.5, its effective profile and unchanged history,
and completed another probe with the same observed distribution. Deleting the
applied adapter was rejected. Final cleanup confirmed an empty native adapter list.

LoRA probes may have zero streaming callbacks: this pinned bridge can buffer a
first token matching a partial stop prefix while retaining the final probability
record. The assertions inspect the actual final record, finite values, token
budget and terminal flags, and confirmed completion settlement. They do not
substitute a callback count or a randomly different text for evidence of effect.

## Manual UI checks

On the final APK identified above, the Russian Resources card passed explicit
companion binding, selection without automatic application, apply at scale 1,
draft scale 0.5 while confirmed scale remained 1, explicit application of 0.5,
and removal with confirmed empty native state. Mutation controls were disabled
while native state was unconfirmed. See the [LoRA UI receipt](validation/llama-rn-stage3/ui-evidence/lora-ui.json),
[applied scale 0.5](validation/llama-rn-stage3/ui-evidence/ui-lora-scale-half-ru.png)
and [removed state](validation/llama-rn-stage3/ui-evidence/ui-lora-removed-ru.png).

Earlier APK `53b68061fb0a767a4e2b16827e3548098c524eba92d3f0d6708ccc8a74359571`
passed manual checks of four exclusive output modes in
[English](validation/llama-rn-stage3/ui-evidence/ui-output-en.png) and
[Russian](validation/llama-rn-stage3/ui-evidence/ui-output-ru.png), preserved
selection across language changes, [validated JSON display](validation/llama-rn-stage3/ui-evidence/ui-json-en.png),
and exact clipboard copy/paste of the displayed 17-character JSON result.
[Advanced load controls](validation/llama-rn-stage3/ui-evidence/ui-load-ru.png)
showed separate K/V caches, requested/effective values and reload guidance.
The [earlier UI receipt](validation/llama-rn-stage3/ui-evidence/earlier-ui.json)
retains its LoRA binding failure and blocked scale/remove checks; those were
retested successfully on the final APK as recorded above. These manual UI checks
are separate from the three automated native packs on the final APK.

## Earlier failed attempts

These failures remain separate from the final passing run:

| APK SHA-256 | Result |
| --- | --- |
| `00e068e70b8a84e90c486174e2ceefe2f22c16120594785375d9c1944aa2cbd3` | Stage 1/2 passed; Stage 3 failed custom-clock template/prefill because the vendor core ignored `now`. Later steps not run. |
| `a5f7a011c85d42ac5f87c9ae5ab8c6ec1a05146e8dc3d4ebb2f698cb924443f9` | Stage 1/2 passed; source-core Stage 3 aborted after invalid grammar due to upstream sampler ownership. Later steps not run. |
| `c23e55570e72e0771a53d4cfec87374104dd8d10327e9a5ce8a1c9435957ce76` | Stage 1/2 passed; Stage 3 failed the old LoRA assertion requiring a streaming callback despite a final probability record. Scale/remove/auxiliary/deletion steps not run. This attempt is not LoRA-effect or robust cancellation proof. |
| Earlier APK `53b68061…` (first bootstrap) | Android System UI ANR overlay blocked bootstrap while the QA app was ready behind it. Inference not run on this attempt. After dismissing the overlay, the same hash-verified APK passed all three packs without rebuilding. |

The earlier APK `53b68061fb0a767a4e2b16827e3548098c524eba92d3f0d6708ccc8a74359571`
subsequently passed all native packs, but manual Resources-card testing found
that a prepared adapter could not be selected: equivalent source-URL aliases
changed the binding identity, and companion selection could use stale state.
Those UI binding defects were corrected before the APK identified above was
built. All three native packs were repeated on that new APK. The earlier native
pass is retained as evidence of its tested scope, not proof of the failed UI path.

The clock and ownership failures required the version/source-guarded native
corrections. The probability assertion was corrected to validate final native
records and terminal flags, while cancellation separately requires real native
interruption. An interrupted build before APK completion is not an inference run.

## Local checks and remaining boundaries

`npm run verify:release` exited 0 on the source used for the final APK:
TypeScript, Expo lint, native configuration checks, **242 Jest suites / 5165
tests**, Rust formatting/clippy/scaffolding, **68 Rust library tests and 3 host-bench tests**.
Deferred-promise tests cover late native settlement, partial adapter failure,
rollback, stale chat/variant restore, deletion ownership, and parameter isolation.
Those simulated failures are not claimed as physical-device fault injection.
Hosted CI is a separate gate on the published PR head, not implied by this local
command or native report.

| Not run | Concrete blocker / scope |
| --- | --- |
| iOS native build/inference | Acceptance host and isolated target were Windows/Android; no iOS build/device target was available. |
| GPU / NPU inference | The isolated x86_64 CPU emulator does not provide a supported physical accelerator acceptance target. |
| MTP execution | No compatible validated draft/base fixture was available; CPU LoRA results do not establish MTP. |
| Full sampler/load combination matrix | The pinned small fixture does not exercise every sampler, RoPE/SWA/MoE/cache/backend combination or model-specific reasoning template. These have typed mapping/validation tests, not universal native acceptance. |
| Multiple simultaneous adapters and injected native partial failure | Native fixture contains one compatible adapter; deferred lifecycle tests cover multi-adapter partial failure and uncertain settlement. |

A separate ARM64 host compile/link of
`rnllama_v8_2_dotprod_i8mm_hexagon_opencl` succeeded (341 translation units,
including three Hexagon sources), with ELF64/AArch64 and
`lm_ggml_backend_hexagon_reg` verified. Library SHA-256:
`e357aac24e2f90a27ab40a1e8f64fd1a252d2cc353d5dada40bf436e5bd14417`
(161,783,264 bytes). This preserves a build path; it is not JSI/APK, NPU-device,
or DSP-rebuild acceptance. Temporary compile outputs were removed after verification.

Native state-cache budget remains 0, checkpoint limit 8, `n_parallel: 1` and
parallel mode off. Tool execution, RAG/rerank products, synthesis, microphones,
context pools and saved sessions remain outside Stage 3.
