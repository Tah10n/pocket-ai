# UI Architecture & Component Guide

Last updated: 2026-08-16

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
- `Models` should keep `ScreenHeaderShell` limited to the title and header action. Its composer-shaped search field, compact segmented tabs, and filter/sort triggers form transparent floating chrome above the virtualized catalog. Reserve their initial space with the list content inset so cards can scroll beneath the effect surfaces and provide real backdrop content for blur; do not add an opaque tray behind the controls.

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
- `src/design-system/themes/*.theme.ts` defines theme metadata, preview tokens, light/dark colors, semantic material recipes, and narrow layout presentation choices.
- `src/design-system/themes/registry.ts` is the ordered source of theme ids and metadata; `ThemeId` is derived from the registered definitions.
- `src/design-system/themes/resolver.ts` resolves one deeply immutable object containing colors, materials, component presentation, and React Navigation colors.
- `src/providers/ThemeProvider.tsx`, `app/_layout.tsx`, and `app/(tabs)/_layout.tsx` consume the same resolved theme.
- `src/utils/themeTokens.ts` remains a compatibility facade for stable foundation and layout tokens; it is not a visual-theme registry or appearance API.

Shared UI must request semantic roles instead of identifying a theme. Use `Surface` for dense content and controls, `EffectSurface` only for eligible chrome or overlays, and semantic foreground roles on `Text` and `MaterialSymbols`. Raw theme ids, palette literals, blur values, and renderer selection do not belong in generic components.

### Theme ID Architecture

Color mode and visual style are intentionally separate:

- `theme` is the persisted light/dark/system mode and the only value passed to NativeWind color-scheme resolution.
- `themeId` is the persisted visual-theme identity.
- `ThemeProvider` resolves `{ theme, themeId, resolvedMode }` into one `resolvedTheme`; compatibility fields such as `colors` and `navigationTheme` reference that same result.
- A theme definition owns semantic recipes and narrow component presentation such as attached versus floating tab chrome, attached versus overlay headers, inline versus capsule composers, and plain versus aurora background decoration.
- Generic UI must not branch on `themeId` or a global solid/glass discriminator. A future registry theme must flow through text, buttons, cards, tabs, and chat without component edits.
- Routed screens should start from `ScreenRoot`, which owns the resolved canvas, optional background decoration, floating-header inset, and Android sample-target boundary.

Migration plan for a new visual theme:

1. Add a typed `*.theme.ts` definition and register it in `src/design-system/themes/registry.ts`; do not add a parallel id union or options array.
2. Provide both color modes, semantic material recipes, preview metadata, and the required component presentation values.
3. Persist and sanitize the id through `src/services/SettingsStore.ts` before exposing it in Settings.
4. Keep shared layout compatible with `default`; use component presentation only when the layout itself must differ.
5. Express foreground contrast through semantic color roles and surfaces through material requests. Do not add theme-name conditionals to components.
6. Add registry/resolver, foreground, Settings, and representative primitive tests before expanding the theme to more screens.

### Material and Effect Architecture

Materials distinguish dense content from eligible live-effect chrome:

- `src/design-system/materials/contract.ts` defines semantic roles, variants, tones, shapes, recipes, capability inputs, and the resolved renderer result.
- `Surface` and `PressableSurface` render dense fills, rims, and shadows. Content cards, message rows, attachments, progress tracks, list rows, chips, badges, and text fields stay on this path and never mount live blur.
- `EffectSurface` and `EffectPressableSurface` are the only live-effect renderers. They resolve the current recipe and environment, then render iOS Liquid Glass, the API 33+ Android renderer, `BlurView`, or a dense fallback without callers choosing a renderer.
- `MaterialEnvironmentProvider` owns platform capabilities and Reduce Transparency. Unknown, reduced, missing, or unsupported capability states fail closed to a dense recipe.
- iOS native Liquid Glass requires both runtime availability checks and allowed transparency. Actual semantic controls may opt into native interaction; decorative layers remain noninteractive, and disabled controls cannot advertise interaction.
- Android API 33+ uses the local `pocket-liquid-glass` renderer when its native views resolve. The minSdk-safe host contains no API 33 graphics types; `RenderNode`, `RenderEffect`, and `RuntimeShader` are isolated in the guarded API-specific renderer.
- Android SDK 31–32 retains target-backed `BlurView`; older, pending, detached, reduced-transparency, and runtime-failure states fail closed to the recipe's semantic dense paint.
- `ScreenRoot` owns one API 33+ scene recording boundary containing the canvas color, background decoration, and routed content. Effect chrome excludes itself during capture; the external tab bar and transparent modal sheets consume the active focused scene.
- `ScreenBackgroundDecoration` owns optional aurora paint. Material renderers may consume this visual context, but themes do not duplicate decoration trees in routes.
- Raw `BlurView` and `GlassView` imports are restricted to `EffectSurface`; `BlurTargetView` is restricted to the screen target-ownership boundary.

