import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { Image, Linking, StyleSheet, View } from 'react-native';
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

  it.each([
    ['bullet', '- Orange\n- Seven', ['Orange', 'Seven'], 2],
    ['ordered', '1. Orange\n2. Seven', ['Orange', 'Seven'], 2],
    ['nested', '- Orange\n  1. Seven\n  2. Nested detail', ['Orange', 'Seven', 'Nested detail'], 3],
  ] as const)('keeps %s list content intrinsic and shrinkable inside a content-sized chat bubble', (_kind, content, labels, expectedRows) => {
    const screen = render(<MarkdownRenderer content={content} selectable />);
    // Inspect the real parser/rules output, including merged library defaults.
    // A growing zero-basis list child measures as zero inside an auto-width bubble.
    const contentViews = screen.UNSAFE_getAllByType(View).filter(node => {
      const style = StyleSheet.flatten(node.props.style);
      return style?.flex !== undefined;
    });
    expect(contentViews).toHaveLength(expectedRows);
    for (const node of contentViews) {
      expect(StyleSheet.flatten(node.props.style)).toMatchObject({ flex: 0, flexShrink: 1 });
    }
    for (const label of labels) {
      expect(screen.getByText(label).props.selectable).toBe(true);
    }
  });

  it('preserves long list text, fenced code and table content without stretching all paragraphs', () => {
    const longText = 'A long list item remains readable and wraps within the available chat width. '.repeat(5).trim();
    const screen = render(<MarkdownRenderer content={`- ${longText}\n\n\`\`\`js\nconst answer = 7;\n\`\`\`\n\n| Color | Number |\n| --- | --- |\n| Orange | Seven |\n\nShort reply.`} selectable />);
    expect(screen.getByText(longText)).toBeTruthy();
    expect(screen.getByText('const answer = 7;')).toBeTruthy();
    expect(screen.getByText('Color')).toBeTruthy();
    expect(screen.getByText('Number')).toBeTruthy();
    expect(screen.getByText('Orange')).toBeTruthy();
    expect(screen.getByText('Seven')).toBeTruthy();
    expect(screen.getByText('Short reply.')).toBeTruthy();
  });
});
