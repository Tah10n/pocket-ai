import React from 'react';
import { render } from '@testing-library/react-native';
import { ModelsFilter } from '../../src/components/models/ModelsFilter';
import { getThemeAppearance, getThemeColors } from '../../src/utils/themeTokens';
import type { ModelFilterCriteria, ModelSortPreference } from '../../src/store/modelsStore';

let mockThemeContext: any;

jest.mock('../../src/providers/ThemeProvider', () => ({
  useTheme: () => mockThemeContext,
}));

jest.mock('../../src/components/ui/MaterialSymbols', () => {
  const mockReact = require('react');
  const { Text } = require('react-native');
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
    mockThemeContext = {
      appearance: getThemeAppearance('default', 'light'),
      colors: getThemeColors('light'),
      resolvedMode: 'light',
      themeId: 'default',
    };
  });

  it('keeps the solid theme filter bar surface behind trigger buttons', () => {
    const screen = renderModelsFilter();

    expect(screen.toJSON()?.props.className).toContain('bg-background-0');
    expect(screen.getByTestId('models-filter-toggle').props.className).toContain('rounded-2xl');
  });

  it('does not paint a full-width glass rectangle behind trigger buttons', () => {
    mockThemeContext = {
      appearance: getThemeAppearance('glass', 'light'),
      colors: getThemeColors('light', 'glass'),
      resolvedMode: 'light',
      themeId: 'glass',
    };

    const screen = renderModelsFilter();

    expect(screen.toJSON()?.props.className).toBe('py-1.5');
    expect(screen.toJSON()?.props.className).not.toContain('bg-background');
    expect(screen.getByTestId('models-sort-toggle').props.className).toContain('rounded-2xl');
  });
});