The bottom tab bar is ordinary semantic chrome. Its layout comes from `components.tabBar.presentation`, while `TabBarMaterialBackground` requests `chrome/tabBar` and lets the resolver choose native glass, Android target blur, legacy blur, or a dense fallback.

#### Role and variant map

| Request | Intended use | Live effect eligible |
| --- | --- | --- |
| `canvas/base` | Route canvas behind all content | No |
| `content/raised`, `content/inset`, `content/list` | Cards, panels, rows, and dense list content | No |
| `content/message*`, `content/composerMode` | Message bubbles, thought/attachment/error frames, and inline composer state | No |
| `chrome/header`, `chrome/tabBar`, `chrome/composer`, `chrome/sheet` | Screen-level chrome whose background is outside its sampled content | Yes |
| `control/inline`, `control/floating`, `control/selected` | Chips, buttons, selectors, and semantic controls | Only an explicitly effect-backed floating control |
| `overlay/banner`, `overlay/popover`, `overlay/scrim` | Floating status or modal layers | Banner/popover only; scrims stay dense |

Default-theme invariants are part of this contract. `default` keeps the established solid canvas, content density, frames, radii, spacing, and light/dark hierarchy; it must not acquire live effects merely because a generic renderer supports them. Theme-specific differences belong in recipes, foreground colors, decoration paint, or the narrow component-presentation fields. Shared components must not restore hard-coded default palette classes to compensate for a missing semantic token.

#### Capability and fallback matrices

The renderer resolves capability once from the environment and always fails closed:

| iOS state | Result for a native-liquid preferred recipe |
| --- | --- |
| Reduce Transparency is `unknown` or `reduced` | Dense accessibility fallback |
| Transparency allowed, Glass component and runtime API available | Native Liquid Glass |
| Transparency allowed, native Glass unavailable, `BlurView` available | Recipe-declared iOS blur fallback |
| Transparency allowed, neither renderer available | Dense unsupported fallback |

Reduce Transparency starts as `unknown`, is queried on provider mount, and is updated by the accessibility subscription. Unknown is never treated as permission to mount a translucent renderer. Native glass layers are noninteractive by default; only a real enabled semantic control may request native interaction.

| Android state | Result for a glass effect recipe |
| --- | --- |
| SDK missing, invalid, non-integer, or below 31 | Dense unsupported fallback |
| SDK 31–32 with a ready external sample target | Target-backed Android blur |
| SDK 33+ with native views and a recorded focused scene | Cropped native refraction and blur |
| Native scene pending, software canvas, or bounded render failure | Recipe-owned semantic fill and rim |
| Reduce Transparency is `unknown` or `reduced` | Dense accessibility fallback |

On API 33+, each glass surface records only its bounds expanded by the blur/refraction margin, clamped to the provider. It never performs bitmap readback or creates a full-provider effected layer per surface. Provider attach/switch and window-focus changes reset transient failures; draw retries are bounded before the surface remains on its semantic fallback. On SDK 31–32, the existing target readiness and nested-boundary rules still prevent self/ancestor blur cycles.

#### Performance and testing rules

Chat bubbles, attachments, thought panels, progress tracks, list rows, thumbnails, and other repeated content must remain dense. They may use theme-owned static paint and existing lightweight animations, but must not add `MaterialEnvironmentProvider` consumers, target subscriptions, `BlurView`, or `GlassView` per item. Effect recipes and target ownership are resolved at screen/chrome boundaries.

Every theme or material change should cover:

1. Registry derivation, persistence sanitization, deep immutability, and a synthetic future-theme resolver case.
2. Light/dark semantic paint and foreground contrast, including primary/success/error actions and user messages.
3. iOS native → blur → dense resolution, Reduce Transparency unknown/reduced transitions, and disabled/noninteractive controls.
4. Android SDK parsing, API 33 class isolation, full-scene ownership, crop bounds, semantic fallback, bounded recovery, target readiness, and self-capture exclusion.
5. Representative dense content and chat tests proving no live-effect imports or renderers enter hot paths.
6. Settings selector behavior with enough synthetic entries to force the scalable picker layout.

