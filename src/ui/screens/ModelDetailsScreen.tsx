import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Linking } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { HeaderBar } from '@/components/ui/HeaderBar';
import { ScreenCard, ScreenContent, ScreenStack } from '@/components/ui/ScreenShell';
import { ScrollView } from '@/components/ui/scroll-view';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { getReportedErrorMessage } from '../../services/AppError';
import {
  getHuggingFaceModelUrl,
  getModelCatalogErrorMessage,
  modelCatalogService,
} from '../../services/ModelCatalogService';
import { LifecycleStatus, ModelAccessState, type ModelMetadata } from '../../types/models';

function formatBytes(value: number | null, unknownLabel: string): string {
  if (value === null) {
    return unknownLabel;
  }

  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatCount(value: number | null | undefined, fallback: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fallback;
  }

  return new Intl.NumberFormat().format(Math.round(value));
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <ScreenCard className="min-w-[120px] flex-1" padding="compact">
      <Text className="text-[10px] font-semibold uppercase tracking-wide text-typography-500 dark:text-typography-400">
        {label}
      </Text>
      <Text className="mt-2 text-sm font-semibold text-typography-900 dark:text-typography-100">
        {value}
      </Text>
    </ScreenCard>
  );
}

function createModelPlaceholder(modelId: string): ModelMetadata {
  return {
    id: modelId,
    name: modelId.split('/').pop() || modelId,
    author: modelId.split('/')[0] || 'unknown',
    size: null,
    downloadUrl: getHuggingFaceModelUrl(modelId),
    fitsInRam: null,
    accessState: ModelAccessState.PUBLIC,
    isGated: false,
    isPrivate: false,
    lifecycleStatus: LifecycleStatus.AVAILABLE,
    downloadProgress: 0,
  };
}

function InfoSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <ScreenCard>
      <Text className="text-sm font-semibold text-typography-900 dark:text-typography-100">
        {title}
      </Text>
      <Box className="mt-3">
        {children}
      </Box>
    </ScreenCard>
  );
}

