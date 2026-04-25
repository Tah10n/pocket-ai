import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Modal } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { MaterialSymbols } from '@/components/ui/MaterialSymbols';
import { ScreenActionPill, ScreenBadge, ScreenCard, ScreenContent, ScreenIconButton, ScreenPressableCard, ScreenRoot, ScreenTextField, useScreenAppearance } from '@/components/ui/ScreenShell';
import { HeaderBar } from '@/components/ui/HeaderBar';
import { ScrollView } from '@/components/ui/scroll-view';
import { Text } from '@/components/ui/text';
import { useTranslation } from 'react-i18next';
import { presetManager, SystemPromptPreset } from '../../services/PresetManager';
import { getSettings, subscribeSettings, updateSettings } from '../../services/SettingsStore';
import { getReportedErrorMessage } from '../../services/AppError';
import { toTestIdSegment } from '../../utils/testIds';

interface EditorState {
    preset: SystemPromptPreset | null;
    visible: boolean;
}

export function PresetManagerScreen() {
    const router = useRouter();
    const [presets, setPresets] = useState<SystemPromptPreset[]>([]);
    const [activePresetId, setActivePresetId] = useState<string | null>(() => getSettings().activePresetId);
    const [editorState, setEditorState] = useState<EditorState>({ preset: null, visible: false });
    const [draftName, setDraftName] = useState('');
    const [draftPrompt, setDraftPrompt] = useState('');

    const { t } = useTranslation();
    const appearance = useScreenAppearance();
    const insets = useSafeAreaInsets();

    useEffect(() => {
        loadPresets();
    }, []);

    useEffect(() => {
        return subscribeSettings((settings) => {
            setActivePresetId(settings.activePresetId);
        });
    }, []);

    const loadPresets = () => {
        setPresets(presetManager.getPresets());
    };

    const isCreatingPreset = editorState.preset == null;
    const editorTitle = isCreatingPreset ? t('presets.createTitle') : editorState.preset?.name ?? t('presets.editTitle');
    const activePresetName = useMemo(
        () => presets.find((preset) => preset.id === activePresetId)?.name ?? t('common.default'),
        [activePresetId, presets, t],
    );

    const openCreatePreset = useCallback(() => {
        setDraftName('');
        setDraftPrompt('');
        setEditorState({ preset: null, visible: true });
    }, []);

    const openEditPreset = useCallback((preset: SystemPromptPreset) => {
        setDraftName(preset.name);
        setDraftPrompt(preset.systemPrompt);
        setEditorState({ preset, visible: true });
    }, []);

    const closeEditor = useCallback(() => {
        setEditorState({ preset: null, visible: false });
        setDraftName('');
        setDraftPrompt('');
    }, []);

    const handleBack = useCallback(() => {
        if (router.canGoBack()) {
            router.back();
            return;
        }

        router.replace('/(tabs)/settings');
    }, [router]);

    const handleSaveAndActivate = () => {
        const trimmedName = draftName.trim();
        const trimmedPrompt = draftPrompt.trim();

        if (!trimmedName || !trimmedPrompt) {
            Alert.alert(t('presets.validationErrorTitle'), t('presets.validationErrorMessage'));
            return;
        }

        try {
            let presetIdToActivate = editorState.preset?.id ?? null;

            if (editorState.preset) {
                const updated = presetManager.updatePreset(editorState.preset.id, {
                    name: trimmedName,
                    systemPrompt: trimmedPrompt,
                });
                presetIdToActivate = updated.id;
            } else if (!editorState.preset) {
                const created = presetManager.addPreset(trimmedName, trimmedPrompt);
                presetIdToActivate = created.id;
            }

            updateSettings({ activePresetId: presetIdToActivate });
            loadPresets();
            closeEditor();
        } catch (e: any) {
            Alert.alert(
                t('presets.validationErrorTitle'),
                getReportedErrorMessage('PresetManagerScreen.handleSaveAndActivate', e, t),
            );
        }
    };

    const handleDelete = () => {
        const preset = editorState.preset;
        if (!preset) {
            return;
        }

        Alert.alert(t('presets.deleteTitle'), t('presets.deleteConfirm'), [
            { text: t('common.cancel'), style: 'cancel' },
            {
                text: t('common.delete'),
                style: 'destructive',
                onPress: () => {
                    presetManager.deletePreset(preset.id);
                    if (getSettings().activePresetId === preset.id) {
                        updateSettings({ activePresetId: null });
                    }
                    loadPresets();
                    closeEditor();
                },
            },
        ]);
    };

    const renderItem = useCallback(({ item }: { item: SystemPromptPreset }) => {
        const isActive = item.id === activePresetId;

        return (
            <ScreenPressableCard
                testID={`preset-card-${toTestIdSegment(item.id)}`}
                onPress={() => openEditPreset(item)}
                padding="compact"
                className={`active:opacity-80 ${
                    isActive
                        ? appearance.classNames.selectedInsetCardClassName
                        : ''
                }`}
            >
                <Box className="flex-row items-start justify-between gap-3">
                    <Box className="min-w-0 flex-1">
                        <Text className="text-base font-bold text-typography-900 dark:text-typography-100">
                            {item.name}
                        </Text>
                        <Text className="mt-1 text-sm text-typography-600 dark:text-typography-400" numberOfLines={3}>
                            {item.systemPrompt}
                        </Text>
                        <Box className="mt-3 flex-row items-center gap-2">
                            {isActive ? (
                                <ScreenBadge tone="success" size="micro">
                                    {t('common.active')}
                                </ScreenBadge>
                            ) : null}
                        </Box>
                    </Box>

                    <MaterialSymbols name="chevron-right" size="lg" className="text-typography-400" />
                </Box>
            </ScreenPressableCard>
        );
    }, [activePresetId, appearance.classNames.selectedInsetCardClassName, openEditPreset, t]);

    const renderEmptyState = useCallback(() => (
        <Box className="flex-1 justify-center py-6">
            <ScreenCard dashed padding="compact" className="items-center">
                <Text className="text-center text-base font-semibold text-typography-900 dark:text-typography-100">
                    {t('presets.emptyTitle')}
                </Text>
                <Text className="mt-2 text-center text-sm leading-5 text-typography-500 dark:text-typography-400">
                    {t('presets.emptyDescription')}
                </Text>
            </ScreenCard>
        </Box>
    ), [t]);

    return (
        <ScreenRoot>
            <HeaderBar
                title={t('settings.presets')}
                subtitle={t('presets.activePreset', { name: activePresetName })}
                onBack={handleBack}
                backAccessibilityLabel={t('chat.headerBackAccessibilityLabel')}
                backButtonTestID="preset-manager-back-button"
                rightAccessory={(
                    <ScreenActionPill
                        onPress={openCreatePreset}
                        tone="primary"
                        size="lg"
                        testID="preset-manager-add-preset"
                    >
                        <MaterialSymbols name="add" size="sm" className="text-typography-0" />
                        <Text className="text-sm font-semibold text-typography-0">{t('presets.addPreset')}</Text>
                    </ScreenActionPill>
                )}
            />

            <ScreenContent className="flex-1 pt-2">
                <FlashList
                    data={presets}
                    keyExtractor={(item) => item.id}
                    renderItem={renderItem}
                    ListEmptyComponent={renderEmptyState}
                    ItemSeparatorComponent={() => <Box className="h-2" />}
                    contentContainerStyle={{ flexGrow: 1, paddingBottom: insets.bottom + 24 }}
                />
            </ScreenContent>

            <Modal
                visible={editorState.visible}
                animationType="slide"
                presentationStyle="fullScreen"
                onRequestClose={closeEditor}
            >
                <ScreenRoot>
                    <HeaderBar
                        title={editorTitle}
                        subtitle={t('presets.editorDescription')}
                        onBack={closeEditor}
                        backAccessibilityLabel={t('common.cancel')}
                        rightAccessory={!isCreatingPreset ? (
                            <ScreenIconButton
                                testID="preset-editor-delete"
                                onPress={handleDelete}
                                iconName="delete"
                                tone="danger"
                                accessibilityLabel={t('common.delete')}
                            />
                        ) : undefined}
                    />

                    <ScreenContent className="flex-1 pt-2">
                        <ScrollView
                            className="flex-1"
                            showsVerticalScrollIndicator={false}
                            keyboardShouldPersistTaps="handled"
                            contentContainerStyle={{ flexGrow: 1 }}
                        >
                            <Box className="flex-1 pb-2">
                                <ScreenTextField
                                    label={t('presets.nameLabel')}
                                    size="prominent"
                                    placeholder={t('presets.namePlaceholder')}
                                    testID="preset-editor-name"
                                    value={draftName}
                                    onChangeText={setDraftName}
                                />

                                <ScreenTextField
                                    label={t('presets.systemPromptLabel')}
                                    containerClassName="mt-5 flex-1"
                                    fieldClassName="flex-1"
                                    size="prominentMultiline"
                                    placeholder={t('presets.systemPromptPlaceholder')}
                                    testID="preset-editor-prompt"
                                    value={draftPrompt}
                                    onChangeText={setDraftPrompt}
                                />
                            </Box>
                        </ScrollView>
                    </ScreenContent>

                    <ScreenContent className="pt-4" includeBottomSafeArea>
                        <Box className="flex-row gap-3">
                            <Button action="primary" className="flex-1" testID="preset-editor-save" onPress={handleSaveAndActivate}>
                                <ButtonText>{t('presets.saveAndActivate')}</ButtonText>
                            </Button>
                            <Button action="secondary" className="flex-1" testID="preset-editor-cancel" onPress={closeEditor}>
                                <ButtonText>{t('common.cancel')}</ButtonText>
                            </Button>
                        </Box>
                    </ScreenContent>
                </ScreenRoot>
            </Modal>
        </ScreenRoot>
    );
}
