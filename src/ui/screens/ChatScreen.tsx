import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Alert,
    BackHandler,
    Dimensions,
    FlatList,
    Keyboard,
    KeyboardAvoidingView,
    LayoutChangeEvent,
    KeyboardEvent,
    NativeScrollEvent,
    NativeSyntheticEvent,
    Platform,
    View,
} from 'react-native';
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import DeviceInfo from 'react-native-device-info';
import { useFocusEffect } from '@react-navigation/native';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { ChatHeader } from '@/components/ui/ChatHeader';
import { ChatStatusBanner } from '@/components/ui/ChatStatusBanner';
import { ChatMessageBubble } from '@/components/ui/ChatMessageBubble';
import { ChatInputBar } from '@/components/ui/ChatInputBar';
import { ModelParametersSheet } from '@/components/ui/ModelParametersSheet';
import { MaterialSymbols } from '@/components/ui/MaterialSymbols';
import { useTranslation } from 'react-i18next';
import { PresetSelectorSheet } from '@/components/ui/PresetSelectorSheet';
import { resolvePresetSnapshot, useChatSession } from '../../hooks/useChatSession';
import { useLLMEngine } from '../../hooks/useLLMEngine';
import { useRouter } from 'expo-router';
import { llmEngineService } from '../../services/LLMEngineService';
import { EngineStatus } from '../../types/models';
import { ChatMessage } from '../../types/chat';
import { getChatHardwareBannerInputs, hardwareListenerService } from '../../services/HardwareListenerService';
import { registry } from '../../services/LocalStorageRegistry';
import { modelCatalogService } from '../../services/ModelCatalogService';
import { useChatStore } from '../../store/chatStore';
import { getReportedErrorMessage } from '../../services/AppError';
import {
    DEFAULT_MODEL_LOAD_PARAMETERS,
    getGenerationParametersForModel,
    getModelLoadParametersForModel,
    getSettings,
    resetGenerationParametersForModel,
    resetModelLoadParametersForModel,
    subscribeSettings,
    updateSettings,
    updateModelLoadParametersForModel,
    updateGenerationParametersForModel,
    type ModelLoadParameters,
} from '../../services/SettingsStore';
import {
    clampContextWindowTokens,
    resolveContextWindowCeiling,
} from '../../utils/contextWindow';
import { hasPersistedLoadProfileChanges } from '../../utils/modelLoadProfile';
import { screenLayoutMetrics } from '../../utils/themeTokens';

const AUTO_SCROLL_BOTTOM_THRESHOLD = 96;
const FALLBACK_TOP_K = 40;
const FALLBACK_MIN_P = 0.05;
const FALLBACK_REPETITION_PENALTY = 1;
const SHOULD_USE_KEYBOARD_AVOIDING_VIEW = Platform.OS === 'ios';

export function getAndroidKeyboardOverlapCompensation({
    baseWindowHeight,
    currentWindowHeight,
    keyboardHeight,
    coveredBottomInset = 0,
    gap = 8,
}: {
    baseWindowHeight: number;
    currentWindowHeight: number;
    keyboardHeight: number;
    coveredBottomInset?: number;
    gap?: number;
}) {
    const resizedBySystem = Math.max(0, baseWindowHeight - currentWindowHeight);
    const reservedInsetAdjustment = Math.max(0, coveredBottomInset - gap);
    const compensation = Math.max(0, keyboardHeight - resizedBySystem - reservedInsetAdjustment);

    if (coveredBottomInset > 0) {
        return Math.max(gap, compensation);
    }

    return compensation;
}

export function getAndroidKeyboardSpacerHeight({
    viewportCompensation,
    composerBottomY,
    keyboardTopY,
    gap = 8,
}: {
    viewportCompensation: number;
    composerBottomY?: number | null;
    keyboardTopY?: number | null;
    gap?: number;
}) {
    const measuredOverlap =
        typeof composerBottomY === 'number' && typeof keyboardTopY === 'number'
            ? Math.max(0, composerBottomY + gap - keyboardTopY)
            : 0;

    return Math.max(viewportCompensation, measuredOverlap);
}

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

export function handleAndroidBackNavigation({
    canGoBack,
    onGoBack,
}: {
    canGoBack: boolean;
    onGoBack: () => void;
}) {
    if (!canGoBack) {
        return false;
    }

    onGoBack();
    return true;
}

