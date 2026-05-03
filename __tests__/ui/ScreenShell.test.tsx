import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';

const mockMaterialSymbols = jest.fn(({ name }: any) => {
  const mockReact = require('react');
  const { Text } = require('react-native');
  return mockReact.createElement(Text, null, name);
});

let mockSafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };
let mockThemeContext: any = {
  colors: { background: '#fff', headerBlurTint: 'light' },
  resolvedMode: 'light',
  themeId: 'default',
};

jest.mock('react-native-css-interop', () => {
  const mockReact = require('react');
  return {
    createInteropElement: mockReact.createElement,
  };
});

jest.mock('@/components/ui/box', () => {
  const mockReact = require('react');
  const { View } = require('react-native');
  return {
    Box: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
  };
});

jest.mock('@/components/ui/input', () => {
  const mockReact = require('react');
  const { TextInput, View } = require('react-native');
  return {
    Input: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
    InputField: (props: any) => mockReact.createElement(TextInput, props),
  };
});

jest.mock('@/components/ui/pressable', () => {
  const mockReact = require('react');
  const { Pressable } = require('react-native');
  return {
    Pressable: ({ children, ...props }: any) => mockReact.createElement(Pressable, props, children),
  };
});

jest.mock('@/components/ui/text', () => {
  const mockReact = require('react');
  const { Text } = require('react-native');
  return {
    Text: ({ children, ...props }: any) => mockReact.createElement(Text, props, children),
    composeTextRole: (_role: string, className = '') => className,
  };
});

jest.mock('../../src/components/ui/MaterialSymbols', () => ({
  MaterialSymbols: (props: any) => mockMaterialSymbols(props),
}));

jest.mock('../../src/providers/ThemeProvider', () => ({
  useTheme: () => mockThemeContext,
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => mockSafeAreaInsets,
}));

jest.mock('expo-blur', () => {
  const mockReact = require('react');
  const { View } = require('react-native');
  return {
    BlurTargetView: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
    BlurView: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
  };
});

jest.mock('expo-linear-gradient', () => {
  const mockReact = require('react');
  const { View } = require('react-native');
  return {
    LinearGradient: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
  };
});

const {
  getGlassCornerRadiusStyle,
  ScreenActionPill,
  ScreenCard,
  ScreenChip,
  ScreenContent,
  ScreenHeaderShell,
  ScreenIconButton,
  ScreenIconTile,
  ScreenInlineInput,
  ScreenPressableCard,
  ScreenRoot,
  ScreenSegmentedControl,
  ScreenSheet,
  useFloatingHeaderInset,
} = require('../../src/components/ui/ScreenShell');

function FloatingHeaderInsetProbe() {
  const { Text } = require('react-native');
  return <Text testID="floating-header-inset">{useFloatingHeaderInset()}</Text>;
}

function getGradientSignature(nodes: any[]) {
  const { StyleSheet } = require('react-native');

  return nodes
    .filter((node: any) => Array.isArray(node.props.colors))
    .map((node: any) => ({
      alphaStops: node.props.colors.map((color: string) => color.match(/rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/)?.[1]),
      colors: node.props.colors,
      end: node.props.end,
      locations: node.props.locations,
      start: node.props.start,
      style: StyleSheet.flatten(node.props.style),
    }));
}

function expectMatchingGradientGeometry(darkLayer: any, lightLayer: any) {
  expect(darkLayer).toMatchObject({
    end: lightLayer.end,
    locations: lightLayer.locations,
    start: lightLayer.start,
    style: lightLayer.style,
  });
}

function expectDarkAlphaStopsNoBrighter(darkLayer: any, lightLayer: any) {
  for (let stopIndex = 0; stopIndex < lightLayer.alphaStops.length; stopIndex += 1) {
    const lightAlpha = Number(lightLayer.alphaStops[stopIndex]);
    const darkAlpha = Number(darkLayer.alphaStops[stopIndex]);

    if (Number.isNaN(lightAlpha) || Number.isNaN(darkAlpha)) {
      expect(darkLayer.alphaStops[stopIndex]).toBe(lightLayer.alphaStops[stopIndex]);
      continue;
    }

    expect(darkAlpha).toBeLessThanOrEqual(lightAlpha);
  }
}

