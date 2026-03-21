# UI Architecture & Component Guide

## Folder Structure

All UI components in this project are strictly centralized in one directory to prevent duplication, broken imports, and confusion.

**Directory:** `app/src/components/ui/`

This is the **only** directory where UI components should live. It contains both:
1. **Primitives**: Base wrapper elements for NativeWind/Gluestack styling (e.g., `box.tsx`, `text.tsx`, `pressable.tsx`, `input.tsx`).
2. **Custom Components**: Application-specific composite components (e.g., `ChatHeader.tsx`, `ActiveModelCard.tsx`, `ModelListItem.tsx`, `QuickActionsGrid.tsx`).

> **⚠️ Warning:** Do not create or use the legacy `app/components/` directory. It has been completely deprecated and removed to maintain a single source of truth in `src`.

## Imports & Aliases

To make imports clean and refactor-friendly regardless of file depth, the project uses TypeScript path aliases.

Whenever you need to import a UI component, **always** use the `@/components/ui/...` alias:

```tsx
// ✅ Correct (Absolute Alias)
import { Box } from '@/components/ui/box';
import { ActiveModelCard } from '@/components/ui/ActiveModelCard';
import { MaterialSymbols } from '@/components/ui/MaterialSymbols';

// ❌ Incorrect (Fragile Relative Paths)
import { Box } from '../../components/ui/box';
import { ActiveModelCard } from '../../../src/components/ui/ActiveModelCard';
import { MaterialSymbols } from '../../components/ui/MaterialSymbols';
```

### How it works
Behind the scenes in `app/tsconfig.json`, the `@/*` alias is cleanly mapped to `./src/*`:
```json
"paths": {
  "@/*": ["./src/*"]
}
```
This ensures that tools (TypeScript, ESLint, Metro bundler) automatically resolve `@/components/...` to `app/src/components/...`.

## Component Guidelines

* **Styling**: Prefer NativeWind (`className`) for styling. Use inline styles or `StyleSheet` when dealing with dynamic runtime calculations (like `safeAreaInsets`) or when a documented runtime-stability workaround requires plain React Native primitives.
* **Icons**: Use the centralized `MaterialSymbols` component (`@/components/ui/MaterialSymbols`) instead of importing directly from `@expo/vector-icons`.
* **CSS Interop**: All base primitive components must be wrapped in NativeWind's `cssInterop` object so they can seamlessly accept and process `className` props without throwing unhandled UI update crashes.
* **Interop Exceptions**: If a screen is a verified trigger for an upstream NativeWind / `react-native-css-interop` runtime issue, a screen-local fallback to React Native primitives is acceptable, but it must be documented in the file itself and in `app/README.md`. The current example is `src/ui/screens/SettingsScreen.tsx`, which intentionally avoids NativeWind wrappers to keep theme switching stable.
* **Localization**: New user-facing copy must not be hard-coded directly into production components. Add every new visible string to both `src/i18n/locales/en.json` and `src/i18n/locales/ru.json`, then render it through `useTranslation()` and `t(...)`.
* **What counts as user-facing copy**: Buttons, section titles, helper text, alert messages, empty states, tab labels, modal copy, filter chips, sort labels, and menu actions.
* **Allowed exceptions**: Developer-only console output, non-user-facing telemetry/debug text, and intentional test-only mock strings.

## Localization Checklist

Before considering a UI change complete:

1. Check whether the change introduces any new visible text.
2. If yes, add keys for that text in both locale files.
3. Use `t(...)` in the component instead of inline literals.
4. Verify that the screen does not become mixed-language when switching to either supported locale.
