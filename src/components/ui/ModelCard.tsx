import React, { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Box } from './box';
import { ModelDownloadProgress, ModelLifecycleActionRow } from './ModelLifecycleControls';
import { ScreenBadge, ScreenCard, ScreenIconButton } from './ScreenShell';
import { Text, composeTextRole } from './text';
import { ValueSelectorRow } from './ValueSelectorRow';
import { ModelAccessState, type ModelMetadata } from '../../types/models';
import { formatModelFileSize } from '../../utils/modelSize';

interface ModelCardProps {
  model: ModelMetadata;
  onOpenDetails: (modelId: string) => void;
  onDownload: (model: ModelMetadata) => void;
  onConfigureToken: () => void;
  onOpenVariantSelector?: (modelId: string) => void;
  onOpenModelPage: (modelId: string) => void;
  onLoad: (id: string) => void;
  onOpenSettings: (id: string) => void;
  onUnload: () => void;
  onDelete: (id: string) => void;
  onCancel: (id: string) => void;
  onChat: () => void;
  isActive: boolean;
}

const ModelCardComponent = ({
  model,
  onOpenDetails,
  onDownload,
  onConfigureToken,
  onOpenVariantSelector,
  onOpenModelPage,
  onLoad,
  onOpenSettings,
  onUnload,
  onDelete,
  onCancel,
  onChat,
  isActive,
}: ModelCardProps) => {
  const { t } = useTranslation();
  const sizeLabel = formatModelFileSize(model.size, t('models.sizeUnknown'));
  const memoryFitDecision = model.memoryFitDecision;
  const quantizationLabel = model.gguf?.sizeLabel?.trim();
  const hasKnownFileSize = typeof model.size === 'number' && Number.isFinite(model.size) && model.size > 0;
  const quantizationAndSize = quantizationLabel && hasKnownFileSize
    ? `${quantizationLabel} + ${sizeLabel}`
    : null;
  const canOpenVariantSelector = typeof onOpenVariantSelector === 'function' && (model.variants?.length ?? 0) > 1;
  const accessBadge = model.accessState === ModelAccessState.AUTH_REQUIRED
    ? {
        text: t('models.requiresToken'),
        tone: 'accent' as const,
      }
    : model.accessState === ModelAccessState.ACCESS_DENIED
      ? {
          text: t('models.accessDenied'),
          tone: 'error' as const,
        }
      : null;
  return (
    <ScreenCard
      className={isActive ? 'bg-primary-500/5 dark:bg-primary-500/10' : ''}
      padding="compact"
      tone={isActive ? 'accent' : 'default'}
    >
      <Box className="flex-row items-start justify-between gap-2.5">
        <Box className="min-w-0 flex-1">
          <Box className="flex-row flex-wrap items-start gap-2">
            <Text numberOfLines={2} className={composeTextRole('sectionTitle', 'flex-1 text-base tracking-tight')}>
              {model.name}
            </Text>
            {isActive ? (
              <ScreenBadge tone="success" size="micro">
                {t('common.active')}
              </ScreenBadge>
            ) : null}
          </Box>
          <Text numberOfLines={1} className={composeTextRole('caption', 'mt-0.5')}>
            {model.author}
          </Text>
        </Box>

        <ScreenIconButton
          testID={`model-details-${model.id}`}
          onPress={() => onOpenDetails(model.id)}
          accessibilityLabel={t('models.details')}
          iconName="open-in-new"
          size="compact"
        />
      </Box>

      <Box className="mt-2 flex-row flex-wrap gap-1.5">
        {accessBadge ? (
          <ScreenBadge tone={accessBadge.tone} size="micro">
            {accessBadge.text}
          </ScreenBadge>
        ) : null}
        {memoryFitDecision === 'likely_oom' ? (
          <ScreenBadge tone="error" size="micro" iconName="warning">
            {t('models.ramLikelyOom')}
          </ScreenBadge>
        ) : memoryFitDecision === 'borderline' ? (
          <ScreenBadge tone="warning" size="micro" iconName="warning">
            {t('models.ramBorderline')}
          </ScreenBadge>
        ) : memoryFitDecision === 'unknown' && model.size !== null ? (
          <ScreenBadge tone="neutral" size="micro" iconName="help">
            {t('models.ramFitUnknown')}
          </ScreenBadge>
        ) : memoryFitDecision === undefined && model.fitsInRam === false ? (
          <ScreenBadge tone="warning" size="micro" iconName="warning">
            {t('models.ramWarning')}
          </ScreenBadge>
        ) : null}
        {model.size === null ? (
          <ScreenBadge tone="warning" size="micro" iconName="help">
            {t('models.sizeUnknownBadge')}
          </ScreenBadge>
        ) : !quantizationLabel && hasKnownFileSize ? (
          <ScreenBadge tone="neutral" size="micro">
            {t('models.sizeLabel')} {sizeLabel}
          </ScreenBadge>
        ) : null}
      </Box>

      {quantizationAndSize ? (
        <ValueSelectorRow
          label={t('models.quantizationLabel')}
          value={quantizationAndSize}
          onPress={canOpenVariantSelector ? () => onOpenVariantSelector(model.id) : undefined}
          showChevron={canOpenVariantSelector}
          className="mt-2.5"
        />
      ) : null}

      <ModelDownloadProgress model={model} density="compact" className="mt-2.5" />

      <ModelLifecycleActionRow
        model={model}
        onDownload={onDownload}
        onConfigureToken={onConfigureToken}
        onOpenModelPage={onOpenModelPage}
        onLoad={onLoad}
        onOpenSettings={onOpenSettings}
        onUnload={onUnload}
        onDelete={onDelete}
        onCancel={onCancel}
        onChat={onChat}
        className="mt-3 flex-row items-center gap-2"
        pillClassName="min-w-0 basis-0 flex-1"
      />
    </ScreenCard>
  );
};

ModelCardComponent.displayName = 'ModelCard';

export const ModelCard = memo(ModelCardComponent, (prevProps, nextProps) => {
  // Custom comparison to ensure fast check since model is an object
  return prevProps.isActive === nextProps.isActive &&
         prevProps.onOpenVariantSelector === nextProps.onOpenVariantSelector &&
         prevProps.model.id === nextProps.model.id &&
         prevProps.model.name === nextProps.model.name &&
         prevProps.model.author === nextProps.model.author &&
         prevProps.model.lifecycleStatus === nextProps.model.lifecycleStatus &&
         prevProps.model.downloadProgress === nextProps.model.downloadProgress &&
         prevProps.model.fitsInRam === nextProps.model.fitsInRam &&
         prevProps.model.memoryFitDecision === nextProps.model.memoryFitDecision &&
         prevProps.model.memoryFitConfidence === nextProps.model.memoryFitConfidence &&
         prevProps.model.gguf?.sizeLabel === nextProps.model.gguf?.sizeLabel &&
         prevProps.model.size === nextProps.model.size &&
         (prevProps.model.variants?.length ?? 0) === (nextProps.model.variants?.length ?? 0) &&
         prevProps.model.activeVariantId === nextProps.model.activeVariantId &&
         prevProps.model.accessState === nextProps.model.accessState;
});

