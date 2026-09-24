# Model parameters

This document describes how Pocket AI stores and applies generation parameters and model load profiles with llama.rn **0.13.0-rc.3**. The [Android CPU acceptance](llama-rn-013-stage3-acceptance.md) verifies structured output, shared template/count/prefill, probabilities and LoRA application/restoration on pinned fixtures. The [capability inventory](llama-rn-capabilities.md) separates that evidence from typed mapping and still-unverified model/backend combinations.

## Categories

Pocket AI treats model settings as two categories:

1. **Generation parameters** (apply to the next completion immediately)
2. **Load parameters** (require a model load/reload to take effect)

## Generation parameters

Generation parameters are defined and sanitized in:

- `src/services/SettingsStore.ts` (`GenerationParameters`)

They are snapshotted into chat threads so history remains reproducible and stable even if defaults change later:

- `src/types/chat.ts` (`GenerationParamsSnapshot`)
- `src/store/chatStore.ts`
- `src/utils/chatThreadParameters.ts`

Opening, sending or regenerating an existing chat preserves its own snapshot. Changing one control merges into that chat's snapshot; it does not replace unrelated fields with another chat's model defaults. Presets can capture generation settings, including template and output mode, to seed new chats. Legacy presets without these settings keep the existing default behavior. Completed/stopped/error assistant messages retain their generation and actual load-profile snapshots; changing settings does not rewrite earlier messages.

Before the first send, the parameter sheet shows the selected preset's generation seed, or model defaults when the preset has none. Explicit edits and resets override that seed for the current draft and become the first thread snapshot. Changing the draft's model or preset, or starting another chat, discards its local overrides.

### Advanced generation controls

The sheet groups sampling, templates and output under Advanced. Fields are optional, strictly typed and bounded by `generationControls.ts`. Zero, false and empty arrays remain distinct from absence. The adapter explicitly resets mutable native sampler values for every request because native completion state is reused.

| Product setting | Native field | Product bounds / behavior |
| --- | --- | --- |
| `frequencyPenalty`, `presencePenalty` | `penalty_freq`, `penalty_present` | -2..2; default 0 |
| `penaltyLastN` | `penalty_last_n` | -1..131072 tokens; -1 means context, 0 disables window |
| `typicalP` | `typical_p` | 0..1; default 1 |
| `mirostat`, `mirostatTau`, `mirostatEta` | `mirostat`, `mirostat_tau`, `mirostat_eta` | mode 0/1/2, tau 0..20, eta 0..1; default mode 0. Mirostat bypasses the ordinary sampler chain, including penalties and DRY |
| `xtcProbability`, `xtcThreshold` | `xtc_probability`, `xtc_threshold` | 0..1; probability 0 by default |
| `dryMultiplier`, `dryBase`, `dryAllowedLength`, `dryPenaltyLastN`, `drySequenceBreakers` | canonical `dry_*` fields | multiplier 0..10 (default 0), base 1..10, length 0..256 tokens, window -1..131072; at most 32 literal breakers |
| `topNSigma` | `top_n_sigma` | -1..20; default -1 (off) |
| `stop` | `stop` | at most 32 strings, each 1..256 characters; significant whitespace retained; snapshot arrays are never mutated |
| `nProbs` | `n_probs` | 0..10; default 0. Probability is token likelihood, not answer correctness |
| `reasoningFormat`, `thinkingBudgetTokens`, `thinkingBudgetMessage` | `reasoning_format`, `thinking_budget_tokens`, `thinking_budget_message` | format none/auto/deepseek; budget 0..8192 tokens. Capability/effort and context fit still apply. Structured modes disable reasoning |
| `ignoreEos`, `logitBias` | `ignore_eos`, `logit_bias` | default false / empty; at most 128 numeric pairs, token ID 0..2147483647, bias -100..100; loaded-vocabulary bounds checked natively |

