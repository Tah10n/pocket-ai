import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Clipboard } from 'react-native';

interface Props {
    content: string;
}

// A highly simplified markdown renderer for demonstration.
// In a full app, react-native-markdown-display or similar would be used.
export function MarkdownRenderer({ content }: Props) {
    const renderBlocks = () => {
        const blocks = content.split('```');
        return blocks.map((block, index) => {
            const isCode = index % 2 !== 0; // Odd indices are inside code blocks
            if (isCode) {
                const lines = block.split('\n');
                const lang = lines[0];
                const code = lines.slice(1).join('\n');
                return (
                    <View key={index} style={styles.codeContainer}>
                        <View style={styles.codeHeader}>
                            <Text style={styles.langText}>{lang}</Text>
                            <TouchableOpacity onPress={() => Clipboard.setString(code)}>
                                <Text style={styles.copyText}>Copy Code</Text>
                            </TouchableOpacity>
                        </View>
                        <Text style={styles.code}>{code}</Text>
                    </View>
                );
            }
            return <Text key={index} style={styles.text}>{block}</Text>;
        });
    };

    return <View style={styles.container}>{renderBlocks()}</View>;
}

const styles = StyleSheet.create({
    container: { flex: 1 },
    text: { fontSize: 16, lineHeight: 24, color: '#333' },
    codeContainer: {
        backgroundColor: '#1E1E1E',
        borderRadius: 8,
        marginVertical: 8,
        overflow: 'hidden'
    },
    codeHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        backgroundColor: '#333',
        padding: 8,
    },
    langText: { color: '#ccc', fontSize: 12 },
    copyText: { color: '#4CAF50', fontSize: 12, fontWeight: 'bold' },
    code: { padding: 12, fontFamily: 'monospace', color: '#D4D4D4' }
});
