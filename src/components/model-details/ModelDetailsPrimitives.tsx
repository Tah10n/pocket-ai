import React from 'react';
import { Box } from '../ui/box';
import { type MaterialSymbolsProps } from '../ui/MaterialSymbols';
import { ScreenCard, ScreenIconTile, ScreenSurface, useScreenAppearance } from '../ui/ScreenShell';
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
  const appearance = useScreenAppearance();
  const toneTokens = appearance.classNames.toneClassNameByTone[tone];

  return (
    <ScreenSurface
      tone={tone}
      withControlTint
      className={`rounded-2xl border px-4 ${compact ? 'py-3' : 'min-w-[148px] flex-1 py-3.5'} ${toneTokens.surfaceClassName}`}
    >
      <Box className="flex-row items-start justify-between gap-3">
        <Box className="min-w-0 flex-1">
          <Text className={composeTextRole('eyebrow', toneTokens.labelClassName)}>
            {label}
          </Text>
          <Text className={composeTextRole(compact ? 'body' : 'sectionTitle', `mt-2 ${toneTokens.valueClassName}`)}>
            {value}
          </Text>
        </Box>
        {iconName ? (
          <ScreenIconTile iconName={iconName} tone={tone} className="h-10 w-10 rounded-2xl" />
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
    <Box className="mb-4 flex-row items-center gap-3">
      <ScreenIconTile iconName={iconName} tone={tone} size="lg" />
      <Text className={composeTextRole('sectionTitle')}>
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
