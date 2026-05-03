import React, { useMemo } from 'react';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Box } from '@/components/ui/box';
import { HeaderBar } from '@/components/ui/HeaderBar';
import { MaterialSymbols } from '@/components/ui/MaterialSymbols';
import { ScreenCard, ScreenContent, ScreenIconTile, ScreenRoot, ScreenStack } from '@/components/ui/ScreenShell';
import { ScrollView } from '@/components/ui/scroll-view';
import { Text } from '@/components/ui/text';
import { type ThemeTone } from '@/utils/themeTokens';

type SectionConfig = {
    id: string;
    icon: React.ComponentProps<typeof MaterialSymbols>['name'];
    tone: ThemeTone;
    iconClassName?: string;
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

        router.replace('/(tabs)/settings');
    }, [canGoBack, router]);

    const sections = useMemo<SectionConfig[]>(() => [
        {
            id: 'on-device',
            icon: 'computer',
            tone: 'accent',
            iconClassName: 'text-primary-500',
            titleKey: 'legal.onDeviceTitle',
            bodyKey: 'legal.onDeviceDescription',
        },
        {
            id: 'network',
            icon: 'cloud-download',
            tone: 'info',
            titleKey: 'legal.networkTitle',
            bodyKey: 'legal.networkDescription',
        },
        {
            id: 'storage',
            icon: 'storage',
            tone: 'success',
            titleKey: 'legal.storageTitle',
            bodyKey: 'legal.storageDescription',
        },
        {
            id: 'downloads',
            icon: 'file-download',
            tone: 'warning',
            titleKey: 'legal.downloadsTitle',
            bodyKey: 'legal.downloadsDescription',
        },
        {
            id: 'resources',
            icon: 'memory',
            tone: 'accent',
            titleKey: 'legal.resourcesTitle',
            bodyKey: 'legal.resourcesDescription',
        },
        {
            id: 'controls',
            icon: 'tune',
            tone: 'success',
            titleKey: 'legal.controlsTitle',
            bodyKey: 'legal.controlsDescription',
        },
    ], []);

    return (
        <ScreenRoot>
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
                            <Text className="text-xs font-extrabold uppercase tracking-wide text-primary-500">
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
                                        <ScreenIconTile iconName={section.icon} tone={section.tone} iconSize={20} size="lg" iconClassName={section.iconClassName} />
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
        </ScreenRoot>
    );
}
