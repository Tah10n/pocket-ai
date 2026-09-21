# llama.rn 0.13 Stage 1 Android acceptance

On 2026-09-21, `runtime-inference-lifecycle` passed through Pocket AI's
`LLMEngineService` → `LlamaRuntimeAdapter` → native `llama.rn`. This is a local
Android CPU result, separate from CI build and UI checks.

## Binary and model identity

| Field | Verified value |
|---|---|
| Public source commit | `04415f12bbb4a4ef79e42888758fdbaee1c764b4` |
| Public source tree | `b91a3278cdafbd70328022b3598177ab7f56f2b2` |
| Source state | Clean; the report-only follow-up does not change runtime sources |
| App / runtime | Pocket AI 1.6.3 (22), `llama.rn` exactly `0.13.0-rc.3` |
| Variant / package | Embedded-bundle Release, isolated `com.github.tah10n.pocketai.qa`, debug QA signing |
| APK and installed APK SHA-256 | `831d4942d0477811081842b52b08f065024190c52ccbad5871b457ca0e755697` |
| Target | Fresh Android emulator, `sdk_gphone64_x86_64`, API 36, packaged/matched ABI `x86_64`, 4 GiB configured RAM |
| Model repository | [`Mungert/SmolLM2-135M-Instruct-GGUF`](https://huggingface.co/Mungert/SmolLM2-135M-Instruct-GGUF/tree/980b4318b34b2f20e60c89d8f8a98283ec83cbd6) |
| Model revision | `980b4318b34b2f20e60c89d8f8a98283ec83cbd6` |
| Model file | `SmolLM2-135M-Instruct-q8_0.gguf` |
| Model SHA-256 | `bc64cce8e1c11e4ed870633b557e04af718249c817c4cf8a6784116144ec3e28` |
| Backend | Actual CPU; `actualGpuAccelerated=false`, `loadedGpuLayers=0`, one discovered device |
| Load policy | Context 512, `n_parallel=1`, parallel mode off, MTP off, state-cache budget 0 MiB / max checkpoints 8 |

The existing QA bootstrap verifies model bytes before registering the fixture.
The scenario runner checks build provenance and installed APK content. These checks,
JS BuildInfo, and download receipts are not native attestation. Native execution is
supported by the callback, completion, and native token-counter results below.
No weights, generated answers, documents, or local user paths are included here.

## Results

Build: **passed** (8m 56s). Installation: **passed**. App JS launch: **passed**.
Inference: **passed** (36.722s; completed at 12:45:51 UTC).

| Step | Result | Callbacks | Native predicted / evaluated tokens | Evidence |
|---|---|---:|---:|---|
| Backend discovery and CPU load | passed | — | — | Actual CPU diagnostics and runtime policy checked |
| Generate | passed | 15 | 14 / 36 | Nonempty final result, 81 characters |
| Stop after generation began | passed | 1 | — | 3 callback characters; active request stopped and driver drained within 15s |
| Generate after stop | passed | 15 | 14 / 91 | Nonempty final result, 81 characters |
| New chat isolation | passed | 15 | 15 / 36 | New store thread, no inherited history/summary; input contains only system plus new user message |
| Unload | passed | — | — | No active model or completion after unload |
| Reload on CPU | passed | — | — | CPU diagnostics and runtime policy rechecked |
| Generate after reload | passed | 15 | 14 / 71 | Nonempty final result, 81 characters |
| `document-docx-send` | passed | — | — | Same APK/model; native document processing and completed answer checked by the existing synthetic-fixture scenario |

The DOCX scenario completed at 12:50:07 UTC (182.276s including picker/navigation).
Its counters are not substituted for the dedicated inference evidence. Callback counts
need not equal predicted-token counts; exact answer wording is not asserted.
Machine-readable lifecycle evidence is [included separately](validation/llama-rn-013-android-cpu.json).

The first lifecycle attempt exposed a QA ownership race: ChatScreen automatically
reloaded the active thread's model during the harness's explicit unload. The QA-only
guard now suppresses automatic loading after this fixed smoke starts, including after
failure until process restart. Rendered-screen regression tests preserve normal
loading outside QA and before the smoke. No adapter rewrite was needed.

The earlier Windows Ninja failure was reproduced as a path-resolution failure for
the generated Nitro prefab config: the raw path was 262 characters while its normalized
path was 249, and only the normalized lookup succeeded. Building in a shorter checkout
resolved it. No generated Ninja files, native modules, signing guards, or integrity
checks were disabled. A fresh emulator avoided uninstalling an existing QA app with a
different signing certificate.

## Reproduction and scope

From the public repository root, with the Android toolchain and emulator available:

```sh
node scripts/android-scenarios.js --serial emulator-5554 --pack inference --isolated-qa-install --fail-on-skip --bootstrap-screenshot
node scripts/android-scenarios.js --serial emulator-5554 --pack documents --scenario document-docx-send --isolated-qa-install --skip-build --fail-on-skip
npm run verify:release
```

The local run selected `ANDROID_SMOKE_TARGET_ABI=x86_64`. `--skip-build` is accepted
only when current provenance matches. The inference pack is explicit and excluded from
`all`; it does not add weight downloads to the four-API CI matrix. Per-operation deadlines
are 120s, cancellation drain is 15s, and failure force-stops only the isolated QA package.
No second native context is started after an uncertain timeout.

Original-head CI [35591354318](https://github.com/Tah10n/pocket-ai/actions/runs/35591354318)
passed deterministic checks, Android native Release API 32/33/34/35, iOS unsigned
Release simulator build, and aggregate `verify`. Head was
`4c8c87e9a1dd2f24654969eeddd3281be8ee9803`, base
`f9818e6afb78b77c1829bf5f4dc2d49f949a2349`, and the job checkout log confirms merge SHA
`3001a9ae0e341bcdb75e705c40c601447097b3e7`. These are build/UI results, not inference
proof for that head. Final-head CI is tracked by the PR checks, separately from this
dated local binary record.

Local `npm run verify:release` passed: TypeScript, ESLint, 215 Jest suites / 4,575
tests, 68 Rust tests plus 3 documentation tests, and the native configuration contract.
The first concurrent build/test run hit three existing 5s adb-proxy test deadlines;
the full serial rerun passed without changing those deadlines. New regression coverage
checks missing model/evidence, empty generation, timeout, cancellation drain, QA ownership,
and sanitized output. Mock-based tests are separate from the native results above.

| Additional combination | Status | Reason |
|---|---|---|
| Reasoning / MTP | not_run | Prepared SmolLM2 fixture has no reasoning/MTP capability; no compatible prepared model |
| Images / audio | not_run | Text-only model; no compatible prepared multimodal model/projector or audio companion |
| Android GPU / NPU | not_run | CPU emulator only; no physical GPU/NPU target or Hexagon SDK validation |
| iOS inference | not_run | No iOS execution target on this Windows host; CI simulator build is not inference |
| Physical-device/OOM pressure matrix | not_run | No physical target or controlled pressure run in this acceptance |

See [the device validation protocol](runtime-hardening-device-validation.md) for wider
coverage. This result closes the targeted Android CPU lifecycle evidence gap, not the
unavailable backend/model/platform combinations above.
