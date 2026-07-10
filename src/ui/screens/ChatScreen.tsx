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
    StyleSheet,
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
import { ChatInputBar, markChatInputDraftConsumedError } from '@/components/ui/ChatInputBar';
import { ErrorReportSheet } from '@/components/ui/ErrorReportSheet';
import {
    MODEL_WARMUP_BANNER_RESERVED_HEIGHT,
    ModelWarmupBanner,
    resolveModelWarmupProgressPercent,
} from '@/components/ui/ModelWarmupBanner';
import { ModelParametersSheet } from '@/components/ui/ModelParametersSheet';
import { MaterialSymbols } from '@/components/ui/MaterialSymbols';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { ScreenAndroidContentBlurTarget, ScreenCard, ScreenIconTile, ScreenRoot, ScreenSurface, useScreenAppearance } from '@/components/ui/ScreenShell';
import { useTranslation } from 'react-i18next';
import { PresetSelectorSheet } from '@/components/ui/PresetSelectorSheet';
import { resolvePresetSnapshot, useChatSession } from '../../hooks/useChatSession';
import { useLLMEngine } from '../../hooks/useLLMEngine';
import { useErrorReportSheetController, type ErrorReportContext } from '@/hooks/useErrorReportSheetController';
import { useFloatingScrollInsets } from '../../hooks/useTabBarContentInset';
import { useChatImageAttachments } from '../../hooks/useChatImageAttachments';
import { useChatDocumentAttachments } from '../../hooks/useChatDocumentAttachments';
import { useChatMediaAttachments } from '../../hooks/useChatMediaAttachments';
import { useModelParametersSheetController } from '@/hooks/useModelParametersSheetController';
import { useModelRegistryRevision } from '@/hooks/useModelRegistryRevision';
import { useRouter } from 'expo-router';
import { EngineStatus, LifecycleStatus, type ModelMetadata } from '../../types/models';
import { ChatMessage, getThreadActiveModelId } from '../../types/chat';
import type { ChatDocumentAttachmentDraft, ChatMediaAttachmentDraft } from '../../types/attachments';
import type {
    AttachmentDraft,
    MultimodalReadinessState,
    MultimodalReadinessStatus,
    MultimodalSupportModality,
} from '../../types/multimodal';
import { getChatHardwareBannerInputs, hardwareListenerService } from '../../services/HardwareListenerService';
import { registry } from '../../services/LocalStorageRegistry';
import { useChatStore } from '../../store/chatStore';
import { getShortModelLabel } from '@/utils/modelLabel';
import { getReportedErrorMessage, toAppError } from '../../services/AppError';
import {
    getGenerationParametersForModel,
    getSettings,
    resetGenerationParametersForModel,
    subscribeSettings,
    updateSettings,
    updateGenerationParametersForModel,
} from '../../services/SettingsStore';
import { getThemeActionContentClassName, screenLayoutMetrics } from '../../utils/themeTokens';
import { handleModelLoadMemoryPolicyError } from '../../utils/modelLoadMemoryPolicyPrompt';
import { resolveEffectiveActiveVariantNativeSupport } from '../../utils/modelCapabilities';
import { isMultimodalReadinessReusableForModel } from '../../utils/multimodalReadiness';
import type { LoadModelOptions } from '../../services/LLMEngineService';
import { getReadinessStatusForProjectorLifecycle, projectorArtifactService } from '../../services/ProjectorArtifactService';

const AUTO_SCROLL_REARM_THRESHOLD_PX = 32;
const AUTO_SCROLL_DISARM_THRESHOLD_PX = 64;
const FALLBACK_FLASH_LIST_AUTO_SCROLL_BOTTOM_THRESHOLD_RATIO = 0.02;
const FALLBACK_TOP_K = 40;
const FALLBACK_MIN_P = 0.05;
const FALLBACK_REPETITION_PENALTY = 1;
const SHOULD_USE_KEYBOARD_AVOIDING_VIEW = Platform.OS === 'ios';
const KEYBOARD_SPACER_SETTLE_EPSILON = 0.5;
const VISION_READINESS_TRANSLATION_KEYS: Record<MultimodalReadinessStatus, string> = {
    ready: 'chat.visionReadiness.ready',
    text_only: 'chat.visionReadiness.textOnly',
    missing_projector: 'chat.visionReadiness.missingProjector',
    ambiguous_projector: 'chat.visionReadiness.ambiguousProjector',
    projector_downloading: 'chat.visionReadiness.projectorDownloading',
    initializing: 'chat.visionReadiness.initializing',
    failed: 'chat.visionReadiness.failed',
    unsupported: 'chat.visionReadiness.unsupported',
};

function getMissingAttachmentDraftIdsFromPreAppendFailure(error: unknown): Set<string> | null {
    const appError = toAppError(error);
    if (appError.code !== 'chat_attachment_missing') {
        return null;
    }

    const details = appError.details;
    const ids = new Set<string>();
    const attachmentIds = details?.attachmentIds;
    if (Array.isArray(attachmentIds)) {
        attachmentIds.forEach((attachmentId) => {
            if (typeof attachmentId === 'string' && attachmentId.length > 0) {
                ids.add(attachmentId);
            }
        });
    }

    if (typeof details?.attachmentId === 'string' && details.attachmentId.length > 0) {
        ids.add(details.attachmentId);
    }

    return ids;
}

function splitAttachmentDraftsById<T extends { id?: string }>(
    drafts: readonly T[],
    idsToMatch: ReadonlySet<string>,
): { matchedDrafts: T[]; remainingDrafts: T[] } {
    const matchedDrafts: T[] = [];
    const remainingDrafts: T[] = [];

    drafts.forEach((draft) => {
        if (draft.id && idsToMatch.has(draft.id)) {
            matchedDrafts.push(draft);
        } else {
            remainingDrafts.push(draft);
        }
    });

    return { matchedDrafts, remainingDrafts };
}
const IMAGE_ATTACHMENTS_NO_MODEL_REASON_KEY = 'chat.visionReadiness.noModel';
const IMAGE_ATTACHMENTS_EDITING_REASON_KEY = 'chat.visionReadiness.editingMessage';
const DOCUMENT_ATTACHMENTS_EDITING_REASON_KEY = 'chat.attachments.documentEditingDisabled';
const MEDIA_ATTACHMENTS_EDITING_REASON_KEY = 'chat.attachments.mediaEditingDisabled';
const MEDIA_ATTACHMENTS_RUNTIME_UNAVAILABLE_REASON_KEY = 'chat.attachments.mediaRuntimeUnavailable';