describe('ScreenShell', () => {
  beforeEach(() => {
    mockMaterialSymbols.mockClear();
    mockSafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };
    mockThemeContext = {
      colors: { background: '#fff', headerBlurTint: 'light' },
      resolvedMode: 'light',
      themeId: 'default',
    };
  });

  it('applies the runtime theme background through ScreenRoot', () => {
    const { getByTestId } = render(
      <ScreenRoot testID="screen-root">content</ScreenRoot>,
    );

    expect(getByTestId('screen-root').props.className).toContain('flex-1');
    expect(getByTestId('screen-root').props.style).toEqual(expect.arrayContaining([
      expect.objectContaining({ backgroundColor: '#fff' }),
    ]));
  });

  it('renders glass root accents as smooth gradient layers', () => {
    const { getThemeAppearance } = require('../../src/utils/themeTokens');
    mockThemeContext = {
      colors: { background: '#fff', headerBlurTint: 'light' },
      resolvedMode: 'light',
      themeId: 'glass',
      appearance: getThemeAppearance('glass', 'light'),
    };

    const { UNSAFE_getAllByType } = render(
      <ScreenRoot testID="screen-root">content</ScreenRoot>,
    );

    const { View } = require('react-native');
    const views = UNSAFE_getAllByType(View);
    const gradientLayers = views.filter((node: any) => Array.isArray(node.props.colors));
    const hardCircleAccents = views.filter((node: any) =>
      typeof node.props.className === 'string'
      && node.props.className.includes('rounded-full')
      && node.props.className.includes('bg-primary-500/40'),
    );
    const hardHairlineAccents = views.filter((node: any) =>
      typeof node.props.className === 'string'
      && node.props.className.includes('h-px'),
    );
    const hardBottomStrips = views.filter((node: any) =>
      typeof node.props.className === 'string'
      && node.props.className.includes('bottom-0')
      && node.props.className.includes('h-48')
      && node.props.className.includes('bg-background'),
    );

    expect(gradientLayers.length).toBeGreaterThanOrEqual(4);
    expect(hardCircleAccents).toHaveLength(0);
    expect(hardHairlineAccents).toHaveLength(0);
    expect(hardBottomStrips).toHaveLength(0);
  });

  it('keeps dark glass root accents on the same geometry with dimmer opacity than light', () => {
    const { View } = require('react-native');
    const { getThemeAppearance, getThemeColors } = require('../../src/utils/themeTokens');
    mockThemeContext = {
      colors: getThemeColors('light', 'glass'),
      resolvedMode: 'light',
      themeId: 'glass',
      appearance: getThemeAppearance('glass', 'light'),
    };
    const lightRender = render(<ScreenRoot testID="screen-root">content</ScreenRoot>);
    const lightSignature = getGradientSignature(lightRender.UNSAFE_getAllByType(View));
    lightRender.unmount();

    mockThemeContext = {
      colors: getThemeColors('dark', 'glass'),
      resolvedMode: 'dark',
      themeId: 'glass',
      appearance: getThemeAppearance('glass', 'dark'),
    };
    const darkRender = render(<ScreenRoot testID="screen-root">content</ScreenRoot>);
    const darkSignature = getGradientSignature(darkRender.UNSAFE_getAllByType(View));

    expect(darkSignature).toHaveLength(lightSignature.length);
    for (let index = 0; index < lightSignature.length; index += 1) {
      const lightLayer = lightSignature[index]!;
      const darkLayer = darkSignature[index]!;

      expectMatchingGradientGeometry(darkLayer, lightLayer);
      expectDarkAlphaStopsNoBrighter(darkLayer, lightLayer);
      expect(darkLayer.colors.join('|')).not.toContain('rgba(255, 255, 255');
    }

    darkRender.unmount();
  });

  it('uses the normalized compact icon-button shape', () => {
    const { getByLabelText } = render(
      <ScreenIconButton iconName="close" accessibilityLabel="Close" size="compact" />,
    );

    expect(getByLabelText('Close').props.className).toContain('h-8 w-8 rounded-full');
    expect(mockMaterialSymbols.mock.calls[0][0].size).toBe('md');
  });

  it('resolves glass frame radius from shared rounded utility classes', () => {
    expect(getGlassCornerRadiusStyle('rounded-[24px] rounded-br-lg')).toEqual({
      borderRadius: 24,
      borderBottomRightRadius: 8,
    });
    expect(getGlassCornerRadiusStyle('rounded-t-[32px]')).toEqual({
      borderTopLeftRadius: 32,
      borderTopRightRadius: 32,
    });
    expect(getGlassCornerRadiusStyle('h-8 w-8 rounded-full')).toEqual({
      borderRadius: 9999,
    });
  });

  it('keeps icon tiles on an explicit vector-icon color across visual theme toggles', () => {
    const { getThemeAppearance, getThemeToneIconColor } = require('../../src/utils/themeTokens');
    const expectedColor = getThemeToneIconColor('info', 'light');
    mockThemeContext = {
      colors: { background: '#fff', headerBlurTint: 'light' },
      resolvedMode: 'light',
      themeId: 'default',
      appearance: getThemeAppearance('default', 'light'),
    };

    const { rerender } = render(
      <ScreenIconTile iconName="palette" tone="info" />,
    );

    expect(mockMaterialSymbols.mock.calls[mockMaterialSymbols.mock.calls.length - 1]?.[0]).toEqual(expect.objectContaining({
      name: 'palette',
      color: expectedColor,
    }));

    mockThemeContext = {
      ...mockThemeContext,
      themeId: 'glass',
      appearance: getThemeAppearance('glass', 'light'),
    };
    rerender(<ScreenIconTile iconName="palette" tone="info" />);
    expect(mockMaterialSymbols.mock.calls[mockMaterialSymbols.mock.calls.length - 1]?.[0]).toEqual(expect.objectContaining({
      name: 'palette',
      color: expectedColor,
    }));

    mockThemeContext = {
      ...mockThemeContext,
      themeId: 'default',
      appearance: getThemeAppearance('default', 'light'),
    };
    rerender(<ScreenIconTile iconName="palette" tone="info" />);
    expect(mockMaterialSymbols.mock.calls[mockMaterialSymbols.mock.calls.length - 1]?.[0]).toEqual(expect.objectContaining({
      name: 'palette',
      color: expectedColor,
    }));
  });

  it('parses explicit icon text color tokens without substring matches', () => {
    const { getThemeAppearance, getThemeColors } = require('../../src/utils/themeTokens');
    mockThemeContext = {
      colors: {
        ...getThemeColors('light', 'glass'),
        icon: '#123456',
        textInverse: '#abcdef',
      },
      resolvedMode: 'light',
      themeId: 'glass',
      appearance: getThemeAppearance('glass', 'light'),
    };

    const { rerender } = render(
      <ScreenIconButton
        iconName="palette"
        accessibilityLabel="Palette"
        iconClassName="text-typography-0/50"
      />,
    );

    expect(mockMaterialSymbols.mock.calls[mockMaterialSymbols.mock.calls.length - 1]?.[0]).toEqual(expect.objectContaining({
      color: '#123456',
    }));

    rerender(
      <ScreenIconButton
        iconName="palette"
        accessibilityLabel="Palette"
        iconClassName="text-typography-0"
      />,
    );

    expect(mockMaterialSymbols.mock.calls[mockMaterialSymbols.mock.calls.length - 1]?.[0]).toEqual(expect.objectContaining({
      color: '#abcdef',
    }));
  });

  it('uses the normalized sheet padding tokens', () => {
    const { getByTestId } = render(
      <ScreenSheet testID="screen-sheet">content</ScreenSheet>,
    );

    expect(getByTestId('screen-sheet').props.className).toContain('px-4');
    expect(getByTestId('screen-sheet').props.className).toContain('pt-5');
  });

  it('renders frosted backdrops for glass cards', () => {
    const { StyleSheet } = require('react-native');
    const { getThemeAppearance } = require('../../src/utils/themeTokens');
    const appearance = getThemeAppearance('glass', 'light');
    mockThemeContext = {
      colors: { background: '#fff', headerBlurTint: 'light' },
      resolvedMode: 'light',
      themeId: 'glass',
      appearance,
    };

    const { getByTestId, UNSAFE_getAllByType } = render(
      <ScreenCard testID="glass-card">content</ScreenCard>,
    );

    expect(getByTestId('glass-card').props.className).toContain('px-4 py-3');
    expect(getByTestId('glass-card').props.className).toContain('relative overflow-hidden');
    expect(getByTestId('glass-card').props.className).toContain('bg-transparent');
    expect(StyleSheet.flatten(getByTestId('glass-card').props.style)).toMatchObject({
      borderRadius: 20,
      borderWidth: 0,
      elevation: 0,
      shadowOpacity: 0,
    });
    expect(StyleSheet.flatten(getByTestId('glass-card').props.style).borderColor).toBeUndefined();

    const { View } = require('react-native');
    const blurBackdrop = UNSAFE_getAllByType(View).find((node: any) =>
      node.props.pointerEvents === 'none'
      && node.props.intensity === appearance.effects.surfaceBlurIntensity,
    );
    expect(blurBackdrop).toBeTruthy();

    const innerRim = UNSAFE_getAllByType(View).find((node: any) =>
      Array.isArray(node.props.style)
      && node.props.style.some((entry: any) => entry?.opacity === 0.9),
    );
    expect(innerRim?.props.style).toEqual(expect.arrayContaining([
      expect.objectContaining({ borderRadius: 20 }),
    ]));
    expect(StyleSheet.flatten(innerRim?.props.style).borderWidth).toBe(StyleSheet.hairlineWidth);
  });

  it('keeps dark glass cards contrasty without white feathered stripes', () => {
    const { Platform, StyleSheet, View } = require('react-native');
    const { getThemeAppearance, getThemeColors } = require('../../src/utils/themeTokens');
    const originalPlatform = Platform.OS;
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'ios' });

    try {
      mockThemeContext = {
        colors: getThemeColors('light', 'glass'),
        resolvedMode: 'light',
        themeId: 'glass',
        appearance: getThemeAppearance('glass', 'light'),
      };
      const lightRender = render(<ScreenCard testID="light-glass-card">content</ScreenCard>);
      const lightSignature = getGradientSignature(lightRender.UNSAFE_getAllByType(View));
      lightRender.unmount();

      mockThemeContext = {
        colors: getThemeColors('dark', 'glass'),
        resolvedMode: 'dark',
        themeId: 'glass',
        appearance: getThemeAppearance('glass', 'dark'),
      };
      const darkRender = render(<ScreenCard testID="dark-glass-card">content</ScreenCard>);
      const darkViews = darkRender.UNSAFE_getAllByType(View);
      const darkSignature = getGradientSignature(darkViews);
      const darkContrastLayer = darkViews.find((node: any) =>
        StyleSheet.flatten(node.props.style)?.backgroundColor === 'rgba(6,11,20,0.48)',
      );

      expect(darkContrastLayer).toBeTruthy();

      expect(darkSignature).toHaveLength(lightSignature.length);
      expect(darkSignature.length).toBeGreaterThan(0);
      for (const darkLayer of darkSignature) {
        expect(darkLayer.colors.join('|')).not.toContain('rgba(244,247,251');
        expect(darkLayer.colors.join('|')).not.toContain('rgba(255,255,255');
      }

      darkRender.unmount();
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, get: () => originalPlatform });
    }
  });

  it('does not render glass tint gradients for solid theme controls', () => {
    const { Text, View } = require('react-native');
    const { UNSAFE_getAllByType } = render(
      <ScreenActionPill tone="primary">
        <Text>Action</Text>
      </ScreenActionPill>,
    );

    expect(UNSAFE_getAllByType(View).some((node: any) => Array.isArray(node.props.colors))).toBe(false);
  });

  it('keeps dark glass segmented labels above decorative active layers after switching', () => {
    const { StyleSheet } = require('react-native');
    const { getThemeAppearance, getThemeColors } = require('../../src/utils/themeTokens');
    mockThemeContext = {
      colors: getThemeColors('dark', 'glass'),
      resolvedMode: 'dark',
      themeId: 'glass',
      appearance: getThemeAppearance('glass', 'dark'),
    };

    function SegmentedControlHarness() {
      const [activeKey, setActiveKey] = React.useState('light');

      return (
        <ScreenSegmentedControl
          activeKey={activeKey}
          onChange={setActiveKey}
          options={[
            { key: 'light', label: 'Light', testID: 'segmented-light' },
            { key: 'dark', label: 'Dark', testID: 'segmented-dark' },
          ]}
        />
      );
    }

    const { getByTestId, getByText } = render(<SegmentedControlHarness />);

    fireEvent.press(getByTestId('segmented-dark'));

    expect(getByText('Light').props.children).toBe('Light');
    expect(getByText('Dark').props.children).toBe('Dark');
    expect(StyleSheet.flatten(getByText('Light').props.style)).toMatchObject({
      color: '#c9d5e7',
      opacity: 1,
      position: 'relative',
      zIndex: 1,
      elevation: 1,
    });
    expect(StyleSheet.flatten(getByText('Dark').props.style)).toMatchObject({
      color: '#d9ebff',
      opacity: 1,
      position: 'relative',
      zIndex: 1,
      elevation: 1,
    });
  });

  it('keeps glass icon button frames on the same radius as their touch target', () => {
    const { getThemeAppearance } = require('../../src/utils/themeTokens');
    mockThemeContext = {
      colors: { background: '#fff', headerBlurTint: 'light' },
      resolvedMode: 'light',
      themeId: 'glass',
      appearance: getThemeAppearance('glass', 'light'),
    };

    const { getByLabelText } = render(
      <ScreenIconButton iconName="close" accessibilityLabel="Close" size="compact" />,
    );

    expect(getByLabelText('Close').props.style).toEqual(expect.arrayContaining([
      expect.objectContaining({ borderRadius: 9999 }),
    ]));
  });

  it('floats glass headers and publishes their measured content inset', () => {
    const { getThemeAppearance } = require('../../src/utils/themeTokens');
    mockThemeContext = {
      colors: { background: '#fff', headerBlurTint: 'light' },
      resolvedMode: 'light',
      themeId: 'glass',
      appearance: getThemeAppearance('glass', 'light'),
    };

    const { getByTestId, UNSAFE_getAllByType } = render(
      <ScreenRoot>
        <ScreenHeaderShell testID="floating-header" floating={true}>Header</ScreenHeaderShell>
        <ScreenContent testID="floating-content">
          <FloatingHeaderInsetProbe />
        </ScreenContent>
      </ScreenRoot>,
    );

    const { StyleSheet, View } = require('react-native');
    const headerShell = UNSAFE_getAllByType(View).find((node: any) =>
      typeof node.props.className === 'string'
      && node.props.className.includes('absolute left-0 right-0 top-0'),
    );

    expect(headerShell).toBeTruthy();
    expect(headerShell.props.className).not.toContain('border-b');
    expect(headerShell.props.className).toContain('border-transparent');
    expect(StyleSheet.flatten(headerShell.props.style).borderBottomWidth).toBe(0);
    fireEvent(headerShell, 'layout', { nativeEvent: { layout: { height: 88 } } });
    expect(getByTestId('floating-header-inset').props.children).toBe(88);
    expect(StyleSheet.flatten(getByTestId('floating-content').props.style).paddingTop).toBe(88);
  });

  it('keeps glass header fade continuous without a midpoint divider stop', () => {
    const { getThemeAppearance } = require('../../src/utils/themeTokens');
    mockThemeContext = {
      colors: { background: '#fff', headerBlurTint: 'light' },
      resolvedMode: 'light',
      themeId: 'glass',
      appearance: getThemeAppearance('glass', 'light'),
    };

    const { UNSAFE_getAllByType } = render(
      <ScreenHeaderShell>Header</ScreenHeaderShell>,
    );

    const { View } = require('react-native');
    const headerFade = UNSAFE_getAllByType(View).find((node: any) =>
      Array.isArray(node.props.colors)
      && node.props.colors[0] === 'rgba(255,255,255,0.38)'
      && node.props.colors[1] === 'rgba(255,255,255,0)',
    );

    expect(headerFade).toBeTruthy();
    expect(headerFade?.props.locations).toBeUndefined();
  });

  it('keeps non-floating headers in normal flow', () => {
    const { getThemeAppearance } = require('../../src/utils/themeTokens');
    mockThemeContext = {
      colors: { background: '#fff', headerBlurTint: 'light' },
      resolvedMode: 'light',
      themeId: 'glass',
      appearance: getThemeAppearance('glass', 'light'),
    };

    const { UNSAFE_getAllByType } = render(
      <ScreenRoot>
        <ScreenHeaderShell floating={false} testID="fixed-header">Header</ScreenHeaderShell>
      </ScreenRoot>,
    );

    const { View } = require('react-native');
    expect(UNSAFE_getAllByType(View).some((node: any) =>
      typeof node.props.className === 'string'
      && node.props.className.includes('absolute left-0 right-0 top-0'),
    )).toBe(false);
  });

  it('renders matte glass cards without specular or optical refraction gradients', () => {
    const { Platform, View } = require('react-native');
    const { getThemeAppearance } = require('../../src/utils/themeTokens');
    const originalPlatform = Platform.OS;
    mockThemeContext = {
      colors: { background: '#fff', headerBlurTint: 'light' },
      resolvedMode: 'light',
      themeId: 'glass',
      appearance: getThemeAppearance('glass', 'light'),
    };
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'ios' });

    try {
      const { UNSAFE_getAllByType } = render(
        <ScreenCard testID="matte-glass-card" decorative="matte">content</ScreenCard>,
      );
      const gradientColors = UNSAFE_getAllByType(View)
        .map((node: any) => node.props.colors)
        .filter((colors: any) => Array.isArray(colors))
        .map((colors: string[]) => colors.join('|'));

      expect(gradientColors.some((colors: string) => colors.includes('rgba(255,255,255,0.2)'))).toBe(true);
      expect(gradientColors.some((colors: string) =>
        colors.includes('rgba(37,99,235')
        || colors.includes('rgba(14,165,233')
        || colors.includes('rgba(56,189,248')
      )).toBe(false);
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, get: () => originalPlatform });
    }
  });

  it('keeps standard glass cards decorative by default', () => {
    const { Platform, View } = require('react-native');
    const { getThemeAppearance } = require('../../src/utils/themeTokens');
    const originalPlatform = Platform.OS;
    mockThemeContext = {
      colors: { background: '#fff', headerBlurTint: 'light' },
      resolvedMode: 'light',
      themeId: 'glass',
      appearance: getThemeAppearance('glass', 'light'),
    };
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'ios' });

    try {
      const { UNSAFE_getAllByType } = render(
        <ScreenCard testID="standard-glass-card">content</ScreenCard>,
      );
      const gradientColors = UNSAFE_getAllByType(View)
        .map((node: any) => node.props.colors)
        .filter((colors: any) => Array.isArray(colors))
        .map((colors: string[]) => colors.join('|'));

      expect(gradientColors.some((colors: string) =>
        colors.includes('rgba(37,99,235')
        || colors.includes('rgba(14,165,233')
        || colors.includes('rgba(56,189,248')
      )).toBe(true);
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, get: () => originalPlatform });
    }
  });

  it('renders frosted backdrops for glass pressable cards', () => {
    const { StyleSheet } = require('react-native');
    const { getThemeAppearance } = require('../../src/utils/themeTokens');
    const appearance = getThemeAppearance('glass', 'light');
    mockThemeContext = {
      colors: { background: '#fff', headerBlurTint: 'light' },
      resolvedMode: 'light',
      themeId: 'glass',
      appearance,
    };

    const { getByTestId, UNSAFE_getAllByType } = render(
      <ScreenPressableCard testID="glass-pressable-card" onPress={jest.fn()}>content</ScreenPressableCard>,
    );

    expect(getByTestId('glass-pressable-card').props.className).toContain('relative overflow-hidden');
    expect(getByTestId('glass-pressable-card').props.className).toContain('bg-transparent');
    expect(StyleSheet.flatten(getByTestId('glass-pressable-card').props.style)).toMatchObject({
      borderWidth: 0,
      elevation: 0,
      shadowOpacity: 0,
    });
    expect(StyleSheet.flatten(getByTestId('glass-pressable-card').props.style).borderColor).toBeUndefined();

    const { View } = require('react-native');
    const blurBackdrop = UNSAFE_getAllByType(View).find((node: any) =>
      node.props.pointerEvents === 'none'
      && node.props.intensity === appearance.effects.surfaceBlurIntensity,
    );
    expect(blurBackdrop).toBeTruthy();
  });

  it('keeps compact glass controls tint-only without nested blur views', () => {
    const { getThemeAppearance } = require('../../src/utils/themeTokens');
    const appearance = getThemeAppearance('glass', 'light');
    mockThemeContext = {
      colors: { background: '#fff', headerBlurTint: 'light' },
      resolvedMode: 'light',
      themeId: 'glass',
      appearance,
    };

    const { getByLabelText, UNSAFE_getAllByType } = render(
      <ScreenIconButton iconName="close" accessibilityLabel="Close" size="compact" />,
    );

    expect(getByLabelText('Close').props.className).toContain('relative overflow-hidden');

    const { View } = require('react-native');
    const views = UNSAFE_getAllByType(View);
    const blurBackdrop = views.find((node: any) =>
      node.props.pointerEvents === 'none'
      && node.props.intensity === appearance.effects.surfaceBlurIntensity,
    );
    const tintBackdrop = views.find((node: any) =>
      node.props.pointerEvents === 'none'
      && Array.isArray(node.props.colors)
      && node.props.colors.includes('rgba(255,255,255,0.22)'),
    );

    expect(blurBackdrop).toBeUndefined();
    expect(tintBackdrop).toBeTruthy();
  });

  it('keeps dark glass control tint without white feathered stripes', () => {
    const { View } = require('react-native');
    const { getThemeAppearance, getThemeColors } = require('../../src/utils/themeTokens');
    mockThemeContext = {
      colors: getThemeColors('light', 'glass'),
      resolvedMode: 'light',
      themeId: 'glass',
      appearance: getThemeAppearance('glass', 'light'),
    };
    const lightRender = render(<ScreenIconTile iconName="palette" tone="info" />);
    const lightSignature = getGradientSignature(lightRender.UNSAFE_getAllByType(View));
    lightRender.unmount();

    mockThemeContext = {
      colors: getThemeColors('dark', 'glass'),
      resolvedMode: 'dark',
      themeId: 'glass',
      appearance: getThemeAppearance('glass', 'dark'),
    };
    const darkRender = render(<ScreenIconTile iconName="palette" tone="info" />);
    const darkSignature = getGradientSignature(darkRender.UNSAFE_getAllByType(View));

    expect(lightSignature.length).toBeGreaterThan(darkSignature.length);
    expect(darkSignature.length).toBeGreaterThan(0);
    for (const darkLayer of darkSignature) {
      expect(darkLayer.colors.join('|')).not.toContain('rgba(244,247,251');
      expect(darkLayer.colors.join('|')).not.toContain('rgba(255,255,255');
    }

    darkRender.unmount();
  });

  it('keeps inline glass inputs tint-only without specular blur chrome', () => {
    const { getThemeAppearance } = require('../../src/utils/themeTokens');
    const appearance = getThemeAppearance('glass', 'light');
    mockThemeContext = {
      colors: { background: '#fff', headerBlurTint: 'light' },
      resolvedMode: 'light',
      themeId: 'glass',
      appearance,
    };

    const { UNSAFE_getAllByType } = render(
      <ScreenInlineInput value="" onChangeText={jest.fn()} />,
    );

    const { View } = require('react-native');
    const views = UNSAFE_getAllByType(View);
    expect(views.some((node: any) => node.props.intensity === appearance.effects.surfaceBlurIntensity)).toBe(false);
    expect(views.some((node: any) => Array.isArray(node.props.colors)
      && node.props.colors.includes('rgba(255,255,255,0.22)'))).toBe(true);
  });

  it('omits native border width classes from glass chips', () => {
    const { getThemeAppearance } = require('../../src/utils/themeTokens');
    mockThemeContext = {
      colors: { background: '#fff', headerBlurTint: 'light' },
      resolvedMode: 'light',
      themeId: 'glass',
      appearance: getThemeAppearance('glass', 'light'),
    };

    const { getByTestId } = render(
      <ScreenChip testID="glass-chip" label="Default" onPress={jest.fn()} />,
    );

    expect(getByTestId('glass-chip').props.className.split(/\s+/)).not.toContain('border');
  });

  it('keeps separate Android glass target wrappers while rendering matte surfaces', () => {
    const { Platform } = require('react-native');
    const { getThemeAppearance } = require('../../src/utils/themeTokens');
    const originalPlatform = Platform.OS;
    const originalVersion = Platform.Version;
    const appearance = getThemeAppearance('glass', 'light');
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'android' });
    Object.defineProperty(Platform, 'Version', { configurable: true, get: () => 34 });
    mockThemeContext = {
      colors: { background: '#fff', headerBlurTint: 'light' },
      resolvedMode: 'light',
      themeId: 'glass',
      appearance,
    };

    try {
      const { getByTestId, UNSAFE_getAllByType } = render(
        <ScreenRoot>
          <ScreenSheet testID="android-glass-sheet">content</ScreenSheet>
        </ScreenRoot>,
      );

      const { View } = require('react-native');
      const views = UNSAFE_getAllByType(View);
      const blurBackdrop = views.find((node: any) =>
        node.props.pointerEvents === 'none'
        && node.props.intensity === appearance.effects.surfaceBlurIntensity,
      );
      const backgroundBlurTarget = getByTestId('screen-glass-blur-target');
      const sceneBlurTarget = getByTestId('screen-glass-scene-blur-target');
      expect(backgroundBlurTarget).toBeTruthy();
      expect(backgroundBlurTarget.props.pointerEvents).toBe('none');
      expect(sceneBlurTarget.props.pointerEvents).toBe('box-none');
      expect(() => backgroundBlurTarget.findByProps({ testID: 'android-glass-sheet' })).toThrow();
      expect(sceneBlurTarget.findByProps({ testID: 'android-glass-sheet' })).toBeTruthy();
      expect(blurBackdrop).toBeUndefined();
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, get: () => originalPlatform });
      Object.defineProperty(Platform, 'Version', { configurable: true, get: () => originalVersion });
    }
  });

  it('uses matte glass instead of native blur for dark Android surfaces', () => {
    const { Platform, StyleSheet } = require('react-native');
    const { getThemeAppearance, getThemeColors } = require('../../src/utils/themeTokens');
    const originalPlatform = Platform.OS;
    const originalVersion = Platform.Version;
    const appearance = getThemeAppearance('glass', 'dark');
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'android' });
    Object.defineProperty(Platform, 'Version', { configurable: true, get: () => 34 });
    mockThemeContext = {
      colors: getThemeColors('dark', 'glass'),
      resolvedMode: 'dark',
      themeId: 'glass',
      appearance,
    };

    try {
      const { UNSAFE_getAllByType } = render(
        <ScreenRoot>
          <ScreenSheet testID="android-dark-glass-sheet">content</ScreenSheet>
        </ScreenRoot>,
      );

      const { View } = require('react-native');
      const views = UNSAFE_getAllByType(View);
      expect(views.some((node: any) => node.props.intensity === appearance.effects.surfaceBlurIntensity)).toBe(false);
      expect(views.some((node: any) =>
        StyleSheet.flatten(node.props.style)?.backgroundColor === 'rgba(6,11,20,0.46)',
      )).toBe(true);
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, get: () => originalPlatform });
      Object.defineProperty(Platform, 'Version', { configurable: true, get: () => originalVersion });
    }
  });

  it('falls back to dense tint surfaces instead of BlurView on pre-31 Android', () => {
    const { Platform } = require('react-native');
    const { getThemeAppearance } = require('../../src/utils/themeTokens');
    const originalPlatform = Platform.OS;
    const originalVersion = Platform.Version;
    const appearance = getThemeAppearance('glass', 'light');
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'android' });
    Object.defineProperty(Platform, 'Version', { configurable: true, get: () => 30 });
    mockThemeContext = {
      colors: { background: '#fff', headerBlurTint: 'light' },
      resolvedMode: 'light',
      themeId: 'glass',
      appearance,
    };

    try {
      const { UNSAFE_getAllByType } = render(
        <ScreenRoot>
          <ScreenSheet testID="legacy-glass-sheet">content</ScreenSheet>
        </ScreenRoot>,
      );

      const { View } = require('react-native');
      const views = UNSAFE_getAllByType(View);
      expect(views.some((node: any) => node.props.intensity === appearance.effects.surfaceBlurIntensity)).toBe(false);
      expect(views.some((node: any) => typeof node.props.className === 'string'
        && node.props.className.includes('bg-background-0/15'))).toBe(true);
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, get: () => originalPlatform });
      Object.defineProperty(Platform, 'Version', { configurable: true, get: () => originalVersion });
    }
  });

  it('adds native bottom safe area space to sheet padding', () => {
    const { Platform, StyleSheet } = require('react-native');
    const { screenLayoutMetrics } = require('../../src/utils/themeTokens');
    const originalPlatform = Platform.OS;
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'android' });
    mockSafeAreaInsets = { top: 0, right: 0, bottom: 18, left: 0 };

    try {
      const { getByTestId } = render(
        <ScreenSheet testID="safe-screen-sheet">content</ScreenSheet>,
      );

      expect(StyleSheet.flatten(getByTestId('safe-screen-sheet').props.style).paddingBottom)
        .toBe(screenLayoutMetrics.sheetBottomInset + 18);
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, get: () => originalPlatform });
    }
  });

  it('keeps inline inputs inside the shared input shell', () => {
    const { UNSAFE_getAllByType } = render(
      <ScreenInlineInput
        containerTestID="inline-input-shell"
        testID="inline-input-field"
        variant="search"
        value=""
        onChangeText={jest.fn()}
      />,
    );

    const { View } = require('react-native');
    const requiredClasses = [
      'min-w-0',
      'flex-1',
      'border-0',
      'bg-transparent',
      'px-0',
    ];
    const shell = UNSAFE_getAllByType(View).find((node: any) =>
      typeof node.props.className === 'string'
      && requiredClasses.every((token) => node.props.className.split(/\s+/).includes(token)),
    );

    expect(shell).toBeTruthy();
  });

  it('does not inject native bottom safe area padding by default', () => {
    const { Platform, StyleSheet } = require('react-native');
    const originalPlatform = Platform.OS;
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'ios' });
    mockSafeAreaInsets = { top: 0, right: 0, bottom: 32, left: 0 };

    try {
      const { getByTestId } = render(
        <ScreenContent testID="screen-content" className="pb-0">content</ScreenContent>,
      );

      expect(StyleSheet.flatten(getByTestId('screen-content').props.style)?.paddingBottom).toBeUndefined();
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, get: () => originalPlatform });
    }
  });

  it('adds native bottom safe area space to opted-in screen content padding', () => {
    const { Platform, StyleSheet } = require('react-native');
    const { screenLayoutMetrics } = require('../../src/utils/themeTokens');
    const originalPlatform = Platform.OS;
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'ios' });
    mockSafeAreaInsets = { top: 0, right: 0, bottom: 32, left: 0 };

    try {
      const { getByTestId } = render(
        <ScreenContent testID="safe-screen-content" includeBottomSafeArea>content</ScreenContent>,
      );

      expect(StyleSheet.flatten(getByTestId('safe-screen-content').props.style).paddingBottom)
        .toBe(screenLayoutMetrics.contentBottomInset + 32);
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, get: () => originalPlatform });
    }
  });

  it('adds extra bottom inset for floating screen overlays', () => {
    const { StyleSheet } = require('react-native');
    const { screenLayoutMetrics } = require('../../src/utils/themeTokens');

    const { getByTestId } = render(
      <ScreenContent testID="extra-screen-content" extraBottomInset={96}>content</ScreenContent>,
    );

    expect(StyleSheet.flatten(getByTestId('extra-screen-content').props.style).paddingBottom)
      .toBe(screenLayoutMetrics.contentBottomInset + 96);
  });
});
