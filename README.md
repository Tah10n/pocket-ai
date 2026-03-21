# Pocket AI App

Expo Router React Native app for an offline-first local AI assistant. The app focuses on GGUF model discovery, download, verification, local loading through `llama.rn`, and an on-device chat experience.

## Scripts

Install dependencies:

```bash
npm install
```

Start the Expo app:

```bash
npm start
```

Run an Android smoke check:

```bash
npm run android:smoke
```

Run the Android smoke check on an emulator and save a screenshot:

```bash
npm run android:emulator
```

Run the basic UI scenarios against the current Android target:

```bash
npm run android:scenarios
```

Run the same scenarios on an emulator:

```bash
npm run android:scenarios:emulator
```

Run tests, lint, and the Android smoke check together:

```bash
npm run check:android
```

Run tests, lint, and the emulator workflow together:

```bash
npm run check:android:emulator
```

Run tests, lint, and the emulator UI scenarios together:

```bash
npm run check:android:scenarios
```

Run lint:

```bash
npm run lint
```

Run tests:

```bash
npm test
```

## Current app structure

The codebase uses Expo Router for routes and keeps app logic under `src/`.

```text
app/
├── app/                 # Expo Router entrypoints and tab routes
├── src/
│   ├── components/      # Shared UI and feature-level reusable components
│   ├── hooks/           # UI hooks and screen-facing state helpers
│   ├── i18n/            # i18n bootstrap and translations
│   ├── lib/             # Small shared adapters, including MMKV wiring
│   ├── providers/       # React providers such as theming
│   ├── services/        # Persistence, model catalog, downloads, engine, bootstrap
│   ├── store/           # Zustand stores and persist adapters
│   ├── types/           # Shared TypeScript types
│   ├── ui/screens/      # Screen components rendered by Expo Router routes
│   └── utils/           # UI and domain utilities
├── __tests__/           # Jest tests
└── README.md
```

## Conventions

- Write repository documentation and code comments in English.
- Keep shared reusable building blocks in `src/components`.
- Keep route-facing screen components in `src/ui/screens`.
- Use `src/store` as the single home for Zustand store modules.
- Use `src/services` for app services and persistence helpers rather than putting that logic into components.

## Documentation

- [../IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md): delivery roadmap and current phase status.
- [UI Architecture & Components Guidelines](./docs/ui-architecture.md): guidance for creating and modifying UI components.
- [New Architecture Migration Guide](./docs/new-architecture.md): notes for React Native New Architecture and native-module-related setup.

## Android Smoke Automation

`npm run android:smoke` is a non-interactive Android launch path intended for local smoke checks and agent-driven verification.

It will:

- resolve `adb` and `emulator` from the Android SDK even when they are not on `PATH`
- reuse an existing Metro server or start one on a free port in the `8081-8090` range
- reuse a connected Android device or boot the first available AVD
- build and install the debug APK
- set up `adb reverse` and open the Expo development client against the selected Metro port

`npm run android:emulator` uses the same flow but prefers an AVD and writes a screenshot to `artifacts/android-emulator-smoke.png`, which is useful for visual smoke checks and scripted UI scenarios.

`npm run android:scenarios:emulator` builds on top of that launcher and executes a small set of baseline user flows using `adb` and Android UI hierarchy dumps. The current scenarios cover:

- Home screen smoke (`Pocket AI`, `New Chat`, `Quick Actions`, `Swap Model`)
- Bottom tab navigation (`Home`, `Chat`, `Models`, `Settings`)
- `New Chat` CTA navigation
- `Swap Model` CTA navigation

Each run writes screenshots and a JSON report under `artifacts/android-scenarios/`.

Optional environment variables:

- `ANDROID_SERIAL`: target a specific connected device
- `ANDROID_AVD`: force a specific emulator name when no device is connected
- `ANDROID_SKIP_BUILD=1`: skip Gradle assembly and reuse the existing debug APK
- `ANDROID_SMOKE_PORT=8081`: change the first port checked for Metro reuse/startup
- `ANDROID_SMOKE_SCREENSHOT=artifacts/android-smoke.png`: save a screenshot after launch

CLI flags are also supported:

- `--emulator`: force emulator usage
- `--avd <name>`: choose a specific AVD
- `--serial <serial>`: choose a specific connected device
- `--skip-build`: reuse the existing debug APK
- `--port <number>`: override the first Metro port to probe
- `--screenshot [path]`: save a screenshot after launch
