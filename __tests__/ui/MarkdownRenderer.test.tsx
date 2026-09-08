import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { Image, Linking } from 'react-native';
import { MarkdownRenderer } from '../../src/components/ui/MarkdownRenderer';

jest.mock('react-native-css-interop', () => {
  const mockReact = require('react');
  return {
    createInteropElement: mockReact.createElement,
  };
});

jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn(),
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
    Text: ({ children }: any) => mockReact.createElement(Text, null, children),
  };
});

jest.mock('@/components/ui/pressable', () => {
  const mockReact = require('react');
  const { Pressable } = require('react-native');
  return {
    Pressable: ({ children, ...props }: any) => mockReact.createElement(Pressable, props, children),
  };
});

describe('MarkdownRenderer', () => {
  it('renders headings, lists, and bold text', () => {
    const { getByText } = render(
      <MarkdownRenderer content={'# Heading\n\n- item one\n- item two\n\nThis is **bold** text.'} />,
    );

    expect(getByText('Heading')).toBeTruthy();
    expect(getByText('item one')).toBeTruthy();
    expect(getByText('item two')).toBeTruthy();
    expect(getByText('bold')).toBeTruthy();
  });

  it('blocks every Markdown image source without creating a native image', () => {
    const content = [
      '![http image](http://tracker.example/pixel)',
      '![https image](https://tracker.example/pixel)',
      '![data image](data:image/png;base64,AAAA)',
      '![relative image](./pixel.png)',
      '![protocol relative](//tracker.example/pixel)',
      '[![linked image](https://tracker.example/linked)](https://example.com)',
      '![reference image][remote]',
      '',
      '[remote]: https://tracker.example/reference',
    ].join('\n\n');

    const screen = render(<MarkdownRenderer content={content} />);

    for (const label of [
      'http image',
      'https image',
      'data image',
      'relative image',
      'protocol relative',
      'linked image',
      'reference image',
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.UNSAFE_queryAllByType(Image)).toHaveLength(0);
  });

  it('renders a safe fallback for an image without alt text', () => {
    const screen = render(<MarkdownRenderer content={'![](https://tracker.example/pixel)'} />);

    expect(screen.getByText('chat.remoteImageBlocked')).toBeTruthy();
    expect(screen.UNSAFE_queryAllByType(Image)).toHaveLength(0);
  });

  it('blocks unsafe block links around remote-image fallbacks', () => {
    const openUrl = jest.spyOn(Linking, 'openURL').mockResolvedValueOnce(undefined);
    const screen = render(
      <MarkdownRenderer
        content={'[![unsafe linked image](https://tracker.example/pixel)](intent://settings)\n\n[![phone linked image](https://tracker.example/pixel)](tel:+123456789)\n\n[![safe linked image](https://tracker.example/pixel)](https://example.com)'}
      />,
    );

    fireEvent.press(screen.getByText('unsafe linked image'));
    fireEvent.press(screen.getByText('phone linked image'));
    expect(openUrl).not.toHaveBeenCalled();

    fireEvent.press(screen.getByText('safe linked image'));
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith('https://example.com');
  });
});
