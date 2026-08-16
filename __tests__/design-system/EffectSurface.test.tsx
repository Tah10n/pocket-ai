import React from 'react';
import { render } from '@testing-library/react-native';
import { StyleSheet, View } from 'react-native';
import {
  AndroidBlurBoundaryProvider,
  AndroidBlurSampleTargetProvider,
  type AndroidBlurBoundary,
  type AndroidBlurSampleTarget,
} from '../../src/design-system/materials/AndroidBlurTargetContext';
import { EffectSurface } from '../../src/design-system/materials/EffectSurface';
import { MaterialEnvironmentProvider } from '../../src/design-system/materials/MaterialEnvironmentProvider';
import { createMaterialEnvironment } from '../../src/design-system/materials/environment';
import { resolveTheme } from '../../src/design-system/themes/resolver';

let mockResolvedTheme = resolveTheme('glass', 'light');

jest.mock('@/components/ui/box', () => {
  const mockReact = jest.requireActual('react');
  const { View: MockView } = jest.requireActual('react-native');

  return {
    Box: ({ children, ...props }: any) => mockReact.createElement(MockView, props, children),
  };
});

jest.mock('expo-blur', () => {
  const mockReact = jest.requireActual('react');
  const { View: MockView } = jest.requireActual('react-native');

  return {
    BlurView: ({ children, ...props }: any) => mockReact.createElement(MockView, props, children),
  };
});

jest.mock('../../src/providers/ThemeProvider', () => ({
  useTheme: () => ({ resolvedTheme: mockResolvedTheme }),
}));

function createTarget(ownerId: symbol): {
  readonly boundary: AndroidBlurBoundary;
  readonly sample: AndroidBlurSampleTarget;
} {
  const targetRef = { current: null };

  return {
    boundary: { id: ownerId, targetRef },
    sample: { ownerId, ready: true, targetRef },
  };
}

describe('EffectSurface', () => {
  beforeEach(() => {
    mockResolvedTheme = resolveTheme('glass', 'light');
  });

  it('fails closed to a dense recipe before runtime capabilities are known', () => {
    const screen = render(
      <EffectSurface
        testID="unknown-effect-surface"
        material={{ role: 'chrome', variant: 'header' }}
      />,
    );
    const surface = screen.getByTestId('unknown-effect-surface');

    expect(StyleSheet.flatten(surface.props.style)).toMatchObject({
      backgroundColor: mockResolvedTheme.colors.surfaceOverlay,
      borderWidth: 1,
    });
    expect(screen.UNSAFE_getAllByType(View).some((node: any) => (
      Object.prototype.hasOwnProperty.call(node.props, 'intensity')
    ))).toBe(false);
  });

  it('uses legacy iOS BlurView while the native Liquid Glass renderer is unavailable', () => {
    const environment = createMaterialEnvironment('ios', {
      blurViewAvailable: true,
      liquidGlassApiAvailable: true,
      liquidGlassComponentAvailable: true,
      transparencyState: 'allowed',
    });
    const screen = render(
      <MaterialEnvironmentProvider environment={environment}>
        <EffectSurface material={{ role: 'chrome', variant: 'header' }} />
      </MaterialEnvironmentProvider>,
    );
    const blurLayer = screen.UNSAFE_getAllByType(View).find((node: any) => (
      Object.prototype.hasOwnProperty.call(node.props, 'intensity')
    ));

    expect(blurLayer).toBeTruthy();
    expect(blurLayer?.props.blurMethod).toBeUndefined();
    expect(blurLayer?.props.blurTarget).toBeUndefined();
  });

  it('uses an external Android sample target on SDK 31+', () => {
    const target = createTarget(Symbol('background'));
    const sceneBoundary = createTarget(Symbol('scene')).boundary;
    const environment = createMaterialEnvironment('android', {
      androidSdkVersion: 34,
      androidTargetBlurSupported: true,
      blurViewAvailable: true,
      transparencyState: 'allowed',
    });
    const screen = render(
      <MaterialEnvironmentProvider environment={environment}>
        <AndroidBlurSampleTargetProvider target={target.sample}>
          <AndroidBlurBoundaryProvider boundary={sceneBoundary}>
            <EffectSurface material={{ role: 'chrome', variant: 'header' }} />
          </AndroidBlurBoundaryProvider>
        </AndroidBlurSampleTargetProvider>
      </MaterialEnvironmentProvider>,
    );
    const blurLayer = screen.UNSAFE_getAllByType(View).find((node: any) => (
      node.props.blurMethod === 'dimezisBlurViewSdk31Plus'
    ));

    expect(blurLayer?.props.blurTarget).toBe(target.sample.targetRef);
    expect(blurLayer?.props.blurReductionFactor).toBeGreaterThan(1);
  });

  it('uses a ready explicit Android target for sibling composer chrome', () => {
    const explicitTargetRef = { current: {} } as React.RefObject<View | null>;
    const environment = createMaterialEnvironment('android', {
      androidSdkVersion: 34,
      androidTargetBlurSupported: true,
      blurViewAvailable: true,
      transparencyState: 'allowed',
    });
    const screen = render(
      <MaterialEnvironmentProvider environment={environment}>
        <EffectSurface
          androidBlurTargetRef={explicitTargetRef}
          material={{ role: 'chrome', variant: 'composer' }}
        />
      </MaterialEnvironmentProvider>,
    );
    const blurLayer = screen.UNSAFE_getAllByType(View).find((node: any) => (
      node.props.blurMethod === 'dimezisBlurViewSdk31Plus'
    ));

    expect(blurLayer?.props.blurTarget).toBe(explicitTargetRef);
  });

  it('fails closed while an Android sample target is pending', () => {
    const target = createTarget(Symbol('pending'));
    const environment = createMaterialEnvironment('android', {
      androidSdkVersion: 34,
      androidTargetBlurSupported: true,
      blurViewAvailable: true,
      transparencyState: 'allowed',
    });
    const screen = render(
      <MaterialEnvironmentProvider environment={environment}>
        <AndroidBlurSampleTargetProvider target={{ ...target.sample, ready: false }}>
          <EffectSurface material={{ role: 'chrome', variant: 'header' }} />
        </AndroidBlurSampleTargetProvider>
      </MaterialEnvironmentProvider>,
    );

    expect(screen.UNSAFE_getAllByType(View).some((node: any) => (
      Object.prototype.hasOwnProperty.call(node.props, 'intensity')
    ))).toBe(false);
  });

  it('fails closed when the Android sample target owns an ancestor boundary', () => {
    const ownedTarget = createTarget(Symbol('content'));
    const environment = createMaterialEnvironment('android', {
      androidSdkVersion: 34,
      androidTargetBlurSupported: true,
      blurViewAvailable: true,
      transparencyState: 'allowed',
    });
    const screen = render(
      <MaterialEnvironmentProvider environment={environment}>
        <AndroidBlurSampleTargetProvider target={ownedTarget.sample}>
          <AndroidBlurBoundaryProvider boundary={ownedTarget.boundary}>
            <EffectSurface material={{ role: 'chrome', variant: 'header' }} />
          </AndroidBlurBoundaryProvider>
        </AndroidBlurSampleTargetProvider>
      </MaterialEnvironmentProvider>,
    );

    expect(screen.UNSAFE_getAllByType(View).some((node: any) => (
      Object.prototype.hasOwnProperty.call(node.props, 'intensity')
    ))).toBe(false);
  });
});
