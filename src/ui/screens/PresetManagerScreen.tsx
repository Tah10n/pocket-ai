import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, FlatList, TextInput, Button, Alert } from 'react-native';
import { presetManager, SystemPromptPreset } from '../../services/PresetManager';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../providers/ThemeProvider';

export function PresetManagerScreen() {
    const [presets, setPresets] = useState<SystemPromptPreset[]>([]);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editName, setEditName] = useState('');
    const [editPrompt, setEditPrompt] = useState('');

    const { t } = useTranslation();
    const { colors } = useTheme();

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
        <View style={[styles.card, { borderColor: colors.border, backgroundColor: colors.surface }]}>
            <View style={styles.cardHeader}>
                <Text style={[styles.title, { color: colors.text }]}>{item.name} {item.isBuiltIn && '(Built-in)'}</Text>
                {!item.isBuiltIn && (
                    <View style={styles.actions}>
                        <Button title={t('common.edit')} onPress={() => startEditing(item)} />
                        <Button title={t('common.delete')} color="red" onPress={() => handleDelete(item.id)} />
                    </View>
                )}
            </View>
            <Text style={[styles.promptText, { color: colors.text }]} numberOfLines={3}>
                {item.systemPrompt}
            </Text>
        </View>
    );

    return (
        <View style={[styles.container, { backgroundColor: colors.background }]}>
            <Text style={[styles.header, { color: colors.text }]}>{t('settings.presets')}</Text>

            <View style={[styles.editor, { borderColor: colors.border, backgroundColor: colors.surface }]}>
                <TextInput
                    style={[styles.input, { borderColor: colors.border, color: colors.text }]}
                    placeholder="Preset Name"
                    placeholderTextColor="#888"
                    value={editName}
                    onChangeText={setEditName}
                />
                <TextInput
                    style={[styles.input, { borderColor: colors.border, height: 80, color: colors.text }]}
                    placeholder="System Prompt"
                    placeholderTextColor="#888"
                    multiline
                    value={editPrompt}
                    onChangeText={setEditPrompt}
                />
                <View style={styles.editorActions}>
                    <Button title={editingId ? t('common.save') : t('common.add')} onPress={handleSave} />
                    {editingId && (
                        <Button title={t('common.cancel')} onPress={() => { setEditingId(null); setEditName(''); setEditPrompt(''); }} color="gray" />
                    )}
                </View>
            </View>

            <FlatList
                data={presets}
                keyExtractor={item => item.id}
                renderItem={renderItem}
                contentContainerStyle={styles.list}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1 },
    header: { fontSize: 24, fontWeight: 'bold', padding: 16 },
    list: { paddingHorizontal: 16, paddingBottom: 32 },
    card: { borderWidth: 1, borderRadius: 8, padding: 16, marginBottom: 12 },
    cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
    title: { fontSize: 16, fontWeight: 'bold' },
    actions: { flexDirection: 'row', gap: 8 },
    promptText: { fontSize: 14, opacity: 0.8 },
    editor: { padding: 16, borderWidth: 1, margin: 16, borderRadius: 8 },
    input: { borderWidth: 1, borderRadius: 4, padding: 8, marginBottom: 12 },
    editorActions: { flexDirection: 'row', justifyContent: 'flex-start', gap: 12 }
});
