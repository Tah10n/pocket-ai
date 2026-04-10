import React from 'react';
import { render } from '@testing-library/react-native';
import { Linking } from 'react-native';
import { MarkdownRenderer } from '../../src/components/ui/MarkdownRenderer';

jest.mock('react-native-markdown-display', () => {
  const mockReact = require('react');
  const { View } = require('react-native');

  return ({ children, style, rules }: any) => mockReact.createElement(
    View,
    {
      testID: 'markdown-root',
      markdownStyle: style,
      markdownRules: rules,
    },
    children,
  );
});

jest.mock('../../src/providers/ThemeProvider', () => ({
  useTheme: () => ({
    colors: {
      text: '#f7fbff',
      textSecondary: '#a9b9cf',
      primaryStrong: '#5da9ff',
      border: '#45556b',
      borderStrong: '#61728a',
      borderSubtle: 'rgba(69, 85, 107, 0.7)',
      surfaceMuted: 'rgba(36, 49, 70, 0.92)',
    },
  }),
}));

jest.mock('../../src/components/ui/CodeBlock', () => ({
  CodeBlock: () => null,
}));

describe('MarkdownRenderer theme styles', () => {
  it('uses theme-aware colors for markdown text content', () => {
    const { getByTestId } = render(
      <MarkdownRenderer content={'**Bold** [link](https://example.com) `inline`'} />,
    );

    const style = getByTestId('markdown-root').props.markdownStyle;

    expect(style.text.color).toBe('#f7fbff');
    expect(style.strong.color).toBe('#f7fbff');
    expect(style.link.color).toBe('#5da9ff');
    expect(style.bullet_list_icon.color).toBe('#a9b9cf');
    expect(style.code_inline.color).toBe('#f7fbff');
    expect(style.code_inline.backgroundColor).toBe('rgba(36, 49, 70, 0.92)');
  });

  it('keeps markdown typography aligned with regular chat text and exposes selectable rules', () => {
    const { getByTestId } = render(
      <MarkdownRenderer content={'# Heading\n\nBody'} selectable />,
    );

    const root = getByTestId('markdown-root');
    const style = root.props.markdownStyle;
    const rules = root.props.markdownRules;

    expect(style.text.fontSize).toBe(16);
    expect(style.text.lineHeight).toBe(24);
    expect(style.heading1.fontSize).toBe(16);
    expect(style.heading1.lineHeight).toBe(24);

    const textRuleElement = rules.text(
      { key: 'text-1', content: 'Body' },
      [],
      [],
      { text: style.text },
      {},
    );
    expect(textRuleElement.props.selectable).toBe(true);

    const textgroupRuleElement = rules.textgroup(
      { key: 'textgroup-1' },
      ['Body'],
      [],
      { textgroup: style.textgroup },
    );
    expect(textgroupRuleElement.props.selectable).toBe(true);

    const linkRuleElement = rules.link(
      { key: 'link-1', attributes: { href: 'https://example.com' } },
      ['Link'],
      [],
      { link: style.link },
    );
    expect(linkRuleElement.props.selectable).toBe(true);
  });

  it('keeps markdown text selection disabled by default for grouped text', () => {
    const { getByTestId } = render(
      <MarkdownRenderer content={'Body'} />,
    );

    const root = getByTestId('markdown-root');
    const rules = root.props.markdownRules;
    const style = root.props.markdownStyle;

    const textgroupRuleElement = rules.textgroup(
      { key: 'textgroup-1' },
      ['Body'],
      [],
      { textgroup: style.textgroup },
    );

    expect(textgroupRuleElement.props.selectable).toBe(false);
  });

  it('passes selectable through to fenced code blocks', () => {
    const { getByTestId } = render(
      <MarkdownRenderer content={'```ts\nconst x = 1;\n```'} selectable />,
    );

    const root = getByTestId('markdown-root');
    const rules = root.props.markdownRules;

    const fenceRuleElement = rules.fence({
      key: 'fence-1',
      content: 'const x = 1;',
      sourceInfo: 'ts',
    });

    expect(fenceRuleElement.props.selectable).toBe(true);
  });

  it('allows consumers to handle non-http(s) link schemes via onLinkPress', () => {
    const openUrlSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(true as any);

    const { getByTestId } = render(
      <MarkdownRenderer content={'[mail](mailto:help@example.com)'} selectable />,
    );

    const root = getByTestId('markdown-root');
    const rules = root.props.markdownRules;
    const style = root.props.markdownStyle;

    const mailtoUrl = 'mailto:help@example.com';
    const onLinkPress = jest.fn(() => true);
    const linkRuleElement = rules.link(
      { key: 'link-mailto', attributes: { href: mailtoUrl } },
      ['mail'],
      [],
      { link: style.link },
      onLinkPress,
    );

    linkRuleElement.props.onPress();
    expect(onLinkPress).toHaveBeenCalledWith(mailtoUrl);
    expect(openUrlSpy).toHaveBeenCalledWith(mailtoUrl);

    openUrlSpy.mockClear();
    const linkRuleNoCallback = rules.link(
      { key: 'link-mailto-2', attributes: { href: mailtoUrl } },
      ['mail'],
      [],
      { link: style.link },
    );
    linkRuleNoCallback.props.onPress();
    expect(openUrlSpy).not.toHaveBeenCalled();
  });
});
