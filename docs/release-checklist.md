# Release Checklist

Last updated: 2026-03-28

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
- On first catalog open with no Hugging Face token configured, confirm guided discovery defaults to RAM-friendly public models and offers `Show full catalog`.
- Search for a public GGUF model whose list metadata does not expose a reliable size and confirm the card shows a resolved size or `Unknown`, never `0.00 GB`.
- Open `Filter` and `Sort` and confirm both panels stay collapsed by default, open independently, and do not permanently steal list height.
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
- Open the Hugging Face token screen from `Settings`, verify save and clear both work, confirm the token field remains masked, and verify the education copy plus `Get token` external-link CTA.
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
