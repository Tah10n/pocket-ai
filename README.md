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
