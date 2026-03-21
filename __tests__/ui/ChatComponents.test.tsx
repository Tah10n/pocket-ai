import React from 'react';
import { render } from '@testing-library/react-native';
import { ChatMessageBubble } from '../../src/components/ui/ChatMessageBubble';
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

jest.mock('../../src/components/ui/StreamingCursor', () => {
    const mockReact = require('react');
    const { Text } = require('react-native');
    return {
        StreamingCursor: () => mockReact.createElement(Text, null, '|'),
    };
});

jest.mock('../../src/components/ui/MaterialSymbols', () => {
    const mockReact = require('react');
    const { Text } = require('react-native');
    return {
        MaterialSymbols: ({ name }: any) => mockReact.createElement(Text, null, name),
    };
});

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

describe('ChatMessageBubble', () => {
    it('renders a user bubble with plain text', () => {
        const { getByText } = render(
            <ChatMessageBubble id="user-1" isUser content="Hello AI" isStreaming={false} />
        );
        expect(getByText('Hello AI')).toBeTruthy();
    });

    it('renders an assistant bubble', () => {
        const { getByText } = render(
            <ChatMessageBubble id="assistant-1" isUser={false} content="Hello Human" isStreaming={false} />
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
