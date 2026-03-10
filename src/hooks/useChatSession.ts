import { useState, useCallback } from 'react';
import { llmEngineService } from '../services/LLMEngineService';

export interface ChatMessage {
  id: string;
  isUser: boolean;
  content: string;
  isStreaming?: boolean;
  tokensPerSec?: number;
}

export const useChatSession = () => {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [isGenerating, setIsGenerating] = useState(false);
    
    const appendUserMessage = useCallback(async (text: string) => {
        const newMsg: ChatMessage = {
            id: Date.now().toString(),
            isUser: true,
            content: text
        };
        
        setMessages(prev => [...prev, newMsg]);
        setIsGenerating(true);
        
        const replyId = (Date.now() + 1).toString();
        setMessages(prev => [...prev, {
            id: replyId,
            isUser: false,
            content: '',
            isStreaming: true,
            tokensPerSec: 0
        }]);
        
        let currentText = "";

        try {
            if (llmEngineService.getState() !== 'ready') {
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
