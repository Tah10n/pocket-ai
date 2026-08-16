import React, { useMemo } from 'react';
import {
  type PressableStateCallbackType,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { GlassView } from 'expo-glass-effect';
import { Box } from '@/components/ui/box';
import { Pressable } from '@/components/ui/pressable';
import { useTheme } from '../../providers/ThemeProvider';
import { useResolvedAndroidBlurTarget } from './AndroidBlurTargetContext';
import type { AndroidBlurTargetRef } from '../../utils/androidBlur';
import { useMaterialEnvironment } from './MaterialEnvironmentProvider';
import type {
  MaterialColorMode,
  MaterialEnvironment,
  MaterialRendererRecipe,
  MaterialRequest,
  MaterialShape,
} from './contract';
import { resolveMaterialRecipe } from './resolver';
import {
  getMaterialFrameStyle,
  getMaterialShapeStyle,
  withMaterialPaintOpacity,
} from './style';

type BoxProps = React.ComponentProps<typeof Box>;
type EffectMaterialRequest = Extract<MaterialRequest, {
  role: 'chrome' | 'overlay';
}>;
type InteractiveEffectMaterialRequest = Extract<MaterialRequest, {
  role: 'control';
}>;

function EffectLayers({
  androidBlurTarget,
  clipStyle,
  effectiveEnvironment,
  interactive,
  mode,
  recipe,
}: {
  readonly androidBlurTarget: AndroidBlurTargetRef | null;
  readonly clipStyle: ViewStyle;
  readonly effectiveEnvironment: MaterialEnvironment;
  readonly interactive: boolean;
  readonly mode: MaterialColorMode;
  readonly recipe: MaterialRendererRecipe;
}) {
  const hasEffectLayers = recipe.renderer === 'blur'
    || recipe.renderer === 'native-liquid-glass'
    || Boolean(recipe.contrastFilm)
    || Boolean(recipe.tint);

  if (!hasEffectLayers) {
    return null;
  }

  const nativeGlassIsInteractive = interactive && recipe.renderer === 'native-liquid-glass';

  return (
    <Box
      pointerEvents={nativeGlassIsInteractive ? 'box-none' : 'none'}
      style={[StyleSheet.absoluteFill, clipStyle, { overflow: 'hidden' }]}
    >
      {recipe.renderer === 'blur' ? (
        <BlurView
          pointerEvents="none"
          intensity={recipe.blur.intensity}
          tint={recipe.blur.tint}
          blurMethod={effectiveEnvironment.platform === 'android'
            ? 'dimezisBlurViewSdk31Plus'
            : undefined}
          blurReductionFactor={effectiveEnvironment.platform === 'android'
            ? recipe.blur.androidBlurReductionDivisor
            : undefined}
          blurTarget={effectiveEnvironment.platform === 'android'
            ? androidBlurTarget ?? undefined
            : undefined}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      {recipe.renderer === 'native-liquid-glass' ? (
        <GlassView
          pointerEvents={nativeGlassIsInteractive ? 'auto' : 'none'}
          glassEffectStyle={recipe.nativeGlass.style}
          tintColor={recipe.tint
            ? withMaterialPaintOpacity(recipe.tint.color, recipe.tint.opacity)
            : undefined}
          colorScheme={mode}
          isInteractive={nativeGlassIsInteractive}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      {recipe.contrastFilm ? (
        <Box
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            {
              backgroundColor: withMaterialPaintOpacity(
                recipe.contrastFilm.color,
                recipe.contrastFilm.opacity,
              ),
            },
          ]}
        />
      ) : null}
      {recipe.tint && recipe.renderer !== 'native-liquid-glass' ? (
        <Box
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            {
              backgroundColor: withMaterialPaintOpacity(recipe.tint.color, recipe.tint.opacity),
            },
          ]}
        />
      ) : null}
    </Box>
  );
}

export type EffectSurfaceProps = BoxProps & {
  readonly androidBlurTargetRef?: AndroidBlurTargetRef | null;
  readonly material: EffectMaterialRequest;
  readonly shape?: MaterialShape;
};

export function EffectSurface({
  androidBlurTargetRef,
  children,
  material,
  shape = 'md',
  style,
  ...props
}: EffectSurfaceProps) {
  const { resolvedTheme } = useTheme();
  const environment = useMaterialEnvironment();
  const androidBlurTarget = useResolvedAndroidBlurTarget(androidBlurTargetRef);
  const effectiveEnvironment = useMemo(() => ({
    ...environment,
    androidTargetBlurSupported: environment.androidTargetBlurSupported
      && Boolean(androidBlurTarget),
  }), [androidBlurTarget, environment]);
  const recipe = useMemo(
    () => resolveMaterialRecipe(resolvedTheme.materials, material, effectiveEnvironment),
    [effectiveEnvironment, material, resolvedTheme.materials],
  );
  const frameStyle = useMemo(
    () => getMaterialFrameStyle(recipe, shape),
    [recipe, shape],
  );
  const clipStyle = useMemo(
    () => getMaterialShapeStyle(shape),
    [shape],
  );
  return (
    <Box {...props} style={[frameStyle, style]}>
      <EffectLayers
        androidBlurTarget={androidBlurTarget}
        clipStyle={clipStyle}
        effectiveEnvironment={effectiveEnvironment}
        interactive={false}
        mode={resolvedTheme.mode}
        recipe={recipe}
      />
      {children}
    </Box>
  );
}

type PressableProps = Omit<React.ComponentProps<typeof Pressable>, 'children'>;

export type EffectPressableSurfaceProps = PressableProps & {
  readonly androidBlurTargetRef?: AndroidBlurTargetRef | null;
  readonly children?: React.ReactNode;
  readonly material: InteractiveEffectMaterialRequest;
  readonly shape?: MaterialShape;
};

export function EffectPressableSurface({
  androidBlurTargetRef,
  children,
  disabled,
  material,
  shape = 'md',
  style,
  ...props
}: EffectPressableSurfaceProps) {
  const { resolvedTheme } = useTheme();
  const environment = useMaterialEnvironment();
  const androidBlurTarget = useResolvedAndroidBlurTarget(androidBlurTargetRef);
  const effectiveEnvironment = useMemo(() => ({
    ...environment,
    androidTargetBlurSupported: environment.androidTargetBlurSupported
      && Boolean(androidBlurTarget),
  }), [androidBlurTarget, environment]);
  const recipe = useMemo(
    () => resolveMaterialRecipe(resolvedTheme.materials, material, effectiveEnvironment),
    [effectiveEnvironment, material, resolvedTheme.materials],
  );
  const frameStyle = useMemo(
    () => getMaterialFrameStyle(recipe, shape),
    [recipe, shape],
  );
  const clipStyle = useMemo(
    () => getMaterialShapeStyle(shape),
    [shape],
  );
  const resolvedStyle = typeof style === 'function'
    ? (state: PressableStateCallbackType): StyleProp<ViewStyle> => [frameStyle, style(state)]
    : [frameStyle, style];
  const nativeGlassIsInteractive = recipe.renderer === 'native-liquid-glass' && !disabled;

  return (
    <Pressable {...props} disabled={disabled} style={resolvedStyle}>
      <EffectLayers
        androidBlurTarget={androidBlurTarget}
        clipStyle={clipStyle}
        effectiveEnvironment={effectiveEnvironment}
        interactive={!disabled}
        mode={resolvedTheme.mode}
        recipe={recipe}
      />
      {nativeGlassIsInteractive ? (
        <Box pointerEvents="none">{children}</Box>
      ) : children}
    </Pressable>
  );
}
