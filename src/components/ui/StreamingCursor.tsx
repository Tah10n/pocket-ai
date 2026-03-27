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
}: {
  compact?: boolean;
}) => {
  const opacity = useSharedValue(1);

  useEffect(() => {
    opacity.value = withRepeat(
      withTiming(0, { duration: 500, easing: Easing.inOut(Easing.ease) }),
      -1, // infinite repeat
      true  // reverse each cycle
    );
  }, [opacity]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  return (
    <AnimatedText
      className={compact
        ? 'text-xs leading-4 text-typography-400 opacity-60 dark:text-typography-500'
        : 'text-sm leading-6 text-typography-500 opacity-70 dark:text-typography-400'}
      style={animatedStyle}
    >
      ▏
    </AnimatedText>
  );
};