`nProbs` retains at most 64 token positions × 10 candidates, truncating token strings to 256 characters in diagnostic payloads. The limit is applied once at completion; growing probability arrays are not copied each token or persisted into every message.

The app uses only the rc.3 public numeric `[tokenId, bias]` contract; string token names and boolean biases are unsupported. Token IDs belong to the loaded model's vocabulary. Duplicate IDs use the last value, then pairs are stored in token-ID order; zero biases and empty lists remain explicit. The [pinned bridge correction](validation/llama-rn-stage3/native-probability-patch.md) replaces upstream invalid vector indexing with checked entries and rejects IDs outside the loaded vocabulary before sampling. `ignoreEos=true` suppresses every end-of-generation token, overriding any finite bias for those tokens. Model-defined suppressed tokens remain suppressed.

EOS suppression cannot be combined with an explicit structured output mode or a grammar supplied by the template: an exhausted grammar could otherwise have no permitted termination token. The request is rejected without dropping its constraint. Every completion has a finite integer `n_predict` budget, at most 16384 total visible and reasoning tokens; zero is reserved for explicit prefill. Normal responses remain bounded by `maxTokens`. These mapping and safety checks require a native rebuild containing the pinned correction; device acceptance is reported separately.

### Templates, exact counts and prefill

`template` maps `chatTemplate`, `jinja`, scalar `kwargs`, `addGenerationPrompt`, `now`, `forcePureContent` and `prefillText` to the public formatter. Templates are local data for the native formatter, never JavaScript or remotely fetched executable content. Template text and prefill are limited to 32768 characters; kwargs have at most 32 bounded scalar entries.

One frozen `now` and one bounded prepared-request cache feed token counting, context selection, completion and role-normalization retry. Completion receives the prepared `prompt`, avoiding upstream `completion(messages)` reformatting and grammar replacement. Parser, grammar, thinking tags and template stops come from that same formatter result. Explicit output constraints take priority. Special-token count adjustment follows the pinned native tokenizer metadata; an unknown tokenizer cannot be reported as an exact count.

Prefill text is appended once to the formatted prompt and supplied to the parser. JSON modes use a content-only parser and advance the output grammar with that same content prefix, without feeding the template's assistant protocol prefix into a bare JSON grammar. GBNF with nonempty prefill is rejected because this runtime does not advance user grammar with the prefix. An explicit matching final assistant continuation already present in the formatted prompt is reused. The saved transcript is not modified. The advanced diagnostic action evaluates the unsent composer text with `n_predict=0`, without creating an assistant message. Cancellation waits for actual native settlement. Token diagnostics expose a bounded tokenize/detokenize preview; special/media tokens are not promised to round-trip byte for byte.

The raw rc.3 `tokens_predicted` counter excludes the first output token sampled after a multi-token prompt batch. A completed one-token response can therefore report zero; prefill is identified by the requested `n_predict=0`, not by this counter.

### Structured output

The mutually exclusive modes are text, JSON object, JSON Schema and custom GBNF. Explicit GBNF wins over template grammar; a selected JSON format clears conflicting template grammar and uses the public `response_format` / `json_schema` contracts. Retry never removes a constraint to obtain an arbitrary answer.

Schema validation is local and uses a deliberately narrow Draft-7 subset, with no new dependency, network resolution, file resolution or code execution. The input limit is 32768 characters, depth 16 and 512 schema nodes. Acyclic local `$defs`/`definitions` references are expanded within those bounds; remote references, recursive references and unsupported keywords are rejected before native execution. Supported keywords include types, object properties/required/additionalProperties, array items and length limits, string length limits, enum/const, integer bounds and `anyOf`. This is not full JSON Schema support; constructs such as pattern/format, oneOf/allOf and numeric bounds on non-integer types are rejected.

After native settlement, JSON is parsed once and schema results are independently checked against the validated schema. Interrupted, context-full or token-limited JSON is incomplete even if a fragment happens to parse. Available exact content is retained with an invalid/incomplete status, never silently repaired. JSON uses an exact monospace view and exact copy; legacy text presentation remains unchanged. GBNF constrains native decoding but is not represented as an independent post-generation grammar validation.

