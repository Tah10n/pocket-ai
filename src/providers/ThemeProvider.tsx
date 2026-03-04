import React, { createContext, useContext, useState, useEffect, useMemo } from 'react';
import { useColorScheme as useSystemColorScheme, StyleSheet } from 'react-native';
import { getSettings, updateSettings } from '../services/SettingsStore';

type ThemeMode = 'light' | 'dark';

interface ThemeColors {
    background: string;
    surface: string;
    text: string;
    textSecondary: string;
    primary: string;
    border: string;
    error: string;
    warning: string;
    success: string;
    inputBackground: string;
}

const lightColors: ThemeColors = {
    background: '#F5F5F5',
    surface: '#FFFFFF',
    text: '#1A1A1A',
    textSecondary: '#6B6B6B',
    primary: '#007AFF',
    border: '#E5E5E5',
    error: '#FF3B30',
    warning: '#FF9500',
    success: '#34C759',
    inputBackground: '#FFFFFF',
};

const darkColors: ThemeColors = {
    background: '#000000',
    surface: '#1C1C1E',
    text: '#FFFFFF',
    textSecondary: '#8E8E93',
    primary: '#0A84FF',
    border: '#38383A',
    error: '#FF453A',
    warning: '#FF9F0A',
    success: '#30D158',
    inputBackground: '#2C2C2E',
};

interface ThemeContextValue {
    mode: ThemeMode;
    colors: ThemeColors;
    toggleTheme: () => void;
    setTheme: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
    mode: 'light',
    colors: lightColors,
    toggleTheme: () => { },
    setTheme: () => { },
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
    const systemScheme = useSystemColorScheme();
    const [mode, setMode] = useState<ThemeMode>(() => {
        const settings = getSettings();
        if (settings.theme === 'system') {
            return systemScheme === 'dark' ? 'dark' : 'light';
        }
        return settings.theme === 'dark' ? 'dark' : 'light';
    });

    useEffect(() => {
        const settings = getSettings();
        if (settings.theme === 'system') {
            setMode(systemScheme === 'dark' ? 'dark' : 'light');
        }
    }, [systemScheme]);

    const toggleTheme = () => {
        const newMode = mode === 'light' ? 'dark' : 'light';
        setMode(newMode);
        updateSettings({ theme: newMode });
    };

    const setTheme = (newMode: ThemeMode) => {
        setMode(newMode);
        updateSettings({ theme: newMode });
    };

    const colors = useMemo(() => (mode === 'dark' ? darkColors : lightColors), [mode]);

    return (
        <ThemeContext.Provider value={{ mode, colors, toggleTheme, setTheme }}>
            {children}
        </ThemeContext.Provider>
    );
}

export const useTheme = () => useContext(ThemeContext);
