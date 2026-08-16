import type { Theme } from '@react-navigation/native';
import type {
  ResolvedThemeMode,
  ThemeAppearance,
  ThemeColors,
} from './legacyTheme';
import type { ThemeMaterialRecipes } from '../materials/contract';

export interface ThemePreviewTokens {
  readonly canvas: string;
  readonly surface: string;
  readonly accent: string;
  readonly materialHint: 'solid' | 'translucent';
}

export interface ThemeMetadata<Id extends string = string> {
  readonly id: Id;
  readonly labelKey: string;
  readonly descriptionKey?: string;
  readonly preview: ThemePreviewTokens;
}

export interface ThemeComponentPresentation {
  readonly tabBar: {
    readonly presentation: 'attached' | 'floating';
  };
  readonly header: {
    readonly presentation: 'attached' | 'overlay';
  };
  readonly chat: {
    readonly composerPresentation: 'inline' | 'capsule';
    readonly userBubbleTone: 'primary';
  };
}

export interface ThemeModeDefinition<Id extends string = string> {
  readonly colors: ThemeColors;
  readonly appearance: ThemeAppearance<Id>;
  readonly materials: ThemeMaterialRecipes;
}

export interface ThemeDefinition<Id extends string = string> extends ThemeMetadata<Id> {
  readonly modes: Readonly<Record<ResolvedThemeMode, ThemeModeDefinition<Id>>>;
  readonly components: ThemeComponentPresentation;
}

export interface ResolvedTheme<Id extends string = string> {
  readonly id: Id;
  readonly mode: ResolvedThemeMode;
  readonly metadata: ThemeMetadata<Id>;
  readonly colors: ThemeColors;
  readonly appearance: ThemeAppearance<Id>;
  readonly materials: ThemeMaterialRecipes;
  readonly components: ThemeComponentPresentation;
  readonly navigationTheme: Theme;
}
