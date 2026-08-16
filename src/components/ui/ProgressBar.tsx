import React from 'react';
import { Box } from '@/components/ui/box';
import { Surface } from '@/design-system/materials/Surface';
import { useTheme } from '@/providers/ThemeProvider';

type ProgressBarSize = 'sm' | 'md' | 'lg';
type ProgressBarTone = 'neutral' | 'primary' | 'success' | 'warning' | 'error';
type ProgressBarVariant = 'plain' | 'framed';

interface ProgressBarProps {
  valuePercent: number;
  size?: ProgressBarSize;
  tone?: ProgressBarTone;
  variant?: ProgressBarVariant;
  className?: string;
  fillClassName?: string;
  fillTone?: ProgressBarTone;
  testID?: string;
  fillTestID?: string;
}

const trackHeightClassNameBySize: Record<ProgressBarSize, string> = {
  sm: 'h-1.5',
  md: 'h-2',
  lg: 'h-2.5',
};

const framedTrackHeightClassNameBySize: Record<ProgressBarSize, string> = {
  sm: 'h-3',
  md: 'h-3.5',
  lg: 'h-4',
};

const framedFillHeightClassNameBySize: Record<ProgressBarSize, string> = {
  sm: 'h-2',
  md: 'h-2.5',
  lg: 'h-3',
};

function joinClassNames(...values: (string | undefined | false)[]) {
  return values.filter(Boolean).join(' ');
}

function clampProgressPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(100, value));
}

export function ProgressBar({
  valuePercent,
  size = 'md',
  tone = 'neutral',
  variant = 'plain',
  className,
  fillClassName,
  fillTone,
  testID,
  fillTestID,
}: ProgressBarProps) {
  const { colors } = useTheme();
  const clampedPercent = clampProgressPercent(valuePercent);
  const isFramed = variant === 'framed';
  const containerRadiusClassName = 'relative w-full overflow-hidden rounded-full';
  const progressFill = (
    <Box
      testID={fillTestID}
      className={joinClassNames(
        'relative overflow-hidden rounded-full',
        isFramed ? framedFillHeightClassNameBySize[size] : 'h-full',
        fillClassName,
      )}
      style={{
        width: `${clampedPercent}%`,
        ...(!fillClassName ? { backgroundColor: colors.progressFillByTone[fillTone ?? tone] } : null),
      }}
    />
  );
  const sharedProps = {
    testID,
    accessibilityRole: 'progressbar' as const,
    accessibilityValue: { min: 0, max: 100, now: clampedPercent },
    className: joinClassNames(
      containerRadiusClassName,
      isFramed ? 'justify-center p-0.5' : undefined,
      isFramed ? framedTrackHeightClassNameBySize[size] : trackHeightClassNameBySize[size],
      className,
    ),
    style: isFramed ? undefined : { backgroundColor: colors.progressTrackByTone[tone] },
  };

  if (isFramed) {
    return (
      <Surface
        {...sharedProps}
        material={{ role: 'control', variant: 'inline', tone }}
        shape="full"
      >
        {progressFill}
      </Surface>
    );
  }

  return (
    <Box
      {...sharedProps}
    >
      {progressFill}
    </Box>
  );
}