For multi-model conversations, Pocket AI resolves these snapshots from the thread's **active chat model**, not only the original thread model. Switching models inside a conversation appends a `model_switch` system event while preserving the per-message `modelId` for user and assistant turns.

Current generation parameters include:

- `temperature`, `topP`, `topK`, `minP`, `repetitionPenalty`, `maxTokens`
- `reasoningEffort` (`off | auto | low | medium | high`)
  - type + normalization helpers live in `src/types/reasoning.ts`
  - legacy persisted `reasoningEnabled: boolean` values are migrated via `normalizeReasoningEffort(...)`:
    - `true` -> `medium`
    - `false` -> `off`
    - missing -> `auto`
  - capability + budgeting logic:
    - `src/utils/modelReasoningCapabilities.ts` (`resolveModelReasoningCapability`, `resolveReasoningRuntimeConfig`)
  - chat request mapping:
    - `src/hooks/useChatSession.ts` (`enable_thinking`, `reasoning_format`, `thinking_budget_tokens`, `n_predict`)
  - when the active context budget cannot fit any extra thinking tokens, `useChatSession` disables thinking for that request
- `seed` (`number | null`)
  - `null` means “random seed”
  - a number means “fixed seed”
  - normalize to a non-negative int within `0..2_147_483_647`

Ordinary text presentation strips *leading* reasoning blocks from assistant messages. Structured content, including GBNF, is displayed and copied exactly. Interrupted streaming recovery retains the mode and response configuration and marks structured content incomplete. Supported markers for ordinary text include:

- `<think>...</think>` / `<thinking>...</thinking>`
- `[THINK]...[/THINK]`
- `<|channel>thought ... <channel|>`
- `<|start_thinking|> ... <|end_thinking|>`

- `src/utils/chatPresentation.ts` (`getVisibleAssistantContent`)
- `src/components/ui/ChatMessageBubble.tsx`
- `src/utils/inferenceWindow.ts` (inference window uses visible content)

`model_switch` system events are kept in the transcript for history and UI context, but they are excluded from the inference window so model-change markers never become part of the prompt.

## Load parameters (load profiles)

Load parameters are defined and sanitized in:

- `src/services/SettingsStore.ts` (`ModelLoadParameters`)

They affect native initialization and memory-fit estimation:

- `contextSize`
- `gpuLayers`
- `kvCacheType` (`auto | f16 | q8_0 | q4_0`)
  - optional `cacheTypeK` / `cacheTypeV` override their respective side; an absent side falls back to `kvCacheType`
  - public formats: f16, f32, q8_0, q4_0, q4_1, iq4_nl, q5_0, q5_1; no internal bf16 setting
  - metadata/backend/flash-attention compatibility still determines the effective format; requested and effective values are shown separately
- `mtpEnabled` (`boolean | undefined`)
  - stored per model when the user changes the MTP control
  - `undefined` keeps the model catalog default
  - changing it requires `Apply & reload` for the active model
- `backendPolicy` (`auto | cpu | gpu | npu`)
  - `auto` may reuse a saved stable backend profile from autotune when one exists
  - explicit `cpu` / `gpu` / `npu` bypass Auto selection heuristics

Optional accelerator selectors may also be persisted alongside a load profile:

- `selectedBackendDevices`
  - used when a backend profile targets specific NPU devices discovered on the current device (Hexagon/HTP)
  - device selectors are llama.rn tokens like `HTP0` / `HTP1` / `HTP*` (avoid human-readable GPU labels)

When Advanced Model Controls are enabled, Pocket AI can also persist extra runtime load fields alongside the core profile:

- `cpuThreads`, `cpuMask`, `cpuStrict`
- `flashAttention` (`auto | on | off`)
- `useMmap`, `useMlock`
- `parallelSlots`
- `nBatch`, `nUbatch`
- `kvUnified`

