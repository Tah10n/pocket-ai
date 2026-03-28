import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../../src/types/models';
import { ModelCard } from '../../../src/components/ui/ModelCard';

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
  };
});

jest.mock('../../../src/components/ui/button', () => {
  const mockReact = require('react');
  const { Pressable, Text } = require('react-native');
  return {
    Button: ({ children, onPress, ...props }: any) => mockReact.createElement(Pressable, { onPress, ...props }, children),
    ButtonText: ({ children, ...props }: any) => mockReact.createElement(Text, props, children),
  };
});

function buildModel(accessState: ModelAccessState): ModelMetadata {
  return {
    id: 'org/model',
    name: 'Model',
    author: 'org',
    size: 1024,
    downloadUrl: 'https://huggingface.co/org/model/resolve/main/model.gguf',
    fitsInRam: true,
    accessState,
    isGated: accessState !== ModelAccessState.PUBLIC,
    isPrivate: false,
    lifecycleStatus: LifecycleStatus.AVAILABLE,
    downloadProgress: 0,
  };
}

describe('ModelCard', () => {
  it('renders a token CTA for auth-required models', () => {
    const onConfigureToken = jest.fn();
    const screen = render(
      <ModelCard
        model={buildModel(ModelAccessState.AUTH_REQUIRED)}
        onDownload={jest.fn()}
        onConfigureToken={onConfigureToken}
        onOpenModelPage={jest.fn()}
        onLoad={jest.fn()}
        onUnload={jest.fn()}
        onDelete={jest.fn()}
        onCancel={jest.fn()}
        onChat={jest.fn()}
        isActive={false}
      />,
    );

    expect(screen.getByText('models.requiresToken')).toBeTruthy();
    fireEvent.press(screen.getByText('models.setToken'));
    expect(onConfigureToken).toHaveBeenCalledTimes(1);
  });

  it('renders an open-on-hf CTA for access-denied models', () => {
    const onOpenModelPage = jest.fn();
    const screen = render(
      <ModelCard
        model={buildModel(ModelAccessState.ACCESS_DENIED)}
        onDownload={jest.fn()}
        onConfigureToken={jest.fn()}
        onOpenModelPage={onOpenModelPage}
        onLoad={jest.fn()}
        onUnload={jest.fn()}
        onDelete={jest.fn()}
        onCancel={jest.fn()}
        onChat={jest.fn()}
        isActive={false}
      />,
    );

    expect(screen.getByText('models.accessDenied')).toBeTruthy();
    fireEvent.press(screen.getByText('models.openOnHuggingFace'));
    expect(onOpenModelPage).toHaveBeenCalledWith('org/model');
  });
});
