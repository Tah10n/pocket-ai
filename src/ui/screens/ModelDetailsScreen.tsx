import React, { useCallback } from 'react';
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
import { ModelDownloadProgress, ModelLifecycleActionRow } from '@/components/ui/ModelLifecycleControls';
import { MaterialSymbols } from '@/components/ui/MaterialSymbols';
import { ModelParametersSheet } from '@/components/ui/ModelParametersSheet';
import { ScreenBadge, ScreenContent, ScreenStack } from '@/components/ui/ScreenShell';
import { ScrollView } from '@/components/ui/scroll-view';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { useModelDetailsController } from '@/hooks/useModelDetailsController';
import { LifecycleStatus, ModelAccessState } from '@/types/models';
import { getModelDetailsTagTone } from '@/utils/modelDetailsPresentation';

export function ModelDetailsScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const params = useLocalSearchParams<{ modelId?: string }>();
  const modelId = typeof params.modelId === 'string' ? params.modelId : '';
  const {
    accessBadge,
    cancelDownload,
    displayModel,
    errorMessage,
    handleChat,
    handleDelete,
    handleDownload,
    handleLoad,
    handleOpenModelPage,
    handleOpenTokenSettings,
    handleUnload,
    heroMetrics,
    loading,
    metadataMetrics,
    modelParametersSheetProps,
    openModelParameters,
  } = useModelDetailsController(modelId);

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

  return (
    <Box className="flex-1 bg-background-0 dark:bg-background-950">
      <HeaderBar
        title={t('models.detailTitle')}
        subtitle={displayModel?.id ?? modelId}
        onBack={handleBack}
        backAccessibilityLabel={t('chat.headerBackAccessibilityLabel')}
      />

      <ScrollView className="flex-1">
        <ScreenContent className="flex-1 pt-3">
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
                  <SectionCard className="border-warning-300/70 bg-warning-50/90 dark:border-warning-800 dark:bg-warning-950/35">
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
                      {displayModel.memoryFitDecision === 'fits_high_confidence'
                      || displayModel.memoryFitDecision === 'fits_low_confidence'
                      || (displayModel.memoryFitDecision === undefined && displayModel.fitsInRam === true) ? (
                        <ScreenBadge tone="success" size="micro" iconName="memory">
                          {t('models.ramFitYes')}
                        </ScreenBadge>
                      ) : null}
                      {displayModel.memoryFitDecision === 'likely_oom' ? (
                        <ScreenBadge tone="error" size="micro" iconName="warning">
                          {t('models.ramLikelyOom')}
                        </ScreenBadge>
                      ) : displayModel.memoryFitDecision === 'borderline' ? (
                          <ScreenBadge tone="warning" size="micro" iconName="warning">
                            {t('models.ramBorderline')}
                          </ScreenBadge>
                        ) : displayModel.memoryFitDecision === 'unknown' && displayModel.size !== null ? (
                          <ScreenBadge tone="neutral" size="micro" iconName="help">
                            {t('models.ramFitUnknown')}
                          </ScreenBadge>
                        ) : displayModel.memoryFitDecision === undefined && displayModel.fitsInRam === false ? (
                          <ScreenBadge tone="warning" size="micro" iconName="warning">
                            {t('models.ramWarning')}
                          </ScreenBadge>
                        ) : null}
                      {displayModel.memoryFitConfidence ? (
                        <ScreenBadge tone="neutral" size="micro">
                          {displayModel.memoryFitConfidence === 'high'
                            ? t('models.ramFitConfidenceHigh')
                            : displayModel.memoryFitConfidence === 'medium'
                              ? t('models.ramFitConfidenceMedium')
                              : t('models.ramFitConfidenceLow')}
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
                  progress={<ModelDownloadProgress model={displayModel} />}
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

      <ModelParametersSheet {...modelParametersSheetProps} />
    </Box>
  );
}
