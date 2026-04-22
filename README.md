<p align="center">
  <img src="assets/images/icon.png" width="120" alt="Pocket AI icon" />
</p>

<h1 align="center">Pocket AI</h1>

<p align="center">
  <strong>Offline-first local AI assistant &mdash; discover, download, and chat with GGUF models directly on your device.</strong>
</p>

<p align="center">
  <a href="https://github.com/Tah10n/pocket-ai/blob/main/LICENSE">
    <img src="https://img.shields.io/github/license/Tah10n/pocket-ai?style=flat-square" alt="License" />
  </a>
  <a href="https://github.com/Tah10n/pocket-ai/actions/workflows/ci.yml">
    <img src="https://img.shields.io/github/actions/workflow/status/Tah10n/pocket-ai/ci.yml?style=flat-square&label=CI" alt="CI" />
  </a>
  <img src="https://img.shields.io/badge/platform-Android%20%7C%20iOS-blue?style=flat-square" alt="Platform" />
  <img src="https://img.shields.io/badge/Expo-SDK%2055-000020?style=flat-square&logo=expo" alt="Expo SDK 55" />
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/inference-llama.rn-orange?style=flat-square" alt="llama.rn" />
</p>

<p align="center">
  <img src="docs/screenshots/feature-graphic.png" width="700" alt="Pocket AI — offline-first local AI assistant" />
</p>

<table align="center">
  <tr>
    <td align="center"><strong>Home</strong></td>
    <td align="center"><strong>Model Catalog</strong></td>
    <td align="center"><strong>Settings</strong></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/01-home.png" width="180" alt="Home screen" /></td>
    <td><img src="docs/screenshots/02-model-catalog.png" width="180" alt="Model catalog" /></td>
    <td><img src="docs/screenshots/03-settings.png" width="180" alt="Settings" /></td>
  </tr>
</table>

## How it works

1. **Search** — browse GGUF models from Hugging Face right on your phone.
2. **Download** — pick a model and download it to local storage.
3. **Load** — the model runs through [`llama.rn`](https://github.com/mybigday/llama.rn) entirely on-device.
4. **Chat** — have private conversations with zero network dependency, including switching models inside an existing conversation.

## Features

### Model Discovery

- Browse and search Hugging Face GGUF models with popularity sorting
- Guided discovery mode that surfaces RAM-friendly, token-free models first
- Model details with tags, popularity, access state, and Hugging Face deep links
- Optional Hugging Face access token for gated or private repositories
- Locked and access-denied states shown for gated models instead of generic errors

### On-Device Inference

- Fully local chat after download — no network needed for conversations
- Background generation support with system notifications (Android foreground service, iOS time-limited)
- Per-model generation controls: temperature, top-p/k, min-p, repetition penalty, seed
- Load profiles for GPU layers, context window, and KV cache precision
- Hardware acceleration when available (Android OpenCL GPU, Android Hexagon/HTP NPU (experimental) via [`llama.rn`](https://github.com/mybigday/llama.rn)). Pocket AI uses backend discovery to decide what is safe to attempt; if discovery is unavailable, it forces CPU for stability.
- RAM-aware safety checks that block loading models that won't fit
- Context window bounded by model metadata and estimated device RAM headroom

### Chat & History

- Persistent on-device chat history, encrypted at rest
- In-chat model switching keeps one conversation thread while recording when the active model changes
- Per-message model metadata keeps edits, regeneration, and history restoration aligned with the model that produced each turn
- System prompt presets for different assistant behaviors
- Conversation search, rename, retention controls, and bulk cleanup

### Storage & Data

- Storage manager for unloading, offloading, and clearing model data
- Per-model settings survive model removal for easy re-download
- Bounded local cache for catalog results with online revalidation
- Background model downloads with a persistent progress notification on Android
- Explicit confirmation before downloading models with unverified file sizes
- Storage, memory, and model size labels use decimal units (1 GB = 1,000,000,000 bytes)

### Localization & Theming

- English and Russian localization
- Light, dark, and system theme modes

## Tech stack

| Layer | Technology |
|-------|-----------|
| Framework | [Expo](https://expo.dev) + [React Native](https://reactnative.dev) |
| Navigation | [Expo Router](https://docs.expo.dev/router/introduction/) |
| Language | [TypeScript](https://www.typescriptlang.org/) |
| Styling | [NativeWind](https://www.nativewind.dev/) (Tailwind CSS for React Native) |
| State | [Zustand](https://zustand.docs.pmnd.rs/) |
| Storage | [MMKV](https://github.com/mrousavy/react-native-mmkv) |
| Inference | [llama.rn](https://github.com/mybigday/llama.rn) |

## Getting started

> **Note:** Pocket AI requires a native build environment. It is not compatible with Expo Go because local inference depends on native modules.

### Prerequisites

- Node.js 20+ and npm
- Android Studio (Android) or Xcode (iOS)

### Quick start

```bash
npm install
npm start          # Start Metro
npm run android    # Run on Android
npm run ios        # Run on iOS
```

For release builds and signing setup, see the [Android Build Guide](docs/android-build.md) and [iOS Build Guide](docs/ios-build.md).

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines and the [Code of Conduct](CODE_OF_CONDUCT.md).

This project uses Conventional Commit-style **PR titles** to drive automated versioning and changelog updates.

## Documentation

| Document | Description |
|----------|-------------|
| [Changelog](CHANGELOG.md) | Release history |
| [Privacy & Disclosures](docs/privacy-disclosures.md) | Data handling and privacy policies |
| [Model Parameters](docs/model-parameters.md) | Generation settings, load profiles, and chat snapshot behavior |
| [Android Build Guide](docs/android-build.md) | Android release signing and bundling |
| [iOS Build Guide](docs/ios-build.md) | iOS archive, distribution, and signing |
| [UI Architecture](docs/ui-architecture.md) | Component and layout guidelines |
| [New Architecture](docs/new-architecture.md) | React Native new architecture notes |
| [Release Checklist](docs/release-checklist.md) | Pre-release verification steps |

## Roadmap

Auto-generated from open GitHub issues labeled `roadmap:*`.

<!-- ROADMAP:START -->
### Now

- [\[Feature\]: Allow multiple models per conversation + add “model switched” line](https://github.com/Tah10n/pocket-ai/issues/25) (#25)

### Next

- [\[Feature\]: Show capability icons on model cards (text / vision / reasoning)](https://github.com/Tah10n/pocket-ai/issues/28) (#28)
- [\[Feature\]: Model card “Size” should open quantization/file picker (GGUF variants)](https://github.com/Tah10n/pocket-ai/issues/27) (#27)

### Later

- [\[Feature\]: Chat UI — document attachments (picker, preview, remove)](https://github.com/Tah10n/pocket-ai/issues/43) (#43)
- [\[Feature\]: Multimodal (vision) models — attach images in chat](https://github.com/Tah10n/pocket-ai/issues/29) (#29)
<!-- ROADMAP:END -->

## Project structure

```text
app/         Expo Router route definitions
src/         Components, screens, services, stores, and hooks
__tests__/   Jest test suite
docs/        Product, engineering, and privacy documentation
scripts/     Build automation and Android QA helpers
assets/      App icons, splash assets, and static images
```

## License

MIT — see [LICENSE](LICENSE) for details.
