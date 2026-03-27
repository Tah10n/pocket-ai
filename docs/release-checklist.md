# Release Checklist

Last updated: 2026-03-27

## Purpose

Use this checklist before cutting a preview or production release. It is written for maintainers of this repository and focuses on the local-model workflow, mobile UX stability, and release-facing metadata.

## Build configuration

- App display name: `Pocket AI`
- Expo slug: `pocket-ai`
- Deep-link scheme: `pocketai`
- Android application ID: `com.antigravity.pocketai`
- iOS bundle identifier: `com.antigravity.pocketai`
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
- Open `Filter` and `Sort` and confirm both panels stay collapsed by default, open independently, and do not permanently steal list height.
- Apply at least one filter and one sort option and confirm the list updates immediately.
- Download a GGUF model and wait for verification to finish.
- Load the model and confirm the app reports the engine as ready.
- Unload the model and confirm the UI returns to the unloaded state.

### Chat and history

- Open `Chat` and send a prompt with a loaded model.
- Confirm streaming, stop, and regenerate behavior.
- While sending, confirm the header stays stable and the composer does not visibly jump on Android.
- On a device with a gesture area or home indicator, confirm the composer keeps safe bottom spacing and the send button never falls into the unsafe zone.
- If the active model exposes reasoning, expand `Thinking` or `Thought` and confirm the main reply remains outside the inner reasoning bubble.
- Copy an assistant reply and confirm the clipboard contains only the final assistant message, not the reasoning trace.
- Leave and reopen the app, then confirm the active thread restores correctly.
- Open `All Conversations`, then search, rename, and delete a thread.
- Expand `Chat Retention`, change the retention window, and confirm the control starts collapsed again after applying.

### Settings and disclosures

- Switch theme between `light`, `system`, and `dark`.
- Switch language between English and Russian.
- Open `Privacy & Disclosures` from `Settings` and confirm the content renders correctly.
- Open `Presets` and confirm preset creation, editing, activation, and deletion still work.

### Storage and cleanup

- Open `Storage Manager`.
- Offload a downloaded model and confirm active-model state stays consistent.
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
