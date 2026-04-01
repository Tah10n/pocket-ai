import React from 'react';
import { Box } from '../ui/box';
import { MaterialSymbols } from '../ui/MaterialSymbols';
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
    <SectionCard className={`border-warning-300/70 bg-warning-50/90 dark:border-warning-800 dark:bg-warning-950/35 ${className ?? ''}`.trim()}>
      <Box className="flex-row items-start gap-3">
        <Box className="h-12 w-12 items-center justify-center rounded-[18px] bg-warning-500/12 dark:bg-warning-500/18">
          <MaterialSymbols name="warning" size={22} className="text-warning-700 dark:text-warning-200" />
        </Box>
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

