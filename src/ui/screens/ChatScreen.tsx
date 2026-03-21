import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    Alert,
    FlatList,
    LayoutChangeEvent,
    NativeScrollEvent,
    NativeSyntheticEvent,
} from 'react-native';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { ChatHeader } from '@/components/ui/ChatHeader';
import { ChatMessageBubble } from '@/components/ui/ChatMessageBubble';
import { ChatInputBar } from '@/components/ui/ChatInputBar';
import { ConversationSwitcherSheet } from '@/components/ui/ConversationSwitcherSheet';
import { useChatSession } from '../../hooks/useChatSession';
import { useLLMEngine } from '../../hooks/useLLMEngine';
import { useRouter } from 'expo-router';
import { EngineStatus } from '../../types/models';
import { ChatMessage } from '../../types/chat';
import { getChatHardwareBannerInputs, hardwareListenerService } from '../../services/HardwareListenerService';

const AUTO_SCROLL_BOTTOM_THRESHOLD = 96;

export function getNextShouldStickToBottom(
    currentValue: boolean,
    nativeEvent: NativeScrollEvent,
    isUserInteracting: boolean,
) {
    if (!isUserInteracting) {
        return currentValue;
    }

    const distanceFromBottom = Math.max(nativeEvent.contentOffset.y, 0);

    return distanceFromBottom < AUTO_SCROLL_BOTTOM_THRESHOLD;
}

