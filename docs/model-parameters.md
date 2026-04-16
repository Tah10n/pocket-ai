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
  - used when a backend profile targets specific GPU/NPU devices discovered on the current device

KV cache auto-selection is shared logic:

- `src/utils/kvCache.ts`

Backend policy resolution lives in:

- `src/services/resolveInferenceProfile.ts`
- `src/services/LLMEngineService.ts`

Keep UI estimates aligned with runtime:

- Runtime model loading uses `resolveKvCacheTypes(...)` in `src/services/LLMEngineService.ts`.
- UI context-window ceiling estimation uses the same `resolveKvCacheTypes(...)` in `src/hooks/useModelParametersSheetController.ts`.

## UI entry points

The primary UI for changing these settings lives in:

- `src/components/ui/ModelParametersSheet.tsx`
- `src/hooks/useModelParametersSheetController.ts`

Guideline:

- Treat `seed` as a generation parameter (no reload).
- Treat `kvCacheType` as a load parameter (reload required for the active model).

## Checklist when adding a new model parameter

- Add the field to the `SettingsStore` interface + default + sanitizer.
- Thread snapshot: update `GenerationParamsSnapshot` or load-profile diff utilities as needed.
- Make sure migration/hydration fills a safe value for legacy threads (`AppBootstrap`, `sanitizeHydratedThread`).
- Add localization keys for any new UI copy (`src/i18n/locales/en.json`, `src/i18n/locales/ru.json`).
- Update/extend tests under `__tests__/`.
