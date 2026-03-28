# Pocket AI

Pocket AI is an offline-first mobile app for discovering, downloading, and chatting with local AI models directly on your device.

The project is built around a simple local-first flow:

1. Search GGUF models from Hugging Face.
2. Download and verify a model on the device.
3. Load it through `llama.rn`.
4. Chat locally without routing prompts through a hosted chat-completion API.

## Highlights

- On-device chat with local GGUF models
- Hugging Face model discovery, download, and local file management
- Optional local Hugging Face access token support for gated or private model repositories
- Persistent chat history stored on the device
- System prompt presets for different assistant behaviors
- Runtime generation controls such as temperature, top-p, top-k, min-p, repetition penalty, context window, and max tokens
- Storage manager for unloading or offloading models and clearing local data
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
- Chat history, presets, settings, and downloaded model references are persisted on-device.
- Network access is limited to model-management flows such as Hugging Face search, metadata fetches, and model downloads.
- If a Hugging Face access token is configured, it stays on-device and is attached only to gated or private Hugging Face requests that require it.
- Large GGUF models may exceed the RAM or storage available on smaller devices.

## Repository layout

```text
app/         Expo Router entrypoints and route definitions
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

## Current status

The app is in active development. The current focus is a stable local-model experience: better model management, predictable mobile UX, and release-ready privacy and storage controls.
