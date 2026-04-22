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
- `backendPolicy` (`auto | cpu | gpu | npu`)
  - `auto` may reuse a saved stable backend profile from autotune when one exists
  - explicit `cpu` / `gpu` / `npu` bypass Auto selection heuristics

Optional accelerator selectors may also be persisted alongside a load profile:

- `selectedBackendDevices`
  - used when a backend profile targets specific NPU devices discovered on the current device (Hexagon/HTP)
  - device selectors are llama.rn tokens like `HTP0` / `HTP1` / `HTP*` (avoid human-readable GPU labels)

KV cache auto-selection is shared logic:

- `src/utils/kvCache.ts`

Backend policy resolution lives in:

- `src/services/resolveInferenceProfile.ts`
- `src/services/LLMEngineService.ts`

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

When a conversation has switched models in-chat, Model Controls target the thread's current active model so the sheet can correctly choose between `Save load profile` for inactive models and `Apply & reload` for the active chat model.

Guideline:

- Treat `seed` as a generation parameter (no reload).
- Treat `kvCacheType` as a load parameter (reload required for the active model).

## Checklist when adding a new model parameter

- Add the field to the `SettingsStore` interface + default + sanitizer.
- Thread snapshot: update `GenerationParamsSnapshot` or load-profile diff utilities as needed.
- Make sure migration/hydration fills a safe value for legacy threads (`AppBootstrap`, `sanitizeHydratedThread`).
- Add localization keys for any new UI copy (`src/i18n/locales/en.json`, `src/i18n/locales/ru.json`).
- Update/extend tests under `__tests__/`.
