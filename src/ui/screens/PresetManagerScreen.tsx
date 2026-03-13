import React, { useState, useEffect } from 'react';
import { Alert } from 'react-native';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { Input, InputField } from '@/components/ui/input';
import { Button, ButtonText } from '@/components/ui/button';
import { FlashList } from '@shopify/flash-list';
import { presetManager, SystemPromptPreset } from '../../services/PresetManager';
import { useTranslation } from 'react-i18next';
import { typographyColors } from '../../utils/themeTokens';

export function PresetManagerScreen() {
    const [presets, setPresets] = useState<SystemPromptPreset[]>([]);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editName, setEditName] = useState('');
    const [editPrompt, setEditPrompt] = useState('');

    const { t } = useTranslation();

    useEffect(() => {
        loadPresets();
    }, []);

    const loadPresets = () => {
        setPresets(presetManager.getPresets());
    };

    const handleSave = () => {
        if (!editName.trim() || !editPrompt.trim()) {
            Alert.alert('Error', 'Name and Prompt cannot be empty');
            return;
        }

        try {
            if (editingId) {
                presetManager.updatePreset(editingId, { name: editName, systemPrompt: editPrompt });
            } else {
                presetManager.addPreset(editName, editPrompt);
            }
            setEditingId(null);
            setEditName('');
            setEditPrompt('');
            loadPresets();
        } catch (e: any) {
            Alert.alert('Error', e.message);
        }
    };

    const handleDelete = (id: string) => {
        Alert.alert('Delete', 'Are you sure?', [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Delete',
                style: 'destructive',
                onPress: () => {
                    presetManager.deletePreset(id);
                    loadPresets();
                }
            }
        ]);
    };

    const startEditing = (preset: SystemPromptPreset) => {
        if (preset.isBuiltIn) {
            Alert.alert('Info', 'Built-in presets cannot be edited.');
            return;
        }
        setEditingId(preset.id);
        setEditName(preset.name);
        setEditPrompt(preset.systemPrompt);
    };

    const renderItem = ({ item }: { item: SystemPromptPreset }) => (
        <Box className="border border-outline-200 dark:border-outline-800 rounded-lg p-4 mb-3 bg-background-0 dark:bg-background-950">
            <Box className="flex-row justify-between items-center mb-2">
                <Text className="text-base font-bold text-typography-900 dark:text-typography-100">{item.name} {item.isBuiltIn && '(Built-in)'}</Text>
                {!item.isBuiltIn && (
                    <Box className="flex-row gap-2">
                        <Button action="primary" size="sm" onPress={() => startEditing(item)}>
                            <ButtonText>{t('common.edit')}</ButtonText>
                        </Button>
                        <Button action="negative" size="sm" onPress={() => handleDelete(item.id)}>
                            <ButtonText>{t('common.delete')}</ButtonText>
                        </Button>
                    </Box>
                )}
            </Box>
            <Text className="text-sm opacity-80 text-typography-700 dark:text-typography-400" numberOfLines={3}>
                {item.systemPrompt}
            </Text>
        </Box>
    );

    return (
        <Box className="flex-1 bg-background-0 dark:bg-background-950">
            <Text className="text-2xl font-bold p-4 text-typography-900 dark:text-typography-100">{t('settings.presets')}</Text>

            <Box className="p-4 border border-outline-200 dark:border-outline-800 m-4 rounded-lg bg-background-0 dark:bg-background-950">
                <Input className="mb-3">
                    <InputField
                        placeholder="Preset Name"
                        placeholderTextColor={typographyColors[500]}
                        value={editName}
                        onChangeText={setEditName}
                        className="text-typography-900 dark:text-typography-100 p-2"
                    />
                </Input>
                <Input className="h-20 mb-3">
                    <InputField
                        placeholder="System Prompt"
                        placeholderTextColor={typographyColors[500]}
                        multiline
                        value={editPrompt}
                        onChangeText={setEditPrompt}
                        className="text-typography-900 dark:text-typography-100 p-2"
                        textAlignVertical="top"
                    />
                </Input>
                <Box className="flex-row justify-start gap-3">
                    <Button action="primary" onPress={handleSave}>
                        <ButtonText>{editingId ? t('common.save') : t('common.add')}</ButtonText>
                    </Button>
                    {editingId && (
                        <Button action="secondary" onPress={() => { setEditingId(null); setEditName(''); setEditPrompt(''); }}>
                            <ButtonText>{t('common.cancel')}</ButtonText>
                        </Button>
                    )}
                </Box>
            </Box>

            <Box className="flex-1 px-4 pb-8">
                <FlashList
                    data={presets}
                    keyExtractor={item => item.id}
                    renderItem={renderItem}
                />
            </Box>
        </Box>
    );
}
