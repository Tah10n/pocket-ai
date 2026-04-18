import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import { CodeBlock } from '../../src/components/ui/CodeBlock';

const en = require('../../src/i18n/locales/en.json');

const reactI18nextMock = jest.requireMock('react-i18next') as {
  __setTranslationOverride: (key: string, value: string, nextLanguage?: string) => void;
  __resetTranslations: () => void;
};

jest.useFakeTimers();

jest.mock('react-native-css-interop', () => {
  const mockReact = require('react');
  return {
    createInteropElement: mockReact.createElement,
  };
});

jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/components/ui/box', () => {
  const mockReact = require('react');
  const { View } = require('react-native');
  return {
    Box: ({ children }: any) => mockReact.createElement(View, null, children),
  };
});

jest.mock('@/components/ui/text', () => {
  const mockReact = require('react');
  const { Text } = require('react-native');
  return {
    Text: ({ children, className: _className, textRole: _textRole, ...props }: any) =>
      mockReact.createElement(Text, props, children),
  };
});

jest.mock('@/components/ui/pressable', () => {
  const mockReact = require('react');
  const { Pressable } = require('react-native');
  return {
    Pressable: ({ children, ...props }: any) => mockReact.createElement(Pressable, props, children),
  };
});

describe('CodeBlock', () => {
  beforeEach(() => {
    reactI18nextMock.__resetTranslations();
    reactI18nextMock.__setTranslationOverride('common.copy', en.common.copy);
    reactI18nextMock.__setTranslationOverride('common.copied', en.common.copied);
  });

  it('copies the code and shows temporary feedback', async () => {
    const { getByTestId, getByText, queryByText } = render(
      <CodeBlock language="ts" code={'const x = 1;'} />,
    );

    await act(async () => {
      fireEvent.press(getByTestId('copy-code-button'));
    });

    expect(Clipboard.setStringAsync).toHaveBeenCalledWith('const x = 1;');
    expect(getByText(en.common.copied)).toBeTruthy();

    await act(async () => {
      jest.advanceTimersByTime(1500);
    });

    expect(queryByText(en.common.copied)).toBeNull();
    expect(getByText(en.common.copy)).toBeTruthy();
  });

  it('respects selectable for the rendered code text', () => {
    const { getByText, rerender } = render(
      <CodeBlock language="ts" code={'const x = 1;'} />,
    );

    expect(getByText('const x = 1;').props.selectable).toBe(false);

    rerender(
      <CodeBlock language="ts" code={'const x = 1;'} selectable />,
    );

    expect(getByText('const x = 1;').props.selectable).toBe(true);
  });
});
