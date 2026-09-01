import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
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
import { useFocusEffect, useIsFocused, usePreventRemove } from '@react-navigation/native';
import { FlashList, FlashListRef } from '@shopify/flash-list';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { ChatHeader } from '@/components/ui/ChatHeader';
import { ChatStatusBanner } from '@/components/ui/ChatStatusBanner';
import { ChatMessageBubble } from '@/components/ui/ChatMessageBubble';
import { ChatSystemEventRow } from '@/components/ui/ChatSystemEventRow';
import { ChatModelSelectorSheet } from '@/components/ui/ChatModelSelectorSheet';
import {
    ChatInputBar,
    markChatInputDraftConsumedError,
    markChatInputErrorReported,
} from '@/components/ui/ChatInputBar';
import { ErrorReportSheet } from '@/components/ui/ErrorReportSheet';
import {
    MODEL_WARMUP_BANNER_RESERVED_HEIGHT,
    ModelWarmupBanner,
    resolveModelWarmupProgressPercent,
} from '@/components/ui/ModelWarmupBanner';
import { ModelParametersSheet } from '@/components/ui/ModelParametersSheet';
import { MaterialSymbols } from '@/components/ui/MaterialSymbols';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { ScreenAndroidContentBlurTarget, ScreenCard, ScreenIconTile, ScreenRoot, ScreenSurface } from '@/components/ui/ScreenShell';
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
import {
    ChatMessage,
    getThreadActiveModelId,
    type GenerationParamsSnapshot,
} from '../../types/chat';
import type { ChatDocumentAttachmentDraft, ChatMediaAttachmentDraft } from '../../types/attachments';
import type {
    AttachmentDraft,
    MultimodalReadinessState,
    MultimodalReadinessStatus,
    MultimodalSupportModality,
} from '../../types/multimodal';
import { getChatHardwareBannerInputs, hardwareListenerService } from '../../services/HardwareListenerService';
import { llmEngineService } from '../../services/LLMEngineService';
import { performanceMonitor } from '../../services/PerformanceMonitor';
import { registry } from '../../services/LocalStorageRegistry';
import { useChatStore } from '../../store/chatStore';
import { getShortModelLabel } from '@/utils/modelLabel';
import { AppError, getErrorMessage, getReportedErrorMessage, toAppError } from '../../services/AppError';
import {
    getGenerationParametersForModel,
    getSettings,
    resetGenerationParametersForModel,
    subscribeSettings,
    updateGenerationParametersForModel,
} from '../../services/SettingsStore';
import { screenLayoutMetrics } from '../../utils/themeTokens';
import { handleModelLoadMemoryPolicyError } from '../../utils/modelLoadMemoryPolicyPrompt';
import { resolveEffectiveActiveVariantNativeSupport } from '../../utils/modelCapabilities';
import { isMultimodalReadinessReusableForModel } from '../../utils/multimodalReadiness';
import type { LoadModelOptions } from '../../services/LLMEngineService';
import { useTheme } from '../../providers/ThemeProvider';
import { getReadinessStatusForProjectorLifecycle, projectorArtifactService } from '../../services/ProjectorArtifactService';
import {
    armAndroidQaGenerationGate,
    getAndroidQaGenerationEvidenceSnapshot,
    isAndroidQaGenerationEvidenceEnabled,
    subscribeAndroidQaGenerationEvidence,
} from '../../services/AndroidQaGenerationEvidence';
import { hasActiveChatGenerationWork } from '../../services/ChatGenerationService';
import { selectActiveChatPreset } from '../../services/ActiveChatPresetService';
import {
    backgroundTaskService,
    type ForegroundServiceStartFailureCategory,
    type ForegroundServiceStartStatus,
} from '../../services/BackgroundTaskService';

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

function areGenerationParamsSnapshotsEqual(
    left: GenerationParamsSnapshot,
    right: GenerationParamsSnapshot,
): boolean {
    return (
        left.temperature === right.temperature
        && left.topP === right.topP
        && (left.topK ?? FALLBACK_TOP_K) === (right.topK ?? FALLBACK_TOP_K)
        && (left.minP ?? FALLBACK_MIN_P) === (right.minP ?? FALLBACK_MIN_P)
        && (
            left.repetitionPenalty ?? FALLBACK_REPETITION_PENALTY
        ) === (
            right.repetitionPenalty ?? FALLBACK_REPETITION_PENALTY
        )
        && left.maxTokens === right.maxTokens
        && (left.reasoningEffort ?? 'auto') === (right.reasoningEffort ?? 'auto')
        && (left.seed ?? null) === (right.seed ?? null)
    );
}

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

export function sanitizeDocumentFailureDisplayName(
    value: string | null | undefined,
    fallback: string,
): string {
    const normalized = (value ?? '').normalize('NFKC')
        .replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]+/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
    const bounded = Array.from(normalized).slice(0, 160).join('').trimEnd();
    return bounded || fallback;
}
const IMAGE_ATTACHMENTS_NO_MODEL_REASON_KEY = 'chat.visionReadiness.noModel';
const IMAGE_ATTACHMENTS_EDITING_REASON_KEY = 'chat.visionReadiness.editingMessage';
const DOCUMENT_ATTACHMENTS_EDITING_REASON_KEY = 'chat.attachments.documentEditingDisabled';
const MEDIA_ATTACHMENTS_EDITING_REASON_KEY = 'chat.attachments.mediaEditingDisabled';
const MEDIA_ATTACHMENTS_RUNTIME_UNAVAILABLE_REASON_KEY = 'chat.attachments.mediaRuntimeUnavailable';
const VIDEO_ATTACHMENTS_REGENERATE_UNSUPPORTED_REASON_KEY = 'chat.attachments.videoRegenerateUnsupported';

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
    if (!('kind' in attachment)) {
        return isVisionReadinessReady(readiness);
    }

    switch (attachment.kind) {
        case 'audio':
            return isAudioReadinessReady(readiness);
        case 'document':
            return true;
        case 'image':
            return isVisionReadinessReady(readiness);
        case 'video':
        default:
            return false;
    }
}

type ScrollMetrics = Pick<NativeScrollEvent, 'contentOffset' | 'contentSize' | 'layoutMeasurement'>;
type AndroidKeyboardMetrics = {
    height: number;
    topY: number;
    screenTopY?: number;
    reportedScreenY?: number | null;
};

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

