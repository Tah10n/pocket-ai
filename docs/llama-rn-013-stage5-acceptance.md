# llama.rn 0.13 Stage 5 acceptance

Android CPU native acceptance passed on 2026-10-01 for the exact source and installed APK below. All five scenarios passed, including the earlier inference, resource, generation-profile and local-tool baselines. The Stage 5 protocol completed fourteen steps and all 36 frozen English/Russian ranking cases across three app processes and two cold reopens. Ordinary English/Russian document controls and measured touch targets were verified separately on the same source/APK, with the capture and answer-quality limits below.

## Reproducible identity

The [sanitized identity](validation/llama-rn-stage5/cpu-evidence/identity.json) binds the public source, embedded fixture, guarded runtime patch, built APK and installed APK. The [fixture manifest](validation/llama-rn-stage5/retrieval-fixtures.json) and [model sources](validation/llama-rn-stage5/model-sources.md) retain the model revisions, file hashes, licenses, languages and preprocessing contracts fixed before native results.

| Item | Identity |
| --- | --- |
| Public source built | `bff98b9c8e239b87167359c0359670ce0fb288e1` |
| Public app tree built and tested | `1816478ae629aa07c2d8cd27645b7a5097b9e1fc` |
| Runtime | Exactly `llama.rn 0.13.0-rc.3`, upstream commit `6cf681be300bc115e6580dd120e7e7606906dacd` |
| APK and installed APK SHA-256 | `22e491805c5520ab61b3a2ff078d4c7d969295aab175106df4da122d16e97ece` |
| APK bytes | 82,255,506 |
| Build provenance digest | `9df1a118aca28afb003e9f53530a33817b7be18c492ef8e49931879b210c7490` |
| Guarded source patch SHA-256 | `5093423b44e29c70a6757c61a59bfa986af7f7909b8e63c9333359bda1253cf4` |
| Embedded retrieval fixture SHA-256 | `b71691fda62cfbcb3e7114eaaa95654c52bbba46595b05e65fa570a524429eb7` |
| Platform | Android release QA package, x86_64 emulator, CPU, embedded bundle |
| Embedding B | Pinned multilingual E5 small Q8_0, mean pooling, native L2 normalization, 384 dimensions |
| Reranker C | Pinned BGE reranker v2 m3 Q4_K_M, rank pooling, raw relative scores |

The sanitized native receipts contain fixed fixture IDs, structural locators, operation counts and finite diagnostic categories. Raw prompts, answer text, vectors, scores, probabilities and local file paths are excluded from those receipts. The separately linked ordinary UI screenshots intentionally retain synthetic fixture questions and answers. Source validation and JavaScript tests are separate from native inference proof.

## Native protocol

| Scenario | Result | Duration |
| --- | --- | ---: |
| [Inference lifecycle](validation/llama-rn-stage5/cpu-evidence/inference-lifecycle-evidence.json) | Passed | 28,175 ms |
| [Model resources](validation/llama-rn-stage5/cpu-evidence/model-resources-evidence.json) | Passed | 68,090 ms |
| [Stage 3 generation profiles](validation/llama-rn-stage5/cpu-evidence/stage3-evidence.json) | Passed | 77,235 ms |
| [Local tools](validation/llama-rn-stage5/cpu-evidence/local-tools-evidence.json) | Passed | 193,065 ms |
| Document retrieval | Passed | 345,847 ms |

The earlier baselines include `generate → stop → generate`, `unload → reload → generate`, and the mounted production hook's interrupted-output recovery. [Tool cold reopen](validation/llama-rn-stage5/cpu-evidence/local-tools-cold-reopen.json) and [recovery evidence](validation/llama-rn-stage5/cpu-evidence/local-tools-recovery-evidence.json) retain their individual outcomes. Passing the local-tool scenario does not establish reliable automatic selection for every model; its controlled automatic calculator case remains an observed zero-call answer.