export function ModelDetailsScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const params = useLocalSearchParams<{ modelId?: string }>();
  const modelId = typeof params.modelId === 'string' ? params.modelId : '';
  const missingModelMessage = t('models.detailMissingModel');
  const [model, setModel] = useState<ModelMetadata | null>(
    () => (modelId
      ? modelCatalogService.getCachedModel(modelId) ?? createModelPlaceholder(modelId)
      : null),
  );
  const [loading, setLoading] = useState(Boolean(modelId));
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (!modelId) {
      setLoading(false);
      setErrorMessage(missingModelMessage);
      return () => {
        cancelled = true;
      };
    }

    setLoading(true);
    setErrorMessage(null);

    void modelCatalogService.getModelDetails(modelId)
      .then((resolvedModel) => {
        if (cancelled) {
          return;
        }

        setModel(resolvedModel);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        setErrorMessage(getModelCatalogErrorMessage(error));
        setModel(modelCatalogService.getCachedModel(modelId));
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [missingModelMessage, modelId]);

  const accessStateLabel = useMemo(() => {
    if (!model) {
      return t('models.statusUnknown');
    }

    if (model.accessState === ModelAccessState.AUTH_REQUIRED) {
      return t('models.requiresToken');
    }

    if (model.accessState === ModelAccessState.ACCESS_DENIED) {
      return t('models.accessDenied');
    }

    if (model.accessState === ModelAccessState.AUTHORIZED) {
      return t('models.accessAuthorized');
    }

    return t('models.accessPublic');
  }, [model, t]);

  const ramStateLabel = useMemo(() => {
    if (!model) {
      return t('models.statusUnknown');
    }

    if (model.fitsInRam === true) {
      return t('models.ramFitYes');
    }

    if (model.fitsInRam === false) {
      return t('models.ramWarning');
    }

    return t('models.sizeUnknown');
  }, [model, t]);

  const metadataMetrics = useMemo(() => {
    if (!model) {
      return [];
    }

    return [
      { label: t('models.typeLabel'), value: model.modelType },
      { label: t('models.architecturesLabel'), value: model.architectures?.join(', ') },
      { label: t('models.baseModelsLabel'), value: model.baseModels?.join(', ') },
      { label: t('models.licenseLabel'), value: model.license },
      { label: t('models.languagesLabel'), value: model.languages?.join(', ') },
      { label: t('models.datasetsLabel'), value: model.datasets?.join(', ') },
      { label: t('models.quantizedByLabel'), value: model.quantizedBy },
      { label: t('models.modelCreatorLabel'), value: model.modelCreator },
    ].filter((item): item is { label: string; value: string } => (
      typeof item.value === 'string' && item.value.trim().length > 0
    ));
  }, [model, t]);

  const handleOpenModelPage = useCallback(async () => {
    if (!modelId) {
      return;
    }

    try {
      await Linking.openURL(getHuggingFaceModelUrl(modelId));
    } catch (error) {
      Alert.alert(
        t('models.actionFailedTitle'),
        getReportedErrorMessage('ModelDetailsScreen.handleOpenModelPage', error, t),
      );
    }
  }, [modelId, t]);

  const handleOpenTokenSettings = useCallback(() => {
    router.push('/huggingface-token' as any);
  }, [router]);

  const handleBack = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }

    router.replace('/(tabs)/models' as any);
  }, [router]);

  return (
    <Box className="flex-1 bg-background-0 dark:bg-background-950">
      <HeaderBar
        title={t('models.detailTitle')}
        subtitle={model?.id ?? modelId}
        onBack={handleBack}
        backAccessibilityLabel={t('chat.headerBackAccessibilityLabel')}
      />

      <ScrollView className="flex-1">
        <ScreenContent className="flex-1 pt-3">
          <ScreenStack>
            {loading && !model ? (
              <Box className="items-center justify-center pt-16">
                <Spinner size="large" />
                <Text className="mt-3 text-typography-500">{t('common.loading')}</Text>
              </Box>
            ) : null}

            {!loading && !model ? (
              <ScreenCard>
                <Text className="text-base font-semibold text-typography-900 dark:text-typography-100">
                  {t('models.detailUnavailable')}
                </Text>
                <Text className="mt-2 text-sm text-typography-500 dark:text-typography-400">
                  {errorMessage ?? t('models.detailMissingModel')}
                </Text>
                {modelId ? (
                  <Button action="secondary" className="mt-4 self-start" onPress={() => { void handleOpenModelPage(); }}>
                    <ButtonText className="text-typography-900 dark:text-typography-100">
                      {t('models.openOnHuggingFace')}
                    </ButtonText>
                  </Button>
                ) : null}
              </ScreenCard>
            ) : null}

            {model ? (
              <>
                {errorMessage ? (
                  <ScreenCard tone="warning">
                    <Text className="text-sm text-warning-700 dark:text-warning-300">{errorMessage}</Text>
                  </ScreenCard>
                ) : null}

                <ScreenCard>
                  <Text className="text-lg font-bold text-typography-900 dark:text-typography-100">
                    {model.name}
                  </Text>
                  <Text className="mt-1 text-sm text-typography-500 dark:text-typography-400">
                    {model.author}
                  </Text>

                  <Box className="mt-4 flex-row flex-wrap gap-2">
                    <MetricCard
                      label={t('models.sizeLabel')}
                      value={formatBytes(model.size, t('models.sizeUnknown'))}
                    />
                    <MetricCard
                      label={t('models.accessLabel')}
                      value={accessStateLabel}
                    />
                    <MetricCard
                      label={t('models.ramFitLabel')}
                      value={ramStateLabel}
                    />
                    <MetricCard
                      label={t('models.downloadsLabel')}
                      value={formatCount(model.downloads, t('models.metricUnavailable'))}
                    />
                    <MetricCard
                      label={t('models.likesLabel')}
                      value={formatCount(model.likes, t('models.metricUnavailable'))}
                    />
                  </Box>

                  <Box className="mt-4 flex-row flex-wrap gap-3">
                    {model.accessState === ModelAccessState.AUTH_REQUIRED ? (
                      <Button onPress={handleOpenTokenSettings}>
                        <ButtonText>{t('models.setToken')}</ButtonText>
                      </Button>
                    ) : null}
                    <Button action="secondary" onPress={() => { void handleOpenModelPage(); }}>
                      <ButtonText className="text-typography-900 dark:text-typography-100">
                        {t('models.openOnHuggingFace')}
                      </ButtonText>
                    </Button>
                  </Box>
                </ScreenCard>

                <InfoSection title={t('models.descriptionLabel')}>
                  <Text className="text-sm leading-6 text-typography-700 dark:text-typography-300">
                    {model.description ?? t('models.descriptionUnavailable')}
                  </Text>
                </InfoSection>

                {metadataMetrics.length > 0 ? (
                  <InfoSection title={t('models.metadataLabel')}>
                    <Box className="flex-row flex-wrap gap-3">
                      {metadataMetrics.map((item) => (
                        <MetricCard key={item.label} label={item.label} value={item.value} />
                      ))}
                    </Box>
                  </InfoSection>
                ) : null}

                <InfoSection title={t('models.tagsLabel')}>
                  {model.tags?.length ? (
                    <Box className="flex-row flex-wrap gap-2">
                      {model.tags.slice(0, 16).map((tag) => (
                        <Box
                          key={tag}
                          className="rounded-full border border-outline-200 bg-background-0 px-3 py-1.5 dark:border-outline-700 dark:bg-background-950"
                        >
                          <Text className="text-xs text-typography-700 dark:text-typography-300">{tag}</Text>
                        </Box>
                      ))}
                    </Box>
                  ) : (
                    <Text className="text-sm text-typography-500 dark:text-typography-400">
                      {t('models.tagsUnavailable')}
                    </Text>
                  )}
                </InfoSection>
              </>
            ) : null}
          </ScreenStack>
        </ScreenContent>
      </ScrollView>
    </Box>
  );
}
