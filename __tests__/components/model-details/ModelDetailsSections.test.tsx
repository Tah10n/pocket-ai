import React from 'react';
import { render } from '@testing-library/react-native';
import { Text as NativeText } from 'react-native';

const mockSectionCard = jest.fn(({ children, ...props }: any) => {
  const mockReact = require('react');
  const { View } = require('react-native');
  return mockReact.createElement(View, props, children);
});

const mockDetailValueCard = jest.fn((props: any) => {
  const mockReact = require('react');
  const { View } = require('react-native');
  return mockReact.createElement(View, props);
});

const mockScreenChip = jest.fn((props: any) => {
  const mockReact = require('react');
  const { View } = require('react-native');
  return mockReact.createElement(View, props);
});

jest.mock('../../../src/components/ui/box', () => {
  const mockReact = require('react');
  const { View } = require('react-native');
  return {
    Box: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
  };
});

jest.mock('../../../src/components/ui/text', () => {
  const mockReact = require('react');
  const { Text } = require('react-native');
  return {
    Text: ({ children, ...props }: any) => mockReact.createElement(Text, props, children),
    composeTextRole: (_role: string, className = '') => className,
  };
});

jest.mock('../../../src/components/model-details/ModelDetailsPrimitives', () => ({
  SectionCard: (props: any) => mockSectionCard(props),
  DetailValueCard: (props: any) => mockDetailValueCard(props),
}));

jest.mock('../../../src/components/ui/ScreenShell', () => {
  const mockReact = require('react');
  const { View } = require('react-native');
  return {
    ScreenChip: (props: any) => mockScreenChip(props),
    ScreenStack: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
  };
});

import { ModelDetailsHeroCard } from '../../../src/components/model-details/ModelDetailsHeroCard';
import { ModelDetailsMetadataSection } from '../../../src/components/model-details/ModelDetailsMetadataSection';
import { ModelDetailsTagsSection } from '../../../src/components/model-details/ModelDetailsTagsSection';

describe('model details sections', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the hero card without optional sections when they are absent', () => {
    const screen = render(
      <ModelDetailsHeroCard
        title="Model title"
        modelId="author/model-q4"
      />,
    );

    expect(screen.getByText('Model title')).toBeTruthy();
    expect(screen.getByText('author/model-q4')).toBeTruthy();
    expect(screen.queryByText('Badge')).toBeNull();
    expect(screen.queryByText('Action')).toBeNull();
    expect(screen.queryByText('Progress')).toBeNull();
  });

  it('renders optional hero sections when they are provided', () => {
    const screen = render(
      <ModelDetailsHeroCard
        badges={<NativeText>Badge</NativeText>}
        title="Model title"
        modelId="author/model-q4"
        actions={<NativeText>Action</NativeText>}
        progress={<NativeText>Progress</NativeText>}
        openOnHuggingFaceButton={<NativeText>Open HF</NativeText>}
      />,
    );

    expect(screen.getByText('Badge')).toBeTruthy();
    expect(screen.getByText('Action')).toBeTruthy();
    expect(screen.getByText('Progress')).toBeTruthy();
    expect(screen.getByText('Open HF')).toBeTruthy();
  });

  it('renders the tags empty state with the default success tone', () => {
    const screen = render(
      <ModelDetailsTagsSection
        chips={[]}
        emptyLabel="No tags"
        title="Tags"
        iconName="label"
      />,
    );

    expect(screen.getByText('No tags')).toBeTruthy();
    expect(mockSectionCard).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Tags',
      iconName: 'label',
      tone: 'success',
    }));
    expect(mockScreenChip).not.toHaveBeenCalled();
  });

  it('renders chips with the max-width fallback class when no className is provided', () => {
    render(
      <ModelDetailsTagsSection
        chips={[{ key: 'tag-a', label: 'Alpha' }]}
        emptyLabel="No tags"
        title="Tags"
        iconName="label"
      />,
    );

    expect(mockScreenChip).toHaveBeenCalledWith(expect.objectContaining({
      label: 'Alpha',
      className: 'max-w-full',
    }));
  });

  it('returns null for empty metadata sections', () => {
    const screen = render(
      <ModelDetailsMetadataSection
        items={[]}
        title="Metadata"
        iconName="info"
      />,
    );

    expect(screen.toJSON()).toBeNull();
    expect(mockDetailValueCard).not.toHaveBeenCalled();
  });

  it('renders metadata items with the default tone and compact fallback', () => {
    render(
      <ModelDetailsMetadataSection
        items={[
          {
            label: 'License',
            value: 'MIT',
            tone: 'info',
          },
        ]}
        title="Metadata"
        iconName="info"
      />,
    );

    expect(mockSectionCard).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Metadata',
      iconName: 'info',
      tone: 'primary',
    }));
    expect(mockDetailValueCard).toHaveBeenCalledWith(expect.objectContaining({
      label: 'License',
      value: 'MIT',
      tone: 'info',
      compact: true,
    }));
  });
});
