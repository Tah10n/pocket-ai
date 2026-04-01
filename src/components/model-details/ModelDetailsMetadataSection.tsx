import React from 'react';
import { ScreenStack } from '../ui/ScreenShell';
import { DetailValueCard, type DetailValueCardProps, SectionCard, type SectionCardProps } from './ModelDetailsPrimitives';

export interface ModelDetailsMetadataSectionProps {
  items: readonly DetailValueCardProps[];
  title: React.ReactNode;
  iconName: NonNullable<SectionCardProps['iconName']>;
  tone?: NonNullable<SectionCardProps['tone']>;
  className?: string;
}

export function ModelDetailsMetadataSection({
  items,
  title,
  iconName,
  tone = 'primary',
  className,
}: ModelDetailsMetadataSectionProps) {
  if (items.length === 0) {
    return null;
  }

  return (
    <SectionCard
      title={title}
      iconName={iconName}
      tone={tone}
      className={className}
    >
      <ScreenStack gap="compact">
        {items.map((item) => (
          <DetailValueCard
            key={item.label}
            label={item.label}
            value={item.value}
            tone={item.tone}
            iconName={item.iconName}
            compact={item.compact ?? true}
          />
        ))}
      </ScreenStack>
    </SectionCard>
  );
}
