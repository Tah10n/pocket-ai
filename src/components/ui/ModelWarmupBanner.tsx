import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Box } from '@/components/ui/box';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { ScreenBanner, ScreenIconTile } from '@/components/ui/ScreenShell';
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
    <ScreenBanner
      floating
      tone="accent"
      className="absolute left-3 right-3"
      style={{ bottom: (bottomOffset ?? safeBottomOffset) + MODEL_WARMUP_BANNER_BOTTOM_GAP }}
    >
      <Box className="mb-2 flex-row items-center gap-2">
        <ScreenIconTile iconName="sync" tone="accent" size="sm" className="h-8 w-8">
          <Spinner className="text-primary-600 dark:text-primary-300" />
        </ScreenIconTile>
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
    </ScreenBanner>
  );
}
