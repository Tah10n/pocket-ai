# UI Architecture & Component Guide

Last updated: 2026-04-29

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
- `routes/components/`
- duplicated UI primitives inside feature folders

The goal is one clear source of truth for reusable UI.

## Imports and aliases

Prefer the `@/...` alias for imports that target code under `src/`, especially in new files and larger refactors:

```tsx
import { Box } from '@/components/ui/box';
import { ActiveModelCard } from '@/components/ui/ActiveModelCard';
import { MaterialSymbols } from '@/components/ui/MaterialSymbols';
```

The current codebase still contains a mix of alias and relative imports. Do not churn otherwise-stable files just to rewrite imports, but avoid introducing new deep relative chains when an alias import would be clearer.

Relative imports are still acceptable for:

- local siblings in the same folder
- route-local files under `app/`
- lightly touched files that already follow one style consistently

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
- When adding model controls or load-profile settings, keep parameter sanitization in `src/services/SettingsStore.ts`, and keep any shared heuristics in a utility module so UI estimates and runtime behavior stay aligned (for example `src/utils/kvCache.ts`).

## Units and byte formatting

Pocket AI displays storage, memory, and model sizes using decimal units (base-10):

- 1 KB = 1,000 bytes
- 1 MB = 1,000,000 bytes
- 1 GB = 1,000,000,000 bytes

Use `DECIMAL_GIGABYTE` from [`src/utils/modelSize.ts`](../src/utils/modelSize.ts) for UI-facing conversions, and keep labels consistent (`GB`, not `GiB`).

## NativeWind and interop notes

- Shared primitives should support the project's NativeWind interop expectations.
- If a verified upstream issue makes NativeWind wrappers unstable for a specific screen, a screen-local fallback to plain React Native primitives is acceptable.
- When such an exception exists, document it in the affected file and keep the repository documentation aligned.
- There is no standing route-level `StyleSheet` exception in the current app shell. If a future screen needs one, treat it as temporary and record the reason here.

## Screen layout conventions

Screen-level chrome should be standardized rather than rebuilt from scratch per route.

Use [`@/components/ui/ScreenShell`](../src/components/ui/ScreenShell.tsx) for internal routed screens:

- `ScreenHeaderShell` handles top safe-area spacing, header chrome, border treatment, and width alignment.
- `ScreenContent` keeps the content column aligned with the same width contract as the header.
- `ScreenStack`, `ScreenCard`, and `ScreenPressableCard` provide the default vertical rhythm and card treatment for routed screens.
- `ScreenSectionLabel` should be the default section-eyebrow treatment instead of route-local uppercase text styles.

This should be the default for screens such as conversations, presets, legal, storage, and model-management flows.

Shared spacing, corner radius, header action sizing, and routed-screen keyboard gaps belong in [`src/utils/themeTokens.ts`](../src/utils/themeTokens.ts), not in route-local constants. When a visual adjustment should stay consistent across screens, update the shared tokens first and let the screen primitives consume them.

## Shared input and badge primitives

Use the screen-level primitives from [`src/components/ui/ScreenShell.tsx`](../src/components/ui/ScreenShell.tsx) instead of rebuilding pills and input rows in route files:

- `ScreenBadge` is the default for active-state pills, counters, warning tags, and compact metadata badges.
- `ScreenChip` is the default for compact labeled chips, especially when the chip can be pressed or needs leading or trailing icons.
- `ScreenTextField` is the default for labeled form fields and multiline editors.
- `ScreenInlineInput` is the default for compact search rows and chat-style inline inputs such as the composer.

Do not hand-roll route-local `rounded-full` badges or search rows unless the shared primitive is missing a capability that should be added centrally.

## Header patterns

