import React from 'react';
import { Box } from '../ui/box';
import { Text } from '../ui/text';
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
  return (
    <SectionCard className={`border-primary-500/15 ${className ?? ''}`.trim()}>
      {badges ? (
        <Box className="flex-row flex-wrap gap-2">
          {badges}
        </Box>
      ) : null}

      <Text className="mt-3 text-[18px] font-bold leading-6 tracking-tight text-typography-900 dark:text-typography-50">
        {title}
      </Text>

      <Box className="mt-2 self-start rounded-full border border-outline-200/80 bg-background-0/80 px-3 py-1.5 dark:border-outline-700 dark:bg-background-950/70">
        <Text className="text-xs font-medium text-typography-600 dark:text-typography-300">
          {modelId}
        </Text>
      </Box>

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
