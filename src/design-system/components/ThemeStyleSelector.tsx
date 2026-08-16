import React, { useCallback, useMemo, useState } from 'react';
import { StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Box } from '@/components/ui/box';
import { ListPickerSheet, type ListPickerSheetItem } from '@/components/ui/ListPickerSheet';
import { ValueSelectorRow } from '@/components/ui/ValueSelectorRow';
import type { ThemeMetadata, ThemePreviewTokens } from '../themes/contract';

interface ThemePreviewSwatchProps {
  preview: ThemePreviewTokens;
  testID: string;
  compact?: boolean;
}

function ThemePreviewSwatch({ preview, testID, compact = false }: ThemePreviewSwatchProps) {
  return (
    <Box
      testID={testID}
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={[
        styles.preview,
        compact ? styles.previewCompact : styles.previewRow,
        { backgroundColor: preview.canvas, borderColor: preview.accent },
      ]}
    >
      <Box style={[styles.previewSurface, { backgroundColor: preview.surface }]}>
        <Box style={[styles.previewAccent, { backgroundColor: preview.accent }]} />
      </Box>
    </Box>
  );
}

export interface ThemeStyleSelectorProps<Id extends string> {
  themes: readonly ThemeMetadata<Id>[];
  activeThemeId: Id;
  onChange: (themeId: Id) => void;
  testID?: string;
}

export function ThemeStyleSelector<Id extends string>({
  themes,
  activeThemeId,
  onChange,
  testID = 'settings-theme-style-control',
}: ThemeStyleSelectorProps<Id>) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const selectedTheme = useMemo(
    () => themes.find((theme) => theme.id === activeThemeId),
    [activeThemeId, themes],
  );
  const selectedLabel = selectedTheme ? t(selectedTheme.labelKey) : '';
  const closePicker = useCallback(() => setVisible(false), []);
  const openPicker = useCallback(() => setVisible(true), []);
  const items = useMemo<ListPickerSheetItem[]>(() => themes.map((theme) => {
    const label = t(theme.labelKey);

    return {
      key: theme.id,
      title: label,
      description: theme.descriptionKey ? t(theme.descriptionKey) : undefined,
      leading: (
        <ThemePreviewSwatch
          preview={theme.preview}
          testID={`settings-theme-style-${theme.id}-preview`}
        />
      ),
      selected: theme.id === activeThemeId,
      testID: `settings-theme-style-${theme.id}`,
      accessibilityLabel: label,
      accessibilityHint: t('settings.themeStyleOptionHint', { theme: label }),
      onPress: () => {
        setVisible(false);
        onChange(theme.id);
      },
    };
  }), [activeThemeId, onChange, t, themes]);

  return (
    <>
      <ValueSelectorRow
        testID={testID}
        className="mt-4"
        value={selectedLabel}
        leading={selectedTheme ? (
          <ThemePreviewSwatch
            compact
            preview={selectedTheme.preview}
            testID={`${testID}-preview`}
          />
        ) : undefined}
        onPress={openPicker}
        disabled={!selectedTheme}
        showChevron
        accessibilityLabel={t('settings.themeStyle')}
        accessibilityHint={t('settings.themeStylePickerHint')}
        accessibilityValue={selectedTheme ? { text: selectedLabel } : undefined}
      />

      <ListPickerSheet
        visible={visible}
        title={t('settings.themeStylePickerTitle')}
        subtitle={t('settings.themeStyleDescription')}
        onClose={closePicker}
        items={items}
        testID="settings-theme-style-sheet"
      />
    </>
  );
}

const styles = StyleSheet.create({
  preview: {
    flexShrink: 0,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    padding: 4,
  },
  previewCompact: {
    width: 38,
    height: 30,
    borderRadius: 10,
  },
  previewRow: {
    width: 46,
    height: 38,
    borderRadius: 12,
  },
  previewSurface: {
    flex: 1,
    justifyContent: 'flex-end',
    overflow: 'hidden',
    borderRadius: 7,
    padding: 3,
  },
  previewAccent: {
    width: '58%',
    height: 5,
    borderRadius: 999,
  },
});
