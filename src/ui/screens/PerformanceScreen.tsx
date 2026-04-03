import React, { useCallback, useMemo, useState } from 'react';
import { Alert, Platform, Share } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
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

const TIMING_GOOD_THRESHOLD_MS = 250;
const TIMING_WARN_THRESHOLD_MS = 1000;

type TimingTone = 'neutral' | 'good' | 'warn' | 'bad';

function formatDuration(durationMs: number | undefined) {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) {
    return null;
  }

  if (durationMs < 1000) {
    return `${Math.round(durationMs)} ms`;
  }

  return `${(durationMs / 1000).toFixed(2)} s`;
}

function formatTimingThreshold(durationMs: number) {
  if (!Number.isFinite(durationMs)) {
    return null;
  }

  if (durationMs < 1000) {
    return `${Math.round(durationMs)} ms`;
  }

  if (durationMs % 1000 === 0) {
    return `${Math.round(durationMs / 1000)} s`;
  }

  return `${(durationMs / 1000).toFixed(2)} s`;
}

function getTimingTone(durationMs: number | undefined): TimingTone {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) {
    return 'neutral';
  }

  if (durationMs <= TIMING_GOOD_THRESHOLD_MS) {
    return 'good';
  }

  if (durationMs <= TIMING_WARN_THRESHOLD_MS) {
    return 'warn';
  }

  return 'bad';
}

function getTimingToneClassName(tone: TimingTone): string {
  if (tone === 'good') {
    return 'text-success-700 dark:text-success-300';
  }

  if (tone === 'warn') {
    return 'text-warning-700 dark:text-warning-300';
  }

  if (tone === 'bad') {
    return 'text-error-700 dark:text-error-300';
  }

  return 'text-typography-900 dark:text-typography-100';
}

function getEventDisplayValue(event: PerformanceEvent): { value: string | null; tone: TimingTone } {
  if (event.type === 'span') {
    return {
      value: formatDuration(event.durationMs),
      tone: getTimingTone(event.durationMs),
    };
  }

  if (event.type === 'counter') {
    return {
      value: typeof event.value === 'number' ? `${event.value}` : null,
      tone: 'neutral',
    };
  }

  return { value: null, tone: 'neutral' };
}

type SpanAggregate = {
  name: string;
  count: number;
  avgMs: number;
  p95Ms: number;
  maxMs: number;
};

function percentileNearestRank(sortedSamples: number[], percentile: number): number | null {
  if (sortedSamples.length === 0) {
    return null;
  }

  const clamped = Math.min(1, Math.max(0, percentile));
  const rank = Math.ceil(clamped * sortedSamples.length);
  const index = Math.min(sortedSamples.length - 1, Math.max(0, rank - 1));
  return sortedSamples[index];
}

