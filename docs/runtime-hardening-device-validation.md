# Runtime Hardening Device Validation

Last updated: 2026-07-28

## Purpose

Use this runbook when a change affects llama.rn, model/context lifecycle, prompt state
caching, chat model selection, branch regeneration, multimodal prompt identity, memory
pressure, or notification routing.

Unit tests and a successful native build are required, but they do not prove device
correctness or performance. Record physical-device work separately and never mark a model,
backend, or scenario as passed when its prerequisites were unavailable.

## Evidence rules

Use synthetic chat content and disposable conversations. For every run, record:

- Git commit and whether the worktree was clean;
- app version and llama.rn version;
- device manufacturer/model, OS version, serial alias, total RAM, and supported ABIs;
- build variant, selected ABI, APK SHA-256, and install timestamp;
- model repository/file, quantization, model SHA or stable artifact marker, and projector
  identity when applicable;
- requested and actual backend, GPU layers/devices, context size, KV cache type, MTP mode,
  and prompt state-cache policy;
- cold/warm state, battery/thermal condition, and memory-pressure condition;
- correctness, crash/OOM, TTFT, prompt evaluation duration, and process RSS/PSS;
- report, trace, screenshot, and log paths.

Do not put prompts, generated message text, local attachment paths, media hashes,
notification content, authorization data, or user-created conversation names in a shared
report. Screenshots and UI hierarchies can contain visible content; review them before
sharing.

## Automated preflight

Start from the committed lockfile and a clean dependency tree:

```bash
npm ci
npm run typecheck
npm run lint
npm test
```

For Android changes, build current source instead of relying on an unverified older APK:

```bash
npm run android:smoke
```

Run the fail-closed scenario packs relevant to the change:

```bash
npm run android:scenarios:runtime -- --fail-on-skip
npm run android:scenarios:storage -- --fail-on-skip
npm run android:scenarios:attachments -- --fail-on-skip
npm run android:scenarios:branch-regeneration -- --fail-on-skip
```

