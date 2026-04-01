import React from 'react';
import { Box } from '../ui/box';
import { MaterialSymbols, type MaterialSymbolsProps } from '../ui/MaterialSymbols';
import { ScreenCard } from '../ui/ScreenShell';
import { Text } from '../ui/text';
import { getDetailToneTokens, type ModelDetailsTone } from '@/utils/modelDetailsPresentation';

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
  const toneTokens = getDetailToneTokens(tone);

  return (
    <Box
      className={`rounded-[18px] border px-4 ${compact ? 'py-3.5' : 'min-w-[148px] flex-1 py-4'} ${toneTokens.shellClassName}`}
    >
      <Box className="flex-row items-start justify-between gap-3">
        <Box className="min-w-0 flex-1">
          <Text className={`text-[10px] font-semibold uppercase tracking-wide ${toneTokens.labelClassName}`}>
            {label}
          </Text>
          <Text className={`mt-2 ${compact ? 'text-sm leading-6' : 'text-base'} font-bold ${toneTokens.valueClassName}`}>
            {value}
          </Text>
        </Box>
        {iconName ? (
          <Box className={`h-10 w-10 items-center justify-center rounded-[16px] ${toneTokens.iconWrapClassName}`}>
            <MaterialSymbols name={iconName} size={18} className={toneTokens.iconClassName} />
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}

export function SectionHeader({
  title,
  iconName,
  tone,
}: SectionHeaderProps) {
  const toneTokens = getDetailToneTokens(tone);

  return (
    <Box className="mb-4 flex-row items-center gap-3">
      <Box className={`h-11 w-11 items-center justify-center rounded-[18px] ${toneTokens.iconWrapClassName}`}>
        <MaterialSymbols name={iconName} size={20} className={toneTokens.iconClassName} />
      </Box>
      <Text className="text-base font-semibold text-typography-900 dark:text-typography-100">
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
  return (
    <ScreenCard className={`overflow-hidden bg-background-50/95 dark:bg-background-900/75 ${className ?? ''}`.trim()}>
      {title && iconName ? (
        <SectionHeader title={title} iconName={iconName} tone={tone} />
      ) : null}
      {children}
    </ScreenCard>
  );
}
