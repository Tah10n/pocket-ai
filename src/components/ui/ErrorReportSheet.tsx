import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Modal, Platform, Share } from 'react-native';
import DeviceInfo from 'react-native-device-info';
import { useTranslation } from 'react-i18next';
import * as Clipboard from 'expo-clipboard';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { Input, InputField } from '@/components/ui/input';
import { Pressable } from '@/components/ui/pressable';
import { ScrollView } from '@/components/ui/scroll-view';
import { ScreenCard, ScreenIconButton, ScreenModalOverlay, ScreenSheet, ScreenStack } from '@/components/ui/ScreenShell';
import { Text } from '@/components/ui/text';
import { toAppError } from '@/services/AppError';
import type { ErrorReportContext } from '@/hooks/useErrorReportSheetController';
import { screenLayoutTokens } from '@/utils/themeTokens';

type DeviceReportData = {
  deviceModel: string;
  systemName: string;
  systemVersion: string;
  totalMemoryBytes: number | null;
  cpuArch: string[];
  isEmulator: boolean | null;
};

export interface ErrorReportSheetProps {
  visible: boolean;
  scope: string;
  error: unknown;
  context?: ErrorReportContext;
  onClose: () => void;
}

function safeJsonStringify(value: unknown, indent: number): string {
  const seen = new WeakSet<object>();

  return JSON.stringify(
    value,
    (_key, val) => {
      if (typeof val === 'bigint') {
        return val.toString();
      }

      if (val instanceof Error) {
        return {
          name: val.name,
          message: val.message,
          stack: val.stack,
        };
      }

      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) {
          return '[Circular]';
        }
        seen.add(val);
      }

      return val;
    },
    indent,
  );
}

function isNonEmptySection(section: unknown): section is Record<string, unknown> {
  if (!section || typeof section !== 'object') {
    return false;
  }

  return Object.keys(section as Record<string, unknown>).length > 0;
}

function getPlatformVersion(): string {
  try {
    const version = Platform.Version;
    return typeof version === 'string' ? version : String(version);
  } catch {
    return 'unknown';
  }
}

