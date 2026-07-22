# Release Checklist

Last updated: 2026-07-22

## Purpose

Use this checklist before cutting a preview or production release. It is written for maintainers of this repository and focuses on the local-model workflow, mobile UX stability, and release-facing metadata.

## Build configuration

- App display name: `Pocket AI`
- Expo slug: `pocket-ai`
- Store-visible version is read from `app.json -> expo.version`
- The next Android Play upload code is stored in `app.json -> expo.android.versionCode`
- Deep-link scheme: `pocketai`
- Android application ID: `com.github.tah10n.pocketai`
- iOS bundle identifier: `com.github.tah10n.pocketai`
- Android release signing is loaded from local `keystore.properties` at the app root or `POCKET_AI_UPLOAD_*` environment variables
- Local Android release builds write the signed AAB to `android/app/build/outputs/bundle/release/app-release.aab`
- Release provenance is written to `artifacts/android-release/build-provenance-release-universal.json`
- Universal Android release artifacts contain exactly `arm64-v8a` and `x86_64`, including the required React Native and `llama.rn` libraries for both ABIs

## Release metadata

This repository uses **Release Please** to automate:

- `app.json -> expo.version`
- `package.json -> version`
- `.release-please-manifest.json` release state
- [`CHANGELOG.md`](../CHANGELOG.md)

If you're cutting a user-facing store release:

- Merge the Release Please **Release PR** (it updates versions, release state, and changelog).
- Avoid manual edits to the version, manifest, or changelog files in the normal flow.
- After the local production build, if `app.json` reserves the next Android `versionCode`, carry that change in a small follow-up commit/PR. Do not expect to add it to the already-merged Release PR.

Notes:

- Release Please derives version bumps from merged PR titles (Conventional Commits).
- If `main` requires status checks, configure a PAT secret (for example `RELEASE_PLEASE_TOKEN`) so CI runs on Release PRs.

## Pre-flight checks

Install the exact dependency state from the committed lockfile:

```bash
npm ci
```

Run the local verification gate before cutting a build:

```bash
npm run verify:release
```

This expands to:

```bash
npm run typecheck
npm run lint
npm test
```

If the release affects model loading, chat, downloads, storage, or navigation behavior, also run an Android phone smoke pass with a connected device:

```bash
npm run android:smoke
```

If Metro reports an unreadable serialized cache or the debug device appears to run a stale
bundle, use `npm run android -- --clear-metro-cache`. The explicit flag starts a fresh Metro
instance with its disk cache reset instead of silently reusing the running server.

If the release changes shared theme, tab chrome, routed headers, localization fit, or motion behavior, also run the UI hardening gate:

```bash
npm run verify:mobile-change
npm run android:scenarios -- --skip-build --pack dependency-ui
node ./scripts/android-scenarios.js --skip-build --scenario hf-catalog-hardening
node ./scripts/android-screen-capture.js --skip-build --screen home,models,settings,conversations,huggingface-token,model-details --output-dir artifacts/android-scenarios/manual-sample
```

`npm run android:scenarios` defaults to the small core pack (`home-smoke`, `bottom-tabs`, `new-chat-cta`). Use `--pack catalog` or `--scenario variant-picker-smoke` for live model-catalog checks, `--pack dependency-ui` for shared theme, tab chrome, routed headers, or motion changes, `--pack runtime` for localization or state behavior, `--pack native` for Expo or native-module changes, and `--pack extended` when you need the broader stable pass without live catalog smoke. The explicit state-mutating cache check is `npm run android:scenarios:storage -- --skip-build`; it is intentionally excluded from `all`. Keep noisy perf and other optional checks targeted via `--scenario <id>` or `--pack all`.

For a final current-source Android matrix, use fail-closed packs so an unmet precondition is
reported as a failure instead of a silent pass:

```bash
npm run android:scenarios:runtime -- --fail-on-skip
npm run android:scenarios:storage -- --fail-on-skip
npm run android:scenarios:attachments -- --fail-on-skip
npm run android:scenarios:branch-regeneration -- --fail-on-skip
```

