import React, { useCallback, useEffect, useState } from 'react';
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { HeaderBar } from '@/components/ui/HeaderBar';
import { MaterialSymbols } from '@/components/ui/MaterialSymbols';
import {
    ScreenCard,
    ScreenContent,
    ScreenIconTile,
    ScreenPressableCard,
    ScreenRoot,
    ScreenSectionLabel,
    ScreenSegmentedControl,
    ScreenStack,
} from '@/components/ui/ScreenShell';
import { ScrollView } from '@/components/ui/scroll-view';
import { Text } from '@/components/ui/text';
import { useDeviceMetrics } from '../../hooks/useDeviceMetrics';
import { useFloatingScrollInsets } from '../../hooks/useTabBarContentInset';
import { useLLMEngine } from '../../hooks/useLLMEngine';
import { useTheme } from '../../providers/ThemeProvider';
import { huggingFaceTokenService } from '../../services/HuggingFaceTokenService';
import { llmEngineService } from '../../services/LLMEngineService';
import { getAppStorageMetrics, type AppStorageMetrics } from '../../services/StorageManagerService';
import { getSettings, subscribeSettings, updateSettings } from '../../services/SettingsStore';
import { screenLayoutMetrics, semanticColorTokens, withAlpha, type ThemeId, type ThemeTone } from '../../utils/themeTokens';

function clampPercentage(value: number) {
    if (!Number.isFinite(value)) {
        return 0;
    }

    return Math.max(0, Math.min(100, value));
}

function formatSystemCapacity(value: number) {
    if (!Number.isFinite(value) || value <= 0) {
        return '0 MB';
    }

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = value;
    let unitIndex = 0;

    while (size >= 1000 && unitIndex < units.length - 1) {
        size /= 1000;
        unitIndex += 1;
    }

    const precision = unitIndex >= 3 ? 1 : (size >= 10 || unitIndex === 0 ? 0 : 1);
    return `${size.toFixed(precision)} ${units[unitIndex]}`;
}

function formatBytes(value: number) {
    if (!Number.isFinite(value) || value <= 0) {
        return '0 MB';
    }

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = value;
    let unitIndex = 0;

    while (size >= 1000 && unitIndex < units.length - 1) {
        size /= 1000;
        unitIndex += 1;
    }

    const precision = size >= 10 || unitIndex === 0 ? 0 : 1;
    return `${size.toFixed(precision)} ${units[unitIndex]}`;
}

function formatPercent(value: number) {
    return `${Math.round(clampPercentage(value))}%`;
}

function SettingsNavCard({
    title,
    description,
    iconName,
    iconTone = 'accent',
    iconClassName,
    trailingText,
    onPress,
}: {
    title: string;
    description: string;
    iconName: React.ComponentProps<typeof MaterialSymbols>['name'];
    iconTone?: ThemeTone;
    iconClassName?: string;
    trailingText?: string;
    onPress: () => void;
}) {
    return (
        <ScreenPressableCard onPress={onPress} padding="compact">
            <Box className="flex-row items-center gap-3">
                <ScreenIconTile iconName={iconName} tone={iconTone} iconClassName={iconClassName} />

                <Box className="min-w-0 flex-1">
                    <Text className="text-base font-semibold text-typography-900 dark:text-typography-100">
                        {title}
                    </Text>
                    <Text className="mt-1 text-sm leading-5 text-typography-500 dark:text-typography-400">
                        {description}
                    </Text>
                </Box>

                <Box className="shrink-0 flex-row items-center gap-1">
                    {trailingText ? (
                        <Text className="text-sm font-semibold text-primary-500">
                            {trailingText}
                        </Text>
                    ) : null}
                    <MaterialSymbols name="chevron-right" size="lg" className="text-typography-400 dark:text-typography-500" />
                </Box>
            </Box>
        </ScreenPressableCard>
    );
}

