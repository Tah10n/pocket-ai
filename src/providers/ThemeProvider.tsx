import React, { createContext, useContext, useState, useEffect, useMemo } from 'react';
import { useColorScheme as useSystemColorScheme } from 'react-native';
import { useColorScheme as useNativewindColorScheme } from 'nativewind';
import { getSettings, subscribeSettings, updateSettings } from '../services/SettingsStore';

type ThemeMode = 'light' | 'dark' | 'system';
type ResolvedThemeMode = 'light' | 'dark';

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
    background: '#f6f6f8',
    surface: '#ffffff',
    text: '#0f172a',
    textSecondary: '#64748b',
    primary: '#3211d4',
    border: '#e2e8f0',
    error: '#ef4444',
    warning: '#f59e0b',
    success: '#10b981',
    inputBackground: '#ffffff',
};

const darkColors: ThemeColors = {
    background: '#131022',
    surface: '#0f172a',
    text: '#ffffff',
    textSecondary: '#94a3b8',
    primary: '#3211d4',
    border: '#1f2937',
    error: '#f87171',
    warning: '#fbbf24',
    success: '#34d399',
    inputBackground: '#0f172a',
};

interface ThemeContextValue {
    mode: ThemeMode;
    resolvedMode: ResolvedThemeMode;
    colors: ThemeColors;
    toggleTheme: () => void;
    setTheme: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
    mode: 'system',
    resolvedMode: 'light',
    colors: lightColors,
    toggleTheme: () => {},
    setTheme: () => {},
});

function resolveThemeMode(mode: ThemeMode, systemScheme: 'light' | 'dark' | null | undefined): ResolvedThemeMode {
    if (mode === 'system') {
        return systemScheme === 'dark' ? 'dark' : 'light';
    }

    return mode;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
    const systemScheme = useSystemColorScheme();
    const { setColorScheme } = useNativewindColorScheme();
    const [mode, setMode] = useState<ThemeMode>(() => getSettings().theme ?? 'system');

    const resolvedMode: ResolvedThemeMode = useMemo(() => {
        return resolveThemeMode(mode, systemScheme);
    }, [mode, systemScheme]);

    useEffect(() => {
        setColorScheme(mode);
    }, [mode, setColorScheme]);

    useEffect(() => {
        return subscribeSettings((nextSettings) => {
            setMode((currentMode) => (
                currentMode === nextSettings.theme ? currentMode : nextSettings.theme
            ));
        });
    }, []);

    const toggleTheme = () => {
        const nextMode = resolvedMode === 'dark' ? 'light' : 'dark';
        setMode(nextMode);
        updateSettings({ theme: nextMode });
    };

    const setTheme = (newMode: ThemeMode) => {
        setMode(newMode);
        updateSettings({ theme: newMode });
    };

    const colors = useMemo(() => (resolvedMode === 'dark' ? darkColors : lightColors), [resolvedMode]);

    return (
        <ThemeContext.Provider value={{ mode, resolvedMode, colors, toggleTheme, setTheme }}>
            {children}
        </ThemeContext.Provider>
    );
}

export const useTheme = () => useContext(ThemeContext);