The [warm receipt](validation/llama-rn-stage5/cpu-evidence/document-retrieval-evidence.json) has the first ten steps, the [first cold receipt](validation/llama-rn-stage5/cpu-evidence/document-retrieval-cold-evidence.json) has twelve, and the [final cold receipt](validation/llama-rn-stage5/cpu-evidence/document-retrieval-deleted-evidence.json) has all fourteen. The fixed case results agree across these barriers.

| Step | Native result |
| --- | --- |
| Prepare models | Exact pinned fixtures verified |
| Prepare corpus | Four committed direct-text documents produced twelve structural paragraphs |
| Stop preparation | One document embedding started and settled; cancellation drained, A and its effective profile restored, no ready index published |
| Prepare indexes | Twelve document embeddings settled; four indexes published; zero query embeddings and rerank calls |
| Corpus rankings | All twelve queries executed in Keywords, Hybrid and Hybrid with rerank; no failure or fallback |
| Repeat query | Zero document embeddings; one query embedding and one rerank call; original native indexes mapped |
| LoRA handoff | A with its ordered LoRA profile → B → C → restored A → real answer; profile and probability configuration restored, native idle barrier awaited |
| Tool and JSON Schema | Real `search_attached_documents` call in Hybrid mode with rerank off; owned ID and locator matched, result returned, final schema answer validated and history committed |
| Stop search | One query embedding settled; cancellation drained, no rerank call or continuation |
| Next query | Fresh query embedding and rerank succeeded after Stop; no document vectors recomputed |
| Cold reuse | Four matching indexes reconciled after restart; zero document embeddings, one query embedding and one rerank call; no tool reexecution |
| Delete corpus | Committed fixture chat and derived indexes removed |
| Deleted reuse | After the second restart, deleted files remained absent and old IDs were rejected before any native operation |
| Cleanup | Previous chat/model profile restored; fixture data absent and completion drained |

The LoRA answer evaluated all 159 prompt tokens and returned 95 characters. Its prompt used the actual selected paragraphs `lab-guide/lab-204` (chunk 0, source offsets 0–100), `equipment-rules/equipment-317` (chunk 0, offsets 0–94), and `lab-guide/lab-240` (chunk 1, offsets 102–189). The receipt records ordered native candidate indexes and profile/probability restoration checks without exposing text or probabilities.

The tool case used three native completions and one genuine search call; all 641 final prompt tokens were evaluated, with 114 output characters. The actual mode was `hybrid` with no fallback. Tool reranking within the unchanged ten-second per-tool deadline is **not verified**. Independent corpus and LoRA handoff cases establish C's native execution; they do not establish tool+C execution under that deadline.

## Measured ranking quality

[Ranking metrics](validation/llama-rn-stage5/cpu-evidence/ranking-metrics.json) retain every frozen query. Each mode has twelve queries, six English and six Russian, with fourteen query-to-paragraph relevance judgments. The four-document corpus has twelve physical paragraphs; a paragraph can be relevant to more than one query. Recall@3 is averaged per query after deduplicating embedding subchunks by original paragraph. Successful execution is distinct from retrieval quality.

| Mode | Mean Recall@3 | English | Russian | Failures / fallbacks |
| --- | ---: | ---: | ---: | ---: |
| Keywords | 0.583333 | 0.583333 | 0.583333 | 0 / 0 |
| Hybrid | 0.791667 | 0.750000 | 0.833333 | 0 / 0 |
| Hybrid with rerank | 1.000000 | 1.000000 | 1.000000 | 0 / 0 |

The nonzero relevant-rank counts are Keywords: rank 1 ×6, 2 ×1, 3 ×1, 4 ×1, 6 ×2, 8 ×2, 12 ×1; Hybrid: 1 ×8, 2 ×2, 3 ×1, 4 ×1, 5 ×2; Hybrid with rerank: 1 ×11, 2 ×2, 3 ×1. These small synthetic-corpus measurements do not establish general ranking quality, language coverage or parser-format coverage.

