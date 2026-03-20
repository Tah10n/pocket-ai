import { useState, useCallback, useEffect, useRef } from 'react';
import { llmEngineService } from '../services/LLMEngineService';
import { EngineStatus } from '../types/models';
import { getSettings, saveChatHistory } from '../services/SettingsStore';

export interface ChatMessage {
  id: string;
  isUser: boolean;
  content: string;
  isStreaming?: boolean;
  tokensPerSec?: number;
}

function createSessionId() {
  return `chat-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export const useChatSession = () => {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [isGenerating, setIsGenerating] = useState(false);
    const sessionIdRef = useRef<string>(createSessionId());
    const createdAtRef = useRef<number | null>(null);

    useEffect(() => {
        if (messages.length === 0) {
            return;
        }

        const persistedMessages = messages
            .filter((message) => message.isUser || message.content.trim().length > 0)
            .map((message) => ({
                role: message.isUser ? 'user' as const : 'assistant' as const,
                content: message.content,
            }));

        if (persistedMessages.length === 0) {
            return;
        }

        const timestamp = createdAtRef.current ?? Date.now();
        createdAtRef.current = timestamp;

        const settings = getSettings();
        saveChatHistory({
            id: sessionIdRef.current,
            messages: persistedMessages,
            modelId: settings.activeModelId ?? 'No Model',
            presetId: settings.activePresetId,
            createdAt: timestamp,
            updatedAt: Date.now(),
        });
    }, [messages]);
    
    const appendUserMessage = useCallback(async (text: string) => {
        const newMsg: ChatMessage = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            isUser: true,
            content: text
        };
        
        setMessages(prev => [...prev, newMsg]);
        setIsGenerating(true);
        
        const replyId = `${Date.now() + 1}-${Math.random().toString(36).slice(2, 9)}`;
        setMessages(prev => [...prev, {
            id: replyId,
            isUser: false,
            content: '',
            isStreaming: true,
            tokensPerSec: 0
        }]);
        
        let currentText = "";

        try {
            if (llmEngineService.getState().status !== EngineStatus.READY) {
                throw new Error("Model is not loaded or engine is not ready. Please select and load a model in the Models tab.");
            }

            let tokensCount = 0;
            const startTime = Date.now();

            await llmEngineService.chatCompletion(
                text,
                "You are a helpful AI assistant. Answer concisely and accurately.",
                (token) => {
                    currentText += token;
                    tokensCount++;
                    const elapsedSec = (Date.now() - startTime) / 1000;
                    const ts = elapsedSec > 0 ? tokensCount / elapsedSec : 0;
                    
                    setMessages(prev => prev.map(m => 
                        m.id === replyId ? { ...m, content: currentText, tokensPerSec: ts } : m
                    ));
                }
            );

            // Finalize streaming
            setMessages(prev => prev.map(m => 
                m.id === replyId ? { ...m, isStreaming: false } : m
            ));

        } catch (e: any) {
            setMessages(prev => prev.map(m => 
                m.id === replyId ? { ...m, content: currentText + (currentText.length > 0 ? '\n\n' : '') + `[Error: ${e.message}]`, isStreaming: false } : m
            ));
        } finally {
            setIsGenerating(false);
        }
        
    }, []);

    return {
        messages,
        isGenerating,
        appendUserMessage
    };
};
