import React from 'react';
import { Modal } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Box } from '@/components/ui/box';
import { Pressable } from '@/components/ui/pressable';
import { ScrollView } from '@/components/ui/scroll-view';
import { joinClassNames, ScreenBadge, ScreenCard, ScreenIconButton, ScreenModalOverlay, ScreenPressableCard, ScreenSheet } from '@/components/ui/ScreenShell';
import { Text } from '@/components/ui/text';
import { MaterialSymbols, type MaterialSymbolsProps } from './MaterialSymbols';
import { listRowSelectedClassName, screenLayoutTokens } from '../../utils/themeTokens';

export interface ListPickerSheetItem {
  key: string;
  title: string;
  description?: string;
  supportingText?: string;
  selected?: boolean;
  disabled?: boolean;
  onPress?: () => void;
  testID?: string;
  accessibilityLabel?: string;
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
  const isInteractive = typeof item.onPress === 'function' && !item.disabled;
  const cardClassName = joinClassNames(
    item.selected && listRowSelectedClassName,
    item.disabled && 'border-outline-100 bg-background-100/80 dark:border-outline-900 dark:bg-background-900/40',
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
              numberOfLines={item.supportingText ? 1 : 2}
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
  actions,
  items,
  emptyState,
  sheetClassName,
  testID,
}: ListPickerSheetContentProps) {
  const { t } = useTranslation();
  const activeLabel = t('common.active');

  return (
    <ScreenSheet testID={testID} className={joinClassNames(screenLayoutTokens.sheetMaxHeightCompactClassName, sheetClassName)}>
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
        <ScrollView showsVerticalScrollIndicator={false}>
          <Box className="gap-3 pb-2">
            {items.map((item) => (
              <ListPickerRow key={item.key} item={item} activeLabel={activeLabel} />
            ))}
          </Box>
        </ScrollView>
      ) : emptyState ? (
        <Box
          testID={emptyState.testID}
          className="min-h-[220px] flex-1 items-center justify-center rounded-2xl border border-dashed border-outline-200 px-5 py-8 dark:border-outline-800"
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
        </Box>
      ) : null}
    </ScreenSheet>
  );
}

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
