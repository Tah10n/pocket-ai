import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useColorScheme as useSystemColorScheme } from 'react-native';
import { useColorScheme as useNativewindColorScheme } from 'nativewind';
import { getSettings, subscribeSettings, updateSettings } from '../services/SettingsStore';
import {
    DEFAULT_THEME_ID,
    createNavigationTheme,
    getThemeAppearance,
    getThemeColors,
    type ThemeAppearance,
    type ThemeId,
    type ResolvedThemeMode,
    type ThemeColors,
    type ThemeMode,
} from '../utils/themeTokens';

interface ThemeContextValue {
    mode: ThemeMode;
    themeId: ThemeId;
    resolvedMode: ResolvedThemeMode;
    colors: ThemeColors;
    appearance: ThemeAppearance;
    navigationTheme: ReturnType<typeof createNavigationTheme>;
    toggleTheme: () => void;
    setTheme: (mode: ThemeMode) => void;
    setThemeId: (themeId: ThemeId) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
    mode: 'system',
    themeId: DEFAULT_THEME_ID,
    resolvedMode: 'light',
    colors: getThemeColors('light'),
    appearance: getThemeAppearance(DEFAULT_THEME_ID, 'light'),
    navigationTheme: createNavigationTheme('light'),
    toggleTheme: () => {},
    setTheme: () => {},
    setThemeId: () => {},
});

type SystemColorScheme = ReturnType<typeof useSystemColorScheme>;

function resolveThemeMode(mode: ThemeMode, systemScheme: SystemColorScheme): ResolvedThemeMode {
    if (mode === 'system') {
        return systemScheme === 'dark' ? 'dark' : 'light';
    }

    return mode;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
    const systemScheme = useSystemColorScheme();
    const { setColorScheme } = useNativewindColorScheme();
    const [mode, setMode] = useState<ThemeMode>(() => getSettings().theme ?? 'system');
    const [themeId, setThemeIdState] = useState<ThemeId>(() => getSettings().themeId ?? DEFAULT_THEME_ID);

    const resolvedMode: ResolvedThemeMode = useMemo(() => {
        return resolveThemeMode(mode, systemScheme);
    }, [mode, systemScheme]);

    const colors = useMemo(() => getThemeColors(resolvedMode, themeId), [resolvedMode, themeId]);
    const appearance = useMemo(() => getThemeAppearance(themeId, resolvedMode), [resolvedMode, themeId]);
    const navigationTheme = useMemo(() => createNavigationTheme(resolvedMode, themeId), [resolvedMode, themeId]);

    useEffect(() => {
        setColorScheme(mode);
    }, [mode, setColorScheme]);

    useEffect(() => {
        return subscribeSettings((nextSettings) => {
            const nextThemeId = nextSettings.themeId ?? DEFAULT_THEME_ID;
            setMode((currentMode) => (
                currentMode === nextSettings.theme ? currentMode : nextSettings.theme
            ));
            setThemeIdState((currentThemeId) => (
                currentThemeId === nextThemeId ? currentThemeId : nextThemeId
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

    const setThemeId = (newThemeId: ThemeId) => {
        setThemeIdState(newThemeId);
        updateSettings({ themeId: newThemeId });
    };

    return (
        <ThemeContext.Provider value={{ mode, themeId, resolvedMode, colors, appearance, navigationTheme, toggleTheme, setTheme, setThemeId }}>
            {children}
        </ThemeContext.Provider>
    );
}

export const useTheme = () => useContext(ThemeContext);
