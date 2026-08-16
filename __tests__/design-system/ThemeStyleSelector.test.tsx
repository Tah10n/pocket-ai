import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { ThemeStyleSelector } from '../../src/design-system/components/ThemeStyleSelector';
import type { ThemeMetadata } from '../../src/design-system/themes/contract';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { theme?: string }) => (
      options?.theme ? `${key}:${options.theme}` : key
    ),
  }),
}));

jest.mock('@/components/ui/box', () => {
  const mockReact = jest.requireActual('react');
  const { View: MockView } = jest.requireActual('react-native');

  return {
    Box: ({ children, ...props }: any) => mockReact.createElement(MockView, props, children),
  };
});

jest.mock('@/components/ui/ValueSelectorRow', () => {
  const mockReact = jest.requireActual('react');
  const { Pressable: MockPressable, Text: MockText } = jest.requireActual('react-native');

  return {
    ValueSelectorRow: ({ leading, value, ...props }: any) => mockReact.createElement(
      MockPressable,
      props,
      leading,
      mockReact.createElement(MockText, null, value),
    ),
  };
});

jest.mock('@/components/ui/ListPickerSheet', () => {
  const mockReact = jest.requireActual('react');
  const {
    Pressable: MockPressable,
    Text: MockText,
    View: MockView,
  } = jest.requireActual('react-native');

  return {
    ListPickerSheet: ({ visible, items, testID }: any) => visible
      ? mockReact.createElement(
        MockView,
        { testID },
        items.map((item: any) => mockReact.createElement(
          MockPressable,
          {
            key: item.key,
            testID: item.testID,
            onPress: item.onPress,
            accessibilityLabel: item.accessibilityLabel,
            accessibilityHint: item.accessibilityHint,
            accessibilityState: { selected: item.selected === true },
          },
          item.leading,
          mockReact.createElement(MockText, null, item.title),
          item.description ? mockReact.createElement(MockText, null, item.description) : null,
        )),
      )
      : null,
  };
});

function createThemes(count: number): readonly ThemeMetadata<string>[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `theme-${index}`,
    labelKey: `themes.theme-${index}`,
    descriptionKey: `themes.theme-${index}-description`,
    preview: {
      canvas: `#00000${index}`,
      surface: `#10000${index}`,
      accent: `#20000${index}`,
      materialHint: index % 2 === 0 ? 'solid' as const : 'translucent' as const,
    },
  }));
}

describe('ThemeStyleSelector', () => {
  it.each([2, 3, 6])('renders %i registry entries in an adaptive picker', (count) => {
    const themes = createThemes(count);
    const screen = render(
      <ThemeStyleSelector
        themes={themes}
        activeThemeId="theme-0"
        onChange={jest.fn()}
      />,
    );

    const trigger = screen.getByTestId('settings-theme-style-control');
    expect(trigger.props.accessibilityValue).toEqual({ text: 'themes.theme-0' });
    expect(screen.getByTestId(
      'settings-theme-style-control-preview',
      { includeHiddenElements: true },
    ).props.accessible).toBe(false);

    fireEvent.press(trigger);

    expect(screen.getByTestId('settings-theme-style-sheet')).toBeTruthy();
    expect(screen.getAllByTestId(/^settings-theme-style-theme-\d+$/)).toHaveLength(count);
    expect(screen.getAllByTestId(
      /^settings-theme-style-theme-\d+-preview$/,
      { includeHiddenElements: true },
    )).toHaveLength(count);
  });

  it('closes after selecting a typed registry entry and preserves stable ids', () => {
    const themes = createThemes(6);
    const onChange = jest.fn();
    const screen = render(
      <ThemeStyleSelector
        themes={themes}
        activeThemeId="theme-2"
        onChange={onChange}
      />,
    );

    fireEvent.press(screen.getByTestId('settings-theme-style-control'));
    expect(screen.getByTestId('settings-theme-style-theme-2').props.accessibilityState).toEqual({ selected: true });

    fireEvent.press(screen.getByTestId('settings-theme-style-theme-5'));

    expect(onChange).toHaveBeenCalledWith('theme-5');
    expect(screen.queryByTestId('settings-theme-style-sheet')).toBeNull();
  });

  it('renders solid color swatches without exposing decorative descendants to accessibility', () => {
    const [theme] = createThemes(2);
    const screen = render(
      <ThemeStyleSelector
        themes={[theme]}
        activeThemeId={theme.id}
        onChange={jest.fn()}
      />,
    );

    fireEvent.press(screen.getByTestId('settings-theme-style-control'));
    const preview = screen.getByTestId(
      `settings-theme-style-${theme.id}-preview`,
      { includeHiddenElements: true },
    );
    const flattenedStyle = Object.assign({}, ...preview.props.style);

    expect(preview.type).toBe('View');
    expect(preview.props.accessibilityElementsHidden).toBe(true);
    expect(preview.props.importantForAccessibility).toBe('no-hide-descendants');
    expect(flattenedStyle).toMatchObject({
      backgroundColor: theme.preview.canvas,
      borderColor: theme.preview.accent,
    });
  });
});
