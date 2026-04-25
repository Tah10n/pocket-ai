import { BlurTargetView, BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import { Platform, StyleSheet, type View } from 'react-native';
import { Box } from '@/components/ui/box';
import { useTheme } from '../../providers/ThemeProvider';
import type { ThemeAppearance } from '../../utils/themeTokens';
import { GlassSpecular } from './GlassSpecular';

function joinClassNames(...values: (string | undefined | false)[]) {
  return values.filter(Boolean).join(' ');
}

function getAndroidSdkVersion() {
  if (Platform.OS !== 'android') {
    return undefined;
  }

  const version = Platform.Version;
  const parsedVersion = typeof version === 'string'
    ? Number.parseInt(version, 10)
    : version;

  return Number.isFinite(parsedVersion) ? parsedVersion : undefined;
}

function isAndroidBlurFallbackRequired() {
  const sdkVersion = getAndroidSdkVersion();

  return Platform.OS === 'android' && (sdkVersion === undefined || sdkVersion < 31);
}

function getAndroidBlurProps(
  appearance: ThemeAppearance,
  blurTarget?: React.RefObject<View | null>,
) {
  if (Platform.OS !== 'android' || isAndroidBlurFallbackRequired() || !blurTarget) {
    return {};
  }

  return {
    blurMethod: 'dimezisBlurViewSdk31Plus' as const,
    blurReductionFactor: appearance.effects.blurReductionFactor,
    blurTarget,
  };
}

export function TabBarGlassBackground() {
  const { appearance, colors } = useTheme();
  const tabBarBlurTargetRef = React.useRef<View | null>(null);

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

  return (
    <Box
      pointerEvents="none"
      className={joinClassNames(
        'overflow-hidden',
        appearance.classNames.bottomBarClassName,
        shouldFallback ? 'bg-background-0/82 dark:bg-background-950/72' : undefined,
      )}
      style={StyleSheet.absoluteFill}
    >
      {shouldUseAndroidBlurTarget ? (
        <BlurTargetView
          testID="tab-bar-glass-blur-target"
          ref={tabBarBlurTargetRef}
          pointerEvents="none"
          style={StyleSheet.absoluteFill}
        >
          <Box pointerEvents="none" className="absolute inset-0 bg-background-0/55 dark:bg-background-950/48" />
          <Box pointerEvents="none" className="absolute -left-16 -top-24 h-48 w-48 rounded-full bg-primary-500/35 dark:bg-primary-400/22" />
          <Box pointerEvents="none" className="absolute -right-12 -top-20 h-44 w-44 rounded-full bg-info-500/28 dark:bg-info-400/18" />
        </BlurTargetView>
      ) : null}
      {shouldFallback ? (
        <Box pointerEvents="none" className="absolute inset-0 bg-background-0/82 dark:bg-background-950/72" />
      ) : (
        <BlurView
          pointerEvents="none"
          intensity={appearance.effects.surfaceBlurIntensity}
          tint={colors.headerBlurTint}
          {...getAndroidBlurProps(appearance, shouldUseAndroidBlurTarget ? tabBarBlurTargetRef : undefined)}
          style={StyleSheet.absoluteFill}
        />
      )}
      {!shouldFallback ? <Box pointerEvents="none" className="absolute inset-0 bg-background-0/10 dark:bg-background-950/10" /> : null}
      <GlassSpecular tint={colors.headerBlurTint} />
      <LinearGradient
        pointerEvents="none"
        colors={[
          colors.headerBlurTint === 'dark' ? 'rgba(0,0,0,0)' : 'rgba(255,255,255,0)',
          colors.headerBlurTint === 'dark' ? 'rgba(0,0,0,0.18)' : 'rgba(255,255,255,0.16)',
        ]}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={styles.bottomScrim}
      />
    </Box>
  );
}

const styles = StyleSheet.create({
  bottomScrim: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 24,
  },
});
