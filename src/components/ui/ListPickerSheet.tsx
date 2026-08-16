import React from 'react';
import { FlatList, Modal, StyleSheet, useWindowDimensions, type ListRenderItem } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Box } from '@/components/ui/box';
import { Pressable } from '@/components/ui/pressable';
import { joinClassNames, ScreenBadge, ScreenCard, ScreenIconButton, ScreenIconTile, ScreenModalOverlay, ScreenPressableCard, ScreenSheet } from '@/components/ui/ScreenShell';
import { Text } from '@/components/ui/text';
import { MaterialSymbols, type MaterialSymbolsProps } from './MaterialSymbols';
import type { AndroidBlurTargetRef } from '../../utils/androidBlur';
import { getNativeBottomSafeAreaInset } from '../../utils/safeArea';
import { screenLayoutMetrics, screenLayoutTokens } from '../../utils/themeTokens';

export interface ListPickerSheetItem {
  key: string;
  title: string;
  leading?: React.ReactNode;
  description?: string;
  supportingText?: string;
  badges?: ListPickerSheetBadge[];
  iconName?: MaterialSymbolsProps['name'];
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
  const hasAction = typeof item.onPress === 'function';
  const isInteractive = hasAction && !item.disabled;
  const hasSupportingText = Boolean(item.supportingText);
  const hasBadges = (item.badges?.length ?? 0) > 0;
  const hasSecondaryContent = Boolean(item.description) || hasSupportingText || hasBadges;
  const rowAlignmentClassName = hasSecondaryContent ? 'items-start' : 'items-center';
  const cardClassName = item.disabled ? 'opacity-60' : undefined;
  const content = (
    <Box
      testID={item.testID ? `${item.testID}-content` : undefined}
      className={joinClassNames('flex-row justify-between gap-3', rowAlignmentClassName)}
    >
      <Box
        testID={item.testID ? `${item.testID}-body` : undefined}
        className={joinClassNames('min-w-0 flex-1 flex-row gap-3', rowAlignmentClassName)}
      >
        {item.leading ?? (item.iconName ? (
          <ScreenIconTile
            iconName={item.iconName}
            tone="neutral"
            iconSize="sm"
            size="sm"
            className={hasSecondaryContent ? 'mt-0.5 h-9 w-9' : 'h-9 w-9 self-center'}
            testID={item.testID ? `${item.testID}-leading-icon` : undefined}
          />
        ) : null)}
        <Box className="min-w-0 flex-1">
          <Text colorRole={item.selected ? 'accent' : 'primary'}
            numberOfLines={1}
            className="text-sm font-semibold"
          >
            {item.title}
          </Text>
          {item.description ? (
            <Text colorRole="tertiary"
              numberOfLines={hasSupportingText || hasBadges ? 1 : 2}
              className="mt-1 text-xs  "
            >
              {item.description}
            </Text>
          ) : null}
          {item.supportingText ? (
            <Text colorRole="secondary"
              numberOfLines={2}
              className="mt-2 text-sm  "
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
      </Box>

      {item.selected ? (
        <ScreenBadge tone="success" size="micro">
          {activeLabel}
        </ScreenBadge>
      ) : !isInteractive ? null : (
        <MaterialSymbols colorRole="tertiary" name="chevron-right" size="md" className="" />
      )}
    </Box>
  );
  if (!hasAction) {
    return (
      <ScreenCard
        testID={item.testID}
        padding="compact"
        tone={item.selected ? 'accent' : 'default'}
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
      tone={item.selected ? 'accent' : 'default'}
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
            <Text colorRole="primary" className="text-lg font-semibold  ">
              {title}
            </Text>
            {subtitle ? (
              <Text colorRole="tertiary" className="mt-1 text-sm  ">
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
              <MaterialSymbols colorRole="tertiary"
                name={emptyState.iconName}
                size="2xl"
                className=" "
              />
            ) : null}
            <Text colorRole="secondary" className="mt-3 text-center text-sm font-semibold  ">
              {emptyState.title}
            </Text>
            <Text colorRole="tertiary" className="mt-2 text-center text-sm  ">
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
