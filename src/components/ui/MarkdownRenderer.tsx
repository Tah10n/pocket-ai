import React from 'react';
import { Linking, Text as RNText } from 'react-native';
import Markdown from 'react-native-markdown-display';
import { CodeBlock } from './CodeBlock';
import { useTheme } from '../../providers/ThemeProvider';

interface MarkdownRendererProps {
  content: string;
  selectable?: boolean;
}

const CHAT_MESSAGE_FONT_SIZE = 16;
const CHAT_MESSAGE_LINE_HEIGHT = 24;

function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function openMarkdownUrl(url: string, customCallback?: (url: string) => boolean) {
  if (!url || !isSafeUrl(url)) {
    return;
  }

  if (customCallback) {
    const result = customCallback(url);
    if (result && typeof result === 'boolean') {
      void Linking.openURL(url);
    }
    return;
  }

  void Linking.openURL(url);
}

export function MarkdownRenderer({ content, selectable = false }: MarkdownRendererProps) {
  const { colors } = useTheme();

  return (
    <Markdown
      style={{
        // react-native-markdown-display uses View wrappers for body/paragraph,
        // so the readable theme color has to live on text-bearing rules as well.
        text: {
          color: colors.text,
          fontSize: CHAT_MESSAGE_FONT_SIZE,
          lineHeight: CHAT_MESSAGE_LINE_HEIGHT,
        },
        body: {
          color: colors.text,
        },
        paragraph: {
          marginTop: 0,
          marginBottom: 10,
        },
        heading1: {
          color: colors.text,
          fontSize: CHAT_MESSAGE_FONT_SIZE,
          lineHeight: CHAT_MESSAGE_LINE_HEIGHT,
          fontWeight: '700',
          marginBottom: 10,
        },
        heading2: {
          color: colors.text,
          fontSize: CHAT_MESSAGE_FONT_SIZE,
          lineHeight: CHAT_MESSAGE_LINE_HEIGHT,
          fontWeight: '700',
          marginBottom: 10,
        },
        heading3: {
          color: colors.text,
          fontSize: CHAT_MESSAGE_FONT_SIZE,
          lineHeight: CHAT_MESSAGE_LINE_HEIGHT,
          fontWeight: '700',
          marginBottom: 8,
        },
        heading4: {
          color: colors.text,
          fontSize: CHAT_MESSAGE_FONT_SIZE,
          lineHeight: CHAT_MESSAGE_LINE_HEIGHT,
          fontWeight: '700',
          marginBottom: 8,
        },
        heading5: {
          color: colors.text,
          fontSize: CHAT_MESSAGE_FONT_SIZE,
          lineHeight: CHAT_MESSAGE_LINE_HEIGHT,
          fontWeight: '700',
          marginBottom: 6,
        },
        heading6: {
          color: colors.text,
          fontSize: CHAT_MESSAGE_FONT_SIZE,
          lineHeight: CHAT_MESSAGE_LINE_HEIGHT,
          fontWeight: '700',
          marginBottom: 6,
        },
        bullet_list: {
          marginVertical: 8,
        },
        ordered_list: {
          marginVertical: 8,
        },
        list_item: {
          color: colors.text,
        },
        bullet_list_icon: {
          color: colors.textSecondary,
        },
        ordered_list_icon: {
          color: colors.textSecondary,
        },
        strong: {
          color: colors.text,
          fontWeight: '700',
        },
        em: {
          color: colors.text,
          fontStyle: 'italic',
        },
        s: {
          color: colors.textSecondary,
          textDecorationLine: 'line-through',
        },
        link: {
          color: colors.primaryStrong,
          textDecorationLine: 'underline',
        },
        blockquote: {
          backgroundColor: colors.surfaceMuted,
          borderColor: colors.borderStrong,
          borderLeftWidth: 4,
          marginLeft: 0,
          paddingHorizontal: 10,
          paddingVertical: 8,
        },
        code_inline: {
          color: colors.text,
          backgroundColor: colors.surfaceMuted,
          borderColor: colors.border,
          borderWidth: 1,
          borderRadius: 6,
          paddingHorizontal: 6,
          paddingVertical: 2,
        },
        code_block: {
          color: colors.text,
          backgroundColor: colors.surfaceMuted,
          borderColor: colors.border,
          borderWidth: 1,
          borderRadius: 8,
          padding: 10,
        },
        textgroup: {
          color: colors.text,
        },
        hr: {
          backgroundColor: colors.borderSubtle,
          height: 1,
        },
      }}
      rules={{
        text: (node: any, _children: React.ReactNode[], _parent: any[], styles: any, inheritedStyles: any = {}) => (
          <RNText key={node.key} selectable={selectable} style={[inheritedStyles, styles.text]}>
            {node.content}
          </RNText>
        ),
        strong: (node: any, children: React.ReactNode[], _parent: any[], styles: any) => (
          <RNText key={node.key} selectable={selectable} style={styles.strong}>
            {children}
          </RNText>
        ),
        em: (node: any, children: React.ReactNode[], _parent: any[], styles: any) => (
          <RNText key={node.key} selectable={selectable} style={styles.em}>
            {children}
          </RNText>
        ),
        s: (node: any, children: React.ReactNode[], _parent: any[], styles: any) => (
          <RNText key={node.key} selectable={selectable} style={styles.s}>
            {children}
          </RNText>
        ),
        link: (node: any, children: React.ReactNode[], _parent: any[], styles: any, onLinkPress?: (url: string) => boolean) => (
          <RNText
            key={node.key}
            selectable={selectable}
            style={styles.link}
            onPress={() => openMarkdownUrl(node.attributes.href, onLinkPress)}
          >
            {children}
          </RNText>
        ),
        code_inline: (node: any, _children: React.ReactNode[], _parent: any[], styles: any, inheritedStyles: any = {}) => (
          <RNText key={node.key} selectable={selectable} style={[inheritedStyles, styles.code_inline]}>
            {node.content}
          </RNText>
        ),
        fence: (node: any) => (
          <CodeBlock
            key={`fence-${node.key ?? node.content?.slice(0, 24) ?? 'block'}`}
            code={node.content}
            language={typeof node.sourceInfo === 'string' ? node.sourceInfo : undefined}
          />
        ),
      }}
    >
      {content}
    </Markdown>
  );
}
