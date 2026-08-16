import React from 'react';
import { render } from '@testing-library/react-native';
import { View } from 'react-native';
import { TabBarMaterialBackground } from '../../../src/components/ui/TabBarMaterialBackground';

const mockEffectSurface = jest.fn(({ children, ...props }) => (
  <View {...props}>{children}</View>
));
const mockActiveTarget = { current: null };

jest.mock('../../../src/design-system/materials/EffectSurface', () => ({
  EffectSurface: (props: unknown) => mockEffectSurface(props),
}));

jest.mock('../../../src/utils/androidBlur', () => ({
  useActiveAndroidBlurTarget: () => mockActiveTarget,
}));

describe('TabBarMaterialBackground', () => {
  beforeEach(() => {
    mockEffectSurface.mockClear();
  });

  it('delegates tab chrome and the active external target to the material renderer', () => {
    const screen = render(<TabBarMaterialBackground />);

    expect(screen.getByTestId('tab-bar-material-background')).toBeTruthy();
    expect(mockEffectSurface).toHaveBeenCalledWith(expect.objectContaining({
      androidBlurTargetRef: mockActiveTarget,
      material: { role: 'chrome', variant: 'tabBar' },
      pointerEvents: 'none',
      shape: 'tabBar',
    }));
  });
});
