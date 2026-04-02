import React from 'react';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { MaterialSymbols, type MaterialSymbolName } from './MaterialSymbols';

type ChatStatusBannerTone = 'warning' | 'info' | 'neutral';

interface ChatStatusBannerProps {
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  tone?: ChatStatusBannerTone;
  iconName?: MaterialSymbolName;
  centered?: boolean;
  testID?: string;
}

const toneStyles: Record<
  ChatStatusBannerTone,
  {
    container: string;
    iconWrap: string;
    icon: string;
    title: string;
    description: string;
    action: string;
    actionText: string;
  }
> = {
  warning: {
    container: 'border-warning-300 bg-warning-50 dark:border-warning-700 dark:bg-warning-950/40',
    iconWrap: 'bg-warning-100 dark:bg-warning-900/60',
    icon: 'text-warning-700 dark:text-warning-300',
    title: 'text-warning-800 dark:text-warning-200',
    description: 'text-warning-700/80 dark:text-warning-300/80',
    action: 'border-warning-400/30 bg-warning-100 dark:border-warning-600/40 dark:bg-warning-900/60',
    actionText: 'text-warning-800 dark:text-warning-200',
  },
  info: {
    container: 'border-primary-500/15 bg-primary-500/5 dark:bg-primary-500/10',
    iconWrap: 'bg-primary-500/10 dark:bg-primary-500/20',
    icon: 'text-primary-600 dark:text-primary-300',
    title: 'text-primary-700 dark:text-primary-200',
    description: 'text-primary-700/80 dark:text-primary-300/80',
    action: 'border-primary-500/20 bg-primary-500/10 dark:bg-primary-500/20',
    actionText: 'text-primary-700 dark:text-primary-200',
  },
  neutral: {
    container: 'border-outline-200 bg-background-50 dark:border-outline-800 dark:bg-background-900/60',
    iconWrap: 'bg-background-100 dark:bg-background-800',
    icon: 'text-typography-700 dark:text-typography-200',
    title: 'text-typography-800 dark:text-typography-100',
    description: 'text-typography-600 dark:text-typography-300',
    action: 'border-outline-200 bg-background-0 dark:border-outline-700 dark:bg-background-800',
    actionText: 'text-typography-800 dark:text-typography-100',
  },
};

export function ChatStatusBanner({
  title,
  description,
  actionLabel,
  onAction,
  tone = 'neutral',
  iconName = 'info-outline',
  centered = false,
  testID,
}: ChatStatusBannerProps) {
  const styles = toneStyles[tone];

  return (
    <Box
      testID={testID}
      className={`rounded-3xl border px-4 py-4 ${styles.container} ${centered ? 'w-full max-w-md self-center' : ''}`}
    >
      <Box className={`flex-row gap-3 ${centered ? 'items-start' : 'items-start'}`}>
        <Box className={`mt-0.5 h-9 w-9 items-center justify-center rounded-2xl ${styles.iconWrap}`}>
          <MaterialSymbols name={iconName} size={18} className={styles.icon} />
        </Box>

        <Box className="min-w-0 flex-1">
          <Text className={`text-sm font-semibold ${styles.title}`}>{title}</Text>
          {description ? (
            <Text className={`mt-1 text-sm leading-5 ${styles.description}`}>{description}</Text>
          ) : null}
          {actionLabel && onAction ? (
            <Button
              onPress={onAction}
              action="secondary"
              size="sm"
              className={`mt-3 self-start ${styles.action}`}
            >
              <ButtonText className={styles.actionText}>{actionLabel}</ButtonText>
            </Button>
          ) : null}
        </Box>
      </Box>
    </Box>
  );
}
