import React from 'react';
import { Box } from '../ui/box';
import { ScreenChip } from '../ui/ScreenShell';
import { Text } from '../ui/text';
import { SectionCard, type SectionCardProps } from './ModelDetailsPrimitives';

type ModelDetailsTagTone = 'neutral' | 'accent' | 'warning' | 'error' | 'success' | 'info';
type ModelDetailsTagSize = 'micro' | 'default';

export interface ModelDetailsTagChip {
  key: string;
  label: string;
  tone?: ModelDetailsTagTone;
  size?: ModelDetailsTagSize;
  className?: string;
}

export interface ModelDetailsTagsSectionProps {
  chips: readonly ModelDetailsTagChip[];
  emptyLabel: React.ReactNode;
  title: React.ReactNode;
  iconName: NonNullable<SectionCardProps['iconName']>;
  tone?: NonNullable<SectionCardProps['tone']>;
  className?: string;
}

export function ModelDetailsTagsSection({
  chips,
  emptyLabel,
  title,
  iconName,
  tone = 'success',
  className,
}: ModelDetailsTagsSectionProps) {
  return (
    <SectionCard
      title={title}
      iconName={iconName}
      tone={tone}
      className={className}
    >
      {chips.length > 0 ? (
        <Box className="flex-row flex-wrap gap-2">
          {chips.map((chip) => (
            <ScreenChip
              key={chip.key}
              label={chip.label}
              tone={chip.tone}
              size={chip.size}
              className={chip.className ?? 'max-w-full'}
            />
          ))}
        </Box>
      ) : (
        <Text className="text-sm leading-6 text-typography-500 dark:text-typography-400">
          {emptyLabel}
        </Text>
      )}
    </SectionCard>
  );
}
