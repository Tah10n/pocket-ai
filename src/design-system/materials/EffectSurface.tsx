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
import {
  AndroidLiquidGlassCaptureExclusion,
  AndroidLiquidGlassSurface,
} from './AndroidLiquidGlass';
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
  pressed = false,
  mode,
  recipe,
}: {
  readonly androidBlurTarget: AndroidBlurTargetRef | null;
  readonly clipStyle: ViewStyle;
  readonly effectiveEnvironment: MaterialEnvironment;
  readonly interactive: boolean;
  readonly pressed?: boolean;
  readonly mode: MaterialColorMode;
  readonly recipe: MaterialRendererRecipe;
}) {
  const hasEffectLayers = recipe.renderer === 'blur'
    || recipe.renderer === 'native-liquid-glass'
    || recipe.renderer === 'android-liquid-glass'
    || Boolean(recipe.contrastFilm)
    || Boolean(recipe.tint);

  if (!hasEffectLayers) {
    return null;
  }

  const nativeGlassIsInteractive = interactive && (
    recipe.renderer === 'native-liquid-glass'
    || recipe.renderer === 'android-liquid-glass'
  );
  const defaultRadius = typeof clipStyle.borderRadius === 'number' ? clipStyle.borderRadius : 0;
  const cornerRadiusTopLeft = typeof clipStyle.borderTopLeftRadius === 'number'
    ? clipStyle.borderTopLeftRadius
    : defaultRadius;
  const cornerRadiusTopRight = typeof clipStyle.borderTopRightRadius === 'number'
    ? clipStyle.borderTopRightRadius
    : defaultRadius;
  const cornerRadiusBottomRight = typeof clipStyle.borderBottomRightRadius === 'number'
    ? clipStyle.borderBottomRightRadius
    : defaultRadius;
  const cornerRadiusBottomLeft = typeof clipStyle.borderBottomLeftRadius === 'number'
    ? clipStyle.borderBottomLeftRadius
    : defaultRadius;

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
      {recipe.renderer === 'android-liquid-glass' ? (
        <AndroidLiquidGlassSurface
          pointerEvents="none"
          cornerRadius={defaultRadius}
          cornerRadiusTopLeft={cornerRadiusTopLeft}
          cornerRadiusTopRight={cornerRadiusTopRight}
          cornerRadiusBottomRight={cornerRadiusBottomRight}
          cornerRadiusBottomLeft={cornerRadiusBottomLeft}
          dark={mode === 'dark'}
          tintColor={recipe.tint?.color}
          tintOpacity={recipe.tint?.opacity ?? 0}
          fallbackColor={recipe.androidGlass.fallbackFill.color}
          fallbackOpacity={recipe.androidGlass.fallbackFill.opacity}
          fallbackBorderColor={recipe.androidGlass.fallbackRim.color}
          fallbackBorderOpacity={recipe.androidGlass.fallbackRim.opacity}
          fallbackBorderWidth={recipe.androidGlass.fallbackRim.width}
          interactive={nativeGlassIsInteractive}
          pressed={pressed}
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
      {recipe.tint
      && recipe.renderer !== 'native-liquid-glass'
      && recipe.renderer !== 'android-liquid-glass' ? (
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
  const content = (
    <>
      <EffectLayers
        androidBlurTarget={androidBlurTarget}
        clipStyle={clipStyle}
        effectiveEnvironment={effectiveEnvironment}
        interactive={false}
        pressed={false}
        mode={resolvedTheme.mode}
        recipe={recipe}
      />
      {children}
    </>
  );
  if (recipe.renderer === 'android-liquid-glass') {
    return (
      <AndroidLiquidGlassCaptureExclusion
        {...props}
        collapsable={false}
        pointerEvents="box-none"
        style={[frameStyle, style]}
      >
        {content}
      </AndroidLiquidGlassCaptureExclusion>
    );
  }
  return <Box {...props} style={[frameStyle, style]}>{content}</Box>;
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
  className,
  material,
  shape = 'md',
  style,
  onPressIn,
  onPressOut,
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
  const [isPressed, setIsPressed] = React.useState(false);
  const handlePressIn = React.useCallback((event: Parameters<NonNullable<typeof onPressIn>>[0]) => {
    setIsPressed(true);
    onPressIn?.(event);
  }, [onPressIn]);
  const handlePressOut = React.useCallback((event: Parameters<NonNullable<typeof onPressOut>>[0]) => {
    setIsPressed(false);
    onPressOut?.(event);
  }, [onPressOut]);
  const resolvedStyle = typeof style === 'function'
    ? (state: PressableStateCallbackType): StyleProp<ViewStyle> => [frameStyle, style(state)]
    : [frameStyle, style];
  const androidHostStyle = typeof style === 'function'
    ? (state: PressableStateCallbackType): StyleProp<ViewStyle> => [
      clipStyle,
      { borderColor: 'transparent', borderWidth: frameStyle.borderWidth },
      style(state),
    ]
    : [
      clipStyle,
      { borderColor: 'transparent', borderWidth: frameStyle.borderWidth },
      style,
    ];
  const nativeGlassIsInteractive = (
    recipe.renderer === 'native-liquid-glass'
    || recipe.renderer === 'android-liquid-glass'
  ) && !disabled;

  const content = (
    <>
      <EffectLayers
        androidBlurTarget={androidBlurTarget}
        clipStyle={clipStyle}
        effectiveEnvironment={effectiveEnvironment}
        interactive={!disabled}
        pressed={isPressed}
        mode={resolvedTheme.mode}
        recipe={recipe}
      />
      {nativeGlassIsInteractive ? (
        <Box pointerEvents="none">{children}</Box>
      ) : children}
    </>
  );
  if (recipe.renderer === 'android-liquid-glass') {
    const excludedContent = React.Children.map(children, (child) => (
      <AndroidLiquidGlassCaptureExclusion
        collapsable={false}
        pointerEvents="box-none"
      >
        {nativeGlassIsInteractive ? <Box pointerEvents="none">{child}</Box> : child}
      </AndroidLiquidGlassCaptureExclusion>
    ));

    return (
      <Pressable
        {...props}
        className={className}
        disabled={disabled}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        style={androidHostStyle}
      >
        <AndroidLiquidGlassCaptureExclusion
          collapsable={false}
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, frameStyle]}
        >
          <EffectLayers
            androidBlurTarget={androidBlurTarget}
            clipStyle={clipStyle}
            effectiveEnvironment={effectiveEnvironment}
            interactive={!disabled}
            pressed={isPressed}
            mode={resolvedTheme.mode}
            recipe={recipe}
          />
        </AndroidLiquidGlassCaptureExclusion>
        {excludedContent}
      </Pressable>
    );
  }
  return (
    <Pressable
      {...props}
      className={className}
      disabled={disabled}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={resolvedStyle}
    >
      {content}
    </Pressable>
  );
}
