import React, { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';
import { Box } from '@/components/ui/box';
import { MarkdownRenderer } from './MarkdownRenderer';

interface Props {
    role: 'user' | 'assistant';
    content: string;
    isStreaming: boolean;
}

export function MessageBubble({ role, content, isStreaming }: Props) {
    const [announced, setAnnounced] = useState(false);

    useEffect(() => {
        // Suppress chatter during stream, announce when finished.
        if (!isStreaming && !announced && role === 'assistant') {
            AccessibilityInfo.announceForAccessibility('Assistant completed response.');
            setAnnounced(true);
        }
    }, [isStreaming, announced, role]);

    return (
        <Box
            className={`max-w-4/5 p-3 my-1.5 rounded-xl ${
                role === 'user' 
                    ? 'self-end bg-success-200 rounded-br-sm' 
                    : 'self-start bg-background-0 rounded-bl-sm border border-outline-200'
            }`}
            // Suppress screen reader chatter during token streaming
            // Read out the entire block only when not streaming or focused
            importantForAccessibility={isStreaming ? 'no-hide-descendants' : 'yes'}
            accessibilityLiveRegion={isStreaming ? 'none' : 'polite'}
        >
            <MarkdownRenderer content={content} />
        </Box>
    );
}
