import React, { useState, useEffect } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet } from 'react-native';
import { presetManager, SystemPromptPreset } from '../../services/PresetManager';
import { updateSettings, getSettings } from '../../services/SettingsStore';
import { useTheme } from '../../providers/ThemeProvider';

interface Props {
    onPresetSelected?: (preset: SystemPromptPreset) => void;
}

export function PresetSelector({ onPresetSelected }: Props) {
    const [presets, setPresets] = useState<SystemPromptPreset[]>([]);
    const [activeId, setActiveId] = useState<string | null>(null);
    const { colors } = useTheme();

    useEffect(() => {
        setPresets(presetManager.getPresets());
        setActiveId(getSettings().activePresetId);
    }, []);

    const handleSelect = (preset: SystemPromptPreset) => {
        setActiveId(preset.id);
        updateSettings({ activePresetId: preset.id });
        onPresetSelected?.(preset);
    };

    return (
        <View style={[styles.container, { backgroundColor: colors.surface }]}>
            <Text style={[styles.title, { color: colors.text }]}>Choose a Role</Text>
            <FlatList
                data={presets}
                keyExtractor={(item) => item.id}
                horizontal
                showsHorizontalScrollIndicator={false}
                renderItem={({ item }) => (
                    <TouchableOpacity
                        style={[
                            styles.chip,
                            { borderColor: colors.border },
                            activeId === item.id && { backgroundColor: colors.primary, borderColor: colors.primary },
                        ]}
                        onPress={() => handleSelect(item)}
                    >
                        <Text
                            style={[
                                styles.chipText,
                                { color: colors.text },
                                activeId === item.id && { color: '#fff' },
                            ]}
                        >
                            {item.name}
                        </Text>
                    </TouchableOpacity>
                )}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    container: { padding: 12 },
    title: { fontSize: 16, fontWeight: '600', marginBottom: 8 },
    chip: {
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderRadius: 20,
        borderWidth: 1,
        marginRight: 8,
    },
    chipText: { fontSize: 14 },
});
