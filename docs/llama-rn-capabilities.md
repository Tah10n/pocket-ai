# llama.rn capability inventory

This inventory covers the public entry point of **llama.rn 0.13.0-rc.3**, pinned exactly in `package.json` and `package-lock.json`. The selected tag's source and installed declarations are the contract; availability in that contract does not establish model support or successful native execution. Stage 1 updates the runtime and existing integration. Stage 2 adds model purposes, companion preparation and exclusive temporary auxiliary loading. Stage 3 adds generation settings, shared prompt preparation, restricted structured output and transactional adapter management. Implementation and native acceptance remain separate below; subsequent stages describe acceptance criteria, not delivered features.

## Stage 2 resource workflow

Model details shows independent purpose evidence for chat, embedding, reranker and TTS.
Catalog task/model-card declarations and GGUF metadata remain distinct from filename,
tag and manual hints. None proves native compatibility. Unknown legacy models remain
available for chat; declared specialized models are excluded from new chat selection.
Input audio support does not imply speech synthesis. Evidence survives public catalog
cache, registry hydration and refresh. Native check receipts belong to the exact
source/revision/path/checksum/size and are invalidated when that file changes.

Auxiliary selections live in encrypted settings separately from the chat selection.
Model details offers an explicit load check for small CPU embedding/rank profiles;
the bounded context and workspace reserve use a conservative, low-confidence policy.
Unknown overhead, including TTS loading in this stage, blocks the check rather than
assuming zero bytes or applying a chat estimate. Preparing TTS files remains available.
The selected pooling comes from the model by default; rank checks request rank pooling.
An explicit QA embedding call validates dimensions and finite values, without exposing
vectors. It does not implement semantic search or document reranking.

The existing artifact manifest and download queue now manage GGUF `tts_codec` (also
called vocoder) and `lora_adapter` resources. Users bind a real source URL, published
file size and optional expected SHA-256, then explicitly prepare or retry the selected
file. Pause/cancel state survives restart. TTS selects one codec; adapters can have
multiple selections. Binding follows the base file identity. An optional companion
failure never makes the installed base chat file corrupt. A size-only check is labelled
separately from matching a source checksum. Source-identical installed companions can
be reused after validation; physical paths are counted once and shared files survive
removal of another owner. No content-addressed store is introduced.

`LLMEngineService` owns one heavy context, including pending initialization, native
operations and release. Auxiliary loading reserves its existing lifecycle queue,
refuses an active user response, temporarily releases idle chat A, checks B, releases B
and restores A only while the chat selection, saved profile, file identity and private
storage are still current. It never substitutes B for the selected chat model. Errors
and timeouts keep uncertain native resources blocked; a timer is not a release receipt.
Deletion uses the same ownership barrier. Restore errors stay visible and do not
rewrite history or silently choose another model.

File presence, selected-profile completeness, memory admission, loaded context and
native operation receipts are separate states. TTS synthesis, parallel decoding and
sessions remain deferred. Stage 3 applies verified LoRA resources as described below.
All contexts retain `n_parallel: 1`,
`state_cache_budget_mb: 0` and `state_cache_max_checkpoints: 8`.
See [stage 2 Android acceptance](llama-rn-013-stage2-acceptance.md) for actual native
results, exact fixtures and independently reported unavailable combinations.

## Stage 3 implementation and verification boundaries

Advanced generation controls extend the existing model-parameter sheet. Settings,
presets and chat snapshots use typed fields; formatter/parser internals are not an
arbitrary native-parameter JSON editor. Missing legacy fields retain safe defaults.
The engine explicitly resolves all mutable sampler defaults on every completion:
the pinned native bridge otherwise retains values from the preceding request.

`PreparedLlamaRequest` formats an exact message/options identity once per retained
context-cache entry. Token counting and generation use that same prompt, timestamp,
media paths and parser metadata. Completion receives `prompt`, not `messages`, so
the upstream wrapper cannot format it a second time or overwrite explicit grammar.
The bounded in-memory cache is invalidated on context replacement and LoRA changes.
It is not a saved session or enabled native prefix-cache feature. The app's prefill
setting is a content suffix, appended once to the formatted prompt and supplied as
`prefill_text` to parsing; it does not include an extra assistant generation prefix.
If the last assistant message and the formatted prompt both already end in that
exact suffix, preparation reuses it. A matching user-message suffix alone does
not suppress prefill.
The original messages are unchanged. The separate prefill action evaluates the
prompt with `n_predict: 0` under normal completion ownership and creates no assistant
history item. Ordinary replies retain a bounded output budget.

An automatic request timestamp is private request metadata, distinct from an
explicit `template.now` override. A legacy `llama-chat` formatter ignores custom
Jinja kwargs, explicit time, `add_generation_prompt: false` and pure-content
overrides in this pinned bridge. Preparation rejects those combinations instead
of reporting them as applied; default legacy chats continue to work. A custom
Jinja template requires a model whose selected formatter actually supports Jinja.

Exact text counting accounts for a pinned runtime discrepancy: public `tokenize`
uses `add_special: false`, while completion enables special-token insertion when
the vocabulary requests BOS or the model has an encoder. The count correction
uses the loaded model's public tokenizer metadata and the selected runtime's
SPM/BPE/WPM/UGM defaults and explicit overrides, including its Gemma4 override.
It does not prepend text or guess a universal extra token. Unknown/malformed
tokenizer metadata makes exact counting unavailable rather than returning a false
exact value. Media tokenization already shares completion's native path and is not
corrected again. The Jinja formatter itself removes the automatic BOS/EOS boundary
text; preparation preserves that behavior. Native prefill receipts must compare
`tokens_evaluated` against this count below the context truncation boundary.

