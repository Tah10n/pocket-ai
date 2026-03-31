# Release Checklist

Last updated: 2026-03-31

## Purpose

Use this checklist before cutting a preview or production release. It is written for maintainers of this repository and focuses on the local-model workflow, mobile UX stability, and release-facing metadata.

## Build configuration

- App display name: `Pocket AI`
- Expo slug: `pocket-ai`
- Deep-link scheme: `pocketai`
- Android application ID: `com.github.tah10n.pocketai`
- iOS bundle identifier: `com.github.tah10n.pocketai`
- EAS profiles in [`eas.json`](../eas.json): `development`, `preview`, `production`

## Pre-flight checks

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

If the release affects model loading, chat, downloads, storage, or navigation behavior, also run an Android emulator smoke pass:

```bash
npm run android:emulator
```

If the release changes shared theme, tab chrome, routed headers, localization fit, or motion behavior, also run the UI hardening gate:

```bash
npm run verify:mobile-change
node .\scripts\android-scenarios.js --emulator --skip-build --scenario home-smoke
node .\scripts\android-scenarios.js --emulator --skip-build --scenario bottom-tabs
node .\scripts\android-scenarios.js --emulator --skip-build --scenario hf-catalog-hardening
node .\scripts\android-scenarios.js --emulator --skip-build --scenario hf-token-education
node .\scripts\android-scenarios.js --emulator --skip-build --scenario conversations-management
node .\scripts\android-screen-capture.js --emulator --skip-build --screen home,models,settings,conversations,huggingface-token,model-details --output-dir artifacts/android-scenarios/manual-sample
```

## Build commands

Use the committed EAS profiles:

```bash
npm run build:android:preview
npm run build:android:production
npm run build:all:production
```

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
- Search for a public GGUF model whose list metadata does not expose a reliable size and confirm the card shows a resolved size or `Unknown`, never `0.00 GB`.
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
- Change the Hugging Face token state, then reopen a gated or private model from the catalog and confirm the card plus detail screen agree on `Locked`, `Access denied`, or authorized access instead of showing stale access labels.
- Download a GGUF model and wait for verification to finish.
- Confirm model cards stay compact and do not render a separate `Status` chip.
- On a downloaded model card, confirm the secondary `Settings` action opens the model controls sheet without leaving the list.
- In model controls, confirm the context-window ceiling reflects the verified model limit or estimated device RAM headroom instead of exposing an obviously unsafe maximum.
- Change the context window or GPU layers and confirm the sheet shows the pending load-profile state plus `Save load profile` for an inactive model or `Apply & reload` for the active model.
- Load the model and confirm the app reports the engine as ready.
- With the model active, apply a changed load profile and confirm the model reloads successfully with the updated settings.
- Unload the model and confirm the UI returns to the unloaded state.

### Chat and history

- Open `Chat` and send a prompt with a loaded model.
- Confirm streaming, stop, and regenerate behavior.
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
- Open `Settings` and confirm the `Memory (RAM)` card refreshes while the screen stays open, the Android `App` memory value responds when loading or unloading a model, and the RAM plus storage cards do not repeat the same free or available value in multiple places.
- Open `Privacy & Disclosures` from `Settings` and confirm the content renders correctly.
- Open the Hugging Face token screen from `Settings`, verify save and clear both work, confirm the token field remains masked, and verify the education copy plus `Get token` external-link CTA.
- Open `Presets` and confirm preset creation, editing, activation, and deletion still work.

### Shared UI hardening follow-up

- Review `Home`, `Chat`, `Models`, and `Settings` with the shared tab chrome and confirm tab labels, icon contrast, and header rhythm remain consistent.
- Review `Conversations`, `Presets`, `Storage Manager`, `Privacy & Disclosures`, `Hugging Face Token`, `Model Details`, and the modal route and confirm routed back affordances stay in one visual zone.
- Recheck the shipped routes in both English and Russian at the defined dynamic-type checkpoints.
- Run one approved iOS smoke pass plus one weak-device or low-memory Android pass when shared motion or typography changes.

### Storage and cleanup

- Open `Storage Manager`.
- Remove a downloaded model with `Delete and keep settings` and confirm the file is removed while its saved per-model settings remain available after downloading the same model again.
- Remove a downloaded model with `Delete and reset settings` and confirm both the file and the saved per-model settings are cleared.
- Clear chat history and confirm saved threads are removed.
- Reset settings and confirm defaults are restored.

## Release-facing files to keep aligned

When release behavior or product messaging changes, check these files together:

- [`README.md`](../README.md)
- [`app.json`](../app.json)
- [`eas.json`](../eas.json)
- [`docs/privacy-disclosures.md`](./privacy-disclosures.md)

## Notes

- `Pocket AI` depends on native modules for local inference, so release validation should use native builds rather than Expo Go.
- Emulator smoke checks are useful, but they are not a substitute for testing at least one real device when changing model loading, storage, or long-running chat behavior.