The branch-regeneration command already selects a release APK and requires current-head
build/install provenance. Do not add `--skip-build` or `--preserve-running-app` to that
command. Record the device model, serial, supported ABI list, selected ABI, final Git HEAD,
APK SHA-256, report path, and the result of every step in the release evidence.

For PR CI, `android-pack-catalog` selects the catalog pack. If multiple Android pack labels are applied, CI uses this priority order: `android-pack-all`, `android-pack-native`, `android-pack-runtime`, `android-pack-dependency-ui`, `android-pack-catalog`, then `android-pack-extended`.

## Build commands

The repository build command generates `android/` when it is missing. It also runs a clean
Expo prebuild when the active stamp, prebuild inputs, build variant, private-input HMAC, or
generated native-project digest no longer matches. Do not manually preserve a stale native
tree to avoid regeneration.

If Gradle fails with "SDK location not found", make sure the Android SDK is installed and either:

- set `ANDROID_HOME` / `ANDROID_SDK_ROOT`, or
- create `android/local.properties` with `sdk.dir=...` (for example `sdk.dir=C:/Users/<you>/AppData/Local/Android/Sdk` on Windows)

Create the Play Store Android App Bundle locally:

```bash
npm run build:android:production
```

This command uses `expo.version` as `versionName`, uses the current
`expo.android.versionCode` as the upload code, and after a successful build reserves the
next `versionCode` in `app.json`. It runs in an isolated Gradle user home with task reruns
forced and both build and configuration caches disabled.

After a successful build, `app.json` is expected to change (the next `expo.android.versionCode` is reserved). Commit this change in a small follow-up commit/PR so the next upload code is not lost.

Only override the version values when recovering from a failed or custom release flow:

```bash
npm run build:android:production -- --version-code 2 --version-name 1.0.1
```

`versionCode` must be between `1` and `2100000000`. For the default auto-bumping bundle
task, reservation fails before any mutation when the build already uses the maximum; use
`--no-bump` only when that is an intentional final bundle publication code. The
assemble-only APK task does not reserve a next code.

