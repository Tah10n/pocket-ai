import React from 'react';
import { Box } from '../ui/box';
import { ScreenIconTile } from '../ui/ScreenShell';
import { SectionCard } from './ModelDetailsPrimitives';
import { Text } from '../ui/text';

export interface ModelDetailsUnavailableStateProps {
  title: React.ReactNode;
  message: React.ReactNode;
  openOnHuggingFaceButton?: React.ReactNode;
  className?: string;
}

export function ModelDetailsUnavailableState({
  title,
  message,
  openOnHuggingFaceButton,
  className,
}: ModelDetailsUnavailableStateProps) {
  return (
    <SectionCard tone="warning" className={className}>
      <Box className="flex-row items-start gap-3">
        <ScreenIconTile iconName="warning" tone="warning" iconSize={22} className="h-12 w-12 rounded-[18px]" />
        <Box className="min-w-0 flex-1">
          <Text className="text-base font-semibold text-typography-900 dark:text-typography-100">
            {title}
          </Text>
          <Text className="mt-2 text-sm leading-6 text-typography-600 dark:text-typography-300">
            {message}
          </Text>
          {openOnHuggingFaceButton ? (
            <Box className="mt-4 self-start">
              {openOnHuggingFaceButton}
            </Box>
          ) : null}
        </Box>
      </Box>
    </SectionCard>
  );
}

