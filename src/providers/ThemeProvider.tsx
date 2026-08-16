import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useColorScheme as useSystemColorScheme } from 'react-native';
import { useColorScheme as useNativewindColorScheme } from 'nativewind';
import { getSettings, subscribeSettings, updateSettings } from '../services/SettingsStore';
import type { ResolvedTheme } from '../design-system/themes/contract';
import type {
    ResolvedThemeMode,
    ThemeAppearance,
    ThemeColors,
    ThemeMode,
} from '../design-system/themes/legacyTheme';
import { DEFAULT_THEME_ID, type ThemeId } from '../design-system/themes/registry';
import { resolveTheme } from '../design-system/themes/resolver';

interface ThemeContextValue {
    mode: ThemeMode;
    themeId: ThemeId;
    resolvedMode: ResolvedThemeMode;
    colors: ThemeColors;
    appearance: ThemeAppearance;
    resolvedTheme: ResolvedTheme<ThemeId>;
    navigationTheme: ResolvedTheme<ThemeId>['navigationTheme'];
    toggleTheme: () => void;
    setTheme: (mode: ThemeMode) => void;
    setThemeId: (themeId: ThemeId) => void;
}

const defaultResolvedTheme = resolveTheme(DEFAULT_THEME_ID, 'light');

const ThemeContext = createContext<ThemeContextValue>({
    mode: 'system',
    themeId: DEFAULT_THEME_ID,
    resolvedMode: 'light',
    colors: defaultResolvedTheme.colors,
    appearance: defaultResolvedTheme.appearance,
    resolvedTheme: defaultResolvedTheme,
    navigationTheme: defaultResolvedTheme.navigationTheme,
    toggleTheme: () => {},
    setTheme: () => {},
    setThemeId: () => {},
});

type SystemColorScheme = ReturnType<typeof useSystemColorScheme>;

const noopThemeAction = () => {};

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

    const resolvedTheme = useMemo(() => resolveTheme(themeId, resolvedMode), [resolvedMode, themeId]);
    const { colors, appearance, navigationTheme } = resolvedTheme;

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

    const toggleTheme = useCallback(() => {
        const nextMode = resolvedMode === 'dark' ? 'light' : 'dark';
        setMode(nextMode);
        updateSettings({ theme: nextMode });
    }, [resolvedMode]);

    const setTheme = useCallback((newMode: ThemeMode) => {
        setMode(newMode);
        updateSettings({ theme: newMode });
    }, []);

    const setThemeId = useCallback((newThemeId: ThemeId) => {
        setThemeIdState(newThemeId);
        updateSettings({ themeId: newThemeId });
    }, []);

    const value = useMemo<ThemeContextValue>(() => ({
        mode,
        themeId,
        resolvedMode,
        colors,
        appearance,
        resolvedTheme,
        navigationTheme,
        toggleTheme,
        setTheme,
        setThemeId,
    }), [appearance, colors, mode, navigationTheme, resolvedMode, resolvedTheme, setTheme, setThemeId, themeId, toggleTheme]);

    return (
        <ThemeContext.Provider value={value}>
            {children}
        </ThemeContext.Provider>
    );
}

type StaticThemeProviderProps = {
    children: React.ReactNode;
    resolvedMode: ResolvedThemeMode;
    mode?: ThemeMode;
    themeId?: ThemeId;
    resolvedTheme?: ResolvedTheme<ThemeId>;
};

export function StaticThemeProvider({
    children,
    resolvedMode,
    mode = 'system',
    themeId = DEFAULT_THEME_ID,
    resolvedTheme: resolvedThemeOverride,
}: StaticThemeProviderProps) {
    const { setColorScheme } = useNativewindColorScheme();
    const resolvedTheme = useMemo(
        () => resolvedThemeOverride ?? resolveTheme(themeId, resolvedMode),
        [resolvedMode, resolvedThemeOverride, themeId],
    );
    const { colors, appearance, navigationTheme } = resolvedTheme;
    const effectiveResolvedMode = resolvedTheme.mode;
    const effectiveThemeId = resolvedTheme.id;

    useEffect(() => {
        setColorScheme(effectiveResolvedMode);
    }, [effectiveResolvedMode, setColorScheme]);

    const value = useMemo<ThemeContextValue>(() => ({
        mode,
        themeId: effectiveThemeId,
        resolvedMode: effectiveResolvedMode,
        colors,
        appearance,
        resolvedTheme,
        navigationTheme,
        toggleTheme: noopThemeAction,
        setTheme: noopThemeAction,
        setThemeId: noopThemeAction,
    }), [appearance, colors, effectiveResolvedMode, effectiveThemeId, mode, navigationTheme, resolvedTheme]);

    return (
        <ThemeContext.Provider value={value}>
            {children}
        </ThemeContext.Provider>
    );
}

export const useTheme = () => useContext(ThemeContext);