The build script forces `NODE_ENV=production`, accepts only the repository-owned
`app:bundleRelease`/`:app:bundleRelease` and `app:assembleRelease`/`:app:assembleRelease`
contracts, and rejects external Gradle/JVM topology, signing, architecture, init-script,
argument-file, and user-home overrides. It recomputes inputs after Gradle, verifies the
artifact's exact ABI/native-library contract, writes SHA-256 provenance atomically, and only
then reserves the next upload code. See the
[Android Build Guide](./android-build.md#hermetic-gradle-execution) for the complete contract.

## Android signing setup

Keep both signing files outside the generated `android/` tree:

- `keystore.properties`
- `keystores/pocket-ai-upload.jks`

Generate an upload keystore once and keep it outside version control:

```bash
keytool -genkeypair -v -storetype PKCS12 -keystore keystores/pocket-ai-upload.jks -alias pocketai -keyalg RSA -keysize 2048 -validity 10000
```

Store the signing credentials in `keystore.properties` at the app root:

```text
storeFile=keystores/pocket-ai-upload.jks
storePassword=your-store-password
keyAlias=pocketai
keyPassword=your-key-password
```

## Destructive branch-regeneration pack

`npm run android:scenarios:branch-regeneration -- --fail-on-skip` is an ordered, one-shot
device test. It mutates the prepared fixture, deletes that fixture near the end, and clears
all chat history in the final step. Run it only against disposable QA app data. Back up any
conversation you care about before starting; a successful run cannot be repeated without
preparing the fixture again.

### Preconditions

- Connect one selected device/emulator and make enough storage available for a verified
  release APK build or exact-input reuse and install.
- Use only synthetic, non-sensitive prompts, model labels, and attachment names. Per-step
  screenshots and UI hierarchy XML preserve visible fixture text and are not sanitized.
- Prepare two recent conversations: the branch fixture first and a separate clear-history
  sentinel second.
- Load a selectable local model and wait for model warm-up to settle.
- In the fixture, create completed user/assistant pairs in this oldest-to-newest order:
  audio when the installed runtime exposes audio attachments, document, image, reasoning,
  and the ordinary main turn.
- Ensure every required user turn exposes regeneration and every target assistant is
  complete. End the fixture with the main assistant immediately followed by a model-switch
  marker.
- Keep the fixture short enough for the runner to reach its history-start accessibility
  anchor within 24 viewports.

Audio is the only conditional target. If the installed runtime does not expose the audio
attachment action, step 13 records `not_applicable` with explicit evidence. If audio is
exposed, the audio fixture is mandatory and any missing precondition fails the pack.

### Ordered steps

| Step | Stable scenario ID | Durable gate |
|---:|---|---|
| 1 | `branch-regeneration-01-fixture` | Authenticates the two prepared conversations, loaded model, complete ordered target turns, regeneration actions, attachment identities, reasoning surface, and trailing model-switch marker. |
| 2 | `branch-regeneration-02-trailing-model-switch` | Confirms the main assistant is complete and is followed by the exact model-switch marker. |
| 3 | `branch-regeneration-03-force-stop-before-token` | Starts main-turn regeneration behind the QA gate, proves a newly owned operation exists, and force-stops before first output. |
| 4 | `branch-regeneration-04-relaunch-old-branch` | Relaunches and proves the original complete assistant plus model-switch marker remain authoritative, with the interrupted assistant absent and no duplicate IDs. |
| 5 | `branch-regeneration-05-force-stop-after-partial` | Starts another regeneration, waits for real durable partial output, records the new assistant identity, and force-stops. |
| 6 | `branch-regeneration-06-relaunch-partial-branch` | Relaunches and proves exactly one stopped replacement exists while the old assistant and trailing marker are absent. |
| 7 | `branch-regeneration-07-success` | Completes regeneration and proves a new complete assistant immediately follows the target user, atomically replacing the stopped branch. |
| 8 | `branch-regeneration-08-stop-before-output` | Stops before output and proves the step-7 complete branch remains authoritative and the interrupted assistant is absent. |
| 9 | `branch-regeneration-09-stop-after-partial` | Stops after durable partial output and proves exactly one stopped replacement exists without duplicate IDs. |
| 10 | `branch-regeneration-10-reasoning-clear` | Regenerates the reasoning turn with reasoning disabled and proves stale thought content is absent both after settle and after relaunch. |
| 11 | `branch-regeneration-11-image-attachment` | Regenerates the image turn and proves user attachment identity reaches the new complete assistant generation. |
| 12 | `branch-regeneration-12-document-attachment` | Regenerates the document turn and proves user attachment identity reaches the new complete assistant generation. |
| 13 | `branch-regeneration-13-audio-attachment` | Regenerates and verifies audio identity when supported, or records why audio is not applicable. |
| 14 | `branch-regeneration-14-delete-conversation` | Deletes the fixture through the user-facing conversation control and proves it leaves the recent list. |
| 15 | `branch-regeneration-15-clear-history-relaunch` | Clears history through Storage Manager, force-stops, relaunches, and proves both fixture and sentinel remain deleted. |

The runner takes a full pre-operation assistant baseline for every regeneration. A successful
replacement must be a new complete assistant directly adjacent to the target user; an
unrelated, reused, non-complete, or reordered assistant cannot satisfy the gate. Each step
also fails on duplicate message IDs, unexpected topology, missing evidence, or fatal app
logs. The complete pack also fails if either its initial or final current-head provenance
validation is stale.

### Evidence

The runner writes an atomic summary to
`artifacts/android-scenarios/latest-report.json`, the build/install chain to
`artifacts/android-scenarios/build-provenance-latest.json`, and per-step screenshot, UI dump,
and sanitized log evidence beneath `artifacts/android-scenarios/branch-regeneration/`.
The runner validates provenance before the first step and again after the final step; on
success, the report stores the final top-level provenance summary plus exactly 15 ordered
scenario results rather than two separate successful provenance rows. Confirm all 15
results are accounted for, no required step is skipped, and the APK/device/final-HEAD
identity matches the release record. Manually inspect screenshots and XML before sharing
them because their visible fixture content is raw.

Only QA release builds expose the accessibility topology and deterministic generation gates
used here. The shipping release build rejects QA evidence flags, so these controls are not
part of the production app surface.

## Manual QA checklist

### Clean start

- Install a fresh build on a clean device or emulator.
- Confirm the splash screen, app icon, display name, and package metadata match `Pocket AI`.
- Confirm first launch reaches the tab shell without bootstrap crashes.

### Model flow

- Open `Models`.
- Search the Hugging Face catalog while online.
- Confirm `All Models` and `Downloaded` render as one segmented control inside the same page, not as two separate standalone buttons.
- On first catalog open with no Hugging Face token configured, confirm guided discovery defaults to RAM-friendly public models and offers `Show full catalog`.
- Search for a public GGUF model whose list metadata does not expose a reliable size and confirm the card shows `Loading size…` while metadata is resolving, then a resolved size or `Unknown`, never `0.00 GB`.
- Confirm size labels use decimal units (1 GB = 1,000,000,000 bytes).
- For a model with multiple GGUF files, open the variant picker from a catalog card and confirm each option shows quantization, file name, size, and RAM-fit status.
- Select a non-default variant and confirm the catalog card updates its size and RAM-fit label without losing access state or jumping the list.
- Open `Filter` and `Sort` and confirm both panels stay collapsed by default, open independently, use the compact trigger style, and do not permanently steal list height.
- In `Filter`, confirm the visible criteria are limited to RAM, token, and size choices; do not show separate lifecycle categories such as `Available`, `Downloading`, or `Downloaded`.
- Apply `No token required` and confirm gated/private repositories are excluded.
- Apply `Most downloaded` and `Most popular` and confirm the catalog order updates without breaking cursor pagination.
- Scroll through at least three catalog pages and confirm autoload appends unique results without jumping back or duplicating model IDs.
- Force a later-page failure if possible and confirm the footer keeps earlier results visible and offers a retry path.
- After a later-page failure, use `Retry` and confirm the catalog resumes from the same cursor without duplicating models or getting stuck on an expired buffered page.
- Relaunch the app after a successful catalog load and confirm the recent first-page results appear quickly from local cache, then refresh cleanly when the network is available.
- Search for a gated Hugging Face model with no token configured and confirm the primary action routes into token setup instead of a normal download.
- Save a valid Hugging Face token and confirm a newly accessible gated model leaves the locked state without restarting the app.
- Save an invalid or insufficient Hugging Face token and confirm the affected model shows `Access denied` with a recovery path.
- Open model details from a catalog card and confirm description, tags, popularity metrics, and the `Open on HF` action render without breaking list navigation.
- Open the variant picker from model details and confirm the selected variant matches the catalog card, including file name, size, and RAM-fit status.
- Change the Hugging Face token state, then reopen a gated or private model from the catalog and confirm the card plus detail screen agree on `Locked`, `Access denied`, or authorized access instead of showing stale access labels.
- Download the selected GGUF variant and wait for verification to finish.
- While a download is active, background the app and confirm the Android foreground-service notification stays visible and continues updating.
- On Android 13+, confirm the app requests notification permission when starting a download and denying it does not crash the app.
- After download completion, confirm the selected variant remains active, the model appears in `Downloaded` without requiring a manual refresh, and load/settings actions target the downloaded file.
- Confirm model cards stay compact and do not render a separate `Status` chip.
- Confirm RAM-fit badges on model cards and the model-details hero use short user-facing labels such as `Fits in RAM`, `Near RAM limit`, or `Won't fit RAM`, and do not expose internal terms like `OOM` or confidence levels.
- On a downloaded model card, confirm the secondary `Settings` action opens the model controls sheet without leaving the list.
- In model controls, confirm the context-window ceiling reflects the verified model limit or estimated device RAM headroom instead of exposing an obviously unsafe maximum.
- Change the context window or GPU layers and confirm the sheet shows the pending load-profile state plus `Save load profile` for an inactive model or `Apply & reload` for the active model.
- Change the KV cache type and confirm the sheet treats it as a load-profile change (persisted per-model, reload-required for the active model).
- Switch the seed between `Random` and `Fixed`, set a numeric seed value, and confirm it affects the next response without requiring a reload.
- On an Android device without compatible acceleration backends (for example Snapdragon 888 / SM8350), confirm NPU is not offered (or is disabled), loading uses a safe fallback, and model load does not crash.
- On an Android device with compatible acceleration backends (SM8450+ / Snapdragon 8 Gen 1+), confirm NPU is offered and can load a model without crashing.
- Try loading a model or load profile that exceeds the estimated RAM budget and confirm the app shows a memory warning or blocks the load instead of crashing during native initialization.
- Try loading a model that only fits at the minimum context window (512 tokens) and confirm it is marked as `Won't fit RAM` and loading is disabled.
- Load the model and confirm the app reports the engine as ready.
- With the model active, apply a changed load profile and confirm the model reloads successfully with the updated settings.
- Unload the model and confirm the UI returns to the unloaded state.

### Multimodal attachments and MTP

- Load a known image-capable model with its matching projector and confirm the composer exposes image attachment only after runtime vision support is ready.
- Select an image through the system picker, confirm preview and remove both work, then send it and verify the local model returns a grounded response.
- Load a known audio-capable model with its matching projector and confirm WAV/MP3 attachment is available only after runtime audio support is ready; send one fixture and verify a grounded response.
- Attach a supported local text document and a text-based PDF, confirm bounded local extraction reaches the model, then verify a scanned/textless PDF reports the specific no-extractable-text recovery message.
- Confirm an unsupported model, missing or mismatched projector, or failed multimodal initialization keeps text-only chat available without exposing an attachment action that cannot succeed.
- Relaunch after a successful attachment send and confirm the message preview and attachment metadata restore with the conversation.
- Delete an attachment message or conversation and confirm its app-owned attachment file is removed when cleanup runs.
- Confirm new video attachment is unavailable and the UI does not claim direct-video or sampled-frame support.
- With an embedded-MTP model, confirm Model Controls exposes the MTP toggle, the model loads with MTP enabled, and a text response completes without affecting image/audio requests.
- With a compatible Gemma model that uses a separate MTP draft GGUF, confirm the companion download, verification, storage accounting, and model-detail readiness state stay aligned.
- Force a missing draft, failed draft download, or MTP initialization failure and confirm the base model remains usable through ordinary generation.
- Toggle MTP for the active model and confirm the transactional reload either commits the new setting after a successful load or preserves the prior setting after failure/cancellation.

### Chat and history

- Open `Chat` and send a prompt with a loaded model.
- Confirm streaming, stop, and regenerate behavior.
- Switch to a different downloaded model from the chat header and confirm the current conversation stays open, the header updates to the selected model, and a `Model switched` system row appears in the transcript.
- After switching models in chat, open Model Controls and confirm the active chat model shows `Apply & reload` instead of `Save load profile`.
- Switch models more than once in the same conversation, then edit or regenerate an older user turn and confirm the rebuilt branch stays aligned with the intended active model.
- Start a longer generation, then background the app and confirm Android shows a persistent generation notification and a completion notification when finished. Tap the notification and confirm it returns you to the chat.
- During visible partial output, force-stop the app, relaunch it, and confirm only the last
  committed partial prefix is recovered as stopped without duplicating the assistant turn
  or resurrecting a replaced branch.
- While sending, confirm the header stays stable, does not add a redundant `Generating` label, and the composer does not visibly jump on Android.
- With the Android keyboard open, confirm the composer keeps a small but visible gap above the keyboard instead of touching it or floating too high.
- Confirm the preset and model chips stay aligned to the normal chat content inset and do not inherit extra left offset from the back-button slot.
- On a device with a gesture area or home indicator, confirm the composer keeps safe bottom spacing and the send button never falls into the unsafe zone.
- If the active model exposes reasoning, expand `Thinking` or `Thought` and confirm the main reply remains outside the inner reasoning bubble.
- Copy an assistant reply and confirm the clipboard contains only the final assistant message, not the reasoning trace.
- Raise `Max tokens` for the active chat profile and confirm the app still keeps room for recent chat history instead of dropping to an empty prompt window unnecessarily.
- Leave and reopen the app, then confirm the active thread restores correctly.
- Open `All Conversations`, then search, rename, and delete a thread.
- Expand `Chat Retention`, change the retention window, and confirm the control starts collapsed again after applying.

### Settings and disclosures

- Switch theme between `light`, `system`, and `dark`.
- Switch language between English and Russian.
- Open `Settings` and confirm the `Memory (RAM)` card refreshes while the screen stays open, the Android `App` memory value responds when loading or unloading a model, the RAM card shows conservative available memory instead of a misleading raw free-memory figure, and the RAM plus storage cards do not repeat the same free or available value in multiple places.
- Open `Privacy & Disclosures` from `Settings` and confirm the content renders correctly.
- Open the Hugging Face token screen from `Settings`, verify save and clear both work, confirm the token field remains masked, and verify the education copy plus `Get token` external-link CTA.
- Open `Presets` and confirm preset creation, editing, activation, and deletion still work.

### Shared UI hardening follow-up

- Review `Home`, `Chat`, `Models`, and `Settings` with the shared tab chrome and confirm tab labels, icon contrast, and header rhythm remain consistent.
- Review `Conversations`, `Presets`, `Storage Manager`, `Privacy & Disclosures`, `Hugging Face Token`, `Model Details`, and the modal route and confirm routed back affordances stay in one visual zone.
- Recheck the shipped routes in both English and Russian at the defined dynamic-type checkpoints.
- Run one approved iOS smoke pass plus one weak-device or low-memory Android pass when shared motion or typography changes.

### Storage and cleanup

- Open `Storage Manager` on a device that already has chats, downloaded models, and rebuildable temporary files. Confirm it shows an explicit calculating state instead of false zero or empty values, resolves the real values promptly, and remains responsive while measuring cache usage. The live React Native HTTP cache is intentionally excluded because deleting it behind the active networking client can stall requests.
- Run `npm run android:scenarios:storage -- --skip-build` and confirm the real private-cache sentinel is removed. Confirm the action does not immediately repopulate the catalog cache or surface a handled network timeout as a red-screen error.
- Rapidly tap the routed back affordance twice and confirm only one navigation occurs without leaving the app or logging an unhandled `GO_BACK` action.
- Remove a downloaded model with `Delete and keep settings` and confirm the file is removed while its saved per-model settings remain available after downloading the same model again.
- Remove a downloaded model with `Delete and reset settings` and confirm both the file and the saved per-model settings are cleared.
- Clear chat history during or after partial generation, relaunch, and confirm saved
  threads plus all active-response recovery data are removed. Repeat with thread deletion
  and confirm the deleted conversation cannot be recovered.
- Reset settings and confirm defaults are restored.

## Release-facing files to keep aligned

When release behavior or product messaging changes, check these files together:

- [`README.md`](../README.md)
- [`CHANGELOG.md`](../CHANGELOG.md)
- [`app.json`](../app.json)
- [`package.json`](../package.json)
- [`.release-please-manifest.json`](../.release-please-manifest.json)
- [`plugins/withAndroidReleaseConfig.js`](../plugins/withAndroidReleaseConfig.js)
- [`plugins/withAndroidQaReleaseGuard.js`](../plugins/withAndroidQaReleaseGuard.js)
- [`scripts/build-android-release.js`](../scripts/build-android-release.js)
- [`scripts/android-build-provenance.js`](../scripts/android-build-provenance.js)
- [`scripts/android-smoke.js`](../scripts/android-smoke.js)
- [`scripts/android-scenarios.js`](../scripts/android-scenarios.js)
- [`eas.json`](../eas.json)
- [`docs/android-build.md`](./android-build.md)
- [`docs/runtime-performance.md`](./runtime-performance.md)
- [`docs/model-parameters.md`](./model-parameters.md)
- [`docs/multimodal-attachments.md`](./multimodal-attachments.md)
- [`docs/privacy-disclosures.md`](./privacy-disclosures.md)

## Notes

- `Pocket AI` depends on native modules for local inference, so release validation should use native builds rather than Expo Go.
- Emulator smoke checks are useful, but they are not a substitute for testing at least one real device when changing model loading, storage, or long-running chat behavior.
