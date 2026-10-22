import React from 'react';
import { useTranslation } from 'react-i18next';
import { Box } from './box';
import { Text } from './text';
import { Button, ButtonText } from './button';
import { ScrollView } from './scroll-view';
import { AppError, getErrorMessage } from '../../services/AppError';
import { isComparisonVariantSelectable, type ChatComparison } from '../../hooks/useChatComparison';

export function ChatComparisonPanel({ comparison, onStop, onChoose, onClose }: {
  comparison: ChatComparison;
  onStop: (index: 0 | 1) => void;
  onChoose: (index: 0 | 1) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Box testID="chat-comparison-panel" className="gap-2 rounded-2xl border border-outline-200 p-3">
      <Box className="flex-row items-center justify-between gap-2">
        <Text colorRole="primary" className="flex-1 font-semibold">{t('comparison.title')}</Text>
        <Button size="sm" action="secondary" testID="chat-comparison-close" onPress={onClose}>
          <ButtonText>{t('common.close')}</ButtonText>
        </Button>
      </Box>
      <Text colorRole="secondary" className="text-xs">{t('comparison.description')}</Text>
      {comparison.errorCode ? <Text colorRole="danger" accessibilityLiveRegion="polite">
        {getErrorMessage(new AppError(comparison.errorCode, comparison.errorCode), t)}
      </Text> : null}
      <ScrollView className="max-h-64" nestedScrollEnabled>
        <Box className="gap-3">
          {comparison.variants.map((variant, offset) => {
            const index = offset === 0 ? 0 : 1;
            const terminal = ['completed', 'cancelled', 'error'].includes(variant.state);
            return (
              <Box key={index} className="gap-2 rounded-xl bg-background-50 p-3" testID={`chat-comparison-${index}`}>
                <Text colorRole="primary" className="font-semibold">{t('comparison.variant', { number: index + 1 })}</Text>
                <Text colorRole="secondary" className="text-xs" accessibilityLiveRegion="polite" testID={`chat-comparison-status-${index}`}>
                  {t(`comparison.states.${variant.state}`)}
                </Text>
                <Text colorRole="secondary" className="text-xs">{t('comparison.parameters', {
                  temperature: variant.generation.temperature, seed: variant.generation.seed,
                })}</Text>
                <Text colorRole="primary" selectable testID={`chat-comparison-content-${index}`}>{variant.content || t('comparison.waiting')}</Text>
                {variant.generation.output && variant.generation.output.mode !== 'text' ? (
                  <Text colorRole="secondary" className="text-xs" accessibilityLiveRegion="polite">
                    {t(`comparison.validation.${variant.structuredOutput?.status ?? (terminal ? 'unavailable' : 'pending')}`)}
                  </Text>
                ) : null}
                {!terminal && comparison.running ? (
                  <Button size="sm" action="secondary" testID={`chat-comparison-stop-${index}`}
                    accessibilityLabel={t('comparison.stopVariant', { number: index + 1 })}
                    disabled={variant.state === 'cancelling'} onPress={() => onStop(index)}>
                    <ButtonText>{t('comparison.stop')}</ButtonText>
                  </Button>
                ) : null}
                <Button size="sm" testID={`chat-comparison-choose-${index}`}
                  accessibilityLabel={t('comparison.chooseVariant', { number: index + 1 })}
                  disabled={comparison.running || Boolean(comparison.errorCode) || !isComparisonVariantSelectable(variant)}
                  onPress={() => onChoose(index)}>
                  <ButtonText>{t('comparison.choose')}</ButtonText>
                </Button>
              </Box>
            );
          })}
        </Box>
      </ScrollView>
      {comparison.running ? <Text colorRole="secondary" className="text-xs">{t('comparison.drainHint')}</Text> : null}
    </Box>
  );
}
