# Release Checklist

Last updated: 2026-03-26

## Build configuration

- App display name: `Pocket AI`
- Expo slug: `pocket-ai`
- Deep-link scheme: `pocketai`
- Android application ID: `com.antigravity.pocketai`
- iOS bundle identifier: `com.antigravity.pocketai`
- EAS profiles committed in [`eas.json`](../eas.json): `development`, `preview`, `production`

## Pre-flight

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

## Build commands

Use the committed EAS profiles:

```bash
npm run build:android:preview
npm run build:android:production
npm run build:all:production
```

## Manual QA checklist

### Clean start

- Install a fresh build on a clean device/emulator.
- Confirm the splash screen, app icon, name, and package metadata match `Pocket AI`.
- Confirm first launch reaches the tab shell without bootstrap crashes.

### Model flow

- Open `Models`.
- Search the Hugging Face catalog while online.
- Download a GGUF model and wait for verification to finish.
- Load the model and confirm the app reports the engine as ready.
- Unload the model and confirm the UI returns to the unloaded state.

### Chat and history

- Open `Chat` and send a prompt with a loaded model.
- Confirm streaming, stop, and regenerate behavior.
- Leave and reopen the app, then confirm the active thread restores correctly.
- Open `All Conversations`, search, rename, and delete a thread.

### Settings and disclosures

- Switch theme between `light`, `system`, and `dark`.
- Switch language between English and Russian.
- Open `Privacy & Disclosures` from `Settings` and confirm the content renders.
- Open `Presets` and confirm preset editing still works.

### Storage and cleanup

- Open `Storage Manager`.
- Offload a downloaded model and confirm active-model state stays consistent.
- Clear chat history and confirm saved threads are removed.
- Reset settings and confirm defaults are restored.

## Release docs to keep aligned

- [`README.md`](../README.md)
- [`docs/privacy-disclosures.md`](./privacy-disclosures.md)
- [`../IMPLEMENTATION_PLAN.md`](../../IMPLEMENTATION_PLAN.md)
