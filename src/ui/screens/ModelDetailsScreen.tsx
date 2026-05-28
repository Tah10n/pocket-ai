import React, { useCallback, useMemo, useRef, useState } from 'react';
import type { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import {
  DetailValueCard,
  ModelDetailsHeroCard,
  ModelDetailsMetadataSection,
  ModelDetailsTagsSection,
  ModelDetailsUnavailableState,
  SectionCard,
} from '@/components/model-details';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { HeaderBar } from '@/components/ui/HeaderBar';
import {
  isModelDownloading,
  ModelDownloadProgress,
  ModelLifecycleActionRow,
  ModelProjectorStatus,
} from '@/components/ui/ModelLifecycleControls';
import { MaterialSymbols } from '@/components/ui/MaterialSymbols';
import { ErrorReportSheet } from '@/components/ui/ErrorReportSheet';
import { ModelVariantPickerSheet } from '@/components/ui/ModelVariantPickerSheet';
import { ProjectorChoiceSheet } from '@/components/ui/ProjectorChoiceSheet';
import { MODEL_WARMUP_BANNER_RESERVED_HEIGHT, ModelWarmupBanner } from '@/components/ui/ModelWarmupBanner';
import { ModelParametersSheet } from '@/components/ui/ModelParametersSheet';
import { ScreenAndroidContentBlurTarget, ScreenBadge, ScreenCard, ScreenContent, ScreenRoot, ScreenStack } from '@/components/ui/ScreenShell';
import { ScrollView } from '@/components/ui/scroll-view';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { ValueSelectorRow } from '@/components/ui/ValueSelectorRow';
import { useModelDetailsController } from '@/hooks/useModelDetailsController';
import { EngineStatus, LifecycleStatus, ModelAccessState } from '@/types/models';
import { getModelVisionCapabilityBadgePresentation } from '@/utils/modelCapabilities';
import { getVariantMemoryBadgePresentation } from '@/utils/modelMemoryBadgePresentation';
import { formatModelFileSize } from '@/utils/modelSize';
import { getModelDetailsTagTone } from '@/utils/modelDetailsPresentation';
import { canSelectModelVariant, getActiveModelVariant } from '@/utils/modelVariants';
import { selectModelProjectorLifecycleState } from '@/store/modelsStore';

export function ModelDetailsScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const params = useLocalSearchParams<{ modelId?: string; variantId?: string }>();
  const modelId = typeof params.modelId === 'string' ? params.modelId : '';
  const variantId = typeof params.variantId === 'string' ? params.variantId : undefined;
  const {
    accessBadge,
    cancelDownload,
    displayModel,
    engineState,
    errorReportSheetProps,
    errorMessage,
    dismissEngineError,
    handleChat,
    handleDelete,
    handleDownload,
    handleLoad,
    handleOpenModelPage,
    handleOpenTokenSettings,
    handleSelectProjector,
    handleSelectVariant,
    handleUnload,
    heroMetrics,
    isProjectorChoiceVisible,
    loading,
    metadataMetrics,
    modelParametersSheetProps,
    openModelParameters,
    openProjectorChoice,
    projectorChoiceModel,
    closeProjectorChoice,
    reportEngineError,
  } = useModelDetailsController(modelId, variantId);
  const warmupContentBlurTargetRef = useRef<View | null>(null);
  const [isVariantPickerVisible, setVariantPickerVisible] = useState(false);

  const handleBack = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }

    router.replace('/(tabs)/models');
  }, [router]);

  const openOnHuggingFaceButton = modelId ? (
    <Button action="softPrimary" onPress={() => { void handleOpenModelPage(modelId); }}>
      <MaterialSymbols name="open-in-new" size={18} className="text-primary-600 dark:text-primary-300" />
      <ButtonText className="text-primary-600 dark:text-primary-300">
        {t('models.openOnHuggingFace')}
      </ButtonText>
    </Button>
  ) : null;

  const metadataItems = metadataMetrics.map((item) => ({
    ...item,
    tone: 'neutral' as const,
    compact: true,
  }));

  const tagChips = displayModel?.tags?.slice(0, 16).map((tag) => ({
    key: tag,
    label: tag,
    tone: getModelDetailsTagTone(tag, displayModel.datasets),
    size: 'default' as const,
    className: 'max-w-full',
  })) ?? [];
  const activeVariant = displayModel ? getActiveModelVariant(displayModel) : undefined;
  const detailsMemoryBadge = displayModel
    ? getVariantMemoryBadgePresentation(displayModel, activeVariant, { useModelFallback: true })
    : null;
  const detailsMemoryDecision = activeVariant?.ramFit ?? displayModel?.memoryFitDecision;
  const detailsDisplaySize = activeVariant?.size ?? displayModel?.size ?? null;
  const shouldShowDetailsMemoryBadge = detailsMemoryBadge !== null && (
    detailsMemoryBadge.tone !== 'neutral'
    || (detailsMemoryDecision === 'unknown' && detailsDisplaySize !== null)
  );
  const detailsQuantizationLabel = activeVariant?.quantizationLabel ?? displayModel?.gguf?.sizeLabel?.trim();
  const variantSelectorValue = useMemo(() => {
    if (!detailsQuantizationLabel) {
      return null;
    }

    return `${detailsQuantizationLabel} - ${formatModelFileSize(detailsDisplaySize, t('models.sizeUnknown'))}`;
  }, [detailsDisplaySize, detailsQuantizationLabel, t]);
  const shouldShowStandaloneDetailsMemoryBadge = !variantSelectorValue && shouldShowDetailsMemoryBadge;
  const detailsVisionBadge = displayModel ? getModelVisionCapabilityBadgePresentation(displayModel) : null;
  const detailsProjectorLifecycle = displayModel ? selectModelProjectorLifecycleState(displayModel) : null;
  const shouldShowProjectorStatus = detailsProjectorLifecycle !== null && detailsProjectorLifecycle.status !== 'text_only';
  const shouldShowDownloadProgress = Boolean(displayModel && (
    isModelDownloading(displayModel)
    || displayModel.lifecycleStatus === LifecycleStatus.PAUSED
    || displayModel.lifecycleStatus === LifecycleStatus.FAILED
  ));
  const canOpenVariantPicker = displayModel ? canSelectModelVariant(displayModel) : false;
  const closeVariantPicker = useCallback(() => {
    setVariantPickerVisible(false);
  }, []);
  const selectVariant = useCallback((variantId: string) => {
    if (!displayModel || !canOpenVariantPicker) {
      setVariantPickerVisible(false);
      return;
    }

    handleSelectVariant(variantId);
    router.setParams({ modelId, variantId });
    setVariantPickerVisible(false);
  }, [canOpenVariantPicker, displayModel, handleSelectVariant, modelId, router]);

  return (
    <ScreenRoot>
      <ScreenAndroidContentBlurTarget
        blurTargetRef={warmupContentBlurTargetRef}
        style={{ flex: 1 }}
        testID="model-details-warmup-content-blur-target"
      >
        <HeaderBar
          title={t('models.detailTitle')}
          subtitle={displayModel?.id ?? modelId}
          onBack={handleBack}
          backAccessibilityLabel={t('chat.headerBackAccessibilityLabel')}
        />

        {engineState.status === EngineStatus.ERROR && engineState.lastError ? (
          <ScreenContent className="pt-3 pb-0">
            <ScreenCard padding="compact" tone="error">
              <Text className="text-sm font-semibold text-error-700 dark:text-error-300">
                {t('common.errors.modelLoadFailed')}
              </Text>
              <Text selectable className="mt-1 text-sm text-error-700 dark:text-error-300">
                {engineState.lastError}
              </Text>
              <Box className="mt-3 flex-row gap-2">
                <Button action="secondary" size="sm" onPress={dismissEngineError} className="flex-1">
                  <ButtonText>{t('common.close')}</ButtonText>
                </Button>
                <Button action="softPrimary" size="sm" onPress={reportEngineError} className="flex-1">
                  <ButtonText>{t('models.errorReport.reportButton')}</ButtonText>
                </Button>
              </Box>
            </ScreenCard>
          </ScreenContent>
        ) : null}

        <ScrollView className="flex-1">
          <ScreenContent
            className="flex-1 pt-3"
            extraBottomInset={engineState.status === EngineStatus.INITIALIZING ? MODEL_WARMUP_BANNER_RESERVED_HEIGHT : 0}
            includeBottomSafeArea
          >
            <ScreenStack gap="loose">
            {loading && !displayModel ? (
              <Box className="items-center justify-center pt-16">
                <Spinner size="large" />
                <Text className="mt-3 text-typography-500">{t('common.loading')}</Text>
              </Box>
            ) : null}

            {!loading && !displayModel ? (
              <ModelDetailsUnavailableState
                title={t('models.detailUnavailable')}
                message={errorMessage ?? t('models.detailMissingModel')}
                openOnHuggingFaceButton={openOnHuggingFaceButton ?? undefined}
              />
            ) : null}

            {displayModel ? (
              <>
                {errorMessage ? (
                  <SectionCard tone="warning">
                    <Text className="text-sm leading-6 text-warning-700 dark:text-warning-300">{errorMessage}</Text>
                  </SectionCard>
                ) : null}

                <ModelDetailsHeroCard
                  badges={(
                    <>
                      <ScreenBadge tone={accessBadge.tone} size="micro" iconName={accessBadge.iconName}>
                        {accessBadge.label}
                      </ScreenBadge>
                      {displayModel.lifecycleStatus === LifecycleStatus.ACTIVE ? (
                        <ScreenBadge tone="success" size="micro">
                          {t('common.active')}
                        </ScreenBadge>
                      ) : null}
                      {detailsVisionBadge ? (
                        <ScreenBadge tone={detailsVisionBadge.tone} size="micro" iconName={detailsVisionBadge.iconName}>
                          {t(detailsVisionBadge.labelKey)}
                        </ScreenBadge>
                      ) : null}
                      {shouldShowStandaloneDetailsMemoryBadge && detailsMemoryBadge ? (
                        <ScreenBadge tone={detailsMemoryBadge.tone} size="micro" iconName={detailsMemoryBadge.iconName}>
                          {t(detailsMemoryBadge.labelKey)}
                        </ScreenBadge>
                      ) : null}
                    </>
                  )}
                  title={displayModel.name}
                  modelId={displayModel.id}
                  actions={(
                    <ModelLifecycleActionRow
                      model={displayModel}
                      onDownload={handleDownload}
                      onConfigureToken={handleOpenTokenSettings}
                      onOpenModelPage={(id) => {
                        void handleOpenModelPage(id);
                      }}
                      onLoad={() => { void handleLoad(); }}
                      onOpenSettings={() => { openModelParameters(displayModel.id); }}
                      onUnload={() => { void handleUnload(); }}
                      onDelete={() => { handleDelete(); }}
                      onCancel={cancelDownload}
                      onChat={handleChat}
                      className="flex-row flex-wrap items-center gap-2"
                      pillClassName="min-w-[124px] flex-1"
                    />
                  )}
                  progress={shouldShowProjectorStatus || shouldShowDownloadProgress ? (
                    <Box className="gap-3">
                      {shouldShowProjectorStatus ? (
                        <ModelProjectorStatus model={displayModel} onChooseProjector={openProjectorChoice} />
                      ) : null}
                      {shouldShowDownloadProgress ? <ModelDownloadProgress model={displayModel} /> : null}
                    </Box>
                  ) : undefined}
                  variantSelector={variantSelectorValue ? (
                    <ValueSelectorRow
                      value={variantSelectorValue}
                      badges={detailsMemoryBadge ? (
                        <ScreenBadge
                          tone={detailsMemoryBadge.tone}
                          size="micro"
                          iconName={detailsMemoryBadge.iconName}
                        >
                          {t(detailsMemoryBadge.labelKey)}
                        </ScreenBadge>
                      ) : undefined}
                      onPress={canOpenVariantPicker ? () => setVariantPickerVisible(true) : undefined}
                      showChevron={canOpenVariantPicker}
                      accessibilityLabel={t('models.variantSelectorAccessibilityLabel', {
                        modelName: displayModel.name,
                        value: variantSelectorValue,
                      })}
                      accessibilityHint={canOpenVariantPicker
                        ? t('models.variantSelectorAccessibilityHint')
                        : t('models.variantSelectorReadOnlyAccessibilityHint')}
                      testID={`model-details-variant-selector-${displayModel.id}`}
                    />
                  ) : undefined}
                  openOnHuggingFaceButton={!(
                    displayModel.lifecycleStatus === LifecycleStatus.AVAILABLE
                    && displayModel.accessState === ModelAccessState.ACCESS_DENIED
                  ) ? (openOnHuggingFaceButton ?? undefined) : undefined}
                />

                <Box className="flex-row flex-wrap gap-3">
                  {heroMetrics.map((item) => (
                    <DetailValueCard
                      key={item.label}
                      label={item.label}
                      value={item.value}
                      iconName={item.iconName}
                      tone={item.tone}
                    />
                  ))}
                </Box>

                <SectionCard
                  title={t('models.descriptionLabel')}
                  iconName="description"
                  tone="info"
                >
                  <Text className="text-sm leading-7 text-typography-700 dark:text-typography-300">
                    {displayModel.description ?? t('models.descriptionUnavailable')}
                  </Text>
                </SectionCard>

                <ModelDetailsMetadataSection
                  items={metadataItems}
                  title={t('models.metadataLabel')}
                  iconName="hub"
                  tone="primary"
                />

                <ModelDetailsTagsSection
                  chips={tagChips}
                  emptyLabel={t('models.tagsUnavailable')}
                  title={t('models.tagsLabel')}
                  iconName="sell"
                  tone="success"
                />
              </>
            ) : null}
            </ScreenStack>
          </ScreenContent>
        </ScrollView>
      </ScreenAndroidContentBlurTarget>

      <ModelWarmupBanner androidContentBlurTargetRef={warmupContentBlurTargetRef} engineState={engineState} />
      <ModelParametersSheet
        {...modelParametersSheetProps}
        androidContentBlurTargetRef={warmupContentBlurTargetRef}
      />
      <ModelVariantPickerSheet
        visible={isVariantPickerVisible}
        model={displayModel}
        androidContentBlurTargetRef={warmupContentBlurTargetRef}
        onSelectVariant={selectVariant}
        onClose={closeVariantPicker}
      />
      <ProjectorChoiceSheet
        visible={isProjectorChoiceVisible}
        model={projectorChoiceModel ?? displayModel}
        androidContentBlurTargetRef={warmupContentBlurTargetRef}
        onSelectProjector={handleSelectProjector}
        onClose={closeProjectorChoice}
      />
      <ErrorReportSheet
        {...errorReportSheetProps}
        androidContentBlurTargetRef={warmupContentBlurTargetRef}
      />
    </ScreenRoot>
  );
}
