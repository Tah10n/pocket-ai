import React from 'react';
import { Box } from '../ui/box';
import { type MaterialSymbolsProps } from '../ui/MaterialSymbols';
import { ScreenCard, ScreenIconTile, ScreenSurface } from '../ui/ScreenShell';
import { Text, composeTextRole } from '../ui/text';
import { type ModelDetailsTone } from '@/utils/modelDetailsPresentation';

export interface DetailValueCardProps {
  label: string;
  value: string;
  tone: ModelDetailsTone;
  iconName?: MaterialSymbolsProps['name'];
  compact?: boolean;
}

export interface SectionHeaderProps {
  title: React.ReactNode;
  iconName: MaterialSymbolsProps['name'];
  tone: ModelDetailsTone;
}

export interface SectionCardProps {
  children: React.ReactNode;
  title?: React.ReactNode;
  iconName?: MaterialSymbolsProps['name'];
  tone?: ModelDetailsTone;
  className?: string;
}

export function DetailValueCard({
  label,
  value,
  tone,
  iconName,
  compact = false,
}: DetailValueCardProps) {
  const colorRole = tone === 'primary'
    ? 'accent'
    : tone === 'error'
      ? 'danger'
      : tone === 'neutral'
        ? 'primary'
        : tone;

  return (
    <ScreenSurface
      tone={tone}
      withControlTint
      className={`px-4 py-3 ${compact ? '' : 'min-w-[148px] flex-1'}`.trim()}
    >
      <Box className="flex-row items-start justify-between gap-2.5">
        <Box className="min-w-0 flex-1">
          <Text colorRole={colorRole} className={composeTextRole('eyebrow')}>
            {label}
          </Text>
          <Text colorRole="primary" className={composeTextRole(compact ? 'body' : 'sectionTitle', 'mt-1.5')}>
            {value}
          </Text>
        </Box>
        {iconName ? (
          <ScreenIconTile iconName={iconName} tone={tone} />
        ) : null}
      </Box>
    </ScreenSurface>
  );
}

export function SectionHeader({
  title,
  iconName,
  tone,
}: SectionHeaderProps) {
  return (
    <Box className="mb-2.5 flex-row items-center gap-2.5">
      <ScreenIconTile iconName={iconName} tone={tone} />
      <Text colorRole="primary" className={composeTextRole('sectionTitle')}>
        {title}
      </Text>
    </Box>
  );
}

export function SectionCard({
  children,
  title,
  iconName,
  tone = 'neutral',
  className,
}: SectionCardProps) {
  const cardTone = tone === 'warning'
    ? 'warning'
    : tone === 'error'
      ? 'error'
      : tone === 'primary'
        ? 'accent'
        : 'default';

  return (
    <ScreenCard tone={cardTone} className={`overflow-hidden ${className ?? ''}`.trim()}>
      {title && iconName ? (
        <SectionHeader title={title} iconName={iconName} tone={tone} />
      ) : null}
      {children}
    </ScreenCard>
  );
}
