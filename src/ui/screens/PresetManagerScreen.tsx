import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Modal } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { Input, InputField } from '@/components/ui/input';
import { MaterialSymbols } from '@/components/ui/MaterialSymbols';
import { Pressable } from '@/components/ui/pressable';
import { ScrollView } from '@/components/ui/scroll-view';
import { Text } from '@/components/ui/text';
import { useTranslation } from 'react-i18next';
import { presetManager, SystemPromptPreset } from '../../services/PresetManager';
import { getSettings, subscribeSettings, updateSettings } from '../../services/SettingsStore';
import { typographyColors } from '../../utils/themeTokens';
import { getReportedErrorMessage } from '../../services/AppError';

interface EditorState {
    preset: SystemPromptPreset | null;
    visible: boolean;
}

export function PresetManagerScreen() {
    const [presets, setPresets] = useState<SystemPromptPreset[]>([]);
    const [activePresetId, setActivePresetId] = useState<string | null>(() => getSettings().activePresetId);
    const [editorState, setEditorState] = useState<EditorState>({ preset: null, visible: false });
    const [draftName, setDraftName] = useState('');
    const [draftPrompt, setDraftPrompt] = useState('');

    const { t } = useTranslation();

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
            <Pressable
                onPress={() => openEditPreset(item)}
                className={`mb-3 rounded-2xl border px-4 py-4 active:opacity-80 ${
                    isActive
                        ? 'border-primary-500/40 bg-primary-500/10 dark:border-primary-400'
                        : 'border-outline-200 bg-background-0 dark:border-outline-800 dark:bg-background-950'
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
                                <Box className="rounded-full bg-primary-500/15 px-2 py-1">
                                    <Text className="text-xs font-semibold uppercase tracking-wide text-primary-600 dark:text-primary-400">
                                        {t('common.active')}
                                    </Text>
                                </Box>
                            ) : null}
                        </Box>
                    </Box>

                    <MaterialSymbols name="chevron-right" size={20} className="text-typography-400" />
                </Box>
            </Pressable>
        );
    }, [activePresetId, openEditPreset, t]);

    return (
        <Box className="flex-1 bg-background-0 dark:bg-background-950">
            <Box className="border-b border-outline-200 px-4 pb-4 pt-4 dark:border-outline-800">
                <Box className="flex-row items-center justify-between gap-3">
                    <Box className="flex-1">
                        <Text className="text-2xl font-bold text-typography-900 dark:text-typography-100">
                            {t('settings.presets')}
                        </Text>
                        <Text className="mt-1 text-sm text-typography-500 dark:text-typography-400">
                            {t('presets.activePreset', { name: activePresetName })}
                        </Text>
                    </Box>

                    <Pressable
                        onPress={openCreatePreset}
                        className="flex-row items-center gap-2 rounded-full bg-primary-500 px-4 py-2 active:opacity-80"
                    >
                        <MaterialSymbols name="add" size={18} className="text-typography-0" />
                        <Text className="text-sm font-semibold text-typography-0">{t('presets.addPreset')}</Text>
                    </Pressable>
                </Box>
            </Box>

            <Box className="flex-1 px-4 pb-8 pt-4">
                <FlashList
                    data={presets}
                    keyExtractor={(item) => item.id}
                    renderItem={renderItem}
                />
            </Box>

            <Modal visible={editorState.visible} animationType="slide" transparent onRequestClose={closeEditor}>
                <Box className="flex-1 justify-end bg-black/40">
                    <Pressable className="flex-1" onPress={closeEditor} />
                    <Box className="max-h-[88%] rounded-t-3xl bg-background-0 px-5 pb-8 pt-5 dark:bg-background-950">
                        <Box className="mb-4 flex-row items-center justify-between gap-3">
                            <Box className="flex-1">
                                <Text className="text-lg font-semibold text-typography-900 dark:text-typography-100">
                                    {editorTitle}
                                </Text>
                                <Text className="mt-1 text-sm text-typography-500 dark:text-typography-400">
                                    {t('presets.editorDescription')}
                                </Text>
                            </Box>

                            {!isCreatingPreset ? (
                                <Pressable
                                    onPress={handleDelete}
                                    className="h-10 w-10 items-center justify-center rounded-full bg-error-500/10 active:opacity-80"
                                >
                                    <MaterialSymbols name="delete" size={18} className="text-error-600" />
                                </Pressable>
                            ) : null}
                        </Box>

                        <ScrollView showsVerticalScrollIndicator={false}>
                            <Box className="pb-2">
                                <Text className="mb-2 text-xs font-semibold uppercase tracking-wide text-typography-500 dark:text-typography-400">
                                    {t('presets.nameLabel')}
                                </Text>
                                <Input className="mb-4">
                                    <InputField
                                        placeholder={t('presets.namePlaceholder')}
                                        placeholderTextColor={typographyColors[500]}
                                        value={draftName}
                                        onChangeText={setDraftName}
                                        className="p-3 text-typography-900 dark:text-typography-100"
                                    />
                                </Input>

                                <Text className="mb-2 text-xs font-semibold uppercase tracking-wide text-typography-500 dark:text-typography-400">
                                    {t('presets.systemPromptLabel')}
                                </Text>
                                <Input className="min-h-40">
                                    <InputField
                                        placeholder={t('presets.systemPromptPlaceholder')}
                                        placeholderTextColor={typographyColors[500]}
                                        multiline
                                        value={draftPrompt}
                                        onChangeText={setDraftPrompt}
                                        className="min-h-40 p-3 text-typography-900 dark:text-typography-100"
                                        textAlignVertical="top"
                                    />
                                </Input>
                            </Box>
                        </ScrollView>

                        <Box className="mt-5 flex-row gap-3">
                            <Button action="primary" className="flex-1" onPress={handleSaveAndActivate}>
                                <ButtonText>{t('presets.saveAndActivate')}</ButtonText>
                            </Button>
                            <Button action="secondary" className="flex-1" onPress={closeEditor}>
                                <ButtonText>{t('common.cancel')}</ButtonText>
                            </Button>
                        </Box>
                    </Box>
                </Box>
            </Modal>
        </Box>
    );
}
