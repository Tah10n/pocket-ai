import React from 'react';
import Markdown from 'react-native-markdown-display';
import { CodeBlock } from './CodeBlock';

interface MarkdownRendererProps {
  content: string;
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  return (
    <Markdown
      style={{
        body: {
          color: '#111827',
          fontSize: 16,
          lineHeight: 24,
        },
        heading1: {
          fontSize: 24,
          fontWeight: '700',
          marginBottom: 12,
        },
        heading2: {
          fontSize: 20,
          fontWeight: '700',
          marginBottom: 10,
        },
        bullet_list: {
          marginVertical: 8,
        },
        ordered_list: {
          marginVertical: 8,
        },
        strong: {
          fontWeight: '700',
        },
      }}
      rules={{
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
