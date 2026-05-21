import React from 'react';
import { FlatList, Modal, StyleSheet, useWindowDimensions, type ListRenderItem } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Box } from '@/components/ui/box';
import { Pressable } from '@/components/ui/pressable';
import { joinClassNames, ScreenBadge, ScreenCard, ScreenIconButton, ScreenModalOverlay, ScreenPressableCard, ScreenSheet, useScreenAppearance } from '@/components/ui/ScreenShell';
import { Text } from '@/components/ui/text';
import { MaterialSymbols, type MaterialSymbolsProps } from './MaterialSymbols';
import type { AndroidBlurTargetRef } from '../../utils/androidBlur';
import { getNativeBottomSafeAreaInset } from '../../utils/safeArea';
import { screenLayoutMetrics, screenLayoutTokens } from '../../utils/themeTokens';

export interface ListPickerSheetItem {
  key: string;
  title: string;
  description?: string;
  supportingText?: string;
  badges?: ListPickerSheetBadge[];
  selected?: boolean;
  disabled?: boolean;
  onPress?: () => void;
  testID?: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityState?: React.ComponentProps<typeof Pressable>['accessibilityState'];
}

export interface ListPickerSheetBadge {
  key: string;
  label: string;
  tone?: 'neutral' | 'accent' | 'warning' | 'error' | 'success' | 'info';
  iconName?: MaterialSymbolsProps['name'];
  testID?: string;
}

export interface ListPickerSheetEmptyState {
  title: string;
  description: string;
  iconName?: MaterialSymbolsProps['name'];
  action?: React.ReactNode;
  testID?: string;
}

interface ListPickerSheetContentProps {
  title: string;
  subtitle?: string;
  onClose: () => void;
  androidContentBlurTargetRef?: AndroidBlurTargetRef | null;
  actions?: React.ReactNode;
  items: ListPickerSheetItem[];
  emptyState?: ListPickerSheetEmptyState;
  sheetClassName?: string;
  testID?: string;
}

interface ListPickerSheetProps extends ListPickerSheetContentProps {
  visible: boolean;
  modalAnimationType?: 'none' | 'slide' | 'fade';
}

function ListPickerRow({
  item,
  activeLabel,
}: {
  item: ListPickerSheetItem;
  activeLabel: string;
}) {
  const appearance = useScreenAppearance();
  const isInteractive = typeof item.onPress === 'function' && !item.disabled;
  const hasSupportingText = Boolean(item.supportingText);
  const hasBadges = (item.badges?.length ?? 0) > 0;
  const cardClassName = joinClassNames(
    item.selected && appearance.classNames.selectedInsetCardClassName,
    item.disabled && 'opacity-60',
  );
  const content = (
    <Box className="flex-row items-start justify-between gap-3">
      <Box className="min-w-0 flex-1">
        <Text
          numberOfLines={1}
          className={joinClassNames(
            'text-sm font-semibold',
            item.selected
              ? 'text-primary-600 dark:text-primary-400'
              : item.disabled
                ? 'text-typography-500 dark:text-typography-500'
                : 'text-typography-900 dark:text-typography-100',
          )}
        >
          {item.title}
        </Text>
        {item.description ? (
          <Text
            numberOfLines={hasSupportingText || hasBadges ? 1 : 2}
            className="mt-1 text-xs text-typography-500 dark:text-typography-400"
          >
            {item.description}
          </Text>
        ) : null}
        {item.supportingText ? (
          <Text
            numberOfLines={2}
            className="mt-2 text-sm text-typography-600 dark:text-typography-300"
          >
            {item.supportingText}
          </Text>
        ) : null}
        {hasBadges ? (
          <Box className="mt-2 flex-row flex-wrap items-center gap-2">
            {item.badges?.map((badge) => (
              <ScreenBadge
                key={badge.key}
                testID={badge.testID}
                tone={badge.tone ?? 'neutral'}
                size="micro"
                iconName={badge.iconName}
              >
                {badge.label}
              </ScreenBadge>
            ))}
          </Box>
        ) : null}
      </Box>

      {item.selected ? (
        <ScreenBadge tone="success" size="micro">
          {activeLabel}
        </ScreenBadge>
      ) : !isInteractive ? null : (
        <MaterialSymbols name="chevron-right" size="md" className="text-typography-400" />
      )}
    </Box>
  );
  if (!isInteractive) {
    return (
      <ScreenCard
        testID={item.testID}
        padding="compact"
        className={cardClassName}
      >
        {content}
      </ScreenCard>
    );
  }

  return (
    <ScreenPressableCard
      testID={item.testID}
      onPress={item.onPress}
      disabled={item.disabled}
      accessibilityLabel={item.accessibilityLabel ?? item.title}
      accessibilityHint={item.accessibilityHint}
      accessibilityRole="button"
      accessibilityState={{
        selected: item.selected === true,
        disabled: item.disabled === true,
        ...item.accessibilityState,
      }}
      padding="compact"
      className={cardClassName}
    >
      {content}
    </ScreenPressableCard>
  );
}

