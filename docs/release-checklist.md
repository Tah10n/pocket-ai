# Release Checklist

Last updated: 2026-03-27

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
- Open `Filter` and `Sort` and confirm both panels stay collapsed by default, open independently, and do not permanently steal list height.
- Apply at least one filter and one sort option from the dropdown panels, then confirm the list updates immediately and the active choices remain reflected in the controls.
- Download a GGUF model and wait for verification to finish.
- Load the model and confirm the app reports the engine as ready.
- Unload the model and confirm the UI returns to the unloaded state.

### Chat and history

- Open `Chat` and send a prompt with a loaded model.
- Confirm streaming, stop, and regenerate behavior.
- While sending, confirm the chat surface does not visibly jump: the header should stay stable and the composer should not resize twice on Android.
- On a device with a bottom gesture area or home indicator, confirm the composer keeps its full bottom safe-area padding and the send button never drops into the unsafe zone.
- If the active model exposes reasoning, expand `Thinking` / `Thought` and confirm the main reply stays outside the inner thought bubble.
- Copy an assistant reply and confirm the clipboard contains only the final message, not the reasoning trace.
- In a development build, confirm `t/s` appears in the same compact metadata row as the message action icons and remains visible after generation completes.
- Leave and reopen the app, then confirm the active thread restores correctly.
- Open `All Conversations`, search, rename, and delete a thread.
- Expand `Chat Retention`, change the retention window, and confirm the control starts collapsed again after applying.

### Settings and disclosures

- Switch theme between `light`, `system`, and `dark`.
- Switch language between English and Russian.
- After switching to Russian, run `npm run android:screens:emulator` and confirm the capture flow still succeeds because the runner restores an English UI baseline before writing artifacts.
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