## Runtime and storage boundaries

[Document processing](document-processing.md) documents the default Keywords mode, explicit Hybrid preparation, optional rerank, bounded source enumeration, encrypted indexes, fingerprints, quotas and fallback. [Local tools](local-tools.md) documents current-chat ownership and the unchanged 180-second run / ten-second tool deadlines.

B and C run serially on CPU with 512-token contexts, zero state-cache budget and at most eight checkpoints. Every complete input is checked against the pinned 511-token cap, including prefixes and automatic specials. B uses `query: ` / `passage: ` prefixes and native L2 normalization. C uses raw scores; its actual native pair layout and detokenize/re-tokenize counting differ from the upstream Hugging Face pair template. The measured results apply to this exact conversion and runtime. A process also guards the native embedding function's static dimension across embedding contexts; 384 is this fixture's dimension, not a universal requirement.

Publication requires current committed attachment ownership and, when a loaded A was suspended, verified exact-A restoration. Preparation can run without a loaded chat model. Lexical fallback or answer continuation after admitted native work requires confirmed safe drain and a verified restoration receipt. Stop waits for the real native callback and source work to settle before release. Cancellation, uncertain drain, ownership loss or private-mode transition does not create hidden lexical fallback or continue the answer. Ordinary model/configuration/vector failures may use bounded Keywords retrieval with an explicit actual mode and reason. Tool search never silently prepares missing indexes.

## Earlier attempts and local verification

[Selected attempt history](validation/llama-rn-stage5/cpu-evidence/attempt-history.json) keeps earlier failures and the first complete acceptance separate from attempt 18. Attempt 10 passed baselines, all rankings and LoRA handoff but failed the tool step with `operation_failed`; its timing suggested a deadline issue, while the receipt did not identify the rejected suboperation. Attempt 12 passed all ten warm steps but failed host cold-navigation before invoking the cold action. Attempt 13 stopped at a stale QA checkpoint precondition with zero retrieval steps or cases. Earlier attempts failed the Stop-preparation check; the exact failed condition and underlying cause remain unresolved. Later attempts used changed diagnostic sources, and subsequent complete attempts passed. Attempt 16 passed baselines, Stop preparation and index creation on source `09fd79be39708bde2e905dfe2f644eab069d9ff9`, then the host hierarchy read timed out after two recorded ranking cases. It was not complete native acceptance. Attempt 17 independently completed the whole protocol on that same historical source/APK after restart and remains passed.

A later ordinary preparation review found that an early admission rejection could leave the preparation owner claimed and conceal the failure status. The narrow settlement correction releases ownership and records failure for that path. Attempt 18 rebuilt the corrected source and completed the whole native protocol independently; the ordinary UI checks below are separate.

The [exact-source release verification](validation/llama-rn-stage5/cpu-evidence/verification-summary.json) passed 266 Jest suites / 5,861 tests, 68 Rust library tests and three host tests, typecheck, lint and native configuration. Separate two-suite / 69-test diagnostic and three-suite / 219-test preparation runs passed; these counts overlap the full verification and must not be summed. Hosted CI and earlier-stage reports retain their own source identities and scope.

## Ordinary UI verification

The [ordinary UI receipt](validation/llama-rn-stage5/cpu-evidence/ordinary-ui/evidence.json) binds the same public source/APK to separate English/Russian control checks after the native scenario actors closed. It uses the repository's 869-byte multilingual Markdown fixture and a generated 227,602-byte, 384-paragraph cancellation/retry document. Screenshots show only synthetic repository/generated sample questions and answers; they are separate from the sanitized native receipts.