export function ListPickerSheetContent({
  title,
  subtitle,
  onClose,
  androidContentBlurTargetRef,
  actions,
  items,
  emptyState,
  sheetClassName,
  testID,
}: ListPickerSheetContentProps) {
  const { t } = useTranslation();
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const activeLabel = t('common.active');
  const nativeBottomInset = getNativeBottomSafeAreaInset(insets.bottom);
  const renderPickerItem = React.useCallback<ListRenderItem<ListPickerSheetItem>>(({ item }) => (
    <ListPickerRow item={item} activeLabel={activeLabel} />
  ), [activeLabel]);
  const renderPickerSeparator = React.useCallback(() => <Box className="h-3" />, []);
  const pickerListMaxHeight = React.useMemo(
    () => Math.max(240, Math.round(windowHeight * 0.64)),
    [windowHeight],
  );
  const pickerListContentStyle = React.useMemo(
    () => [
      styles.pickerListContent,
      { paddingBottom: screenLayoutMetrics.sheetBottomInset + nativeBottomInset },
    ],
    [nativeBottomInset],
  );

  return (
    <ScreenSheet
      testID={testID}
      className={joinClassNames(
        'min-h-0',
        screenLayoutTokens.sheetMaxHeightDefaultClassName,
        sheetClassName,
      )}
      style={styles.sheet}
      androidBlurTargetRef={androidContentBlurTargetRef}
    >
      <Box className="min-h-0 flex-shrink" style={styles.sheetContent}>
        <Box className="mb-4 flex-row items-center justify-between gap-3">
          <Box className="min-w-0 flex-1">
            <Text className="text-lg font-semibold text-typography-900 dark:text-typography-100">
              {title}
            </Text>
            {subtitle ? (
              <Text className="mt-1 text-sm text-typography-500 dark:text-typography-400">
                {subtitle}
              </Text>
            ) : null}
          </Box>
          <ScreenIconButton
            onPress={onClose}
            accessibilityLabel={t('common.cancel')}
            iconName="close"
          />
        </Box>

        {actions ? <Box className="mb-4 gap-3">{actions}</Box> : null}

        {items.length > 0 ? (
          <Box
            testID={testID ? `${testID}-list-container` : undefined}
            className="min-h-0"
            style={[styles.pickerListContainer, { maxHeight: pickerListMaxHeight }]}
          >
            <FlatList
              testID={testID ? `${testID}-list` : undefined}
              data={items}
              keyExtractor={(item) => item.key}
              renderItem={renderPickerItem}
              ItemSeparatorComponent={renderPickerSeparator}
              showsVerticalScrollIndicator={false}
              bounces={false}
              endFillColor="transparent"
              overScrollMode="never"
              style={styles.pickerList}
              contentContainerStyle={pickerListContentStyle}
            />
          </Box>
        ) : emptyState ? (
          <ScreenCard
            testID={emptyState.testID}
            dashed
            padding="none"
            className="min-h-[220px] flex-1 items-center justify-center px-5 py-8"
          >
            {emptyState.iconName ? (
              <MaterialSymbols
                name={emptyState.iconName}
                size="2xl"
                className="text-typography-400 dark:text-typography-500"
              />
            ) : null}
            <Text className="mt-3 text-center text-sm font-semibold text-typography-700 dark:text-typography-200">
              {emptyState.title}
            </Text>
            <Text className="mt-2 text-center text-sm text-typography-500 dark:text-typography-400">
              {emptyState.description}
            </Text>
            {emptyState.action ? <Box className="mt-4 w-full">{emptyState.action}</Box> : null}
          </ScreenCard>
        ) : null}
      </Box>
    </ScreenSheet>
  );
}

const styles = StyleSheet.create({
  sheet: {
    minHeight: 0,
    flexShrink: 1,
  },
  sheetContent: {
    alignSelf: 'stretch',
    minHeight: 0,
    flexShrink: 1,
  },
  pickerListContainer: {
    alignSelf: 'stretch',
    backgroundColor: 'transparent',
    minHeight: 0,
    flexShrink: 1,
  },
  pickerList: {
    backgroundColor: 'transparent',
    flexGrow: 0,
    flexShrink: 1,
    minHeight: 0,
  },
  pickerListContent: {
    backgroundColor: 'transparent',
  },
});

export function ListPickerSheet({
  visible,
  modalAnimationType = 'fade',
  ...contentProps
}: ListPickerSheetProps) {
  return (
    <Modal visible={visible} animationType={modalAnimationType} transparent onRequestClose={contentProps.onClose}>
      <ScreenModalOverlay>
        <Pressable className="flex-1" onPress={contentProps.onClose} />
        <ListPickerSheetContent {...contentProps} />
      </ScreenModalOverlay>
    </Modal>
  );
}