The branch-regeneration pack is destructive and requires a disposable, prepared release
fixture. Follow the stricter preconditions in the
[Release Checklist](./release-checklist.md#destructive-branch-regeneration-pack).
`--fail-on-skip` is intentional: an unmet prerequisite is a failed validation result, not
a silent pass.

For iOS dependency integration, run the CocoaPods/install or archive check available on a
macOS host and record the exact command. A Windows or Linux TypeScript/Jest run is not an
iOS build.

## GitHub Android jobs

The normal `verify` job always runs for a pull request. Android jobs are opt-in:

- `android (qa)` runs when the PR body checks an Android box or the PR has an appropriate
  `run-android-*` / `android-pack-*` label. Use `android-pack-native` for broad native
  integration or `android-pack-runtime` for the runtime pack.
- `android (branch regeneration)` runs only with
  `android-pack-branch-regeneration`. It needs the dedicated prepared self-hosted runner
  and does not run alongside `android-pack-all`.

Do not weaken workflow conditions to make a job appear green. If a label, prepared runner,
device, model, projector, or fixture is missing, record that exact reason and keep the
combination in the unverified list.

## Minimum device matrix

Use at least the following when artifacts and hardware are available:

| Role | Examples | Required cache expectation |
|---|---|---|
| Recurrent/hybrid text | LFM2/LFM2.5, Granite 4 hybrid, Qwen 3.5, Mamba/RWKV | Adaptive 64/128/160 MiB only after a high-confidence fit |
| Pure-attention control | Llama, Qwen 2/3, Gemma | Explicit 0 MiB |
| Multimodal | A compatible model plus its projector | Policy-selected tier with media identity checks |

Exercise:

- CPU;
- OpenCL GPU, when discovered and actually selected;
- Hexagon/HTP NPU, when discovered and actually selected.

Granite 4 hybrid and Mamba 2 must report 0 MiB on Hexagon/HTP. Do not infer an accelerator
result from the requested profile; confirm the actual runtime backend and device list.

## Prompt state-cache checks

Before testing, inspect runtime diagnostics. Each context must report:

- `stateCacheBudgetMb`;
- `stateCacheMaxCheckpoints`;
- `stateCacheEnabled`;
- `stateCacheEligibility`;
- `stateCachePolicyReason`;
- `stateCachePolicyVersion`;
- `promptStateCacheBytes`;
- `stateCacheArchitecture`;
- `backendMode`.

The native init parameters must be explicit even when the budget is 0 MiB. Enabled cache
uses 8 maximum checkpoints. Verify that the accurate memory estimate includes the complete
configured budget and that the selected candidate still fits after the budget is added.

Run these scenarios:

1. Start from a cold model load and send the first synthetic request.
2. Send several warm turns with a long shared prefix.
3. Regenerate the last answer.
4. Edit an earlier user message and regenerate the branch.
5. Create a new chat with the same system prompt but different synthetic facts.
6. Create another chat with a different system prompt.
7. Confirm a naturally disabled 0 MiB profile with the pure-attention control.
8. Confirm a non-zero adaptive profile on an eligible architecture with sufficient
   headroom.
9. Repeat under low headroom or memory pressure and confirm a safe downgrade, ideally to
   0 MiB.
10. Switch model A to B and back to A.

Correctness gates:

- no ordinary turn or regeneration performs an unconditional full cache clear;
- the answer in a new chat does not contain facts supplied only to another chat;
- model switch releases the old context and does not transfer checkpoints;
- low-memory, critical-pressure, unknown, borderline, likely-OOM, and insufficient-
  confidence decisions never get a non-zero tier;
- a 160 MiB OOM does not prevent the corresponding 0 MiB profile from loading;
- a successful 0 MiB profile is not treated as proof that 160 MiB is safe.

Current llama.rn APIs do not expose authoritative cache-hit, restored-token, checkpoint-
count, or actual-allocation metrics. Do not derive them by parsing unstable native log
text. Compare only correctness and available measurements such as TTFT, prompt evaluation
duration, process RSS/PSS, and normalized model/backend/profile identity.

## Multi-model chat checks

1. Create chat A on model A.
2. Load model B from Models.
3. Return to chat A.
4. Confirm input stays blocked until model A is ready.
5. Confirm the thread still names A and no generation starts on B.
6. If A is downloaded, use the explicit load/retry action and wait for A.
7. If A is missing, confirm the unavailable state and Models action without changing the
   thread to B.
8. Begin a header model selection and immediately switch chats.
9. Begin two rapid selections in the same chat and confirm only the latest selection wins.
10. Leave the chat while selection is in flight and confirm the callback is invalidated.
11. Exercise normal send, regenerate, edited regeneration, and image/audio send where
    supported.

At the native boundary, the thread model and engine model must match. A mismatch must not
start completion, append a placeholder, change the thread model, or leave a branch
transaction active.

## Cancellation and history checks

1. Stop during attachment or prompt preparation.
2. Start a pre-native branch regeneration and clear all chat history.
3. Repeat at the native-completion boundary.
4. Stop after partial output.
5. Relaunch after each destructive case.

Confirm:

- prompt preparation and native completion are both stopped or drained;
- the branch transaction settles;
- a canceled answer cannot appear in the next request;
- cleared messages do not return after a late callback or relaunch;
- Storage Manager reports `chat_history_busy` and offers retry if the postcondition is
  not met;
- an already-empty history clear remains successful.

## Multimodal identity checks

Use two synthetic images with visibly different content:

1. Send image A and a follow-up that intentionally refers to A.
2. In an independent request or replaced branch, send image B and confirm A-only semantics
   do not leak into B.
3. Remove the image and send a text-only request; confirm no old image influences it.
4. Replace the file content at the same app-owned path through the supported attachment
   workflow and confirm the prepared identity changes.
5. Switch model A to B and back to A while a compatible projector is in use.

Record projector identity and readiness for each step. Do not invent an app-level media
cache key or bypass the existing attachment validation flow.

## Notification checks

1. Launch the app and grant or inspect notification permission while root initialization
   is running.
2. Repeat initialization-related actions rapidly.
3. Background and foreground the app, then relaunch it.
4. Tap one inference notification for an existing thread; confirm exactly one navigation.
5. Delete a thread, then tap an older notification for it.
6. Clear all history, then exercise another stale notification.
7. Exercise malformed or missing thread identifiers through the available QA fixture.

Confirm one response listener, no subscription after dispose, clean retry after setup
failure, no duplicate `router.push`, and no invalid `activeThreadId`. A stale target must
show neutral localized copy and open the conversation list. Logs and traces must not
contain notification content or conversation names.

## A/B measurement protocol

For each supported model/backend/profile combination:

1. Stabilize thermal state and close unrelated memory-heavy apps.
2. Record one cold request after a fresh model load.
3. Record at least three warm turns with the same long prefix.
4. Record one regeneration and one edit/regeneration.
5. Repeat the same scenario for the available 0 MiB control and adaptive profile.
6. Capture median TTFT, prompt evaluation duration, and RSS/PSS; also retain each raw
   sample and any crash/OOM.

Do not compare different prompt text as if it were an A/B result. A performance claim is
valid only when correctness is unchanged and model artifact, backend, sampling parameters,
context size, prompt, device state, and build are comparable. Report “no measurable
conclusion” when the available data cannot support one.

## Result template

| Field | Result |
|---|---|
| Git commit / clean worktree | |
| App / llama.rn version | |
| Device / OS / ABI / RAM | |
| Build variant / APK SHA-256 | |
| Model / quantization / artifact identity | |
| Projector identity | |
| Requested / actual backend | |
| Context / KV / MTP profile | |
| State-cache budget / reason / policy version | |
| Cold TTFT / prompt duration / RSS-PSS | |
| Warm TTFT / prompt duration / RSS-PSS | |
| Regenerate/edit result | |
| Chat/model isolation result | |
| Multimodal isolation result | |
| Notification result | |
| Crash/OOM | |
| Evidence paths | |
| Unverified combinations and reason | |

Finish by listing every unavailable device, model, projector, backend, pressure condition,
and scenario explicitly. A successful build or emulator smoke pass must not be reported as
physical-device model validation.