Stage 3 also carries `ropeFreqBase`, `ropeFreqScale`, `noExtraBufts`, `swaFull`, `nCpuMoe` and the public draft controls `specDraftNMax`, `specDraftNMin`, `specDraftPMin`, `specDraftPSplit`, `specDraftNGpuLayers`, `specDraftCacheTypeK`, `specDraftCacheTypeV`. These are load-profile fields and require reload. Draft settings apply only to an admitted draft configuration; minimum cannot exceed maximum, and enabled MTP cannot use a zero maximum. Quantized draft V requests fall back to f16 because rc.3 exposes no independent draft flash-attention policy. The diagnostic profile makes this fallback visible.

All advanced allocation settings participate in reload, last-good, autotune and calibration identities. Old successful profiles do not certify a new allocation. Applying the active profile reserves context ownership, confirms native initialization before persisting the request, and restores the previous complete effective profile on a settled failure. A changed chat/variant cancels restoration; uncertain native ownership cannot publish READY. Safe fallback retains requested/effective diagnostics.

### Reset and partial changes

`Reset all` replaces the complete load draft. After `Apply & reload` succeeds,
advanced overrides (including independent K/V caches, RoPE, memory flags, MoE,
speculative draft options and LoRA) are removed from the applied and saved profile.
Changing a basic value after Reset retains that value without restoring old advanced
options. Inactive models save the replacement for their next load. Reopening or
restarting uses that confirmed profile.

For the current chat, a confirmed Reset also clears its LoRA snapshot together with
the model-default adapter configuration. Ordinary edits preserve the distinction
between the chat's adapter snapshot and the model default. Other chats, other models
and old message snapshots remain unchanged. A partial programmatic update preserves
untouched fields; an explicit `undefined` clears an optional override. Failed or
cancelled reloads do not persist the replacement.
### LoRA profiles

The existing Resources card selects one or more installed `lora_adapter` artifacts and individual scales (-16..16, including 0), then explicitly applies or removes them. Selection, local download and native-confirmed application are separate states. No editor accepts filesystem paths. Resolver checks exact base/variant and artifact identities, managed paths, size, GGUF header, SHA-256 and architecture/adapter metadata; native loading remains the final tensor compatibility check.

Live changes call `applyLoraAdapters`, `removeLoraAdapters` and `getLoadedLoraAdapters` under the context lifecycle lease. Only verified readback followed by cache invalidation commits the effective list. A settled partial failure reloads the previous confirmed profile; a timeout retains original and uncertain paths until native settlement and confirmed release. Applied files cannot be removed even when registry selection has changed. Independent files remain removable when lifecycle ownership permits it.

Ordered adapter identities/scales and verified resident bytes participate in memory fit and allocation identities. Initialization restores the list through `lora_list`; auxiliary A→B→A restores the full actual profile. Each chat has its own adapter snapshot, old chats default to the base model, and response load snapshots record what was used. Regeneration uses the current explicit chat configuration; earlier messages remain unchanged.

KV cache auto-selection is shared logic:

- `src/utils/kvCache.ts`

Resolved runtime inference profile selection lives in:

- `src/services/resolveInferenceProfile.ts`
- `src/services/LLMEngineService.ts`

Vision-capable model loads also apply an internal multimodal safety rule when a compatible projector is available:

- `llama.rn` context shifting is disabled when a vision projector is resolvable at load time so media markers stay aligned with the attached images.
- If a vision-capable model is loaded before a projector is ready, the text-only context keeps the default `llama.rn` context-shifting behavior, then reloads with context shifting disabled before image chat becomes ready.
- This is not exposed as a user setting; text-only model contexts and vision-capable contexts without a ready projector keep the default `llama.rn` behavior.

### Prompt state cache safety policy

