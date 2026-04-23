import React from 'react';
import { render } from '@testing-library/react-native';
import { ChatSystemEventRow } from '../../../src/components/ui/ChatSystemEventRow';

const reactI18nextMock = jest.requireMock('react-i18next') as {
  __setTranslationOverride: (key: string, value: string, nextLanguage?: string) => void;
  __resetTranslations: () => void;
};

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

describe('ChatSystemEventRow', () => {
  beforeEach(() => {
    reactI18nextMock.__resetTranslations();
    reactI18nextMock.__setTranslationOverride('chat.modelSwitchedLine', '{{from}} → {{to}}');
  });

  it('falls back to the default unknown labels and test id', () => {
    const screen = render(
      <ChatSystemEventRow fromModelId="" toModelId="" />,
    );

    expect(screen.getByTestId('chat-model-switch-row')).toBeTruthy();
    expect(screen.getByText('common.unknown → common.unknown')).toBeTruthy();
  });

  it('renders explicit model labels and a custom row id', () => {
    const screen = render(
      <ChatSystemEventRow id="event-1" fromModelId="author/model-a" toModelId="author/model-b" />,
    );

    expect(screen.getByTestId('chat-model-switch-row-event-1')).toBeTruthy();
    expect(screen.getByText('model-a → model-b')).toBeTruthy();
  });
});
