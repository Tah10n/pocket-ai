import React from 'react';
import { Box } from './box';
import { MaterialSymbols } from './MaterialSymbols';
import { joinClassNames, ScreenPressableSurface, ScreenSurface, useScreenAppearance } from './ScreenShell';
import { Text, composeTextRole } from './text';
import { cardPaddingByDensity, radiusTokens } from '../../utils/themeTokens';

export interface ValueSelectorRowProps {
  label?: string;
  value: string;
  badges?: React.ReactNode;
  onPress?: () => void;
  showChevron?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  className?: string;
  testID?: string;
}

export function ValueSelectorRow({
  label,
  value,
  badges,
  onPress,
  showChevron = false,
  disabled = false,
  accessibilityLabel,
  accessibilityHint,
  className,
  testID,
}: ValueSelectorRowProps) {
  const appearance = useScreenAppearance();
  const isInteractive = typeof onPress === 'function' && !disabled;
  const hasLabel = typeof label === 'string' && label.trim().length > 0;
  const hasAccessibilityText = Boolean(accessibilityLabel || accessibilityHint);
  const accessibilityState = disabled ? { disabled: true } : undefined;
  const accessibilityProps = {
    accessible: hasAccessibilityText ? true : undefined,
    accessibilityLabel,
    accessibilityHint,
    accessibilityState,
  };
  const containerClassName = joinClassNames(
    // DS-EXCEPTION: keep an explicit 44px min touch target for list rows.
    'min-h-[44px] flex-row items-center gap-3 border',
    appearance.classNames.toneClassNameByTone.neutral.surfaceClassName,
    radiusTokens.md,
    cardPaddingByDensity.compact,
    disabled ? 'opacity-60' : undefined,
    className,
  );

  const content = (
    <>
      <Box className="min-w-0 flex-1 flex-row items-center justify-between gap-3">
        {hasLabel ? (
          <Text className={composeTextRole('caption', 'shrink-0')}>
            {label}
          </Text>
        ) : null}
        <Box className={joinClassNames(
          'min-w-0 flex-1 flex-row flex-wrap items-center gap-1.5',
          hasLabel ? 'justify-end' : 'justify-start',
        )}>
          <Text
            numberOfLines={1}
            className={composeTextRole('body', joinClassNames(
              'min-w-0 shrink',
              hasLabel ? 'text-right' : 'text-left',
            ))}
          >
            {value}
          </Text>
          {badges}
        </Box>
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
      <ScreenPressableSurface
        testID={testID}
        onPress={onPress}
        disabled={disabled}
        accessible={hasAccessibilityText ? true : undefined}
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint}
        accessibilityRole="button"
        tone="neutral"
        className={containerClassName}
      >
        {content}
      </ScreenPressableSurface>
    );
  }

  return (
    <ScreenSurface
      {...accessibilityProps}
      testID={testID}
      tone="neutral"
      className={containerClassName}
    >
      {content}
    </ScreenSurface>
  );
}
