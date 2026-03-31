import React, { useMemo } from 'react';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Box } from '@/components/ui/box';
import { HeaderBar } from '@/components/ui/HeaderBar';
import { MaterialSymbols } from '@/components/ui/MaterialSymbols';
import { ScreenCard, ScreenContent, ScreenStack } from '@/components/ui/ScreenShell';
import { ScrollView } from '@/components/ui/scroll-view';
import { Text } from '@/components/ui/text';

type SectionConfig = {
    id: string;
    icon: React.ComponentProps<typeof MaterialSymbols>['name'];
    iconWrapClassName: string;
    iconClassName: string;
    titleKey: string;
    bodyKey: string;
};

export function LegalScreen() {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();
    const router = useRouter();
    const canGoBack = router.canGoBack();
    const handleBack = React.useCallback(() => {
        if (canGoBack) {
            router.back();
            return;
        }

        router.replace('/(tabs)/settings' as any);
    }, [canGoBack, router]);

    const sections = useMemo<SectionConfig[]>(() => [
        {
            id: 'on-device',
            icon: 'computer',
            iconWrapClassName: 'bg-primary-500/10 dark:bg-primary-500/20',
            iconClassName: 'text-primary-500',
            titleKey: 'legal.onDeviceTitle',
            bodyKey: 'legal.onDeviceDescription',
        },
        {
            id: 'network',
            icon: 'cloud-download',
            iconWrapClassName: 'bg-info-500/10 dark:bg-info-500/20',
            iconClassName: 'text-info-600 dark:text-info-300',
            titleKey: 'legal.networkTitle',
            bodyKey: 'legal.networkDescription',
        },
        {
            id: 'storage',
            icon: 'storage',
            iconWrapClassName: 'bg-success-500/10 dark:bg-success-500/20',
            iconClassName: 'text-success-600 dark:text-success-300',
            titleKey: 'legal.storageTitle',
            bodyKey: 'legal.storageDescription',
        },
        {
            id: 'downloads',
            icon: 'file-download',
            iconWrapClassName: 'bg-warning-500/15 dark:bg-warning-500/25',
            iconClassName: 'text-warning-700 dark:text-warning-200',
            titleKey: 'legal.downloadsTitle',
            bodyKey: 'legal.downloadsDescription',
        },
        {
            id: 'resources',
            icon: 'memory',
            iconWrapClassName: 'bg-primary-500/10 dark:bg-primary-500/15',
            iconClassName: 'text-primary-600 dark:text-primary-300',
            titleKey: 'legal.resourcesTitle',
            bodyKey: 'legal.resourcesDescription',
        },
        {
            id: 'controls',
            icon: 'tune',
            iconWrapClassName: 'bg-success-500/10 dark:bg-success-500/20',
            iconClassName: 'text-success-700 dark:text-success-300',
            titleKey: 'legal.controlsTitle',
            bodyKey: 'legal.controlsDescription',
        },
    ], []);

    return (
        <Box className="flex-1 bg-background-0 dark:bg-background-950">
            <HeaderBar
                title={t('legal.title')}
                subtitle={t('legal.subtitle')}
                onBack={handleBack}
                backAccessibilityLabel={t('chat.headerBackAccessibilityLabel')}
                backButtonTestID="legal-back-button"
            />

            <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
                <ScreenContent className="pt-5" style={{ paddingBottom: insets.bottom + 32 }}>
                    <ScreenStack gap="loose">
                        <ScreenCard tone="accent" className="px-5 py-5">
                            <Text className="text-xs font-extrabold uppercase tracking-[0.18em] text-primary-500">
                                {t('legal.eyebrow')}
                            </Text>
                            <Text className="mt-3 text-2xl font-extrabold tracking-tight text-typography-900 dark:text-typography-100">
                                {t('legal.introTitle')}
                            </Text>
                            <Text className="mt-3 text-sm leading-6 text-typography-600 dark:text-typography-300">
                                {t('legal.introDescription')}
                            </Text>
                        </ScreenCard>

                        <ScreenStack>
                            {sections.map((section) => (
                                <ScreenCard key={section.id} testID={`legal-section-${section.id}`}>
                                    <Box className="flex-row items-start gap-3">
                                        <Box className={`h-11 w-11 items-center justify-center rounded-2xl ${section.iconWrapClassName}`}>
                                            <MaterialSymbols name={section.icon} size={20} className={section.iconClassName} />
                                        </Box>
                                        <Box className="min-w-0 flex-1">
                                            <Text className="text-base font-semibold text-typography-900 dark:text-typography-100">
                                                {t(section.titleKey)}
                                            </Text>
                                            <Text className="mt-1.5 text-sm leading-6 text-typography-600 dark:text-typography-300">
                                                {t(section.bodyKey)}
                                            </Text>
                                        </Box>
                                    </Box>
                                </ScreenCard>
                            ))}
                        </ScreenStack>
                    </ScreenStack>
                </ScreenContent>
            </ScrollView>
        </Box>
    );
}