Visual QA is a separate evidence layer. Review `default` and every added theme in light and dark on Home, Chat, Models, Settings, a routed detail screen, a sheet, and the tab bar. Check selected/disabled controls, long localized copy, message attachments/thought/error states, Reduce Transparency, and Android target-pending fallback. Android screenshots do not prove iOS Liquid Glass; record iOS simulator/device evidence separately.

#### Minimal add-theme shape

```ts
const lightColors = createMyThemeColors('light');
const darkColors = createMyThemeColors('dark');

export const paperTheme = {
  id: 'paper',
  labelKey: 'settings.themeStylePaper',
  descriptionKey: 'settings.themeStylePaperDescription',
  preview: { canvas: lightColors.background, surface: lightColors.surface, accent: lightColors.primary, materialHint: 'solid' },
  modes: {
    light: { colors: lightColors, materials: createMyMaterialRecipes(lightColors, 'light') },
    dark: { colors: darkColors, materials: createMyMaterialRecipes(darkColors, 'dark') },
  },
  components: {
    screen: { backgroundDecoration: 'plain' },
    tabBar: { presentation: 'attached' },
    header: { presentation: 'attached' },
    chat: { composerPresentation: 'inline', userBubbleTone: 'primary' },
  },
} as const satisfies ThemeDefinition<'paper'>;
```

Register the definition once in `themes/registry.ts`; the derived `ThemeId`, Settings metadata, persistence validator, and resolver then include it without parallel unions or component branches. Add both locale keys and all required colors/material variants before registration.

## Screen Chrome Contract

Use the shared header families instead of route-local chrome:

- Root tabs: `HomeScreen` uses `HeaderBar`, `ChatScreen` uses `ChatHeader`, `ModelsCatalogScreen` uses `SearchHeader`, and `SettingsScreen` uses `HeaderBar`.
- Internal routed screens and the modal route should use `HeaderBar` plus `ScreenContent`, then build cards, badges, chips, and inline inputs from the shared screen primitives unless a documented exception is required.
- Back affordances belong only on genuinely navigable routed screens; root-tab chrome should not invent a fallback back behavior.
- Header actions and icon-only controls should keep the shared minimum touch-target contract from `theme-contract.json`.
- `Models` cards should stay visually dense: keep essential chips such as access, RAM warning, and size, but do not add a redundant `Status` chip when the lifecycle is already communicated by actions, progress, or the active badge.
- RAM-fit chips and warnings should use short user-facing language such as `Fits in RAM`, `Near RAM limit`, or `Won't fit RAM`; do not surface internal estimator jargon like `OOM` or confidence-level badges in the shipped UI.
- Finite option pickers should use `ListPickerSheet` before adding route-local modal UI. GGUF variant selection should go through `ModelVariantPickerSheet` and keep quantization, file name, size, selected state, and RAM-fit status visible without nesting cards.
- `Models` filtering should stay focused on user-useful criteria. The compact filter UI should expose RAM, token, and size filters; lifecycle categories such as `Available`, `Downloading`, and `Downloaded` should not appear as separate filter rows.

## QA Handoff

If you change shared theme, header, localization, motion, or routed-screen chrome, rerun this handoff set on a connected Android phone before closing the work:

```bash
npm run verify:mobile-change
npm run android:scenarios -- --skip-build --pack dependency-ui
node ./scripts/android-scenarios.js --skip-build --scenario hf-catalog-hardening
node ./scripts/android-screen-capture.js --skip-build --screen home,models,settings,conversations,huggingface-token,model-details --output-dir artifacts/android-scenarios/manual-sample
```

`npm run android:scenarios` defaults to a small core smoke pack (`home-smoke`, `bottom-tabs`, `new-chat-cta`). Use `--pack catalog` or `--scenario variant-picker-smoke` for live model-catalog checks, `--pack dependency-ui` for UI architecture changes, `--pack runtime` for localization or persisted-state changes, `npm run android:scenarios:native` for the isolated release-profile Glass matrix across Home, Chat, Models, and Settings in light and dark modes, and `--pack extended` when you need the broader stable pass without live catalog smoke. Raw `--pack native` is forced onto the same `.qa` package and restores the package's prior theme and notification state. Keep perf and other optional scenarios targeted unless `--pack all` is needed.

Manual follow-up is still required for:

- iOS route-by-route smoke
- screen-reader semantics
- dynamic-type checkpoints
- weak-device motion and responsiveness
- modal route review
