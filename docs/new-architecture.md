# React Native New Architecture

Last updated: 2026-04-23

## Overview

Pocket AI targets React Native's New Architecture by default. The app depends on native modules that benefit from Fabric, TurboModules, JSI, and Hermes-backed execution.

In this repository, New Architecture is enabled explicitly in the committed Android native project:

- [`android/gradle.properties`](../android/gradle.properties) via `newArchEnabled=true`

The current [`app.json`](../app.json) does **not** set `expo.newArchEnabled` explicitly, so do not treat app config as the source of truth for this checkout.

## Why it matters here

Pocket AI is not just a UI shell. It relies on native integrations for local storage and on-device inference, so architecture mismatches tend to fail as runtime errors, missing modules, or unstable model-loading behavior rather than simple visual regressions.

The most sensitive areas are:

- local storage setup through MMKV
- JSI-heavy inference through `llama.rn`
- React Navigation and screen layout behavior under Fabric

## Current native-project layout

- The Android native project is committed in this repository.
- An `ios/` directory is not currently committed here.

If you generate or commit an iOS native project later, keep New Architecture enabled during Pod installation and verify that all native dependencies remain compatible.

## Android notes

The committed Android project already has New Architecture enabled.

To clean and rebuild Android locally:

```bash
cd android
./gradlew clean
cd ..
npm run android
```

If you are debugging stale native behavior after dependency changes, also consider reinstalling dependencies and rebuilding the app from scratch.

## iOS notes

This repository currently does not commit an `ios/` directory. If you need local iOS native sources, generate them through the Expo native workflow first, then ensure New Architecture stays enabled when installing Pods.

When debugging iOS-specific native issues after generating the project, verify:

- Pod installation was performed with New Architecture enabled
- native dependencies are compatible with the current React Native version
- any generated native state is not stale after dependency or config changes

## Module-specific notes

### `react-native-mmkv`

- Use the `createMMKV(...)` factory pattern rather than direct constructor-based setup.
- The current storage wrapper lives in [`src/services/storage.ts`](../src/services/storage.ts).
- This wrapper also includes a safe in-memory fallback for unsupported environments such as tests or web.

### `react-native-nitro-modules`

- Keep this dependency aligned with the React Native and MMKV versions used by the app.
- If MMKV or other Nitro-backed modules fail to initialize, treat version compatibility as a primary suspect.

### `llama.rn`

- This is the core local-inference integration.
- It relies heavily on native threads and JSI bindings.
- If model loading, context creation, or generation starts failing after a React Native upgrade, verify `llama.rn` compatibility before assuming the app logic is at fault.

### `react-native-reanimated` and `react-native-screens`

- These libraries are deeply involved in navigation and layout behavior under Fabric.
- Keep them aligned with the active React Native version.
- If you see navigation glitches, layout instability, or screen-mount issues after upgrades, check these libraries early.

## Common failure modes

- TurboModule not found at runtime
- JSI crashes during model load or generation
- Native module available in one build flavor but missing in another
- Behavior changes after dependency upgrades without a full native rebuild

## Practical troubleshooting

- Clean and rebuild native artifacts after major dependency changes.
- Verify New Architecture remains enabled in the generated native config; do not assume the current app config declares it explicitly.
- Confirm native dependencies are compatible with the current React Native version.
- Check whether the issue reproduces on a fresh install instead of only on a reused debug build.