`llama.rn` 0.12.7 exposes cross-turn prompt state caching. Pocket AI keeps the policy
infrastructure as an internal load-profile dimension; it is not a user-facing model
parameter.

This is different from the normal KV cache precision control:

- KV cache precision changes the memory format used by the active model context.
- Prompt state caching may retain native checkpoints that can restore a matching prompt
  prefix on a later completion.

Every native initialization path passes an explicit budget and an explicit checkpoint
limit. Production always passes `state_cache_budget_mb: 0` and
`state_cache_max_checkpoints: 8`; the runtime adapter enforces those values even if a
caller supplies a non-zero budget. The app therefore never inherits llama.rn's upstream
default or accidentally enables the cache through a test helper, environment variable, or
fallback path.

The non-zero candidate tiers and normalized GGUF architecture detection remain available
as future-ready policy infrastructure:

- recurrent: Mamba/Mamba 2 and RWKV 6/7 families;
- hybrid: Jamba, Falcon H1, PLaMo 2, Granite hybrid, LFM2, Nemotron H,
  Qwen 3 Next/3.5, Kimi Linear, and their supported MoE variants;
- ineligible: pure-attention and pure sliding-window attention architectures;
- unknown: unrecognized or missing architecture metadata.

That classification does not enable caching in the current production build. Recurrent,
hybrid, CPU, GPU, NPU, low-memory, and memory-pressure profiles all receive 0 MiB. The
reason for an otherwise eligible profile is `native_memory_bound_unverified`.

The fail-closed policy is necessary because the native budget is not a proven hard memory
cap: at least one checkpoint may remain pinned, a replacement can allocate before eviction,
and a recurrent checkpoint's size may be unknown before allocation. Treating a configured
64/128/160 MiB budget as the complete additional peak would therefore make the memory fit
unsafe.

The accurate production estimate records `promptStateCacheBytes: 0`. Cache budget,
checkpoint count, and policy version remain part of calibration, retry, OOM-bound, and
last-good identities. Policy version 2 separates the fail-closed profile from older
non-zero records. An old non-zero last-good profile cannot enable the cache, and a
successful 0 MiB load is not evidence that a future non-zero profile is safe.

Diagnostics expose the selected `stateCacheBudgetMb`, `stateCacheMaxCheckpoints`,
`stateCacheEnabled`, `stateCacheEligibility`, `stateCachePolicyReason`,
`stateCachePolicyVersion`, `promptStateCacheBytes`, normalized architecture, and backend
mode (`stateCacheArchitecture` and the existing `backendMode`). Production diagnostics
must report a 0 MiB budget, `stateCacheEnabled: false`, and
`promptStateCacheBytes: 0`. They deliberately do not claim cache hits, restored tokens,
actual checkpoint count, allocated bytes, or a performance improvement.

Future enablement requires a runtime with a verifiable strict native memory bound plus the
[physical-device validation matrix](./runtime-hardening-device-validation.md). It is
separate follow-up work, not a release toggle in this version.

### Backend discovery (llama.rn)

Pocket AI uses llama.rn backend discovery to decide whether it is safe to attempt GPU/NPU initialization:

- `llama.rn.getBackendDevicesInfo()` provides the discovered devices.
- `devices: string[]` can be passed to llama.rn init to target specific backends.
  - NPU selection is exposed via `HTP*` selectors (for example: `['HTP0']` or `['HTP*']`).

Safety rule:

- If backend discovery is unavailable, Pocket AI forces CPU-only candidates to avoid native crashes on unsupported accelerator paths.

### Backend autotune (benchmark)

Advanced Model Controls can run a backend benchmark (autotune) to measure tokens/sec for a small set of candidates.

- Implementation: `src/services/InferenceAutotuneService.ts`
- Persistence: `src/services/InferenceAutotuneStore.ts`
  - keyed by `modelId`, `contextSize`, `kvCacheType` (and model signature fields when available)
  - cancelled runs are **not** persisted
  - `restorationError` is runtime-only (not persisted)

