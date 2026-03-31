import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useColorScheme as useSystemColorScheme } from 'react-native';
import { useColorScheme as useNativewindColorScheme } from 'nativewind';
import { getSettings, subscribeSettings, updateSettings } from '../services/SettingsStore';
import {
    createNavigationTheme,
    getThemeColors,
    type ResolvedThemeMode,
    type ThemeColors,
    type ThemeMode,
} from '../utils/themeTokens';

interface ThemeContextValue {
    mode: ThemeMode;
    resolvedMode: ResolvedThemeMode;
    colors: ThemeColors;
    navigationTheme: ReturnType<typeof createNavigationTheme>;
    toggleTheme: () => void;
    setTheme: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
    mode: 'system',
    resolvedMode: 'light',
    colors: getThemeColors('light'),
    navigationTheme: createNavigationTheme('light'),
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

    const colors = useMemo(() => getThemeColors(resolvedMode), [resolvedMode]);
    const navigationTheme = useMemo(() => createNavigationTheme(resolvedMode), [resolvedMode]);

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

    return (
        <ThemeContext.Provider value={{ mode, resolvedMode, colors, navigationTheme, toggleTheme, setTheme }}>
            {children}
        </ThemeContext.Provider>
    );
}

export const useTheme = () => useContext(ThemeContext);