| API or field | Existing/new application path and scope | Reload and validation | Current evidence |
| --- | --- | --- | --- |
| `temperature`, `top_k`, `top_p`, `min_p`, `penalty_repeat`, `seed`, ordinary `n_predict` | Existing settings/preset/chat snapshot → effective request → completion. Seed is explicitly reset to `-1` when unset. | No reload. Finite, bounded product values; significant zero remains zero. Ordinary responses never default to infinite generation. | Real declaration checks and engine request tests; Android CPU bounded completion and deterministic baseline passed. This does not individually validate every sampler setting. |
| `penalty_last_n`, `penalty_freq`, `penalty_present`, `typical_p` | New advanced generation fields, resolved per request. | No reload. Penalty window preserves `0` and `-1`; probability-like values stay in `[0,1]`. Product safety bounds are not claims that native enforces the same limits. | Settings/snapshot and consecutive-request reset tests; native `not_run` until recorded. |
| `mirostat`, `mirostat_tau`, `mirostat_eta`; `xtc_probability`, `xtc_threshold`; `dry_multiplier`, `dry_base`, `dry_allowed_length`, `dry_penalty_last_n`, `dry_sequence_breakers`; `top_n_sigma` | New advanced sampler controls. Dependent values stay in the snapshot while the UI marks inactive controls. | No reload. Mirostat is `0/1/2`; XTC and DRY remain disabled by default; empty DRY breaker arrays and `0` values are explicit. Native precedence among sampler families is retained. | Typed mapping/default/reset coverage; native `not_run` until recorded. |
| `stop`, `n_probs` | New request settings. Stops are copied and combined with template/safety stops without trimming significant whitespace. Probabilities are opt-in. | No reload. At most 32 bounded user strings; `n_probs` defaults to `0`, capped at 10. Final diagnostic retention is capped at 64 tokens and 256 characters per token string. No growing probability arrays are copied into each streamed chat update. | Engine whitespace, immutable-input and probability-bound tests; Android CPU real top-10 probabilities and repeated-request bounds passed. |
| `ignore_eos`, `logit_bias` | Advanced request settings flow through preset/chat snapshots and canonical numeric mapping to the patched rc.3 bridge. | No reload; false/empty defaults, max 128 pairs, finite bias -100..100, last duplicate wins. Native validates the current vocabulary. EOS suppression overrides finite EOG biases and is rejected with explicit or template-provided output grammars. | Typed mapping, duplicate/zero/reset/conflict tests; Android CPU probability-changing bias, EOS suppression, invalid vocabulary ID rejection and next-request reset passed. |
| `enable_thinking`, `reasoning_format`, `thinking_budget_tokens`, `thinking_budget_message` | Existing reasoning policy plus advanced request overrides. Thinking tags remain formatter-owned. | No reload. Budgets require model/template tags; absent budget is explicitly reset. Structured modes disable thinking to keep their explicit output grammar and content validation consistent. | Request-state reset and formatter metadata tests. Model-specific reasoning behavior requires separate native execution. |
| `chat_template`, `jinja`, `chat_template_kwargs`, `add_generation_prompt`, `now`, `force_pure_content`, `prefill_text` | New typed template settings in snapshots and shared request preparation. `chatTemplate` is the app field mapped to canonical upstream `chat_template`, not a second alias setting. | No reload. Template is formatter data, never JavaScript or a network fetch. Bounded text/scalar kwargs; timestamp held constant across context fitting/counting/retries/generation. | Shared prompt/options identity, false/zero kwargs, prefill and context-epoch tests; Android CPU custom kwargs/frozen clock/count/prefill passed with 16 evaluated tokens. |
| `response_format`, `json_schema`, `grammar` | Mutually exclusive text, JSON object, restricted JSON Schema and GBNF modes. Final JSON content is independently checked once after native settles. | No reload. Explicit GBNF overrides template grammar and disables inherited lazy triggers. Explicit JSON schema clears template grammar before native schema conversion. Invalid/cancelled/truncated results retain content with an unsuccessful validation status. No unconstrained fallback. | Schema subset/result and retry tests; Android CPU JSON object/schema, GBNF, invalid grammar, cancellation, truncation and next ordinary request passed. |
| `grammar_lazy`, `grammar_triggers`, `preserved_tokens`, `chat_format`, `chat_parser`, `generation_prompt`, `thinking_forced_open`, thinking tags | Internal preparation metadata from one formatter result. | No independent settings. Parser/tag metadata stays paired with its prompt. Explicit output constraints reset grammar-specific lazy metadata. | Real-declaration adapter fixtures and prepared-request tests. |
| `cache_type_k`, `cache_type_v` | New distinct load-profile settings, alongside backward-compatible common `kvCacheType`. Explicit K/V takes priority for its side. | Reload. Public cache union only; capability/backend combination validation remains required. Requested/effective identities participate in memory fit, calibration, autotune and last-good reuse. | Load mapping, profile identity, rollback and cache-combination tests; CPU/GPU/NPU combinations need their own native receipts. |
| `rope_freq_base`, `rope_freq_scale`, `no_extra_bufts`, `swa_full`, `n_cpu_moe` | New optional typed load-profile fields. | Reload. Finite/range checks and allocation identity; active changes are transactional. A failed new profile restores the previous effective profile, including adapters, only while selection is current. | Native init argument mapping and deferred transactional tests. Model/backend support remains unverified unless separately recorded. |
| `spec_draft_n_max`, `spec_draft_n_min`, `spec_draft_p_min`, `spec_draft_p_split`, `spec_draft_n_gpu_layers`, `spec_draft_cache_type_k`, `spec_draft_cache_type_v` | New draft profile controls on the existing eligible MTP path. Draft file and mode remain artifact/orchestration-owned. | Reload for profile changes. Ordered min/max and probability bounds; draft memory/backend/cache validation. Media requests still disable MTP. Aliased object/path fields do not become extra settings. | Load/profile mapping and existing MTP regressions. No claim of successful native MTP without a compatible fixture. |
| Completion `n_threads` | Existing CPU thread choice belongs to the load profile, not a competing per-chat thread override. | Reload through `cpuThreads`; no new completion-level override. | Existing load mapping; this request-level API remains deliberately unexposed. |
| `lora`, `lora_scaled`, `lora_list`; `applyLoraAdapters`, `removeLoraAdapters`, `getLoadedLoraAdapters` | Canonical artifact-ID/identity/scale profile maps to `lora_list` on init; explicit live apply/scale/remove uses the public APIs and readback. | Live mutation requires exclusive ownership, verified bytes/SHA-256/base identity/metadata, fresh memory admission, confirmed cache clearing and updated context identity. Partial failure rebuilds the previous effective profile. Late operations retain file ownership. | Resolver, deferred lifecycle/recovery and deletion tests; Android CPU apply/readback, scale change, nonzero probability effect, removal, A+LoRA → B → A and deletion guard passed. |
| `tokenize`, `detokenize`, prefill `n_predict: 0` | Existing exact token count plus advanced engine diagnostics and prefill action. | No reload. Same exclusive native lifecycle; input/token diagnostic bounds; no promise of byte-identical special/media token round-trips. | Preparation and prefill unit tests; Android CPU tokenize/detokenize and zero-generation prefill passed without history mutation. |