- Reuse existing header components such as `HeaderBar`, `ChatHeader`, and `SearchHeader` when the pattern already fits.
- If a screen needs a custom header, build it inside `ScreenHeaderShell` instead of hand-rolling a separate safe-area and border container.
- Keep touch targets, horizontal padding, and border treatment visually consistent across internal screens.
- Chat-style headers should keep the title and action buttons on the first row, then place preset or model chips on their own content-aligned row instead of offsetting them for a back-button placeholder.
- Avoid redundant transient header status copy when the screen already exposes a stronger live affordance. In chat, active streaming is represented by the transcript and stop control rather than a separate `Generating` label in the header.
- For page-local tabs such as the `Models` screen, use the shared `ScreenSegmentedControl` pattern instead of rendering the sections as separate standalone buttons. Keep the tab ids in a shared module and localize only the visible labels.
- `Models` should keep its `SearchHeader` compact: one title row, one shared inline-search row, then one segmented-tab row. Filter and sort triggers should read as compact controls inside the page, not as large standalone cards.

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

## Visual System Contract

The shared visual system resolves from one semantic source of truth:

- `src/utils/theme-contract.json` defines the semantic palette and motion bands.
- `src/utils/themeTokens.ts` maps that contract into runtime theme colors, visual-theme appearance tokens, and React Navigation colors.
- `src/providers/ThemeProvider.tsx`, `app/_layout.tsx`, and `app/(tabs)/_layout.tsx` consume the same palette and `themeId` decisions so tab chrome, status bars, and NativeWind surfaces stay aligned.

When you need a tinted surface or accent treatment, prefer semantic theme colors plus `withAlpha(...)` instead of introducing a new raw hex or `rgba(...)` value.

### Theme ID Architecture

Color mode and visual style are intentionally separate:

- `theme` remains the persisted light/dark/system mode and is the only value passed to NativeWind color-scheme resolution.
- `themeId` is the persisted visual-theme identity. It selects the app-level appearance family, currently `default` or `glass`.
- `ThemeProvider` resolves `{ theme, themeId, resolvedMode }` into `colors`, `appearance`, and `navigationTheme`.
- `appearance` owns non-palette visual decisions such as shared surface classes, tone-aware icon tiles/badges/banners/progress, dividers, header/surface blur intensity, sheet/card/input translucency, segmented controls, message bubbles, glass highlight chrome, and tab-bar shadow/elevation.
- Routed screens should start from `ScreenRoot` so the resolved runtime palette owns the page background instead of duplicating route-local `bg-background-*` classes.
- Reusable tinted UI should use `ScreenCard`, `ScreenPressableCard`, `ScreenIconTile`, `ScreenBanner`, `ScreenBadge`, `ScreenActionPill`, `ProgressBar`, and `ValueSelectorRow` before adding route-local surface classes.

Migration plan for new visual themes:

1. Add the theme id to `themeIds` and define its color overrides and `ThemeAppearance` branch in `src/utils/themeTokens.ts`.
2. Persist and sanitize the id through `src/services/SettingsStore.ts` before exposing it in Settings.
3. Route new shared chrome through `appearance.classNames` or `appearance.effects` instead of hard-coded `bg-background-*`, translucent accent surfaces, opacity, blur, shadow, or elevation values.
4. Keep visual themes layout-compatible with `default`: do not change shared spacing, size, or radius tokens unless the feature explicitly calls for a layout variant.
5. For glass-like themes, combine translucency with real `BlurView` backdrops, the shared `ScreenRoot` `BlurTargetView`, subtle borders, shadows, non-interactive background accents, and specular highlight chrome instead of only lowering surface opacity.
6. Keep one-off route styles as documented exceptions only when a primitive cannot express the layout safely; status dots and solid active fills may stay route-local when they are not surfaces.
7. Add tests for settings migration, provider resolution, layout-token parity, and any newly themed primitive before expanding the theme to more surfaces.

### Glass Surface Architecture

Glass themes distinguish chrome from inline content:

