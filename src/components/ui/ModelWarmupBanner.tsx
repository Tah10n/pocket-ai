import React, { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Box } from '@/components/ui/box';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { ScreenBanner, ScreenIconTile, useScreenAppearance } from '@/components/ui/ScreenShell';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { EngineStatus, type EngineState } from '@/types/models';
import type { MultimodalReadinessState, MultimodalReadinessStatus } from '@/types/multimodal';
import type { AndroidBlurTargetRef } from '@/utils/androidBlur';
import { sanitizeMultimodalFailureReason } from '@/utils/multimodalFailureReason';
import { getNativeBottomSafeAreaInset } from '@/utils/safeArea';

export const MODEL_WARMUP_BANNER_BOTTOM_GAP = 8;
export const MODEL_WARMUP_BANNER_RESERVED_HEIGHT = 120;

const WARMUP_MULTIMODAL_READINESS_KEYS: Record<MultimodalReadinessStatus, string | null> = {
  ready: null,
  text_only: 'chat.visionReadiness.textOnly',
  missing_projector: 'chat.visionReadiness.missingProjector',
  ambiguous_projector: 'chat.visionReadiness.ambiguousProjector',
  projector_downloading: 'chat.visionReadiness.projectorDownloading',
  initializing: 'chat.visionReadiness.initializing',
  failed: 'chat.visionReadiness.failed',
  unsupported: 'chat.visionReadiness.unsupported',
};
const WARMUP_FAILURE_REASON_MAX_LENGTH = 140;

export function resolveModelWarmupProgressPercent(loadProgress: number): number {
  const rawPercent = loadProgress > 1 ? loadProgress : loadProgress * 100;
  const resolvedPercent = Number.isFinite(rawPercent) ? Math.round(rawPercent) : 0;
  return Math.max(0, Math.min(100, resolvedPercent));
}

export function ModelWarmupBanner({
  androidContentBlurTargetRef,
  bottomOffset,
  engineState,
  multimodalReadiness,
}: {
  androidContentBlurTargetRef?: AndroidBlurTargetRef | null;
  bottomOffset?: number;
  engineState: EngineState;
  multimodalReadiness?: MultimodalReadinessState;
}) {
  const { t } = useTranslation();
  const appearance = useScreenAppearance();
  const insets = useSafeAreaInsets();
  const lastIosAnnouncementRef = useRef<string | null>(null);

  const progressPercent = useMemo(
    () => resolveModelWarmupProgressPercent(engineState.loadProgress),
    [engineState.loadProgress],
  );
  const safeBottomOffset = getNativeBottomSafeAreaInset(insets.bottom);
  const shouldForceNativeAndroidBlur = Boolean(androidContentBlurTargetRef);
  const diagnosticsMultimodal = engineState.diagnostics?.multimodal;
  const multimodalReadinessStatus = multimodalReadiness?.status ?? diagnosticsMultimodal?.readinessStatus;
  const multimodalReadinessKey = multimodalReadinessStatus
    ? WARMUP_MULTIMODAL_READINESS_KEYS[multimodalReadinessStatus]
    : null;
  const multimodalFailureReason = sanitizeMultimodalFailureReason(
    diagnosticsMultimodal?.failureReason ?? multimodalReadiness?.failureReason,
    WARMUP_FAILURE_REASON_MAX_LENGTH,
  );
  const warmupPhaseText = t('chat.warmingUp');
  const multimodalReadinessText = multimodalReadinessKey ? t(multimodalReadinessKey) : null;
  const warmupAccessibilityLabel = [
    warmupPhaseText,
    multimodalReadinessText,
    multimodalFailureReason,
  ]
    .filter((entry): entry is string => Boolean(entry))
    .join(' ');
  const warmupAnnouncement = engineState.status === EngineStatus.INITIALIZING
    ? warmupAccessibilityLabel
    : null;

  useEffect(() => {
    if (Platform.OS !== 'ios') {
      return;
    }

    const announcement = warmupAnnouncement?.trim() || null;
    if (!announcement) {
      lastIosAnnouncementRef.current = null;
      return;
    }

    if (lastIosAnnouncementRef.current === announcement) {
      return;
    }

    lastIosAnnouncementRef.current = announcement;
    AccessibilityInfo.announceForAccessibility(announcement);
  }, [warmupAnnouncement]);

  if (engineState.status !== EngineStatus.INITIALIZING) {
    return null;
  }

  return (
    <Box
      pointerEvents="box-none"
      testID="model-warmup-banner-container"
      className="absolute left-0 right-0 items-center px-3"
      style={{ bottom: (bottomOffset ?? safeBottomOffset) + MODEL_WARMUP_BANNER_BOTTOM_GAP }}
    >
      <ScreenBanner
        testID="model-warmup-banner"
        floating
        tone="accent"
        forceNativeAndroidBlur={shouldForceNativeAndroidBlur}
        androidBlurTargetRef={androidContentBlurTargetRef ?? null}
        className="w-full max-w-lg"
      >
        <Box
          testID="model-warmup-banner-live-region"
          accessible
          accessibilityLabel={warmupAccessibilityLabel}
          accessibilityLiveRegion={Platform.OS === 'android' ? 'polite' : undefined}
          role="status"
          className="mb-2 flex-row items-center gap-2"
        >
          <ScreenIconTile iconName="sync" tone="accent" size="sm" className="h-8 w-8">
            <Spinner className="text-primary-600 dark:text-primary-300" />
          </ScreenIconTile>
          <Box className="min-w-0 flex-1">
            <Text
              numberOfLines={1}
              textRole="action"
              className="text-primary-700 dark:text-primary-200"
            >
              {warmupPhaseText}{' '}{progressPercent}%
            </Text>
            {multimodalReadinessText ? (
              <Text
                testID="model-warmup-multimodal-readiness"
                numberOfLines={1}
                textRole="caption"
                className="text-primary-700 dark:text-primary-200"
              >
                {multimodalReadinessText}
              </Text>
            ) : null}
            {multimodalFailureReason ? (
              <Text
                testID="model-warmup-multimodal-failure"
                numberOfLines={1}
                textRole="caption"
                className="text-primary-700 dark:text-primary-200"
              >
                {multimodalFailureReason}
              </Text>
            ) : null}
          </Box>
        </Box>
        <ProgressBar
          testID="model-warmup-progress-track"
          fillTestID="model-warmup-progress-fill"
          valuePercent={progressPercent}
          size="lg"
          tone="primary"
          variant="framed"
          fillClassName={appearance.classNames.toneClassNameByTone.primary.progressFillClassName}
          forceNativeAndroidBlur={shouldForceNativeAndroidBlur}
          androidBlurTargetRef={androidContentBlurTargetRef ?? null}
        />
      </ScreenBanner>
    </Box>
  );
}
