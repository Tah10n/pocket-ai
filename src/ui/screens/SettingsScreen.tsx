import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, Switch, Button } from 'react-native';
import Slider from '@react-native-community/slider';
import { getSettings, updateSettings, AppSettings } from '../../services/SettingsStore';
import { useTranslation } from 'react-i18next';
import { useNavigation } from '@react-navigation/native';

export function SettingsScreen() {
    const [settings, setSettings] = useState<AppSettings>(getSettings());
    const { t, i18n } = useTranslation();
    const navigation = useNavigation<any>();

    const handleChange = (key: keyof AppSettings, value: any) => {
        const updated = updateSettings({ [key]: value });
        setSettings(updated);
    };

    return (
        <ScrollView style={styles.container}>
            <Text style={styles.header}>Settings</Text>

            {/* Temperature */}
            <View style={styles.section}>
                <Text style={styles.label}>Temperature: {settings.temperature.toFixed(2)}</Text>
                <Text style={styles.hint}>Lower = more deterministic, Higher = more creative</Text>
                <Slider
                    style={styles.slider}
                    minimumValue={0}
                    maximumValue={2}
                    step={0.05}
                    value={settings.temperature}
                    onValueChange={(v) => handleChange('temperature', v)}
                    minimumTrackTintColor="#4CAF50"
                    maximumTrackTintColor="#ccc"
                />
            </View>

            {/* Top-P */}
            <View style={styles.section}>
                <Text style={styles.label}>Top-P: {settings.topP.toFixed(2)}</Text>
                <Text style={styles.hint}>Nucleus sampling probability</Text>
                <Slider
                    style={styles.slider}
                    minimumValue={0}
                    maximumValue={1}
                    step={0.05}
                    value={settings.topP}
                    onValueChange={(v) => handleChange('topP', v)}
                    minimumTrackTintColor="#2196F3"
                    maximumTrackTintColor="#ccc"
                />
            </View>

            {/* Max Tokens */}
            <View style={styles.section}>
                <Text style={styles.label}>Max Tokens: {settings.maxTokens}</Text>
                <Text style={styles.hint}>Maximum response length</Text>
                <Slider
                    style={styles.slider}
                    minimumValue={256}
                    maximumValue={4096}
                    step={128}
                    value={settings.maxTokens}
                    onValueChange={(v) => handleChange('maxTokens', Math.round(v))}
                    minimumTrackTintColor="#FF9800"
                    maximumTrackTintColor="#ccc"
                />
            </View>

            {/* Theme */}
            <View style={styles.section}>
                <Text style={styles.label}>{t('settings.darkMode') || 'Dark Mode'}</Text>
                <Switch
                    value={settings.theme === 'dark'}
                    onValueChange={(v) => handleChange('theme', v ? 'dark' : 'light')}
                />
            </View>

            {/* Language */}
            <View style={styles.section}>
                <Text style={styles.label}>{t('settings.language') || 'Language'}</Text>
                <View style={styles.buttonRow}>
                    <Button title="English" onPress={() => i18n.changeLanguage('en')} color={i18n.language === 'en' ? 'blue' : 'gray'} />
                    <Button title="Русский" onPress={() => i18n.changeLanguage('ru')} color={i18n.language === 'ru' ? 'blue' : 'gray'} />
                </View>
            </View>

            {/* Presets Management */}
            <View style={styles.section}>
                <Text style={styles.label}>{t('settings.presets') || 'System Prompt Presets'}</Text>
                <Button title="Manage Presets" onPress={() => navigation.navigate('PresetManager')} />
            </View>
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, padding: 16, backgroundColor: '#fff' },
    header: { fontSize: 24, fontWeight: 'bold', marginBottom: 24 },
    section: { marginBottom: 24, borderBottomWidth: 1, borderColor: '#eee', paddingBottom: 16 },
    label: { fontSize: 16, fontWeight: '600', marginBottom: 4 },
    hint: { fontSize: 12, color: '#888', marginBottom: 8 },
    slider: { width: '100%', height: 40 },
    buttonRow: { flexDirection: 'row', gap: 12, marginTop: 8 }
});