function UsageMeter({
    label,
    value,
    percentage,
    fillColor,
    trackBackground,
    labelColor,
    valueColor,
    testID,
}: {
    label: string;
    value: string;
    percentage: number;
    fillColor: string;
    trackBackground: string;
    labelColor: string;
    valueColor: string;
    testID: string;
}) {
    return (
        <Box className="gap-2">
            <Box className="flex-row items-center justify-between gap-3">
                <Text className="flex-1 text-xs font-semibold leading-4" style={{ color: labelColor }}>
                    {label}
                </Text>
                <Text className="text-xs font-semibold leading-4 text-right" style={{ color: valueColor }}>
                    {value}
                </Text>
            </Box>
            <Box className="h-2.5 overflow-hidden rounded-full" style={{ backgroundColor: trackBackground }}>
                <Box
                    testID={testID}
                    className="h-full rounded-full"
                    style={{
                        width: `${clampPercentage(percentage)}%`,
                        backgroundColor: fillColor,
                    }}
                />
            </Box>
        </Box>
    );
}

function LayeredUsageMeter({
    rows,
    basePercentage,
    baseFillColor,
    overlayPercentage,
    overlayFillColor,
    trackBackground,
    labelColor,
    valueColor,
    trackTestID,
    baseTestID,
    overlayTestID,
}: {
    rows: {
        label: string;
        value: string;
        color: string;
    }[];
    basePercentage: number;
    baseFillColor: string;
    overlayPercentage: number;
    overlayFillColor: string;
    trackBackground: string;
    labelColor: string;
    valueColor: string;
    trackTestID: string;
    baseTestID: string;
    overlayTestID: string;
}) {
    return (
        <Box className="gap-2">
            <ScreenStack gap="compact">
                {rows.map((row) => (
                    <Box key={`${row.label}-${row.value}`} className="flex-row items-center justify-between gap-3">
                        <Box className="flex-1 flex-row items-center gap-2">
                            <Box className="h-2 w-2 rounded-full" style={{ backgroundColor: row.color }} />
                            <Text className="flex-1 text-xs font-semibold leading-4" style={{ color: labelColor }}>
                                {row.label}
                            </Text>
                        </Box>
                        <Text className="text-xs font-semibold leading-4 text-right" style={{ color: valueColor }}>
                            {row.value}
                        </Text>
                    </Box>
                ))}
            </ScreenStack>
            <Box testID={trackTestID} className="h-2.5 overflow-hidden rounded-full" style={{ backgroundColor: trackBackground }}>
                <Box
                    testID={baseTestID}
                    className="absolute inset-y-0 left-0 rounded-full"
                    style={{
                        width: `${clampPercentage(basePercentage)}%`,
                        backgroundColor: baseFillColor,
                    }}
                />
                <Box
                    testID={overlayTestID}
                    className="absolute inset-y-0 left-0 rounded-full"
                    style={{
                        width: `${clampPercentage(overlayPercentage)}%`,
                        backgroundColor: overlayFillColor,
                    }}
                />
            </Box>
        </Box>
    );
}

