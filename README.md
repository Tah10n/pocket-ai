# Pocket AI

Pocket AI is an offline-first mobile app for discovering, downloading, and chatting with local AI models directly on your device.

The project is built around a simple local-first flow:

1. Search GGUF models from Hugging Face.
2. Download and verify a model on the device.
3. Load it through `llama.rn`.
4. Chat locally without routing prompts through a hosted chat-completion API.

## Highlights

- On-device chat with local GGUF models
- Hugging Face model discovery with cursor-based catalog loading and local file management
- Guided catalog defaults that prioritize RAM-friendly, token-free models on first open
- Popularity-aware Hugging Face sorting with `Most downloaded` and `Most popular`
- Optional local Hugging Face access token support for gated or private model repositories
- Token education flow with a direct link to Hugging Face token settings
- Locked and access-denied states for gated Hugging Face models instead of generic download failures
- Routed model details flow with tags, popularity, access state, and Hugging Face deep links
- Explicit `Unknown` size handling when Hugging Face does not expose trustworthy GGUF metadata yet
- Confirmed warning path before downloading a model whose file size still cannot be verified
- Bounded on-device catalog cache for recent first-page results and recent model details, with online revalidation on reopen
- Persistent chat history stored on the device
- System prompt presets for different assistant behaviors
- Per-model generation controls such as temperature, top-p, top-k, min-p, repetition penalty, context window, and max tokens, plus saved load profiles for GPU layers
- Storage manager for unloading or offloading models, optionally keeping or resetting saved model settings, and clearing local data
- Conversation retention controls
- English and Russian localization

## Why Pocket AI

Pocket AI is designed around privacy, ownership, and a practical mobile workflow for local inference. Once a model is downloaded and loaded, inference stays on the device. The network is used for model discovery, metadata fetches, and downloads, but not for hosted chat completion in the current release flow.

## Tech stack

- Expo + React Native
- Expo Router
- TypeScript
- NativeWind
- Zustand
- MMKV
- `llama.rn` for on-device inference

## Getting started

### Prerequisites

- Node.js and npm
- Android Studio for Android builds
- Xcode for iOS builds
- A native development environment, because local inference depends on native modules

`Pocket AI` is not a pure Expo Go app. Features such as local model loading rely on native integrations, so use a native build workflow.

### Install dependencies

```bash
npm install
```

### Run the app

Start Metro:

```bash
npm start
```

Run on Android:

```bash
npm run android
```

Run on iOS:

```bash
npm run ios
```

### Build an Android release bundle locally

If the `android/` project is missing, generate it once first:

```bash
npx expo prebuild --platform android
```

If Gradle fails with "SDK location not found", make sure the Android SDK is installed and either:

- set `ANDROID_HOME` / `ANDROID_SDK_ROOT`, or
- create `android/local.properties` with `sdk.dir=...` (for example `sdk.dir=C:/Users/<you>/AppData/Local/Android/Sdk` on Windows)

Create a local upload-signing config for Google Play in `keystore.properties` at the app root, or provide the same values with environment variables:

```text
storeFile=keystores/pocket-ai-upload.jks
storePassword=your-store-password
keyAlias=pocketai
keyPassword=your-key-password
```

The `storeFile` path is resolved from the project root. For example, `keystores/pocket-ai-upload.jks` points to `./keystores/pocket-ai-upload.jks`.

Build the Play Store bundle:

```bash
npm run build:android:production
```

The build script uses:

- `expo.version` from `app.json` as the Android `versionName`
- `expo.android.versionCode` from `app.json` as the next Play upload code

After a successful production build, the script automatically reserves the next `expo.android.versionCode` in `app.json` so the following upload gets a fresh Play version code without EAS.

Override the values only if you need to recover from a failed or custom release flow:

```bash
npm run build:android:production -- --version-code 2 --version-name 1.0.1
```

The generated Android App Bundle is written to `android/app/build/outputs/bundle/release/app-release.aab`.

## Useful scripts

Run lint:

```bash
npm run lint
```

Run type checks:

```bash
npm run typecheck
```

Run tests:

```bash
npm test
```

Run the local release verification gate:

```bash
npm run verify:release
```

Build the local Android App Bundle for Google Play:

```bash
npm run build:android:production
```

Run the default change verification gate:

```bash
npm run verify:mobile-change
```

Run the Android-inclusive change verification gate:

```bash
npm run verify:mobile-change:android
```

Run the Android emulator smoke flow:

```bash
npm run android:emulator
```

Run the Android emulator UI scenarios:

```bash
npm run android:scenarios:emulator
```

## Product notes

- Inference is local after a model has been downloaded and loaded.
- Chat history, presets, settings, downloaded model references, and per-model generation or load profiles are persisted on-device and encrypted at rest.
- Network access is limited to model-management flows such as Hugging Face search, metadata fetches, and model downloads.
- Storage, memory, and model size labels use decimal units (1 GB = 1,000,000,000 bytes).
- If a Hugging Face access token is configured, it stays on-device and is attached to Hugging Face API requests as needed to surface gated or private repositories (including catalog browsing). Token-scoped catalog state is kept in memory and cleared when the token is updated or removed.
- The model catalog can start in a guided discovery mode that favors RAM-friendly public models, then switch back to the full Hugging Face catalog on demand.
- The model catalog can show public, locked, and access-denied Hugging Face repositories in the same search flow, with popularity sorting and routed model details.
- Recent first-page catalog results and recently opened public model details are cached locally so the catalog can reopen quickly and still refresh from Hugging Face when the network is available.
- If a model still has no trustworthy size, Pocket AI asks for explicit confirmation before starting a download with limited storage estimates and size verification.
- A downloaded model can be opened into a saved settings sheet where sampling changes apply immediately and load-profile changes are saved for the next load or an explicit reload.
- Context window controls are bounded by verified model metadata and estimated device RAM headroom before the model is loaded.
- If a model cannot fit into memory even after falling back to the safest load profile (or it only fits at the minimum context window of 512 tokens), Pocket AI marks it as `Won't fit RAM` and blocks the load instead of attempting an unsafe native initialization.
- When a downloaded model is removed, Pocket AI can keep its saved per-model settings for a future download or reset them at the same time.
- Large GGUF models may exceed the RAM or storage available on smaller devices.

## Repository layout

```text
app          Expo Router entrypoints and route definitions
src/         Application logic, components, screens, services, and stores
__tests__/   Jest test suite
docs/        Product and engineering notes
scripts/     Local automation and Android QA helpers
assets/      Icons, splash assets, and other static files
```

## Documentation

- [Privacy & Disclosures](./docs/privacy-disclosures.md)
- [Release Checklist](./docs/release-checklist.md)
- [New Architecture Notes](./docs/new-architecture.md)
- [UI Architecture Guidelines](./docs/ui-architecture.md)
- [Changelog](./CHANGELOG.md)
- [Contributing](./CONTRIBUTING.md)
- [Code of Conduct](./CODE_OF_CONDUCT.md)
- [License](./LICENSE)

## Current status

The app is in active development. The current focus is a stable local-model experience: better model management, predictable mobile UX, and release-ready privacy and storage controls.