function isVisionReadinessReady(readiness: MultimodalReadinessState): boolean {
    return readiness.status === 'ready' && readiness.support.includes('vision');
}

function isAudioReadinessReady(readiness: MultimodalReadinessState): boolean {
    return readiness.status === 'ready' && readiness.support.includes('audio');
}

function canSendRetainedAttachment(
    attachment: NonNullable<ChatMessage['attachments']>[number],
    readiness: MultimodalReadinessState,
): boolean {
    if ('kind' in attachment) {
        if (attachment.kind === 'audio') {
            return isAudioReadinessReady(readiness);
        }

        if (attachment.kind === 'document') {
            return true;
        }

        return isVisionReadinessReady(readiness);
    }

    return isVisionReadinessReady(readiness);
}

type ScrollMetrics = Pick<NativeScrollEvent, 'contentOffset' | 'contentSize' | 'layoutMeasurement'>;

function getVisionReadinessTranslationKey(status: MultimodalReadinessStatus): string {
    return VISION_READINESS_TRANSLATION_KEYS[status];
}

function resolveImageAttachmentReadinessReason({
    activeModelId,
    displayedModelId,
    isEngineReady,
    readiness,
}: {
    activeModelId?: string | null;
    displayedModelId?: string | null;
    isEngineReady: boolean;
    readiness: MultimodalReadinessState;
}): string {
    if (!displayedModelId) {
        return IMAGE_ATTACHMENTS_NO_MODEL_REASON_KEY;
    }

    if (!isEngineReady || activeModelId !== displayedModelId) {
        return 'chat.visionReadiness.initializing';
    }

    if (readiness.status === 'ready' && !readiness.support.includes('vision')) {
        return 'chat.visionReadiness.unsupported';
    }

    return getVisionReadinessTranslationKey(readiness.status);
}

function resolveRetainedRegenerateAttachmentBlockedReason({
    audioReadinessReason,
    imageReadinessReason,
    readiness,
    retainedAttachments,
}: {
    audioReadinessReason: string | undefined;
    imageReadinessReason: string;
    readiness: MultimodalReadinessState;
    retainedAttachments: ChatMessage['attachments'];
}): string {
    let hasBlockedAudio = false;
    let hasBlockedVision = false;

    for (const attachment of retainedAttachments ?? []) {
        if (canSendRetainedAttachment(attachment, readiness)) {
            continue;
        }

        if ('kind' in attachment && attachment.kind === 'audio') {
            hasBlockedAudio = true;
        } else if (!('kind' in attachment) || attachment.kind !== 'document') {
            hasBlockedVision = true;
        }
    }

    if (hasBlockedAudio && hasBlockedVision) {
        return MEDIA_ATTACHMENTS_RUNTIME_UNAVAILABLE_REASON_KEY;
    }

    if (hasBlockedAudio) {
        return audioReadinessReason ?? 'chat.attachments.audioRuntimeUnavailable';
    }

    return imageReadinessReason;
}

function resolveRequestedSupportFromNativeModalities(
    requestedNativeModalities: { vision: boolean; audio: boolean },
): MultimodalSupportModality[] {
    return [
        ...(requestedNativeModalities.vision ? ['vision' as const] : []),
        ...(requestedNativeModalities.audio ? ['audio' as const] : []),
    ];
}

export function resolveFallbackMultimodalReadiness(
    model: ModelMetadata | undefined,
    modelId: string | null,
): MultimodalReadinessState {
    const resolvedModelId = modelId ?? model?.id ?? '';

    if (!model) {
        return {
            modelId: resolvedModelId,
            status: 'text_only',
            support: [],
            checkedAt: 0,
        };
    }

    const requestedNativeModalities = resolveEffectiveActiveVariantNativeSupport(model);
    if (!requestedNativeModalities.vision && !requestedNativeModalities.audio) {
        return {
            modelId: resolvedModelId,
            status: 'text_only',
            support: [],
            checkedAt: 0,
        };
    }
    const requestedSupport = resolveRequestedSupportFromNativeModalities(requestedNativeModalities);
    const requestedSupportPayload = requestedSupport.length > 0 ? { requestedSupport } : null;

    const resolution = projectorArtifactService.resolveProjectorForModel(model);
    const selectedProjector = resolution.selectedProjector;
    const persistedReadiness = model.multimodalReadiness;

    if (!selectedProjector) {
        const fallbackReadiness: MultimodalReadinessState = {
            modelId: resolvedModelId,
            status: resolution.status === 'ambiguous'
                ? 'ambiguous_projector'
                : resolution.status === 'failed'
                    ? 'failed'
                    : 'missing_projector',
            support: [],
            ...requestedSupportPayload,
            failureReason: resolution.status === 'failed' ? resolution.reason : undefined,
            checkedAt: 0,
        };

        return fallbackReadiness;
    }

    const lifecycleReadiness = getReadinessStatusForProjectorLifecycle(selectedProjector);
    const status = lifecycleReadiness ?? 'initializing';

    const fallbackReadiness: MultimodalReadinessState = {
        modelId: resolvedModelId,
        status,
        projectorId: selectedProjector.id,
        projectorSize: selectedProjector.size ?? undefined,
        support: [],
        ...requestedSupportPayload,
        failureReason: status === 'failed'
            ? selectedProjector.matchReason ?? resolution.reason
            : undefined,
        checkedAt: 0,
    };

    const canReusePersistedReadiness = isMultimodalReadinessReusableForModel({
        model,
        readiness: persistedReadiness,
        projectorId: selectedProjector.id,
        requestedSupport,
        projectorCandidates: resolution.candidates,
    });
    if (
        canReusePersistedReadiness
        && lifecycleReadiness === null
        && (persistedReadiness?.status === 'ready' || persistedReadiness?.status === 'unsupported')
    ) {
        return persistedReadiness;
    }

    if (
        persistedReadiness?.status === 'failed'
        && canReusePersistedReadiness
        && status === 'initializing'
    ) {
        return persistedReadiness;
    }

    return fallbackReadiness;
}

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
    currentSpacerHeight = 0,
    composerBottomY,
    keyboardTopY,
    gap = 8,
}: {
    viewportCompensation: number;
    currentSpacerHeight?: number;
    composerBottomY?: number | null;
    keyboardTopY?: number | null;
    gap?: number;
}) {
    if (typeof composerBottomY === 'number' && typeof keyboardTopY === 'number') {
        const measuredDelta = composerBottomY + gap - keyboardTopY;

        if (Math.abs(measuredDelta) < KEYBOARD_SPACER_SETTLE_EPSILON) {
            return Math.max(0, currentSpacerHeight);
        }

        return Math.max(0, currentSpacerHeight + measuredDelta);
    }

    return Math.max(viewportCompensation, currentSpacerHeight);
}

