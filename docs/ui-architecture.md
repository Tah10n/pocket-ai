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

* **Styling**: We strictly use NativeWind (`className`) for styling. Avoid inline `style={{ ... }}` unless dealing with dynamic runtime calculations (like `safeAreaInsets`).
* **Icons**: Use the centralized `MaterialSymbols` component (`@/components/ui/MaterialSymbols`) instead of importing directly from `@expo/vector-icons`.
* **CSS Interop**: All base primitive components must be wrapped in NativeWind's `cssInterop` object so they can seamlessly accept and process `className` props without throwing unhandled UI update crashes.
