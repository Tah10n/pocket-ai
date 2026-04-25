import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Alert,
    BackHandler,
    Dimensions,
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
import { useFocusEffect } from '@react-navigation/native';
import { FlashList, FlashListRef } from '@shopify/flash-list';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { ChatHeader } from '@/components/ui/ChatHeader';
import { ChatStatusBanner } from '@/components/ui/ChatStatusBanner';
import { ChatMessageBubble } from '@/components/ui/ChatMessageBubble';
import { ChatSystemEventRow } from '@/components/ui/ChatSystemEventRow';
import { ChatModelSelectorSheet } from '@/components/ui/ChatModelSelectorSheet';
import { ChatInputBar } from '@/components/ui/ChatInputBar';
import { ErrorReportSheet } from '@/components/ui/ErrorReportSheet';
import {
    MODEL_WARMUP_BANNER_RESERVED_HEIGHT,
    ModelWarmupBanner,
    resolveModelWarmupProgressPercent,
} from '@/components/ui/ModelWarmupBanner';
import { ModelParametersSheet } from '@/components/ui/ModelParametersSheet';
import { MaterialSymbols } from '@/components/ui/MaterialSymbols';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { ScreenCard, ScreenIconTile, ScreenRoot, useScreenAppearance } from '@/components/ui/ScreenShell';
import { useTranslation } from 'react-i18next';
import { PresetSelectorSheet } from '@/components/ui/PresetSelectorSheet';
import { resolvePresetSnapshot, useChatSession } from '../../hooks/useChatSession';
import { useLLMEngine } from '../../hooks/useLLMEngine';
import { useErrorReportSheetController, type ErrorReportContext } from '@/hooks/useErrorReportSheetController';
import { useModelParametersSheetController } from '@/hooks/useModelParametersSheetController';
import { useModelRegistryRevision } from '@/hooks/useModelRegistryRevision';
import { useRouter } from 'expo-router';
import { EngineStatus, LifecycleStatus } from '../../types/models';
import { ChatMessage, getThreadActiveModelId } from '../../types/chat';
import { getChatHardwareBannerInputs, hardwareListenerService } from '../../services/HardwareListenerService';
import { registry } from '../../services/LocalStorageRegistry';
import { useChatStore } from '../../store/chatStore';
import { getShortModelLabel } from '@/utils/modelLabel';
import { getReportedErrorMessage } from '../../services/AppError';
import {
    getGenerationParametersForModel,
    getSettings,
    resetGenerationParametersForModel,
    subscribeSettings,
    updateSettings,
    updateGenerationParametersForModel,
} from '../../services/SettingsStore';
import { screenLayoutMetrics } from '../../utils/themeTokens';

const AUTO_SCROLL_REARM_THRESHOLD_PX = 32;
const AUTO_SCROLL_DISARM_THRESHOLD_PX = 64;
const FALLBACK_FLASH_LIST_AUTO_SCROLL_BOTTOM_THRESHOLD_RATIO = 0.02;
const FALLBACK_TOP_K = 40;
const FALLBACK_MIN_P = 0.05;
const FALLBACK_REPETITION_PENALTY = 1;
const SHOULD_USE_KEYBOARD_AVOIDING_VIEW = Platform.OS === 'ios';

type ScrollMetrics = Pick<NativeScrollEvent, 'contentOffset' | 'contentSize' | 'layoutMeasurement'>;

function snapshotScrollMetrics(metrics: ScrollMetrics): ScrollMetrics {
    return {
        contentOffset: { x: metrics.contentOffset.x, y: metrics.contentOffset.y },
        contentSize: { width: metrics.contentSize.width, height: metrics.contentSize.height },
        layoutMeasurement: { width: metrics.layoutMeasurement.width, height: metrics.layoutMeasurement.height },
    };
}

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
    metrics: ScrollMetrics,
    isUserInteracting: boolean,
) {
    if (!isUserInteracting) {
        return currentValue;
    }

    const contentHeight = metrics.contentSize.height;
    const viewportHeight = metrics.layoutMeasurement.height;
    const offsetY = metrics.contentOffset.y;

    if (!Number.isFinite(contentHeight) || !Number.isFinite(viewportHeight) || !Number.isFinite(offsetY)) {
        return currentValue;
    }

    const distanceFromBottom = Math.max(
        contentHeight - viewportHeight - offsetY,
        0,
    );

    if (distanceFromBottom <= AUTO_SCROLL_REARM_THRESHOLD_PX) {
        return true;
    }

    if (distanceFromBottom >= AUTO_SCROLL_DISARM_THRESHOLD_PX) {
        return false;
    }

    // Hysteresis band: keep the previous value to avoid jitter.
    return currentValue;
}

