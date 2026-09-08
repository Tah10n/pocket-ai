import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { ModelsFilter } from '../../src/components/models/ModelsFilter';
import { resolveTheme } from '../../src/design-system/themes/resolver';
import type { ModelFilterCriteria, ModelSortPreference } from '../../src/store/modelsStore';

let mockThemeContext: any;
const mockAndroidBlurTargetRef = { current: null };
const mockRequestAndroidLiquidGlassSceneRefresh = jest.fn();

jest.mock('../../src/components/ui/ScreenShell', () => ({
  ...jest.requireActual('../../src/components/ui/ScreenShell'),
  useAndroidLiquidGlassSceneRefresh: () => mockRequestAndroidLiquidGlassSceneRefresh,
}));

jest.mock('../../src/design-system/materials/EffectSurface', () => {
  const mockReact = jest.requireActual<typeof import('react')>('react');
  const { Pressable, View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    EffectPressableSurface: ({ children, ...props }: any) => mockReact.createElement(Pressable, props, children),
    EffectSurface: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
  };
});

jest.mock('../../src/providers/ThemeProvider', () => ({
  useTheme: () => mockThemeContext,
}));

jest.mock('../../src/components/ui/MaterialSymbols', () => {
  const mockReact = jest.requireActual<typeof import('react')>('react');
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    MaterialSymbols: ({ name, ...props }: any) => mockReact.createElement(Text, props, name),
  };
});

const filters: ModelFilterCriteria = {
  fitsInRamOnly: false,
  noTokenRequiredOnly: false,
  sizeRanges: [],
};

const sort: ModelSortPreference = {
  direction: 'desc',
  field: 'downloads',
};

function renderModelsFilter() {
  return render(
    <ModelsFilter
      androidContentBlurTargetRef={mockAndroidBlurTargetRef}
      filters={filters}
      sort={sort}
      onFitsInRamToggle={jest.fn()}
      onNoTokenRequiredToggle={jest.fn()}
      onSizeRangeToggle={jest.fn()}
      onSortChange={jest.fn()}
      onClear={jest.fn()}
    />,
  );
}

describe('ModelsFilter', () => {
  beforeEach(() => {
    const resolvedTheme = resolveTheme('default', 'light');
    mockThemeContext = {
      colors: resolvedTheme.colors,
      resolvedMode: 'light',
      resolvedTheme,
      themeId: 'default',
    };
    mockRequestAndroidLiquidGlassSceneRefresh.mockClear();
  });

  it('keeps the filter bar background owned by semantic trigger surfaces', () => {
    const screen = renderModelsFilter();

    expect(screen.toJSON()?.props.className).toBeUndefined();
    expect(screen.getByTestId('models-filter-toggle').props.className).toContain('h-9');
    expect(screen.getByTestId('models-filter-toggle').props.className).toContain('rounded-full');
    expect(screen.getByTestId('models-filter-toggle').props.androidBlurTargetRef)
      .toBe(mockAndroidBlurTargetRef);
    expect(screen.getByTestId('models-filter-toggle').props.material).toEqual({
      role: 'control',
      variant: 'floating',
      tone: 'neutral',
    });
    expect(screen.getByTestId('models-sort-toggle').props.accessibilityLabel)
      .toBe('models.sortTitle: models.sortMostDownloaded');
    expect(screen.getByTestId('models-sort-toggle').props.accessibilityState)
      .toEqual({ expanded: false });
  });

  it('does not paint a full-width glass rectangle behind trigger buttons', () => {
    const resolvedTheme = resolveTheme('glass', 'light');
    mockThemeContext = {
      colors: resolvedTheme.colors,
      resolvedMode: 'light',
      resolvedTheme,
      themeId: 'glass',
    };

    const screen = renderModelsFilter();

    expect(screen.toJSON()?.props.className).toBeUndefined();
    expect(screen.toJSON()?.props.className ?? '').not.toContain('bg-background');
    expect(screen.getByTestId('models-sort-toggle').props.className).toContain('rounded-full');
  });

  it('uses the catalog blur target for expanded filter chrome', () => {
    const screen = renderModelsFilter();

    fireEvent.press(screen.getByTestId('models-filter-toggle'));

    expect(screen.getByTestId('models-filter-panel').props.androidBlurTargetRef)
      .toBe(mockAndroidBlurTargetRef);
    expect(screen.getByTestId('models-filter-panel').props.material).toEqual({
      role: 'overlay',
      variant: 'popover',
      tone: 'neutral',
    });
    expect(screen.getByTestId('models-filter-toggle').props.material).toEqual({
      role: 'control',
      variant: 'floating',
      tone: 'primary',
    });

    fireEvent(screen.getByTestId('models-filter-panel'), 'layout', {
      nativeEvent: { layout: { height: 160 } },
    });
    expect(mockRequestAndroidLiquidGlassSceneRefresh).toHaveBeenCalledTimes(1);
  });

  it('keeps the expanded sort trigger glass-backed and refreshes its popover scene', () => {
    const screen = renderModelsFilter();

    fireEvent.press(screen.getByTestId('models-sort-toggle'));

    expect(screen.getByTestId('models-sort-toggle').props.material).toEqual({
      role: 'control',
      variant: 'floating',
      tone: 'primary',
    });
    fireEvent(screen.getByTestId('models-sort-panel'), 'layout', {
      nativeEvent: { layout: { height: 160 } },
    });
    expect(mockRequestAndroidLiquidGlassSceneRefresh).toHaveBeenCalledTimes(1);
  });
});
