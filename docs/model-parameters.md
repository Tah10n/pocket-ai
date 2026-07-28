# Model parameters

This document describes how Pocket AI stores and applies per-model generation parameters and model load profiles.

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

Visible assistant content strips *leading* reasoning blocks from assistant messages. Supported markers include:

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

KV cache auto-selection is shared logic:

- `src/utils/kvCache.ts`

Resolved runtime inference profile selection lives in:

- `src/services/resolveInferenceProfile.ts`
- `src/services/LLMEngineService.ts`

Vision-capable model loads also apply an internal multimodal safety rule when a compatible projector is available:

- `llama.rn` context shifting is disabled when a vision projector is resolvable at load time so media markers stay aligned with the attached images.
- If a vision-capable model is loaded before a projector is ready, the text-only context keeps the default `llama.rn` context-shifting behavior, then reloads with context shifting disabled before image chat becomes ready.
- This is not exposed as a user setting; text-only model contexts and vision-capable contexts without a ready projector keep the default `llama.rn` behavior.

### Automatic prompt state cache

`llama.rn` 0.12.7 adds bounded cross-turn prompt state caching. Pocket AI controls it as
an internal load-profile dimension; it is not a user-facing model parameter.

This is different from the normal KV cache precision control:

- KV cache precision changes the memory format used by the active model context.
- Prompt state caching reserves optional memory for native checkpoints that can restore a
  matching prompt prefix on a later completion.

Every native initialization path passes an explicit budget and an explicit checkpoint
limit. The initial compatibility gate is 0 MiB, and runtime policy can select the largest
high-confidence fit from 160, 128, or 64 MiB. Enabled profiles use a maximum of 8
checkpoints. If no candidate is safe, the explicit budget remains 0 MiB; the app never
inherits llama.rn's upstream default implicitly.

Eligibility comes from normalized GGUF architecture metadata, not model names:

- recurrent: Mamba/Mamba 2 and RWKV 6/7 families;
- hybrid: Jamba, Falcon H1, PLaMo 2, Granite hybrid, LFM2, Nemotron H,
  Qwen 3 Next/3.5, Kimi Linear, and their supported MoE variants;
- disabled: pure-attention, pure sliding-window attention, and unknown architectures.

CPU and supported GPU profiles can use an eligible tier. Mamba 2 and Granite 4 hybrid are
kept at 0 MiB on Hexagon/HTP. Low-memory signals, critical pressure, an uncertain or
borderline base fit, a likely OOM, or a restricted safe-load decision also force 0 MiB.

The whole selected budget is counted once as `promptStateCacheBytes` in the accurate
memory estimate. Calibration cannot shrink that hard cap. Cache budget, checkpoint count,
and policy version are part of calibration, retry, OOM-bound, and last-good identities, so
a safe disabled profile cannot be mistaken for proof that a non-zero profile is safe.
Legacy profiles without these dimensions are read as disabled and must pass the current
policy before a non-zero budget can be used.

Ordinary turns and regeneration leave the native cache available for safe prefix matching.
Changing the loaded model releases the old context and its checkpoints. Each chat request
still sends its complete conversation-scoped prompt and current media set; Pocket AI does
not maintain a separate app-level checkpoint or media cache key.

Diagnostics expose the selected `stateCacheBudgetMb`, `stateCacheMaxCheckpoints`,
`stateCacheEnabled`, `stateCacheEligibility`, `stateCachePolicyReason`,
`stateCachePolicyVersion`, `promptStateCacheBytes`, normalized architecture, and backend
mode (`stateCacheArchitecture` and the existing `backendMode`). They deliberately do not
claim cache hits, restored tokens, actual checkpoint count,
or actual allocated bytes because the native API does not report those values.

The most likely gains are repeated long prefixes, regeneration, edits, recurrent/hybrid
architectures, and some multimodal scenarios. Do not assume a speedup for every model,
backend, prompt, or device; use the
[device validation runbook](./runtime-hardening-device-validation.md) for A/B evidence.

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

Model details shows whether MTP is embedded, ready, downloading, or needs a companion download. MTP draft-token limits are selected conservatively from the active quantization; the user-facing load-profile control enables or disables the resolved MTP configuration rather than editing that native token limit.

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
