import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Box } from '@/components/ui/box';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { EngineStatus, type EngineState } from '@/types/models';
import { getNativeBottomSafeAreaInset } from '@/utils/safeArea';

export const MODEL_WARMUP_BANNER_BOTTOM_GAP = 8;
export const MODEL_WARMUP_BANNER_RESERVED_HEIGHT = 96;

export function resolveModelWarmupProgressPercent(loadProgress: number): number {
  const rawPercent = loadProgress > 1 ? loadProgress : loadProgress * 100;
  const resolvedPercent = Number.isFinite(rawPercent) ? Math.round(rawPercent) : 0;
  return Math.max(0, Math.min(100, resolvedPercent));
}

export function ModelWarmupBanner({
  bottomOffset,
  engineState,
}: {
  bottomOffset?: number;
  engineState: EngineState;
}) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();

  const progressPercent = useMemo(
    () => resolveModelWarmupProgressPercent(engineState.loadProgress),
    [engineState.loadProgress],
  );
  const safeBottomOffset = getNativeBottomSafeAreaInset(insets.bottom);

  if (engineState.status !== EngineStatus.INITIALIZING) {
    return null;
  }

  return (
    <Box
      className="absolute left-3 right-3 rounded-2xl border border-primary-500/20 bg-background-0/95 px-3 py-2.5 dark:border-primary-400/25 dark:bg-background-950/95"
      style={{ bottom: (bottomOffset ?? safeBottomOffset) + MODEL_WARMUP_BANNER_BOTTOM_GAP }}
    >
      <Box className="mb-2 flex-row items-center gap-2">
        <Box className="h-8 w-8 items-center justify-center rounded-full bg-primary-500/10 dark:bg-primary-500/15">
          <Spinner className="text-primary-600 dark:text-primary-300" />
        </Box>
        <Text numberOfLines={1} className="min-w-0 flex-1 text-sm font-semibold text-primary-700 dark:text-primary-200">
          {t('chat.warmingUp')}{' '}{progressPercent}%
        </Text>
      </Box>
      <ProgressBar
        testID="model-warmup-progress-track"
        fillTestID="model-warmup-progress-fill"
        valuePercent={progressPercent}
        size="lg"
        tone="primary"
        variant="framed"
      />
    </Box>
  );
}
