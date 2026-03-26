import React, { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialSymbols } from '@/components/ui/MaterialSymbols';
import { ScreenHeaderShell } from '@/components/ui/ScreenShell';
import { useTheme } from '../../providers/ThemeProvider';

const styles = StyleSheet.create({
    screen: { flex: 1, width: '100%', maxWidth: 768, alignSelf: 'center' },
    header: { borderBottomWidth: StyleSheet.hairlineWidth },
    headerBar: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16 },
    backButton: { height: 42, width: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
    headerTextWrap: { flex: 1 },
    headerTitle: { fontSize: 20, fontWeight: '700' },
    headerSubtitle: { marginTop: 2, fontSize: 12, lineHeight: 18 },
    content: { paddingHorizontal: 16, paddingTop: 20, paddingBottom: 32, gap: 16 },
    introCard: { borderWidth: 1, borderRadius: 24, padding: 18 },
    introEyebrow: { fontSize: 11, fontWeight: '800', letterSpacing: 0.8, textTransform: 'uppercase' },
    introTitle: { marginTop: 10, fontSize: 22, fontWeight: '800' },
    introBody: { marginTop: 8, fontSize: 14, lineHeight: 21 },
    sectionCard: { borderWidth: 1, borderRadius: 22, padding: 16 },
    sectionHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
    sectionIcon: { height: 42, width: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
    sectionTextWrap: { flex: 1 },
    sectionTitle: { fontSize: 16, fontWeight: '700' },
    sectionBody: { marginTop: 6, fontSize: 13, lineHeight: 19 },
});

type SectionConfig = {
    id: string;
    icon: string;
    iconBackground: string;
    iconColor: string;
    titleKey: string;
    bodyKey: string;
};

export function LegalScreen() {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();
    const router = useRouter();
    const { colors, resolvedMode } = useTheme();
    const canGoBack = router.canGoBack();

    const isDark = resolvedMode === 'dark';
    const cardBackground = isDark ? 'rgba(15, 23, 42, 0.72)' : colors.surface;
    const mutedBackground = isDark ? 'rgba(30, 41, 59, 0.85)' : '#eef2f7';

    const sections = useMemo<SectionConfig[]>(() => [
        {
            id: 'on-device',
            icon: 'computer',
            iconBackground: 'rgba(50, 17, 212, 0.12)',
            iconColor: colors.primary,
            titleKey: 'legal.onDeviceTitle',
            bodyKey: 'legal.onDeviceDescription',
        },
        {
            id: 'network',
            icon: 'cloud-download',
            iconBackground: 'rgba(14, 165, 233, 0.14)',
            iconColor: '#0284c7',
            titleKey: 'legal.networkTitle',
            bodyKey: 'legal.networkDescription',
        },
        {
            id: 'storage',
            icon: 'storage',
            iconBackground: 'rgba(20, 184, 166, 0.14)',
            iconColor: '#0f766e',
            titleKey: 'legal.storageTitle',
            bodyKey: 'legal.storageDescription',
        },
        {
            id: 'downloads',
            icon: 'file-download',
            iconBackground: 'rgba(245, 158, 11, 0.18)',
            iconColor: colors.warning,
            titleKey: 'legal.downloadsTitle',
            bodyKey: 'legal.downloadsDescription',
        },
        {
            id: 'resources',
            icon: 'memory',
            iconBackground: 'rgba(79, 70, 229, 0.14)',
            iconColor: '#4f46e5',
            titleKey: 'legal.resourcesTitle',
            bodyKey: 'legal.resourcesDescription',
        },
        {
            id: 'controls',
            icon: 'tune',
            iconBackground: 'rgba(34, 197, 94, 0.14)',
            iconColor: '#15803d',
            titleKey: 'legal.controlsTitle',
            bodyKey: 'legal.controlsDescription',
        },
    ], [colors.primary, colors.warning]);

    return (
        <View style={{ flex: 1, backgroundColor: colors.background }}>
            <ScreenHeaderShell>
                <View style={styles.headerBar}>
                    <Pressable
                        testID="legal-back-button"
                        onPress={() => {
                            if (canGoBack) {
                                router.back();
                                return;
                            }
                            router.replace('/(tabs)/settings' as any);
                        }}
                        style={[styles.backButton, { backgroundColor: mutedBackground }]}
                    >
                        <MaterialSymbols name="arrow-back-ios-new" size={18} color={colors.primary} />
                    </Pressable>
                    <View style={styles.headerTextWrap}>
                        <Text style={[styles.headerTitle, { color: colors.text }]}>{t('legal.title')}</Text>
                        <Text style={[styles.headerSubtitle, { color: colors.textSecondary }]}>{t('legal.subtitle')}</Text>
                    </View>
                </View>
            </ScreenHeaderShell>

            <View style={styles.screen}>
                <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
                    <View style={[styles.introCard, { backgroundColor: cardBackground, borderColor: colors.border }]}>
                        <Text style={[styles.introEyebrow, { color: colors.primary }]}>{t('legal.eyebrow')}</Text>
                        <Text style={[styles.introTitle, { color: colors.text }]}>{t('legal.introTitle')}</Text>
                        <Text style={[styles.introBody, { color: colors.textSecondary }]}>{t('legal.introDescription')}</Text>
                    </View>

                    {sections.map((section) => (
                        <View
                            key={section.id}
                            testID={`legal-section-${section.id}`}
                            style={[styles.sectionCard, { backgroundColor: cardBackground, borderColor: colors.border }]}
                        >
                            <View style={styles.sectionHeader}>
                                <View style={[styles.sectionIcon, { backgroundColor: section.iconBackground }]}>
                                    <MaterialSymbols name={section.icon as any} size={20} color={section.iconColor} />
                                </View>
                                <View style={styles.sectionTextWrap}>
                                    <Text style={[styles.sectionTitle, { color: colors.text }]}>{t(section.titleKey)}</Text>
                                    <Text style={[styles.sectionBody, { color: colors.textSecondary }]}>{t(section.bodyKey)}</Text>
                                </View>
                            </View>
                        </View>
                    ))}
                </ScrollView>
            </View>
        </View>
    );
}
