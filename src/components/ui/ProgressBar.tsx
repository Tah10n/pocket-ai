import React from 'react';
import { Box } from '@/components/ui/box';
import { useTheme } from '@/providers/ThemeProvider';
import { DEFAULT_THEME_ID, getThemeAppearance } from '@/utils/themeTokens';

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
  const theme = useTheme();
  const appearance = theme.appearance ?? getThemeAppearance(theme.themeId ?? DEFAULT_THEME_ID, theme.resolvedMode ?? 'light');
  const clampedPercent = clampProgressPercent(valuePercent);
  const isFramed = variant === 'framed';
  const toneClassNames = appearance.classNames.toneClassNameByTone[tone];

  return (
    <Box
      testID={testID}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: clampedPercent }}
      className={joinClassNames(
        'relative w-full overflow-hidden rounded-full',
        isFramed ? 'border p-0.5' : undefined,
        isFramed ? framedTrackHeightClassNameBySize[size] : trackHeightClassNameBySize[size],
        isFramed ? toneClassNames.framedProgressTrackClassName : toneClassNames.progressTrackClassName,
        className,
      )}
    >
      <Box
        testID={fillTestID}
        className={joinClassNames(
          'relative h-full overflow-hidden rounded-full',
          toneClassNames.progressFillClassName,
          fillClassName,
        )}
        style={{ width: `${clampedPercent}%` }}
      >
        {isFramed ? <Box className={joinClassNames('absolute inset-y-0 right-0 w-5', appearance.classNames.progressShineClassName)} /> : null}
      </Box>
    </Box>
  );
}