export function PerformanceScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const [, setRevision] = useState(0);

  useFocusEffect(
    useCallback(() => {
      const intervalId = setInterval(() => {
        setRevision((current) => current + 1);
      }, 1000);

      return () => clearInterval(intervalId);
    }, []),
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
  const spanAggregates = useMemo<SpanAggregate[]>(() => {
    const spansByName = new Map<string, { durationsMs: number[]; totalMs: number }>();

    for (const event of snapshot.events) {
      if (event.type !== 'span') {
        continue;
      }

      const durationMs = event.durationMs;
      if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) {
        continue;
      }

      const aggregate = spansByName.get(event.name);
      if (aggregate) {
        aggregate.durationsMs.push(durationMs);
        aggregate.totalMs += durationMs;
      } else {
        spansByName.set(event.name, { durationsMs: [durationMs], totalMs: durationMs });
      }
    }

    const aggregates: SpanAggregate[] = [];

    for (const [name, spanAggregate] of spansByName.entries()) {
      spanAggregate.durationsMs.sort((left, right) => left - right);

      const count = spanAggregate.durationsMs.length;
      const maxMs = spanAggregate.durationsMs[count - 1] ?? 0;
      const p95Ms = percentileNearestRank(spanAggregate.durationsMs, 0.95) ?? maxMs;
      const avgMs = count > 0 ? spanAggregate.totalMs / count : 0;

      aggregates.push({
        name,
        count,
        avgMs,
        p95Ms,
        maxMs,
      });
    }

    aggregates.sort((left, right) => (
      right.p95Ms - left.p95Ms
      || right.maxMs - left.maxMs
      || right.count - left.count
      || left.name.localeCompare(right.name)
    ));

    return aggregates;
  }, [snapshot.events]);
  const events = useMemo(() => snapshot.events.slice().reverse().slice(0, 120), [snapshot.events]);

  const goodThresholdLabel = formatTimingThreshold(TIMING_GOOD_THRESHOLD_MS) ?? `${TIMING_GOOD_THRESHOLD_MS} ms`;
  const warnThresholdLabel = formatTimingThreshold(TIMING_WARN_THRESHOLD_MS) ?? `${TIMING_WARN_THRESHOLD_MS} ms`;

  return (
    <Box className="flex-1 bg-background-0 dark:bg-background-950">
      <HeaderBar
        title={t('performance.title')}
        subtitle={t('performance.subtitle')}
        onBack={handleBack}
        backAccessibilityLabel={t('chat.headerBackAccessibilityLabel')}
        backButtonTestID="performance-back-button"
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
                  testID="performance-toggle-instrumentation"
                  onPress={() => {
                    performanceMonitor.setEnabled(!performanceMonitor.isEnabled());
                    setRevision((current) => current + 1);
                  }}
                >
                  <ButtonText>
                    {snapshot.enabled ? t('performance.disableInstrumentation') : t('performance.enableInstrumentation')}
                  </ButtonText>
                </Button>
                <Button action="secondary" size="sm" testID="performance-copy-trace" onPress={() => { void handleCopy(); }}>
                  <ButtonText>{t('performance.copyTrace')}</ButtonText>
                </Button>
                <Button action="secondary" size="sm" testID="performance-share-trace" onPress={() => { void handleShare(); }}>
                  <ButtonText>{t('performance.shareTrace')}</ButtonText>
                </Button>
                <Button action="secondary" size="sm" testID="performance-save-trace" onPress={() => { void handleSaveToFile(); }}>
                  <ButtonText>{t('performance.saveTraceToFile')}</ButtonText>
                </Button>
                {Platform.OS === 'android' ? (
                  <Button
                    action="secondary"
                    size="sm"
                    disabled={!snapshot.enabled}
                    testID="performance-dump-logcat"
                    onPress={handleDumpToLogcat}
                  >
                    <ButtonText>{t('performance.dumpToLogcat')}</ButtonText>
                  </Button>
                ) : null}
                <Button action="secondary" size="sm" testID="performance-clear-trace" onPress={handleClear}>
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
              <ScreenSectionLabel>{t('performance.spans')}</ScreenSectionLabel>
              <ScreenStack className="mt-2">
                <ScreenCard padding="compact" variant="inset">
                  <Text className="text-xs text-typography-500 dark:text-typography-400">
                    {t('performance.timingLegendLabel')}
                  </Text>
                  <Box className="mt-2 flex-row flex-wrap gap-3">
                    <Text className="text-xs font-semibold text-success-700 dark:text-success-300">
                      {t('performance.timingLegendGood', { value: goodThresholdLabel })}
                    </Text>
                    <Text className="text-xs font-semibold text-warning-700 dark:text-warning-300">
                      {t('performance.timingLegendWarn', { value: warnThresholdLabel })}
                    </Text>
                    <Text className="text-xs font-semibold text-error-700 dark:text-error-300">
                      {t('performance.timingLegendBad', { value: warnThresholdLabel })}
                    </Text>
                  </Box>
                </ScreenCard>

                {spanAggregates.length === 0 ? (
                  <ScreenCard padding="compact">
                    <Text className="text-sm text-typography-500 dark:text-typography-400">
                      {t('performance.emptySpans')}
                    </Text>
                  </ScreenCard>
                ) : (
                  spanAggregates.map((spanAggregate) => (
                    <ScreenCard key={spanAggregate.name} padding="compact">
                      <Box className="flex-row items-center justify-between gap-3">
                        <Text className="flex-1 text-sm text-typography-700 dark:text-typography-200">
                          {spanAggregate.name}
                        </Text>
                        <Box className="flex-row items-baseline gap-1">
                          <Text className="text-xs text-typography-500 dark:text-typography-400">
                            {t('performance.spanMetricP95')}
                          </Text>
                          <Text
                            className={`text-sm font-semibold ${getTimingToneClassName(getTimingTone(spanAggregate.p95Ms))}`}
                          >
                            {formatDuration(spanAggregate.p95Ms) ?? '-'}
                          </Text>
                        </Box>
                      </Box>
                      <Box className="mt-1 flex-row flex-wrap gap-2">
                        <Text className="text-xs text-typography-500 dark:text-typography-400">
                          {t('performance.spanMetricCount', { count: spanAggregate.count })}
                        </Text>
                        <Text className="text-xs text-typography-500 dark:text-typography-400">
                          {t('performance.spanMetricAvg', { value: formatDuration(spanAggregate.avgMs) ?? '-' })}
                        </Text>
                        <Text className="text-xs text-typography-500 dark:text-typography-400">
                          {t('performance.spanMetricMax', { value: formatDuration(spanAggregate.maxMs) ?? '-' })}
                        </Text>
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
                  events.map((event, index) => {
                    const { value, tone } = getEventDisplayValue(event);

                    return (
                      <ScreenCard key={`${event.type}-${event.name}-${index}`} padding="compact">
                        <Box className="flex-row items-center justify-between gap-3">
                          <Text className="flex-1 text-sm text-typography-700 dark:text-typography-200">
                            {event.name}
                          </Text>
                          {value ? (
                            <Text className={`text-sm font-semibold ${getTimingToneClassName(tone)}`}>
                              {value}
                            </Text>
                          ) : (
                            <Text className="text-xs text-typography-500 dark:text-typography-400">
                              {event.type}
                            </Text>
                          )}
                        </Box>
                      </ScreenCard>
                    );
                  })
                )}
              </ScreenStack>
            </Box>
          </ScreenStack>
        </ScreenContent>
      </ScrollView>
    </Box>
  );
}
