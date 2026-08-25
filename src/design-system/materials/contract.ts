export type SurfaceRole = 'canvas' | 'content' | 'chrome' | 'control' | 'overlay';

export type MaterialShape = 'none' | 'sm' | 'md' | 'lg' | 'xl' | 'sheet' | 'tabBar' | 'full';

export type MaterialTone =
  | 'neutral'
  | 'primary'
  | 'accent'
  | 'info'
  | 'success'
  | 'warning'
  | 'error';

export type CanvasMaterialVariant = 'base';
export type ContentMaterialVariant =
  | 'raised'
  | 'inset'
  | 'list'
  | 'message'
  | 'messageThought'
  | 'messageAttachment'
  | 'messageError'
  | 'composerMode';
export type ChromeMaterialVariant = 'header' | 'tabBar' | 'composer' | 'sheet';
export type ControlMaterialVariant = 'inline' | 'floating' | 'selected';
export type OverlayMaterialVariant = 'banner' | 'popover' | 'scrim';

export type MaterialRequest =
  | { readonly role: 'canvas'; readonly variant?: CanvasMaterialVariant; readonly tone?: MaterialTone }
  | { readonly role: 'content'; readonly variant?: ContentMaterialVariant; readonly tone?: MaterialTone }
  | { readonly role: 'chrome'; readonly variant?: ChromeMaterialVariant; readonly tone?: MaterialTone }
  | { readonly role: 'control'; readonly variant?: ControlMaterialVariant; readonly tone?: MaterialTone }
  | { readonly role: 'overlay'; readonly variant?: OverlayMaterialVariant; readonly tone?: MaterialTone };

export type MaterialPlatform = 'ios' | 'android' | 'web';
export type MaterialColorMode = 'light' | 'dark';
export type TransparencyState = 'unknown' | 'reduced' | 'allowed';

export interface MaterialPalette {
  readonly background: string;
  readonly surface: string;
  readonly surfaceMuted: string;
  readonly surfaceOverlay: string;
  readonly cardBackground: string;
  readonly inputBackground: string;
  readonly border: string;
  readonly borderStrong: string;
  readonly borderSubtle: string;
  readonly primary: string;
  readonly primarySoft: string;
  readonly info: string;
  readonly infoSurface: string;
  readonly success: string;
  readonly successSurface: string;
  readonly warning: string;
  readonly warningSurface: string;
  readonly error: string;
  readonly dangerSurface: string;
  readonly overlay: string;
  readonly tabBarBackground: string;
  readonly tabBarBorder: string;
  readonly headerBlurTint: 'light' | 'dark';
}

export interface MaterialEnvironment {
  readonly platform: MaterialPlatform;
  readonly androidSdkVersion?: number;
  readonly blurViewAvailable: boolean;
  readonly androidTargetBlurSupported: boolean;
  readonly liquidGlassComponentAvailable: boolean;
  readonly liquidGlassApiAvailable: boolean;
  readonly transparencyState: TransparencyState;
}

export interface MaterialPaint {
  readonly color: string;
  readonly opacity: number;
}

export interface MaterialRim {
  readonly color: string;
  readonly opacity: number;
  readonly width: number;
}

export interface MaterialShadow {
  readonly color: string;
  readonly opacity: number;
  readonly radius: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly elevation: number;
}

interface MaterialRendererRecipeBase {
  readonly fill: MaterialPaint;
  readonly tint: MaterialPaint | null;
  readonly contrastFilm: MaterialPaint | null;
  readonly rim: MaterialRim;
  readonly shadow: MaterialShadow;
  readonly interactionSupport: 'static' | 'pressable' | 'native';
}

export interface SolidMaterialRecipe extends MaterialRendererRecipeBase {
  readonly renderer: 'solid';
}

export interface TintedMaterialRecipe extends MaterialRendererRecipeBase {
  readonly renderer: 'tinted';
}

export interface BlurMaterialRecipe extends MaterialRendererRecipeBase {
  readonly renderer: 'blur';
  readonly blur: {
    readonly intensity: number;
    readonly tint:
      | 'light'
      | 'dark'
      | 'default'
      | 'systemUltraThinMaterialLight'
      | 'systemUltraThinMaterialDark';
    readonly androidBlurReductionDivisor: number;
  };
}

export interface NativeLiquidGlassMaterialRecipe extends MaterialRendererRecipeBase {
  readonly renderer: 'native-liquid-glass';
  readonly nativeGlass: {
    readonly style: 'clear' | 'regular';
  };
}

export type DenseMaterialRecipe = SolidMaterialRecipe | TintedMaterialRecipe;
export type MaterialRendererRecipe =
  | DenseMaterialRecipe
  | BlurMaterialRecipe
  | NativeLiquidGlassMaterialRecipe;

export interface MaterialRecipeDefinition {
  readonly preferredByPlatform: Readonly<Record<MaterialPlatform, MaterialRendererRecipe>>;
  readonly platformFallbackByPlatform?: Readonly<Partial<Record<MaterialPlatform, MaterialRendererRecipe>>>;
  readonly accessibilityFallback: DenseMaterialRecipe;
  readonly unsupportedPlatformFallback: DenseMaterialRecipe;
}

export type MaterialToneRecipes = Readonly<{
  neutral: MaterialRecipeDefinition;
} & Partial<Record<Exclude<MaterialTone, 'neutral'>, MaterialRecipeDefinition>>>;

export type MaterialVariantRecipes<Variant extends string> = Readonly<Record<Variant, MaterialToneRecipes>>;

export interface ThemeMaterialRecipes {
  readonly canvas: MaterialVariantRecipes<CanvasMaterialVariant>;
  readonly content: MaterialVariantRecipes<ContentMaterialVariant>;
  readonly chrome: MaterialVariantRecipes<ChromeMaterialVariant>;
  readonly control: MaterialVariantRecipes<ControlMaterialVariant>;
  readonly overlay: MaterialVariantRecipes<OverlayMaterialVariant>;
}
