import React, { useMemo } from 'react';
import { StyleSheet } from 'react-native';
import { BlurView } from 'expo-blur';
import { Box } from '@/components/ui/box';
import { useTheme } from '../../providers/ThemeProvider';
import { useResolvedAndroidBlurTarget } from './AndroidBlurTargetContext';
import type { AndroidBlurTargetRef } from '../../utils/androidBlur';
import { useMaterialEnvironment } from './MaterialEnvironmentProvider';
import type { MaterialRequest, MaterialShape } from './contract';
import { resolveMaterialRecipe } from './resolver';
import {
  getMaterialFrameStyle,
  getMaterialShapeStyle,
  withMaterialPaintOpacity,
} from './style';

type BoxProps = React.ComponentProps<typeof Box>;
type EffectMaterialRequest = Extract<MaterialRequest, {
  role: 'chrome' | 'control' | 'overlay';
}>;

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
    // Native Liquid Glass is enabled only when its renderer is installed in the iOS slice.
    liquidGlassComponentAvailable: false,
    liquidGlassApiAvailable: false,
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
  const hasEffectLayers = recipe.renderer === 'blur'
    || Boolean(recipe.contrastFilm)
    || Boolean(recipe.tint);

  return (
    <Box {...props} style={[frameStyle, style]}>
      {hasEffectLayers ? (
        <Box
          pointerEvents="none"
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
          {recipe.tint ? (
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
      ) : null}
      {children}
    </Box>
  );
}
