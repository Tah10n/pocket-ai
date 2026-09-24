import React from 'react';
import { useTranslation } from 'react-i18next';
import type { EngineDiagnostics } from '@/types/models';
import { Box } from './box';
import { Text } from './text';

/** Bounded engine readback only. Draft controls do not describe a completed request. */
export function GenerationRuntimeDiagnostics({ value }: { value: NonNullable<EngineDiagnostics['generation']> }) {
  const { t } = useTranslation();
  const yesNo = (enabled: boolean) => t(`advancedGeneration.choices.${enabled ? 'on' : 'off'}`);
  const finite = (value: number | undefined): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const timings = value.timings;
  return (
    <Box testID="generation-runtime-diagnostics" className="mt-3 gap-1">
      <Text accessibilityRole="header" colorRole="accent" className="text-xs font-semibold uppercase tracking-wider">
        {t('generationDiagnostics.title')}
      </Text>
      <Text colorRole="secondary" className="text-xs leading-4">{t('generationDiagnostics.scope')}</Text>
      <Text testID="generation-runtime-format" colorRole="secondary" className="text-sm leading-5">
        {t('generationDiagnostics.format', { mode: t(`advancedGeneration.choices.${value.outputMode}`),
          source: t(`generationDiagnostics.source.${value.templateSource}`), formatter: t(`generationDiagnostics.formatter.${value.formatter}`) })}
      </Text>
      <Text testID="generation-runtime-prefill" colorRole="secondary" className="text-sm leading-5">
        {t('generationDiagnostics.prefill', { operation: yesNo(value.prefill), suffix: yesNo(value.hasPrefillText) })}
      </Text>
      <Text testID="generation-runtime-probabilities" colorRole="secondary" className="text-sm leading-5">
        {t('generationDiagnostics.probabilities', { count: value.nProbs })}
      </Text>
      {value.probabilities ? (
        <Text testID="generation-runtime-retained" colorRole="secondary" className="text-sm leading-5">
          {t('generationDiagnostics.retained', { count: value.probabilities.retainedTokens,
            suffix: value.probabilities.truncated ? t('generationDiagnostics.truncated') : '' })}
        </Text>
      ) : null}
      {value.nProbs > 0 ? <Text colorRole="secondary" className="text-xs leading-4">{t('generationDiagnostics.probabilityMeaning')}</Text> : null}
      {timings ? (
        <>
          <Text testID="generation-runtime-tokens" colorRole="secondary" className="text-sm leading-5">
            {t('generationDiagnostics.tokens', { prompt: timings.tokensEvaluated, generated: timings.tokensPredicted })}
          </Text>
          {finite(timings.promptPerSecond) ? <Text testID="generation-runtime-prompt-speed" colorRole="secondary" className="text-sm leading-5">
            {t('generationDiagnostics.promptSpeed', { speed: timings.promptPerSecond.toFixed(2) })}
          </Text> : null}
          {finite(timings.predictedPerSecond) ? <Text testID="generation-runtime-generation-speed" colorRole="secondary" className="text-sm leading-5">
            {t('generationDiagnostics.generationSpeed', { speed: timings.predictedPerSecond.toFixed(2) })}
          </Text> : null}
          {finite(timings.timeToFirstTokenMs) ? <Text testID="generation-runtime-ttft" colorRole="secondary" className="text-sm leading-5">
            {t('generationDiagnostics.ttft', { milliseconds: Math.round(timings.timeToFirstTokenMs) })}
          </Text> : null}
        </>
      ) : null}
    </Box>
  );
}
