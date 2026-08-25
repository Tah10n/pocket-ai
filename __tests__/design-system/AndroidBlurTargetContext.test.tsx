import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { Text, View } from 'react-native';
import {
  AndroidBlurBoundaryProvider,
  AndroidBlurSampleTargetProvider,
  useAndroidBlurTargetHandle,
  useResolvedAndroidBlurTarget,
  type AndroidBlurBoundary,
  type AndroidBlurSampleTarget,
} from '../../src/design-system/materials/AndroidBlurTargetContext';
import type { AndroidBlurTargetRef } from '../../src/utils/androidBlur';

function TargetProbe({ explicitTarget }: { explicitTarget?: AndroidBlurTargetRef | null }) {
  const resolvedTarget = useResolvedAndroidBlurTarget(explicitTarget);

  return <Text testID="resolved-target">{resolvedTarget ? 'usable' : 'blocked'}</Text>;
}

function createTarget(ownerId: symbol): {
  readonly boundary: AndroidBlurBoundary;
  readonly sample: AndroidBlurSampleTarget;
} {
  const targetRef: AndroidBlurTargetRef = { current: null };

  return {
    boundary: { id: ownerId, targetRef },
    sample: { ownerId, ready: true, targetRef },
  };
}

describe('Android blur target ownership', () => {
  it('allows a sibling sample target outside the current ancestor chain', () => {
    const sample = createTarget(Symbol('background')).sample;
    const scene = createTarget(Symbol('scene')).boundary;
    const screen = render(
      <AndroidBlurSampleTargetProvider target={sample}>
        <AndroidBlurBoundaryProvider boundary={scene}>
          <TargetProbe />
        </AndroidBlurBoundaryProvider>
      </AndroidBlurSampleTargetProvider>,
    );

    expect(screen.getByTestId('resolved-target').props.children).toBe('usable');
  });

  it('blocks a sample target that owns the current ancestor boundary', () => {
    const ownedTarget = createTarget(Symbol('content'));
    const screen = render(
      <AndroidBlurSampleTargetProvider target={ownedTarget.sample}>
        <AndroidBlurBoundaryProvider boundary={ownedTarget.boundary}>
          <TargetProbe />
        </AndroidBlurBoundaryProvider>
      </AndroidBlurSampleTargetProvider>,
    );

    expect(screen.getByTestId('resolved-target').props.children).toBe('blocked');
  });

  it('blocks an explicitly requested target when any ancestor owns its ref', () => {
    const outerTarget = createTarget(Symbol('outer'));
    const innerTarget = createTarget(Symbol('inner'));
    const screen = render(
      <AndroidBlurSampleTargetProvider target={innerTarget.sample}>
        <AndroidBlurBoundaryProvider boundary={outerTarget.boundary}>
          <AndroidBlurBoundaryProvider boundary={innerTarget.boundary}>
            <TargetProbe explicitTarget={outerTarget.sample.targetRef} />
          </AndroidBlurBoundaryProvider>
        </AndroidBlurBoundaryProvider>
      </AndroidBlurSampleTargetProvider>,
    );

    expect(screen.getByTestId('resolved-target').props.children).toBe('blocked');
  });

  it('publishes reactive pending, ready, and detached states for managed targets', () => {
    function ManagedTarget({ active }: { readonly active: boolean }) {
      const targetRef = React.useRef<View | null>(null);
      const target = useAndroidBlurTargetHandle(targetRef, 'managed-test-target', active);

      return (
        <AndroidBlurSampleTargetProvider target={target.sample}>
          <View testID="managed-target" onLayout={target.markReady} />
          <TargetProbe />
        </AndroidBlurSampleTargetProvider>
      );
    }

    const screen = render(<ManagedTarget active />);
    expect(screen.getByTestId('resolved-target').props.children).toBe('blocked');

    fireEvent(screen.getByTestId('managed-target'), 'layout', {
      nativeEvent: { layout: { height: 10, width: 10, x: 0, y: 0 } },
    });
    expect(screen.getByTestId('resolved-target').props.children).toBe('usable');

    screen.rerender(<ManagedTarget active={false} />);
    expect(screen.getByTestId('resolved-target').props.children).toBe('blocked');
  });

  it('notifies an explicit sibling consumer when its managed target becomes ready', () => {
    function ExplicitManagedTarget() {
      const targetRef = React.useRef<View | null>(null);
      const target = useAndroidBlurTargetHandle(targetRef, 'explicit-managed-target', true);

      return (
        <>
          <View testID="explicit-managed-target" onLayout={target.markReady} />
          <TargetProbe explicitTarget={targetRef} />
        </>
      );
    }

    const screen = render(<ExplicitManagedTarget />);
    expect(screen.getByTestId('resolved-target').props.children).toBe('blocked');

    fireEvent(screen.getByTestId('explicit-managed-target'), 'layout', {
      nativeEvent: { layout: { height: 10, width: 10, x: 0, y: 0 } },
    });
    expect(screen.getByTestId('resolved-target').props.children).toBe('usable');
  });
});
