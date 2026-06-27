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
import {
  sanitizeErrorForReport,
  sanitizeErrorReportContext,
  sanitizeErrorReportObjectKey,
  sanitizeErrorReportString,
  sanitizeModelErrorReportContext,
} from '@/services/ErrorReportSanitizer';
import type { ErrorReportContext } from '@/hooks/useErrorReportSheetController';
import type { AndroidBlurTargetRef } from '@/utils/androidBlur';
import { screenLayoutTokens } from '@/utils/themeTokens';

type DeviceReportData = {
  deviceModel: string;
  systemName: string;
  systemVersion: string;
  totalMemoryBytes: number | null;
  cpuArch: string[];
  isEmulator: boolean | null;
};

type DeletableReportFile = File & {
  delete?: () => void | Promise<void>;
};

const REPORT_PREVIEW_TEXT_LIMIT = 240;
const REPORT_PREVIEW_KEY_LIMIT = 12;
const REPORT_PREVIEW_ADDITIONAL_INFO_SANITIZE_LIMIT = 4096;
const REPORT_SHARE_CACHE_CLEANUP_DELAY_MS = 5 * 60 * 1_000;

export interface ErrorReportSheetProps {
  visible: boolean;
  scope: string;
  error: unknown;
  context?: ErrorReportContext;
  androidContentBlurTargetRef?: AndroidBlurTargetRef | null;
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
        const sanitizedError = sanitizeErrorForReport(val, { includeStack: true });
        return {
          name: sanitizedError.name,
          message: sanitizedError.message,
          stack: sanitizedError.stack,
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

  for (const key in section as Record<string, unknown>) {
    if (Object.prototype.hasOwnProperty.call(section, key)) {
      return true;
    }
  }

  return false;
}

function truncatePreviewText(value: string): string {
  return value.length > REPORT_PREVIEW_TEXT_LIMIT
    ? `${value.slice(0, REPORT_PREVIEW_TEXT_LIMIT)}…`
    : value;
}

function buildSanitizedAdditionalInfoPreview(value: string): string | undefined {
  // Keep preview work bounded on the render path. Copy/share still sanitizes the full text.
  const previewSource = value
    .slice(0, REPORT_PREVIEW_ADDITIONAL_INFO_SANITIZE_LIMIT)
    .trim();
  if (!previewSource) {
    return undefined;
  }

  const sanitizedValue = sanitizeErrorReportString(previewSource);
  if (!sanitizedValue) {
    return undefined;
  }

  const preview = truncatePreviewText(sanitizedValue);
  return value.length > REPORT_PREVIEW_ADDITIONAL_INFO_SANITIZE_LIMIT && !preview.endsWith('…')
    ? `${preview}…`
    : preview;
}

function previewSectionKeys(section: unknown): string[] | undefined {
  if (!section || typeof section !== 'object') {
    return undefined;
  }

  const keys: string[] = [];
  let ownKeyCount = 0;
  for (const key in section as Record<string, unknown>) {
    if (!Object.prototype.hasOwnProperty.call(section, key)) {
      continue;
    }

    ownKeyCount += 1;
    if (keys.length < REPORT_PREVIEW_KEY_LIMIT) {
      keys.push(sanitizeErrorReportObjectKey(key));
      continue;
    }

    keys.push('…');
    break;
  }

  return ownKeyCount > 0 ? keys : undefined;
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
  androidContentBlurTargetRef,
  onClose,
}: ErrorReportSheetProps) {
  const { t } = useTranslation();
  const appError = useMemo(() => toAppError(error), [error]);
  const sanitizedAppError = useMemo(() => sanitizeErrorForReport(appError, { includeStack: false }), [appError]);

  const modelContext = useMemo(() => sanitizeModelErrorReportContext(context?.model), [context?.model]);
  const engineContext = useMemo(() => sanitizeErrorReportContext(context?.engine), [context?.engine]);
  const optionsContext = useMemo(() => sanitizeErrorReportContext(context?.options), [context?.options]);
  const extraContext = useMemo(() => sanitizeErrorReportContext(context?.extra), [context?.extra]);

  const hasModelContext = isNonEmptySection(modelContext);
  const hasEngineContext = isNonEmptySection(engineContext);
  const hasOptionsContext = isNonEmptySection(optionsContext);
  const hasExtraContext = isNonEmptySection(extraContext);
  const hasDiagnostics = isNonEmptySection(sanitizedAppError.details);

  const [includeModelInfo, setIncludeModelInfo] = useState(true);
  const [includeEngineInfo, setIncludeEngineInfo] = useState(true);
  const [includeOptionsInfo, setIncludeOptionsInfo] = useState(true);
  const [includeDeviceInfo, setIncludeDeviceInfo] = useState(false);
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
    setIncludeDeviceInfo(false);
    setIncludeDiagnostics(true);
    setIncludeStackTrace(true);
    setAdditionalInfo('');
    setDeviceData(null);
    onClose();
  }, [onClose]);

  const reportBaseObject = useMemo(() => {
    if (!visible) {
      return null;
    }

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
        name: error instanceof Error ? sanitizeErrorReportString(error.name) : sanitizedAppError.name,
        code: appError.code,
        message: sanitizedAppError.message,
        stack: includeStackTrace && error instanceof Error && typeof error.stack === 'string'
          ? sanitizeErrorReportString(error.stack)
          : undefined,
      },
    };

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
      report.diagnostics = sanitizedAppError.details;
    }

    if (includeDeviceInfo && deviceData) {
      report.device = deviceData;
    }

    return report;
  }, [
    appError.code,
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
    sanitizedAppError.details,
    sanitizedAppError.message,
    sanitizedAppError.name,
    scope,
    visible,
  ]);

  const buildReportObject = useCallback(() => {
    if (!reportBaseObject) {
      return null;
    }

    const report: Record<string, unknown> = { ...reportBaseObject };
    const trimmedAdditionalInfo = additionalInfo.trim();
    if (trimmedAdditionalInfo) {
      report.additionalInfo = sanitizeErrorReportString(trimmedAdditionalInfo);
    }

    return report;
  }, [additionalInfo, reportBaseObject]);

  const reportPreviewJson = useMemo(() => {
    if (!reportBaseObject) {
      return '';
    }

    const sanitizedAdditionalInfoPreview = buildSanitizedAdditionalInfoPreview(additionalInfo);
    const preview = {
      schemaVersion: reportBaseObject.schemaVersion,
      reportType: reportBaseObject.reportType,
      scope: reportBaseObject.scope,
      error: {
        name: sanitizedAppError.name,
        code: appError.code,
        message: truncatePreviewText(sanitizedAppError.message),
        stackIncluded: includeStackTrace && error instanceof Error && typeof error.stack === 'string',
      },
      includedSections: {
        model: includeModelInfo && hasModelContext,
        engine: includeEngineInfo && hasEngineContext,
        options: includeOptionsInfo && hasOptionsContext,
        extra: hasExtraContext,
        diagnostics: includeDiagnostics && hasDiagnostics,
        device: includeDeviceInfo && Boolean(deviceData),
      },
      sectionKeys: {
        model: includeModelInfo ? previewSectionKeys(modelContext) : undefined,
        engine: includeEngineInfo ? previewSectionKeys(engineContext) : undefined,
        options: includeOptionsInfo ? previewSectionKeys(optionsContext) : undefined,
        extra: previewSectionKeys(extraContext),
        diagnostics: includeDiagnostics ? previewSectionKeys(sanitizedAppError.details) : undefined,
      },
      additionalInfoPreview: sanitizedAdditionalInfoPreview,
    };

    try {
      return safeJsonStringify(preview, 2);
    } catch {
      return JSON.stringify({ error: t('models.errorReport.previewSerializeFailed') })
        ?? '{"error":"models.errorReport.previewSerializeFailed"}';
    }
  }, [
    additionalInfo,
    appError.code,
    deviceData,
    engineContext,
    error,
    extraContext,
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
    optionsContext,
    reportBaseObject,
    sanitizedAppError.details,
    sanitizedAppError.message,
    sanitizedAppError.name,
    t,
  ]);

  const buildReportJson = useCallback(() => {
    const reportObject = buildReportObject();
    if (!reportObject) {
      return '';
    }

    try {
      return safeJsonStringify(reportObject, 2);
    } catch {
      return '{"error":"Failed to serialize report"}';
    }
  }, [buildReportObject]);

  const writeReportToFile = useCallback(async (json: string) => {
    const fileName = `pocket-ai-model-load-report-${Date.now().toString(16)}.json`;
    const file = new File(Paths.cache, fileName) as DeletableReportFile;
    file.create({ overwrite: true });
    file.write(json, { encoding: 'utf8' });
    return { file, fileName, fileUri: file.uri };
  }, []);

  const deleteReportFile = useCallback(async (file: DeletableReportFile) => {
    try {
      if (typeof file.delete === 'function') {
        await file.delete();
      }
    } catch {
      // Best-effort cache cleanup must not block fallback sharing or mask share errors.
    }
  }, []);

  const scheduleReportFileCleanup = useCallback((file: DeletableReportFile) => {
    setTimeout(() => {
      void deleteReportFile(file);
    }, REPORT_SHARE_CACHE_CLEANUP_DELAY_MS);
  }, [deleteReportFile]);

  const handleCopy = useCallback(async () => {
    try {
      const reportJson = buildReportJson();
      await Clipboard.setStringAsync(reportJson);
      Alert.alert(t('models.errorReport.copiedTitle'), t('models.errorReport.copiedMessage'));
    } catch {
      Alert.alert(t('models.errorReport.failedTitle'), t('models.errorReport.copyFailedMessage'));
    }
  }, [buildReportJson, t]);

  const handleShare = useCallback(async () => {
    try {
      const reportJson = buildReportJson();
      let shared = false;

      try {
        const isAvailable = await Sharing.isAvailableAsync();
        if (isAvailable) {
          const reportFile = await writeReportToFile(reportJson);
          try {
            await Sharing.shareAsync(reportFile.fileUri, { mimeType: 'application/json' });
            shared = true;
            // Keep the cache file after a successful native share. On Android, the chooser can
            // resolve before the receiving app has opened the content URI; deleting here can turn
            // an apparently successful share into a broken attachment for the recipient. Cache
            // files are small JSON reports, so clean them up after a short grace period instead.
            scheduleReportFileCleanup(reportFile.file);
          } catch (nativeShareError) {
            await deleteReportFile(reportFile.file);
            throw nativeShareError;
          }
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
  }, [buildReportJson, deleteReportFile, scheduleReportFileCleanup, t, writeReportToFile]);

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
        <Pressable testID="error-report-sheet-backdrop" className="flex-1" onPress={handleClose} />
        <ScreenSheet
          testID="error-report-sheet"
          className={screenLayoutTokens.sheetMaxHeightDefaultClassName}
          androidBlurTargetRef={androidContentBlurTargetRef}
        >
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
                  {sanitizedAppError.message}
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

              <ScreenCard variant="inset">
                <Text className="text-xs font-semibold uppercase tracking-wider text-primary-500">
                  {t('models.errorReport.previewTitle')}
                </Text>
                <Text className="mt-2 text-sm leading-6 text-typography-600 dark:text-typography-300">
                  {t('models.errorReport.previewMessage')}
                </Text>
                <Text
                  selectable
                  className="mt-3 font-mono text-[11px] leading-5 text-typography-700 dark:text-typography-200"
                >
                  {reportPreviewJson}
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