function resolveAudioAttachmentReadinessReason({
    activeModelId,
    displayedModelId,
    hasDisplayedModel,
    isAudioSupported,
    isEngineReady,
    readiness,
}: {
    activeModelId?: string | null;
    displayedModelId?: string | null;
    hasDisplayedModel: boolean;
    isAudioSupported: boolean;
    isEngineReady: boolean;
    readiness: MultimodalReadinessState;
}): string | undefined {
    if (!displayedModelId || !hasDisplayedModel) {
        return 'chat.attachments.audioPickerDisabled';
    }

    if (!isAudioSupported) {
        return 'chat.attachments.audioModelUnsupported';
    }

    if (
        !isEngineReady
        || activeModelId !== displayedModelId
        || !isAudioReadinessReady(readiness)
    ) {
        return 'chat.attachments.audioRuntimeUnavailable';
    }

    return undefined;
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
    let hasBlockedVideo = false;
    let hasBlockedVision = false;

    for (const attachment of retainedAttachments ?? []) {
        if (canSendRetainedAttachment(attachment, readiness)) {
            continue;
        }

        if ('kind' in attachment && attachment.kind === 'audio') {
            hasBlockedAudio = true;
        } else if ('kind' in attachment && attachment.kind === 'video') {
            hasBlockedVideo = true;
        } else if (!('kind' in attachment) || attachment.kind !== 'document') {
            hasBlockedVision = true;
        }
    }

    if (hasBlockedVideo) {
        return VIDEO_ATTACHMENTS_REGENERATE_UNSUPPORTED_REASON_KEY;
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

export function getAndroidKeyboardTopY({
    screenHeight,
    windowHeight = screenHeight,
    keyboardHeight,
    reportedScreenY,
}: {
    screenHeight: number;
    windowHeight?: number;
    keyboardHeight: number;
    reportedScreenY?: number | null;
}) {
    const heightDerivedTopY = Math.max(0, screenHeight - Math.max(0, keyboardHeight));
    const viewportDerivedTopY = Math.max(0, windowHeight - Math.max(0, keyboardHeight));

    if (typeof reportedScreenY !== 'number' || !Number.isFinite(reportedScreenY) || reportedScreenY <= 0) {
        return Math.min(heightDerivedTopY, viewportDerivedTopY);
    }

    // Android keyboard events can exclude IME chrome or system-bar space from
    // either screenY or height. The earliest plausible edge across the screen and
    // app viewport is the safe boundary; choosing a later one leaves the composer
    // partially under the keyboard on affected OEM builds.
    return Math.min(reportedScreenY, heightDerivedTopY, viewportDerivedTopY);
}

export function getAndroidFloatingKeyboardTopY({
    screenHeight,
    keyboardHeight,
    reportedScreenY,
}: {
    screenHeight: number;
    keyboardHeight: number;
    reportedScreenY?: number | null;
}) {
    const heightDerivedTopY = Math.max(0, screenHeight - Math.max(0, keyboardHeight));

    if (typeof reportedScreenY !== 'number' || !Number.isFinite(reportedScreenY) || reportedScreenY <= 0) {
        return heightDerivedTopY;
    }

    // measure() and KeyboardEvent.screenY use screen coordinates. Do not mix in
    // Dimensions.get('window') here: on edge-to-edge OEM builds that window can
    // exclude system chrome and lift an absolutely positioned composer too far.
    return Math.min(reportedScreenY, heightDerivedTopY);
}

export function isAndroidKeyboardMeasurementCurrent({
    isKeyboardVisible,
    activeMetrics,
    measuredMetrics,
}: {
    isKeyboardVisible: boolean;
    activeMetrics: AndroidKeyboardMetrics | null;
    measuredMetrics: AndroidKeyboardMetrics;
}) {
    return isKeyboardVisible && activeMetrics === measuredMetrics;
}

export function shouldFloatAndroidComposerOverContent({
    platform,
    composerPresentation,
}: {
    platform: typeof Platform.OS;
    composerPresentation: 'inline' | 'capsule';
    isKeyboardVisible: boolean;
}) {
    // Keep the focused TextInput in one native layout mode while Android opens
    // the IME. Some OEM builds drop input focus when its ancestor switches from
    // absolute positioning to normal flow during the keyboard transition.
    return platform === 'android' && composerPresentation === 'capsule';
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

function AndroidQaGenerationEvidenceSurface({
    documentDraftCount,
    topInset,
}: {
    documentDraftCount: number;
    topInset: number;
}) {
    if (!isAndroidQaGenerationEvidenceEnabled()) {
        return null;
    }
    return (
        <EnabledAndroidQaGenerationEvidenceSurface
            documentDraftCount={documentDraftCount}
            topInset={topInset}
        />
    );
}

function EnabledAndroidQaGenerationEvidenceSurface({
    documentDraftCount,
    topInset,
}: {
    documentDraftCount: number;
    topInset: number;
}) {
    const [backgroundTaskState, setBackgroundTaskState] = useState<
        'idle' | 'starting' | ForegroundServiceStartStatus
    >('idle');
    const [backgroundTaskFailureCategory, setBackgroundTaskFailureCategory] = useState<
        ForegroundServiceStartFailureCategory | null
    >(null);
    const [isHiddenForVisualCapture, setIsHiddenForVisualCapture] = useState(false);
    const didStartQaBackgroundTaskRef = useRef(false);
    const evidence = useSyncExternalStore(
        subscribeAndroidQaGenerationEvidence,
        getAndroidQaGenerationEvidenceSnapshot,
        getAndroidQaGenerationEvidenceSnapshot,
    );

    const startQaBackgroundTask = useCallback(async () => {
        setBackgroundTaskState('starting');
        setBackgroundTaskFailureCategory(null);
        const outcome = await backgroundTaskService.startBackgroundInference(
            'Android QA foreground service',
            { requireServiceStart: true },
        );
        didStartQaBackgroundTaskRef.current = outcome.serviceRunning;
        setBackgroundTaskState(outcome.status);
        setBackgroundTaskFailureCategory(outcome.failureCategory ?? null);
        if (!outcome.requirementSatisfied) {
            await backgroundTaskService.stopBackgroundTask('inference');
        }
    }, []);

    const stopQaBackgroundTask = useCallback(async () => {
        await backgroundTaskService.stopBackgroundTask('inference');
        didStartQaBackgroundTaskRef.current = false;
        setBackgroundTaskState('idle');
        setBackgroundTaskFailureCategory(null);
    }, []);

    useEffect(() => () => {
        if (didStartQaBackgroundTaskRef.current && backgroundTaskService.isTaskActive('inference')) {
            void backgroundTaskService.stopBackgroundTask('inference');
        }
    }, []);

    useFocusEffect(useCallback(() => () => {
        setIsHiddenForVisualCapture(false);
    }, []));

    if (isHiddenForVisualCapture) {
        return null;
    }

    return (
        <View
            testID="chat-qa-generation-evidence"
            style={[styles.androidQaEvidenceSurface, { marginTop: topInset }]}
        >
            <View
                accessible
                accessibilityLabel={`chat-qa-document-draft-count-${documentDraftCount}`}
                collapsable={false}
                testID={`chat-qa-document-draft-count-${documentDraftCount}`}
                style={styles.androidQaEvidenceMarker}
            />
            <View style={styles.androidQaEvidenceActions}>
                <Button
                    size="xs"
                    action="secondary"
                    accessibilityLabel="chat-qa-hide-generation-evidence-action"
                    testID="chat-qa-hide-generation-evidence"
                    onPress={() => setIsHiddenForVisualCapture(true)}
                >
                    <ButtonText>QA hide</ButtonText>
                </Button>
                <Button
                    size="xs"
                    action="secondary"
                    testID="chat-qa-arm-during-document-preparation"
                    onPress={() => armAndroidQaGenerationGate('during-document-preparation')}
                >
                    <ButtonText>QA document</ButtonText>
                </Button>
                <Button
                    size="xs"
                    action="secondary"
                    testID="chat-qa-arm-before-first-output"
                    onPress={() => armAndroidQaGenerationGate('before-first-output')}
                >
                    <ButtonText>QA pre-output</ButtonText>
                </Button>
                <Button
                    size="xs"
                    action="secondary"
                    testID="chat-qa-arm-after-first-durable-output"
                    onPress={() => armAndroidQaGenerationGate('after-first-durable-output')}
                >
                    <ButtonText>QA first patch</ButtonText>
                </Button>
                {Platform.OS === 'android' ? (
                    <>
                        <Button
                            size="xs"
                            action="secondary"
                            testID="chat-qa-start-background-task"
                            onPress={() => void startQaBackgroundTask()}
                        >
                            <ButtonText>QA start FGS</ButtonText>
                        </Button>
                        <Button
                            size="xs"
                            action="secondary"
                            testID="chat-qa-stop-background-task"
                            onPress={() => void stopQaBackgroundTask()}
                        >
                            <ButtonText>QA stop FGS</ButtonText>
                        </Button>
                    </>
                ) : null}
            </View>
            {Platform.OS === 'android' ? (
                <>
                    <View
                        accessible
                        accessibilityLabel={`chat-qa-background-task-state-${backgroundTaskState}`}
                        collapsable={false}
                        testID={`chat-qa-background-task-state-${backgroundTaskState}`}
                        style={styles.androidQaEvidenceMarker}
                    />
                    {backgroundTaskFailureCategory ? (
                        <View
                            accessible
                            accessibilityLabel={`chat-qa-background-task-failure-${backgroundTaskFailureCategory}`}
                            collapsable={false}
                            testID={`chat-qa-background-task-failure-${backgroundTaskFailureCategory}`}
                            style={styles.androidQaEvidenceMarker}
                        />
                    ) : null}
                </>
            ) : null}
            {evidence.armedGate ? (
                <View
                    accessible
                    accessibilityLabel={`chat-qa-generation-armed-${evidence.armedGate}`}
                    collapsable={false}
                    testID={`chat-qa-generation-armed-${evidence.armedGate}`}
                    style={styles.androidQaEvidenceMarker}
                />
            ) : null}
            {evidence.activeGate ? (
                <View
                    accessible
                    accessibilityLabel={`chat-qa-generation-gate-${evidence.activeGate.phase}-${evidence.activeGate.operationId}`}
                    collapsable={false}
                    testID={`chat-qa-generation-gate-${evidence.activeGate.phase}-${evidence.activeGate.operationId}`}
                    style={styles.androidQaEvidenceMarker}
                />
            ) : null}
            {evidence.preparedGeneration ? (
                <>
                    <View
                        accessible
                        accessibilityLabel={`chat-prepared-generation-${evidence.preparedGeneration.userMessageId}-${evidence.preparedGeneration.assistantMessageId}`}
                        collapsable={false}
                        testID={`chat-prepared-generation-${evidence.preparedGeneration.userMessageId}-${evidence.preparedGeneration.assistantMessageId}`}
                        style={styles.androidQaEvidenceMarker}
                    />
                    {evidence.preparedGeneration.attachments.map((attachment) => (
                        <View
                            key={`${attachment.kind}:${attachment.id}`}
                            accessible
                            accessibilityLabel={`chat-prepared-attachment-${evidence.preparedGeneration?.assistantMessageId}-${attachment.kind}-${attachment.id}`}
                            collapsable={false}
                            testID={`chat-prepared-attachment-${evidence.preparedGeneration?.assistantMessageId}-${attachment.kind}-${attachment.id}`}
                            style={styles.androidQaEvidenceMarker}
                        />
                    ))}
                    {(evidence.preparedGeneration.documentSentinelIds ?? []).map((sentinelId) => (
                        <View
                            key={sentinelId}
                            accessible
                            accessibilityLabel={`chat-prepared-document-sentinel-${sentinelId}`}
                            collapsable={false}
                            testID={`chat-prepared-document-sentinel-${sentinelId}`}
                            style={styles.androidQaEvidenceMarker}
                        />
                    ))}
                </>
            ) : null}
        </View>
    );
}

const ChatScreenContent = () => {
    const {
        activeThread,
        messages,
        messageListRevision,
        isGenerating,
        isStoppingGeneration,
        isPreparingDocuments,
        shouldOfferSummary,
        truncatedMessageCount,
        appendUserMessage,
        deleteMessage,
        stopGeneration,
        regenerateFromUserMessage,
        startNewChat,
    } = useChatSession();
    const isGenerationBusy = isGenerating || isStoppingGeneration || isPreparingDocuments;
    usePreventRemove(isPreparingDocuments, () => undefined);
    const { state: engineState, loadModel } = useLLMEngine();
    const { t } = useTranslation();
    const { resolvedTheme } = useTheme();
    const modelRegistryRevision = useModelRegistryRevision();
    const router = useRouter();
    const { openErrorReport, sheetProps: errorReportSheetProps } = useErrorReportSheetController();
    const { paddingTop: headerInset, paddingBottom: tabBarInset } = useFloatingScrollInsets();
    const tabBarHeight = useBottomTabBarHeight();
    const isScreenFocused = useIsFocused();
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
    const [, setModelSyncRevision] = useState(0);
    const [settings, setSettings] = useState(() => getSettings());
    const [pendingRegenerateMessage, setPendingRegenerateMessage] = useState<{
        messageId: string;
        originalContent: string;
        attachments: ChatMessage['attachments'];
    } | null>(null);
    const newThreadRevision = useChatStore((state) => state.newThreadRevision);
    const updateThreadPresetSnapshot = useChatStore((state) => state.updateThreadPresetSnapshot);
    const updateThreadParamsSnapshot = useChatStore((state) => state.updateThreadParamsSnapshot);
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
    const androidKeyboardMetricsRef = useRef<AndroidKeyboardMetrics | null>(null);
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
    const modelSelectionRequestIdRef = useRef(0);
    const isScreenActiveRef = useRef(true);
    const documentPreparationInFlightRef = useRef(false);
    const previousActiveThreadIdRef = useRef(activeThread?.id ?? null);
    const autoModelLoadTargetKeyRef = useRef<string | null>(null);
    const hasActiveModel = Boolean(engineState.activeModelId);
    const isEngineReady = engineState.status === EngineStatus.READY;
    const isModelInitializing = engineState.status === EngineStatus.INITIALIZING;
    const warmupProgressPercent = useMemo(
        () => resolveModelWarmupProgressPercent(engineState.loadProgress),
        [engineState.loadProgress],
    );
    const activeThreadId = activeThread?.id ?? null;
    const currentChatActiveModelId = activeThread
        ? getThreadActiveModelId(activeThread)
        : settings.activeModelId ?? engineState.activeModelId ?? null;
    const isModelSelectionPending = pendingModelSelection != null;
    const isPendingModelSelectionForCurrentThread = pendingModelSelection != null
        && pendingModelSelection.threadId === activeThreadId;
    const isCurrentChatModelReady = Boolean(currentChatActiveModelId)
        && isEngineReady
        && engineState.activeModelId === currentChatActiveModelId;
    const isInputDisabled = !isCurrentChatModelReady
        || isPendingModelSelectionForCurrentThread
        || isGenerationBusy;
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
        composerPresentation: resolvedTheme.components.chat.composerPresentation,
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

    const displayedChatActiveModelId = isPendingModelSelectionForCurrentThread
        ? pendingModelSelection.modelId
        : currentChatActiveModelId;
    const activeChatModel = useMemo(() => {
        void modelRegistryRevision;

        return displayedChatActiveModelId ? registry.getModel(displayedChatActiveModelId) : undefined;
    }, [displayedChatActiveModelId, modelRegistryRevision]);
    const currentThreadModelArtifact = useMemo(() => {
        void modelRegistryRevision;
        return currentChatActiveModelId ? registry.getModel(currentChatActiveModelId) : undefined;
    }, [currentChatActiveModelId, modelRegistryRevision]);
    const canLoadCurrentThreadModel = Boolean(
        activeThread
        && currentChatActiveModelId
        && currentThreadModelArtifact?.localPath
        && (
            currentThreadModelArtifact.lifecycleStatus === LifecycleStatus.DOWNLOADED
            || currentThreadModelArtifact.lifecycleStatus === LifecycleStatus.ACTIVE
        ),
    );
    const multimodalReadiness = useMemo(
        () => resolveFallbackMultimodalReadiness(activeChatModel, displayedChatActiveModelId),
        [activeChatModel, displayedChatActiveModelId],
    );
    const hasReadyVisionSupport = isVisionReadinessReady(multimodalReadiness);
    const audioAttachmentsSupported = activeChatModel
        ? resolveEffectiveActiveVariantNativeSupport(activeChatModel).audio
        : false;
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
    const attachmentThreadOwnerKey = activeThread?.id ?? `new-thread:${newThreadRevision}`;
    const imageAttachmentOwnerKey = [
        attachmentThreadOwnerKey,
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
        attachmentThreadOwnerKey,
        displayedChatActiveModelId ?? 'no-displayed-model',
    ].join('|');
    const documentAttachmentDrafts = useChatDocumentAttachments({
        enabled: documentAttachmentsEnabled,
        disabledReason: documentAttachmentsDisabledReason,
        ownerKey: documentAttachmentOwnerKey,
        preserveFailedDraftsOnNewThreadCommit: true,
    });
    const openDocumentAttachmentPicker = documentAttachmentDrafts.attachDocuments;
    const mediaAttachmentOwnerKey = [
        attachmentThreadOwnerKey,
        displayedChatActiveModelId ?? 'no-displayed-model',
    ].join('|');
    const audioAttachmentReadinessReason = resolveAudioAttachmentReadinessReason({
        activeModelId: engineState.activeModelId,
        displayedModelId: displayedChatActiveModelId,
        hasDisplayedModel: Boolean(activeChatModel),
        isAudioSupported: audioAttachmentsSupported,
        isEngineReady,
        readiness: multimodalReadiness,
    });
    const audioAttachmentsEnabled =
        !isInputDisabled
        && !pendingRegenerateMessage
        && audioAttachmentReadinessReason === undefined;
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
                />
                <Box className="min-w-0 flex-1">
                    <Text colorRole="accent" className="text-xs font-semibold leading-4  ">
                        {t('chat.attachments.retainedForRegenerate', { count: retainedRegenerateAttachments.length })}
                    </Text>
                    <Text colorRole="accent" className="mt-0.5 text-xs leading-4  ">
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
        ? `${lastMessage.id}:${lastMessage.state}:${lastMessage.content.length}:${lastMessage.tokensPerSec ?? -1}:${messageListRevision}`
        : `empty:${messageListRevision}`;
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
    const activeThreadNeedsItsModel = Boolean(activeThread) && !isCurrentChatModelReady;
    const activeThreadModelUnavailable = activeThreadNeedsItsModel && !canLoadCurrentThreadModel;
    const recoveryTitle = activeThreadModelUnavailable
        ? t('chat.threadModelUnavailableTitle')
        : activeThreadNeedsItsModel
            ? (isModelInitializing ? t('chat.threadModelLoadingTitle') : t('chat.threadModelRequiredTitle'))
            : hasActiveModel
                ? t('chat.warmingUp')
                : t('chat.loadModelWarning');
    const recoveryDescription = activeThreadModelUnavailable
        ? t('chat.threadModelUnavailableDescription')
        : activeThreadNeedsItsModel
            ? t('chat.threadModelRequiredDescription', { model: modelLabel })
            : hasActiveModel
                ? t('chat.warmingUpDescription')
                : t('chat.loadModelDescription');
    const activePresetLabel = activeThread?.presetSnapshot.name ?? (settings.activePresetId ? resolvePresetSnapshot(settings.activePresetId).name : t('common.default'));
    const shouldShowModelRecovery = !isCurrentChatModelReady || isPendingModelSelectionForCurrentThread;
    const shouldShowRecoveryBanner = shouldShowModelRecovery && hasMessages;
    const shouldShowRecoveryCard = shouldShowModelRecovery && !hasMessages;
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
    const modelRecoveryActionRoute = useMemo(
        () => (
            hasDownloadedModels
                ? ({ pathname: '/(tabs)/models', params: { initialTab: 'downloaded' } } as const)
                : '/(tabs)/models'
        ),
        [hasDownloadedModels],
    );
    const resolvedModelRecoveryActionLabel = canLoadCurrentThreadModel
        ? t('chat.loadThreadModel')
        : hasActiveModel
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

    const executeThreadModelLoad = useCallback(async ({
        targetModelId,
        threadId,
        expectedThreadModelId,
        applySelection,
        options,
    }: {
        targetModelId: string;
        threadId: string | null;
        expectedThreadModelId: string | null;
        applySelection: boolean;
        options?: LoadModelOptions;
    }): Promise<
        | { status: 'applied' }
        | { status: 'stale' }
        | { status: 'failed'; error: unknown }
    > => {
        if (applySelection && hasActiveChatGenerationWork()) {
            return {
                status: 'failed',
                error: new AppError(
                    'engine_busy',
                    'Wait for the current chat work to finish before switching models.',
                ),
            };
        }
        const requestId = modelSelectionRequestIdRef.current + 1;
        modelSelectionRequestIdRef.current = requestId;
        if (applySelection && isScreenActiveRef.current) {
            setPendingModelSelection({ threadId, modelId: targetModelId });
        }

        const isLatestRequest = () => (
            isScreenActiveRef.current
            && modelSelectionRequestIdRef.current === requestId
        );
        const clearPendingSelection = () => {
            if (!isScreenActiveRef.current) {
                return;
            }
            setPendingModelSelection((currentValue) => (
                modelSelectionRequestIdRef.current === requestId
                && currentValue?.threadId === threadId
                && currentValue.modelId === targetModelId
                    ? null
                    : currentValue
            ));
        };
        const invalidateAsStale = () => {
            if (applySelection) {
                performanceMonitor.incrementCounter('chat.modelSelection.stale');
            }
            if (isScreenActiveRef.current) {
                setModelSyncRevision((revision) => revision + 1);
            }
            return { status: 'stale' as const };
        };
        const failSelection = (error: unknown) => {
            if (applySelection) {
                performanceMonitor.incrementCounter('chat.modelSelection.failed');
            }
            return { status: 'failed' as const, error };
        };
        const recoverAuthoritativeThreadModel = async (): Promise<
            | { status: 'recovered' }
            | { status: 'stale' }
            | { status: 'failed'; error: unknown }
        > => {
            if (!applySelection || !threadId || !isLatestRequest()) {
                return { status: 'stale' };
            }

            const recoveryState = useChatStore.getState();
            const authoritativeThread = recoveryState.getThread(threadId);
            if (
                recoveryState.activeThreadId !== threadId
                || !authoritativeThread
            ) {
                return { status: 'stale' };
            }
            const authoritativeModelId = getThreadActiveModelId(authoritativeThread);
            if (!authoritativeModelId) {
                return {
                    status: 'failed',
                    error: new Error(
                        'The conversation does not have an authoritative model to restore.',
                    ),
                };
            }
            const currentEngineState = llmEngineService.getState();
            if (
                currentEngineState.status === EngineStatus.READY
                && currentEngineState.activeModelId === authoritativeModelId
            ) {
                return { status: 'recovered' };
            }

            try {
                await loadModel(authoritativeModelId, {
                    preferLastWorkingProfile: true,
                });
            } catch {
                if (!isLatestRequest()) {
                    return { status: 'stale' };
                }
                autoModelLoadTargetKeyRef.current =
                    `${threadId}:${authoritativeModelId}`;
                return {
                    status: 'failed',
                    error: new Error(
                        'The authoritative conversation model could not be restored.',
                    ),
                };
            }

            if (!isLatestRequest()) {
                return { status: 'stale' };
            }
            const postRecoveryState = useChatStore.getState();
            const postRecoveryThread = postRecoveryState.getThread(threadId);
            const postRecoveryEngineState = llmEngineService.getState();
            if (
                postRecoveryState.activeThreadId !== threadId
                || !postRecoveryThread
                || getThreadActiveModelId(postRecoveryThread) !== authoritativeModelId
            ) {
                return { status: 'stale' };
            }
            if (
                postRecoveryEngineState.status !== EngineStatus.READY
                || postRecoveryEngineState.activeModelId !== authoritativeModelId
            ) {
                autoModelLoadTargetKeyRef.current =
                    `${threadId}:${authoritativeModelId}`;
                return {
                    status: 'failed',
                    error: new Error(
                        'The authoritative conversation model did not become ready.',
                    ),
                };
            }
            return { status: 'recovered' };
        };
        let targetModelLoadCompleted = false;

        try {
            await loadModel(targetModelId, options);
            targetModelLoadCompleted = true;

            if (!isLatestRequest()) {
                return invalidateAsStale();
            }

            const chatState = useChatStore.getState();
            const freshThread = threadId ? chatState.getThread(threadId) : undefined;
            const threadIntentIsCurrent = threadId === null
                ? chatState.activeThreadId === null
                : (
                    chatState.activeThreadId === threadId
                    && freshThread != null
                    && getThreadActiveModelId(freshThread) === expectedThreadModelId
                );
            const freshEngineState = llmEngineService.getState();
            const engineLoadedRequestedModel = freshEngineState.status === EngineStatus.READY
                && freshEngineState.activeModelId === targetModelId;

            if (!threadIntentIsCurrent) {
                return invalidateAsStale();
            }
            if (!engineLoadedRequestedModel) {
                return failSelection(
                    new Error('The requested model did not become the active ready context.'),
                );
            }

            let expectedParamsSnapshot: GenerationParamsSnapshot | null = null;
            if (
                applySelection
                && freshThread
                && threadId
                && expectedThreadModelId !== null
            ) {
                if (hasActiveChatGenerationWork()) {
                    return failSelection(new AppError(
                        'engine_busy',
                        'Wait for the current chat work to finish before switching models.',
                    ));
                }
                expectedParamsSnapshot = getGenerationParametersForModel(targetModelId);
                const commitResult = useChatStore.getState().commitThreadModelSelection({
                    threadId,
                    expectedCurrentModelId: expectedThreadModelId,
                    nextModelId: targetModelId,
                    paramsSnapshot: expectedParamsSnapshot,
                });

                if (
                    commitResult.status === 'missing'
                    || (
                        commitResult.status === 'stale'
                        && useChatStore.getState().activeThreadId !== threadId
                    )
                ) {
                    return invalidateAsStale();
                }
                if (
                    commitResult.status === 'busy'
                    || commitResult.status === 'persistence_failed'
                    || commitResult.status === 'stale'
                ) {
                    if (!isLatestRequest()) {
                        return invalidateAsStale();
                    }
                    const recoveryResult = await recoverAuthoritativeThreadModel();
                    if (recoveryResult.status === 'stale') {
                        return invalidateAsStale();
                    }
                    if (recoveryResult.status === 'failed') {
                        return failSelection(recoveryResult.error);
                    }
                    if (commitResult.status === 'stale') {
                        return invalidateAsStale();
                    }
                    return failSelection(
                        commitResult.status === 'persistence_failed'
                            ? new Error('The selected conversation model could not be saved.')
                            : new Error('The conversation is busy and cannot change models.'),
                    );
                }
            }

            if (!isLatestRequest()) {
                return invalidateAsStale();
            }
            const postCommitState = useChatStore.getState();
            const postCommitThread = threadId
                ? postCommitState.getThread(threadId)
                : undefined;
            const postCommitEngineState = llmEngineService.getState();
            const threadPostconditionHolds = threadId === null
                ? postCommitState.activeThreadId === null
                : (
                    postCommitState.activeThreadId === threadId
                    && postCommitThread != null
                    && getThreadActiveModelId(postCommitThread) === targetModelId
                    && (
                        !applySelection
                        || (
                            expectedParamsSnapshot != null
                            && areGenerationParamsSnapshotsEqual(
                                postCommitThread.paramsSnapshot,
                                expectedParamsSnapshot,
                            )
                        )
                    )
                );
            const enginePostconditionHolds =
                postCommitEngineState.status === EngineStatus.READY
                && postCommitEngineState.activeModelId === targetModelId;
            if (!threadPostconditionHolds || !enginePostconditionHolds) {
                const recoveryResult = await recoverAuthoritativeThreadModel();
                if (recoveryResult.status === 'stale') {
                    return invalidateAsStale();
                }
                if (recoveryResult.status === 'failed') {
                    return failSelection(recoveryResult.error);
                }
                return failSelection(
                    new Error('The model selection postcondition was not satisfied.'),
                );
            }

            autoModelLoadTargetKeyRef.current = null;
            if (applySelection) {
                performanceMonitor.incrementCounter('chat.modelSelection.applied');
            }
            if (isScreenActiveRef.current) {
                setModelSyncRevision((revision) => revision + 1);
            }
            return { status: 'applied' };
        } catch (error) {
            if (!isLatestRequest()) {
                return invalidateAsStale();
            }
            if (applySelection && threadId) {
                try {
                    const recoveryResult = await recoverAuthoritativeThreadModel();
                    if (recoveryResult.status === 'stale') {
                        return invalidateAsStale();
                    }
                    if (recoveryResult.status === 'failed') {
                        return failSelection(recoveryResult.error);
                    }
                } catch {
                    const recoveryState = useChatStore.getState();
                    const recoveryThread = recoveryState.getThread(threadId);
                    if (
                        recoveryState.activeThreadId === threadId
                        && recoveryThread
                    ) {
                        autoModelLoadTargetKeyRef.current =
                            `${threadId}:${getThreadActiveModelId(recoveryThread)}`;
                    }
                    return failSelection(
                        new Error(
                            'The authoritative conversation model recovery failed unexpectedly.',
                        ),
                    );
                }
            }
            return failSelection(
                targetModelLoadCompleted && applySelection
                    ? new Error('The model selection could not be completed safely.')
                    : error,
            );
        } finally {
            clearPendingSelection();
        }
    }, [loadModel]);

    const handleSelectModelFromHeader = useCallback(async (nextModelId: string) => {
        if (isGenerationBusy || hasActiveChatGenerationWork()) {
            return;
        }

        const chatState = useChatStore.getState();
        const selectionThreadId = chatState.activeThreadId;
        const selectionThread = selectionThreadId
            ? chatState.getThread(selectionThreadId)
            : undefined;
        const expectedThreadModelId = selectionThread
            ? getThreadActiveModelId(selectionThread)
            : null;

        if (nextModelId === expectedThreadModelId || (
            selectionThreadId === null && nextModelId === currentChatActiveModelId
        )) {
            modelSelectionRequestIdRef.current += 1;
            autoModelLoadTargetKeyRef.current = null;
            performanceMonitor.incrementCounter('chat.modelSelection.invalidated');
            setPendingModelSelection(null);
            setModelSyncRevision((revision) => revision + 1);
            setModelSelectorOpen(false);
            return;
        }

        setModelSelectorOpen(false);
        const attemptLoadSelectedModel = async (options?: LoadModelOptions): Promise<void> => {
            const result = await executeThreadModelLoad({
                targetModelId: nextModelId,
                threadId: selectionThreadId,
                expectedThreadModelId,
                applySelection: true,
                options,
            });
            if (result.status !== 'failed') {
                return;
            }

            const appError = toAppError(result.error, 'model_load_failed');
            const handledByMemoryPolicy = handleModelLoadMemoryPolicyError({
                t,
                appError,
                options,
                onRetry: (nextOptions) => {
                    void attemptLoadSelectedModel(nextOptions).catch((error) => {
                        try {
                            showAlertForError(
                                'common.actionFailed',
                                'ChatScreen.retryModelSelection',
                                toAppError(error, 'model_load_failed'),
                            );
                        } catch {
                            performanceMonitor.incrementCounter(
                                'chat.modelSelection.errorHandlerFailed',
                            );
                        }
                    });
                },
            });
            if (!handledByMemoryPolicy) {
                showAlertForError('common.actionFailed', 'ChatScreen.loadModel', appError);
            }
        };

        await attemptLoadSelectedModel();
    }, [
        currentChatActiveModelId,
        executeThreadModelLoad,
        isGenerationBusy,
        showAlertForError,
        t,
    ]);

    const handleModelRecoveryAction = useCallback(async () => {
        try {
            const chatState = useChatStore.getState();
            const threadId = chatState.activeThreadId;
            const thread = threadId ? chatState.getThread(threadId) : undefined;
            const threadModelId = thread ? getThreadActiveModelId(thread) : '';
            const model = threadModelId ? registry.getModel(threadModelId) : undefined;
            const canLoadModel = Boolean(
                thread
                && model?.localPath
                && (
                    model.lifecycleStatus === LifecycleStatus.DOWNLOADED
                    || model.lifecycleStatus === LifecycleStatus.ACTIVE
                ),
            );
            if (!threadId || !thread || !threadModelId || !canLoadModel) {
                router.navigate(modelRecoveryActionRoute);
                return;
            }

            autoModelLoadTargetKeyRef.current = null;
            const result = await executeThreadModelLoad({
                targetModelId: threadModelId,
                threadId,
                expectedThreadModelId: threadModelId,
                applySelection: false,
                options: {
                    preferLastWorkingProfile: true,
                },
            });
            if (result.status === 'failed') {
                showAlertForError(
                    'chat.threadModelLoadErrorTitle',
                    'ChatScreen.loadThreadModel',
                    toAppError(result.error, 'model_load_failed'),
                );
            }
        } catch {
            try {
                showAlertForError(
                    'chat.threadModelLoadErrorTitle',
                    'ChatScreen.loadThreadModel',
                    new Error('The conversation model recovery action failed.'),
                );
            } catch {
                performanceMonitor.incrementCounter(
                    'chat.modelSelection.errorHandlerFailed',
                );
            }
        }
    }, [
        executeThreadModelLoad,
        modelRecoveryActionRoute,
        router,
        showAlertForError,
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
        canApplyReload: !isGenerationBusy,
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

    const resetAndroidKeyboardState = useCallback(() => {
        if (Platform.OS !== 'android') {
            return;
        }

        if (keyboardMeasureFrameRef.current !== null) {
            cancelAnimationFrame(keyboardMeasureFrameRef.current);
            keyboardMeasureFrameRef.current = null;
        }

        isKeyboardVisibleRef.current = false;
        androidKeyboardMetricsRef.current = null;
        androidKeyboardInsetRef.current = 0;
        setIsAndroidKeyboardVisible(false);
        setAndroidKeyboardInsetValue(0);
        baseWindowHeightRef.current = Dimensions.get('window').height;
    }, [setAndroidKeyboardInsetValue]);

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
                if (!isAndroidKeyboardMeasurementCurrent({
                    isKeyboardVisible: isKeyboardVisibleRef.current,
                    activeMetrics: androidKeyboardMetricsRef.current,
                    measuredMetrics: keyboardMetrics,
                })) {
                    return;
                }

                setAndroidKeyboardInsetValue(getAndroidKeyboardSpacerHeight({
                    viewportCompensation,
                    currentSpacerHeight: androidKeyboardInsetRef.current,
                    composerBottomY: pageY + height,
                    keyboardTopY: shouldFloatComposerOverContent
                        ? (keyboardMetrics.screenTopY ?? keyboardMetrics.topY)
                        : keyboardMetrics.topY,
                    gap: screenLayoutMetrics.keyboardComposerGap,
                }));
            });
        });
    }, [setAndroidKeyboardInsetValue, shouldFloatComposerOverContent, tabBarHeight]);

    const handleComposerContainerLayout = useCallback((event: LayoutChangeEvent) => {
        const nextHeight = event.nativeEvent.layout.height;
        setComposerContainerHeight((currentValue) => (
            Math.abs(currentValue - nextHeight) < 1 ? currentValue : nextHeight
        ));

        if (isKeyboardVisibleRef.current) {
            updateAndroidKeyboardInsetFromLayout();
        }
    }, [updateAndroidKeyboardInsetFromLayout]);

    const handleAttachDocuments = useCallback(async () => {
        if (Platform.OS !== 'android') {
            await openDocumentAttachmentPicker();
            return;
        }

        Keyboard.dismiss();
        resetAndroidKeyboardState();
        try {
            await openDocumentAttachmentPicker();
        } finally {
            // The external picker can pause the activity without delivering keyboardDidHide,
            // and a late keyboard frame event can otherwise restore the stale inset on return.
            resetAndroidKeyboardState();
        }
    }, [openDocumentAttachmentPicker, resetAndroidKeyboardState]);

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
            documentPreparationInFlightRef.current = hasSendableDocumentAttachmentDrafts;
            const restoreAttachmentDraftsForRetry = (draftsToRestore: readonly AttachmentDraft[]) => {
                if (draftsToRestore.length === 0) {
                    return;
                }

                const retryThread = attachmentThreadOwnerKey.startsWith('new-thread:')
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

                const retryThread = attachmentThreadOwnerKey.startsWith('new-thread:')
                    ? useChatStore.getState().getActiveThread()
                    : null;
                const retryOwnerKey = retryThread
                    ? [retryThread.id, getThreadActiveModelId(retryThread)].join('|')
                    : null;

                if (retryOwnerKey) {
                    documentAttachmentDrafts.restoreDraftsForRetry(draftsToRestore, { preserveOwnerKey: retryOwnerKey });
                } else {
                    documentAttachmentDrafts.restoreDraftsForRetry(draftsToRestore);
                }
            };
            const restoreMediaDraftsForRetry = (draftsToRestore: readonly ChatMediaAttachmentDraft[]) => {
                if (draftsToRestore.length === 0) {
                    return;
                }

                mediaAttachmentDrafts.restoreDraftsForRetry(draftsToRestore);
            };

            let userMessageAppended = false;
            let documentFailureAlertCoversSendError = false;
            const restoredFailedDocumentDraftKeys = new Set<string>();
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
                            documentPreparationInFlightRef.current = false;
                        },
                        onDocumentAttachmentFailures: (failures) => {
                            const failedDrafts = failures.map((failure) => failure.draft)
                                .filter((draft, index, entries) => entries.findIndex((candidate) => (
                                    candidate === draft || (draft.id && candidate.id === draft.id)
                                )) === index);
                            failedDrafts.forEach((draft) => {
                                restoredFailedDocumentDraftKeys.add(draft.id || draft.localUri || draft.pickerUri);
                            });
                            documentFailureAlertCoversSendError = documentDrafts.length > 0
                                && documentDrafts.every((draft) => restoredFailedDocumentDraftKeys.has(
                                    draft.id || draft.localUri || draft.pickerUri,
                                ));
                            restoreDocumentDraftsForRetry(failedDrafts);
                            const details = failures.map(({ draft, errorCode }) => {
                                const displayName = sanitizeDocumentFailureDisplayName(
                                    draft.displayName ?? draft.fileName,
                                    t('chat.attachments.attachDocument'),
                                );
                                return `${displayName}: ${getErrorMessage(new AppError(errorCode, errorCode), t)}`;
                            }).join('\n');
                            Alert.alert(
                                t('common.actionFailed'),
                                `${t('chat.attachments.documentPartialFailure')}\n\n${details}`,
                            );
                        },
                        onPreparationCancelled: () => {
                            setComposerDraft(content);
                            restoreAttachmentDraftsForRetry(attachmentDrafts);
                            restoreDocumentDraftsForRetry(documentDrafts);
                            restoreMediaDraftsForRetry(mediaDrafts);
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
                const retryableDocumentDrafts = documentDrafts.filter((draft) => (
                    !restoredFailedDocumentDraftKeys.has(draft.id || draft.localUri || draft.pickerUri)
                ));
                if (retryableDocumentDrafts.length > 0 && missingAttachmentDraftIds) {
                    if (missingAttachmentDraftIds.size > 0) {
                        const { matchedDrafts, remainingDrafts } = splitAttachmentDraftsById(
                            retryableDocumentDrafts,
                            missingAttachmentDraftIds,
                        );
                        if (matchedDrafts.length > 0) {
                            documentAttachmentDrafts.discardDrafts(matchedDrafts, 'missing copied document drafts after failed send');
                        }
                        if (remainingDrafts.length > 0) {
                            restoreDocumentDraftsForRetry(remainingDrafts);
                        }
                    } else {
                        documentAttachmentDrafts.discardDrafts(retryableDocumentDrafts, 'missing copied document drafts after failed send');
                    }
                } else if (retryableDocumentDrafts.length > 0) {
                    restoreDocumentDraftsForRetry(retryableDocumentDrafts);
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
                throw documentFailureAlertCoversSendError
                    ? markChatInputErrorReported(error)
                    : error;
            }
        } finally {
            documentPreparationInFlightRef.current = false;
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

    useFocusEffect(
        useCallback(() => {
            isScreenActiveRef.current = true;
            return () => {
                isScreenActiveRef.current = false;
                modelSelectionRequestIdRef.current += 1;
                autoModelLoadTargetKeyRef.current = null;
                performanceMonitor.incrementCounter('chat.modelSelection.invalidated');
                setPendingModelSelection(null);
                if (documentPreparationInFlightRef.current) {
                    // A tab or route transition must invalidate document preparation before its
                    // late native result can be attached to whichever conversation becomes active.
                    void stopGeneration().catch(() => {
                        performanceMonitor.incrementCounter('chat.documentPreparation.blurStopFailed');
                    });
                }
            };
        }, [stopGeneration]),
    );

    useEffect(() => {
        if (previousActiveThreadIdRef.current === activeThreadId) {
            return;
        }

        previousActiveThreadIdRef.current = activeThreadId;
        modelSelectionRequestIdRef.current += 1;
        autoModelLoadTargetKeyRef.current = null;
        performanceMonitor.incrementCounter('chat.modelSelection.invalidated');
        setPendingModelSelection(null);
    }, [activeThreadId]);

    useEffect(() => {
        if (
            !isScreenFocused
            || !activeThreadId
            || !currentChatActiveModelId
            || isGenerationBusy
            || isPendingModelSelectionForCurrentThread
        ) {
            return;
        }

        if (
            engineState.status === EngineStatus.READY
            && engineState.activeModelId === currentChatActiveModelId
        ) {
            autoModelLoadTargetKeyRef.current = null;
            return;
        }

        void modelRegistryRevision;
        const threadModel = registry.getModel(currentChatActiveModelId);
        const canAutoLoadThreadModel = threadModel?.localPath
            && (
                threadModel.lifecycleStatus === LifecycleStatus.DOWNLOADED
                || threadModel.lifecycleStatus === LifecycleStatus.ACTIVE
            );
        if (!canAutoLoadThreadModel) {
            return;
        }

        const targetKey = `${activeThreadId}:${currentChatActiveModelId}`;
        if (autoModelLoadTargetKeyRef.current === targetKey) {
            return;
        }
        autoModelLoadTargetKeyRef.current = targetKey;

        void executeThreadModelLoad({
            targetModelId: currentChatActiveModelId,
            threadId: activeThreadId,
            expectedThreadModelId: currentChatActiveModelId,
            applySelection: false,
            options: { preferLastWorkingProfile: true },
        }).then((result) => {
            if (
                result.status === 'failed'
                && autoModelLoadTargetKeyRef.current === targetKey
            ) {
                showAlertForError(
                    'chat.threadModelLoadErrorTitle',
                    'ChatScreen.autoLoadThreadModel',
                    toAppError(result.error, 'model_load_failed'),
                );
            }
            if (
                result.status === 'stale'
                && autoModelLoadTargetKeyRef.current === targetKey
            ) {
                autoModelLoadTargetKeyRef.current = null;
            }
        }).catch((error) => {
            try {
                showAlertForError(
                    'chat.threadModelLoadErrorTitle',
                    'ChatScreen.autoLoadThreadModel',
                    toAppError(error, 'model_load_failed'),
                );
            } catch {
                performanceMonitor.incrementCounter(
                    'chat.modelSelection.errorHandlerFailed',
                );
            }
        });
    }, [
        activeThreadId,
        currentChatActiveModelId,
        engineState.activeModelId,
        engineState.status,
        executeThreadModelLoad,
        isGenerationBusy,
        isPendingModelSelectionForCurrentThread,
        isScreenFocused,
        modelRegistryRevision,
        showAlertForError,
    ]);

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
                keyboardMetrics.topY = getAndroidKeyboardTopY({
                    screenHeight,
                    windowHeight: window.height,
                    keyboardHeight: keyboardMetrics.height,
                    reportedScreenY: keyboardMetrics.reportedScreenY ?? keyboardMetrics.topY,
                });
                keyboardMetrics.screenTopY = getAndroidFloatingKeyboardTopY({
                    screenHeight,
                    keyboardHeight: keyboardMetrics.height,
                    reportedScreenY: keyboardMetrics.reportedScreenY ?? keyboardMetrics.screenTopY,
                });
            }

            updateAndroidKeyboardInsetFromLayout();
        });

        const updateKeyboardMetrics = (event: KeyboardEvent) => {
            isKeyboardVisibleRef.current = true;
            setIsAndroidKeyboardVisible(true);
            const keyboardHeight = event.endCoordinates.height;
            const screenHeight = Dimensions.get('screen').height;
            const reportedScreenY = event.endCoordinates.screenY;
            androidKeyboardMetricsRef.current = {
                height: keyboardHeight,
                topY: getAndroidKeyboardTopY({
                    screenHeight,
                    windowHeight: Dimensions.get('window').height,
                    keyboardHeight,
                    reportedScreenY,
                }),
                screenTopY: getAndroidFloatingKeyboardTopY({
                    screenHeight,
                    keyboardHeight,
                    reportedScreenY,
                }),
                reportedScreenY,
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
            resetAndroidKeyboardState();
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
    }, [resetAndroidKeyboardState, updateAndroidKeyboardInsetFromLayout]);

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
    }, [
        activeThread?.id,
        clearForcedScrollTimeouts,
        closeModelParameters,
        newThreadRevision,
        setShouldFollowLatestMessage,
    ]);

    useFocusEffect(
        useCallback(() => {
            if (Platform.OS !== 'android') {
                return undefined;
            }

            const subscription = BackHandler.addEventListener('hardwareBackPress', () => (
                isGenerationBusy
                    ? true
                    : handleAndroidBackNavigation({
                        canGoBack: router.canGoBack(),
                        onGoBack: () => {
                            router.back();
                        },
                    })
            ));

            return () => {
                subscription.remove();
            };
        }, [isGenerationBusy, router]),
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
                messageState={msg.state}
                tokensPerSec={msg.tokensPerSec}
                inferenceMetrics={msg.inferenceMetrics}
                canDelete={msg.state !== 'streaming' && !isGenerationBusy}
                canRegenerate={
                    msg.role === 'user'
                    && msg.state === 'complete'
                    && !isGenerationBusy
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
        isGenerationBusy,
        isInputDisabled,
        messages.length,
    ]);

    return (
        <>
            <ChatHeader
                androidContentBlurTargetRef={warmupContentBlurTargetRef}
                title={headerTitle}
                presetLabel={activePresetLabel}
                modelLabel={headerModelLabel}
                modelSelectable={hasDownloadedModels}
                statusLabel={statusLabel}
                statusTone={statusTone}
                canStartNewChat={!isGenerationBusy}
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
                canOpenPresetSelector={!isGenerationBusy}
                onOpenModelSelector={hasDownloadedModels
                    ? () => {
                        setModelSelectorOpen(true);
                    }
                    : undefined}
                canOpenModelSelector={hasDownloadedModels && !isGenerationBusy}
                canOpenModelControls={Boolean(configurableModelId) && !isGenerationBusy && !isModelSelectionPending}
                onBack={!isGenerationBusy && router.canGoBack() ? () => router.back() : undefined}
            />

            <ScreenAndroidContentBlurTarget
                blurTargetRef={warmupContentBlurTargetRef}
                style={styles.warmupContentBlurTarget}
                testID="chat-warmup-content-blur-target"
            >
                <Box className="flex-1">
                <Box className="flex-1 px-3 pt-1.5">
                    {shouldShowRecoveryBanner ? (
                        <Box className="mb-3">
                            <ChatStatusBanner
                                title={recoveryTitle}
                                description={recoveryDescription}
                                actionLabel={resolvedModelRecoveryActionLabel}
                                onAction={() => {
                                    void handleModelRecoveryAction();
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
                                testID="chat-stopped-banner"
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

                    <AndroidQaGenerationEvidenceSurface
                        documentDraftCount={documentAttachmentDrafts.drafts.length}
                        topInset={headerInset}
                    />

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
                                ListHeaderComponent={isAndroidQaGenerationEvidenceEnabled() ? (
                                    <View
                                        accessible
                                        accessibilityLabel="chat-history-start-anchor"
                                        collapsable={false}
                                        testID="chat-history-start-anchor"
                                        style={styles.chatHistoryStartAnchor}
                                    />
                                ) : null}
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
                                        <ScreenSurface material={{ role: 'control', variant: 'inline' }} shape="full" className="mt-4 px-3 py-1.5">
                                            <Text colorRole="secondary" className="text-xs font-semibold uppercase tracking-wide">
                                                {modelLabel}
                                            </Text>
                                        </ScreenSurface>
                                    ) : null}

                                    <Text colorRole="primary"
                                        className="mt-5 text-center text-xl font-semibold leading-7  "
                                    >
                                        {recoveryTitle}
                                    </Text>

                                    {isModelInitializing ? (
                                        <ScreenSurface tone="accent" withControlTint className="mt-4 w-full px-3 py-2.5">
                                            <Box className="mb-2 flex-row items-center justify-end">
                                                <ScreenSurface material={{ role: 'control', variant: 'inline', tone: 'accent' }} shape="full" className="px-2.5 py-1">
                                                    <Text colorRole="accent" className="text-xs font-bold">
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
                                            />
                                        </ScreenSurface>
                                    ) : null}

                                    <Text colorRole="secondary"
                                        className="mt-3 text-center text-sm leading-6  "
                                    >
                                        {recoveryDescription}
                                    </Text>

                                    <Button
                                        size="md"
                                        className="mt-6 self-stretch"
                                        onPress={() => {
                                            void handleModelRecoveryAction();
                                        }}
                                    >
                                        <MaterialSymbols
                                            name={hasActiveModel ? 'tune' : 'download'}
                                            size={18}
                                            colorRole="onAccent"
                                        />
                                        <ButtonText>{resolvedModelRecoveryActionLabel}</ButtonText>
                                    </Button>

                                    <Text colorRole="secondary"
                                        className="mt-4 text-center text-xs leading-5  "
                                    >
                                        {activeThread
                                            ? t('chat.emptyExistingThread')
                                            : t('chat.emptyNewThread')}
                                    </Text>
                                </ScreenCard>
                            </Box>
                        ) : (
                            <Box className="flex-1 items-center px-6 pt-14 pb-8">
                                <Text colorRole="primary" className="text-xl font-semibold  ">
                                    {t('chat.noMessages')}
                                </Text>
                                <Text colorRole="tertiary" className="mt-2 text-center text-sm leading-6  ">
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
                                isSending={isGenerating || isPreparingDocuments}
                                androidContentBlurTargetRef={warmupContentBlurTargetRef}
                                attachmentDrafts={imageAttachmentDrafts.drafts}
                                documentAttachmentDrafts={documentAttachmentDrafts.drafts}
                                mediaAttachmentDrafts={mediaAttachmentDrafts.drafts}
                                onAttachImages={imageAttachmentDrafts.attachImages}
                                onAttachDocuments={handleAttachDocuments}
                                onAttachAudio={mediaAttachmentDrafts.attachAudio}
                                onRemoveAttachmentDraft={imageAttachmentDrafts.removeDraft}
                                onRemoveDocumentAttachmentDraft={documentAttachmentDrafts.removeDraft}
                                onRemoveMediaAttachmentDraft={mediaAttachmentDrafts.removeDraft}
                                imageAttachmentsEnabled={imageAttachmentsEnabled}
                                documentAttachmentsEnabled={documentAttachmentsEnabled}
                                audioAttachmentsSupported={audioAttachmentsSupported}
                                audioAttachmentsEnabled={audioAttachmentsEnabled}
                                imageAttachmentsDisabledReason={imageAttachmentsDisabledReason}
                                documentAttachmentsDisabledReason={documentAttachmentsDisabledReason}
                                audioAttachmentsDisabledReason={audioAttachmentsDisabledReason}
                                isImageAttachmentActionBusy={imageAttachmentDrafts.isPicking}
                                isDocumentAttachmentActionBusy={documentAttachmentDrafts.isPicking || isPreparingDocuments}
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
                                isSending={isGenerating || isPreparingDocuments}
                                androidContentBlurTargetRef={warmupContentBlurTargetRef}
                                attachmentDrafts={imageAttachmentDrafts.drafts}
                                documentAttachmentDrafts={documentAttachmentDrafts.drafts}
                                mediaAttachmentDrafts={mediaAttachmentDrafts.drafts}
                                onAttachImages={imageAttachmentDrafts.attachImages}
                                onAttachDocuments={handleAttachDocuments}
                                onAttachAudio={mediaAttachmentDrafts.attachAudio}
                                onRemoveAttachmentDraft={imageAttachmentDrafts.removeDraft}
                                onRemoveDocumentAttachmentDraft={documentAttachmentDrafts.removeDraft}
                                onRemoveMediaAttachmentDraft={mediaAttachmentDrafts.removeDraft}
                                imageAttachmentsEnabled={imageAttachmentsEnabled}
                                documentAttachmentsEnabled={documentAttachmentsEnabled}
                                audioAttachmentsSupported={audioAttachmentsSupported}
                                audioAttachmentsEnabled={audioAttachmentsEnabled}
                                imageAttachmentsDisabledReason={imageAttachmentsDisabledReason}
                                documentAttachmentsDisabledReason={documentAttachmentsDisabledReason}
                                audioAttachmentsDisabledReason={audioAttachmentsDisabledReason}
                                isImageAttachmentActionBusy={imageAttachmentDrafts.isPicking}
                                isDocumentAttachmentActionBusy={documentAttachmentDrafts.isPicking || isPreparingDocuments}
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
                canSelect={!isGenerationBusy}
                androidContentBlurTargetRef={warmupContentBlurTargetRef}
                onClose={() => setModelSelectorOpen(false)}
                onSelectModel={(modelId) => {
                    void handleSelectModelFromHeader(modelId).catch((error) => {
                        try {
                            showAlertForError(
                                'common.actionFailed',
                                'ChatScreen.selectModel',
                                toAppError(error, 'model_load_failed'),
                            );
                        } catch {
                            performanceMonitor.incrementCounter(
                                'chat.modelSelection.errorHandlerFailed',
                            );
                        }
                    });
                }}
            />

            <PresetSelectorSheet
                visible={isPresetSelectorOpen}
                canSelect={!isGenerationBusy}
                activePresetId={activeThread?.presetId ?? settings.activePresetId}
                androidContentBlurTargetRef={warmupContentBlurTargetRef}
                onClose={() => setPresetSelectorOpen(false)}
                onSelectPreset={(presetId: string | null) => {
                    if (isGenerationBusy || hasActiveChatGenerationWork()) {
                        return;
                    }
                    const presetSnapshot = resolvePresetSnapshot(presetId);
                    selectActiveChatPreset(presetId);

                    if (activeThread) {
                        updateThreadPresetSnapshot(activeThread.id, presetId, presetSnapshot);
                    }
                }}
                onManagePresets={() => {
                    if (isGenerationBusy || hasActiveChatGenerationWork()) {
                        return;
                    }
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
        </>
    );
};

export const ChatScreen = () => (
    <ScreenRoot className="w-full max-w-2xl mx-auto">
        <ChatScreenContent />
    </ScreenRoot>
);

const styles = StyleSheet.create({
    androidQaEvidenceSurface: {
        gap: 2,
        paddingHorizontal: 4,
        paddingVertical: 2,
    },
    androidQaEvidenceActions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 4,
    },
    androidQaEvidenceMarker: {
        height: 1,
        width: 1,
    },
    chatHistoryStartAnchor: {
        height: 1,
        width: 1,
    },
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