export function getFlashListAutoScrollBottomThreshold(viewportHeight: number) {
    if (viewportHeight <= 0) {
        return FALLBACK_FLASH_LIST_AUTO_SCROLL_BOTTOM_THRESHOLD_RATIO;
    }

    return Math.min(1, AUTO_SCROLL_REARM_THRESHOLD_PX / viewportHeight);
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
    const { state: engineState, loadModel } = useLLMEngine();
    const { t } = useTranslation();
    const appearance = useScreenAppearance();
    const modelRegistryRevision = useModelRegistryRevision();
    const router = useRouter();
    const { openErrorReport, sheetProps: errorReportSheetProps } = useErrorReportSheetController();
    const tabBarHeight = useBottomTabBarHeight();
    const [hardwareStatus, setHardwareStatus] = useState(() => hardwareListenerService.getCurrentStatus());
    const [composerDraft, setComposerDraft] = useState('');
    const [androidKeyboardInset, setAndroidKeyboardInset] = useState(0);
    const [composerContainerHeight, setComposerContainerHeight] = useState(0);
    const [isAutoScrollPaused, setIsAutoScrollPaused] = useState(false);
    const [isListTouching, setIsListTouching] = useState(false);
    const [listViewportHeight, setListViewportHeight] = useState(0);
    const [isPresetSelectorOpen, setPresetSelectorOpen] = useState(false);
    const [isModelSelectorOpen, setModelSelectorOpen] = useState(false);
    const [pendingModelSelection, setPendingModelSelection] = useState<{
        threadId: string | null;
        modelId: string;
    } | null>(null);
    const [settings, setSettings] = useState(() => getSettings());
    const [pendingRegenerateMessage, setPendingRegenerateMessage] = useState<{
        messageId: string;
        originalContent: string;
    } | null>(null);
    const updateThreadPresetSnapshot = useChatStore((state) => state.updateThreadPresetSnapshot);
    const updateThreadParamsSnapshot = useChatStore((state) => state.updateThreadParamsSnapshot);
    const switchThreadModel = useChatStore((state) => state.switchThreadModel);
    const listRef = useRef<FlashListRef<ChatMessage> | null>(null);
    const autoScrollFrameRef = useRef<number | null>(null);
    const keyboardMeasureFrameRef = useRef<number | null>(null);
    const endDragFinalizeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const endDragMetricsRef = useRef<ScrollMetrics | null>(null);
    const touchEndFinalizeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const didDeferAutoScrollWhileTouchingRef = useRef(false);
    const forcedScrollTimeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);
    const forcedFollowPassesRef = useRef(0);
    const baseWindowHeightRef = useRef(Dimensions.get('window').height);
    const isKeyboardVisibleRef = useRef(false);
    const androidKeyboardMetricsRef = useRef<{ height: number; topY: number } | null>(null);
    const composerContainerRef = useRef<View | null>(null);
    const isUserInteractingRef = useRef(false);
    const isListTouchingRef = useRef(false);
    const isMomentumScrollingRef = useRef(false);
    const dragStartOffsetYRef = useRef<number | null>(null);
    const momentumStartOffsetYRef = useRef<number | null>(null);
    const shouldStickToBottomRef = useRef(true);
    const hasActiveModel = Boolean(engineState.activeModelId);
    const isEngineReady = engineState.status === EngineStatus.READY;
    const isModelInitializing = engineState.status === EngineStatus.INITIALIZING;
    const warmupProgressPercent = useMemo(
        () => resolveModelWarmupProgressPercent(engineState.loadProgress),
        [engineState.loadProgress],
    );
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
        (hardwareBannerInputs.showLowMemoryWarning || hardwareBannerInputs.showThermalWarning ? 22 : 14)
        + (isModelInitializing ? MODEL_WARMUP_BANNER_RESERVED_HEIGHT : 0);

    const downloadedModels = useMemo(() => {
        // Force recompute on registry revision changes.
        void modelRegistryRevision;

        return registry.getModels()
            .filter((model) => (
                model.lifecycleStatus === LifecycleStatus.DOWNLOADED
                || model.lifecycleStatus === LifecycleStatus.ACTIVE
            ))
            .sort((left, right) => (left.name ?? left.id).localeCompare(right.name ?? right.id));
    }, [modelRegistryRevision]);

    const activeThreadId = activeThread?.id ?? null;
    const currentChatActiveModelId = activeThread
        ? getThreadActiveModelId(activeThread)
        : settings.activeModelId ?? engineState.activeModelId ?? null;
    const isModelSelectionPending = pendingModelSelection != null;
    const isPendingModelSelectionForCurrentThread = pendingModelSelection != null
        && pendingModelSelection.threadId === activeThreadId;
    const displayedChatActiveModelId = isPendingModelSelectionForCurrentThread
        ? pendingModelSelection.modelId
        : currentChatActiveModelId;

    const headerTitle = activeThread?.title ?? t('chat.newChatTitle');
    const configurableModelId = currentChatActiveModelId;
    const rawCurrentParams = getGenerationParametersForModel(configurableModelId);
    const currentParams = {
        ...rawCurrentParams,
        topK: rawCurrentParams.topK ?? FALLBACK_TOP_K,
        minP: rawCurrentParams.minP ?? FALLBACK_MIN_P,
        repetitionPenalty: rawCurrentParams.repetitionPenalty ?? FALLBACK_REPETITION_PENALTY,
        reasoningEffort: rawCurrentParams.reasoningEffort ?? 'auto',
    };
    const rawDefaultParams = getGenerationParametersForModel(null);
    const defaultParams = {
        ...rawDefaultParams,
        topK: rawDefaultParams.topK ?? FALLBACK_TOP_K,
        minP: rawDefaultParams.minP ?? FALLBACK_MIN_P,
        repetitionPenalty: rawDefaultParams.repetitionPenalty ?? FALLBACK_REPETITION_PENALTY,
        reasoningEffort: rawDefaultParams.reasoningEffort ?? 'auto',
    };
    const displayMessages = messages;
    const hasMessages = displayMessages.length > 0;
    const lastMessage = messages[messages.length - 1];
    const lastMessageSignature = lastMessage
        ? `${lastMessage.id}:${lastMessage.state}:${lastMessage.content.length}:${lastMessage.tokensPerSec ?? -1}`
        : 'empty';
    const modelLabel = displayedChatActiveModelId
        ? (getShortModelLabel(displayedChatActiveModelId) || displayedChatActiveModelId)
        : t('chat.modelUnavailable');
    const rawParamsSource = activeThread?.paramsSnapshot ?? currentParams;
    const paramsSource = {
        ...rawParamsSource,
        topK: rawParamsSource.topK ?? FALLBACK_TOP_K,
        minP: rawParamsSource.minP ?? FALLBACK_MIN_P,
        repetitionPenalty: rawParamsSource.repetitionPenalty ?? FALLBACK_REPETITION_PENALTY,
        reasoningEffort: rawParamsSource.reasoningEffort ?? 'auto',
    };
    const thermalWarningMessage = hardwareBannerInputs.thermalState === 'critical'
        ? t('chat.thermalDescriptionCritical')
        : t('chat.thermalDescriptionElevated');
    const recoveryTitle = hasActiveModel ? t('chat.warmingUp') : t('chat.loadModelWarning');
    const recoveryDescription = hasActiveModel ? t('chat.warmingUpDescription') : t('chat.loadModelDescription');
    const activePresetLabel = activeThread?.presetSnapshot.name ?? (settings.activePresetId ? resolvePresetSnapshot(settings.activePresetId).name : t('common.default'));
    const shouldShowRecoveryBanner = isInputDisabled && hasMessages;
    const shouldShowRecoveryCard = isInputDisabled && !hasMessages;
    const shouldShowFloatingWarmupBanner = isModelInitializing && !shouldShowRecoveryCard;
    const hasDownloadedModels = downloadedModels.length > 0;
    const modelRecoveryActionRoute = hasDownloadedModels
        ? ({ pathname: '/(tabs)/models', params: { initialTab: 'downloaded' } } as const)
        : '/(tabs)/models';
    const resolvedModelRecoveryActionLabel = hasActiveModel
        ? t('chat.openModels')
        : hasDownloadedModels
            ? t('chat.loadModel')
            : t('chat.downloadModel');
    const headerModelLabel = shouldShowRecoveryCard && !hasActiveModel
        ? undefined
        : modelLabel;
    const listMaintainVisibleContentPosition = useMemo(() => {
        // NOTE: FlashList auto-scroll uses autoscrollToBottomThreshold. Some versions ignore the
        // `disabled` flag, so we set the threshold negative to truly disable auto-follow.
        // NOTE: `maintainVisibleContentPosition` is most reliable on RN New Architecture.
        // We keep manual scroll scheduling (scrollToEnd bursts) as a fallback.
        // While the user is pressing the list during streaming, temporarily suspend auto-follow
        // without changing the underlying stickiness state.
        const shouldDisableAutoScroll = isAutoScrollPaused || (isGenerating && isListTouching);
        const autoscrollToBottomThreshold = shouldDisableAutoScroll
            ? -1
            : getFlashListAutoScrollBottomThreshold(listViewportHeight);

        return {
            autoscrollToBottomThreshold,
            animateAutoScrollToBottom: false,
            startRenderingFromBottom: true,
        };
    }, [isAutoScrollPaused, isGenerating, isListTouching, listViewportHeight]);

    const setShouldFollowLatestMessage = useCallback((shouldFollow: boolean) => {
        shouldStickToBottomRef.current = shouldFollow;
        setIsAutoScrollPaused((currentValue) => {
            const nextValue = !shouldFollow;
            return currentValue === nextValue ? currentValue : nextValue;
        });
    }, []);

    const showAlertForError = useCallback((titleKey: string, scope: string, error: unknown) => {
        Alert.alert(t(titleKey), getReportedErrorMessage(scope, error, t));
    }, [t]);

    const showAlertForModelLoadError = useCallback((titleKey: string, scope: string, error: unknown) => {
        const message = getReportedErrorMessage(scope, error, t);
        Alert.alert(
            t(titleKey),
            message,
            [
                { text: t('common.close'), style: 'cancel' },
                {
                    text: t('models.errorReport.reportButton'),
                    onPress: () => {
                        const model = configurableModelId ? registry.getModel(configurableModelId) : undefined;
                        const reportContext: ErrorReportContext = {
                            model: model ? {
                                id: model.id,
                                name: model.name,
                                author: model.author,
                                size: model.size,
                                localPath: model.localPath,
                                downloadUrl: model.downloadUrl,
                                lifecycleStatus: model.lifecycleStatus,
                                accessState: model.accessState,
                            } : configurableModelId ? { id: configurableModelId } : undefined,
                            engine: {
                                status: engineState.status,
                                activeModelId: engineState.activeModelId,
                                loadProgress: engineState.loadProgress,
                                lastError: engineState.lastError,
                            },
                        };

                        openErrorReport({ scope, error, context: reportContext });
                    },
                },
            ],
        );
    }, [
        configurableModelId,
        engineState.activeModelId,
        engineState.lastError,
        engineState.loadProgress,
        engineState.status,
        openErrorReport,
        t,
    ]);

    const handleSelectModelFromHeader = useCallback(async (nextModelId: string) => {
        if (isGenerating) {
            return;
        }

        const selectionThreadId = activeThread?.id ?? null;

        if (nextModelId === currentChatActiveModelId) {
            setPendingModelSelection((currentValue) => (
                currentValue?.threadId === selectionThreadId ? null : currentValue
            ));
            setModelSelectorOpen(false);
            return;
        }

        setPendingModelSelection({ threadId: selectionThreadId, modelId: nextModelId });
        setModelSelectorOpen(false);

        try {
            await loadModel(nextModelId);
        } catch (error) {
            setPendingModelSelection((currentValue) => (
                currentValue?.threadId === selectionThreadId && currentValue.modelId === nextModelId
                    ? null
                    : currentValue
            ));
            showAlertForError('common.actionFailed', 'ChatScreen.loadModel', error);
            return;
        }

        setPendingModelSelection((currentValue) => (
            currentValue?.threadId === selectionThreadId && currentValue.modelId === nextModelId
                ? null
                : currentValue
        ));

        if (!activeThread) {
            return;
        }

        switchThreadModel(activeThread.id, nextModelId);
        updateThreadParamsSnapshot(activeThread.id, getGenerationParametersForModel(nextModelId));
    }, [
        activeThread,
        currentChatActiveModelId,
        isGenerating,
        loadModel,
        showAlertForError,
        switchThreadModel,
        updateThreadParamsSnapshot,
    ]);

    const getConfigurableModelById = useCallback((modelId: string | null) => {
        if (!modelId) {
            return undefined;
        }

        return registry.getModel(modelId);
    }, []);

    const {
        openModelParameters,
        closeModelParameters,
        sheetProps: modelParametersSheetProps,
    } = useModelParametersSheetController({
        getModelById: getConfigurableModelById,
        showError: (scope, error) => {
            showAlertForModelLoadError('chat.applyModelSettingsErrorTitle', scope, error);
        },
        applyReloadErrorScope: 'ChatScreen.handleApplyLoadParams',
        activeModelId: currentChatActiveModelId,
        canApplyReload: !isGenerating,
        modelLabelOverride: modelLabel,
        paramsOverride: paramsSource,
        defaultParamsOverride: defaultParams,
        onChangeParams: (modelId, partial) => {
            const nextParams = {
                ...getGenerationParametersForModel(modelId),
                ...partial,
            };

            updateGenerationParametersForModel(modelId, partial);

            if (activeThread && getThreadActiveModelId(activeThread) === modelId) {
                updateThreadParamsSnapshot(activeThread.id, nextParams);
            }
        },
        onResetParamField: (modelId, field) => {
            const resetParams = getGenerationParametersForModel(null);
            const partial = { [field]: resetParams[field] } as Partial<typeof resetParams>;
            const nextParams = {
                ...getGenerationParametersForModel(modelId),
                ...partial,
            };

            updateGenerationParametersForModel(modelId, partial);

            if (activeThread && getThreadActiveModelId(activeThread) === modelId) {
                updateThreadParamsSnapshot(activeThread.id, nextParams);
            }
        },
        onResetAllParams: (modelId) => {
            resetGenerationParametersForModel(modelId);
            const resetParams = getGenerationParametersForModel(modelId);

            if (activeThread && getThreadActiveModelId(activeThread) === modelId) {
                updateThreadParamsSnapshot(activeThread.id, resetParams);
            }
        },
    });

    const clearForcedScrollTimeouts = useCallback(() => {
        forcedScrollTimeoutsRef.current.forEach((timeoutId) => {
            clearTimeout(timeoutId);
        });
        forcedScrollTimeoutsRef.current = [];
    }, []);

    const clearEndDragFinalizeTimeout = useCallback(() => {
        if (endDragFinalizeTimeoutRef.current === null) {
            return;
        }

        clearTimeout(endDragFinalizeTimeoutRef.current);
        endDragFinalizeTimeoutRef.current = null;
    }, []);

    const clearTouchEndFinalizeTimeout = useCallback(() => {
        if (touchEndFinalizeTimeoutRef.current === null) {
            return;
        }

        clearTimeout(touchEndFinalizeTimeoutRef.current);
        touchEndFinalizeTimeoutRef.current = null;
    }, []);

    const scheduleForcedScrollBurst = useCallback(() => {
        clearForcedScrollTimeouts();

        [32, 96, 192].forEach((delayMs) => {
            const timeoutId = setTimeout(() => {
                listRef.current?.scrollToEnd({ animated: false });
            }, delayMs);

            forcedScrollTimeoutsRef.current.push(timeoutId);
        });
    }, [clearForcedScrollTimeouts]);

    const scrollToLatestMessage = useCallback((animated: boolean) => {
        listRef.current?.scrollToEnd({ animated });
    }, []);

    const scheduleScrollToLatestMessage = useCallback((animated: boolean, force = false) => {
        if (!messages.length || autoScrollFrameRef.current !== null || isUserInteractingRef.current) {
            return;
        }

        if (isListTouchingRef.current) {
            if (force || shouldStickToBottomRef.current) {
                didDeferAutoScrollWhileTouchingRef.current = true;
            }

            return;
        }

        if (!force && !shouldStickToBottomRef.current) {
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

    const handleListTouchStart = useCallback(() => {
        isListTouchingRef.current = true;
        setIsListTouching(true);
        clearEndDragFinalizeTimeout();
        clearTouchEndFinalizeTimeout();
        forcedFollowPassesRef.current = 0;
        clearForcedScrollTimeouts();

        // Clear any stale drag/momentum bookkeeping so a simple tap cannot inherit a previous gesture.
        dragStartOffsetYRef.current = null;
        momentumStartOffsetYRef.current = null;
        endDragMetricsRef.current = null;
        isMomentumScrollingRef.current = false;
        isUserInteractingRef.current = false;

        if (autoScrollFrameRef.current !== null) {
            cancelAnimationFrame(autoScrollFrameRef.current);
            autoScrollFrameRef.current = null;
        }

        // Do not change stickiness here: a tap should not permanently disable auto-follow.
        // Auto-scroll is temporarily suspended via maintainVisibleContentPosition while the
        // list is touched.
    }, [clearEndDragFinalizeTimeout, clearForcedScrollTimeouts, clearTouchEndFinalizeTimeout]);

    const handleListTouchEnd = useCallback(() => {
        isListTouchingRef.current = false;
        setIsListTouching(false);

        if (!didDeferAutoScrollWhileTouchingRef.current) {
            return;
        }

        clearTouchEndFinalizeTimeout();
        touchEndFinalizeTimeoutRef.current = setTimeout(() => {
            touchEndFinalizeTimeoutRef.current = null;

            if (!didDeferAutoScrollWhileTouchingRef.current) {
                return;
            }

            didDeferAutoScrollWhileTouchingRef.current = false;

            if (!shouldStickToBottomRef.current) {
                return;
            }

            scheduleScrollToLatestMessage(false, true);
        }, 0);
    }, [clearTouchEndFinalizeTimeout, scheduleScrollToLatestMessage]);

    const handleListTouchCancel = useCallback(() => {
        isListTouchingRef.current = false;
        setIsListTouching(false);

        if (!didDeferAutoScrollWhileTouchingRef.current) {
            return;
        }

        clearTouchEndFinalizeTimeout();
        touchEndFinalizeTimeoutRef.current = setTimeout(() => {
            touchEndFinalizeTimeoutRef.current = null;

            if (!didDeferAutoScrollWhileTouchingRef.current) {
                return;
            }

            didDeferAutoScrollWhileTouchingRef.current = false;

            if (!shouldStickToBottomRef.current) {
                return;
            }

            scheduleScrollToLatestMessage(false, true);
        }, 0);
    }, [clearTouchEndFinalizeTimeout, scheduleScrollToLatestMessage]);

    const updateStickinessFromNativeEvent = (
        nativeEvent: ScrollMetrics,
        options: { allowRearmToBottom?: boolean } = {},
    ) => {
        const allowRearmToBottom = options.allowRearmToBottom ?? true;
        const currentValue = shouldStickToBottomRef.current;
        const nextValue = getNextShouldStickToBottom(
            currentValue,
            nativeEvent,
            isUserInteractingRef.current,
        );

        if (!allowRearmToBottom && !currentValue && nextValue) {
            return;
        }

        setShouldFollowLatestMessage(nextValue);
    };

    const updateStickinessFromScrollEvent = (
        event: NativeSyntheticEvent<NativeScrollEvent>,
        options: { allowRearmToBottom?: boolean } = {},
    ) => {
        updateStickinessFromNativeEvent(event.nativeEvent, options);
    };

    const handleListScrollBeginDrag = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
        clearEndDragFinalizeTimeout();
        clearTouchEndFinalizeTimeout();
        isMomentumScrollingRef.current = false;
        dragStartOffsetYRef.current = event.nativeEvent.contentOffset.y;
        momentumStartOffsetYRef.current = null;
        isListTouchingRef.current = true;
        setIsListTouching(true);
        isUserInteractingRef.current = true;
        setShouldFollowLatestMessage(false);
        forcedFollowPassesRef.current = 0;
        clearForcedScrollTimeouts();

        if (autoScrollFrameRef.current !== null) {
            cancelAnimationFrame(autoScrollFrameRef.current);
            autoScrollFrameRef.current = null;
        }
    };

    const handleListScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
        updateStickinessFromScrollEvent(event, { allowRearmToBottom: false });
    };

    const handleListScrollEndDrag = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
        // Drag end implies the user's touch has ended.
        isListTouchingRef.current = false;
        setIsListTouching(false);

        // Snapshot the scroll metrics we need because we reference them asynchronously.
        endDragMetricsRef.current = snapshotScrollMetrics(event.nativeEvent);

        // If momentum scrolling begins, we must keep auto-follow disabled until momentum ends.
        // We delay deciding whether to re-arm until after the JS loop yields so that
        // `onMomentumScrollBegin` (if any) can flip the momentum flag.
        isUserInteractingRef.current = true;
        clearEndDragFinalizeTimeout();

        endDragFinalizeTimeoutRef.current = setTimeout(() => {
            endDragFinalizeTimeoutRef.current = null;

            if (isMomentumScrollingRef.current) {
                return;
            }

            const nativeEvent = endDragMetricsRef.current;
            if (nativeEvent) {
                const startOffsetY = dragStartOffsetYRef.current ?? nativeEvent.contentOffset.y;
                const endOffsetY = nativeEvent.contentOffset.y;

                // If the user's swipe moved away from the bottom (opposite of auto-follow direction),
                // keep auto-follow disabled even when still near the bottom.
                if (endOffsetY >= startOffsetY) {
                    updateStickinessFromNativeEvent(nativeEvent);
                }
            }

            dragStartOffsetYRef.current = null;
            endDragMetricsRef.current = null;

            isUserInteractingRef.current = false;
        }, 0);
    };

    const handleListMomentumScrollBegin = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
        clearEndDragFinalizeTimeout();
        clearTouchEndFinalizeTimeout();
        isMomentumScrollingRef.current = true;
        isUserInteractingRef.current = true;
        // Momentum implies the user's touch has ended.
        isListTouchingRef.current = false;
        setIsListTouching(false);
        dragStartOffsetYRef.current = null;
        momentumStartOffsetYRef.current = event.nativeEvent?.contentOffset?.y
            ?? endDragMetricsRef.current?.contentOffset?.y
            ?? null;
        setShouldFollowLatestMessage(false);
        forcedFollowPassesRef.current = 0;
        clearForcedScrollTimeouts();

        if (autoScrollFrameRef.current !== null) {
            cancelAnimationFrame(autoScrollFrameRef.current);
            autoScrollFrameRef.current = null;
        }
    };

    const handleListMomentumScrollEnd = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
        clearEndDragFinalizeTimeout();
        clearTouchEndFinalizeTimeout();
        isMomentumScrollingRef.current = false;
        isListTouchingRef.current = false;
        setIsListTouching(false);
        const startOffsetY = momentumStartOffsetYRef.current;
        const endOffsetY = event.nativeEvent.contentOffset.y;

        // If the inertial scroll moved away from the bottom overall, keep auto-follow disabled.
        if (startOffsetY === null || endOffsetY >= startOffsetY) {
            updateStickinessFromScrollEvent(event);
        }

        momentumStartOffsetYRef.current = null;
        endDragMetricsRef.current = null;
        isUserInteractingRef.current = false;
    };

    const handleListViewportLayout = (event: LayoutChangeEvent) => {
        const nextViewportHeight = event.nativeEvent.layout.height;
        setListViewportHeight((currentValue) => (
            Math.abs(currentValue - nextViewportHeight) < 1 ? currentValue : nextViewportHeight
        ));

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

        if (!composerContainer || typeof composerContainer.measure !== 'function') {
            setAndroidKeyboardInset(viewportCompensation);
            return;
        }

        if (keyboardMeasureFrameRef.current !== null) {
            cancelAnimationFrame(keyboardMeasureFrameRef.current);
        }

        keyboardMeasureFrameRef.current = requestAnimationFrame(() => {
            keyboardMeasureFrameRef.current = null;

            composerContainer.measure((_x, _y, _width, height, _pageX, pageY) => {
                setAndroidKeyboardInset(getAndroidKeyboardSpacerHeight({
                    viewportCompensation,
                    composerBottomY: pageY + height,
                    keyboardTopY: keyboardMetrics.topY,
                    gap: screenLayoutMetrics.keyboardComposerGap,
                }));
            });
        });
    }, [tabBarHeight]);

    const handleComposerContainerLayout = useCallback((event: LayoutChangeEvent) => {
        const nextHeight = event.nativeEvent.layout.height;
        setComposerContainerHeight((currentValue) => (
            Math.abs(currentValue - nextHeight) < 1 ? currentValue : nextHeight
        ));

        if (isKeyboardVisibleRef.current) {
            updateAndroidKeyboardInsetFromLayout();
        }
    }, [updateAndroidKeyboardInsetFromLayout]);

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
        setShouldFollowLatestMessage(true);
        isUserInteractingRef.current = false;
        forcedFollowPassesRef.current = burst ? 6 : 1;
        clearForcedScrollTimeouts();

        if (autoScrollFrameRef.current !== null) {
            cancelAnimationFrame(autoScrollFrameRef.current);
            autoScrollFrameRef.current = null;
        }

        if (messages.length || activeThread) {
            scrollToLatestMessage(false);
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
        setShouldFollowLatestMessage,
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

    const handleBeginRegenerateFromMessage = useCallback((messageId: string) => {
        const activeThread = useChatStore.getState().getActiveThread();
        const message = activeThread?.messages.find((entry) => entry.id === messageId);
        if (!message) {
            return;
        }

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

    const handleDeleteMessage = useCallback((messageId: string) => {
        const activeThread = useChatStore.getState().getActiveThread();
        const message = activeThread?.messages.find((entry) => entry.id === messageId);
        if (!message) {
            return;
        }

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
                            const deleted = deleteMessage(messageId);
                            if (deleted && pendingRegenerateMessage?.messageId === messageId) {
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
        if (!pendingModelSelection) {
            return;
        }

        if (pendingModelSelection.threadId !== activeThreadId) {
            return;
        }

        if (currentChatActiveModelId === pendingModelSelection.modelId) {
            setPendingModelSelection(null);
        }
    }, [activeThreadId, currentChatActiveModelId, pendingModelSelection]);

    useEffect(() => {
        if (Platform.OS !== 'android') {
            return;
        }

        baseWindowHeightRef.current = Dimensions.get('window').height;

        const dimensionsSubscription = Dimensions.addEventListener('change', ({ window }) => {
            if (!isKeyboardVisibleRef.current) {
                baseWindowHeightRef.current = window.height;
                return;
            }

            const keyboardMetrics = androidKeyboardMetricsRef.current;

            if (keyboardMetrics) {
                const screenHeight = Dimensions.get('screen').height;
                keyboardMetrics.topY = Math.max(0, screenHeight - keyboardMetrics.height);
            }

            updateAndroidKeyboardInsetFromLayout();
        });

        const updateKeyboardMetrics = (event: KeyboardEvent) => {
            isKeyboardVisibleRef.current = true;
            androidKeyboardMetricsRef.current = {
                height: event.endCoordinates.height,
                topY: event.endCoordinates.screenY > 0
                    ? event.endCoordinates.screenY
                    : Math.max(0, Dimensions.get('screen').height - event.endCoordinates.height),
            };
        };

        const keyboardWillShowSubscription = Keyboard.addListener('keyboardWillShow', (event: KeyboardEvent) => {
            updateKeyboardMetrics(event);
            updateAndroidKeyboardInsetFromLayout();
        });

        const keyboardShowSubscription = Keyboard.addListener('keyboardDidShow', (event: KeyboardEvent) => {
            updateKeyboardMetrics(event);
            updateAndroidKeyboardInsetFromLayout();
        });

        const keyboardFrameSubscription = Keyboard.addListener('keyboardDidChangeFrame', (event: KeyboardEvent) => {
            updateKeyboardMetrics(event);
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
            keyboardWillShowSubscription.remove();
            keyboardShowSubscription.remove();
            keyboardFrameSubscription.remove();
            keyboardHideSubscription.remove();
        };
    }, [updateAndroidKeyboardInsetFromLayout]);

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

            clearEndDragFinalizeTimeout();
            clearTouchEndFinalizeTimeout();
            clearForcedScrollTimeouts();
        };
    }, [clearEndDragFinalizeTimeout, clearForcedScrollTimeouts, clearTouchEndFinalizeTimeout]);

    useEffect(() => {
        setShouldFollowLatestMessage(true);
        isUserInteractingRef.current = false;
        forcedFollowPassesRef.current = 0;
        clearForcedScrollTimeouts();
        setPendingRegenerateMessage(null);
        setComposerDraft('');
        setPresetSelectorOpen(false);
        setModelSelectorOpen(false);
        closeModelParameters();
    }, [activeThread?.id, clearForcedScrollTimeouts, closeModelParameters, setShouldFollowLatestMessage]);

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

    const renderChatMessage = useCallback(({ item: msg, index }: { item: ChatMessage; index: number }) => {
        if (msg.kind === 'model_switch') {
            return (
                <ChatSystemEventRow
                    id={msg.id}
                    fromModelId={msg.switchFromModelId ?? ''}
                    toModelId={msg.switchToModelId ?? msg.modelId ?? ''}
                    onLayout={index === messages.length - 1 ? handleLastMessageLayout : undefined}
                />
            );
        }

        return (
            <ChatMessageBubble
                id={msg.id}
                isUser={msg.role === 'user'}
                content={msg.content}
                thoughtContent={msg.thoughtContent}
                errorMessage={msg.errorMessage}
                isStreaming={msg.state === 'streaming'}
                tokensPerSec={msg.tokensPerSec}
                canDelete={msg.state !== 'streaming'}
                canRegenerate={
                    msg.role === 'user'
                    && msg.state === 'complete'
                    && !isGenerating
                    && !isInputDisabled
                }
                onDelete={handleDeleteMessage}
                onRegenerate={handleBeginRegenerateFromMessage}
                onLayout={index === messages.length - 1 ? handleLastMessageLayout : undefined}
            />
        );
    }, [
        handleBeginRegenerateFromMessage,
        handleDeleteMessage,
        handleLastMessageLayout,
        isGenerating,
        isInputDisabled,
        messages.length,
    ]);

    return (
        <ScreenRoot className="w-full max-w-2xl mx-auto">
            <ChatHeader
                title={headerTitle}
                presetLabel={activePresetLabel}
                modelLabel={headerModelLabel}
                modelSelectable={hasDownloadedModels}
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
                    openModelParameters(configurableModelId);
                }}
                onOpenPresetSelector={() => {
                    setPresetSelectorOpen(true);
                }}
                canOpenPresetSelector={!isGenerating}
                onOpenModelSelector={hasDownloadedModels
                    ? () => {
                        setModelSelectorOpen(true);
                    }
                    : undefined}
                canOpenModelSelector={hasDownloadedModels && !isGenerating && !isModelSelectionPending}
                canOpenModelControls={Boolean(configurableModelId) && !isGenerating && !isModelSelectionPending}
                onBack={router.canGoBack() ? () => router.back() : undefined}
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
                                    router.navigate(modelRecoveryActionRoute);
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

                    <Box testID="chat-list-viewport" className="flex-1" onLayout={handleListViewportLayout}>
                        {hasMessages ? (
                            <FlashList
                                key={activeThread?.id ?? 'no-thread'}
                                ref={listRef}
                                data={displayMessages}
                                extraData={`${lastMessageSignature}:${pendingRegenerateMessage?.messageId ?? 'none'}:${isInputDisabled ? 'disabled' : 'enabled'}`}
                                showsVerticalScrollIndicator={false}
                                scrollEventThrottle={16}
                                keyboardShouldPersistTaps="handled"
                                onTouchStart={handleListTouchStart}
                                onTouchEnd={handleListTouchEnd}
                                onTouchCancel={handleListTouchCancel}
                                contentContainerStyle={{ paddingTop: 4, paddingBottom: listBottomPadding, flexGrow: 1 }}
                                maintainVisibleContentPosition={listMaintainVisibleContentPosition}
                                onContentSizeChange={handleListContentSizeChange}
                                onLoad={handleListContentSizeChange}
                                onScroll={handleListScroll}
                                onScrollBeginDrag={handleListScrollBeginDrag}
                                onScrollEndDrag={handleListScrollEndDrag}
                                onMomentumScrollBegin={handleListMomentumScrollBegin}
                                onMomentumScrollEnd={handleListMomentumScrollEnd}
                                ItemSeparatorComponent={() => <Box className="h-2" />}
                                keyExtractor={(item) => item.id}
                                renderItem={renderChatMessage}
                            />
                        ) : shouldShowRecoveryCard ? (
                            <Box className="flex-1 justify-center px-3 pb-10">
                                <ScreenCard
                                     testID="chat-recovery-card"
                                    tone="warning"
                                    padding="none"
                                    className="items-center px-6 py-8"
                                 >
                                    <ScreenIconTile
                                        iconName={hasActiveModel ? 'hourglass-empty' : 'download'}
                                        tone="warning"
                                        size="lg"
                                        iconSize="xl"
                                        className="h-16 w-16 rounded-full"
                                    />

                                    {hasActiveModel ? (
                                        <Box className={`mt-4 ${appearance.classNames.inlinePillClassName}`}>
                                            <Text className="text-xs font-semibold uppercase tracking-wide text-typography-600 dark:text-typography-300">
                                                {modelLabel}
                                            </Text>
                                        </Box>
                                    ) : null}

                                    <Text
                                        className="mt-5 text-center text-xl font-semibold leading-7 text-typography-900 dark:text-typography-100"
                                    >
                                        {recoveryTitle}
                                    </Text>

                                    {isModelInitializing ? (
                                        <Box className={`mt-4 w-full rounded-2xl border px-3 py-2.5 ${appearance.classNames.toneClassNameByTone.accent.surfaceClassName}`}>
                                            <Box className="mb-2 flex-row items-center justify-end">
                                                <Box className={`rounded-full px-2.5 py-1 ${appearance.classNames.toneClassNameByTone.accent.percentPillClassName}`}>
                                                    <Text className="text-xs font-bold text-primary-700 dark:text-primary-200">
                                                        {warmupProgressPercent}%
                                                    </Text>
                                                </Box>
                                            </Box>
                                            <ProgressBar
                                                testID="chat-recovery-warmup-progress-track"
                                                fillTestID="chat-recovery-warmup-progress-fill"
                                                valuePercent={warmupProgressPercent}
                                                size="lg"
                                                tone="primary"
                                                variant="framed"
                                            />
                                        </Box>
                                    ) : null}

                                    <Text
                                        className="mt-3 text-center text-sm leading-6 text-typography-600 dark:text-typography-300"
                                    >
                                        {recoveryDescription}
                                    </Text>

                                    <Button
                                        size="md"
                                        className="mt-6 self-stretch"
                                        onPress={() => {
                                            router.navigate(modelRecoveryActionRoute);
                                        }}
                                    >
                                        <MaterialSymbols
                                            name={hasActiveModel ? 'tune' : 'download'}
                                            size={18}
                                            className="text-typography-0"
                                        />
                                        <ButtonText>{resolvedModelRecoveryActionLabel}</ButtonText>
                                    </Button>

                                    <Text
                                        className="mt-4 text-center text-xs leading-5 text-typography-500 dark:text-typography-300"
                                    >
                                        {activeThread
                                            ? t('chat.emptyExistingThread')
                                            : t('chat.emptyNewThread')}
                                    </Text>
                                </ScreenCard>
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
                        onLayout={handleComposerContainerLayout}
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
                        onLayout={handleComposerContainerLayout}
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

            {shouldShowFloatingWarmupBanner ? (
                <ModelWarmupBanner
                    engineState={engineState}
                    bottomOffset={composerContainerHeight}
                />
            ) : null}

            <ChatModelSelectorSheet
                visible={isModelSelectorOpen}
                models={downloadedModels}
                currentModelId={displayedChatActiveModelId}
                canSelect={!isGenerating && !isModelSelectionPending}
                onClose={() => setModelSelectorOpen(false)}
                onSelectModel={(modelId) => {
                    void handleSelectModelFromHeader(modelId);
                }}
            />

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
                    router.push('/presets');
                }}
            />

            <ModelParametersSheet {...modelParametersSheetProps} />
            <ErrorReportSheet {...errorReportSheetProps} />
        </ScreenRoot>
    );
};
