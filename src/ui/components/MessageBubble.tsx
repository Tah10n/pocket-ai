import React, { useEffect, useState } from 'react';
import { View, StyleSheet, AccessibilityInfo } from 'react-native';
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
        <View
            style={[styles.bubble, role === 'user' ? styles.userBubble : styles.assistantBubble]}
            // Suppress screen reader chatter during token streaming
            // Read out the entire block only when not streaming or focused
            importantForAccessibility={isStreaming ? 'no-hide-descendants' : 'yes'}
            accessibilityLiveRegion={isStreaming ? 'none' : 'polite'}
        >
            <MarkdownRenderer content={content} />
        </View>
    );
}

const styles = StyleSheet.create({
    bubble: {
        maxWidth: '85%',
        padding: 12,
        marginVertical: 6,
        borderRadius: 12,
    },
    userBubble: {
        alignSelf: 'flex-end',
        backgroundColor: '#DCF8C6',
        borderBottomRightRadius: 2,
    },
    assistantBubble: {
        alignSelf: 'flex-start',
        backgroundColor: '#FFFFFF',
        borderBottomLeftRadius: 2,
        borderColor: '#E5E5E5',
        borderWidth: 1,
    }
});
