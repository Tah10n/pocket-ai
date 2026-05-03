import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import { Platform, StyleSheet } from 'react-native';
import { Box } from '@/components/ui/box';
import { useTheme } from '../../providers/ThemeProvider';
import { getAndroidBlurProps, getGlassBlurTint, isAndroidBlurFallbackRequired, useActiveAndroidBlurTarget } from '../../utils/androidBlur';
import { bottomTabBarMetrics } from '../../utils/tabBarLayout';
import { GlassSpecular } from './GlassSpecular';

function joinClassNames(...values: (string | undefined | false)[]) {
  return values.filter(Boolean).join(' ');
}

const TAB_BAR_BLUR_INTENSITY_SCALE = 0.22;

type TabBarGradientColors = readonly [string, string, ...string[]];

function getTabBarBlurIntensity(surfaceBlurIntensity: number) {
  return Math.round(surfaceBlurIntensity * TAB_BAR_BLUR_INTENSITY_SCALE);
}

function TabBarFadeBackdrop({ tint }: { tint: 'light' | 'dark' }) {
  const isDark = tint === 'dark';

  if (Platform.OS === 'android') {
    return null;
  }

  const colors: TabBarGradientColors = isDark
    ? ['rgba(125,211,252,0)', 'rgba(125,211,252,0.018)', 'rgba(96,165,250,0.034)']
    : ['rgba(255,255,255,0)', 'rgba(255,255,255,0.018)', 'rgba(255,255,255,0.034)'];

  return (
    <LinearGradient
      pointerEvents="none"
      colors={colors}
      locations={[0, 0.45, 1]}
      start={{ x: 0, y: 0 }}
      end={{ x: 0, y: 1 }}
      style={StyleSheet.absoluteFill}
    />
  );
}

function TabBarTintBackdrop({ tint }: { tint: 'light' | 'dark' }) {
  const isDark = tint === 'dark';

  if (Platform.OS === 'android') {
    return null;
  }

  const colors: TabBarGradientColors = isDark
    ? ['rgba(96,165,250,0)', 'rgba(125,211,252,0.045)', 'rgba(96,165,250,0.026)', 'rgba(52,211,153,0)']
    : ['rgba(255,255,255,0)', 'rgba(255,255,255,0.03)', 'rgba(191,219,254,0.02)', 'rgba(14,165,233,0)'];

  return (
    <LinearGradient
      pointerEvents="none"
      colors={colors}
      locations={[0, 0.22, 0.62, 1]}
      start={{ x: 0.05, y: 0 }}
      end={{ x: 0.95, y: 1 }}
      style={StyleSheet.absoluteFill}
    />
  );
}

function TabBarMatteBackdrop({ fallback = false, tint }: { fallback?: boolean; tint: 'light' | 'dark' }) {
  const isDark = tint === 'dark';
  const backgroundColor = fallback
    ? isDark
      ? 'rgba(244,247,251,0.22)'
      : 'rgba(248,250,252,0.24)'
    : isDark
      ? 'rgba(244,247,251,0.075)'
      : 'rgba(248,250,252,0.01)';

  return (
    <Box
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        {
          backgroundColor,
        },
      ]}
    />
  );
}

function TabBarContrastBackdrop({ fallback = false, tint }: { fallback?: boolean; tint: 'light' | 'dark' }) {
  if (tint !== 'dark') {
    return null;
  }

  return (
    <Box
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        {
          backgroundColor: fallback
            ? 'rgba(6,11,20,0.24)'
            : 'rgba(6,11,20,0.18)',
        },
      ]}
    />
  );
}

