import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TextInput, Button, FlatList, StyleSheet, Alert, KeyboardAvoidingView, Platform } from 'react-native';
import { MessageBubble } from '../components/MessageBubble';
import { llmEngineService } from '../../services/LLMEngineService';
import { hardwareListenerService, HardwareStatus } from '../../services/HardwareListenerService';
import { ModelMetadata } from '../../services/ModelCatalogService';

interface Message {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    isStreaming: boolean;
}

export function ChatScreen({ route }: any) {
    const model: ModelMetadata = route?.params?.model || { id: 'default', contextWindow: 4096 };

    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState('');
    const [isGenerating, setIsGenerating] = useState(false);
    const [hwStatus, setHwStatus] = useState<HardwareStatus>(hardwareListenerService.getCurrentStatus());
    const flatListRef = useRef<FlatList>(null);

    // Auto-summarization context tracking (simplified)
    const [tokenCount, setTokenCount] = useState(0);

    useEffect(() => {
        const unsub = hardwareListenerService.subscribe((status) => {
            setHwStatus(status);
            if (status.isLowMemory) {
                Alert.alert('Memory Warning', 'The OS is running low on memory. The model might be unloaded.');
            }
        });
        return () => { unsub(); };
    }, []);

    const summarizeContextIfNecessary = async () => {
        // 4.6 Auto-Summarization logic (detect >80% context limit)
        const threshold = model.contextWindow * 0.8;
        if (tokenCount > threshold && messages.length > 4) {
            const messagesToSummarize = messages.slice(0, -2);
            const historyText = messagesToSummarize.map(m => `${m.role}: ${m.content}`).join('\n');
            const summaryPrompt = `Summarize the following chat history concisely:\n\n${historyText}`;

            try {
                // Background summarization without streaming to UI
                const result = await llmEngineService.chatCompletion(
                    summaryPrompt,
                    'You are an assistant that summarizes conversations concisely.',
                    undefined,
                    { temperature: 0.3 }
                );

                const summaryMessage: Message = {
                    id: Date.now().toString(),
                    role: 'assistant',
                    content: `*Context auto-summarized:*\n${result.text}`,
                    isStreaming: false
                };

                setMessages(prev => [summaryMessage, ...prev.slice(-2)]);
                setTokenCount(Math.floor(result.text.length / 4) + 200); // Rought estimate
            } catch (e) {
                console.error('Background summarization failed', e);
            }
        }
    };

    const handleSend = async (customPrompt?: string) => {
        const text = customPrompt || input;
        if (!text.trim() || isGenerating) return;

        if (hwStatus.thermalState === 'critical' || hwStatus.thermalState === 'serious') {
            Alert.alert('Thermal Warning', 'Device is too hot. Generating text might be extremely slow.');
        }

        const userMessage: Message = { id: Date.now().toString(), role: 'user', content: text, isStreaming: false };
        const assistantMessage: Message = { id: (Date.now() + 1).toString(), role: 'assistant', content: '', isStreaming: true };

        setMessages(prev => [...prev, userMessage, assistantMessage]);
        setInput('');
        setIsGenerating(true);

        try {
            await llmEngineService.chatCompletion(
                text,
                undefined, // systemPrompt
                (token: string) => {
                    setMessages(prev => {
                        const newMessages = [...prev];
                        const lastIndex = newMessages.length - 1;
                        newMessages[lastIndex] = { ...newMessages[lastIndex], content: newMessages[lastIndex].content + token };
                        return newMessages;
                    });
                    setTokenCount(prev => prev + 1);
                },
            );
        } catch (e) {
            console.error(e);
            Alert.alert('Error', 'Generation failed or engine unavailable.');
        } finally {
            setIsGenerating(false);
            setMessages(prev => {
                const newMessages = [...prev];
                const lastIndex = newMessages.length - 1;
                newMessages[lastIndex].isStreaming = false;
                return newMessages;
            });
            await summarizeContextIfNecessary();
        }
    };

    const stopGeneration = async () => {
        await llmEngineService.stopCompletion();
        setIsGenerating(false);
    };

    const regenerate = () => {
        if (messages.length >= 2) {
            const lastUserMsg = messages.slice().reverse().find(m => m.role === 'user');
            if (lastUserMsg) {
                // Remove last assistant message
                setMessages(prev => prev.slice(0, prev.length - 1));
                handleSend(lastUserMsg.content);
            }
        }
    };

    return (
        <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            {hwStatus.thermalState === 'critical' && (
                <View style={styles.warningBanner}><Text style={styles.warningText}>Thermal Warning: Device is overheated!</Text></View>
            )}

            <FlatList
                ref={flatListRef}
                data={messages}
                keyExtractor={item => item.id}
                renderItem={({ item }) => <MessageBubble {...item} />}
                contentContainerStyle={styles.list}
                onContentSizeChange={() => flatListRef.current?.scrollToEnd()}
            />

            <View style={styles.inputContainer}>
                <TextInput
                    style={styles.input}
                    value={input}
                    onChangeText={setInput}
                    placeholder="Ask local AI..."
                    multiline
                    editable={!isGenerating}
                />
                {isGenerating ? (
                    <Button title="Stop" onPress={stopGeneration} color="red" />
                ) : (
                    <>
                        {messages.length > 0 && messages[messages.length - 1].role === 'assistant' && (
                            <Button title="Redo" onPress={regenerate} color="orange" />
                        )}
                        <Button title="Send" onPress={() => handleSend()} disabled={!input.trim()} />
                    </>
                )}
            </View>
        </KeyboardAvoidingView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#f5f5f5' },
    warningBanner: { backgroundColor: 'orange', padding: 8, alignItems: 'center' },
    warningText: { color: 'white', fontWeight: 'bold' },
    list: { padding: 16, paddingBottom: 32 },
    inputContainer: {
        flexDirection: 'row',
        padding: 12,
        borderTopWidth: 1,
        borderColor: '#e5e5e5',
        backgroundColor: 'white',
        alignItems: 'flex-end'
    },
    input: { flex: 1, borderWidth: 1, borderColor: '#ccc', borderRadius: 20, padding: 12, marginRight: 8, maxHeight: 120 }
});
