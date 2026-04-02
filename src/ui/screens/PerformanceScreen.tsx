import React, { useCallback, useMemo, useState } from 'react';
import { Alert, Platform, Share } from 'react-native';
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import * as Clipboard from 'expo-clipboard';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { HeaderBar } from '@/components/ui/HeaderBar';
import { ScreenCard, ScreenContent, ScreenSectionLabel, ScreenStack } from '@/components/ui/ScreenShell';
import { ScrollView } from '@/components/ui/scroll-view';
import { Text } from '@/components/ui/text';
import { performanceMonitor, type PerformanceEvent } from '@/services/PerformanceMonitor';
import { buildPerformanceExportJson, buildTraceFilename, dumpTraceToLogcat, getUtf8ByteLength } from '@/services/PerformanceExport';

function formatDuration(durationMs: number | undefined) {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) {
    return null;
  }

  if (durationMs < 1000) {
    return `${Math.round(durationMs)} ms`;
  }

  return `${(durationMs / 1000).toFixed(2)} s`;
}

function formatEvent(event: PerformanceEvent) {
  const duration = formatDuration(event.durationMs);
  if (event.type === 'span') {
    return duration ? `${event.name} · ${duration}` : event.name;
  }

  if (event.type === 'counter') {
    return typeof event.value === 'number'
      ? `${event.name} · ${event.value}`
      : event.name;
  }

  return event.name;
}

