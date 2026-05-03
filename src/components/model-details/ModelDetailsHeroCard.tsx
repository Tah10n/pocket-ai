import React from 'react';
import { Box } from '../ui/box';
import { Text, composeTextRole } from '../ui/text';
import { useTheme } from '@/providers/ThemeProvider';
import { DEFAULT_THEME_ID, getThemeAppearance } from '@/utils/themeTokens';
import { ScreenSurface } from '../ui/ScreenShell';
import { SectionCard } from './ModelDetailsPrimitives';

export interface ModelDetailsHeroCardProps {
  badges?: React.ReactNode;
  title: React.ReactNode;
  modelId: React.ReactNode;
  actions?: React.ReactNode;
  progress?: React.ReactNode;
  openOnHuggingFaceButton?: React.ReactNode;
  className?: string;
}

export function ModelDetailsHeroCard({
  badges,
  title,
  modelId,
  actions,
  progress,
  openOnHuggingFaceButton,
  className,
}: ModelDetailsHeroCardProps) {
  const theme = useTheme();
  const appearance = theme.appearance ?? getThemeAppearance(theme.themeId ?? DEFAULT_THEME_ID, theme.resolvedMode ?? 'light');

  return (
    <SectionCard className={className}>
      {badges ? (
        <Box className="flex-row flex-wrap gap-2">
          {badges}
        </Box>
      ) : null}

      <Text className={composeTextRole('screenTitle', 'mt-3 tracking-tight dark:text-typography-50')}>
        {title}
      </Text>

      <ScreenSurface className={`mt-2 self-start ${appearance.classNames.inlinePillClassName}`}>
        <Text className={composeTextRole('chip', 'font-medium text-typography-600 dark:text-typography-300')}>
          {modelId}
        </Text>
      </ScreenSurface>

      {actions ? (
        <Box className="mt-4">
          {actions}
        </Box>
      ) : null}

      {progress ? (
        <Box className="mt-4">
          {progress}
        </Box>
      ) : null}

      {openOnHuggingFaceButton ? (
        <Box className="mt-4 self-start">
          {openOnHuggingFaceButton}
        </Box>
      ) : null}
    </SectionCard>
  );
}
