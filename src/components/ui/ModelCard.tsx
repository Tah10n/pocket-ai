import React, { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Box } from './box';
import { ModelDownloadProgress, ModelLifecycleActionRow } from './ModelLifecycleControls';
import { ScreenBadge, ScreenCard, ScreenIconButton } from './ScreenShell';
import { Text, composeTextRole } from './text';
import { ValueSelectorRow } from './ValueSelectorRow';
import { ModelAccessState, type ModelMetadata } from '../../types/models';
import type { ProjectorArtifact } from '../../types/multimodal';
import { getModelVisionCapabilityBadgePresentation } from '../../utils/modelCapabilities';
import { getVariantMemoryBadgePresentation } from '../../utils/modelMemoryBadgePresentation';
import {
  formatModelFileSize,
  getModelDisplayArtifactSizeBytes,
  getModelDisplayProjectorCandidates,
  getModelDisplaySelectedProjectorId,
} from '../../utils/modelSize';
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
  const displaySize = getModelDisplayArtifactSizeBytes(model);
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
  const displayProjectorCandidates = getModelDisplayProjectorCandidates(model);
  const displaySelectedProjectorId = getModelDisplaySelectedProjectorId(model, displayProjectorCandidates);
  const visionBadge = getModelVisionCapabilityBadgePresentation(activeVariant
    ? {
        ...model,
        chatModalities: activeVariant.chatModalities ?? model.chatModalities,
        artifactRole: activeVariant.artifactRole ?? model.artifactRole,
        visionSource: activeVariant.visionSource ?? model.visionSource,
        visionConfidence: activeVariant.visionConfidence ?? model.visionConfidence,
        projectorCandidates: displayProjectorCandidates,
        selectedProjectorId: displaySelectedProjectorId,
      }
    : model);
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

type RuntimeProjectorArtifact = ProjectorArtifact & {
  downloadErrorAt?: number;
  downloadErrorCode?: string;
  downloadErrorMessage?: string;
};

function nullableFieldEqual<T>(prev: T | null | undefined, next: T | null | undefined): boolean {
  return (prev ?? null) === (next ?? null);
}

function unknownSizeFieldEqual(prev: number | null | undefined, next: number | null | undefined): boolean {
  return (prev ?? 'unknown') === (next ?? 'unknown');
}

function arrayFieldEqual<T>(
  prev: readonly T[] | null | undefined,
  next: readonly T[] | null | undefined,
  itemEqual: (prevItem: T, nextItem: T) => boolean,
): boolean {
  if (prev === next) {
    return true;
  }

  const prevItems = prev ?? [];
  const nextItems = next ?? [];
  if (prevItems.length !== nextItems.length) {
    return false;
  }

  return prevItems.every((prevItem, index) => itemEqual(prevItem, nextItems[index]));
}

function scalarArrayFieldEqual<T>(prev: readonly T[] | null | undefined, next: readonly T[] | null | undefined): boolean {
  return arrayFieldEqual(prev, next, (prevItem, nextItem) => prevItem === nextItem);
}

function projectorArtifactEqual(prev: ProjectorArtifact, next: ProjectorArtifact): boolean {
  if (prev === next) {
    return true;
  }

  const prevRuntime = prev as RuntimeProjectorArtifact;
  const nextRuntime = next as RuntimeProjectorArtifact;

  return prev.id === next.id &&
    prev.ownerModelId === next.ownerModelId &&
    nullableFieldEqual(prev.ownerVariantId, next.ownerVariantId) &&
    prev.repoId === next.repoId &&
    prev.fileName === next.fileName &&
    prev.downloadUrl === next.downloadUrl &&
    nullableFieldEqual(prev.hfRevision, next.hfRevision) &&
    nullableFieldEqual(prev.sha256, next.sha256) &&
    nullableFieldEqual(prev.localPath, next.localPath) &&
    unknownSizeFieldEqual(prev.size, next.size) &&
    prev.lifecycleStatus === next.lifecycleStatus &&
    nullableFieldEqual(prev.downloadProgress, next.downloadProgress) &&
    nullableFieldEqual(prevRuntime.downloadErrorAt, nextRuntime.downloadErrorAt) &&
    nullableFieldEqual(prevRuntime.downloadErrorCode, nextRuntime.downloadErrorCode) &&
    nullableFieldEqual(prevRuntime.downloadErrorMessage, nextRuntime.downloadErrorMessage) &&
    nullableFieldEqual(prev.resumeData, next.resumeData) &&
    prev.matchStatus === next.matchStatus &&
    nullableFieldEqual(prev.matchReason, next.matchReason);
}

