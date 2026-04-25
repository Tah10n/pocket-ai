import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import { StyleSheet } from 'react-native';
import { Box } from '@/components/ui/box';

interface GlassSpecularProps {
  tint: 'light' | 'dark';
}

export function GlassSpecular({ tint }: GlassSpecularProps) {
  const isDark = tint === 'dark';

  return (
    <Box pointerEvents="none" style={StyleSheet.absoluteFill}>
      <LinearGradient
        pointerEvents="none"
        colors={[isDark ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.38)', 'rgba(255,255,255,0)']}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={styles.topRim}
      />
      <LinearGradient
        pointerEvents="none"
        colors={[isDark ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.4)', 'rgba(255,255,255,0)']}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={styles.leftRim}
      />
    </Box>
  );
}

const styles = StyleSheet.create({
  topRim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 12,
  },
  leftRim: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: 1,
  },
});
