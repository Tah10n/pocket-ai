import React from 'react';
import { Box } from '@/components/ui/box';

type ProgressBarSize = 'sm' | 'md' | 'lg';
type ProgressBarTone = 'neutral' | 'primary' | 'success' | 'warning';
type ProgressBarVariant = 'plain' | 'framed';

interface ProgressBarProps {
  valuePercent: number;
  size?: ProgressBarSize;
  tone?: ProgressBarTone;
  variant?: ProgressBarVariant;
  className?: string;
  fillClassName?: string;
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

const trackToneClassNameByTone: Record<ProgressBarTone, string> = {
  neutral: 'bg-background-200 dark:bg-background-800',
  primary: 'bg-primary-200 dark:bg-typography-800',
  success: 'bg-success-200 dark:bg-success-900/50',
  warning: 'bg-warning-200 dark:bg-warning-900/50',
};

const framedTrackToneClassNameByTone: Record<ProgressBarTone, string> = {
  neutral: 'border-outline-200 bg-background-100 dark:border-outline-700 dark:bg-background-900/70',
  primary: 'border-primary-500/20 bg-primary-500/10 dark:border-primary-400/25 dark:bg-primary-500/10',
  success: 'border-success-500/25 bg-success-500/10 dark:border-success-400/25 dark:bg-success-500/10',
  warning: 'border-warning-500/30 bg-background-warning dark:border-warning-700 dark:bg-warning-500/10',
};

const fillToneClassNameByTone: Record<ProgressBarTone, string> = {
  neutral: 'bg-typography-500 dark:bg-typography-300',
  primary: 'bg-primary-500',
  success: 'bg-success-500',
  warning: 'bg-warning-500',
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
  testID,
  fillTestID,
}: ProgressBarProps) {
  const clampedPercent = clampProgressPercent(valuePercent);
  const isFramed = variant === 'framed';

  return (
    <Box
      testID={testID}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: clampedPercent }}
      className={joinClassNames(
        'relative w-full overflow-hidden rounded-full',
        isFramed ? 'border p-0.5' : undefined,
        isFramed ? framedTrackHeightClassNameBySize[size] : trackHeightClassNameBySize[size],
        isFramed ? framedTrackToneClassNameByTone[tone] : trackToneClassNameByTone[tone],
        className,
      )}
    >
      <Box
        testID={fillTestID}
        className={joinClassNames(
          'relative h-full overflow-hidden rounded-full',
          fillToneClassNameByTone[tone],
          fillClassName,
        )}
        style={{ width: `${clampedPercent}%` }}
      >
        {isFramed ? <Box className="absolute inset-y-0 right-0 w-5 bg-typography-0/25" /> : null}
      </Box>
    </Box>
  );
}
