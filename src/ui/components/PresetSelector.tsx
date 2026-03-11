import React, { useState, useEffect } from 'react';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { FlashList } from '@shopify/flash-list';
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
        <Box className="flex-row items-center justify-between px-4 h-16 bg-background-0/80 dark:bg-background-950/80">
            <Text className="text-base font-semibold mb-2 text-typography-900">Choose a Role</Text>
            <FlashList
                data={presets}
                keyExtractor={(item) => item.id}
                horizontal
                showsHorizontalScrollIndicator={false}
                renderItem={({ item }) => (
                    <Pressable
                        className={`px-4 py-2 rounded-full border mr-2 ${
                            activeId === item.id 
                                ? 'bg-primary-500 border-primary-500' 
                                : 'bg-transparent border-outline-300 dark:border-outline-700'
                        }`}
                        onPress={() => handleSelect(item)}
                    >
                        <Text
                            className={`text-sm ${
                                activeId === item.id 
                                    ? 'text-typography-0' 
                                    : 'text-typography-900'
                            }`}
                        >
                            {item.name}
                        </Text>
                    </Pressable>
                )}
            />
        </Box>
    );
}