export function PerformanceScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const isFocused = useIsFocused();
  const [, setRevision] = useState(0);

  useFocusEffect(
    useCallback(() => {
      if (!isFocused) {
        return () => undefined;
      }

      const intervalId = setInterval(() => {
        setRevision((current) => current + 1);
      }, 1000);

      return () => clearInterval(intervalId);
    }, [isFocused]),
  );

  const snapshot = performanceMonitor.snapshot();
  const sessionInfo = performanceMonitor.getSessionInfo();

  const setExportBytesCounter = useCallback((bytes: number) => {
    const currentValue = performanceMonitor.snapshot().counters['perf.export.bytes'] ?? 0;
    performanceMonitor.incrementCounter('perf.export.bytes', bytes - currentValue);
  }, []);

  const handleBack = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }

    router.replace('/(tabs)/settings');
  }, [router]);

  const handleCopy = useCallback(async () => {
    const span = performanceMonitor.startSpan('perf.export', { method: 'copy' });

    try {
      const json = buildPerformanceExportJson({ pretty: true });
      const bytes = getUtf8ByteLength(json);
      setExportBytesCounter(bytes);

      await Clipboard.setStringAsync(json);
      span.end({ method: 'copy', ok: true, bytes });
    } catch {
      span.end({ method: 'copy', ok: false });
      Alert.alert(t('performance.exportFailedTitle'), t('performance.exportFailedMessage'));
    }
  }, [setExportBytesCounter, t]);

  const writeTraceToFile = useCallback(async (json: string, target: 'cache' | 'document' = 'cache') => {
    const directory = target === 'document' ? Paths.document : Paths.cache;
    const fileName = buildTraceFilename(sessionInfo.sessionId);
    const file = new File(directory, fileName);
    file.create({ overwrite: true });
    file.write(json, { encoding: 'utf8' });
    return { fileName, fileUri: file.uri };
  }, [sessionInfo.sessionId]);

  const handleShare = useCallback(async () => {
    const span = performanceMonitor.startSpan('perf.export', { method: 'share' });

    try {
      const json = buildPerformanceExportJson({ pretty: false });
      const bytes = getUtf8ByteLength(json);
      setExportBytesCounter(bytes);

      let shared = false;

      try {
        const isAvailable = await Sharing.isAvailableAsync();
        if (isAvailable) {
          const { fileUri } = await writeTraceToFile(json, 'cache');
          await Sharing.shareAsync(fileUri, { mimeType: 'application/json' });
          shared = true;
        }
      } catch {
        // fallback to Share API below
      }

      if (!shared) {
        await Share.share({ message: json });
      }

      span.end({ method: 'share', ok: true, bytes });
    } catch {
      span.end({ method: 'share', ok: false });
      Alert.alert(t('performance.exportFailedTitle'), t('performance.shareFailedMessage'));
    }
  }, [setExportBytesCounter, t, writeTraceToFile]);

  const handleSaveToFile = useCallback(async () => {
    const span = performanceMonitor.startSpan('perf.export', { method: 'file' });

    try {
      const json = buildPerformanceExportJson({ pretty: false });
      const bytes = getUtf8ByteLength(json);
      setExportBytesCounter(bytes);

      const { fileUri } = await writeTraceToFile(json, 'document');
      const isAvailable = await Sharing.isAvailableAsync();
      if (!isAvailable) {
        throw new Error('Sharing is not available on this platform.');
      }

      await Sharing.shareAsync(fileUri, { mimeType: 'application/json' });
      span.end({ method: 'file', ok: true, bytes });
    } catch {
      span.end({ method: 'file', ok: false });
      Alert.alert(t('performance.exportFailedTitle'), t('performance.saveFailedMessage'));
    }
  }, [setExportBytesCounter, t, writeTraceToFile]);

  const handleDumpToLogcat = useCallback(() => {
    const span = performanceMonitor.startSpan('perf.export', { method: 'logcat' });

    try {
      const result = dumpTraceToLogcat();
      if (!result.ok) {
        span.end({ method: 'logcat', ok: false });
        Alert.alert(t('performance.exportFailedTitle'), t('performance.logcatDumpFailedMessage'));
        return;
      }

      setExportBytesCounter(result.estimatedPayloadBytes);
      span.end({ method: 'logcat', ok: true, bytes: result.estimatedPayloadBytes });
    } catch {
      span.end({ method: 'logcat', ok: false });
      Alert.alert(t('performance.exportFailedTitle'), t('performance.logcatDumpFailedMessage'));
    }
  }, [setExportBytesCounter, t]);

  const handleClear = useCallback(() => {
    performanceMonitor.clear();
    setRevision((current) => current + 1);
  }, []);

  const counters = useMemo(() => Object.entries(snapshot.counters), [snapshot.counters]);
  const events = useMemo(() => snapshot.events.slice().reverse().slice(0, 120), [snapshot.events]);

  return (
    <Box className="flex-1 bg-background-0 dark:bg-background-950">
      <HeaderBar
        title={t('performance.title')}
        subtitle={t('performance.subtitle')}
        onBack={handleBack}
        backAccessibilityLabel={t('chat.headerBackAccessibilityLabel')}
      />

      <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
        <ScreenContent style={{ paddingTop: 18 }}>
          <ScreenStack gap="loose">
            <ScreenCard>
              <Text className="text-sm text-typography-600 dark:text-typography-300">
                {t('performance.summary', {
                  enabled: snapshot.enabled ? t('performance.enabled') : t('performance.disabled'),
                  events: snapshot.events.length,
                })}
              </Text>

              <Box className="mt-4">
                <Text className="text-sm font-semibold text-typography-800 dark:text-typography-100">
                  {t('performance.instrumentationToggleLabel')}
                </Text>
                <Text className="mt-1 text-sm text-typography-600 dark:text-typography-300">
                  {t('performance.instrumentationToggleDescription')}
                </Text>
              </Box>

              <Box className="mt-3 flex-row flex-wrap gap-2">
                <Button
                  action={snapshot.enabled ? 'secondary' : 'positive'}
                  size="sm"
                  onPress={() => {
                    performanceMonitor.setEnabled(!performanceMonitor.isEnabled());
                    setRevision((current) => current + 1);
                  }}
                >
                  <ButtonText>
                    {snapshot.enabled ? t('performance.disableInstrumentation') : t('performance.enableInstrumentation')}
                  </ButtonText>
                </Button>
                <Button action="secondary" size="sm" onPress={() => { void handleCopy(); }}>
                  <ButtonText>{t('performance.copyTrace')}</ButtonText>
                </Button>
                <Button action="secondary" size="sm" onPress={() => { void handleShare(); }}>
                  <ButtonText>{t('performance.shareTrace')}</ButtonText>
                </Button>
                <Button action="secondary" size="sm" onPress={() => { void handleSaveToFile(); }}>
                  <ButtonText>{t('performance.saveTraceToFile')}</ButtonText>
                </Button>
                {Platform.OS === 'android' ? (
                  <Button
                    action="secondary"
                    size="sm"
                    disabled={!snapshot.enabled}
                    onPress={handleDumpToLogcat}
                  >
                    <ButtonText>{t('performance.dumpToLogcat')}</ButtonText>
                  </Button>
                ) : null}
                <Button action="secondary" size="sm" onPress={handleClear}>
                  <ButtonText>{t('performance.clearTrace')}</ButtonText>
                </Button>
              </Box>
            </ScreenCard>

            <Box>
              <ScreenSectionLabel>{t('performance.counters')}</ScreenSectionLabel>
              <ScreenStack className="mt-2">
                {counters.length === 0 ? (
                  <ScreenCard padding="compact">
                    <Text className="text-sm text-typography-500 dark:text-typography-400">
                      {t('performance.emptyCounters')}
                    </Text>
                  </ScreenCard>
                ) : (
                  counters.map(([name, value]) => (
                    <ScreenCard key={name} padding="compact">
                      <Box className="flex-row items-center justify-between gap-3">
                        <Text className="flex-1 text-sm text-typography-700 dark:text-typography-200">{name}</Text>
                        <Text className="text-sm font-semibold text-typography-900 dark:text-typography-100">{value}</Text>
                      </Box>
                    </ScreenCard>
                  ))
                )}
              </ScreenStack>
            </Box>

            <Box>
              <ScreenSectionLabel>{t('performance.events')}</ScreenSectionLabel>
              <ScreenStack className="mt-2">
                {events.length === 0 ? (
                  <ScreenCard padding="compact">
                    <Text className="text-sm text-typography-500 dark:text-typography-400">
                      {t('performance.emptyEvents')}
                    </Text>
                  </ScreenCard>
                ) : (
                  events.map((event, index) => (
                    <ScreenCard key={`${event.type}-${event.name}-${index}`} padding="compact">
                      <Text className="text-sm text-typography-700 dark:text-typography-200">
                        {formatEvent(event)}
                      </Text>
                    </ScreenCard>
                  ))
                )}
              </ScreenStack>
            </Box>
          </ScreenStack>
        </ScreenContent>
      </ScrollView>
    </Box>
  );
}
