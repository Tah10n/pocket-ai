import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { MessageBubble } from '../../src/ui/components/MessageBubble';
import { MarkdownRenderer } from '../../src/ui/components/MarkdownRenderer';

describe('MessageBubble', () => {
    it('renders user message correctly', () => {
        const { getByText } = render(
            <MessageBubble role="user" content="Hello AI" isStreaming={false} />
        );
        expect(getByText('Hello AI')).toBeTruthy();
    });

    it('renders assistant message correctly', () => {
        const { getByText } = render(
            <MessageBubble role="assistant" content="Hello Human" isStreaming={false} />
        );
        expect(getByText('Hello Human')).toBeTruthy();
    });
});

describe('MarkdownRenderer', () => {
    it('renders plain text', () => {
        const { getByText } = render(<MarkdownRenderer content="Simple text" />);
        expect(getByText('Simple text')).toBeTruthy();
    });

    it('renders code blocks with Copy Code button', () => {
        const content = 'Before code\n```js\nconsole.log("hi")\n```\nAfter code';
        const { getByText } = render(<MarkdownRenderer content={content} />);
        expect(getByText('Copy Code')).toBeTruthy();
    });
});