export function ErrorReportSheet({
  visible,
  scope,
  error,
  context,
  onClose,
}: ErrorReportSheetProps) {
  const { t } = useTranslation();
  const appError = useMemo(() => toAppError(error), [error]);

  const modelContext = context?.model;
  const engineContext = context?.engine;
  const optionsContext = context?.options;
  const extraContext = context?.extra;

  const hasModelContext = isNonEmptySection(modelContext);
  const hasEngineContext = isNonEmptySection(engineContext);
  const hasOptionsContext = isNonEmptySection(optionsContext);
  const hasExtraContext = isNonEmptySection(extraContext);
  const hasDiagnostics = isNonEmptySection(appError.details);

  const [includeModelInfo, setIncludeModelInfo] = useState(true);
  const [includeEngineInfo, setIncludeEngineInfo] = useState(true);
  const [includeOptionsInfo, setIncludeOptionsInfo] = useState(true);
  const [includeDeviceInfo, setIncludeDeviceInfo] = useState(true);
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);
  const [includeStackTrace, setIncludeStackTrace] = useState(true);
  const [additionalInfo, setAdditionalInfo] = useState('');
  const [deviceData, setDeviceData] = useState<DeviceReportData | null>(null);

  useEffect(() => {
    if (!visible) {
      return;
    }

    let cancelled = false;

    const fetchDeviceInfo = async () => {
      try {
        const [totalMemoryBytes, cpuArch, isEmulator] = await Promise.all([
          DeviceInfo.getTotalMemory().catch(() => null),
          DeviceInfo.supportedAbis().catch(() => [] as string[]),
          DeviceInfo.isEmulator().catch(() => null),
        ]);

        if (cancelled) {
          return;
        }

        setDeviceData({
          deviceModel: DeviceInfo.getModel(),
          systemName: Platform.OS === 'ios' ? 'iOS' : Platform.OS === 'android' ? 'Android' : Platform.OS,
          systemVersion: getPlatformVersion(),
          totalMemoryBytes,
          cpuArch,
          isEmulator,
        });
      } catch {
        if (!cancelled) {
          setDeviceData(null);
        }
      }
    };

    void fetchDeviceInfo();

    return () => {
      cancelled = true;
    };
  }, [visible]);

  const handleClose = useCallback(() => {
    setIncludeModelInfo(true);
    setIncludeEngineInfo(true);
    setIncludeOptionsInfo(true);
    setIncludeDeviceInfo(true);
    setIncludeDiagnostics(true);
    setIncludeStackTrace(true);
    setAdditionalInfo('');
    setDeviceData(null);
    onClose();
  }, [onClose]);

  const reportObject = useMemo(() => {
    if (!visible) {
      return null;
    }

    const trimmedAdditionalInfo = additionalInfo.trim();
    const buildNumber = (() => {
      try {
        return DeviceInfo.getBuildNumber();
      } catch {
        return undefined;
      }
    })();

    const appVersion = (() => {
      try {
        return DeviceInfo.getVersion();
      } catch {
        return undefined;
      }
    })();

    const report: Record<string, unknown> = {
      schemaVersion: 1,
      reportType: 'model-load-error',
      createdAt: new Date().toISOString(),
      scope,
      app: {
        version: appVersion,
        build: buildNumber,
      },
      platform: {
        os: Platform.OS,
        version: getPlatformVersion(),
      },
      error: {
        name: error instanceof Error ? error.name : undefined,
        code: appError.code,
        message: appError.message,
        stack: includeStackTrace && error instanceof Error ? error.stack : undefined,
      },
    };

    if (trimmedAdditionalInfo) {
      report.additionalInfo = trimmedAdditionalInfo;
    }

    if (includeModelInfo && hasModelContext) {
      report.model = modelContext;
    }

    if (includeEngineInfo && hasEngineContext) {
      report.engine = engineContext;
    }

    if (includeOptionsInfo && hasOptionsContext) {
      report.options = optionsContext;
    }

    if (hasExtraContext) {
      report.extra = extraContext;
    }

    if (includeDiagnostics && hasDiagnostics) {
      report.diagnostics = appError.details;
    }

    if (includeDeviceInfo && deviceData) {
      report.device = deviceData;
    }

    return report;
  }, [
    additionalInfo,
    appError.code,
    appError.details,
    appError.message,
    deviceData,
    error,
    hasDiagnostics,
    hasEngineContext,
    hasExtraContext,
    hasModelContext,
    hasOptionsContext,
    includeDeviceInfo,
    includeDiagnostics,
    includeEngineInfo,
    includeModelInfo,
    includeOptionsInfo,
    includeStackTrace,
    modelContext,
    engineContext,
    extraContext,
    optionsContext,
    scope,
    visible,
  ]);

  const reportJson = useMemo(() => {
    if (!reportObject) {
      return '';
    }

    try {
      return safeJsonStringify(reportObject, 2);
    } catch {
      return '{"error":"Failed to serialize report"}';
    }
  }, [reportObject]);

  const writeReportToFile = useCallback(async (json: string) => {
    const fileName = `pocket-ai-model-load-report-${Date.now().toString(16)}.json`;
    const file = new File(Paths.cache, fileName);
    file.create({ overwrite: true });
    file.write(json, { encoding: 'utf8' });
    return { fileName, fileUri: file.uri };
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      await Clipboard.setStringAsync(reportJson);
      Alert.alert(t('models.errorReport.copiedTitle'), t('models.errorReport.copiedMessage'));
    } catch {
      Alert.alert(t('models.errorReport.failedTitle'), t('models.errorReport.copyFailedMessage'));
    }
  }, [reportJson, t]);

  const handleShare = useCallback(async () => {
    try {
      let shared = false;

      try {
        const isAvailable = await Sharing.isAvailableAsync();
        if (isAvailable) {
          const { fileUri } = await writeReportToFile(reportJson);
          await Sharing.shareAsync(fileUri, { mimeType: 'application/json' });
          shared = true;
        }
      } catch {
        // fall back to Share API
      }

      if (!shared) {
        await Share.share({ message: reportJson });
      }
    } catch {
      Alert.alert(t('models.errorReport.failedTitle'), t('models.errorReport.shareFailedMessage'));
    }
  }, [reportJson, t, writeReportToFile]);

  const renderIncludeToggle = useCallback((params: {
    label: string;
    description: string;
    enabled: boolean;
    enabledLabel: string;
    disabledLabel: string;
    onChange: (next: boolean) => void;
    testIdPrefix: string;
    hidden?: boolean;
  }) => {
    if (params.hidden) {
      return null;
    }

    return (
      <ScreenCard>
        <Box className="flex-row items-start justify-between gap-3">
          <Box className="min-w-0 flex-1">
            <Text className="text-base font-semibold text-typography-900 dark:text-typography-100">
              {params.label}
            </Text>
            <Text className="mt-1 text-sm leading-5 text-typography-500 dark:text-typography-400">
              {params.description}
            </Text>
          </Box>
        </Box>

        <Box className="mt-4 flex-row gap-2">
          <Button
            testID={`${params.testIdPrefix}-off`}
            onPress={() => params.onChange(false)}
            action={!params.enabled ? 'softPrimary' : 'secondary'}
            size="sm"
            className="flex-1 rounded-2xl"
          >
            <ButtonText>{params.disabledLabel}</ButtonText>
          </Button>

          <Button
            testID={`${params.testIdPrefix}-on`}
            onPress={() => params.onChange(true)}
            action={params.enabled ? 'softPrimary' : 'secondary'}
            size="sm"
            className="flex-1 rounded-2xl"
          >
            <ButtonText>{params.enabledLabel}</ButtonText>
          </Button>
        </Box>
      </ScreenCard>
    );
  }, []);

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={handleClose}>
      <ScreenModalOverlay>
        <Pressable className="flex-1" onPress={handleClose} />
        <ScreenSheet className={screenLayoutTokens.sheetMaxHeightDefaultClassName}>
          <Box className="mb-5 flex-row items-start justify-between gap-4">
            <Box className="min-w-0 flex-1">
              <Text className="text-lg font-semibold text-typography-900 dark:text-typography-100">
                {t('models.errorReport.title')}
              </Text>
              <Text className="mt-1 text-sm leading-5 text-typography-500 dark:text-typography-400">
                {t('models.errorReport.subtitle')}
              </Text>
            </Box>

            <ScreenIconButton
              onPress={handleClose}
              accessibilityLabel={t('common.close')}
              iconName="close"
            />
          </Box>

          <ScrollView showsVerticalScrollIndicator={false}>
            <ScreenStack gap="default" className="pb-2">
              <ScreenCard tone="accent" variant="inset">
                <Text className="text-xs font-semibold uppercase tracking-wider text-primary-500">
                  {t('models.errorReport.privacyTitle')}
                </Text>
                <Text className="mt-2 text-sm leading-6 text-typography-600 dark:text-typography-300">
                  {t('models.errorReport.privacyMessage')}
                </Text>
              </ScreenCard>

              <ScreenCard>
                <Text className="text-xs font-semibold uppercase tracking-wider text-primary-500">
                  {t('models.errorReport.errorLabel')}
                </Text>
                <Text className="mt-2 text-sm leading-6 text-typography-700 dark:text-typography-200">
                  {appError.message}
                </Text>
              </ScreenCard>

              {renderIncludeToggle({
                label: t('models.errorReport.includeModelTitle'),
                description: t('models.errorReport.includeModelMessage'),
                enabled: includeModelInfo,
                enabledLabel: t('models.errorReport.includeOn'),
                disabledLabel: t('models.errorReport.includeOff'),
                onChange: setIncludeModelInfo,
                testIdPrefix: 'include-model',
                hidden: !hasModelContext,
              })}

              {renderIncludeToggle({
                label: t('models.errorReport.includeEngineTitle'),
                description: t('models.errorReport.includeEngineMessage'),
                enabled: includeEngineInfo,
                enabledLabel: t('models.errorReport.includeOn'),
                disabledLabel: t('models.errorReport.includeOff'),
                onChange: setIncludeEngineInfo,
                testIdPrefix: 'include-engine',
                hidden: !hasEngineContext,
              })}

              {renderIncludeToggle({
                label: t('models.errorReport.includeOptionsTitle'),
                description: t('models.errorReport.includeOptionsMessage'),
                enabled: includeOptionsInfo,
                enabledLabel: t('models.errorReport.includeOn'),
                disabledLabel: t('models.errorReport.includeOff'),
                onChange: setIncludeOptionsInfo,
                testIdPrefix: 'include-options',
                hidden: !hasOptionsContext,
              })}

              {renderIncludeToggle({
                label: t('models.errorReport.includeDeviceTitle'),
                description: t('models.errorReport.includeDeviceMessage'),
                enabled: includeDeviceInfo,
                enabledLabel: t('models.errorReport.includeOn'),
                disabledLabel: t('models.errorReport.includeOff'),
                onChange: setIncludeDeviceInfo,
                testIdPrefix: 'include-device',
              })}

              {renderIncludeToggle({
                label: t('models.errorReport.includeDiagnosticsTitle'),
                description: t('models.errorReport.includeDiagnosticsMessage'),
                enabled: includeDiagnostics,
                enabledLabel: t('models.errorReport.includeOn'),
                disabledLabel: t('models.errorReport.includeOff'),
                onChange: setIncludeDiagnostics,
                testIdPrefix: 'include-diagnostics',
                hidden: !hasDiagnostics,
              })}

              {renderIncludeToggle({
                label: t('models.errorReport.includeStackTitle'),
                description: t('models.errorReport.includeStackMessage'),
                enabled: includeStackTrace,
                enabledLabel: t('models.errorReport.includeOn'),
                disabledLabel: t('models.errorReport.includeOff'),
                onChange: setIncludeStackTrace,
                testIdPrefix: 'include-stack',
              })}

              <ScreenCard>
                <Text className="text-xs font-semibold uppercase tracking-wider text-primary-500">
                  {t('models.errorReport.additionalInfoTitle')}
                </Text>
                <Text className="mt-2 text-sm leading-6 text-typography-600 dark:text-typography-300">
                  {t('models.errorReport.additionalInfoMessage')}
                </Text>
                <Input className="mt-3">
                  <InputField
                    value={additionalInfo}
                    onChangeText={setAdditionalInfo}
                    multiline
                    numberOfLines={3}
                    placeholder={t('models.errorReport.additionalInfoPlaceholder')}
                    className="py-3 text-sm"
                    textAlignVertical="top"
                  />
                </Input>
              </ScreenCard>

              <ScreenCard variant="inset" className="bg-background-50/70 dark:bg-background-950/40">
                <Text className="text-xs font-semibold uppercase tracking-wider text-primary-500">
                  {t('models.errorReport.previewTitle')}
                </Text>
                <Text
                  selectable
                  className="mt-3 font-mono text-[11px] leading-5 text-typography-700 dark:text-typography-200"
                >
                  {reportJson}
                </Text>
              </ScreenCard>
            </ScreenStack>
          </ScrollView>

          <Box className="mt-5 flex-row gap-3">
            <Button action="secondary" onPress={handleClose} className="flex-1">
              <ButtonText>{t('common.close')}</ButtonText>
            </Button>
            <Button action="softPrimary" onPress={() => { void handleCopy(); }} className="flex-1">
              <ButtonText>{t('models.errorReport.copy')}</ButtonText>
            </Button>
            <Button onPress={() => { void handleShare(); }} className="flex-1">
              <ButtonText>{t('models.errorReport.share')}</ButtonText>
            </Button>
          </Box>
        </ScreenSheet>
      </ScreenModalOverlay>
    </Modal>
  );
}

