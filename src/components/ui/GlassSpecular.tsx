import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import { Platform, StyleSheet } from 'react-native';
import { Box } from '@/components/ui/box';

interface GlassSpecularProps {
  tint: 'light' | 'dark';
}

type SpecularGradientColors = readonly [string, string, ...string[]];

export function GlassSpecular({ tint }: GlassSpecularProps) {
  const isDark = tint === 'dark';

  if (Platform.OS === 'android') {
    return null;
  }

  const topRimColors: SpecularGradientColors = isDark
    ? ['rgba(125,211,252,0)', 'rgba(125,211,252,0.24)', 'rgba(96,165,250,0.1)', 'rgba(6,11,20,0)']
    : ['rgba(255,255,255,0)', 'rgba(255,255,255,0.42)', 'rgba(255,255,255,0.16)', 'rgba(255,255,255,0)'];
  const leftRimColors: SpecularGradientColors = isDark
    ? ['rgba(96,165,250,0)', 'rgba(125,211,252,0.2)', 'rgba(96,165,250,0.08)', 'rgba(6,11,20,0)']
    : ['rgba(255,255,255,0)', 'rgba(255,255,255,0.38)', 'rgba(255,255,255,0.14)', 'rgba(255,255,255,0)'];
  const cornerSheenColors: SpecularGradientColors = isDark
    ? ['rgba(56,189,248,0)', 'rgba(56,189,248,0.16)', 'rgba(37,99,235,0.07)', 'rgba(6,11,20,0)']
    : ['rgba(255,255,255,0)', 'rgba(255,255,255,0.3)', 'rgba(255,255,255,0.11)', 'rgba(255,255,255,0)'];
  const rightRimColors: SpecularGradientColors = isDark
    ? ['rgba(6,11,20,0)', 'rgba(96,165,250,0.14)', 'rgba(6,11,20,0)']
    : ['rgba(255,255,255,0)', 'rgba(255,255,255,0.32)', 'rgba(255,255,255,0)'];
  const bottomRimColors: SpecularGradientColors = isDark
    ? ['rgba(6,11,20,0)', 'rgba(52,211,153,0.11)', 'rgba(6,11,20,0)']
    : ['rgba(255,255,255,0)', 'rgba(255,255,255,0.28)', 'rgba(255,255,255,0)'];

  return (
    <Box pointerEvents="none" style={StyleSheet.absoluteFill}>
      <LinearGradient
        pointerEvents="none"
        colors={topRimColors}
        locations={[0, 0.2, 0.58, 1]}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={styles.topRim}
      />
      <LinearGradient
        pointerEvents="none"
        colors={leftRimColors}
        locations={[0, 0.24, 0.62, 1]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={styles.leftRim}
      />
      <LinearGradient
        pointerEvents="none"
        colors={cornerSheenColors}
        locations={[0, 0.26, 0.66, 1]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.cornerSheen}
      />
      <LinearGradient
        pointerEvents="none"
        colors={rightRimColors}
        locations={[0, 0.52, 1]}
        start={{ x: 1, y: 0 }}
        end={{ x: 0, y: 0 }}
        style={styles.rightRim}
      />
      <LinearGradient
        pointerEvents="none"
        colors={bottomRimColors}
        locations={[0, 0.54, 1]}
        start={{ x: 0, y: 1 }}
        end={{ x: 0, y: 0 }}
        style={styles.bottomRim}
      />
    </Box>
  );
}

const styles = StyleSheet.create({
  topRim: {
    position: 'absolute',
    top: 0,
    left: -8,
    right: -8,
    height: 46,
  },
  leftRim: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: 36,
  },
  cornerSheen: {
    position: 'absolute',
    top: -14,
    left: -28,
    right: -28,
    height: 112,
  },
  rightRim: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 0,
    width: 24,
  },
  bottomRim: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 22,
  },
});