export const ChatScreen = () => {
    const {
        activeThread,
        messages,
        isGenerating,
        shouldOfferSummary,
        truncatedMessageCount,
        appendUserMessage,
        deleteMessage,
        stopGeneration,
        regenerateFromUserMessage,
        createSummaryPlaceholder,
        startNewChat,
    } = useChatSession();
    const { state: engineState } = useLLMEngine();
    const { t } = useTranslation();
    const router = useRouter();
    const tabBarHeight = useBottomTabBarHeight();
    const [hardwareStatus, setHardwareStatus] = useState(() => hardwareListenerService.getCurrentStatus());
    const [composerDraft, setComposerDraft] = useState('');
    const [androidKeyboardInset, setAndroidKeyboardInset] = useState(0);
    const [isPresetSelectorOpen, setPresetSelectorOpen] = useState(false);
    const [isModelParametersOpen, setModelParametersOpen] = useState(false);
    const [isApplyingModelReload, setApplyingModelReload] = useState(false);
    const [settings, setSettings] = useState(() => getSettings());
    const [recommendedGpuLayers, setRecommendedGpuLayers] = useState(0);
    const [measuredContextWindowCeiling, setMeasuredContextWindowCeiling] = useState<number | null>(null);
    const [draftLoadParams, setDraftLoadParams] = useState<ModelLoadParameters>({
        contextSize: DEFAULT_MODEL_LOAD_PARAMETERS.contextSize,
        gpuLayers: 0,
    });
    const [pendingRegenerateMessage, setPendingRegenerateMessage] = useState<{
        messageId: string;
        originalContent: string;
    } | null>(null);
    const updateThreadPresetSnapshot = useChatStore((state) => state.updateThreadPresetSnapshot);
    const updateThreadParamsSnapshot = useChatStore((state) => state.updateThreadParamsSnapshot);
    const loadDraftSourceRef = useRef<{
        contextSize: 'current' | 'default' | 'user';
        gpuLayers: 'current' | 'default' | 'user';
    }>({
        contextSize: 'current',
        gpuLayers: 'current',
    });
    const loadDraftSeedRef = useRef<string | null>(null);
    const listRef = useRef<FlatList<ChatMessage> | null>(null);
    const autoScrollFrameRef = useRef<number | null>(null);
    const keyboardMeasureFrameRef = useRef<number | null>(null);
    const forcedScrollTimeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);
    const forcedFollowPassesRef = useRef(0);
    const baseWindowHeightRef = useRef(Dimensions.get('window').height);
    const isKeyboardVisibleRef = useRef(false);
    const androidKeyboardMetricsRef = useRef<{ height: number; topY: number } | null>(null);
    const composerContainerRef = useRef<View | null>(null);
    const isUserInteractingRef = useRef(false);
    const shouldStickToBottomRef = useRef(true);
    const hasActiveModel = Boolean(engineState.activeModelId);
    const isEngineReady = engineState.status === EngineStatus.READY;
    const isInputDisabled = !hasActiveModel || !isEngineReady;
    const statusLabel = activeThread?.status === 'stopped'
        ? t('chat.statusStopped')
        : activeThread?.status === 'error'
            ? t('chat.statusError')
            : undefined;
    const statusTone = activeThread?.status === 'error'
            ? 'warning'
            : 'neutral';
    const hardwareBannerInputs = getChatHardwareBannerInputs(
        // T013: keep the chat banner contract scoped to banner-ready inputs.
        // T049 can render low-memory / overheating UI from this adapter without
        // coupling the screen to unrelated HardwareStatus fields.
        hardwareStatus,
    );
    const listBottomPadding =
        hardwareBannerInputs.showLowMemoryWarning || hardwareBannerInputs.showThermalWarning ? 22 : 14;

    const headerTitle = activeThread?.title ?? t('chat.newChatTitle');
    const configurableModelId = activeThread?.modelId ?? settings.activeModelId ?? null;
    const rawCurrentParams = getGenerationParametersForModel(configurableModelId);
    const currentParams = {
        ...rawCurrentParams,
        topK: rawCurrentParams.topK ?? FALLBACK_TOP_K,
        minP: rawCurrentParams.minP ?? FALLBACK_MIN_P,
        repetitionPenalty: rawCurrentParams.repetitionPenalty ?? FALLBACK_REPETITION_PENALTY,
        reasoningEnabled: rawCurrentParams.reasoningEnabled === true,
    };
    const currentLoadParams = getModelLoadParametersForModel(configurableModelId);
    const rawDefaultParams = getGenerationParametersForModel(null);
    const defaultParams = {
        ...rawDefaultParams,
        topK: rawDefaultParams.topK ?? FALLBACK_TOP_K,
        minP: rawDefaultParams.minP ?? FALLBACK_MIN_P,
        repetitionPenalty: rawDefaultParams.repetitionPenalty ?? FALLBACK_REPETITION_PENALTY,
        reasoningEnabled: rawDefaultParams.reasoningEnabled === true,
    };
    const defaultLoadParams = getModelLoadParametersForModel(null);
    const displayMessages = useMemo(() => [...messages].reverse(), [messages]);
    const hasMessages = displayMessages.length > 0;
    const lastMessage = messages[messages.length - 1];
    const lastMessageSignature = lastMessage
        ? `${lastMessage.id}:${lastMessage.state}:${lastMessage.content.length}:${lastMessage.tokensPerSec ?? -1}`
        : 'empty';
    const modelLabel = activeThread?.modelId
        ? (activeThread.modelId.split('/').pop() ?? activeThread.modelId)
        : (engineState.activeModelId
            ? (engineState.activeModelId.split('/').pop() ?? engineState.activeModelId)
            : t('chat.modelUnavailable'));
    const rawParamsSource = activeThread?.paramsSnapshot ?? currentParams;
    const paramsSource = {
        ...rawParamsSource,
        topK: rawParamsSource.topK ?? FALLBACK_TOP_K,
        minP: rawParamsSource.minP ?? FALLBACK_MIN_P,
        repetitionPenalty: rawParamsSource.repetitionPenalty ?? FALLBACK_REPETITION_PENALTY,
        reasoningEnabled: rawParamsSource.reasoningEnabled === true,
    };
    const configurableModel = configurableModelId ? registry.getModel(configurableModelId) : undefined;
    const configurableModelAccessState = configurableModel?.accessState;
    const configurableModelIsGated = configurableModel?.isGated === true;
    const configurableModelIsPrivate = configurableModel?.isPrivate === true;
    const configurableModelHasVerifiedContextWindow = configurableModel?.hasVerifiedContextWindow === true;
    const configurableModelMaxContextTokens = configurableModel?.maxContextTokens;
    const configurableModelSize = configurableModel?.size ?? null;
    const baseContextWindowCeiling = useMemo(() => resolveContextWindowCeiling({
        modelMaxContextTokens: configurableModelMaxContextTokens,
        modelSizeBytes: configurableModelSize,
    }), [configurableModelMaxContextTokens, configurableModelSize]);
    const contextWindowCeiling = measuredContextWindowCeiling ?? baseContextWindowCeiling;
    const effectiveCurrentLoadParams = {
        contextSize: clampContextWindowTokens(currentLoadParams.contextSize, contextWindowCeiling),
        gpuLayers: currentLoadParams.gpuLayers,
    };
    const effectiveDefaultLoadParams = {
        contextSize: clampContextWindowTokens(defaultLoadParams.contextSize, contextWindowCeiling),
        gpuLayers: defaultLoadParams.gpuLayers,
    };
    const draftPersistedGpuLayers = loadDraftSourceRef.current.gpuLayers === 'current'
        ? (currentLoadParams.gpuLayers ?? null)
        : loadDraftSourceRef.current.gpuLayers === 'default'
            ? (effectiveDefaultLoadParams.gpuLayers ?? null)
            : draftLoadParams.gpuLayers;
    const applyButtonLabel = settings.activeModelId === configurableModelId ? t('models.applyAndReload') : t('models.saveLoadProfile');
    const showApplyReload = Boolean(configurableModelId) && (
        hasPersistedLoadProfileChanges({
            draftContextSize: draftLoadParams.contextSize,
            draftPersistedGpuLayers,
            persistedLoadParams: currentLoadParams,
        })
        || isApplyingModelReload
    );
    const canApplyReload = Boolean(configurableModelId) && !isGenerating && !isApplyingModelReload;
    const thermalWarningMessage = hardwareBannerInputs.thermalState === 'critical'
        ? t('chat.thermalDescriptionCritical')
        : t('chat.thermalDescriptionElevated');
    const recoveryTitle = hasActiveModel ? t('chat.warmingUp') : t('chat.loadModelWarning');
    const recoveryDescription = hasActiveModel ? t('chat.warmingUpDescription') : t('chat.loadModelDescription');
    const activePresetLabel = activeThread?.presetSnapshot.name ?? (settings.activePresetId ? resolvePresetSnapshot(settings.activePresetId).name : t('common.default'));
    const shouldShowRecoveryBanner = isInputDisabled && hasMessages;
    const shouldShowRecoveryCard = isInputDisabled && !hasMessages;
    const hasDownloadedModels = registry.getModels().some((model) => Boolean(model.localPath));
    const modelRecoveryActionRoute = hasDownloadedModels
        ? { pathname: '/(tabs)/models', params: { initialTab: 'downloaded' as const } }
        : '/(tabs)/models';
    const resolvedModelRecoveryActionLabel = hasActiveModel
        ? t('chat.openModels')
        : hasDownloadedModels
            ? t('chat.loadModel')
            : t('chat.downloadModel');
    const headerModelLabel = shouldShowRecoveryCard && !hasActiveModel
        ? undefined
        : modelLabel;

    const showAlertForError = useCallback((titleKey: string, scope: string, error: unknown) => {
        Alert.alert(t(titleKey), getReportedErrorMessage(scope, error, t));
    }, [t]);

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

    const updateAndroidKeyboardInsetFromLayout = useCallback(() => {
        if (Platform.OS !== 'android') {
            return;
        }

        const keyboardMetrics = androidKeyboardMetricsRef.current;
        const composerContainer = composerContainerRef.current;

        if (!keyboardMetrics) {
            setAndroidKeyboardInset(0);
            return;
        }

        const viewportCompensation = getAndroidKeyboardOverlapCompensation({
            baseWindowHeight: baseWindowHeightRef.current,
            currentWindowHeight: Dimensions.get('window').height,
            keyboardHeight: keyboardMetrics.height,
            coveredBottomInset: tabBarHeight,
            gap: screenLayoutMetrics.keyboardComposerGap,
        });

        if (!composerContainer || typeof composerContainer.measureInWindow !== 'function') {
            setAndroidKeyboardInset(viewportCompensation);
            return;
        }

        if (keyboardMeasureFrameRef.current !== null) {
            cancelAnimationFrame(keyboardMeasureFrameRef.current);
        }

        keyboardMeasureFrameRef.current = requestAnimationFrame(() => {
            keyboardMeasureFrameRef.current = null;

            composerContainer.measureInWindow((_x, y, _width, height) => {
                setAndroidKeyboardInset(getAndroidKeyboardSpacerHeight({
                    viewportCompensation,
                    composerBottomY: y + height,
                    keyboardTopY: keyboardMetrics.topY,
                    gap: screenLayoutMetrics.keyboardComposerGap,
                }));
            });
        });
    }, [tabBarHeight]);

    const handleListContentSizeChange = () => {
        const hasForcedFollowPass = forcedFollowPassesRef.current > 0;

        if (!messages.length || (!shouldStickToBottomRef.current && !hasForcedFollowPass)) {
            return;
        }

        scheduleScrollToLatestMessage(false, hasForcedFollowPass);
    };

    const handleLastMessageLayout = useCallback((_event: LayoutChangeEvent) => {
        const hasForcedFollowPass = forcedFollowPassesRef.current > 0;

        if (!messages.length || (!shouldStickToBottomRef.current && !hasForcedFollowPass)) {
            return;
        }

        scheduleScrollToLatestMessage(false, hasForcedFollowPass);
    }, [messages.length, scheduleScrollToLatestMessage]);

    const armFollowLatestMessage = useCallback((burst = false) => {
        shouldStickToBottomRef.current = true;
        isUserInteractingRef.current = false;
        forcedFollowPassesRef.current = burst ? 6 : 1;
        clearForcedScrollTimeouts();

        if (autoScrollFrameRef.current !== null) {
            cancelAnimationFrame(autoScrollFrameRef.current);
            autoScrollFrameRef.current = null;
        }

        if (messages.length || activeThread) {
            scrollToLatestMessage(false, false);
            scheduleScrollToLatestMessage(false, true);

            if (burst) {
                scheduleForcedScrollBurst();
            }
        }
    }, [
        activeThread,
        clearForcedScrollTimeouts,
        messages.length,
        scheduleForcedScrollBurst,
        scheduleScrollToLatestMessage,
        scrollToLatestMessage,
    ]);

    const handleSendMessage = async (content: string) => {
        armFollowLatestMessage(false);
        if (pendingRegenerateMessage) {
            const targetMessage = pendingRegenerateMessage;
            setPendingRegenerateMessage(null);
            setComposerDraft('');

            try {
                await regenerateFromUserMessage(targetMessage.messageId, content);
            } catch (error) {
                setPendingRegenerateMessage(targetMessage);
                setComposerDraft(content);
                throw error;
            }

            return;
        }

        setComposerDraft('');
        try {
            await appendUserMessage(content);
        } catch (error) {
            setComposerDraft(content);
            throw error;
        }
    };

    const handleBeginRegenerateFromMessage = useCallback((message: ChatMessage) => {
        setPendingRegenerateMessage({
            messageId: message.id,
            originalContent: message.content,
        });
        setComposerDraft(message.content);
    }, []);

    const handleCancelComposerMode = useCallback(() => {
        setPendingRegenerateMessage(null);
        setComposerDraft('');
    }, []);

    const handleDeleteMessage = useCallback((message: ChatMessage) => {
        Alert.alert(
            t('chat.deleteMessageTitle'),
            message.role === 'user'
                ? t('chat.deleteUserMessageDescription')
                : t('chat.deleteAssistantMessageDescription'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('common.delete'),
                    style: 'destructive',
                    onPress: () => {
                        try {
                            const deleted = deleteMessage(message.id);
                            if (deleted && pendingRegenerateMessage?.messageId === message.id) {
                                handleCancelComposerMode();
                            }
                        } catch (error: any) {
                            showAlertForError('chat.deleteMessageErrorTitle', 'ChatScreen.handleDeleteMessage', error);
                        }
                    },
                },
            ],
        );
    }, [deleteMessage, pendingRegenerateMessage?.messageId, showAlertForError, t, handleCancelComposerMode]);

    useEffect(() => {
        return hardwareListenerService.subscribe((nextStatus) => {
            setHardwareStatus(nextStatus);
        });
    }, []);

    useEffect(() => {
        return subscribeSettings((nextSettings) => {
            setSettings(nextSettings);
        });
    }, []);

    useEffect(() => {
        if (Platform.OS !== 'android') {
            return;
        }

        baseWindowHeightRef.current = Dimensions.get('window').height;

        const dimensionsSubscription = Dimensions.addEventListener('change', ({ window }) => {
            if (!isKeyboardVisibleRef.current) {
                baseWindowHeightRef.current = window.height;
            }
        });

        const keyboardShowSubscription = Keyboard.addListener('keyboardDidShow', (event: KeyboardEvent) => {
            isKeyboardVisibleRef.current = true;
            androidKeyboardMetricsRef.current = {
                height: event.endCoordinates.height,
                topY: event.endCoordinates.screenY > 0
                    ? event.endCoordinates.screenY
                    : Math.max(0, Dimensions.get('screen').height - event.endCoordinates.height),
            };
            updateAndroidKeyboardInsetFromLayout();
        });

        const keyboardHideSubscription = Keyboard.addListener('keyboardDidHide', () => {
            isKeyboardVisibleRef.current = false;
            androidKeyboardMetricsRef.current = null;
            setAndroidKeyboardInset(0);
            baseWindowHeightRef.current = Dimensions.get('window').height;
        });

        return () => {
            if (keyboardMeasureFrameRef.current !== null) {
                cancelAnimationFrame(keyboardMeasureFrameRef.current);
                keyboardMeasureFrameRef.current = null;
            }
            dimensionsSubscription.remove();
            keyboardShowSubscription.remove();
            keyboardHideSubscription.remove();
        };
    }, [updateAndroidKeyboardInsetFromLayout]);

    useEffect(() => {
        if (!isModelParametersOpen) {
            return;
        }

        let isCancelled = false;
        const refreshTargetModel = configurableModelId ? registry.getModel(configurableModelId) : undefined;
        const shouldRefreshModelMetadata = refreshTargetModel?.hasVerifiedContextWindow !== true;

        setMeasuredContextWindowCeiling(null);

        void llmEngineService.getRecommendedGpuLayers()
            .then((nextGpuLayers: number) => {
                if (!isCancelled) {
                    setRecommendedGpuLayers(nextGpuLayers);
                }
            })
            .catch(() => {
                if (!isCancelled) {
                    setRecommendedGpuLayers(0);
                }
            });

        void Promise.all([
            DeviceInfo.getTotalMemory().catch(() => null),
            shouldRefreshModelMetadata && refreshTargetModel
                ? modelCatalogService.refreshModelMetadata(refreshTargetModel).catch(() => refreshTargetModel)
                : Promise.resolve(refreshTargetModel),
        ])
            .then(([totalMemoryBytes, resolvedModel]) => {
                if (!isCancelled) {
                    setMeasuredContextWindowCeiling(resolveContextWindowCeiling({
                        modelMaxContextTokens: resolvedModel?.maxContextTokens,
                        modelSizeBytes: resolvedModel?.size ?? null,
                        totalMemoryBytes,
                    }));
                }
            })
            .catch(() => {
                if (!isCancelled) {
                    setMeasuredContextWindowCeiling(null);
                }
            });

        return () => {
            isCancelled = true;
        };
    }, [
        configurableModelAccessState,
        configurableModelHasVerifiedContextWindow,
        configurableModelId,
        configurableModelIsGated,
        configurableModelIsPrivate,
        configurableModelMaxContextTokens,
        configurableModelSize,
        isModelParametersOpen,
    ]);

    useEffect(() => {
        if (!isModelParametersOpen) {
            setMeasuredContextWindowCeiling(null);
            loadDraftSourceRef.current = {
                contextSize: 'current',
                gpuLayers: 'current',
            };
            loadDraftSeedRef.current = null;
            return;
        }

        const seedKey = configurableModelId ?? '__no-model__';
        const shouldInitializeDraft = loadDraftSeedRef.current !== seedKey;

        if (shouldInitializeDraft) {
            loadDraftSourceRef.current = {
                contextSize: 'current',
                gpuLayers: 'current',
            };
            loadDraftSeedRef.current = seedKey;
        }

        setDraftLoadParams((current) => {
            const nextContextSize = shouldInitializeDraft
                ? effectiveCurrentLoadParams.contextSize
                : (
                    loadDraftSourceRef.current.contextSize === 'current'
                        ? effectiveCurrentLoadParams.contextSize
                        : loadDraftSourceRef.current.contextSize === 'default'
                            ? effectiveDefaultLoadParams.contextSize
                            : clampContextWindowTokens(current.contextSize, contextWindowCeiling)
                );
            const nextGpuLayers = shouldInitializeDraft
                ? (currentLoadParams.gpuLayers ?? recommendedGpuLayers)
                : (
                    loadDraftSourceRef.current.gpuLayers === 'current'
                        ? (currentLoadParams.gpuLayers ?? recommendedGpuLayers)
                        : loadDraftSourceRef.current.gpuLayers === 'default'
                            ? (effectiveDefaultLoadParams.gpuLayers ?? recommendedGpuLayers)
                            : current.gpuLayers
                );

            if (
                current.contextSize === nextContextSize
                && current.gpuLayers === nextGpuLayers
            ) {
                return current;
            }

            return {
                contextSize: nextContextSize,
                gpuLayers: nextGpuLayers,
            };
        });
    }, [
        configurableModelId,
        contextWindowCeiling,
        currentLoadParams.gpuLayers,
        effectiveDefaultLoadParams.contextSize,
        effectiveDefaultLoadParams.gpuLayers,
        effectiveCurrentLoadParams.contextSize,
        isModelParametersOpen,
        recommendedGpuLayers,
    ]);

    useEffect(() => {
        return () => {
            if (autoScrollFrameRef.current !== null) {
                cancelAnimationFrame(autoScrollFrameRef.current);
                autoScrollFrameRef.current = null;
            }

            if (keyboardMeasureFrameRef.current !== null) {
                cancelAnimationFrame(keyboardMeasureFrameRef.current);
                keyboardMeasureFrameRef.current = null;
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
        setPresetSelectorOpen(false);
        setModelParametersOpen(false);
        setApplyingModelReload(false);
    }, [activeThread?.id, clearForcedScrollTimeouts]);

    const handleApplyLoadParams = async () => {
        if (!configurableModelId) {
            return;
        }

        if (isGenerating) {
            Alert.alert(t('chat.reloadModelErrorTitle'), t('chat.reloadModelWhileGenerating'));
            return;
        }

        setApplyingModelReload(true);

        try {
            const nextContextSize = clampContextWindowTokens(
                draftLoadParams.contextSize,
                contextWindowCeiling,
            );
            const nextGpuLayers = loadDraftSourceRef.current.gpuLayers === 'current'
                ? (currentLoadParams.gpuLayers ?? null)
                : loadDraftSourceRef.current.gpuLayers === 'default'
                    ? (effectiveDefaultLoadParams.gpuLayers ?? null)
                    : draftLoadParams.gpuLayers;
            const defaultContextSize = clampContextWindowTokens(
                DEFAULT_MODEL_LOAD_PARAMETERS.contextSize,
                contextWindowCeiling,
            );
            const isResetToDefaultProfile =
                nextContextSize === defaultContextSize
                && (nextGpuLayers ?? recommendedGpuLayers) === recommendedGpuLayers;

            if (nextContextSize !== draftLoadParams.contextSize) {
                setDraftLoadParams((current) => ({
                    ...current,
                    contextSize: nextContextSize,
                }));
            }

            if (isResetToDefaultProfile) {
                resetModelLoadParametersForModel(configurableModelId);
            } else {
                updateModelLoadParametersForModel(configurableModelId, {
                    contextSize: nextContextSize,
                    gpuLayers: nextGpuLayers,
                });
            }

            if (settings.activeModelId === configurableModelId) {
                await llmEngineService.load(configurableModelId, { forceReload: true });
            }
        } catch (error: any) {
            showAlertForError('chat.applyModelSettingsErrorTitle', 'ChatScreen.handleApplyLoadParams', error);
        } finally {
            setApplyingModelReload(false);
        }
    };

    useFocusEffect(
        useCallback(() => {
            if (Platform.OS !== 'android') {
                return undefined;
            }

            const subscription = BackHandler.addEventListener('hardwareBackPress', () => (
                handleAndroidBackNavigation({
                    canGoBack: router.canGoBack(),
                    onGoBack: () => {
                        router.back();
                    },
                })
            ));

            return () => {
                subscription.remove();
            };
        }, [router]),
    );

    useEffect(() => {
        const hasForcedFollowPass = forcedFollowPassesRef.current > 0;

        if (!messages.length || (!shouldStickToBottomRef.current && !hasForcedFollowPass)) {
            return;
        }

        scheduleScrollToLatestMessage(false, hasForcedFollowPass);
    }, [lastMessageSignature, messages.length, scheduleScrollToLatestMessage]);

    const renderChatMessage = useCallback(({ item: msg, index }: { item: ChatMessage; index: number }) => (
        <ChatMessageBubble
            id={msg.id}
            isUser={msg.role === 'user'}
            content={msg.content}
            thoughtContent={msg.thoughtContent}
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
    ), [handleBeginRegenerateFromMessage, handleDeleteMessage, handleLastMessageLayout, isGenerating, isInputDisabled]);

    return (
        <Box className="flex-1 w-full max-w-2xl mx-auto bg-background-0 dark:bg-background-950">
            <ChatHeader
                title={headerTitle}
                presetLabel={activePresetLabel}
                modelLabel={headerModelLabel}
                statusLabel={statusLabel}
                statusTone={statusTone}
                canStartNewChat={!isGenerating}
                onStartNewChat={() => {
                    try {
                        startNewChat();
                        handleCancelComposerMode();
                    } catch (error: any) {
                        showAlertForError('conversations.startNewChatErrorTitle', 'ChatScreen.startNewChat', error);
                    }
                }}
                onOpenModelControls={() => {
                    setModelParametersOpen(true);
                }}
                onOpenPresetSelector={() => {
                    setPresetSelectorOpen(true);
                }}
                canOpenPresetSelector={!isGenerating}
                canOpenModelControls={Boolean(configurableModelId) && !isGenerating}
                onBack={undefined}
            />

            <Box className="flex-1">
                <Box className="flex-1 px-3 pt-1.5">
                    {shouldShowRecoveryBanner ? (
                        <Box className="mb-3">
                            <ChatStatusBanner
                                title={recoveryTitle}
                                description={recoveryDescription}
                                actionLabel={resolvedModelRecoveryActionLabel}
                                onAction={() => {
                                    router.navigate(modelRecoveryActionRoute as any);
                                }}
                                tone="warning"
                                iconName={hasActiveModel ? 'hourglass-empty' : 'download'}
                                testID="chat-recovery-banner"
                            />
                        </Box>
                    ) : null}

                    {activeThread?.status === 'stopped' ? (
                        <Box className="mb-3">
                            <ChatStatusBanner
                                title={t('chat.statusStopped')}
                                description={t('chat.generationStopped')}
                                tone="info"
                                iconName="pause-circle-outline"
                            />
                        </Box>
                    ) : null}

                    {shouldOfferSummary ? (
                        <Box className="mb-3">
                            <ChatStatusBanner
                                title={t('chat.summaryTrimmedTitle')}
                                description={t('chat.summaryTrimmedDescription', { count: truncatedMessageCount })}
                                actionLabel={t('chat.summarizeChat')}
                                onAction={createSummaryPlaceholder}
                                tone="info"
                                iconName="summarize"
                            />
                        </Box>
                    ) : null}

                    {activeThread?.summary ? (
                        <Box className="mb-3">
                            <ChatStatusBanner
                                title={t('chat.summaryPlaceholderTitle')}
                                description={activeThread.summary.content}
                                tone="neutral"
                                iconName="notes"
                            />
                        </Box>
                    ) : null}

                    {hardwareBannerInputs.showLowMemoryWarning ? (
                        <Box className="mb-3">
                            <ChatStatusBanner
                                title={t('chat.memoryPressureTitle')}
                                description={t('chat.memoryPressureDescription')}
                                tone="warning"
                                iconName="memory"
                            />
                        </Box>
                    ) : null}

                    {hardwareBannerInputs.showThermalWarning ? (
                        <Box className="mb-3">
                            <ChatStatusBanner
                                title={t('chat.thermalTitle')}
                                description={thermalWarningMessage}
                                tone="warning"
                                iconName="whatshot"
                            />
                        </Box>
                    ) : null}

                    <Box className="flex-1" onLayout={handleListViewportLayout}>
                        {hasMessages ? (
                            <FlatList
                                key={activeThread?.id ?? 'no-thread'}
                                ref={listRef}
                                data={displayMessages}
                                extraData={`${lastMessageSignature}:${pendingRegenerateMessage?.messageId ?? 'none'}:${isInputDisabled ? 'disabled' : 'enabled'}`}
                                inverted
                                showsVerticalScrollIndicator={false}
                                scrollEventThrottle={16}
                                keyboardShouldPersistTaps="handled"
                                contentContainerStyle={{ paddingTop: listBottomPadding, paddingBottom: 4, flexGrow: 1 }}
                                onContentSizeChange={handleListContentSizeChange}
                                onScroll={handleListScroll}
                                onScrollBeginDrag={handleListScrollBeginDrag}
                                onScrollEndDrag={handleListScrollEndDrag}
                                onMomentumScrollEnd={handleListMomentumScrollEnd}
                                onScrollToIndexFailed={() => {
                                    scrollToLatestMessage(false, false);
                                    scheduleForcedScrollBurst();
                                }}
                                ItemSeparatorComponent={() => <Box className="h-2" />}
                                keyExtractor={(item) => item.id}
                                renderItem={renderChatMessage}
                                initialNumToRender={12}
                            />
                        ) : shouldShowRecoveryCard ? (
                            <Box className="flex-1 justify-center px-3 pb-10">
                                <Box
                                    testID="chat-recovery-card"
                                    className="items-center rounded-[20px] border border-warning-300/70 bg-warning-50/80 px-6 py-8 dark:border-warning-800 dark:bg-warning-950/35"
                                >
                                    <Box className="h-16 w-16 items-center justify-center rounded-full bg-warning-500/10 dark:bg-warning-500/15">
                                        <MaterialSymbols
                                            name={hasActiveModel ? 'hourglass-empty' : 'download'}
                                            size={28}
                                            className="text-warning-700 dark:text-warning-200"
                                        />
                                    </Box>

                                    {hasActiveModel ? (
                                        <Box className="mt-4 rounded-full border border-outline-200 bg-background-0 px-3 py-1.5 dark:border-outline-700 dark:bg-background-950/70">
                                            <Text className="text-xs font-semibold uppercase tracking-wide text-typography-600 dark:text-typography-300">
                                                {modelLabel}
                                            </Text>
                                        </Box>
                                    ) : null}

                                    <Text className="mt-5 text-center text-[22px] font-semibold leading-7 text-typography-900 dark:text-typography-100">
                                        {recoveryTitle}
                                    </Text>
                                    <Text className="mt-3 text-center text-sm leading-6 text-typography-600 dark:text-typography-300">
                                        {recoveryDescription}
                                    </Text>

                                    <Button
                                        size="md"
                                        className="mt-6 min-w-[220px] self-stretch"
                                        onPress={() => {
                                            router.navigate(modelRecoveryActionRoute as any);
                                        }}
                                    >
                                        <MaterialSymbols
                                            name={hasActiveModel ? 'tune' : 'download'}
                                            size={18}
                                            className="text-typography-0"
                                        />
                                        <ButtonText>{resolvedModelRecoveryActionLabel}</ButtonText>
                                    </Button>

                                    <Text className="mt-4 text-center text-xs leading-5 text-typography-500 dark:text-typography-400">
                                        {activeThread
                                            ? t('chat.emptyExistingThread')
                                            : t('chat.emptyNewThread')}
                                    </Text>
                                </Box>
                            </Box>
                        ) : (
                            <Box className="flex-1 items-center px-6 pt-14 pb-8">
                                <Text className="text-xl font-semibold text-typography-800 dark:text-typography-100">
                                    {t('chat.noMessages')}
                                </Text>
                                <Text className="mt-2 text-center text-sm leading-6 text-typography-500 dark:text-typography-400">
                                    {activeThread
                                        ? t('chat.emptyExistingThread')
                                        : t('chat.emptyNewThread')}
                                </Text>
                            </Box>
                        )}
                    </Box>
                </Box>

                {SHOULD_USE_KEYBOARD_AVOIDING_VIEW ? (
                    <KeyboardAvoidingView
                        testID="chat-keyboard-avoiding-view"
                        behavior="padding"
                        keyboardVerticalOffset={tabBarHeight}
                    >
                        <ChatInputBar
                            draft={composerDraft}
                            onDraftChange={setComposerDraft}
                            onSendMessage={handleSendMessage}
                            onStopGeneration={stopGeneration}
                            disabled={isInputDisabled}
                            isSending={isGenerating}
                            modeLabel={pendingRegenerateMessage ? t('chat.editEarlierMessage') : undefined}
                            modeDescription={pendingRegenerateMessage
                                ? t('chat.editEarlierMessageDescription')
                                : undefined}
                            onCancelMode={pendingRegenerateMessage ? handleCancelComposerMode : undefined}
                        />
                    </KeyboardAvoidingView>
                ) : (
                    <View
                        ref={composerContainerRef}
                        testID="chat-keyboard-avoiding-view"
                        onLayout={() => {
                            if (isKeyboardVisibleRef.current) {
                                updateAndroidKeyboardInsetFromLayout();
                            }
                        }}
                    >
                        <ChatInputBar
                            draft={composerDraft}
                            onDraftChange={setComposerDraft}
                            onSendMessage={handleSendMessage}
                            onStopGeneration={stopGeneration}
                            disabled={isInputDisabled}
                            isSending={isGenerating}
                            modeLabel={pendingRegenerateMessage ? t('chat.editEarlierMessage') : undefined}
                            modeDescription={pendingRegenerateMessage
                                ? t('chat.editEarlierMessageDescription')
                                : undefined}
                            onCancelMode={pendingRegenerateMessage ? handleCancelComposerMode : undefined}
                        />
                        {androidKeyboardInset > 0 ? (
                            <Box testID="chat-android-keyboard-spacer" style={{ height: androidKeyboardInset }} />
                        ) : null}
                    </View>
                )}
            </Box>

            <PresetSelectorSheet
                visible={isPresetSelectorOpen}
                activePresetId={activeThread?.presetId ?? settings.activePresetId}
                onClose={() => setPresetSelectorOpen(false)}
                onSelectPreset={(presetId: string | null) => {
                    const presetSnapshot = resolvePresetSnapshot(presetId);
                    updateSettings({ activePresetId: presetId });

                    if (activeThread) {
                        updateThreadPresetSnapshot(activeThread.id, presetId, presetSnapshot);
                    }
                }}
                onManagePresets={() => {
                    router.push('/presets' as any);
                }}
            />

            <ModelParametersSheet
                visible={isModelParametersOpen}
                modelId={configurableModelId}
                modelLabel={modelLabel}
                params={paramsSource}
                defaultParams={defaultParams}
                contextWindowCeiling={contextWindowCeiling}
                loadParamsDraft={draftLoadParams}
                defaultLoadParams={effectiveDefaultLoadParams}
                recommendedGpuLayers={recommendedGpuLayers}
                applyButtonLabel={applyButtonLabel}
                canApplyReload={canApplyReload}
                isApplyingReload={isApplyingModelReload}
                showApplyReload={showApplyReload}
                onClose={() => {
                    setModelParametersOpen(false);
                }}
                onChangeParams={(partial) => {
                    const nextParams = {
                        ...getGenerationParametersForModel(configurableModelId),
                        ...partial,
                    };
                    updateGenerationParametersForModel(configurableModelId, partial);

                    if (activeThread && activeThread.modelId === configurableModelId) {
                        updateThreadParamsSnapshot(activeThread.id, nextParams);
                    }
                }}
                onChangeLoadParams={(partial) => {
                    if (partial.contextSize !== undefined) {
                        loadDraftSourceRef.current.contextSize = 'user';
                    }
                    if (partial.gpuLayers !== undefined) {
                        loadDraftSourceRef.current.gpuLayers = 'user';
                    }

                    setDraftLoadParams((current) => ({
                        ...current,
                        ...partial,
                        contextSize: partial.contextSize === undefined
                            ? current.contextSize
                            : clampContextWindowTokens(partial.contextSize, contextWindowCeiling),
                    }));
                }}
                onResetParamField={(field) => {
                    const resetParams = getGenerationParametersForModel(null);
                    const partial = { [field]: resetParams[field] } as Partial<typeof resetParams>;
                    const nextParams = {
                        ...getGenerationParametersForModel(configurableModelId),
                        ...partial,
                    };

                    updateGenerationParametersForModel(configurableModelId, partial);

                    if (activeThread && activeThread.modelId === configurableModelId) {
                        updateThreadParamsSnapshot(activeThread.id, nextParams);
                    }
                }}
                onResetLoadField={(field) => {
                    if (field === 'contextSize') {
                        loadDraftSourceRef.current.contextSize = 'default';
                    } else {
                        loadDraftSourceRef.current.gpuLayers = 'default';
                    }

                    setDraftLoadParams((current) => ({
                        ...current,
                        [field]: field === 'gpuLayers'
                            ? (effectiveDefaultLoadParams.gpuLayers ?? recommendedGpuLayers)
                            : effectiveDefaultLoadParams.contextSize,
                    }));
                }}
                onReset={() => {
                    loadDraftSourceRef.current = {
                        contextSize: 'default',
                        gpuLayers: 'default',
                    };
                    resetGenerationParametersForModel(configurableModelId);
                    const resetParams = getGenerationParametersForModel(configurableModelId);
                    setDraftLoadParams({
                        contextSize: effectiveDefaultLoadParams.contextSize,
                        gpuLayers: effectiveDefaultLoadParams.gpuLayers ?? recommendedGpuLayers,
                    });

                    if (activeThread && activeThread.modelId === configurableModelId) {
                        updateThreadParamsSnapshot(activeThread.id, resetParams);
                    }
                }}
                onApplyReload={handleApplyLoadParams}
            />
        </Box>
    );
};
