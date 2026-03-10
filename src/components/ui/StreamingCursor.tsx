import React, { useEffect } from 'react';
import { Text } from 'react-native';
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
export const StreamingCursor = () => {
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
    <Animated.Text
      style={[
        {
          fontSize: 15,
          lineHeight: 22,
          color: '#3211d4',
        },
        animatedStyle,
      ]}
    >
      ▋
    </Animated.Text>
  );
};
