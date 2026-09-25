# llama.rn 0.13 Stage 4 acceptance

Android CPU native acceptance passed on 2026-09-25 for the exact source and APK below. Four scenarios passed: inference lifecycle, model resources, Stage 3 regression, and local tools. This extends the existing serial engine with bounded local functions; it does not establish general model or platform compatibility.

This work is on `feat/local-tool-calling` and depends on [PR #179](https://github.com/Tah10n/pocket-ai/pull/179), branch `feat/generation-structured-output-lora`, accepted base `047236f45667fa0f176c66fb311131573c4f0a72`. The public PR head and its checks are recorded in the PR body; the native source identity below identifies the actual build. Acceptance does not imply merge, release, or verification of later stages.

## Reproducible identity

The [sanitized identity](validation/llama-rn-stage4/cpu-evidence/identity.json) records the installed APK match and scenario results.

| Item | Identity |
| --- | --- |
| Runtime | Exactly `llama.rn 0.13.0-rc.3` |
| Public app tree built and tested | `02c96702cdb4385a04d818c65a47229fa58b4e8d` |
| APK and installed APK SHA-256 | `69f824ce55f7201c0eea86092416ebaf55b71de515c8458fdc830b19d0103646` |
| Build provenance digest | `d4e031c401fde540b66c487e7dc5334d4e957ef65ed9e97beed670c1fc068a8f` |
| Platform | Android release QA package, x86_64 emulator, CPU, embedded bundle |
| Model | `bartowski/Qwen_Qwen3-0.6B-GGUF`, `Qwen_Qwen3-0.6B-Q8_0.gguf` |
| Model revision | `60b85c0e3d8fe0f6474f406922a26d12aca4550d` |
| Model bytes / SHA-256 | 804,753,824 / `c159d1518f16bc42533d9a09f034eb598b670341adc2b08b9a9751614aea71eb` |

The [fixture manifest](validation/llama-rn-stage4/tool-fixture.json) pins the model. The [guarded source patch](validation/llama-rn-stage3/native-probability-patch.md#stage-4-token-sequence-privacy-extension) preserves earlier corrections and removes reconstructible serial token/text diagnostics. All twenty protected sources are checked before mutation; unknown drift is rejected. The [source identities](validation/llama-rn-stage4/cpu-evidence/source-identities.json) record exact raw and LF-normalized patch/native hashes. Source validation is separate from device evidence.

## Native results

The [local-tool receipt](validation/llama-rn-stage4/cpu-evidence/local-tools-evidence.json) distinguishes proposals, completed executions, returned results and final output checks.

| Case | Result |
| --- | --- |
| Required calculator | Passed: two native completions, one parsed call and execution, exact result 42 forwarded to the model, final reference present, completion drained |
| Automatic calculator selection | **Observed without selection:** one native completion, zero parsed calls and executions. Ordinary JSON resembling a call was correctly not executed. This is not successful automatic tool execution. |
| Ordinary automatic answer | Passed with zero calls and executions |
| Attached-document search | Passed: one parsed call and execution, result forwarded, expected reference found, current-chat membership and actual locator verified |
| JSON Schema final answer | Passed: three native completions, one calculator execution, exact parsed answer 42, valid structured output |
| Stop | Passed: one native proposal, zero executions, cancellation and completion drain confirmed |
| Ordinary generation after Stop | Passed with nonempty output and drained completion |
| Cleanup | Passed: chat history retained and previous model profile restored |

[Cold reopen](validation/llama-rn-stage4/cpu-evidence/local-tools-cold-reopen.json) confirmed unchanged history and no reexecution: four recorded calls, three completed. The cancelled proposal remained unexecuted.

All 49 baseline steps also passed: [nine lifecycle steps](validation/llama-rn-stage4/cpu-evidence/inference-lifecycle-evidence.json), [nine model-resource steps](validation/llama-rn-stage4/cpu-evidence/model-resources-evidence.json), and [31 Stage 3 steps](validation/llama-rn-stage4/cpu-evidence/stage3-evidence.json). These include `generate → stop → generate` and `unload → reload → generate`; a successful build alone is not their proof.

## Contract and limits

[Local tools](local-tools.md) documents permissions, errors, history, output phases and limits. Tools remain off by default. Only final native parsed calls can execute, sequentially; streaming fragments and ordinary JSON cannot. Selection preserves native tool grammar/parsing. Structured output and content prefill use a separate final phase with immutable definitions and tool choice `none`.

The pinned choice modes are `auto`, `none`, and first-round `required`. The rc3 wrapper mishandles the parallel option, so omission preserves the native default false. Compatible differential autoparsing is supported; arbitrary JSON extraction is not a fallback.

Runs allow four rounds, eight calls, 4,096 argument bytes, 8,192 bytes per result, 32,768 total result bytes, 180 seconds overall and ten seconds per tool. Token budgets and document limits remain enforced. Attached-document ownership is checked at execution; the QA prompt supplies an actual attached ID without supplying the answer. Search uses existing document parsing, not embeddings or reranking.

## Earlier failures and verification boundaries

[Historical native receipts](validation/llama-rn-stage4/cpu-evidence/attempt-history.json) and [local verification runs](validation/llama-rn-stage4/cpu-evidence/verification-history.json) retain failed and successful attempts separately. Earlier attempts are not retroactively marked passed. One baseline embedding check failed with an unspecified category before a same-APK retry passed. A subsequent tool attempt failed before a native receipt. Two later runs executed the calculator correctly but failed an overly strict final-string assertion. Text-reference observation was then separated from exact schema-answer validation, with actual answers retained for local semantic inspection.

Automatic mode returned ordinary JSON rather than native calls; the final report explicitly records this optional non-selection. An earlier document proposal invented an unavailable document ID and was rejected. That demonstrated the access guard, not successful search. Providing the actual attachment ID and clearer static guidance preserved the guard and enabled the final successful document case. Earlier UI checks found raw protocol framing and an empty completed-tools panel; subsequent checks confirmed their removal.

Full local release verification passed 254 suites / 5,441 tests, 68 Rust library tests, three Rust host tests, typecheck, lint and native configuration. An earlier full run had one 5-second mocked ADB timeout; its isolated unchanged-source retry and later full runs passed. Hosted CI is not asserted here.

Final-source visual review confirmed the [completed document search](validation/llama-rn-stage4/screenshots/final-document-result.png): the real attached document ID, chunk index 0, source offsets 0–49, untrusted-source flag, matching reference and correct final answer were visible. The [structured answer and cancelled call](validation/llama-rn-stage4/screenshots/final-json-stop.png) showed validated `{"answer":42}` and a cancelled calculator proposal without a result. The [required-calculator screenshot](validation/llama-rn-stage4/screenshots/final-required-calculator.png) showed the correct numeric result without raw protocol tags. The [English](validation/llama-rn-stage4/screenshots/final-tools-en.png) and [Russian](validation/llama-rn-stage4/screenshots/final-tools-ru.png) tool controls were reviewed for localization and fit. A new chat showed tools off by default; English was restored after the check.

The [app-scoped log audit](validation/llama-rn-stage4/cpu-evidence/log-audit.json) checked 2,957 available lines for the verified isolated QA app UID. It found zero matches for the tested calculator arguments, document sentinel, visible answer and token-dump patterns. This is evidence about that bounded buffer and those patterns; it does not establish absence of sensitive data in every log path or on other platforms.

Native iOS, physical GPU/NPU execution, other models/templates, tool execution with media, all document formats, and `get_current_datetime` model-selected execution remain unverified by this fixture. Automatic tool selection is model-dependent; the controlled automatic calculator case did not select a call. An additional manual check with all three tools enabled also returned ordinary JSON containing the result 42 without an execution panel; it does not demonstrate automatic tool execution. Earlier Stage 1–3 reports retain their original source/APK and verification scope.
