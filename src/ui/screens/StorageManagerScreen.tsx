import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { HeaderBar } from '@/components/ui/HeaderBar';
import { ScreenBadge, ScreenCard, ScreenContent, ScreenSectionLabel, ScreenStack } from '@/components/ui/ScreenShell';
import { ScrollView } from '@/components/ui/scroll-view';
import { Text } from '@/components/ui/text';
import { hardwareListenerService, type HardwareStatus } from '../../services/HardwareListenerService';
import {
    clearActiveCache,
    clearChatHistory,
    getAppStorageMetrics,
    offloadModel,
    resetAppSettings,
    type AppStorageMetrics,
} from '../../services/StorageManagerService';
import { getReportedErrorMessage } from '../../services/AppError';
import { formatModelFileSize } from '../../utils/modelSize';
import { toTestIdSegment } from '../../utils/testIds';

type BusyAction = 'cache' | 'chat' | 'settings' | `offload:${string}` | `offload:${string}:reset` | null;

function formatBytes(value: number) {
    if (!Number.isFinite(value) || value <= 0) return '0 MB';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = value;
    let index = 0;
    while (size >= 1000 && index < units.length - 1) {
        size /= 1000;
        index += 1;
    }
    return `${size.toFixed(size >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function ActionCard({
    title,
    description,
    meta,
    busy,
    disabled,
    buttonLabel,
    buttonTestID,
    onPress,
}: {
    title: string;
    description: string;
    meta?: string;
    busy: boolean;
    disabled: boolean;
    buttonLabel: string;
    buttonTestID?: string;
    onPress: () => void;
}) {
    return (
        <ScreenCard variant="inset" className={busy ? 'opacity-70' : undefined}>
            <Box className="flex-row items-start justify-between gap-3">
                <Box className="min-w-0 flex-1">
                    <Text className="text-base font-semibold text-typography-900 dark:text-typography-100">
                        {title}
                    </Text>
                    <Text className="mt-1 text-sm leading-5 text-typography-500 dark:text-typography-400">
                        {description}
                    </Text>
                    {meta ? (
                        <Text className="mt-2 text-xs font-semibold uppercase tracking-wide text-typography-500 dark:text-typography-400">
                            {meta}
                        </Text>
                    ) : null}
                </Box>
                <Button
                    action="softDestructive"
                    size="sm"
                    disabled={disabled}
                    testID={buttonTestID}
                    onPress={onPress}
                    className="shrink-0"
                >
                    <ButtonText>{buttonLabel}</ButtonText>
                </Button>
            </Box>
        </ScreenCard>
    );
}

export function StorageManagerScreen() {
    const { t, i18n } = useTranslation();
    const insets = useSafeAreaInsets();
    const router = useRouter();
    const [appMetrics, setAppMetrics] = useState<AppStorageMetrics | null>(null);
    const [hardwareStatus, setHardwareStatus] = useState<HardwareStatus>(hardwareListenerService.getCurrentStatus());
    const [busyAction, setBusyAction] = useState<BusyAction>(null);
    const mountedRef = useRef(true);
    const canGoBack = router.canGoBack();
    const handleBack = useCallback(() => {
        if (canGoBack) {
            router.back();
            return;
        }

        router.replace('/(tabs)/models');
    }, [canGoBack, router]);

    const loadAppMetrics = useCallback(async () => {
        const next = await getAppStorageMetrics();
        if (mountedRef.current) {
            setAppMetrics(next);
        }
    }, []);

    const refreshAll = useCallback(async () => {
        await loadAppMetrics();
    }, [loadAppMetrics]);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    useEffect(() => hardwareListenerService.subscribe(setHardwareStatus), []);

    useFocusEffect(
        useCallback(() => {
            void refreshAll();
        }, [refreshAll]),
    );

    const runBusyAction = useCallback(async (key: Exclude<BusyAction, null>, action: () => Promise<void>) => {
        try {
            setBusyAction(key);
            await action();
        } catch (error: any) {
            Alert.alert(
                t('storageManager.actionFailedTitle'),
                getReportedErrorMessage('StorageManagerScreen.runBusyAction', error, t),
            );
        } finally {
            if (mountedRef.current) {
                setBusyAction(null);
            }
            await refreshAll();
        }
    }, [refreshAll, t]);

    const handleDeleteModel = useCallback((modelId: string, modelName: string) => {
        Alert.alert(
            t('storageManager.deleteModelTitle'),
            t('storageManager.deleteModelMessage', { model: modelName }),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('storageManager.deleteModelKeepSettings'),
                    onPress: () => {
                        void runBusyAction(`offload:${modelId}`, async () => {
                            await offloadModel(modelId, { preserveSettings: true });
                        });
                    },
                },
                {
                    text: t('storageManager.deleteModelResetSettings'),
                    style: 'destructive',
                    onPress: () => {
                        void runBusyAction(`offload:${modelId}:reset`, async () => {
                            await offloadModel(modelId, { preserveSettings: false });
                        });
                    },
                },
            ],
        );
    }, [runBusyAction, t]);

    const handleClearCache = useCallback(() => {
        Alert.alert(
            t('storageManager.clearCacheTitle'),
            t('storageManager.clearCacheMessage'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('common.clear'),
                    style: 'destructive',
                    onPress: () => {
                        void runBusyAction('cache', async () => {
                            await clearActiveCache();
                        });
                    },
                },
            ],
        );
    }, [runBusyAction, t]);

    const handleClearChatHistory = useCallback(() => {
        Alert.alert(
            t('storageManager.clearChatHistoryTitle'),
            t('storageManager.clearChatHistoryMessage'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('common.clear'),
                    style: 'destructive',
                    onPress: () => {
                        void runBusyAction('chat', async () => {
                            await clearChatHistory();
                        });
                    },
                },
            ],
        );
    }, [runBusyAction, t]);

    const handleResetSettings = useCallback(() => {
        Alert.alert(
            t('storageManager.resetSettingsTitle'),
            t('storageManager.resetSettingsMessage'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('common.reset'),
                    style: 'destructive',
                    onPress: () => {
                        void runBusyAction('settings', async () => {
                            const next = await resetAppSettings();
                            await i18n.changeLanguage(next.language);
                        });
                    },
                },
            ],
        );
    }, [i18n, runBusyAction, t]);

    const downloadedModels = appMetrics?.downloadedModels ?? [];

    return (
        <Box className="flex-1 bg-background-0 dark:bg-background-950">
            <HeaderBar
                title={t('storageManager.title')}
                subtitle={t('storageManager.subtitle')}
                onBack={handleBack}
                backAccessibilityLabel={t('chat.headerBackAccessibilityLabel')}
                backButtonTestID="storage-manager-back-button"
            />

            <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
                <ScreenContent className="pt-5" style={{ paddingBottom: insets.bottom + 32 }}>
                    <ScreenStack gap="loose">
                        {hardwareStatus.isLowMemory ? (
                            <ScreenCard tone="warning">
                                <Text className="text-base font-semibold text-warning-800 dark:text-warning-100">
                                    {t('storageManager.lowMemoryTitle')}
                                </Text>
                                <Text className="mt-2 text-sm leading-6 text-warning-700 dark:text-warning-200">
                                    {t('storageManager.lowMemoryDescription')}
                                </Text>
                            </ScreenCard>
                        ) : null}

                        <ScreenCard>
                            <ScreenSectionLabel>{t('storageManager.actionsTitle')}</ScreenSectionLabel>
                            <Text className="mt-2 text-sm leading-6 text-typography-600 dark:text-typography-300">
                                {t('storageManager.actionsDescription')}
                            </Text>
                            <ScreenStack className="mt-4">
                                <ActionCard
                                    title={t('storageManager.clearCacheTitle')}
                                    description={t('storageManager.clearCacheDescription')}
                                    meta={formatBytes(appMetrics?.cacheBytes ?? 0)}
                                    busy={busyAction === 'cache'}
                                    disabled={busyAction !== null}
                                    buttonLabel={busyAction === 'cache' ? t('common.loading') : t('common.clear')}
                                    buttonTestID="storage-manager-clear-cache"
                                    onPress={handleClearCache}
                                />
                                <ActionCard
                                    title={t('storageManager.clearChatHistoryTitle')}
                                    description={t('storageManager.clearChatHistoryDescription')}
                                    meta={formatBytes(appMetrics?.chatHistoryBytes ?? 0)}
                                    busy={busyAction === 'chat'}
                                    disabled={busyAction !== null}
                                    buttonLabel={busyAction === 'chat' ? t('common.loading') : t('common.clear')}
                                    buttonTestID="storage-manager-clear-chat"
                                    onPress={handleClearChatHistory}
                                />
                                <ActionCard
                                    title={t('storageManager.resetSettingsTitle')}
                                    description={t('storageManager.resetSettingsDescription')}
                                    busy={busyAction === 'settings'}
                                    disabled={busyAction !== null}
                                    buttonLabel={busyAction === 'settings' ? t('common.loading') : t('common.reset')}
                                    buttonTestID="storage-manager-reset-settings"
                                    onPress={handleResetSettings}
                                />
                            </ScreenStack>
                        </ScreenCard>

                        <ScreenCard>
                            <ScreenSectionLabel>
                                {t('storageManager.downloadedModelsTitle', { count: downloadedModels.length })}
                            </ScreenSectionLabel>
                            <Text className="mt-2 text-sm leading-6 text-typography-600 dark:text-typography-300">
                                {t('storageManager.downloadedModelsDescription')}
                            </Text>

                            <ScreenStack className="mt-4">
                                {downloadedModels.length === 0 ? (
                                    <ScreenCard variant="inset">
                                        <Text className="text-base font-semibold text-typography-900 dark:text-typography-100">
                                            {t('storageManager.emptyModelsTitle')}
                                        </Text>
                                        <Text className="mt-2 text-sm leading-6 text-typography-500 dark:text-typography-400">
                                            {t('storageManager.emptyModelsDescription')}
                                        </Text>
                                    </ScreenCard>
                                ) : downloadedModels.map((model) => {
                                    const actionKey: BusyAction = `offload:${model.id}`;
                                    const isActive = appMetrics?.activeModelId === model.id;
                                    return (
                                        <ScreenCard key={model.id} variant="inset">
                                            <Box className="flex-row items-start justify-between gap-3">
                                                <Box className="min-w-0 flex-1">
                                                    <Text className="text-base font-semibold text-typography-900 dark:text-typography-100">
                                                        {model.name}
                                                    </Text>
                                                    <Text className="mt-1 text-sm leading-5 text-typography-500 dark:text-typography-400">
                                                        {model.author} • {formatModelFileSize(model.size, t('models.sizeUnknown'))}
                                                    </Text>
                                                    {isActive ? (
                                                        <ScreenBadge tone="accent" size="micro" className="mt-3 self-start">
                                                            {t('storageManager.activeModelBadge')}
                                                        </ScreenBadge>
                                                    ) : null}
                                                </Box>
                                                <Button
                                                    action="softDestructive"
                                                    size="sm"
                                                    disabled={busyAction !== null}
                                                    onPress={() => handleDeleteModel(model.id, model.name)}
                                                    testID={`storage-manager-delete-model-${toTestIdSegment(model.id)}`}
                                                    className="shrink-0"
                                                >
                                                    <ButtonText>{busyAction === actionKey ? t('common.loading') : t('common.delete')}</ButtonText>
                                                </Button>
                                            </Box>
                                        </ScreenCard>
                                    );
                                })}
                            </ScreenStack>
                        </ScreenCard>
                    </ScreenStack>
                </ScreenContent>
            </ScrollView>
        </Box>
    );
}
