import React from 'react';
import { StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Box } from '@/components/ui/box';
import type { MaterialColorMode } from './contract';
import { withMaterialPaintOpacity } from './style';

type GradientColors = readonly [string, string, ...string[]];

function createAuroraColors(mode: MaterialColorMode, dim: boolean) {
  const scale = dim ? 0.45 : 1;
  const transparent = mode === 'dark'
    ? withMaterialPaintOpacity('#f4f7fb', 0)
    : withMaterialPaintOpacity('#f8fafc', 0);
  const alpha = (value: number) => value * scale;

  return {
    top: mode === 'dark'
      ? [withMaterialPaintOpacity('#60a5fa', alpha(0.16)), withMaterialPaintOpacity('#7dd3fc', alpha(0.09)), transparent] as GradientColors
      : [withMaterialPaintOpacity('#2563eb', alpha(0.24)), withMaterialPaintOpacity('#60a5fa', alpha(0.16)), transparent] as GradientColors,
    cross: mode === 'dark'
      ? [transparent, withMaterialPaintOpacity('#7dd3fc', alpha(0.11)), withMaterialPaintOpacity('#60a5fa', alpha(0.07)), transparent] as GradientColors
      : [transparent, withMaterialPaintOpacity('#3b82f6', alpha(0.18)), withMaterialPaintOpacity('#0ea5e9', alpha(0.12)), transparent] as GradientColors,
    bottom: mode === 'dark'
      ? [transparent, withMaterialPaintOpacity('#60a5fa', alpha(0.12)), withMaterialPaintOpacity('#34d399', alpha(0.055))] as GradientColors
      : [transparent, withMaterialPaintOpacity('#60a5fa', alpha(0.22)), withMaterialPaintOpacity('#22c55e', alpha(0.1))] as GradientColors,
    warmth: mode === 'dark'
      ? [transparent, withMaterialPaintOpacity('#fb923c', alpha(0.045)), transparent] as GradientColors
      : [transparent, withMaterialPaintOpacity('#fb923c', alpha(0.08)), transparent] as GradientColors,
  };
}

const auroraColorsByMode = {
  light: {
    regular: createAuroraColors('light', false),
    dim: createAuroraColors('light', true),
  },
  dark: {
    regular: createAuroraColors('dark', false),
    dim: createAuroraColors('dark', true),
  },
} as const;

export function ScreenBackgroundDecoration({
  dim = false,
  mode,
}: {
  readonly dim?: boolean;
  readonly mode: MaterialColorMode;
}) {
  const colors = auroraColorsByMode[mode][dim ? 'dim' : 'regular'];

  return (
    <Box pointerEvents="none" style={StyleSheet.absoluteFill}>
      <LinearGradient pointerEvents="none" colors={colors.top} locations={[0, 0.46, 1]} start={{ x: 0.72, y: 0 }} end={{ x: 0.2, y: 0.9 }} style={StyleSheet.absoluteFill} />
      <LinearGradient pointerEvents="none" colors={colors.cross} locations={[0, 0.42, 0.72, 1]} start={{ x: 0, y: 0.12 }} end={{ x: 1, y: 0.86 }} style={StyleSheet.absoluteFill} />
      <LinearGradient pointerEvents="none" colors={colors.bottom} locations={[0, 0.54, 1]} start={{ x: 0.3, y: 0.36 }} end={{ x: 0.7, y: 1 }} style={StyleSheet.absoluteFill} />
      <LinearGradient pointerEvents="none" colors={colors.warmth} locations={[0, 0.48, 1]} start={{ x: 0.98, y: 0.32 }} end={{ x: 0.54, y: 0.68 }} style={StyleSheet.absoluteFill} />
    </Box>
  );
}
