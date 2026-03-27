const React = require('react');
const { Text, View } = require('react-native');

const createAnimatedComponent = (Component) =>
  React.forwardRef(({ children, ...props }, ref) =>
    React.createElement(Component, { ...props, ref }, children)
  );

const interpolate = (value, inputRange, outputRange) => {
  if (!Array.isArray(inputRange) || !Array.isArray(outputRange) || inputRange.length === 0 || outputRange.length === 0) {
    return value;
  }

  if (value <= inputRange[0]) {
    return outputRange[0];
  }

  const lastIndex = inputRange.length - 1;
  if (value >= inputRange[lastIndex]) {
    return outputRange[lastIndex];
  }

  for (let index = 1; index < inputRange.length; index += 1) {
    if (value <= inputRange[index]) {
      const inputStart = inputRange[index - 1];
      const inputEnd = inputRange[index];
      const outputStart = outputRange[index - 1];
      const outputEnd = outputRange[index];
      const progress = (value - inputStart) / (inputEnd - inputStart);
      return outputStart + (outputEnd - outputStart) * progress;
    }
  }

  return outputRange[lastIndex];
};

const Animated = {
  View: createAnimatedComponent(View),
  Text: createAnimatedComponent(Text),
  createAnimatedComponent,
  call: () => {},
};

module.exports = {
  __esModule: true,
  default: Animated,
  createAnimatedComponent,
  useSharedValue: (initialValue) => ({ value: initialValue }),
  useAnimatedStyle: (updater) => updater(),
  withRepeat: (animation) => animation,
  withTiming: (toValue) => toValue,
  interpolate,
  Extrapolation: {
    CLAMP: 'clamp',
  },
  Easing: {
    ease: () => 0,
    inOut: (easing) => easing,
  },
};