export function shouldFloatAndroidComposerOverContent({
    platform,
    surfaceKind,
}: {
    platform: typeof Platform.OS;
    surfaceKind: 'solid' | 'glass';
    isKeyboardVisible?: boolean;
}) {
    return platform === 'android' && surfaceKind === 'glass';
}

export function getAndroidFloatingComposerBottomOffset({
    tabBarInset,
    androidKeyboardInset,
    isKeyboardVisible,
    gap = screenLayoutMetrics.keyboardComposerGap,
}: {
    tabBarInset: number;
    androidKeyboardInset: number;
    isKeyboardVisible: boolean;
    gap?: number;
}) {
    return isKeyboardVisible
        ? Math.max(androidKeyboardInset, gap)
        : tabBarInset;
}

export function getChatListBottomChromeInset({
    composerContainerHeight,
    tabBarInset,
    androidKeyboardInset,
    shouldFloatComposerOverContent,
    isKeyboardVisible,
    gap = screenLayoutMetrics.keyboardComposerGap,
}: {
    composerContainerHeight: number;
    tabBarInset: number;
    androidKeyboardInset: number;
    shouldFloatComposerOverContent: boolean;
    isKeyboardVisible: boolean;
    gap?: number;
}) {
    if (!shouldFloatComposerOverContent) {
        return tabBarInset;
    }

    return composerContainerHeight + getAndroidFloatingComposerBottomOffset({
        tabBarInset,
        androidKeyboardInset,
        isKeyboardVisible,
        gap,
    }) + gap;
}

export function shouldRenderAndroidKeyboardSpacer({
    platform,
    shouldFloatComposerOverContent,
    androidKeyboardInset,
}: {
    platform: typeof Platform.OS;
    shouldFloatComposerOverContent: boolean;
    androidKeyboardInset: number;
}) {
    return platform === 'android' && !shouldFloatComposerOverContent && androidKeyboardInset > 0;
}

