import React, { useCallback, useMemo, useState } from 'react';
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import * as Clipboard from 'expo-clipboard';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { HeaderBar } from '@/components/ui/HeaderBar';
import { ScreenCard, ScreenContent, ScreenSectionLabel, ScreenStack } from '@/components/ui/ScreenShell';
import { ScrollView } from '@/components/ui/scroll-view';
import { Text } from '@/components/ui/text';
import { performanceMonitor, type PerformanceEvent } from '@/services/PerformanceMonitor';

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

  const handleBack = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }

    router.replace('/(tabs)/settings' as any);
  }, [router]);

  const handleCopy = useCallback(async () => {
    const payload = JSON.stringify(snapshot, null, 2);
    await Clipboard.setStringAsync(payload);
  }, [snapshot]);

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

              <Box className="mt-3 flex-row flex-wrap gap-2">
                <Button action="secondary" size="sm" onPress={() => { void handleCopy(); }}>
                  <ButtonText>{t('performance.copyTrace')}</ButtonText>
                </Button>
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
