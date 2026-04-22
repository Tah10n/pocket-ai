import React from 'react';
import { render } from '@testing-library/react-native';
import { iconSizePx } from '../../../src/utils/themeTokens';

const mockMaterialIcons = jest.fn((_props: any) => null);

jest.mock('@expo/vector-icons/MaterialIcons', () => (props: any) => mockMaterialIcons(props));

import { MaterialSymbols } from '../../../src/components/ui/MaterialSymbols';

describe('MaterialSymbols', () => {
  beforeEach(() => {
    mockMaterialIcons.mockClear();
  });

  it('uses the semantic medium size by default', () => {
    render(<MaterialSymbols name="info-outline" />);

    expect(mockMaterialIcons).toHaveBeenCalledWith(expect.objectContaining({
      name: 'info-outline',
      size: iconSizePx.md,
    }));
  });

  it('passes through numeric sizes directly', () => {
    render(<MaterialSymbols name="info-outline" size={18} color="#fff" className="text-white" />);

    expect(mockMaterialIcons).toHaveBeenCalledWith(expect.objectContaining({
      name: 'info-outline',
      size: 18,
      color: '#fff',
      className: 'text-white',
    }));
  });
});