| Check | Observed result | Evidence |
| --- | --- | --- |
| EN/RU controls and fresh-chat defaults | Keywords selected; local rerank off | [English](validation/llama-rn-stage5/cpu-evidence/ordinary-ui/default-en.png), [Russian](validation/llama-rn-stage5/cpu-evidence/ordinary-ui/default-ru.png) |
| Downloads attachment and first Keywords turn | File attached and ownership committed; the first turn completed correctly. Its legacy-compatible actual-mode label was not recorded | [Receipt](validation/llama-rn-stage5/cpu-evidence/ordinary-ui/evidence.json) |
| Preparing and progress bar | Visible in both languages | [English](validation/llama-rn-stage5/cpu-evidence/ordinary-ui/preparing-en.png), [Russian](validation/llama-rn-stage5/cpu-evidence/ordinary-ui/preparing-ru.png) |
| Cancel and retry | Expanded English Cancel and collapsed Russian Cancel reached Cancelled; Russian retry made both documents Ready | [English cancelled](validation/llama-rn-stage5/cpu-evidence/ordinary-ui/cancelled-en.png), [Russian cancelled](validation/llama-rn-stage5/cpu-evidence/ordinary-ui/cancelled-ru.png), [Ready](validation/llama-rn-stage5/cpu-evidence/ordinary-ui/ready-ru.png) |
| Clear only B; reselect exact B | C and installed weights retained; index became stale and Prepare was disabled without B. Exact-B reselection restored Ready without pressing Prepare | [Missing B](validation/llama-rn-stage5/cpu-evidence/ordinary-ui/missing-b.png), [reselected Ready](validation/llama-rn-stage5/cpu-evidence/ordinary-ui/reselected-ready.png) |
| Hybrid without B | Completed with actual Keywords mode and explicit `model_unavailable` fallback; the table-value answer was correct | [Fallback answer](validation/llama-rn-stage5/cpu-evidence/ordinary-ui/fallback-answer.png) |
| Keywords+C without B | Actual Keywords with rerank completed without fallback; the comparative answer was incorrect | [Configuration](validation/llama-rn-stage5/cpu-evidence/ordinary-ui/lexical-rerank-config.png), [answer](validation/llama-rn-stage5/cpu-evidence/ordinary-ui/lexical-rerank-answer.png) |
| Hybrid+C after B reselection | Actual Hybrid with rerank completed without fallback and gave the correct South value | [Answer](validation/llama-rn-stage5/cpu-evidence/ordinary-ui/hybrid-rerank-answer.png) |

Numeric preparation progress and the transient Cancelling state were **not captured**. UI document-embedding counts were not measured; readiness after reselection is a UI observation, while the native repeat/cold counters above establish their own vector-reuse and drain proof.

At 1080 × 2400 pixels and 420 dpi, measured fully visible document-search targets were **48.76–49.14 dp** high: expansion 48.76 dp, and mode/rerank/Prepare/collapsed-Cancel targets 49.14 dp. This measurement excludes text labels and existing chat actions; it is not a claim about every control in the app.

The Keywords+C comparison asked which region had the larger share. The model repeated North's 7.5%, although South's 12.0% was required. The later Hybrid+C question correctly returned South's 12.0%. Completed retrieval and native continuation therefore do not guarantee a correct comparison answer; these captures do not establish the cause of the incorrect answer or general answer quality.

## App-scoped log audit

The [UI receipt's log audit](validation/llama-rn-stage5/cpu-evidence/ordinary-ui/evidence.json) covers 193,680 bytes from the current QA app PID and retained logcat ring only. Four synthetic sentinel probes and one serialized-vector probe found zero matches; all five positive controls passed. The receipt records the audited buffer hash. This bounded result does not establish absence of sensitive data in other buffers, processes, platforms or log paths.

## Unverified scope

This fixture does not establish native iOS, physical GPU/NPU execution, other models or languages, the full native parser-format retrieval matrix, or tool+C within its short deadline. The corpus used small direct-text documents; parser capabilities and metadata checks are documented independently. The ordinary UI captures and bounded log audit above are separate from native inference proof. Transient Cancelling, numeric preparation progress and UI embedding counts were not measured, and the incorrect Keywords+C comparison remains an explicit answer-quality limitation. Acceptance does not imply merge, release or acceptance of later stages.
