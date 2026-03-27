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

const AnimatedView = Animated.createAnimatedComponent(View);

export function ThinkingPulse() {
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withRepeat(
      withTiming(1, {
        duration: 1200,
        easing: Easing.inOut(Easing.ease),
      }),
      -1,
      false,
    );
  }, [progress]);

  const haloStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.5, 1], [0.28, 0.12, 0.28], Extrapolation.CLAMP),
    transform: [
      {
        scale: interpolate(progress.value, [0, 0.5, 1], [0.94, 1.1, 0.94], Extrapolation.CLAMP),
      },
    ],
  }));

  const firstDotStyle = useAnimatedStyle(() => {
    const shifted = progress.value % 1;

    return {
      opacity: interpolate(shifted, [0, 0.35, 0.7, 1], [0.35, 1, 0.45, 0.35], Extrapolation.CLAMP),
      transform: [
        {
          scale: interpolate(shifted, [0, 0.35, 0.7, 1], [0.8, 1.18, 0.9, 0.8], Extrapolation.CLAMP),
        },
        {
          translateY: interpolate(shifted, [0, 0.35, 0.7, 1], [1.5, -1.5, 0.5, 1.5], Extrapolation.CLAMP),
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
          scale: interpolate(shifted, [0, 0.35, 0.7, 1], [0.8, 1.18, 0.9, 0.8], Extrapolation.CLAMP),
        },
        {
          translateY: interpolate(shifted, [0, 0.35, 0.7, 1], [1.5, -1.5, 0.5, 1.5], Extrapolation.CLAMP),
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
          scale: interpolate(shifted, [0, 0.35, 0.7, 1], [0.8, 1.18, 0.9, 0.8], Extrapolation.CLAMP),
        },
        {
          translateY: interpolate(shifted, [0, 0.35, 0.7, 1], [1.5, -1.5, 0.5, 1.5], Extrapolation.CLAMP),
        },
      ],
    };
  });

  return (
    <View className="relative h-8 w-8 items-center justify-center">
      <AnimatedView
        className="absolute h-8 w-8 rounded-full bg-primary-500/10 dark:bg-primary-500/20"
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
