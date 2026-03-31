import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../../src/types/models';
import { ModelCard } from '../../../src/components/ui/ModelCard';

const mockScreenBadge = jest.fn();

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

jest.mock('../../../src/components/ui/button', () => {
  const mockReact = require('react');
  const { Pressable, Text } = require('react-native');
  return {
    Button: ({ children, onPress, ...props }: any) => mockReact.createElement(Pressable, { onPress, ...props }, children),
    ButtonText: ({ children, ...props }: any) => mockReact.createElement(Text, props, children),
  };
});

jest.mock('../../../src/components/ui/ScreenShell', () => {
  const mockReact = require('react');
  const { Pressable, Text, View } = require('react-native');
  return {
    ScreenCard: ({ children, ...props }: any) => mockReact.createElement(View, props, children),
    ScreenActionPill: ({ children, onPress, ...props }: any) =>
      mockReact.createElement(Pressable, { onPress, ...props }, children),
    ScreenIconButton: ({ onPress, ...props }: any) =>
      mockReact.createElement(Pressable, { onPress, ...props }),
    ScreenBadge: (props: any) => {
      mockScreenBadge(props);
      return mockReact.createElement(Text, props, props.children);
    },
  };
});

jest.mock('../../../src/components/ui/pressable', () => {
  const mockReact = require('react');
  const { Pressable } = require('react-native');
  return {
    Pressable: ({ children, ...props }: any) => mockReact.createElement(Pressable, props, children),
  };
});

jest.mock('../../../src/components/ui/MaterialSymbols', () => {
  const mockReact = require('react');
  const { Text } = require('react-native');
  return {
    MaterialSymbols: ({ name }: any) => mockReact.createElement(Text, null, name),
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
  beforeEach(() => {
    mockScreenBadge.mockClear();
  });

  it('renders a token CTA for auth-required models', () => {
    const onConfigureToken = jest.fn();
    const onOpenDetails = jest.fn();
    const screen = render(
      <ModelCard
        model={buildModel(ModelAccessState.AUTH_REQUIRED)}
        onOpenDetails={onOpenDetails}
        onDownload={jest.fn()}
        onConfigureToken={onConfigureToken}
        onOpenModelPage={jest.fn()}
        onLoad={jest.fn()}
        onOpenSettings={jest.fn()}
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
    fireEvent.press(screen.getByTestId('model-details-org/model'));
    expect(onOpenDetails).toHaveBeenCalledWith('org/model');
  });

  it('renders an open-on-hf CTA for access-denied models', () => {
    const onOpenModelPage = jest.fn();
    const screen = render(
      <ModelCard
        model={buildModel(ModelAccessState.ACCESS_DENIED)}
        onOpenDetails={jest.fn()}
        onDownload={jest.fn()}
        onConfigureToken={jest.fn()}
        onOpenModelPage={onOpenModelPage}
        onLoad={jest.fn()}
        onOpenSettings={jest.fn()}
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

  it('rerenders visible model text when name or author changes', () => {
    const screen = render(
      <ModelCard
        model={buildModel(ModelAccessState.PUBLIC)}
        onOpenDetails={jest.fn()}
        onDownload={jest.fn()}
        onConfigureToken={jest.fn()}
        onOpenModelPage={jest.fn()}
        onLoad={jest.fn()}
        onOpenSettings={jest.fn()}
        onUnload={jest.fn()}
        onDelete={jest.fn()}
        onCancel={jest.fn()}
        onChat={jest.fn()}
        isActive={false}
      />,
    );

    expect(screen.getByText('Model')).toBeTruthy();
    expect(screen.getByText('org')).toBeTruthy();

    screen.rerender(
      <ModelCard
        model={{
          ...buildModel(ModelAccessState.PUBLIC),
          name: 'Updated Model',
          author: 'updated-org',
        }}
        onOpenDetails={jest.fn()}
        onDownload={jest.fn()}
        onConfigureToken={jest.fn()}
        onOpenModelPage={jest.fn()}
        onLoad={jest.fn()}
        onOpenSettings={jest.fn()}
        onUnload={jest.fn()}
        onDelete={jest.fn()}
        onCancel={jest.fn()}
        onChat={jest.fn()}
        isActive={false}
      />,
    );

    expect(screen.getByText('Updated Model')).toBeTruthy();
    expect(screen.getByText('updated-org')).toBeTruthy();
  });

  it('renders a settings CTA for downloaded models', () => {
    const onOpenSettings = jest.fn();
    const screen = render(
      <ModelCard
        model={{
          ...buildModel(ModelAccessState.PUBLIC),
          lifecycleStatus: LifecycleStatus.DOWNLOADED,
        }}
        onOpenDetails={jest.fn()}
        onDownload={jest.fn()}
        onConfigureToken={jest.fn()}
        onOpenModelPage={jest.fn()}
        onLoad={jest.fn()}
        onOpenSettings={onOpenSettings}
        onUnload={jest.fn()}
        onDelete={jest.fn()}
        onCancel={jest.fn()}
        onChat={jest.fn()}
        isActive={false}
      />,
    );

    fireEvent.press(screen.getByText('models.settings'));

    expect(onOpenSettings).toHaveBeenCalledWith('org/model');
  });

  it('keeps a settings CTA for active models', () => {
    const onOpenSettings = jest.fn();
    const screen = render(
      <ModelCard
        model={{
          ...buildModel(ModelAccessState.PUBLIC),
          lifecycleStatus: LifecycleStatus.ACTIVE,
        }}
        onOpenDetails={jest.fn()}
        onDownload={jest.fn()}
        onConfigureToken={jest.fn()}
        onOpenModelPage={jest.fn()}
        onLoad={jest.fn()}
        onOpenSettings={onOpenSettings}
        onUnload={jest.fn()}
        onDelete={jest.fn()}
        onCancel={jest.fn()}
        onChat={jest.fn()}
        isActive
      />,
    );

    fireEvent.press(screen.getByText('models.settings'));

    expect(onOpenSettings).toHaveBeenCalledWith('org/model');
  });

  it('renders the active badge with success tone', () => {
    render(
      <ModelCard
        model={{
          ...buildModel(ModelAccessState.PUBLIC),
          lifecycleStatus: LifecycleStatus.ACTIVE,
        }}
        onOpenDetails={jest.fn()}
        onDownload={jest.fn()}
        onConfigureToken={jest.fn()}
        onOpenModelPage={jest.fn()}
        onLoad={jest.fn()}
        onOpenSettings={jest.fn()}
        onUnload={jest.fn()}
        onDelete={jest.fn()}
        onCancel={jest.fn()}
        onChat={jest.fn()}
        isActive
      />,
    );

    expect(
      mockScreenBadge.mock.calls.some(([props]) => props.tone === 'success' && props.children === 'common.active'),
    ).toBe(true);
  });
});