function modelVariantsEqual(prevModel: ModelMetadata, nextModel: ModelMetadata): boolean {
  return arrayFieldEqual(prevModel.variants, nextModel.variants, (prevVariant, nextVariant) => (
    prevVariant.variantId === nextVariant.variantId &&
    prevVariant.fileName === nextVariant.fileName &&
    nullableFieldEqual(prevVariant.quantizationLabel, nextVariant.quantizationLabel) &&
    unknownSizeFieldEqual(prevVariant.size, nextVariant.size) &&
    nullableFieldEqual(prevVariant.sha256, nextVariant.sha256) &&
    nullableFieldEqual(prevVariant.ramFit, nextVariant.ramFit) &&
    nullableFieldEqual(prevVariant.ramFitConfidence, nextVariant.ramFitConfidence) &&
    (prevVariant.isLocal === true) === (nextVariant.isLocal === true) &&
    scalarArrayFieldEqual(prevVariant.chatModalities, nextVariant.chatModalities) &&
    nullableFieldEqual(prevVariant.artifactRole, nextVariant.artifactRole) &&
    nullableFieldEqual(prevVariant.visionSource, nextVariant.visionSource) &&
    nullableFieldEqual(prevVariant.visionConfidence, nextVariant.visionConfidence) &&
    arrayFieldEqual(prevVariant.projectorCandidates, nextVariant.projectorCandidates, projectorArtifactEqual) &&
    nullableFieldEqual(prevVariant.selectedProjectorId, nextVariant.selectedProjectorId)
  ));
}

function modelVisionFieldsEqual(prevModel: ModelMetadata, nextModel: ModelMetadata): boolean {
  return scalarArrayFieldEqual(prevModel.chatModalities, nextModel.chatModalities) &&
    nullableFieldEqual(prevModel.artifactRole, nextModel.artifactRole) &&
    nullableFieldEqual(prevModel.visionSource, nextModel.visionSource) &&
    nullableFieldEqual(prevModel.visionConfidence, nextModel.visionConfidence) &&
    arrayFieldEqual(prevModel.projectorCandidates, nextModel.projectorCandidates, projectorArtifactEqual) &&
    nullableFieldEqual(prevModel.selectedProjectorId, nextModel.selectedProjectorId);
}

function multimodalReadinessEqual(
  prev: ModelMetadata['multimodalReadiness'],
  next: ModelMetadata['multimodalReadiness'],
): boolean {
  if (prev === next) {
    return true;
  }

  if (!prev || !next) {
    return prev === next;
  }

  return prev.modelId === next.modelId &&
    nullableFieldEqual(prev.variantId, next.variantId) &&
    prev.status === next.status &&
    nullableFieldEqual(prev.projectorId, next.projectorId) &&
    nullableFieldEqual(prev.projectorSize, next.projectorSize) &&
    scalarArrayFieldEqual(prev.support, next.support) &&
    nullableFieldEqual(prev.failureReason, next.failureReason) &&
    prev.checkedAt === next.checkedAt;
}

export const ModelCard = memo(ModelCardComponent, (prevProps, nextProps) => {
  // Custom comparison to ensure fast check since model is an object
  const modelIdentityEqual = prevProps.model === nextProps.model;

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
         (modelIdentityEqual || (
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
           nullableFieldEqual(prevProps.model.resumeData, nextProps.model.resumeData) &&
           prevProps.model.localPath === nextProps.model.localPath &&
           prevProps.model.downloadedAt === nextProps.model.downloadedAt &&
           prevProps.model.fitsInRam === nextProps.model.fitsInRam &&
           prevProps.model.memoryFitDecision === nextProps.model.memoryFitDecision &&
           prevProps.model.memoryFitConfidence === nextProps.model.memoryFitConfidence &&
           prevProps.model.gguf?.sizeLabel === nextProps.model.gguf?.sizeLabel &&
           prevProps.model.gguf?.totalBytes === nextProps.model.gguf?.totalBytes &&
           prevProps.model.size === nextProps.model.size &&
           modelVariantsEqual(prevProps.model, nextProps.model) &&
           modelVisionFieldsEqual(prevProps.model, nextProps.model) &&
           multimodalReadinessEqual(prevProps.model.multimodalReadiness, nextProps.model.multimodalReadiness) &&
           prevProps.model.activeVariantId === nextProps.model.activeVariantId &&
           prevProps.model.accessState === nextProps.model.accessState &&
           prevProps.model.isGated === nextProps.model.isGated &&
           prevProps.model.isPrivate === nextProps.model.isPrivate
         ));
});