export const ChatScreen = () => {
    const {
        activeThread,
        conversationIndex,
        messages,
        isGenerating,
        shouldOfferSummary,
        truncatedMessageCount,
        appendUserMessage,
        deleteMessage,
        openThread,
        stopGeneration,
        regenerateFromUserMessage,
        createSummaryPlaceholder,
        startNewChat,
    } = useChatSession();
    const { state: engineState } = useLLMEngine();
    const router = useRouter();
    const canGoBack = router.canGoBack();
    const [hardwareStatus, setHardwareStatus] = useState(() => hardwareListenerService.getCurrentStatus());
    const [composerDraft, setComposerDraft] = useState('');
    const [isConversationSwitcherOpen, setConversationSwitcherOpen] = useState(false);
    const [listResetNonce, setListResetNonce] = useState(0);
    const [pendingRegenerateMessage, setPendingRegenerateMessage] = useState<{
        messageId: string;
        originalContent: string;
    } | null>(null);
    const listRef = useRef<FlatList<ChatMessage> | null>(null);
    const autoScrollFrameRef = useRef<number | null>(null);
    const forcedScrollTimeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);
    const forcedFollowPassesRef = useRef(0);
    const isUserInteractingRef = useRef(false);
    const shouldStickToBottomRef = useRef(true);
    const hasActiveModel = Boolean(engineState.activeModelId);
    const isEngineReady = engineState.status === EngineStatus.READY;
    const isInputDisabled = !hasActiveModel || !isEngineReady;
    const statusLabel = activeThread?.status === 'generating'
        ? 'Generating'
        : activeThread?.status === 'stopped'
            ? 'Stopped'
            : activeThread?.status === 'error'
                ? 'Needs retry'
                : undefined;
    const hardwareBannerInputs = getChatHardwareBannerInputs(
        // T013: keep the chat banner contract scoped to banner-ready inputs.
        // T049 can render low-memory / overheating UI from this adapter without
        // coupling the screen to unrelated HardwareStatus fields.
        hardwareStatus,
    );
    const listBottomPadding =
        hardwareBannerInputs.showLowMemoryWarning || hardwareBannerInputs.showThermalWarning ? 32 : 24;

    const headerTitle = activeThread?.title
        ?? (engineState.activeModelId
            ? (engineState.activeModelId.split('/').pop() ?? engineState.activeModelId)
            : 'No Model');
    const displayMessages = [...messages].reverse();
    const hasMessages = displayMessages.length > 0;
    const lastMessage = messages[messages.length - 1];
    const lastMessageSignature = lastMessage
        ? `${lastMessage.id}:${lastMessage.state}:${lastMessage.content.length}:${lastMessage.tokensPerSec ?? -1}`
        : 'empty';
    const modelLabel = activeThread?.modelId
        ? (activeThread.modelId.split('/').pop() ?? activeThread.modelId)
        : (engineState.activeModelId
            ? (engineState.activeModelId.split('/').pop() ?? engineState.activeModelId)
            : 'No model');
    const paramsLabel = activeThread
        ? `T${activeThread.paramsSnapshot.temperature} • TopP ${activeThread.paramsSnapshot.topP} • ${activeThread.paramsSnapshot.maxTokens} tok`
        : undefined;
    const thermalWarningMessage = hardwareBannerInputs.thermalState === 'critical'
        ? 'Device temperature is critical. Pause generation or switch to a smaller model.'
        : 'Device temperature is elevated. Responses may slow down until the device cools.';
    const modelRecoveryActionLabel = hasActiveModel ? 'Open Models' : 'Download Model';

    const scrollToLatestMessage = useCallback((animated: boolean, preferIndex = true) => {
        if (preferIndex) {
            listRef.current?.scrollToIndex?.({ animated, index: 0, viewPosition: 0 });
        }

        listRef.current?.scrollToOffset({ animated, offset: 0 });
    }, []);

    const clearForcedScrollTimeouts = useCallback(() => {
        forcedScrollTimeoutsRef.current.forEach((timeoutId) => {
            clearTimeout(timeoutId);
        });
        forcedScrollTimeoutsRef.current = [];
    }, []);

    const scheduleForcedScrollBurst = useCallback(() => {
        clearForcedScrollTimeouts();

        [32, 96, 192].forEach((delayMs) => {
            const timeoutId = setTimeout(() => {
                scrollToLatestMessage(false, false);
            }, delayMs);

            forcedScrollTimeoutsRef.current.push(timeoutId);
        });
    }, [clearForcedScrollTimeouts, scrollToLatestMessage]);

    const scheduleScrollToLatestMessage = useCallback((animated: boolean, force = false) => {
        if (
            !messages.length
            || autoScrollFrameRef.current !== null
            || (!force && !shouldStickToBottomRef.current)
        ) {
            return;
        }

        autoScrollFrameRef.current = requestAnimationFrame(() => {
            autoScrollFrameRef.current = null;

            if (!force && !shouldStickToBottomRef.current) {
                return;
            }

            scrollToLatestMessage(animated);

            if (force && forcedFollowPassesRef.current > 0) {
                forcedFollowPassesRef.current -= 1;
            }
        });
    }, [messages.length, scrollToLatestMessage]);

    const updateStickinessFromScrollEvent = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
        shouldStickToBottomRef.current = getNextShouldStickToBottom(
            shouldStickToBottomRef.current,
            event.nativeEvent,
            isUserInteractingRef.current,
        );
    };

    const handleListScrollBeginDrag = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
        isUserInteractingRef.current = true;
        forcedFollowPassesRef.current = 0;
        clearForcedScrollTimeouts();
        updateStickinessFromScrollEvent(event);
    };

    const handleListScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
        updateStickinessFromScrollEvent(event);
    };

    const handleListScrollEndDrag = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
        updateStickinessFromScrollEvent(event);
        isUserInteractingRef.current = false;
    };

    const handleListMomentumScrollEnd = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
        updateStickinessFromScrollEvent(event);
        isUserInteractingRef.current = false;
    };

    const handleListViewportLayout = (_event: LayoutChangeEvent) => {
        const hasForcedFollowPass = forcedFollowPassesRef.current > 0;

        if (!messages.length || (!shouldStickToBottomRef.current && !hasForcedFollowPass)) {
            return;
        }

        scheduleScrollToLatestMessage(false, hasForcedFollowPass);
    };

    const handleListContentSizeChange = () => {
        const hasForcedFollowPass = forcedFollowPassesRef.current > 0;

        if (!messages.length || (!shouldStickToBottomRef.current && !hasForcedFollowPass)) {
            return;
        }

        scheduleScrollToLatestMessage(false, hasForcedFollowPass);
    };

    const handleLastMessageLayout = (_event: LayoutChangeEvent) => {
        const hasForcedFollowPass = forcedFollowPassesRef.current > 0;

        if (!messages.length || (!shouldStickToBottomRef.current && !hasForcedFollowPass)) {
            return;
        }

        scheduleScrollToLatestMessage(false, hasForcedFollowPass);
    };

    const resumeFollowingLatestMessage = () => {
        shouldStickToBottomRef.current = true;
        isUserInteractingRef.current = false;
        forcedFollowPassesRef.current = 6;
        setListResetNonce((current) => current + 1);
        clearForcedScrollTimeouts();

        if (autoScrollFrameRef.current !== null) {
            cancelAnimationFrame(autoScrollFrameRef.current);
            autoScrollFrameRef.current = null;
        }

        if (messages.length || activeThread) {
            scrollToLatestMessage(false);
            scheduleScrollToLatestMessage(false, true);
            scheduleForcedScrollBurst();
        }
    };

    const handleSendMessage = async (content: string) => {
        resumeFollowingLatestMessage();
        if (pendingRegenerateMessage) {
            await regenerateFromUserMessage(pendingRegenerateMessage.messageId, content);
            setPendingRegenerateMessage(null);
            setComposerDraft('');
            return;
        }

        await appendUserMessage(content);
        setComposerDraft('');
    };

    const handleSelectConversation = (threadId: string) => {
        try {
            openThread(threadId);
            resumeFollowingLatestMessage();
            router.push('/(tabs)/chat' as any);
        } catch (error: any) {
            Alert.alert('Cannot switch conversation', error?.message || 'Action failed');
        }
    };

    const handleBeginRegenerateFromMessage = (message: ChatMessage) => {
        setPendingRegenerateMessage({
            messageId: message.id,
            originalContent: message.content,
        });
        setComposerDraft(message.content);
    };

    const handleCancelComposerMode = () => {
        setPendingRegenerateMessage(null);
        setComposerDraft('');
    };

    const handleDeleteMessage = (message: ChatMessage) => {
        Alert.alert(
            'Delete message',
            message.role === 'user'
                ? 'Deleting this message will also remove all later replies in this branch.'
                : 'Deleting this reply will also remove any later messages in this branch.',
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Delete',
                    style: 'destructive',
                    onPress: () => {
                        try {
                            const deleted = deleteMessage(message.id);
                            if (deleted && pendingRegenerateMessage?.messageId === message.id) {
                                handleCancelComposerMode();
                            }
                        } catch (error: any) {
                            Alert.alert('Cannot delete message', error?.message || 'Action failed');
                        }
                    },
                },
            ],
        );
    };

    useEffect(() => {
        return hardwareListenerService.subscribe((nextStatus) => {
            setHardwareStatus(nextStatus);
        });
    }, []);

    useEffect(() => {
        return () => {
            if (autoScrollFrameRef.current !== null) {
                cancelAnimationFrame(autoScrollFrameRef.current);
            }

            clearForcedScrollTimeouts();
        };
    }, [clearForcedScrollTimeouts]);

    useEffect(() => {
        shouldStickToBottomRef.current = true;
        isUserInteractingRef.current = false;
        forcedFollowPassesRef.current = 0;
        clearForcedScrollTimeouts();
        setPendingRegenerateMessage(null);
        setComposerDraft('');
        setConversationSwitcherOpen(false);
    }, [activeThread?.id, clearForcedScrollTimeouts]);

    useEffect(() => {
        const hasForcedFollowPass = forcedFollowPassesRef.current > 0;

        if (!messages.length || (!shouldStickToBottomRef.current && !hasForcedFollowPass)) {
            return;
        }

        scheduleScrollToLatestMessage(false, hasForcedFollowPass);
    }, [lastMessageSignature, messages.length, scheduleScrollToLatestMessage]);

    useEffect(() => {
        if (listResetNonce === 0) {
            return;
        }

        scrollToLatestMessage(false);
        scheduleScrollToLatestMessage(false, true);
        scheduleForcedScrollBurst();
    }, [listResetNonce, scheduleForcedScrollBurst, scheduleScrollToLatestMessage, scrollToLatestMessage]);

    return (
        <Box className="flex-1 bg-background-0 dark:bg-background-950 max-w-2xl w-full mx-auto border-x border-primary-500/10">
            <ChatHeader 
                title={headerTitle}
                badgeLabel={activeThread?.presetSnapshot.name ?? (hasActiveModel ? 'Local Model' : 'No Model')}
                detailLabel={paramsLabel}
                memoryLabel={modelLabel}
                statusLabel={statusLabel}
                canStartNewChat={!isGenerating}
                onStartNewChat={() => {
                    void Promise.resolve(startNewChat()).catch(() => {
                        // The button is hidden while a response is generating, but
                        // this guard prevents unhandled promise noise during state races.
                    });
                    handleCancelComposerMode();
                }}
                onMenu={() => {
                    setConversationSwitcherOpen(true);
                }}
                onBack={canGoBack ? () => router.back() : undefined}
            />

            <Box className="flex-1 p-4">
                {isInputDisabled ? (
                    <Box className="mb-4 rounded-2xl border border-warning-300 bg-warning-50 px-4 py-3 dark:border-warning-700 dark:bg-warning-950/40">
                        <Text className="text-sm font-semibold text-warning-700 dark:text-warning-300">
                            Load a model to continue chatting
                        </Text>
                        <Text className="mt-1 text-sm text-warning-700/80 dark:text-warning-300/80">
                            Chat history is still available, but sending is disabled until a local model is ready.
                        </Text>
                        <Pressable
                            onPress={() => {
                                router.push('/(tabs)/models' as any);
                            }}
                            className="mt-3 self-start rounded-full border border-warning-400/30 bg-warning-100 px-3 py-2 active:opacity-70 dark:border-warning-600/40 dark:bg-warning-900/40"
                        >
                            <Text className="text-sm font-medium text-warning-800 dark:text-warning-200">
                                {modelRecoveryActionLabel}
                            </Text>
                        </Pressable>
                    </Box>
                ) : null}

                {activeThread?.status === 'stopped' ? (
                    <Box className="mb-4 rounded-2xl border border-primary-500/15 bg-primary-500/5 px-4 py-3">
                        <Text className="text-sm font-medium text-primary-600 dark:text-primary-400">
                            Generation stopped. You can continue the thread or regenerate from any user message.
                        </Text>
                    </Box>
                ) : null}

                {shouldOfferSummary ? (
                    <Box className="mb-4 rounded-2xl border border-primary-500/15 bg-primary-500/5 px-4 py-3">
                        <Text className="text-sm font-semibold text-primary-700 dark:text-primary-300">
                            Older messages are being trimmed from the model context
                        </Text>
                        <Text className="mt-1 text-sm text-primary-700/80 dark:text-primary-300/80">
                            {truncatedMessageCount} earlier message{truncatedMessageCount === 1 ? '' : 's'} stay visible in the thread, but only recent context is sent during generation.
                        </Text>
                        <Pressable
                            onPress={createSummaryPlaceholder}
                            className="mt-3 self-start rounded-full border border-primary-500/20 bg-primary-500/10 px-3 py-2 active:opacity-70"
                        >
                            <Text className="text-sm font-medium text-primary-600 dark:text-primary-400">
                                Summarize chat
                            </Text>
                        </Pressable>
                    </Box>
                ) : null}

                {activeThread?.summary ? (
                    <Box className="mb-4 rounded-2xl border border-outline-200 bg-background-50 px-4 py-3 dark:border-outline-800 dark:bg-background-900/60">
                        <Text className="text-sm font-semibold text-typography-700 dark:text-typography-200">
                            Summary placeholder
                        </Text>
                        <Text className="mt-1 text-sm text-typography-600 dark:text-typography-300">
                            {activeThread.summary.content}
                        </Text>
                    </Box>
                ) : null}

                {hardwareBannerInputs.showLowMemoryWarning ? (
                    <Box className="mb-4 rounded-2xl border border-warning-300 bg-warning-50 px-4 py-3 dark:border-warning-700 dark:bg-warning-950/40">
                        <Text className="text-sm font-semibold text-warning-700 dark:text-warning-300">
                            Memory pressure detected
                        </Text>
                        <Text className="mt-1 text-sm text-warning-700/80 dark:text-warning-300/80">
                            The active model may be unloaded to keep the app responsive.
                        </Text>
                    </Box>
                ) : null}

                {hardwareBannerInputs.showThermalWarning ? (
                    <Box className="mb-4 rounded-2xl border border-warning-300 bg-warning-50 px-4 py-3 dark:border-warning-700 dark:bg-warning-950/40">
                        <Text className="text-sm font-semibold text-warning-700 dark:text-warning-300">
                            Device is running hot
                        </Text>
                        <Text className="mt-1 text-sm text-warning-700/80 dark:text-warning-300/80">
                            {thermalWarningMessage}
                        </Text>
                    </Box>
                ) : null}
                <Box className="flex-1" onLayout={handleListViewportLayout}>
                    {hasMessages ? (
                        <FlatList
                            key={`${activeThread?.id ?? 'no-thread'}:${listResetNonce}`}
                            ref={listRef}
                            data={displayMessages}
                            extraData={`${lastMessageSignature}:${pendingRegenerateMessage?.messageId ?? 'none'}:${isInputDisabled ? 'disabled' : 'enabled'}`}
                            inverted
                            showsVerticalScrollIndicator={false}
                            scrollEventThrottle={16}
                            contentContainerStyle={{ paddingTop: listBottomPadding, flexGrow: 1 }}
                            onContentSizeChange={handleListContentSizeChange}
                            onScroll={handleListScroll}
                            onScrollBeginDrag={handleListScrollBeginDrag}
                            onScrollEndDrag={handleListScrollEndDrag}
                            onMomentumScrollEnd={handleListMomentumScrollEnd}
                            onScrollToIndexFailed={() => {
                                scrollToLatestMessage(false, false);
                                scheduleForcedScrollBurst();
                            }}
                            ItemSeparatorComponent={() => <Box className="h-6" />}
                            keyExtractor={(item) => item.id}
                            renderItem={({ item: msg, index }) => (
                                <ChatMessageBubble
                                    id={msg.id}
                                    isUser={msg.role === 'user'}
                                    content={msg.content}
                                    isStreaming={msg.state === 'streaming'}
                                    tokensPerSec={msg.tokensPerSec}
                                    canDelete={msg.state !== 'streaming'}
                                    canRegenerate={
                                        msg.role === 'user'
                                        && msg.state === 'complete'
                                        && !isGenerating
                                        && !isInputDisabled
                                    }
                                    onDelete={() => {
                                        handleDeleteMessage(msg);
                                    }}
                                    onRegenerate={() => {
                                        handleBeginRegenerateFromMessage(msg);
                                    }}
                                    onLayout={index === 0 ? handleLastMessageLayout : undefined}
                                />
                            )}
                        />
                    ) : (
                        <Box className="flex-1 items-center justify-center px-6">
                            <Text className="text-base font-semibold text-typography-700 dark:text-typography-300">
                                No messages yet
                            </Text>
                            <Text className="mt-2 text-center text-sm text-typography-500 dark:text-typography-400">
                                {activeThread
                                    ? 'This conversation is empty. Type something below to restart it.'
                                    : 'Type something below to start the conversation.'}
                            </Text>
                        </Box>
                    )}
                </Box>
            </Box>

            <ChatInputBar
                draft={composerDraft}
                onDraftChange={setComposerDraft}
                onSendMessage={handleSendMessage}
                onStopGeneration={stopGeneration}
                disabled={isInputDisabled}
                isSending={isGenerating}
                modeLabel={pendingRegenerateMessage ? 'Editing earlier message' : undefined}
                modeDescription={pendingRegenerateMessage
                    ? 'Update the selected prompt, then send to regenerate this branch from that point.'
                    : undefined}
                onCancelMode={pendingRegenerateMessage ? handleCancelComposerMode : undefined}
            />

            <ConversationSwitcherSheet
                visible={isConversationSwitcherOpen}
                activeThreadId={activeThread?.id ?? null}
                conversations={conversationIndex}
                onClose={() => {
                    setConversationSwitcherOpen(false);
                }}
                onSelectConversation={handleSelectConversation}
                onStartNewChat={() => {
                    try {
                        startNewChat();
                        handleCancelComposerMode();
                        resumeFollowingLatestMessage();
                    } catch (error: any) {
                        Alert.alert('Cannot start a new chat', error?.message || 'Action failed');
                    }
                }}
                onManageConversations={() => {
                    router.push('/conversations' as any);
                }}
            />
        </Box>
    );
};
