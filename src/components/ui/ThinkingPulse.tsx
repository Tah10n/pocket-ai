import React, { useEffect } from 'react';
import { View } from 'react-native';
import Animated, {
  Easing,
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useMotionPreferences } from '../../hooks/useDeviceMetrics';
import { useScreenAppearance } from './ScreenShell';

const AnimatedView = Animated.createAnimatedComponent(View);

export function ThinkingPulse() {
  const motion = useMotionPreferences();
  const appearance = useScreenAppearance();
  const progress = useSharedValue(0);
  const haloClassName = `absolute h-8 w-8 rounded-full ${appearance.classNames.toneClassNameByTone.accent.iconTileClassName}`;

  useEffect(() => {
    if (motion.motionPreset === 'minimal') {
      progress.value = 0;
      return;
    }

    progress.value = withRepeat(
      withTiming(1, {
        duration: motion.motionPreset === 'full' ? 1200 : 900,
        easing: Easing.inOut(Easing.ease),
      }),
      -1,
      false,
    );
  }, [motion.motionPreset, progress]);

  const haloStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.5, 1], motion.motionPreset === 'full' ? [0.28, 0.12, 0.28] : [0.18, 0.12, 0.18], Extrapolation.CLAMP),
    transform: [
      {
        scale: interpolate(progress.value, [0, 0.5, 1], motion.motionPreset === 'full' ? [0.94, 1.1, 0.94] : [0.98, 1.03, 0.98], Extrapolation.CLAMP),
      },
    ],
  }));

  const firstDotStyle = useAnimatedStyle(() => {
    const shifted = progress.value % 1;

    return {
      opacity: interpolate(shifted, [0, 0.35, 0.7, 1], [0.35, 1, 0.45, 0.35], Extrapolation.CLAMP),
      transform: [
        {
          scale: interpolate(shifted, [0, 0.35, 0.7, 1], motion.motionPreset === 'full' ? [0.8, 1.18, 0.9, 0.8] : [0.92, 1.05, 0.95, 0.92], Extrapolation.CLAMP),
        },
        {
          translateY: interpolate(shifted, [0, 0.35, 0.7, 1], motion.motionPreset === 'full' ? [1.5, -1.5, 0.5, 1.5] : [0.5, -0.75, 0.25, 0.5], Extrapolation.CLAMP),
        },
      ],
    };
  });

  const secondDotStyle = useAnimatedStyle(() => {
    const shifted = (progress.value + 0.2) % 1;

    return {
      opacity: interpolate(shifted, [0, 0.35, 0.7, 1], [0.35, 1, 0.45, 0.35], Extrapolation.CLAMP),
      transform: [
        {
          scale: interpolate(shifted, [0, 0.35, 0.7, 1], motion.motionPreset === 'full' ? [0.8, 1.18, 0.9, 0.8] : [0.92, 1.05, 0.95, 0.92], Extrapolation.CLAMP),
        },
        {
          translateY: interpolate(shifted, [0, 0.35, 0.7, 1], motion.motionPreset === 'full' ? [1.5, -1.5, 0.5, 1.5] : [0.5, -0.75, 0.25, 0.5], Extrapolation.CLAMP),
        },
      ],
    };
  });

  const thirdDotStyle = useAnimatedStyle(() => {
    const shifted = (progress.value + 0.4) % 1;

    return {
      opacity: interpolate(shifted, [0, 0.35, 0.7, 1], [0.35, 1, 0.45, 0.35], Extrapolation.CLAMP),
      transform: [
        {
          scale: interpolate(shifted, [0, 0.35, 0.7, 1], motion.motionPreset === 'full' ? [0.8, 1.18, 0.9, 0.8] : [0.92, 1.05, 0.95, 0.92], Extrapolation.CLAMP),
        },
        {
          translateY: interpolate(shifted, [0, 0.35, 0.7, 1], motion.motionPreset === 'full' ? [1.5, -1.5, 0.5, 1.5] : [0.5, -0.75, 0.25, 0.5], Extrapolation.CLAMP),
        },
      ],
    };
  });

  if (motion.motionPreset === 'minimal') {
    return (
      <View className="relative h-8 w-8 items-center justify-center">
        <View className={haloClassName} />
        <View className="flex-row items-center justify-center gap-1">
          <View className="h-1.5 w-1.5 rounded-full bg-primary-500" />
          <View className="h-1.5 w-1.5 rounded-full bg-primary-500 opacity-80" />
          <View className="h-1.5 w-1.5 rounded-full bg-primary-500 opacity-60" />
        </View>
      </View>
    );
  }

  return (
    <View className="relative h-8 w-8 items-center justify-center">
      <AnimatedView
        className={haloClassName}
        style={haloStyle}
      />

      <View className="flex-row items-center justify-center gap-1">
        <AnimatedView className="h-1.5 w-1.5 rounded-full bg-primary-500" style={firstDotStyle} />
        <AnimatedView className="h-1.5 w-1.5 rounded-full bg-primary-500" style={secondDotStyle} />
        <AnimatedView className="h-1.5 w-1.5 rounded-full bg-primary-500" style={thirdDotStyle} />
      </View>
    </View>
  );
}
