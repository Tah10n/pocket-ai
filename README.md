# Pocket AI App

Expo Router React Native app for an offline-first local AI assistant. The app focuses on GGUF model discovery, download, verification, local loading through `llama.rn`, and an on-device chat experience.

Home shows a short recent-conversations slice, a simplified active-model card without decorative artwork, and a context-aware model CTA that can send users straight to downloaded models when no model is currently loaded.
Settings now include theme/language controls, generation parameters, and a routed preset manager where seeded and user-created presets can all be added, edited, activated, or deleted.
Theme switching is currently stabilized with a hybrid approach: the app theme source of truth still lives in `ThemeProvider`, but `SettingsScreen` intentionally uses plain React Native `StyleSheet` styling as a safety workaround for a NativeWind / `react-native-css-interop` dev-time crash that was reproducible during theme changes.

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
- Prefer NativeWind primitives and `className` for shared UI, but document and preserve targeted React Native `StyleSheet` fallbacks when they are used to avoid verified runtime stability issues.
- Treat localization as part of the definition of done for user-facing UI.
- Any new user-visible button label, title, description, tab label, alert copy, empty state, filter label, or menu item must be added to both `src/i18n/locales/en.json` and `src/i18n/locales/ru.json`, then consumed via `t(...)` instead of hard-coded inline strings.
- The only normal exceptions are developer-only logs, temporary test doubles/mocks, and other text that never ships to end users.

## Localization Workflow

When adding or changing user-facing copy:

1. Add the new translation key to `src/i18n/locales/en.json`.
2. Add the matching key to `src/i18n/locales/ru.json`.
3. Use the key from the component or screen with `useTranslation()` and `t(...)`.
4. Avoid shipping mixed-language UI by not leaving new English-only fallback strings in production components.

Example:

```tsx
const { t } = useTranslation();

<Text>{t('home.newChat')}</Text>
```

## Documentation

- [../IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md): delivery roadmap and current phase status.
- [UI Architecture & Components Guidelines](./docs/ui-architecture.md): guidance for creating and modifying UI components.
- [New Architecture Migration Guide](./docs/new-architecture.md): notes for React Native New Architecture and native-module-related setup.

## Model Controls

- The chat model-controls sheet exposes the runtime generation controls used by local inference: `temperature`, `topP`, `topK`, `minP`, `repetition penalty`, `context window`, and `max tokens`.
- Generation settings are saved in `SettingsStore`, snapshotted into each chat thread, and forwarded into `llama.rn` through the chat session pipeline so active chats stay reproducible.
- `Reset all` and per-field reset actions restore the app defaults for both load-time and sampling-related controls.

## Hugging Face Metadata

- The model catalog now reads optional Hugging Face `config` metadata when it is available for a GGUF entry.
- The app currently derives capability hints such as `maxContextTokens`, `modelType`, and `architectures` from fields like `max_position_embeddings`, `n_positions`, `max_sequence_length`, `seq_length`, and `sliding_window`.
- When a model exposes a known context-size limit, the chat parameter UI uses that value to clamp `Context window` and `Max tokens` so the controls stay within the model's advertised range.
- Additional Hugging Face metadata is treated as advisory unless the local runtime explicitly supports it; unsupported config fields are not surfaced as editable controls yet.

## Theme Notes

- Theme persistence and the app-wide resolved mode live in `src/providers/ThemeProvider.tsx`.
- `app/(tabs)/_layout.tsx` reads the resolved theme from that provider so tabs stay in sync with the rest of the app.
- `app/_layout.tsx` contains a dev-only guard for the `react-native-css-interop` upgrade-warning crash that can occur when React Navigation proxy props are stringified during theme-related rerenders.
- `src/ui/screens/SettingsScreen.tsx` is intentionally implemented with React Native primitives and `StyleSheet` right now; do not convert it back to NativeWind wrappers without re-verifying theme switching on device.

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

- Home screen smoke (`Pocket AI`, `New Chat`, `Quick Actions`, active model CTA)
- Bottom tab navigation (`Home`, `Chat`, `Models`, `Settings`)
- `New Chat` CTA navigation
- Active model CTA navigation, including the downloaded-models path when no model is loaded
- `See All` conversation-management navigation

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
