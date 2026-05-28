import React, { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Box } from './box';
import { ModelDownloadProgress, ModelLifecycleActionRow } from './ModelLifecycleControls';
import { ScreenBadge, ScreenCard, ScreenIconButton } from './ScreenShell';
import { Text, composeTextRole } from './text';
import { ValueSelectorRow } from './ValueSelectorRow';
import { ModelAccessState, type ModelMetadata } from '../../types/models';
import { getModelVisionCapabilityBadgePresentation } from '../../utils/modelCapabilities';
import { getVariantMemoryBadgePresentation } from '../../utils/modelMemoryBadgePresentation';
import { formatModelFileSize } from '../../utils/modelSize';
import { canSelectModelVariant, getActiveModelVariant } from '../../utils/modelVariants';

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
  const activeVariant = getActiveModelVariant(model);
  const displaySize = activeVariant?.size ?? model.size;
  const sizeLabel = formatModelFileSize(displaySize, t('models.sizeUnknown'));
  const quantizationLabel = activeVariant?.quantizationLabel ?? model.gguf?.sizeLabel?.trim();
  const hasKnownFileSize = typeof displaySize === 'number' && Number.isFinite(displaySize) && displaySize > 0;
  const quantizationAndSize = quantizationLabel
    ? `${quantizationLabel} - ${sizeLabel}`
    : null;
  const memoryBadge = getVariantMemoryBadgePresentation(model, activeVariant, { useModelFallback: true });
  const memoryDecision = activeVariant?.ramFit ?? model.memoryFitDecision;
  const shouldShowStandaloneMemoryBadge = !quantizationAndSize && (
    memoryBadge.tone !== 'neutral'
    || (memoryDecision === 'unknown' && displaySize !== null)
  );
  const canOpenVariantSelector = typeof onOpenVariantSelector === 'function' && canSelectModelVariant(model);
  const visionBadge = getModelVisionCapabilityBadgePresentation(model);
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
      decorative="tint"
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
        {visionBadge ? (
          <ScreenBadge tone={visionBadge.tone} size="micro" iconName={visionBadge.iconName}>
            {t(visionBadge.labelKey)}
          </ScreenBadge>
        ) : null}
        {shouldShowStandaloneMemoryBadge ? (
          <ScreenBadge tone={memoryBadge.tone} size="micro" iconName={memoryBadge.iconName}>
            {t(memoryBadge.labelKey)}
          </ScreenBadge>
        ) : null}
        {displaySize === null && !quantizationAndSize ? (
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
          value={quantizationAndSize}
          badges={(
            <ScreenBadge tone={memoryBadge.tone} size="micro" iconName={memoryBadge.iconName}>
              {t(memoryBadge.labelKey)}
            </ScreenBadge>
          )}
          onPress={canOpenVariantSelector ? () => onOpenVariantSelector(model.id) : undefined}
          showChevron={canOpenVariantSelector}
          accessibilityLabel={t('models.variantSelectorAccessibilityLabel', {
            modelName: model.name,
            value: quantizationAndSize,
          })}
          accessibilityHint={canOpenVariantSelector
            ? t('models.variantSelectorAccessibilityHint')
            : t('models.variantSelectorReadOnlyAccessibilityHint')}
          testID={`model-variant-selector-${model.id}`}
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

function modelVariantsSignature(model: ModelMetadata): string {
  return (model.variants ?? [])
    .map((variant) => [
      variant.variantId,
      variant.fileName,
      variant.quantizationLabel,
      variant.size ?? 'unknown',
      variant.sha256 ?? '',
      variant.ramFit ?? '',
      variant.ramFitConfidence ?? '',
      variant.isLocal === true ? 'local' : 'remote',
      variant.chatModalities?.join(',') ?? '',
      variant.artifactRole ?? '',
      variant.visionSource ?? '',
      variant.visionConfidence ?? '',
      variant.projectorCandidates?.map((candidate) => candidate.id).join(',') ?? '',
      variant.selectedProjectorId ?? '',
    ].join('\u001f'))
    .join('\u001e');
}

function modelVisionSignature(model: ModelMetadata): string {
  return [
    model.chatModalities?.join(',') ?? '',
    model.artifactRole ?? '',
    model.visionSource ?? '',
    model.visionConfidence ?? '',
    model.projectorCandidates?.map((candidate) => [
      candidate.id,
      candidate.fileName,
      candidate.lifecycleStatus,
      candidate.matchStatus,
    ].join(':')).join(',') ?? '',
    model.selectedProjectorId ?? '',
  ].join('\u001f');
}

export const ModelCard = memo(ModelCardComponent, (prevProps, nextProps) => {
  // Custom comparison to ensure fast check since model is an object
  return prevProps.isActive === nextProps.isActive &&
         prevProps.onOpenDetails === nextProps.onOpenDetails &&
         prevProps.onDownload === nextProps.onDownload &&
         prevProps.onConfigureToken === nextProps.onConfigureToken &&
         prevProps.onOpenVariantSelector === nextProps.onOpenVariantSelector &&
         prevProps.onOpenModelPage === nextProps.onOpenModelPage &&
         prevProps.onLoad === nextProps.onLoad &&
         prevProps.onOpenSettings === nextProps.onOpenSettings &&
         prevProps.onUnload === nextProps.onUnload &&
         prevProps.onDelete === nextProps.onDelete &&
         prevProps.onCancel === nextProps.onCancel &&
         prevProps.onChat === nextProps.onChat &&
         prevProps.model.id === nextProps.model.id &&
         prevProps.model.name === nextProps.model.name &&
         prevProps.model.author === nextProps.model.author &&
         prevProps.model.downloadUrl === nextProps.model.downloadUrl &&
         prevProps.model.resolvedFileName === nextProps.model.resolvedFileName &&
         prevProps.model.sha256 === nextProps.model.sha256 &&
         prevProps.model.hfRevision === nextProps.model.hfRevision &&
         prevProps.model.requiresTreeProbe === nextProps.model.requiresTreeProbe &&
         prevProps.model.allowUnknownSizeDownload === nextProps.model.allowUnknownSizeDownload &&
         prevProps.model.lifecycleStatus === nextProps.model.lifecycleStatus &&
         prevProps.model.downloadProgress === nextProps.model.downloadProgress &&
         prevProps.model.downloadErrorAt === nextProps.model.downloadErrorAt &&
         prevProps.model.downloadErrorCode === nextProps.model.downloadErrorCode &&
         prevProps.model.downloadErrorMessage === nextProps.model.downloadErrorMessage &&
         prevProps.model.resumeData === nextProps.model.resumeData &&
         prevProps.model.localPath === nextProps.model.localPath &&
         prevProps.model.downloadedAt === nextProps.model.downloadedAt &&
         prevProps.model.fitsInRam === nextProps.model.fitsInRam &&
         prevProps.model.memoryFitDecision === nextProps.model.memoryFitDecision &&
         prevProps.model.memoryFitConfidence === nextProps.model.memoryFitConfidence &&
         prevProps.model.gguf?.sizeLabel === nextProps.model.gguf?.sizeLabel &&
         prevProps.model.gguf?.totalBytes === nextProps.model.gguf?.totalBytes &&
         prevProps.model.size === nextProps.model.size &&
         modelVariantsSignature(prevProps.model) === modelVariantsSignature(nextProps.model) &&
         modelVisionSignature(prevProps.model) === modelVisionSignature(nextProps.model) &&
         prevProps.model.activeVariantId === nextProps.model.activeVariantId &&
         prevProps.model.accessState === nextProps.model.accessState &&
         prevProps.model.isGated === nextProps.model.isGated &&
         prevProps.model.isPrivate === nextProps.model.isPrivate;
});

