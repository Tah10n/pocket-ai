import React from 'react';
import { Box } from './box';
import { MaterialSymbols } from './MaterialSymbols';
import { joinClassNames, ScreenPressableSurface, ScreenSurface } from './ScreenShell';
import { Text, composeTextRole } from './text';
import { valueSelectorRowGeometryByDensity } from './controlGeometry';

export interface ValueSelectorRowProps {
  density?: 'default' | 'compact';
  label?: string;
  value: string;
  leading?: React.ReactNode;
  badges?: React.ReactNode;
  onPress?: () => void;
  showChevron?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityValue?: React.ComponentProps<typeof ScreenPressableSurface>['accessibilityValue'];
  className?: string;
  testID?: string;
}

export function ValueSelectorRow({
  density = 'default',
  label,
  value,
  leading,
  badges,
  onPress,
  showChevron = false,
  disabled = false,
  accessibilityLabel,
  accessibilityHint,
  accessibilityValue,
  className,
  testID,
}: ValueSelectorRowProps) {
  const isInteractive = typeof onPress === 'function' && !disabled;
  const hasLabel = typeof label === 'string' && label.trim().length > 0;
  const hasAccessibilityText = Boolean(accessibilityLabel || accessibilityHint);
  const accessibilityState = disabled ? { disabled: true } : undefined;
  const accessibilityProps = {
    accessible: hasAccessibilityText ? true : undefined,
    accessibilityLabel,
    accessibilityHint,
    accessibilityValue,
    accessibilityState,
  };
  const containerClassName = joinClassNames(
    'flex-row items-center gap-3',
    disabled ? 'opacity-60' : undefined,
    className,
  );

  const content = (
    <>
      {leading}
      <Box className="min-w-0 flex-1 flex-row items-center justify-between gap-3">
        {hasLabel ? (
          <Text colorRole="tertiary" className={composeTextRole('caption', 'shrink-0')}>
            {label}
          </Text>
        ) : null}
        <Box className={joinClassNames(
          'min-w-0 flex-1 flex-row flex-wrap items-center gap-1.5',
          hasLabel ? 'justify-end' : 'justify-start',
        )}>
          <Text colorRole="primary"
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
        <MaterialSymbols colorRole="tertiary"
          name="chevron-right"
          size="md"
          className=""
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
        accessibilityValue={accessibilityValue}
        accessibilityRole="button"
        material={{ role: 'control', variant: 'inline', tone: 'neutral' }}
        shape="md"
        className={containerClassName}
        style={valueSelectorRowGeometryByDensity[density]}
      >
        {content}
      </ScreenPressableSurface>
    );
  }

  return (
    <ScreenSurface
      {...accessibilityProps}
      testID={testID}
      material={{ role: 'control', variant: 'inline', tone: 'neutral' }}
      shape="md"
      className={containerClassName}
      style={valueSelectorRowGeometryByDensity[density]}
    >
      {content}
    </ScreenSurface>
  );
}
