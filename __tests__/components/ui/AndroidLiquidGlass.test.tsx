import React from 'react';
import { Platform, processColor, Text, View } from 'react-native';
import { render } from '@testing-library/react-native';
import {
  __setAndroidLiquidGlassNativeViewsForTests,
  AndroidLiquidGlassBackdropProvider,
  AndroidLiquidGlassSurface,
} from '../../../src/design-system/materials/AndroidLiquidGlass';

const MockNativeView: React.ComponentType<any> = (props) => (
  <View {...props} />
);

function mockAndroid(apiLevel: number) {
  const os = Object.getOwnPropertyDescriptor(Platform, 'OS');
  const version = Object.getOwnPropertyDescriptor(Platform, 'Version');
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
  Object.defineProperty(Platform, 'Version', { configurable: true, value: apiLevel });
  return () => {
    if (os) Object.defineProperty(Platform, 'OS', os);
    if (version) Object.defineProperty(Platform, 'Version', version);
  };
}

describe('AndroidLiquidGlass native hosts', () => {
  afterEach(() => {
    __setAndroidLiquidGlassNativeViewsForTests(undefined, undefined);
  });

  it('passes flattened per-corner geometry and dark parameters to API 33 native chrome', () => {
    const restore = mockAndroid(33);
    __setAndroidLiquidGlassNativeViewsForTests(MockNativeView, MockNativeView);
    try {
      const { getByTestId } = render(
        <AndroidLiquidGlassSurface
          testID="native-glass"
          cornerRadius={0}
          cornerRadiusTopLeft={32}
          cornerRadiusTopRight={32}
          cornerRadiusBottomRight={0}
          cornerRadiusBottomLeft={0}
          dark
          tintColor="#2563eb"
          tintOpacity={0.34}
        >
          <Text>Sheet</Text>
        </AndroidLiquidGlassSurface>,
      );
      expect(getByTestId('native-glass').props).toMatchObject({
        cornerRadiusTopLeft: 32,
        cornerRadiusTopRight: 32,
        cornerRadiusBottomRight: 0,
        cornerRadiusBottomLeft: 0,
        dark: true,
        tintColor: processColor('#2563eb'),
        tintOpacity: 0.34,
        effectsEnabled: true,
        interactive: false,
      });
    } finally {
      restore();
    }
  });

  it('uses the native recording boundary only on API 33+', () => {
    const restore = mockAndroid(33);
    __setAndroidLiquidGlassNativeViewsForTests(MockNativeView, MockNativeView);
    try {
      const { getByTestId } = render(
        <AndroidLiquidGlassBackdropProvider testID="provider" active collapsable={false}>
          <Text>Scene</Text>
        </AndroidLiquidGlassBackdropProvider>,
      );
      expect(getByTestId('provider').props.active).toBe(true);
      expect(getByTestId('provider').props.collapsable).toBe(false);
    } finally {
      restore();
    }
  });

  it('keeps children visible through the dense host fallback below API 33', () => {
    const restore = mockAndroid(32);
    __setAndroidLiquidGlassNativeViewsForTests(MockNativeView, MockNativeView);
    try {
      const { getByText } = render(
        <AndroidLiquidGlassSurface cornerRadius={24} dark={false}>
          <Text>Fallback content</Text>
        </AndroidLiquidGlassSurface>,
      );
      expect(getByText('Fallback content')).toBeTruthy();
    } finally {
      restore();
    }
  });
});
