import React from 'react';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import Markdown, { MarkdownIt } from 'react-native-markdown-display';
import * as Clipboard from 'expo-clipboard';
import { MaterialSymbols } from '../../components/ui/MaterialSymbols';

interface MarkdownRendererProps {
    content: string;
}

export const MarkdownRenderer = ({ content }: MarkdownRendererProps) => {
    const copyToClipboard = async (text: string) => {
        await Clipboard.setStringAsync(text);
    };

    const rules = {
        fence: (node: any, children: any, parent: any, styles: any) => {
            const codeContent = node.content;
            return (
                <Box key={node.key} className="my-3 bg-background-100 dark:bg-background-800 rounded-xl border border-outline-200 dark:border-outline-700 overflow-hidden">
                    <Box className="flex-row justify-between items-center px-4 py-2 bg-background-200/50 dark:bg-background-700/50 border-b border-outline-200 dark:border-outline-700">
                        <Text className="text-xs font-bold text-typography-500 uppercase tracking-tighter">Code Snippet</Text>
                        <Pressable 
                            onPress={() => copyToClipboard(codeContent)}
                            className="flex-row items-center gap-1.5 active:opacity-70 bg-primary-500/10 px-2 py-1 rounded-md"
                        >
                            <MaterialSymbols name="content-copy" size={14} className="text-primary-600" />
                            <Text className="text-2xs font-bold text-primary-600 uppercase">Copy Code</Text>
                        </Pressable>
                    </Box>
                    <Box className="p-4">
                        <Text className="text-sm font-mono text-typography-800 dark:text-typography-200">{codeContent}</Text>
                    </Box>
                </Box>
            );
        },
    };

    return (
        <Markdown
            rules={rules}
            style={{
                body: {
                    color: 'inherit',
                    fontSize: 16,
                    lineHeight: 24,
                },
                paragraph: {
                    marginBottom: 12,
                },
                strong: {
                    fontWeight: 'bold',
                },
                em: {
                    fontStyle: 'italic',
                },
                code_inline: {
                    backgroundColor: 'rgba(0,0,0,0.05)',
                    paddingHorizontal: 4,
                    borderRadius: 4,
                    fontFamily: 'monospace',
                },
            }}
        >
            {content}
        </Markdown>
    );
};