function TabBarRefractionOptics({ tint }: { tint: 'light' | 'dark' }) {
  const isDark = tint === 'dark';

  if (Platform.OS === 'android') {
    return null;
  }

  const refractionColors: TabBarGradientColors = isDark
    ? ['rgba(96,165,250,0)', 'rgba(125,211,252,0.05)', 'rgba(56,189,248,0.024)', 'rgba(6,11,20,0)']
    : ['rgba(37,99,235,0)', 'rgba(37,99,235,0.022)', 'rgba(14,165,233,0.01)', 'rgba(37,99,235,0)'];
  const leftLensColors: TabBarGradientColors = isDark
    ? ['rgba(125,211,252,0.055)', 'rgba(96,165,250,0.018)', 'rgba(6,11,20,0)']
    : ['rgba(255,255,255,0.055)', 'rgba(255,255,255,0.012)', 'rgba(255,255,255,0)'];
  const rightLensColors: TabBarGradientColors = isDark
    ? ['rgba(6,11,20,0)', 'rgba(96,165,250,0.014)', 'rgba(125,211,252,0.04)']
    : ['rgba(255,255,255,0)', 'rgba(255,255,255,0.009)', 'rgba(255,255,255,0.04)'];
  const lowerCompressionColors: TabBarGradientColors = isDark
    ? ['rgba(6,11,20,0)', 'rgba(52,211,153,0.018)', 'rgba(6,11,20,0)']
    : ['rgba(255,255,255,0)', 'rgba(37,99,235,0.008)', 'rgba(255,255,255,0)'];

  return (
    <Box pointerEvents="none" style={StyleSheet.absoluteFill}>
      <LinearGradient
        pointerEvents="none"
        colors={refractionColors}
        locations={[0, 0.26, 0.64, 1]}
        start={{ x: 0.04, y: 0 }}
        end={{ x: 0.96, y: 1 }}
        style={styles.refractionBand}
      />
      <LinearGradient
        pointerEvents="none"
        colors={leftLensColors}
        locations={[0, 0.52, 1]}
        start={{ x: 0, y: 0.5 }}
        end={{ x: 1, y: 0.5 }}
        style={styles.leftLensEdge}
      />
      <LinearGradient
        pointerEvents="none"
        colors={rightLensColors}
        locations={[0, 0.5, 1]}
        start={{ x: 0, y: 0.5 }}
        end={{ x: 1, y: 0.5 }}
        style={styles.rightLensEdge}
      />
      <LinearGradient
        pointerEvents="none"
        colors={lowerCompressionColors}
        locations={[0, 0.55, 1]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={styles.lowerLensCompression}
      />
    </Box>
  );
}

function getTabBarBlurTint(tint: 'light' | 'dark') {
  return getGlassBlurTint(tint === 'dark'
    ? 'systemUltraThinMaterialDark'
    : 'systemUltraThinMaterialLight');
}

export function TabBarGlassBackground() {
  const { appearance, colors } = useTheme();
  const activeAndroidBlurTarget = useActiveAndroidBlurTarget();

  if (appearance.surfaceKind !== 'glass') {
    return (
      <Box
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          {
            backgroundColor: colors.tabBarBackground,
            borderTopColor: colors.tabBarBorder,
            borderTopWidth: StyleSheet.hairlineWidth,
          },
        ]}
      />
    );
  }

  const shouldFallback = isAndroidBlurFallbackRequired();
  const shouldUseAndroidBlurTarget = Platform.OS === 'android' && !shouldFallback;
  const hasUsableAndroidBlurTarget = Boolean(activeAndroidBlurTarget?.current);
  const androidBlurTarget = shouldUseAndroidBlurTarget && hasUsableAndroidBlurTarget
    ? activeAndroidBlurTarget
    : undefined;
  const isAndroidBlurTargetPending = shouldUseAndroidBlurTarget && !hasUsableAndroidBlurTarget;
  const shouldRenderBlurView = !shouldFallback && !isAndroidBlurTargetPending;
  const shouldUseDenseMatteFallback = shouldFallback || isAndroidBlurTargetPending;

  return (
    <Box
      pointerEvents="none"
      className={joinClassNames('overflow-hidden', !shouldFallback ? 'bg-transparent' : undefined)}
      style={[
        StyleSheet.absoluteFill,
        styles.floatingGlassBase,
        styles.floatingNativeFrame,
        shouldUseAndroidBlurTarget ? styles.transparentNativeBlurBackground : null,
      ]}
    >
      {shouldRenderBlurView ? (
        <BlurView
          pointerEvents="none"
          intensity={getTabBarBlurIntensity(appearance.effects.surfaceBlurIntensity)}
          tint={getTabBarBlurTint(colors.headerBlurTint)}
          {...getAndroidBlurProps(appearance, androidBlurTarget)}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      <TabBarContrastBackdrop fallback={shouldUseDenseMatteFallback} tint={colors.headerBlurTint} />
      <TabBarMatteBackdrop fallback={shouldUseDenseMatteFallback} tint={colors.headerBlurTint} />
      <TabBarTintBackdrop tint={colors.headerBlurTint} />
      <TabBarFadeBackdrop tint={colors.headerBlurTint} />
      <TabBarRefractionOptics tint={colors.headerBlurTint} />
      <GlassSpecular tint={colors.headerBlurTint} />
    </Box>
  );
}

const styles = StyleSheet.create({
  floatingGlassBase: {
    backgroundColor: 'transparent',
  },
  floatingNativeFrame: {
    borderRadius: bottomTabBarMetrics.glassRadius,
    borderWidth: 0,
    elevation: 0,
    shadowOpacity: 0,
  },
  transparentNativeBlurBackground: {
    backgroundColor: 'transparent',
  },
  refractionBand: {
    position: 'absolute',
    left: -20,
    right: -20,
    top: -10,
    bottom: -10,
    opacity: 0.62,
    transform: [{ rotate: '-1.2deg' }],
  },
  leftLensEdge: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 28,
  },
  rightLensEdge: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: 24,
  },
  lowerLensCompression: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 28,
    opacity: 0.35,
  },
});