- Chrome surfaces that float over other content may use `BlurView`: `ScreenHeaderShell`, `ScreenSheet`, floating `ScreenBanner`, `ScreenChromeBar`/chat composer, bottom tab chrome, and header/icon actions.
- Large inline surfaces such as `ScreenCard` and `ScreenPressableCard` use the shared frosted backdrop plus a light tint and rim border. Smaller inline controls such as `ScreenIconTile`, badges, chips, text fields, segmented controls, and chat bubbles keep denser tinted fills to avoid excessive nested blur in dense lists.
- Dark glass surfaces should read as liquid glass, not opaque slate: use clean `background-0` translucency, color-safe cyan/blue specular and refraction layers, and a dark contrast film; avoid white feathered stripes or hard dark fills for shared chrome.
- The native implementation approximates CSS/SVG liquid-glass distortion with layered `BlurView`, translucent tint/contrast films, directional specular gradients, refraction bands, and a real inner rim; Expo/React Native does not provide CSS `backdrop-filter` or SVG `feDisplacementMap` for native views.
- In `ScreenRoot`, decorative glass accents render as smooth gradient layers behind the scene. Android uses two `BlurTargetView`s: a background-only target for in-screen glass surfaces, and a scene target wrapping the real screen content for external chrome such as the floating tab-bar island. This lets the tab bar sample the screen behind it without making card-level blurs target an ancestor that contains themselves.
- Android currently renders dense translucent fallback panels for shared glass surfaces; keep `ScreenRoot` blur-target wrappers isolated from inline surfaces unless native blur is explicitly re-enabled.
- The bottom tab bar renders through `tabBarBackground`. On Android SDK 31+, the floating tab-bar island samples the active screen scene target with `BlurView`, so light and dark glass tab chrome blur the content behind them. While the target is pending or unavailable, it falls back to the dense matte island.

## Screen Chrome Contract

Use the shared header families instead of route-local chrome:

- Root tabs: `HomeScreen` uses `HeaderBar`, `ChatScreen` uses `ChatHeader`, `ModelsCatalogScreen` uses `SearchHeader`, and `SettingsScreen` uses `HeaderBar`.
- Internal routed screens and the modal route should use `HeaderBar` plus `ScreenContent`, then build cards, badges, chips, and inline inputs from the shared screen primitives unless a documented exception is required.
- Back affordances belong only on genuinely navigable routed screens; root-tab chrome should not invent a fallback back behavior.
- Header actions and icon-only controls should keep the shared minimum touch-target contract from `theme-contract.json`.
- `Models` cards should stay visually dense: keep essential chips such as access, RAM warning, and size, but do not add a redundant `Status` chip when the lifecycle is already communicated by actions, progress, or the active badge.
- RAM-fit chips and warnings should use short user-facing language such as `Fits in RAM`, `Near RAM limit`, or `Won't fit RAM`; do not surface internal estimator jargon like `OOM` or confidence-level badges in the shipped UI.
- `Models` filtering should stay focused on user-useful criteria. The compact filter UI should expose RAM, token, and size filters; lifecycle categories such as `Available`, `Downloading`, and `Downloaded` should not appear as separate filter rows.

## QA Handoff

If you change shared theme, header, localization, motion, or routed-screen chrome, rerun this handoff set on a connected Android phone before closing the work:

```bash
npm run verify:mobile-change
npm run android:scenarios -- --skip-build --pack dependency-ui
node .\scripts\android-scenarios.js --skip-build --scenario hf-catalog-hardening
node .\scripts\android-screen-capture.js --skip-build --screen home,models,settings,conversations,huggingface-token,model-details --output-dir artifacts/android-scenarios/manual-sample
```

`npm run android:scenarios` defaults to a small core smoke pack. Use `--pack dependency-ui` for UI architecture changes, `--pack runtime` for localization or persisted-state changes, `--pack native` for Expo or native-module changes, and `--pack extended` when you need the previous broader stable pass. Keep catalog/perf scenarios as targeted checks.

Manual follow-up is still required for:

- iOS route-by-route smoke
- screen-reader semantics
- dynamic-type checkpoints
- weak-device motion and responsiveness
- modal route review
