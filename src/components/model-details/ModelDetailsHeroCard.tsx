import React from 'react';
import { Box } from '../ui/box';
import { Text, composeTextRole } from '../ui/text';
import { ScreenSurface } from '../ui/ScreenShell';
import { SectionCard } from './ModelDetailsPrimitives';

export interface ModelDetailsHeroCardProps {
  badges?: React.ReactNode;
  title: React.ReactNode;
  modelId: React.ReactNode;
  actions?: React.ReactNode;
  variantSelector?: React.ReactNode;
  progress?: React.ReactNode;
  openOnHuggingFaceButton?: React.ReactNode;
  className?: string;
}

export function ModelDetailsHeroCard({
  badges,
  title,
  modelId,
  actions,
  variantSelector,
  progress,
  openOnHuggingFaceButton,
  className,
}: ModelDetailsHeroCardProps) {
  return (
    <SectionCard className={className}>
      {badges ? (
        <Box className="flex-row flex-wrap gap-2">
          {badges}
        </Box>
      ) : null}

      <Text
        colorRole="primary"
        numberOfLines={2}
        ellipsizeMode="tail"
        textBreakStrategy="balanced"
        className={composeTextRole('screenTitle', 'mt-3 tracking-tight')}
      >
        {title}
      </Text>

      <ScreenSurface material={{ role: 'control', variant: 'inline' }} shape="full" className="mt-2 self-start px-3 py-1.5">
        <Text colorRole="secondary" className={composeTextRole('chip', 'font-medium')}>
          {modelId}
        </Text>
      </ScreenSurface>

      {variantSelector ? (
        <Box className="mt-4">
          {variantSelector}
        </Box>
      ) : null}

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
