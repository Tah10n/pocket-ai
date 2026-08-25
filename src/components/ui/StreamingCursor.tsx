import React, { useEffect } from 'react';
import { Text } from '@/components/ui/text';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  Easing,
} from 'react-native-reanimated';

/**
 * Smooth blinking cursor appended to streaming AI text.
 * Uses react-native-reanimated for performant 60fps animation.
 */
const AnimatedText = Animated.createAnimatedComponent(Text);

export const StreamingCursor = ({
  compact = false,
  reduceMotion = false,
}: {
  compact?: boolean;
  reduceMotion?: boolean;
}) => {
  const opacity = useSharedValue(1);

  useEffect(() => {
    if (reduceMotion) {
      opacity.value = 1;
      return;
    }

    opacity.value = withRepeat(
      withTiming(0, { duration: 500, easing: Easing.inOut(Easing.ease) }),
      -1, // infinite repeat
      true  // reverse each cycle
    );
  }, [opacity, reduceMotion]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  return (
    <AnimatedText
      colorRole="tertiary"
      accessible={false}
      importantForAccessibility="no"
      className={compact
        ? 'text-xs leading-4 opacity-60'
        : 'text-sm leading-6 opacity-70'}
      style={animatedStyle}
    >
      ▏
    </AnimatedText>
  );
};