### Structured-output subset

The interpreter accepts an omitted dialect or the Draft 7 schema URI. Supported
constraints are explicit scalar `type`, object `properties`/`required` and boolean
or schema `additionalProperties`, homogeneous array `items` and item bounds,
string length bounds, integer bounds, `enum`, `const`, and bounded `anyOf`.
Local `#/...` references under `definitions` or `$defs` are expanded before native;
cycles, unresolved references and external references are rejected without I/O.
The schema is limited to 32,768 characters, 16 levels and 512 expanded schema nodes.
The final result has separate size, depth and node limits.

This is not a complete JSON Schema validator. Regex `pattern`, `format`, `oneOf`,
`allOf`, number bounds, tuple arrays, recursive refs and unknown validation keywords
are rejected. Combinations the pinned converter would ignore are also rejected,
rather than advertised as supported. Missing `additionalProperties` is made
explicitly `true` for native conversion; an empty schema is normalized to the
converter's generic JSON-value rule. The local result checker does not strip code
fences, reasoning, prose or invalid fields to manufacture valid JSON. It receives
only the user-content channel. Native GBNF parsing remains responsible for grammar
syntax; GBNF results do not acquire a JSON-validation success label.

All explicit constraints (JSON and GBNF) use the native content-only parser
(`chat_format: 0`, empty `chat_parser`) so template parsers cannot consume literal
protocol or reasoning markers required by the selected grammar. GBNF uses empty
parser prefixes. In this pinned runtime `generation_prompt` advances an
output-format grammar and also prefixes parser input. Preparation supplies only
the configured JSON content prefix there, leaves `prefill_text` empty, and keeps
the template's assistant protocol prefix out of the bare JSON grammar. This
reconstructs the prefix and generated suffix exactly once; original formatter
metadata remains paired in the prepared request. Custom GBNF plus nonempty content
prefill is rejected: native user grammars do not advance through that prefix, so
the app does not advertise unsupported full-output continuation semantics.

### Pinned sampler bridge correction

