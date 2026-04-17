import React from 'react';
import { Box } from './box';
import { MaterialSymbols } from './MaterialSymbols';
import { Pressable } from './pressable';
import { Text, composeTextRole } from './text';

export interface ValueSelectorRowProps {
  label: string;
  value: string;
  onPress?: () => void;
  showChevron?: boolean;
  disabled?: boolean;
  className?: string;
  testID?: string;
}

export function ValueSelectorRow({
  label,
  value,
  onPress,
  showChevron = false,
  disabled = false,
  className,
  testID,
}: ValueSelectorRowProps) {
  const isInteractive = typeof onPress === 'function' && !disabled;
  const containerClassName = [
    'min-h-11 flex-row items-center gap-3 rounded-2xl border border-outline-200 bg-background-50 px-3 py-2.5 dark:border-outline-700 dark:bg-background-900',
    disabled ? 'opacity-60' : '',
    className ?? '',
  ].filter(Boolean).join(' ');

  const content = (
    <>
      <Box className="min-w-0 flex-1 flex-row items-center justify-between gap-3">
        <Text className={composeTextRole('caption', 'shrink-0')}>
          {label}
        </Text>
        <Text numberOfLines={1} className={composeTextRole('body', 'min-w-0 flex-1 text-right')}>
          {value}
        </Text>
      </Box>
      {showChevron ? (
        <MaterialSymbols
          name="chevron-right"
          size="md"
          className="text-typography-400"
        />
      ) : null}
    </>
  );

  if (isInteractive) {
    return (
      <Pressable
        testID={testID}
        onPress={onPress}
        disabled={disabled}
        accessibilityRole="button"
        className={containerClassName}
      >
        {content}
      </Pressable>
    );
  }

  return (
    <Box testID={testID} className={containerClassName}>
      {content}
    </Box>
  );
}
