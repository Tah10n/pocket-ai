import React from 'react';
import { render } from '@testing-library/react-native';
import { ModelsFilter } from '../../src/components/models/ModelsFilter';
import { resolveTheme } from '../../src/design-system/themes/resolver';
import type { ModelFilterCriteria, ModelSortPreference } from '../../src/store/modelsStore';

let mockThemeContext: any;

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
  });

  it('keeps the filter bar background owned by semantic trigger surfaces', () => {
    const screen = renderModelsFilter();

    expect(screen.toJSON()?.props.className).toBe('py-1.5');
    expect(screen.getByTestId('models-filter-toggle').props.className).toContain('rounded-2xl');
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

    expect(screen.toJSON()?.props.className).toBe('py-1.5');
    expect(screen.toJSON()?.props.className).not.toContain('bg-background');
    expect(screen.getByTestId('models-sort-toggle').props.className).toContain('rounded-2xl');
  });
});
