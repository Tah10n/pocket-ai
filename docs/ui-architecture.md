# UI Architecture & Component Guide

Last updated: 2026-03-27

## Purpose

This guide documents the conventions used for UI structure, imports, styling, layout, and localization in Pocket AI. It is intended for contributors who are adding or modifying screens and reusable components.

## Folder ownership

Reusable UI components live under:

`src/components/ui/`

This directory contains both:

1. Base primitives used by the design system and NativeWind interop
2. App-specific composite components such as `ChatHeader`, `ScreenShell`, and model-related cards

Do not create parallel component trees such as:

- `components/`
- `app/components/`
- duplicated UI primitives inside feature folders

The goal is one clear source of truth for reusable UI.

## Imports and aliases

Use the `@/...` alias for application imports whenever possible:

```tsx
import { Box } from '@/components/ui/box';
import { ActiveModelCard } from '@/components/ui/ActiveModelCard';
import { MaterialSymbols } from '@/components/ui/MaterialSymbols';
```

Avoid fragile deep relative imports such as:

```tsx
import { Box } from '../../components/ui/box';
import { ActiveModelCard } from '../../../src/components/ui/ActiveModelCard';
```

The alias is defined in [`tsconfig.json`](../tsconfig.json):

```json
"paths": {
  "@/*": ["./src/*"]
}
```

## Component rules

- Prefer NativeWind `className` styling for reusable UI.
- Use inline styles or `StyleSheet` when values are driven by runtime layout, safe-area math, or a documented framework workaround.
- Use the shared `MaterialSymbols` wrapper instead of importing icon implementations ad hoc across screens.
- Keep application logic in hooks, services, or stores rather than burying it inside presentational components.

## NativeWind and interop notes

- Shared primitives should support the project's NativeWind interop expectations.
- If a verified upstream issue makes NativeWind wrappers unstable for a specific screen, a screen-local fallback to plain React Native primitives is acceptable.
- When such an exception exists, document it in the affected file and keep the repository documentation aligned.

The current notable exception is [`src/ui/screens/SettingsScreen.tsx`](../src/ui/screens/SettingsScreen.tsx), which intentionally uses a safer React Native `StyleSheet` approach to avoid a verified theme-switching crash.

## Screen layout conventions

Screen-level chrome should be standardized rather than rebuilt from scratch per route.

Use [`@/components/ui/ScreenShell`](../src/components/ui/ScreenShell.tsx) for internal routed screens:

- `ScreenHeaderShell` handles top safe-area spacing, header chrome, border treatment, and width alignment.
- `ScreenContent` keeps the content column aligned with the same width contract as the header.

This should be the default for screens such as conversations, presets, legal, storage, and model-management flows.

## Header patterns

- Reuse existing header components such as `HeaderBar`, `ChatHeader`, and `SearchHeader` when the pattern already fits.
- If a screen needs a custom header, build it inside `ScreenHeaderShell` instead of hand-rolling a separate safe-area and border container.
- Keep touch targets, horizontal padding, and border treatment visually consistent across internal screens.

## Content width and bottom spacing

- Keep routed screen content aligned to the same max-width contract as the header.
- Scrollable tab screens should pad bottom content against the active tab bar height rather than hard-coded values.
- Non-tab routed screens should still include bottom safe-area spacing so the last card or action does not sit flush with the device edge.

## Localization checklist

Before considering a UI change complete:

1. Check whether the change introduces any visible text.
2. Add translation keys to both [`src/i18n/locales/en.json`](../src/i18n/locales/en.json) and [`src/i18n/locales/ru.json`](../src/i18n/locales/ru.json).
3. Render the copy through `useTranslation()` and `t(...)` rather than inline literals.
4. Verify the screen does not become mixed-language in either supported locale.

User-facing copy includes:

- buttons
- section titles
- helper text
- alerts
- empty states
- filter and sort labels
- tab labels
- menu actions

Normal exceptions are developer-only logs, diagnostics, and intentional test-only strings.