export function getChatWarmupBannerBottomOffset({
    composerContainerHeight,
    tabBarInset,
    androidKeyboardInset,
    shouldFloatComposerOverContent,
    isKeyboardVisible = false,
}: {
    composerContainerHeight: number;
    tabBarInset: number;
    androidKeyboardInset: number;
    shouldFloatComposerOverContent: boolean;
    isKeyboardVisible?: boolean;
}) {
    return composerContainerHeight + (shouldFloatComposerOverContent
        ? getAndroidFloatingComposerBottomOffset({
            tabBarInset,
            androidKeyboardInset,
            isKeyboardVisible,
        })
        : androidKeyboardInset);
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
        startNewChat,
    } = useChatSession();
    const { state: engineState, loadModel } = useLLMEngine();
    const { t } = useTranslation();
    const appearance = useScreenAppearance();
    const primaryActionContentClassName = getThemeActionContentClassName(appearance, 'primary');
    const modelRegistryRevision = useModelRegistryRevision();
    const router = useRouter();
    const { openErrorReport, sheetProps: errorReportSheetProps } = useErrorReportSheetController();
    const { paddingTop: headerInset, paddingBottom: tabBarInset } = useFloatingScrollInsets();
    const tabBarHeight = useBottomTabBarHeight();
    const [hardwareStatus, setHardwareStatus] = useState(() => hardwareListenerService.getCurrentStatus());
    const [composerDraft, setComposerDraft] = useState('');
    const [androidKeyboardInset, setAndroidKeyboardInset] = useState(0);
    const [isAndroidKeyboardVisible, setIsAndroidKeyboardVisible] = useState(false);
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
        attachments: ChatMessage['attachments'];
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
    const androidKeyboardInsetRef = useRef(0);
    const composerContainerRef = useRef<View | null>(null);
    const warmupContentBlurTargetRef = useRef<View | null>(null);
    const isUserInteractingRef = useRef(false);
    const isListTouchingRef = useRef(false);
    const isMomentumScrollingRef = useRef(false);
    const dragStartOffsetYRef = useRef<number | null>(null);
    const momentumStartOffsetYRef = useRef<number | null>(null);
    const shouldStickToBottomRef = useRef(true);
    const sendMessageInFlightRef = useRef(false);
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
    const isAndroidKeyboardOpen = Platform.OS === 'android' && isAndroidKeyboardVisible;
    const shouldFloatComposerOverContent = shouldFloatAndroidComposerOverContent({
        platform: Platform.OS,
        surfaceKind: appearance.surfaceKind,
        isKeyboardVisible: isAndroidKeyboardVisible,
    });
    const androidFloatingComposerBottomOffset = getAndroidFloatingComposerBottomOffset({
        tabBarInset,
        androidKeyboardInset,
        isKeyboardVisible: isAndroidKeyboardOpen,
    });
    const bottomChromeInset = getChatListBottomChromeInset({
        composerContainerHeight,
        tabBarInset,
        androidKeyboardInset,
        shouldFloatComposerOverContent,
        isKeyboardVisible: isAndroidKeyboardOpen,
    });
    const listBottomPadding =
        (hardwareBannerInputs.showLowMemoryWarning || hardwareBannerInputs.showThermalWarning ? 22 : 14)
        + (isModelInitializing ? MODEL_WARMUP_BANNER_RESERVED_HEIGHT : 0)
        + bottomChromeInset;

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
    const activeChatModel = useMemo(() => {
        void modelRegistryRevision;

        return displayedChatActiveModelId ? registry.getModel(displayedChatActiveModelId) : undefined;
    }, [displayedChatActiveModelId, modelRegistryRevision]);
    const multimodalReadiness = useMemo(
        () => resolveFallbackMultimodalReadiness(activeChatModel, displayedChatActiveModelId),
        [activeChatModel, displayedChatActiveModelId],
    );
    const hasReadyVisionSupport = isVisionReadinessReady(multimodalReadiness);
    const hasReadyAudioSupport = isAudioReadinessReady(multimodalReadiness);
    const visionAttachmentReadinessReason = resolveImageAttachmentReadinessReason({
        activeModelId: engineState.activeModelId,
        displayedModelId: displayedChatActiveModelId,
        isEngineReady,
        readiness: multimodalReadiness,
    });
    const imageAttachmentsDisabledReason = pendingRegenerateMessage
        ? IMAGE_ATTACHMENTS_EDITING_REASON_KEY
        : visionAttachmentReadinessReason;
    const imageAttachmentsEnabled =
        !isInputDisabled
        && !pendingRegenerateMessage
        && engineState.activeModelId === displayedChatActiveModelId
        && hasReadyVisionSupport;
    const imageAttachmentOwnerKey = [
        activeThread?.id ?? 'new-thread',
        displayedChatActiveModelId ?? 'no-displayed-model',
    ].join('|');
    const imageAttachmentDrafts = useChatImageAttachments({
        enabled: imageAttachmentsEnabled,
        disabledReason: imageAttachmentsDisabledReason,
        ownerKey: imageAttachmentOwnerKey,
        preserveFailedDraftsOnNewThreadCommit: true,
    });
    const documentAttachmentsDisabledReason = pendingRegenerateMessage
        ? DOCUMENT_ATTACHMENTS_EDITING_REASON_KEY
        : undefined;
    const documentAttachmentsEnabled =
        !isInputDisabled
        && !pendingRegenerateMessage
        && engineState.activeModelId === displayedChatActiveModelId;
    const documentAttachmentOwnerKey = [
        activeThread?.id ?? 'new-thread',
        displayedChatActiveModelId ?? 'no-displayed-model',
    ].join('|');
    const documentAttachmentDrafts = useChatDocumentAttachments({
        enabled: documentAttachmentsEnabled,
        disabledReason: documentAttachmentsDisabledReason,
        ownerKey: documentAttachmentOwnerKey,
    });
    const mediaAttachmentOwnerKey = [
        activeThread?.id ?? 'new-thread',
        displayedChatActiveModelId ?? 'no-displayed-model',
    ].join('|');
    const audioAttachmentsEnabled =
        !isInputDisabled
        && !pendingRegenerateMessage
        && engineState.activeModelId === displayedChatActiveModelId
        && hasReadyAudioSupport;
    const audioAttachmentReadinessReason = hasReadyAudioSupport
        ? undefined
        : 'chat.attachments.audioRuntimeUnavailable';
    const audioAttachmentsDisabledReason = pendingRegenerateMessage
        ? MEDIA_ATTACHMENTS_EDITING_REASON_KEY
        : audioAttachmentReadinessReason;
    const mediaAttachmentDrafts = useChatMediaAttachments({
        audioEnabled: audioAttachmentsEnabled,
        audioDisabledReason: audioAttachmentsDisabledReason,
        ownerKey: mediaAttachmentOwnerKey,
    });
    const retainedRegenerateAttachments = pendingRegenerateMessage?.attachments ?? [];
    const canSendRetainedRegenerateAttachments = retainedRegenerateAttachments.length > 0
        && !isInputDisabled
        && engineState.activeModelId === displayedChatActiveModelId
        && retainedRegenerateAttachments.every((attachment) => canSendRetainedAttachment(attachment, multimodalReadiness));
    const retainedRegenerateAttachmentsSendBlocked = retainedRegenerateAttachments.length > 0
        && !canSendRetainedRegenerateAttachments;
    const retainedRegenerateAttachmentsBlockedReason = retainedRegenerateAttachmentsSendBlocked
        ? resolveRetainedRegenerateAttachmentBlockedReason({
            audioReadinessReason: audioAttachmentReadinessReason,
            imageReadinessReason: visionAttachmentReadinessReason,
            readiness: multimodalReadiness,
            retainedAttachments: retainedRegenerateAttachments,
        })
        : undefined;
    const retainedRegenerateAttachmentsTray = retainedRegenerateAttachments.length > 0 ? (
        <ScreenSurface
            testID="chat-regenerate-retained-attachments"
            tone="accent"
            withControlTint
            className="rounded-2xl px-3 py-2"
        >
            <Box className="flex-row items-start gap-3">
                <ScreenIconTile
                    iconName="image"
                    tone="accent"
                    size="sm"
                    iconSize="xs"
                    className="mt-0.5 h-6 w-6"
                    iconClassName="text-primary-500"
                />
                <Box className="min-w-0 flex-1">
                    <Text className="text-xs font-semibold leading-4 text-primary-700 dark:text-primary-300">
                        {t('chat.attachments.retainedForRegenerate', { count: retainedRegenerateAttachments.length })}
                    </Text>
                    <Text className="mt-0.5 text-xs leading-4 text-primary-700/80 dark:text-primary-300/80">
                        {retainedRegenerateAttachmentsSendBlocked
                            ? t('chat.attachments.retainedForRegenerateBlockedDescription', {
                                reason: t(retainedRegenerateAttachmentsBlockedReason ?? visionAttachmentReadinessReason),
                            })
                            : t('chat.attachments.retainedForRegenerateDescription')}
                    </Text>
                </Box>
            </Box>
        </ScreenSurface>
    ) : undefined;

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
    const shouldReserveComposerTabBarInset = !shouldFloatComposerOverContent && !isAndroidKeyboardOpen;
    const composerBottomInsetStyle = shouldReserveComposerTabBarInset && tabBarInset > 0
        ? { paddingBottom: tabBarInset }
        : undefined;
    const androidComposerContainerStyle = shouldFloatComposerOverContent
        ? [styles.androidFloatingComposer, { bottom: androidFloatingComposerBottomOffset }]
        : composerBottomInsetStyle;
    const shouldRenderAndroidKeyboardSpacerAfterComposer = shouldRenderAndroidKeyboardSpacer({
        platform: Platform.OS,
        shouldFloatComposerOverContent,
        androidKeyboardInset,
    });
    const warmupBannerBottomOffset = getChatWarmupBannerBottomOffset({
        composerContainerHeight,
        tabBarInset,
        androidKeyboardInset,
        shouldFloatComposerOverContent,
        isKeyboardVisible: isAndroidKeyboardOpen,
    });
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
                                diagnostics: engineState.diagnostics,
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
        engineState.diagnostics,
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

        setModelSelectorOpen(false);

        const clearPendingModelSelection = () => {
            setPendingModelSelection((currentValue) => (
                currentValue?.threadId === selectionThreadId && currentValue.modelId === nextModelId
                    ? null
                    : currentValue
            ));
        };

        const attemptLoadSelectedModel = async (options?: LoadModelOptions): Promise<void> => {
            setPendingModelSelection({ threadId: selectionThreadId, modelId: nextModelId });

            try {
                await loadModel(nextModelId, options);
            } catch (error) {
                clearPendingModelSelection();

                const appError = toAppError(error, 'model_load_failed');
                const handledByMemoryPolicy = handleModelLoadMemoryPolicyError({
                    t,
                    appError,
                    options,
                    onRetry: (nextOptions) => {
                        void attemptLoadSelectedModel(nextOptions);
                    },
                });

                if (!handledByMemoryPolicy) {
                    showAlertForError('common.actionFailed', 'ChatScreen.loadModel', appError);
                }

                return;
            }

            clearPendingModelSelection();

            if (!activeThread) {
                return;
            }

            switchThreadModel(activeThread.id, nextModelId);
            updateThreadParamsSnapshot(activeThread.id, getGenerationParametersForModel(nextModelId));
        };

        await attemptLoadSelectedModel();
    }, [
        activeThread,
        currentChatActiveModelId,
        isGenerating,
        loadModel,
        showAlertForError,
        switchThreadModel,
        t,
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

    const setAndroidKeyboardInsetValue = useCallback((nextInset: number) => {
        const normalizedInset = Math.max(0, nextInset);
        setAndroidKeyboardInset((currentValue) => (
            Math.abs(currentValue - normalizedInset) < 1 ? currentValue : normalizedInset
        ));
    }, []);

    useEffect(() => {
        androidKeyboardInsetRef.current = androidKeyboardInset;
    }, [androidKeyboardInset]);

    const updateAndroidKeyboardInsetFromLayout = useCallback(() => {
        if (Platform.OS !== 'android') {
            return;
        }

        const keyboardMetrics = androidKeyboardMetricsRef.current;
        const composerContainer = composerContainerRef.current;

        if (!keyboardMetrics) {
            setAndroidKeyboardInsetValue(0);
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
            setAndroidKeyboardInsetValue(viewportCompensation);
            return;
        }

        if (keyboardMeasureFrameRef.current !== null) {
            cancelAnimationFrame(keyboardMeasureFrameRef.current);
        }

        keyboardMeasureFrameRef.current = requestAnimationFrame(() => {
            keyboardMeasureFrameRef.current = null;

            composerContainer.measure((_x, _y, _width, height, _pageX, pageY) => {
                setAndroidKeyboardInsetValue(getAndroidKeyboardSpacerHeight({
                    viewportCompensation,
                    currentSpacerHeight: androidKeyboardInsetRef.current,
                    composerBottomY: pageY + height,
                    keyboardTopY: keyboardMetrics.topY,
                    gap: screenLayoutMetrics.keyboardComposerGap,
                }));
            });
        });
    }, [setAndroidKeyboardInsetValue, tabBarHeight]);

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
        if (sendMessageInFlightRef.current) {
            return;
        }

        sendMessageInFlightRef.current = true;
        armFollowLatestMessage(false);
        try {
            if (pendingRegenerateMessage) {
                const targetMessage = pendingRegenerateMessage;
                const hasRetainedAttachments = (targetMessage.attachments?.length ?? 0) > 0;

                if (hasRetainedAttachments && !canSendRetainedRegenerateAttachments) {
                    return;
                }

                setPendingRegenerateMessage(null);
                setComposerDraft('');

                try {
                    if (hasRetainedAttachments) {
                        await regenerateFromUserMessage(targetMessage.messageId, content, { multimodalReadiness });
                    } else {
                        await regenerateFromUserMessage(targetMessage.messageId, content);
                    }
                } catch (error) {
                    setPendingRegenerateMessage(targetMessage);
                    setComposerDraft(content);
                    throw error;
                }

                return;
            }

            const shouldSendAttachmentDrafts = imageAttachmentDrafts.drafts.length > 0 && imageAttachmentsEnabled;
            const shouldSendDocumentAttachmentDrafts = documentAttachmentDrafts.drafts.length > 0 && documentAttachmentsEnabled;
            const shouldSendMediaAttachmentDrafts = mediaAttachmentDrafts.drafts.length > 0;
            const hasFailedAttachmentDrafts = shouldSendAttachmentDrafts
                && imageAttachmentDrafts.drafts.some((draft) => draft.copyStatus === 'failed');
            const hasFailedDocumentAttachmentDrafts = shouldSendDocumentAttachmentDrafts
                && documentAttachmentDrafts.drafts.some((draft) => draft.copyStatus === 'failed');
            const hasFailedMediaAttachmentDrafts = shouldSendMediaAttachmentDrafts
                && mediaAttachmentDrafts.drafts.some((draft) => draft.copyStatus === 'failed');
            const attachmentDrafts = shouldSendAttachmentDrafts
                ? imageAttachmentDrafts.consumeDraftsForSend()
                : [];
            const documentDrafts = shouldSendDocumentAttachmentDrafts
                ? documentAttachmentDrafts.consumeDraftsForSend()
                : [];
            const mediaDrafts = shouldSendMediaAttachmentDrafts
                ? mediaAttachmentDrafts.consumeDraftsForSend({
                    includeAudio: audioAttachmentsEnabled,
                })
                : [];
            const hasSendableAttachmentDrafts = attachmentDrafts.length > 0;
            const hasSendableDocumentAttachmentDrafts = documentDrafts.length > 0;
            const hasSendableMediaAttachmentDrafts = mediaDrafts.length > 0;
            const restoreAttachmentDraftsForRetry = (draftsToRestore: readonly AttachmentDraft[]) => {
                if (draftsToRestore.length === 0) {
                    return;
                }

                const retryThread = imageAttachmentOwnerKey.startsWith('new-thread|')
                    ? useChatStore.getState().getActiveThread()
                    : null;
                const retryOwnerKey = retryThread
                    ? [retryThread.id, getThreadActiveModelId(retryThread)].join('|')
                    : null;

                if (retryOwnerKey) {
                    imageAttachmentDrafts.restoreDraftsForRetry(draftsToRestore, { preserveOwnerKey: retryOwnerKey });
                } else {
                    imageAttachmentDrafts.restoreDraftsForRetry(draftsToRestore);
                }
            };
            const restoreDocumentDraftsForRetry = (draftsToRestore: readonly ChatDocumentAttachmentDraft[]) => {
                if (draftsToRestore.length === 0) {
                    return;
                }

                documentAttachmentDrafts.restoreDraftsForRetry(draftsToRestore);
            };
            const restoreMediaDraftsForRetry = (draftsToRestore: readonly ChatMediaAttachmentDraft[]) => {
                if (draftsToRestore.length === 0) {
                    return;
                }

                mediaAttachmentDrafts.restoreDraftsForRetry(draftsToRestore);
            };

            let userMessageAppended = false;
            setComposerDraft('');
            try {
                await appendUserMessage(
                    content,
                    {
                        ...(hasSendableAttachmentDrafts
                            ? {
                                attachmentDrafts,
                                multimodalReadiness,
                            }
                            : null),
                        ...(hasSendableDocumentAttachmentDrafts
                            ? {
                                documentAttachmentDrafts: documentDrafts,
                            }
                            : null),
                        ...(hasSendableMediaAttachmentDrafts
                            ? {
                                mediaAttachmentDrafts: mediaDrafts,
                                multimodalReadiness,
                            }
                            : null),
                        onUserMessageAppended: () => {
                            userMessageAppended = true;
                        },
                    },
                );
                if (hasFailedAttachmentDrafts) {
                    imageAttachmentDrafts.clearFailedDrafts();
                }
                if (hasFailedDocumentAttachmentDrafts) {
                    documentAttachmentDrafts.clearFailedDrafts();
                }
                if (hasFailedMediaAttachmentDrafts) {
                    mediaAttachmentDrafts.clearFailedDrafts();
                }
            } catch (error) {
                if (userMessageAppended) {
                    if (hasFailedAttachmentDrafts) {
                        imageAttachmentDrafts.clearFailedDrafts();
                    }
                    if (hasFailedDocumentAttachmentDrafts) {
                        documentAttachmentDrafts.clearFailedDrafts();
                    }
                    if (hasFailedMediaAttachmentDrafts) {
                        mediaAttachmentDrafts.clearFailedDrafts();
                    }
                    throw markChatInputDraftConsumedError(error);
                }

                const missingAttachmentDraftIds = getMissingAttachmentDraftIdsFromPreAppendFailure(error);
                if (attachmentDrafts.length > 0 && missingAttachmentDraftIds) {
                    if (missingAttachmentDraftIds.size > 0) {
                        const { matchedDrafts, remainingDrafts } = splitAttachmentDraftsById(
                            attachmentDrafts,
                            missingAttachmentDraftIds,
                        );
                        if (matchedDrafts.length > 0) {
                            imageAttachmentDrafts.discardDrafts(matchedDrafts, 'missing copied drafts after failed send');
                        }
                        if (remainingDrafts.length > 0) {
                            restoreAttachmentDraftsForRetry(remainingDrafts);
                        }
                    } else {
                        // Missing-attachment errors can omit ids for legacy or id-less drafts. Do not
                        // restore consumed drafts that are known to point at unavailable copied files,
                        // otherwise each retry can fail on the same stale attachment forever.
                        imageAttachmentDrafts.discardDrafts(attachmentDrafts, 'missing copied drafts after failed send');
                    }
                } else if (attachmentDrafts.length > 0) {
                    restoreAttachmentDraftsForRetry(attachmentDrafts);
                }
                if (documentDrafts.length > 0 && missingAttachmentDraftIds) {
                    if (missingAttachmentDraftIds.size > 0) {
                        const { matchedDrafts, remainingDrafts } = splitAttachmentDraftsById(
                            documentDrafts,
                            missingAttachmentDraftIds,
                        );
                        if (matchedDrafts.length > 0) {
                            documentAttachmentDrafts.discardDrafts(matchedDrafts, 'missing copied document drafts after failed send');
                        }
                        if (remainingDrafts.length > 0) {
                            restoreDocumentDraftsForRetry(remainingDrafts);
                        }
                    } else {
                        documentAttachmentDrafts.discardDrafts(documentDrafts, 'missing copied document drafts after failed send');
                    }
                } else if (documentDrafts.length > 0) {
                    restoreDocumentDraftsForRetry(documentDrafts);
                }
                if (mediaDrafts.length > 0 && missingAttachmentDraftIds) {
                    if (missingAttachmentDraftIds.size > 0) {
                        const { matchedDrafts, remainingDrafts } = splitAttachmentDraftsById(
                            mediaDrafts,
                            missingAttachmentDraftIds,
                        );
                        if (matchedDrafts.length > 0) {
                            mediaAttachmentDrafts.discardDrafts(matchedDrafts, 'missing copied media drafts after failed send');
                        }
                        if (remainingDrafts.length > 0) {
                            restoreMediaDraftsForRetry(remainingDrafts);
                        }
                    } else {
                        mediaAttachmentDrafts.discardDrafts(mediaDrafts, 'missing copied media drafts after failed send');
                    }
                } else if (mediaDrafts.length > 0) {
                    restoreMediaDraftsForRetry(mediaDrafts);
                }

                setComposerDraft(content);
                throw error;
            }
        } finally {
            sendMessageInFlightRef.current = false;
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
            attachments: message.attachments ?? [],
        });
        setComposerDraft(message.content);
        imageAttachmentDrafts.clearDrafts();
        documentAttachmentDrafts.clearDrafts();
        mediaAttachmentDrafts.clearDrafts();
    }, [documentAttachmentDrafts, imageAttachmentDrafts, mediaAttachmentDrafts]);

    const handleCancelComposerMode = useCallback(() => {
        setPendingRegenerateMessage(null);
        setComposerDraft('');
        imageAttachmentDrafts.clearDrafts();
        documentAttachmentDrafts.clearDrafts();
        mediaAttachmentDrafts.clearDrafts();
    }, [documentAttachmentDrafts, imageAttachmentDrafts, mediaAttachmentDrafts]);

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
                            const deletedMessageIndex = activeThread?.messages.findIndex((entry) => entry.id === messageId) ?? -1;
                            const pendingRegenerateMessageIndex = pendingRegenerateMessage
                                ? activeThread?.messages.findIndex((entry) => entry.id === pendingRegenerateMessage.messageId) ?? -1
                                : -1;
                            const deleted = deleteMessage(messageId);
                            const didDeletePendingRegenerateTarget = pendingRegenerateMessageIndex >= 0
                                && deletedMessageIndex >= 0
                                && pendingRegenerateMessageIndex >= deletedMessageIndex;

                            if (deleted && didDeletePendingRegenerateTarget) {
                                handleCancelComposerMode();
                            }
                        } catch (error: any) {
                            showAlertForError('chat.deleteMessageErrorTitle', 'ChatScreen.handleDeleteMessage', error);
                        }
                    },
                },
            ],
        );
    }, [deleteMessage, pendingRegenerateMessage, showAlertForError, t, handleCancelComposerMode]);

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
            setIsAndroidKeyboardVisible(true);
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
            setIsAndroidKeyboardVisible(false);
            androidKeyboardMetricsRef.current = null;
            setAndroidKeyboardInsetValue(0);
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
    }, [setAndroidKeyboardInsetValue, updateAndroidKeyboardInsetFromLayout]);

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
                attachments={msg.attachments}
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
            <ScreenAndroidContentBlurTarget
                blurTargetRef={warmupContentBlurTargetRef}
                style={styles.warmupContentBlurTarget}
                testID="chat-warmup-content-blur-target"
            >
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
                                title={t('chat.summaryUnavailableTitle')}
                                description={t('chat.summaryUnavailableDescription', { count: truncatedMessageCount })}
                                tone="info"
                                iconName="notes"
                            />
                        </Box>
                    ) : null}

                    {activeThread?.summary && !activeThread.summary.isPlaceholder ? (
                        <Box className="mb-3">
                            <ChatStatusBanner
                                title={t('chat.summarySavedTitle')}
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
                                contentContainerStyle={{ paddingTop: 4 + headerInset, paddingBottom: listBottomPadding, flexGrow: 1 }}
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
                            <Box
                                className="flex-1 justify-center px-3 pb-10"
                                style={{
                                    paddingTop: headerInset,
                                    paddingBottom: 40 + tabBarInset,
                                }}
                            >
                                <ScreenCard
                                    testID="chat-recovery-card"
                                    tone="warning"
                                    padding="none"
                                    decorative="matte"
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
                                        <ScreenSurface className={`mt-4 ${appearance.classNames.inlinePillClassName}`}>
                                            <Text className="text-xs font-semibold uppercase tracking-wide text-typography-600 dark:text-typography-300">
                                                {modelLabel}
                                            </Text>
                                        </ScreenSurface>
                                    ) : null}

                                    <Text
                                        className="mt-5 text-center text-xl font-semibold leading-7 text-typography-900 dark:text-typography-100"
                                    >
                                        {recoveryTitle}
                                    </Text>

                                    {isModelInitializing ? (
                                        <ScreenSurface tone="accent" withControlTint className={`mt-4 w-full rounded-2xl border px-3 py-2.5 ${appearance.classNames.toneClassNameByTone.accent.surfaceClassName}`}>
                                            <Box className="mb-2 flex-row items-center justify-end">
                                                <ScreenSurface tone="accent" withControlTint className={`rounded-full px-2.5 py-1 ${appearance.classNames.toneClassNameByTone.accent.percentPillClassName}`}>
                                                    <Text className="text-xs font-bold text-primary-700 dark:text-primary-200">
                                                        {warmupProgressPercent}%
                                                    </Text>
                                                </ScreenSurface>
                                            </Box>
                                            <ProgressBar
                                                testID="chat-recovery-warmup-progress-track"
                                                fillTestID="chat-recovery-warmup-progress-fill"
                                                valuePercent={warmupProgressPercent}
                                                size="lg"
                                                tone="primary"
                                                variant="framed"
                                                fillClassName={appearance.classNames.toneClassNameByTone.primary.progressFillClassName}
                                            />
                                        </ScreenSurface>
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
                                            className={primaryActionContentClassName}
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

                </Box>
            </ScreenAndroidContentBlurTarget>

            {SHOULD_USE_KEYBOARD_AVOIDING_VIEW ? (
                    <View
                        testID="chat-keyboard-avoiding-view"
                        onLayout={handleComposerContainerLayout}
                        style={composerBottomInsetStyle}
                    >
                        <KeyboardAvoidingView
                            behavior="padding"
                            keyboardVerticalOffset={tabBarHeight}
                        >
                            <ChatInputBar
                                draft={composerDraft}
                                onDraftChange={setComposerDraft}
                                allowEmptyMessageSend={canSendRetainedRegenerateAttachments}
                                onSendMessage={handleSendMessage}
                                sendDisabled={retainedRegenerateAttachmentsSendBlocked}
                                onStopGeneration={stopGeneration}
                                disabled={isInputDisabled}
                                isSending={isGenerating}
                                androidContentBlurTargetRef={warmupContentBlurTargetRef}
                                attachmentDrafts={imageAttachmentDrafts.drafts}
                                documentAttachmentDrafts={documentAttachmentDrafts.drafts}
                                mediaAttachmentDrafts={mediaAttachmentDrafts.drafts}
                                onAttachImages={imageAttachmentDrafts.attachImages}
                                onAttachDocuments={documentAttachmentDrafts.attachDocuments}
                                onAttachAudio={mediaAttachmentDrafts.attachAudio}
                                onRemoveAttachmentDraft={imageAttachmentDrafts.removeDraft}
                                onRemoveDocumentAttachmentDraft={documentAttachmentDrafts.removeDraft}
                                onRemoveMediaAttachmentDraft={mediaAttachmentDrafts.removeDraft}
                                imageAttachmentsEnabled={imageAttachmentsEnabled}
                                documentAttachmentsEnabled={documentAttachmentsEnabled}
                                audioAttachmentsEnabled={audioAttachmentsEnabled}
                                imageAttachmentsDisabledReason={imageAttachmentsDisabledReason}
                                documentAttachmentsDisabledReason={documentAttachmentsDisabledReason}
                                audioAttachmentsDisabledReason={audioAttachmentsDisabledReason}
                                isImageAttachmentActionBusy={imageAttachmentDrafts.isPicking}
                                isDocumentAttachmentActionBusy={documentAttachmentDrafts.isPicking}
                                isAudioAttachmentActionBusy={mediaAttachmentDrafts.isPickingAudio}
                                attachmentsTray={retainedRegenerateAttachmentsTray}
                                modeLabel={pendingRegenerateMessage ? t('chat.editEarlierMessage') : undefined}
                                modeDescription={pendingRegenerateMessage
                                    ? t('chat.editEarlierMessageDescription')
                                    : undefined}
                                onCancelMode={pendingRegenerateMessage ? handleCancelComposerMode : undefined}
                            />
                        </KeyboardAvoidingView>
                    </View>
                ) : (
                    <View
                        testID="chat-keyboard-avoiding-view"
                        style={androidComposerContainerStyle}
                    >
                        <View
                            ref={composerContainerRef}
                            onLayout={handleComposerContainerLayout}
                        >
                            <ChatInputBar
                                draft={composerDraft}
                                onDraftChange={setComposerDraft}
                                allowEmptyMessageSend={canSendRetainedRegenerateAttachments}
                                onSendMessage={handleSendMessage}
                                sendDisabled={retainedRegenerateAttachmentsSendBlocked}
                                onStopGeneration={stopGeneration}
                                disabled={isInputDisabled}
                                isSending={isGenerating}
                                androidContentBlurTargetRef={warmupContentBlurTargetRef}
                                attachmentDrafts={imageAttachmentDrafts.drafts}
                                documentAttachmentDrafts={documentAttachmentDrafts.drafts}
                                mediaAttachmentDrafts={mediaAttachmentDrafts.drafts}
                                onAttachImages={imageAttachmentDrafts.attachImages}
                                onAttachDocuments={documentAttachmentDrafts.attachDocuments}
                                onAttachAudio={mediaAttachmentDrafts.attachAudio}
                                onRemoveAttachmentDraft={imageAttachmentDrafts.removeDraft}
                                onRemoveDocumentAttachmentDraft={documentAttachmentDrafts.removeDraft}
                                onRemoveMediaAttachmentDraft={mediaAttachmentDrafts.removeDraft}
                                imageAttachmentsEnabled={imageAttachmentsEnabled}
                                documentAttachmentsEnabled={documentAttachmentsEnabled}
                                audioAttachmentsEnabled={audioAttachmentsEnabled}
                                imageAttachmentsDisabledReason={imageAttachmentsDisabledReason}
                                documentAttachmentsDisabledReason={documentAttachmentsDisabledReason}
                                audioAttachmentsDisabledReason={audioAttachmentsDisabledReason}
                                isImageAttachmentActionBusy={imageAttachmentDrafts.isPicking}
                                isDocumentAttachmentActionBusy={documentAttachmentDrafts.isPicking}
                                isAudioAttachmentActionBusy={mediaAttachmentDrafts.isPickingAudio}
                                attachmentsTray={retainedRegenerateAttachmentsTray}
                                modeLabel={pendingRegenerateMessage ? t('chat.editEarlierMessage') : undefined}
                                modeDescription={pendingRegenerateMessage
                                    ? t('chat.editEarlierMessageDescription')
                                    : undefined}
                                onCancelMode={pendingRegenerateMessage ? handleCancelComposerMode : undefined}
                            />
                        </View>
                        {shouldRenderAndroidKeyboardSpacerAfterComposer ? (
                            <Box testID="chat-android-keyboard-spacer" style={{ height: androidKeyboardInset }} />
                        ) : null}
                    </View>
            )}

            {shouldShowFloatingWarmupBanner ? (
                <ModelWarmupBanner
                    androidContentBlurTargetRef={warmupContentBlurTargetRef}
                    engineState={engineState}
                    multimodalReadiness={multimodalReadiness}
                    bottomOffset={warmupBannerBottomOffset}
                />
            ) : null}

            <ChatModelSelectorSheet
                visible={isModelSelectorOpen}
                models={downloadedModels}
                currentModelId={displayedChatActiveModelId}
                canSelect={!isGenerating && !isModelSelectionPending}
                androidContentBlurTargetRef={warmupContentBlurTargetRef}
                onClose={() => setModelSelectorOpen(false)}
                onSelectModel={(modelId) => {
                    void handleSelectModelFromHeader(modelId);
                }}
            />

            <PresetSelectorSheet
                visible={isPresetSelectorOpen}
                activePresetId={activeThread?.presetId ?? settings.activePresetId}
                androidContentBlurTargetRef={warmupContentBlurTargetRef}
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

            <ModelParametersSheet
                {...modelParametersSheetProps}
                androidContentBlurTargetRef={warmupContentBlurTargetRef}
            />
            <ErrorReportSheet
                {...errorReportSheetProps}
                androidContentBlurTargetRef={warmupContentBlurTargetRef}
            />
        </ScreenRoot>
    );
};

const styles = StyleSheet.create({
    warmupContentBlurTarget: {
        flex: 1,
    },
    androidFloatingComposer: {
        position: 'absolute',
        left: 0,
        right: 0,
        zIndex: 20,
        elevation: 20,
    },
});
