import React from 'react';
import { render } from '@testing-library/react-native';
import { Text } from 'react-native';

jest.mock('@/components/ui/MaterialSymbols', () => ({
  MaterialSymbols: () => null,
}));

import { ModelDetailsUnavailableState } from '@/components/model-details/ModelDetailsUnavailableState';

describe('ModelDetailsUnavailableState', () => {
  it('renders title and message', () => {
    const { getByText } = render(
      <ModelDetailsUnavailableState
        title="Title"
        message="Message"
      />,
    );

    expect(getByText('Title')).toBeTruthy();
    expect(getByText('Message')).toBeTruthy();
  });

  it('renders optional action content when provided', () => {
    const { getByText } = render(
      <ModelDetailsUnavailableState
        title="Title"
        message="Message"
        openOnHuggingFaceButton={<Text>Open HF</Text>}
      />,
    );

    expect(getByText('Open HF')).toBeTruthy();
  });
});