### Last-good backend profiles (crash recovery / warmup)

Pocket AI also tracks a separate "last known working" backend profile used to make bootstrap recovery more reliable:

- Store: `src/services/InferenceLastGoodProfileStore.ts`
- Used by: `src/services/LLMEngineService.ts` when `LoadModelOptions.preferLastWorkingProfile === true`

This mechanism only reorders already-safe init candidates (it does not override user settings).

Keep UI estimates aligned with runtime:

- Runtime model loading uses `resolveKvCacheTypes(...)` in `src/services/LLMEngineService.ts`.
- UI context-window ceiling estimation uses the same `resolveKvCacheTypes(...)` in `src/hooks/useModelParametersSheetController.ts`.

## UI entry points

The primary UI for changing these settings lives in:

- `src/components/ui/ModelParametersSheet.tsx`
- `src/hooks/useModelParametersSheetController.ts`

GGUF file/quantization selection is separate from load profiles. The catalog and model-details flow selects the active file variant before download/load, while Model Controls continue to manage runtime settings for that selected file.

## MTP speculative decoding

Pocket AI automatically recognizes compatible multi-token prediction (MTP) metadata and filenames:

- Embedded-MTP GGUFs are selectable model variants. When a repository also offers a conventional GGUF, the conventional variant remains the automatic default and MTP can be selected explicitly.
- Gemma models can publish a separate MTP draft GGUF. The draft is treated as an optional companion artifact and is included in download, verification, storage, and RAM estimates when enabled.
- Text generation uses `draft-mtp` speculative decoding. Image and audio requests explicitly disable speculation for that request.
- If the draft is missing, its download fails, or MTP initialization fails, the base model stays available and Pocket AI falls back to ordinary generation.
- Model Controls shows an `Off / On` MTP control only for MTP-capable models. The preference is stored in the model's load profile and never leaks to another model.
- For the active model, MTP changes use the existing transactional reload flow: the new preference is persisted only after the replacement context loads successfully. Failed or cancelled reloads leave the previous preference intact.
- Runtime status distinguishes `Active`, `Disabled`, `Memory fallback`, `Initialization fallback`, a missing companion, and a pending reload.
- Each completed assistant response records native llama.rn telemetry: predicted tokens/sec, time to first token, proposed draft tokens, accepted draft tokens, and acceptance rate. `draftTokens > 0` proves that the native draft loop ran; accepted tokens and stable native throughput are required before claiming a speedup.
- Model Controls also reports app/PSS memory snapshots captured before model load, after model initialization, and after the first generated token when the platform exposes them.

Model details shows whether MTP is embedded, ready, downloading, or needs a companion download. MTP draft-token limits default conservatively from the active quantization. The compact load-profile control enables or disables MTP; Advanced load controls can override the minimum/maximum draft-token limits and other supported draft parameters. These overrides use the same validation, memory admission and transactional reload as the rest of the load profile.

Advanced runtime controls, backend autotune, and runtime diagnostics are shown only when `showAdvancedInferenceControls` is enabled in settings.

When a conversation has switched models in-chat, Model Controls target the thread's current active model so the sheet can correctly choose between `Save load profile` for inactive models and `Apply & reload` for the active chat model.

Guideline:

- Treat `seed` as a generation parameter (no reload).
- Treat `kvCacheType` as a load parameter (reload required for the active model).
- Treat `mtpEnabled` as a per-model load parameter (reload required for the active model).

## Checklist when adding a new model parameter

- Add the field to the `SettingsStore` interface + default + sanitizer.
- Thread snapshot: update `GenerationParamsSnapshot` or load-profile diff utilities as needed.
- Make sure migration/hydration fills a safe value for legacy threads (`AppBootstrap`, `sanitizeHydratedThread`).
- Add localization keys for any new UI copy (`src/i18n/locales/en.json`, `src/i18n/locales/ru.json`).
- Update/extend tests under `__tests__/`.
