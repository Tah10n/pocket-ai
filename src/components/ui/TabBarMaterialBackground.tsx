import React from 'react';
import { StyleSheet } from 'react-native';
import { EffectSurface } from '../../design-system/materials/EffectSurface';
import { useActiveAndroidBlurTarget } from '../../utils/androidBlur';

const TAB_BAR_MATERIAL = { role: 'chrome', variant: 'tabBar' } as const;

export function TabBarMaterialBackground() {
  const activeAndroidBlurTarget = useActiveAndroidBlurTarget();

  return (
    <EffectSurface
      testID="tab-bar-material-background"
      pointerEvents="none"
      androidBlurTargetRef={activeAndroidBlurTarget}
      material={TAB_BAR_MATERIAL}
      shape="tabBar"
      style={StyleSheet.absoluteFill}
    />
  );
}