export const SettingsScreen = () => {
    const { t, i18n } = useTranslation();
    const router = useRouter();
    const isFocused = useIsFocused();
    const { mode, themeId, resolvedMode, setTheme, setThemeId, colors, appearance } = useTheme();
    const { paddingTop: headerInset, paddingBottom: tabBarInset } = useFloatingScrollInsets();
    const { metrics, refresh } = useDeviceMetrics({ enabled: isFocused, refreshIntervalMs: 5000 });
    const { state: engineState, isReady: isEngineReady } = useLLMEngine();
    const [settings, setSettings] = useState(() => getSettings());
    const [appStorageMetrics, setAppStorageMetrics] = useState<AppStorageMetrics | null>(null);
    const [hasHuggingFaceToken, setHasHuggingFaceToken] = useState(() => huggingFaceTokenService.getCachedState().hasToken);

    const isDark = resolvedMode === 'dark';
    const trackBackground = isDark ? withAlpha(semanticColorTokens.outline[700], 0.9) : semanticColorTokens.outline[200];
    const memoryAccent = colors.primary;
    const memoryAccentSoft = isDark ? semanticColorTokens.primary[300] : semanticColorTokens.primary[400];
    const storageAccent = colors.success;
    const storageAccentSoft = isDark ? semanticColorTokens.success[300] : semanticColorTokens.success[400];

    useEffect(() => {
        return subscribeSettings((nextSettings) => {
            setSettings(nextSettings);
        });
    }, []);

    useEffect(() => {
        return huggingFaceTokenService.subscribe((state) => {
            setHasHuggingFaceToken(state.hasToken);
        });
    }, []);

    useFocusEffect(
        useCallback(() => {
            void refresh();
        }, [refresh]),
    );

    useFocusEffect(
        useCallback(() => {
            let isActive = true;

            const loadAppStorageMetrics = async () => {
                const nextMetrics = await getAppStorageMetrics();
                if (isActive) {
                    setAppStorageMetrics(nextMetrics);
                }
            };

            void loadAppStorageMetrics();

            return () => {
                isActive = false;
            };
        }, []),
    );

    const handleLanguagePress = () => {
        const nextLang = settings.language === 'en' ? 'ru' : 'en';
        updateSettings({ language: nextLang });
        i18n.changeLanguage(nextLang);
    };

    const handlePresetsPress = () => {
        router.push('/presets');
    };

    const handleStorageManagerPress = () => {
        router.push('/storage');
    };

    const handleLegalPress = () => {
        router.push('/legal');
    };

    const handleHuggingFaceTokenPress = () => {
        router.push('/huggingface-token');
    };

    const handlePerformancePress = () => {
        router.push('/performance');
    };

    const unloadActiveModel = async () => {
        await llmEngineService.unload();
        await refresh();
    };

    const ramTotalBytes = metrics?.ram.totalBytes ?? 0;
    const ramUsedBytes = metrics?.ram.usedBytes ?? 0;
    const ramAvailableBudgetBytes = metrics?.ram.availableBudgetBytes;
    const ramFreeBytes = metrics?.ram.freeBytes;
    const ramAvailableBytes = metrics?.ram.availableBytes ?? 0;
    const ramAppUsedBytes = metrics?.ram.appUsedBytes ?? 0;
    const ramUsedPercentage = metrics?.ram.usedPercentage ?? 0;
    const ramAppUsedPercentage = ramTotalBytes > 0 ? (ramAppUsedBytes / ramTotalBytes) * 100 : 0;
    const isSystemRamSource = metrics?.ram.source === 'system';

    const storageTotalBytes = metrics?.storage.totalBytes ?? 0;
    const storageUsedBytes = metrics?.storage.usedBytes ?? 0;
    const storageFreeBytes = metrics?.storage.freeBytes ?? Math.max(storageTotalBytes - storageUsedBytes, 0);
    const storageUsedPercentage = metrics?.storage.usedPercentage ?? (storageTotalBytes > 0 ? (storageUsedBytes / storageTotalBytes) * 100 : 0);
    const appFilesBytes = appStorageMetrics?.appFilesBytes ?? 0;
    const appStoragePercentage = storageTotalBytes > 0 ? (appFilesBytes / storageTotalBytes) * 100 : 0;
    const canForceUnloadModel = isEngineReady && Boolean(engineState.activeModelId);
    const ramPrimaryValue = formatSystemCapacity(isSystemRamSource ? ramUsedBytes : ramAppUsedBytes);
    const ramPrimaryLabel = isSystemRamSource
        ? t('settings.memoryInUseOf', { total: formatSystemCapacity(ramTotalBytes) })
        : t('settings.memoryAppUsage');
    const ramAsideLabel = isSystemRamSource
        ? t('settings.available')
        : t('settings.deviceTotal');
    const ramAsideValue = formatSystemCapacity(
        isSystemRamSource
            ? (ramAvailableBudgetBytes ?? ramAvailableBytes ?? ramFreeBytes ?? 0)
            : ramTotalBytes,
    );
    const ramSystemUsageSummary = formatPercent(ramUsedPercentage);
    const ramAppUsageSummary = formatSystemCapacity(ramAppUsedBytes);
    const ramUsedTrackPercentage = clampPercentage(ramUsedPercentage);
    const ramAppTrackPercentage = Math.min(clampPercentage(ramAppUsedPercentage), ramUsedTrackPercentage);
    const storageSystemUsageSummary = formatPercent(storageUsedPercentage);
    const storageAppUsageSummary = formatBytes(appFilesBytes);
    const storageUsedTrackPercentage = clampPercentage(storageUsedPercentage);
    const storageAppTrackPercentage = Math.min(clampPercentage(appStoragePercentage), storageUsedTrackPercentage);

    const handleCellularDownloadsChange = useCallback((nextMode: string) => {
        updateSettings({ allowCellularDownloads: nextMode === 'cellular' });
    }, []);

    const handleAdvancedInferenceControlsChange = useCallback((nextMode: string) => {
        updateSettings({ showAdvancedInferenceControls: nextMode === 'on' });
    }, []);

    const cellularDownloadOptions = [
        { key: 'wifi', label: t('settings.cellularDownloadsWifiOnly') },
        { key: 'cellular', label: t('settings.cellularDownloadsWifiAndCellular') },
    ];

    const advancedInferenceControlOptions = [
        { key: 'off', label: t('settings.advancedInferenceControlsOff') },
        { key: 'on', label: t('settings.advancedInferenceControlsOn') },
    ];

    const themeOptions = [
        { key: 'light', label: t('settings.themeLight'), testID: 'settings-theme-mode-light' },
        { key: 'system', label: t('settings.themeSystem'), testID: 'settings-theme-mode-system' },
        { key: 'dark', label: t('settings.themeDark'), testID: 'settings-theme-mode-dark' },
    ];

    const visualThemeOptions = [
        { key: 'default', label: t('settings.themeStyleDefault'), testID: 'settings-theme-style-default' },
        { key: 'glass', label: t('settings.themeStyleGlass'), testID: 'settings-theme-style-glass' },
    ];

    return (
        <ScreenRoot>
            <HeaderBar
                title={`${t('settings.title')}`}
                onBack={undefined}
                backAccessibilityLabel={t('chat.headerBackAccessibilityLabel')}
                backButtonTestID="settings-back-button"
                showBrand
                brandIconName="settings"
            />

            <ScrollView
                className="flex-1"
                showsVerticalScrollIndicator={false}
                contentContainerStyle={{
                    paddingTop: headerInset,
                    paddingBottom: tabBarInset,
                }}
            >
                <ScreenContent
                    testID="settings-screen-content"
                    respectFloatingHeader={false}
                    className="pt-3"
                    style={{ paddingBottom: screenLayoutMetrics.contentBottomInset }}
                >
                    <ScreenStack gap="default">
                        <Box>
                            <ScreenSectionLabel>{t('settings.resources')}</ScreenSectionLabel>
                            <ScreenStack className="mt-2" gap="compact">
                                <ScreenCard padding="compact">
                                    <Box className="flex-row items-start gap-3">
                                        <ScreenIconTile iconName="memory" tone="accent" iconClassName="text-primary-500" />
                                        <Box className="min-w-0 flex-1">
                                            <Text className="text-base font-semibold text-typography-900 dark:text-typography-100">
                                                {t('settings.memoryTitle')}
                                            </Text>
                                            <Text className="mt-1 text-sm leading-5 text-typography-500 dark:text-typography-400">
                                                {t(isSystemRamSource ? 'settings.memoryDescription' : 'settings.memoryDescriptionFallback')}
                                            </Text>
                                        </Box>
                                    </Box>

                                    <Box className="mt-4 flex-row items-start justify-between gap-3">
                                        <Box className="min-w-0 flex-1">
                                            <Text className="text-2xl font-extrabold tracking-tight text-typography-900 dark:text-typography-100">
                                                {ramPrimaryValue}
                                            </Text>
                                            <Text className="mt-0.5 text-xs leading-4 text-typography-500 dark:text-typography-400">
                                                {ramPrimaryLabel}
                                            </Text>
                                        </Box>

                                        <ScreenCard
                                            padding="none"
                                            className="self-start shrink-0 px-3 py-2.5"
                                        >
                                            <Text className="text-2xs font-semibold uppercase tracking-wide text-typography-500 dark:text-typography-400">
                                                {ramAsideLabel}
                                            </Text>
                                            <Text className="mt-1 text-sm font-extrabold text-primary-500">
                                                {ramAsideValue}
                                            </Text>
                                        </ScreenCard>
                                    </Box>

                                    <ScreenStack className="mt-4" gap="compact">
                                        {isSystemRamSource ? (
                                            <LayeredUsageMeter
                                                rows={[
                                                    {
                                                        label: t('settings.systemUsage'),
                                                        value: ramSystemUsageSummary,
                                                        color: memoryAccent,
                                                    },
                                                    {
                                                        label: t('settings.appMemory'),
                                                        value: ramAppUsageSummary,
                                                        color: memoryAccentSoft,
                                                    },
                                                ]}
                                                basePercentage={ramUsedTrackPercentage}
                                                baseFillColor={memoryAccent}
                                                overlayPercentage={ramAppTrackPercentage}
                                                overlayFillColor={memoryAccentSoft}
                                                trackBackground={trackBackground}
                                                labelColor={colors.textSecondary}
                                                valueColor={colors.text}
                                                trackTestID="settings-memory-track"
                                                baseTestID="settings-memory-used-fill"
                                                overlayTestID="settings-memory-app-fill"
                                            />
                                        ) : (
                                            <UsageMeter
                                                label={t('settings.appMemory')}
                                                value={ramAppUsageSummary}
                                                percentage={ramAppUsedPercentage}
                                                fillColor={memoryAccentSoft}
                                                trackBackground={trackBackground}
                                                labelColor={colors.textSecondary}
                                                valueColor={colors.text}
                                                testID="settings-memory-app-fill"
                                            />
                                        )}
                                    </ScreenStack>

                                    {canForceUnloadModel ? (
                                        <Box className={`mt-4 border-t pt-3 ${appearance.classNames.dividerClassName}`}>
                                            <Button
                                                onPress={unloadActiveModel}
                                                accessibilityRole="button"
                                                disabled={false}
                                                action="softDestructive"
                                                size="sm"
                                                className="self-start"
                                            >
                                                <MaterialSymbols name="close" size="lg" className="text-error-500" />
                                                <ButtonText>{t('settings.forceUnloadModel')}</ButtonText>
                                            </Button>
                                        </Box>
                                    ) : null}
                                </ScreenCard>

                                <ScreenCard padding="compact">
                                    <Box className="flex-row items-start gap-3">
                                        <ScreenIconTile iconName="storage" tone="success" />
                                        <Box className="min-w-0 flex-1">
                                            <Text className="text-base font-semibold text-typography-900 dark:text-typography-100">
                                                {t('settings.storageTitle')}
                                            </Text>
                                            <Text className="mt-1 text-sm leading-5 text-typography-500 dark:text-typography-400">
                                                {t('settings.storageDescription')}
                                            </Text>
                                        </Box>
                                    </Box>

                                    <Box className="mt-4 flex-row items-start justify-between gap-3">
                                        <Box className="min-w-0 flex-1">
                                            <Text className="text-2xl font-extrabold tracking-tight text-typography-900 dark:text-typography-100">
                                                {formatSystemCapacity(storageUsedBytes)}
                                            </Text>
                                            <Text className="mt-0.5 text-xs leading-4 text-typography-500 dark:text-typography-400">
                                                {t('settings.storageUsedOf', { total: formatSystemCapacity(storageTotalBytes) })}
                                            </Text>
                                        </Box>

                                        <ScreenCard
                                            padding="none"
                                            className="self-start shrink-0 px-3 py-2.5"
                                        >
                                            <Text className="text-2xs font-semibold uppercase tracking-wide text-typography-500 dark:text-typography-400">
                                                {t('settings.free')}
                                            </Text>
                                            <Text className="mt-1 text-sm font-extrabold text-success-600 dark:text-success-300">
                                                {formatSystemCapacity(storageFreeBytes)}
                                            </Text>
                                        </ScreenCard>
                                    </Box>

                                    <Box className="mt-4">
                                        <LayeredUsageMeter
                                            rows={[
                                                {
                                                    label: t('settings.systemUsage'),
                                                    value: storageSystemUsageSummary,
                                                    color: storageAccent,
                                                },
                                                {
                                                    label: t('settings.appFilesUsage'),
                                                    value: storageAppUsageSummary,
                                                    color: storageAccentSoft,
                                                },
                                            ]}
                                            basePercentage={storageUsedTrackPercentage}
                                            baseFillColor={storageAccent}
                                            overlayPercentage={storageAppTrackPercentage}
                                            overlayFillColor={storageAccentSoft}
                                            trackBackground={trackBackground}
                                            labelColor={colors.textSecondary}
                                            valueColor={colors.text}
                                            trackTestID="settings-storage-track"
                                            baseTestID="settings-storage-used-fill"
                                            overlayTestID="settings-storage-app-fill"
                                        />
                                    </Box>
                                </ScreenCard>
                            </ScreenStack>
                        </Box>

                        <Box>
                            <ScreenSectionLabel>{t('settings.appearance')}</ScreenSectionLabel>
                            <ScreenStack className="mt-2" gap="compact">
                                <ScreenCard padding="compact">
                                    <Box className="flex-row items-start gap-3">
                                        <ScreenIconTile iconName="palette" tone="info" />
                                        <Box className="min-w-0 flex-1">
                                            <Text className="text-base font-semibold text-typography-900 dark:text-typography-100">
                                                {t('settings.themeMode')}
                                            </Text>
                                            <Text className="mt-1 text-sm leading-5 text-typography-500 dark:text-typography-400">
                                                {t('settings.themeDescription')}
                                            </Text>
                                        </Box>
                                    </Box>

                                    <ScreenSegmentedControl
                                        className="mt-4"
                                        testID="settings-theme-mode-control"
                                        activeKey={mode}
                                        onChange={(nextMode) => setTheme(nextMode as typeof mode)}
                                        options={themeOptions}
                                    />
                                </ScreenCard>

                                <ScreenCard padding="compact">
                                    <Box className="flex-row items-start gap-3">
                                        <ScreenIconTile iconName="auto-awesome" tone="accent" />
                                        <Box className="min-w-0 flex-1">
                                            <Text className="text-base font-semibold text-typography-900 dark:text-typography-100">
                                                {t('settings.themeStyle')}
                                            </Text>
                                            <Text className="mt-1 text-sm leading-5 text-typography-500 dark:text-typography-400">
                                                {t('settings.themeStyleDescription')}
                                            </Text>
                                        </Box>
                                    </Box>

                                    <ScreenSegmentedControl
                                        className="mt-4"
                                        testID="settings-theme-style-control"
                                        activeKey={themeId}
                                        onChange={(nextThemeId) => setThemeId(nextThemeId as ThemeId)}
                                        options={visualThemeOptions}
                                    />
                                </ScreenCard>

                                <SettingsNavCard
                                    title={t('settings.language')}
                                    description={t('settings.languageDescription')}
                                    iconName="language"
                                    iconTone="accent"
                                    iconClassName="text-primary-500"
                                    trailingText={settings.language === 'en' ? t('settings.languageEnglish') : t('settings.languageRussian')}
                                    onPress={handleLanguagePress}
                                />
                            </ScreenStack>
                        </Box>

                        <Box>
                            <ScreenSectionLabel>{t('settings.systemConfiguration')}</ScreenSectionLabel>
                            <ScreenStack className="mt-2" gap="compact">
                                <ScreenCard padding="compact">
                                    <Box className="flex-row items-start gap-3">
                                        <ScreenIconTile iconName="cell-tower" tone="info" />
                                        <Box className="min-w-0 flex-1">
                                            <Text className="text-base font-semibold text-typography-900 dark:text-typography-100">
                                                {t('settings.cellularDownloads')}
                                            </Text>
                                            <Text className="mt-1 text-sm leading-5 text-typography-500 dark:text-typography-400">
                                                {t('settings.cellularDownloadsDescription')}
                                            </Text>
                                        </Box>
                                    </Box>

                                    <ScreenSegmentedControl
                                        className="mt-4"
                                        activeKey={settings.allowCellularDownloads ? 'cellular' : 'wifi'}
                                        onChange={handleCellularDownloadsChange}
                                        options={cellularDownloadOptions}
                                    />
                                </ScreenCard>
                                <ScreenCard padding="compact">
                                    <Box className="flex-row items-start gap-3">
                                        <ScreenIconTile iconName="model-training" tone="accent" iconClassName="text-primary-500" />
                                        <Box className="min-w-0 flex-1">
                                            <Text className="text-base font-semibold text-typography-900 dark:text-typography-100">
                                                {t('settings.advancedInferenceControls')}
                                            </Text>
                                            <Text className="mt-1 text-sm leading-5 text-typography-500 dark:text-typography-400">
                                                {t('settings.advancedInferenceControlsDescription')}
                                            </Text>
                                        </Box>
                                    </Box>

                                    <ScreenSegmentedControl
                                        className="mt-4"
                                        activeKey={settings.showAdvancedInferenceControls ? 'on' : 'off'}
                                        onChange={handleAdvancedInferenceControlsChange}
                                        options={advancedInferenceControlOptions}
                                    />
                                </ScreenCard>
                                <SettingsNavCard
                                    title={t('settings.presets')}
                                    description={t('settings.presetsDescription')}
                                    iconName="tune"
                                    iconTone="warning"
                                    onPress={handlePresetsPress}
                                />
                                <SettingsNavCard
                                    title={t('settings.storageManager')}
                                    description={t('settings.storageManagerDescription')}
                                    iconName="storage"
                                    iconTone="success"
                                    onPress={handleStorageManagerPress}
                                />
                                <SettingsNavCard
                                    title={t('settings.huggingFaceToken')}
                                    description={t('settings.huggingFaceTokenDescription')}
                                    iconName="key"
                                    iconTone="accent"
                                    iconClassName="text-primary-500"
                                    trailingText={hasHuggingFaceToken
                                        ? t('settings.huggingFaceTokenConfigured')
                                        : t('settings.huggingFaceTokenMissing')}
                                    onPress={handleHuggingFaceTokenPress}
                                />
                                <SettingsNavCard
                                    title={t('settings.privacyDisclosures')}
                                    description={t('settings.privacyDisclosuresDescription')}
                                    iconName="security"
                                    iconTone="accent"
                                    iconClassName="text-primary-500"
                                    onPress={handleLegalPress}
                                />
                                {typeof __DEV__ !== 'undefined' && __DEV__ ? (
                                    <SettingsNavCard
                                        title={t('settings.performance')}
                                        description={t('settings.performanceDescription')}
                                        iconName="speed"
                                        iconTone="info"
                                        onPress={handlePerformancePress}
                                    />
                                ) : null}
                            </ScreenStack>
                        </Box>
                    </ScreenStack>
                </ScreenContent>
            </ScrollView>
        </ScreenRoot>
    );
};
