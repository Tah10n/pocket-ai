import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Box } from '@/components/ui/box';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { EngineStatus, type EngineState } from '@/types/models';

function resolveProgressPercent(loadProgress: number): number {
  const rawPercent = loadProgress > 1 ? loadProgress : loadProgress * 100;
  const resolvedPercent = Number.isFinite(rawPercent) ? Math.round(rawPercent) : 0;
  return Math.max(0, Math.min(100, resolvedPercent));
}

export function ModelWarmupBanner({ engineState }: { engineState: EngineState }) {
  const { t } = useTranslation();

  const progressPercent = useMemo(
    () => resolveProgressPercent(engineState.loadProgress),
    [engineState.loadProgress],
  );

  if (engineState.status !== EngineStatus.INITIALIZING) {
    return null;
  }

  return (
    <Box className="absolute bottom-0 left-0 right-0 flex-row items-center justify-center bg-primary-500 p-2">
      <Spinner className="mr-2 text-white" />
      <Text className="font-bold text-white">
        {t('chat.warmingUp')}{' '}{progressPercent}%
      </Text>
    </Box>
  );
}