The [exact rc.3 parameter reader](https://github.com/mybigday/llama.rn/blob/v0.13.0-rc.3/cpp/jsi/JSIParams.cpp#L628) indexes a cleared `std::vector<llama_logit_bias>`. The version- and source-hash-guarded [local bridge correction](validation/llama-rn-stage3/native-probability-patch.md) replaces these invalid writes with checked token/bias entries while keeping runtime version 0.13.0-rc.3. Numeric token IDs must be integers within the loaded vocabulary; biases must be finite floats. Duplicate user IDs use their last bias. EOS suppression replaces matching end-of-generation biases and appends missing ones, so a finite positive user bias cannot restore a suppressed EOG token. Omitted EOS suppression resets to false.

The app further limits inputs to 128 numeric pairs with bias -100..100 and rejects EOS suppression with explicit or template-provided grammar constraints. String token names and boolean bias forms from upstream comments are not part of the public TypeScript contract and are not accepted through casts. Every request keeps a finite generation budget. Native acceptance requires rebuilding with the correction; JavaScript or source-contract tests alone do not prove device behavior.

### Acceptance status

The [2026-09-24 Android CPU acceptance](llama-rn-013-stage3-acceptance.md)
passed the repeated Stage 1 and 2 inference packs and all 27 Stage 3 steps on one
source-built rc.3 APK. It records exact source/APK/model/adapter identities,
structured-output recovery, real bounded probabilities, LoRA distribution changes,
removal and A+LoRA → auxiliary B → A restoration. Earlier failed runs remain
separately identified; they are not relabelled as successful.

Automated declaration/mapping, persistence, deferred ownership and rollback tests
cover additional combinations. They do not establish native support for every
advanced sampler/load field or multiple-adapter failure case. The tested LoRA
fixture has one adapter at two scales. iOS/GPU/NPU execution and compatible MTP
remain **not_run** with concrete blockers in the acceptance report. ARM64 host
compilation is separate from device inference.

## Sources and status terminology

- [Public exports, context, parallel, speaker and helpers](https://github.com/mybigday/llama.rn/blob/v0.13.0-rc.3/src/index.ts)
- [Native parameter/result declarations](https://github.com/mybigday/llama.rn/blob/v0.13.0-rc.3/src/types.ts)
- [TTS capabilities](https://github.com/mybigday/llama.rn/blob/v0.13.0-rc.3/src/tts.ts) and [voice payloads and lookup](https://github.com/mybigday/llama.rn/blob/v0.13.0-rc.3/src/tts-voices.ts)
- [Tagged API documentation](https://github.com/mybigday/llama.rn/tree/v0.13.0-rc.3/docs/API), [README](https://github.com/mybigday/llama.rn/blob/v0.13.0-rc.3/README.md), and [releases](https://github.com/mybigday/llama.rn/releases)

**Integrated** means an existing application path calls the API. **Partial** means only specified parts are used. **Contract only** means preservation/type checking at the adapter boundary, without a product workflow. **Deferred** means no application workflow uses it. **Disabled by policy** means deliberate runtime restrictions remain. These implementation statuses are independent of `passed`, `failed`, or `not_run` device verification. A JavaScript method, mock, or passing unit test never upgrades device verification to `passed`.

The inventory itself makes no new-device execution claim. Each native acceptance test requires an execution record with binary provenance, device or emulator, exact model and companions, actual backend, result, and reason for `not_run`. Existing historical reports do not prove this pinned runtime. Android and iOS require separate records; emulator runs cannot validate a physical GPU or NPU. See [device validation](./runtime-hardening-device-validation.md), [Android builds](./android-build.md), and [iOS builds](./ios-build.md).

## Integration map

All paths below are relative to the public repository root.

| Area | Current application locations |
| --- | --- |
| Runtime boundary | `src/services/LlamaRuntimeAdapter.ts`; lazy loading in `src/services/llamaRnModule.ts`; unavailable native runtime on web in `src/services/llamaRnModule.web.ts` |
| Context lifetime, request ownership, cancellation, reload, completion | `src/services/LLMEngineService.ts`; chat ownership in `src/hooks/useChatSession.ts` |
| Backend discovery and effective profile | `src/services/InferenceBackendService.ts`, `src/services/LLMEngineService.backend.ts` |
| Parameters and safety | `src/services/SettingsStore.ts`, `src/services/PromptStateCachePolicy.ts`, `src/memory/`; [parameter mapping](./model-parameters.md) |
| Projectors and attachments | `src/services/ProjectorArtifactService.ts`, engine multimodal paths; [media contract](./multimodal-attachments.md) |
| Documents | `src/hooks/useChatSession.ts`; [document processing](./document-processing.md). Text extraction/retrieval is application behavior, not a llama.rn document API. |

## Functional coverage

Every source link in this table is pinned to the selected tag. “Proof” describes the check required to establish support; it is not a report that the check passed.

| Group and exact public APIs | Implementation and current call sites | Constraints and use case | Stage and required proof |
| --- | --- | --- | --- |
| [Initialization and lifetime](https://github.com/mybigday/llama.rn/blob/v0.13.0-rc.3/src/index.ts#L1473): `initLlama(params, onProgress?)`, `LlamaContext.release()`, `releaseAllLlama()`, `installJsi()`, `setContextLimit(limit)`; exported `LlamaContext` constructor | Init/release integrated through adapter and engine; lazy module load integrated. `installJsi` normally belongs to upstream initialization. No app context-limit setting or manual construction of native handles. | Compatible GGUF, native binary and sufficient RAM required. Contexts, projectors and drafts consume resources independently. Lifecycle owns release after request completion/cancellation. Web has no native runtime. | **1**, resource policy **2**. Load small model, complete, cancel, complete again, unload/reload, switch chat/model without stale callbacks. Test web rejection and lazy diagnostics without model initialization. |
| [Model, backend and build information](https://github.com/mybigday/llama.rn/blob/v0.13.0-rc.3/src/index.ts#L1350): `loadLlamaModelInfo(model)`, `getBackendDevicesInfo()`, `BuildInfo`; context `id`, `gpu`, `reasonNoGPU`, `devices`, `model`, `androidLib`, `systemInfo` | Integrated adapter model/backend/build helpers and engine/backend services. Context metadata supplies actual loaded state. | `BuildInfo.number`/`commit` describe package build metadata, not a native version getter. Discovery is not proof of selected accelerator execution. Model metadata does not prove companion readiness. | **1**, complete resource roles **2**. Compare package pin, build provenance, discovery and actual loaded context; native smoke must establish binary compatibility. |
| [Text/chat completion and stream](https://github.com/mybigday/llama.rn/blob/v0.13.0-rc.3/src/index.ts#L839): `completion(params, onToken?)`, `stopCompletion()`; `TokenData`, `ToolCall`, `NativeCompletionResult` | Integrated `runCompletionOnContext`, normalizers, engine completion and stop paths, `useChatSession`. Tool calls and nontext outputs are contract preservation only, not executed tools or audio playback. | Streaming `tool_calls[].function.arguments` can be incomplete JSON; parsed accumulated content is not a token delta. Preserve empty/absent/null semantics where the native bridge uses them. Do not move final audio/embedding buffers into ordinary history. | **1**; expanded generation **3**, tools **4**. Contract fixtures plus native stream/stop/retry and final-result consistency; callback exceptions and late callbacks must not corrupt lifecycle. |
| [Formatting and tokens](https://github.com/mybigday/llama.rn/blob/v0.13.0-rc.3/src/index.ts#L711): `isLlamaChatSupported()`, `isJinjaSupported()`, `getFormattedChat(messages, template?, params?)`, `tokenize(text, { media_paths }?)`, `detokenize(tokens)` | Shared prompt formatting and tokenization are integrated in `PreparedLlamaRequest` and the engine; bounded `inspectTokens` diagnostics also call detokenize. Support predicates remain model metadata. | Jinja/model template determines roles, grammar and reasoning support. Media tokenization needs a compatible initialized projector. Token count must reflect the actual formatted prompt. | **1**, additional controls **3**. Compare formatted prompt and tokenization, retain all Jinja metadata, media token accounting, and future detokenize round-trip fixtures. |
| [Generation, reasoning and prefill](https://github.com/mybigday/llama.rn/blob/v0.13.0-rc.3/src/types.ts#L209): `CompletionParams`, `CompletionBaseParams`, `ChatTemplateKwargs`, reasoning/thinking, `prefill_text`, template and sampling fields listed below | Existing generation profiles are extended by typed advanced settings, shared formatting and an explicit prefill operation. Checked numeric biases and EOS suppression use the pinned bridge correction; see the stage 3 map. | Model/template must expose thinking tags for budgets. Request-specific parameters must not leak to subsequent turns. Prefill/parser metadata must stay paired with formatting. | **1** preserve existing behavior; remaining generation **3**. Typecheck real declarations; sequential requests with distinct reasoning settings; native reasoning model with and without budgets. |
| [Structured output and grammar](https://github.com/mybigday/llama.rn/blob/v0.13.0-rc.3/src/index.ts#L264): `CompletionResponseFormat`, `response_format`, `json_schema`, `grammar`, `grammar_lazy`, `grammar_triggers`, `preserved_tokens` | Text, JSON object, restricted JSON Schema and GBNF modes are integrated through shared preparation and independent final JSON validation. See the supported subset above. | Explicit grammar takes precedence over schema conversion. Grammar validity and model/template support require real execution; arbitrary schema coverage is not guaranteed by a TypeScript object. | **3**. Schema-constrained output validates against a declared schema; invalid grammar errors and cancellation leave the next request usable. |
| [Tools](https://github.com/mybigday/llama.rn/blob/v0.13.0-rc.3/src/index.ts#L275): `tools`, `tool_choice`, `parallel_tool_calls`, streamed/final `tool_calls` | Contract only for tool-call preservation in adapter. No tool execution loop or new chat-history schema. | Tool-aware template and model required. `parallel_tool_calls` is a formatter option, distinct from context parallel execution. Partial arguments must remain strings. | **1** preserve contract, workflow **4**. Stream incomplete arguments without parsing; retain final name/id/arguments; future end-to-end controlled tool loop needs separate tests. |
| [Speculative/MTP](https://github.com/mybigday/llama.rn/blob/v0.13.0-rc.3/src/types.ts#L5): `NativeSpeculativeType`, `NativeSpeculativeParams`, `NativeSpeculativeConfig`; init/request `speculative` and flat `spec_*` fields; `model_draft` | Existing MTP profile/companion handling in engine and `src/utils/modelSpeculativeDecoding.ts`; telemetry preserved. | Embedded MTP or compatible separate draft required; draft has its own device/cache/memory costs. Media requests keep MTP disabled. Alias `mtp` means `draft-mtp`, not another algorithm. | **1** preserve; roles/artifacts **2**, generation **3**. Native eligible model with accepted/drafted counters, draft allocation failure recovery, and media exclusion. |
| [Multimodal input and projector](https://github.com/mybigday/llama.rn/blob/v0.13.0-rc.3/src/index.ts#L1040): `initMultimodal({path,use_gpu,image_min_tokens,image_max_tokens})`, `isMultimodalEnabled()`, `getMultimodalSupport()`, `releaseMultimodal()`; `RNLLAMA_MTMD_DEFAULT_MEDIA_MARKER`, message `image_url`/`input_audio`, `media_paths` | Existing adapter/engine multimodal integration and projector service; attachment paths cover images/audio. `isMultimodalEnabled` is available upstream but is not a new app feature. | Matching projector/model, actual vision/audio support and memory fit required. `getMultimodalSupport` returns `{vision,audio}`. Preserve context-shifting restriction and media MTP disable. Input format/preprocessing support differs by model. | **1** regression checks, artifact roles **2**, expanded audio **7**. Native image, WAV and MP3 separately, failed/missing projector, unload/reload; documents independently test extraction plus text completion. |
| [Embedding](https://github.com/mybigday/llama.rn/blob/v0.13.0-rc.3/src/index.ts#L956): `embedding(text, params?)`, `EmbeddingParams`, `NativeEmbeddingParams`, `NativeEmbeddingResult`; init `embedding`, `pooling_type`, `embd_normalize` | Deferred; no llama.rn embedding retrieval workflow. Completion `embeddings` preservation is contract only and is distinct from this text-embedding operation. | Embedding-capable model and correct pooling/normalization; dimensions and RAM depend on model. TTS completion embeddings are not document embeddings. | **5**, resources **2**. Real vectors with expected dimension, finite values, normalization and semantic-retrieval fixtures. |
| [Rerank](https://github.com/mybigday/llama.rn/blob/v0.13.0-rc.3/src/index.ts#L964): `rerank(query, documents, params?)`, `RerankParams`, `RerankResult`, `NativeRerankParams`, `NativeRerankResult` | Deferred. | Appropriate reranker/pooling required. Public wrapper adds original `document` by `index` and sorts descending by score. Budget grows with candidates and prompt size. | **5**. Real relevant/irrelevant ordering, stable source indices, empty/oversized candidate handling. |
| [Parallel execution](https://github.com/mybigday/llama.rn/blob/v0.13.0-rc.3/src/index.ts#L414): all operations and subscription contracts listed below | Disabled by policy; no app queue or increased slot count. Existing settings/types do not establish implementation. | Per-context slot capacity and batch memory; independent request ownership and cancellation required. Enabling parallel is an explicit future policy decision. | **8**. Overlapping completion/embedding/rerank, queue cancellation, slot accounting, failure settlement and subscription removal without leaks. |
| [Sessions and cache](https://github.com/mybigday/llama.rn/blob/v0.13.0-rc.3/src/index.ts#L696): `loadSession(filepath)`, `saveSession(filepath, {tokenSize}?)`, `clearCache(clearData?)`; parallel state file fields; context `state_cache_budget_mb`, `state_cache_max_checkpoints` | Sessions remain deferred. Stage 3 uses confirmed `clearCache(true)` only to invalidate state after LoRA mutation. Cross-turn prompt state cache remains disabled by `PromptStateCachePolicy` and init policy. | State must match model/config and conversation ownership. Recurrent/hybrid architectures need full reset; data clearing differs from metadata reset. Saved state is sensitive application data. | **1** preserve explicit budget `0` and checkpoints `8`; enablement **8**. Cross-chat isolation, stale-state rejection, state-file round-trip, measured bounded memory and invalidation before any cache enablement. |
| [LoRA](https://github.com/mybigday/llama.rn/blob/v0.13.0-rc.3/src/index.ts#L1011): init `lora`, `lora_scaled`, `lora_list`; `applyLoraAdapters(list)`, `removeLoraAdapters()`, `getLoadedLoraAdapters()` | Canonical artifact profiles and explicit apply/list/scale/remove are integrated with verified init restore, exclusive ownership and rollback. Native behavioral acceptance is tracked separately. | Base model compatibility, adapter file integrity and additional RAM; scale and reloading can affect output/state. | **3**, artifact roles **2**. Known matching adapter changes controlled output, inspect loaded list, remove and restore baseline, recover from invalid adapter. |
| [TTS and vocoder](https://github.com/mybigday/llama.rn/blob/v0.13.0-rc.3/src/index.ts#L1086): `initVocoder({path,n_batch,use_gpu})`, `isVocoderEnabled()`, `getTTSCapabilities()`, `getFormattedAudioCompletion(options)`, `decodeAudioTokens(tokens)`, `decodeAudioEmbeddings(embeddings, embeddingDim)`, `getAudioSampleRate()`, `releaseVocoder()`; deprecated `generateAudioCodes(options)` | Deferred. Final `audio_tokens`, `embeddings`, `embedding_dim` at the completion boundary are contract only, with no playback or history persistence. | Matching TTS model/codec and RAM; family dictates token versus continuous-embedding flow. Codec GPU selection is separate from the main model. Experimental upstream API is a risk, not itself a `blocked-upstream` finding. | **6**, resource roles **2**. Both synthesis flows produce finite PCM at reported sample rate; cancellation/release, repeated synthesis and memory accounting per family/backend. |
| [Voices, languages and phonemizer](https://github.com/mybigday/llama.rn/blob/v0.13.0-rc.3/src/tts-voices.ts): `getTTSVoice`, `listTTSVoices`, `listTTSLanguages`; `TTSCapabilities`, `OuteTTSWord`, `OuteTTSSpeaker`, `NeuTTSSpeaker`, `SpeakerPayload`; `getFormattedAudioCompletion` phonemizer hook | Deferred; no voice/language selector or phonemizer installed by this foundation. | Lookup is a JS reference-payload catalog, not universal language support. `requiresPhonemes` is model-derived; caller provides sync/async hook. OuteTTS 1.0 cannot use the legacy default word/code payload. | **6**. Family/language lookup, unknown voice error, hook invocation and real native output with correct phonemes; language claims require tested model output. |
| [Speaker lifecycle](https://github.com/mybigday/llama.rn/blob/v0.13.0-rc.3/src/index.ts#L1269): `createSpeaker(config)`, exported `LlamaSpeaker`, `LlamaSpeaker.bake()`, `.release()`; fields `id`, `family`, `rows`, `baked` | Deferred; no sample-based voice capture or speaker lifecycle. | Native handle belongs to its context; reference PCM/sample rate, optional text/emotion and compatible model/codec required. Bake changes state and consumes resources. Reference audio must not enter logs. | **7**. Create from known PCM, bake, synthesize, release; reject stale/cross-context handles and account for memory. |
| [Measurements and logs](https://github.com/mybigday/llama.rn/blob/v0.13.0-rc.3/src/index.ts#L980): `bench(pp,tg,pl,nr)`, `BenchResult`; completion `timings`, `n_probs`, `completion_probabilities`; `toggleNativeLog(enabled)`, `addNativeLogListener(listener)` and listener `.remove()` | Timings/speculative telemetry and guarded native logs integrated through engine/adapter; benchmark and probability-driven product controls deferred. | Logs may contain sensitive data: app must sanitize/filter; do not log prompts, tool arguments, documents, audio/images or private paths. Benchmark affects memory/thermal state. Probabilities increase payload cost. | **1** preserve telemetry/privacy; expanded measurement **8**, release audit **9**. Finite counters/timings, probability fixtures, native bounded benchmark with actual backend, log subscription cleanup and privacy review. |

## Complete parameter and result ledger

The ledger groups all public load/completion fields without turning each field into a UI setting. Sources are [`ContextParams` and public completion types](https://github.com/mybigday/llama.rn/blob/v0.13.0-rc.3/src/index.ts#L214) and [`NativeContextParams` / `NativeCompletionParams`](https://github.com/mybigday/llama.rn/blob/v0.13.0-rc.3/src/types.ts#L45).

| Contract group | Fields and ownership |
| --- | --- |
| Model/resource load, stages 1–2 | `model`, `is_model_asset`, `model_draft`, `draft_model`, `is_model_draft_asset`, `use_progress_callback`, `vocab_only`, `use_mmap`, `use_mlock`, `no_extra_bufts`; upstream init owns progress callback plumbing. File ownership/integrity belongs to app resource policy. |
| Context/backend/memory, stages 1–2 and 8 | `n_ctx`, `n_batch`, `n_ubatch`, `n_parallel`, `n_threads`, `cpu_mask`, `cpu_strict`, `n_gpu_layers`, `devices`, `no_gpu_devices`, `flash_attn_type`, `flash_attn`, `cache_type_k`, `cache_type_v`, `rope_freq_base`, `rope_freq_scale`, `ctx_shift`, `kv_unified`, `swa_full`, `n_cpu_moe`, `state_cache_budget_mb`, `state_cache_max_checkpoints`. Fit, retries, cache/parallel guards and backend selection stay centrally controlled. |
| Load adapters/features, stages 2–3 and 5 | `chat_template`, `lora`, `lora_scaled`, `lora_list`, `embedding`, `embd_normalize`, `pooling_type`; public pooling values `none`, `mean`, `cls`, `last`, `rank` are mapped by upstream to native numbers. |
| MTP, stages 1–3 | Init/request `speculative`, `spec_type`, `spec_draft_n_max`, `spec_draft_n_min`, `spec_draft_p_min`, `spec_draft_p_split`; init additionally `spec_draft_n_gpu_layers`, `spec_draft_cache_type_k`, `spec_draft_cache_type_v`. Object form has `enabled`, `type`, `types`, `n_max`, `n_min`, `p_min`, `p_split`, and `draft` with `model`, `path`, `model_draft`, `draft_model`, `n_max`, `n_min`, `p_min`, `p_split`, `n_gpu_layers`, `cache_type_k`, `cache_type_v`. |
| Chat/template input, stages 1 and 3–4 | `prompt`, `messages`, `chatTemplate`, `chat_template`, `jinja`, `tools`, `parallel_tool_calls`, `tool_choice`, `response_format`, `media_paths`, `add_generation_prompt`, `now`, `chat_template_kwargs`, `force_pure_content`, `prefill_text`. `RNLlamaOAICompatibleMessage`: `role`, optional `content`, `reasoning_content`; `RNLlamaMessagePart`: `type`, `text`, `image_url.url`, `input_audio.format/data/url`. |
| Parsing/grammar/reasoning, stages 1 and 3–4 | `json_schema`, `grammar`, `grammar_lazy`, `grammar_triggers` (`type`, `value`, `token`), `preserved_tokens`, `chat_format`, `chat_parser`, `generation_prompt`, `reasoning_format` (`none`, `auto`, `deepseek`), `enable_thinking`, `thinking_forced_open`, `thinking_budget_tokens`, `thinking_budget_message`. Formatter-generated parser/tag/grammar metadata is runtime-managed, not independent settings. |
| Sampling, stage 3 (existing subset retained in stage 1) | `n_threads`, `stop`, `n_predict`, `n_probs`, `top_k`, `top_p`, `min_p`, `xtc_probability`, `xtc_threshold`, `typical_p`, `temperature`, `penalty_last_n`, `penalty_repeat`, `penalty_freq`, `penalty_present`, `mirostat`, `mirostat_tau`, `mirostat_eta`, `dry_multiplier`, `dry_base`, `dry_allowed_length`, `dry_penalty_last_n`, `dry_sequence_breakers`, `top_n_sigma`, `ignore_eos`, `logit_bias`, `seed`. |
| Special completion modes, stages 6 and 8 | `embedding` requests completion embeddings for relevant models; it does not invoke `context.embedding`. Native `emit_partial_completion` is omitted from public `CompletionParams` and controlled by upstream callback plumbing. Parallel-only `load_state_path`, `save_state_path`, `save_prompt_state_path`, `load_state_size`, `save_state_size` are not ordinary completion options. |

### Results and metadata

- `FormattedChatResult`: `type`, `prompt`, `has_media`, optional `media_paths`. `JinjaFormattedChatResult` adds `chat_format`, `grammar`, `grammar_lazy`, `grammar_triggers`, `generation_prompt`, `thinking_forced_open`, `thinking_start_tag`, `thinking_end_tag`, `preserved_tokens`, `additional_stops`, `chat_parser`. Retaining an empty string or array differs from discarding an absent field.
- `TokenData`: required `token`; optional `completion_probabilities`, `content`, `reasoning_content`, `tool_calls`, `accumulated_text`, `requestId`. `ToolCall` has `type: 'function'`, optional `id`, and `function.name`/`function.arguments`. No intermediate JSON parsing.
- `NativeCompletionResult`: `text`, `reasoning_content`, `tool_calls`, `content`, `chat_format`, `tokens_predicted`, `tokens_evaluated`, `draft_tokens`, `draft_tokens_accepted`, `truncated`, `stopped_eos`, `stopped_word`, `stopped_limit`, `stopping_word`, `context_full`, `interrupted`, `tokens_cached`, `timings`; optional `completion_probabilities`, `embeddings`, `embedding_dim`, `audio_tokens`. The declaration and native bridge differ for parsed fields and stop flags; see the explicit compatibility exceptions below. `requestId` is declared on token events, not on this final result type.
- `NativeCompletionResultTimings`: `cache_n`, `prompt_n`, `prompt_ms`, `prompt_per_token_ms`, `prompt_per_second`, `predicted_n`, `predicted_ms`, `predicted_per_token_ms`, `predicted_per_second`. `NativeCompletionTokenProb` contains `content` and `probs`; each `NativeCompletionTokenProbItem` has `tok_str` and `prob`.
- `NativeTokenizeResult`: `tokens`, `has_media`, `bitmap_hashes`, `chunk_pos`, `chunk_pos_media`. `NativeEmbeddingResult`: `embedding`. `NativeSessionLoadResult`: `tokens_loaded`, `prompt`; `saveSession` resolves to the saved token count.
- `NativeLlamaContext`: `contextId`, `model`, `gpu`, `reasonNoGPU`, `systemInfo`, optional `androidLib`/`devices`. Model contains `desc`, `size`, `nEmbd`, `nParams`, `is_recurrent`, `is_hybrid`, `metadata`, `chatTemplates`, deprecated `isChatTemplateSupported`. `chatTemplates` includes `llamaChat`, Jinja `default`/`toolUse`, and `defaultCaps`/optional `toolUseCaps` (`tools`, `toolCalls`, `systemRole`, `parallelToolCalls`).
- `NativeBackendDeviceInfo`: `backend`, `type`, `deviceName`, `maxMemorySize`, optional `metadata`. `NativeImageProcessingResult` (`success`, `prompt`, optional `error`) is an exported type; there is no standalone image-processing function exported from `index.ts` to invent an app wrapper for.
- `BenchResult`: `nKvMax`, `nBatch`, `nUBatch`, `flashAttn`, `isPpShared`, `nGpuLayers`, `nThreads`, `nThreadsBatch`, `pp`, `tg`, `pl`, `nKv`, `tPp`, `speedPp`, `tTg`, `speedTg`, `t`, `speed`.

### Parallel namespace: every operation

`ParallelCompletionParams` combines `CompletionBaseParams` with exported `NativeParallelCompletionParams`, omitting runtime-managed `emit_partial_completion` and replacing required native `prompt` with the public prompt/messages input. The native type extends `NativeCompletionParams` with the state-file fields listed above.

| Method | Public request/result contract |
| --- | --- |
| `parallel.completion(params, onToken?)` | `ParallelCompletionParams`; callback `(requestId, TokenData)`; resolves `{ requestId, promise: Promise<NativeCompletionResult>, stop: () => Promise<void> }`. Stop is tied to that queued request. |
| `parallel.embedding(text, params?)` | Resolves `{ requestId, promise: Promise<NativeEmbeddingResult> }`; no returned `stop` method. |
| `parallel.rerank(query, documents, params?)` | Resolves `{ requestId, promise: Promise<RerankResult[]> }`; wrapper sorts scores and attaches document; no returned `stop` method. |
| `parallel.enable(config?)` | Config `{ n_parallel?, n_batch? }`; enables native parallel mode. |
| `parallel.disable()` | Disables native parallel mode. |
| `parallel.configure(config)` | `{ n_parallel?, n_batch? }`; also enables mode, so it is not a harmless read/config-only operation. |
| `parallel.getStatus()` | `Promise<ParallelStatus>` snapshot. |
| `parallel.subscribeToStatus(callback)` | `Promise<{ remove: () => void }>`; remove owns unsubscription. |

`ParallelStatus` has `n_parallel`, `active_slots`, `queued_requests`, `requests`. Each `ParallelRequestStatus` has `request_id`, `type` (`completion`, `embedding`, `rerank`), `state` (`queued`, `processing_prompt`, `generating`, `done`), `prompt_length`, `tokens_generated`, `prompt_ms`, `generation_ms`, `tokens_per_second`. Do not infer public failed/cancelled status variants or a public generic `cancelRequest` from private JSI functions. Queue error settlement needs future native validation, particularly for embedding/rerank callbacks, whose wrappers only resolve result promises.

### TTS and speaker contracts

`TTSCapabilities` exposes `type`, `promptKind`, `family`, `requiresPhonemes`, `defaultLanguage`. Families in this declaration are `outetts`, `soprano`, `neutts`, `csm`, `qwen3_tts`, `moss_tts`, `moss_ttsd`, `chatterbox`, `bluemagpie`, or empty. Prompt kinds distinguish OuteTTS generations and Chatterbox multilingual. This list is an upstream type inventory, not a Pocket AI tested-model list.

`getFormattedAudioCompletion` takes `{ prompt, speaker?, phonemizer?, language? }`, where `speaker` is a built-in voice name, `LlamaSpeaker`, or `SpeakerPayload`. It returns `{ prompt, grammar?, embedding, flow }`, with `flow` equal to `tokens`, `continuous_embd`, or empty. Use the returned mode to select the matching pipeline:

1. Token flow: format, call normal `completion` with the returned settings, decode the final `audio_tokens` using `decodeAudioTokens`, obtain sample rate, then deliver PCM through a separately implemented playback path.
2. Continuous embedding flow: format, call `completion`, pass final `embeddings` and `embedding_dim` to `decodeAudioEmbeddings`, obtain sample rate, then deliver PCM.

Both decoders resolve `number[]`. Neither establishes streaming playback. The legacy `generateAudioCodes` wrapper takes `prompt`, `maxFrames`, `temperature`, `topP`, `topK`, `seed`, optional `onFrame(step,codes)` and returns `codes`, `nCodebook`, `nFrames`, `stoppedOnEos`, `aborted`; it is deprecated in favor of the normal completion loop.

`getTTSVoice(family, name, language?)` resolves a payload or `null`; `listTTSVoices(family, language?)` and `listTTSLanguages(family)` return names. `OuteTTSWord` has `word`, `duration`, `codes`; `OuteTTSSpeaker` has `words`. `NeuTTSSpeaker` has `ref_phones`, `ref_codes`. `SpeakerPayload` additionally permits a custom payload. The optional phonemizer hook `(text, language) => string | Promise<string>` is caller-owned; the wrapper uses it for required phonemes and applicable reference text.

`createSpeaker` accepts `refAudio: Float32Array | number[]`, `refAudioSampleRate`, optional `refText`, `emotion`, `bake`. A returned `LlamaSpeaker` has readonly `id`/`family`, mutable `rows`/`baked`, and async `bake`/`release`. Its constructor takes context ID plus native handle metadata; applications should obtain real handles through `createSpeaker`, not fabricate IDs.

## Aliases, discrepancies and runtime-owned controls

- [Native JSI result construction](https://github.com/mybigday/llama.rn/blob/v0.13.0-rc.3/cpp/jsi/JSICompletion.h#L10) differs from `src/types.ts`: `createToolCalls` emits `id: null` for an empty native ID although `ToolCall.id` is declared optional string. `setChatOutputFields` omits empty `content`, `reasoning_content` and `tool_calls` although final-result declarations require them. Native `stopped_word` and `stopped_limit` are booleans although declarations say string and number. The adapter models these specific native compatibility cases explicitly, preserves null tool IDs/boolean stop flags and retains its existing absent-parsed-field clearing policy required by the chat engine. They are not grounds to cast the whole result blindly or label all upstream support blocked.
- Deprecated `chatTemplate` aliases `chat_template`; `flash_attn` is superseded by `flash_attn_type`; `no_gpu_devices` is superseded by `devices`; model `isChatTemplateSupported` is superseded by the template capability structure. None needs a duplicate UI setting.
- `draft_model` aliases `model_draft`; speculative draft object path aliases and `mtp`/`draft-mtp` describe the same resource/mode. Preserve a single application choice and normalize deliberately.
- The old positional `getFormattedAudioCompletion(speaker, text)` signature was removed. The options object in the selected source is authoritative. `generateAudioCodes` remains exported but deprecated.
- The source's `NativeContextParams.n_gpu_layers` comment says “Currently only for iOS”, while the same type explicitly documents Android backend device selectors. Treat that comment as insufficient evidence of backend capability; use actual discovery/context data and platform smoke tests. Do not claim a backend works from the requested layer count.
- The implementation's internal valid-cache list includes `bf16`, but public `ContextParams.cache_type_k/v` does not. Use the public union; do not cast unsupported values into settings.
- Upstream JSI installation captures and deletes `global.llama*` bindings. Global presence tests cannot establish runtime health. Public API shape checks prove only the JavaScript contract; native build provenance plus smoke execution establishes binary compatibility.
- Progress/partial-emission plumbing, formatted parser metadata, native handles, stop identity, cache budgets and slot policy belong to runtime orchestration. No new startup probes, automatic model loads, or universal capability registry are needed.
- No feature is marked `blocked-upstream` merely because its API is experimental. A blocker requires a concrete reproducer and pinned source/issue evidence; unsupported product workflows remain deferred and unverified native paths remain `not_run`.

## Nine-stage acceptance map

| Stage | Scope and exit evidence |
| --- | --- |
| **1 — Runtime and contracts** | Exact runtime/native artifact identity, adapter field preservation, real-declaration type compatibility, lazy/web behavior, retained safety policy, diagnostics and honest native matrix. No tool execution, audio playback, parallel enablement or state-cache activation. |
| **2 — Model roles, artifacts and resources** | Explicit model/companion ownership, integrity, backend/resource fit and lifecycle without substituting a globally selected model for the active chat model. |
| **3 — Generation, structured output and LoRA** | Verified settings and templates, schema/grammar output, reasoning/prefill, adapter management, eligible speculative decoding. |
| **4 — Tools** | Validated final tool calls, controlled execution and result-to-model loop; partial streams remain non-executable. |
| **5 — Embeddings/rerank** | Model-role-specific vectors/ranking with retrieval quality, index identity and resource proofs. |
| **6 — TTS** | Token and continuous-embedding synthesis, codec lifecycle, voices/languages, phonemizer and playback verified separately. |
| **7 — Audio input and sample-based voices** | Model-supported audio input plus reference-audio speaker creation/bake/release, ownership and privacy. |
| **8 — Parallel, sessions, cache and measurements** | Request isolation, error/cancellation settlement, bounded slots/cache, session validity and representative backend benchmarks. |
| **9 — Completeness and stable release** | Reconcile exports/types against final selected stable tag; model/platform evidence and release regression gates. Deferred or unavailable paths cannot silently become “supported.” |

Stage 1 retains `state_cache_budget_mb: 0` and `state_cache_max_checkpoints: 8`, existing slot limits with parallel disabled, multimodal context-shifting restrictions and MTP disable on media. It preserves memory-fit/OOM recovery, backend discovery, transactional reload, chat/model ownership and stored history/profiles. Native dependency changes require a new binary; package `BuildInfo` is not permission for a JS-only OTA to an old binary.
