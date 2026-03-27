import React from 'react';
import { useTranslation } from 'react-i18next';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { MaterialSymbols } from './MaterialSymbols';
import { ScreenHeaderShell } from './ScreenShell';

interface ChatHeaderProps {
  title: string;
  presetLabel?: string;
  modelLabel?: string;
  statusLabel?: string;
  statusTone?: 'neutral' | 'accent' | 'warning';
  canStartNewChat?: boolean;
  onStartNewChat?: () => void;
  onOpenModelControls?: () => void;
  canOpenModelControls?: boolean;
  onBack?: () => void;
  onMenu?: () => void;
}

function HeaderChip({
  label,
  tone = 'neutral',
}: {
  label: string;
  tone?: 'neutral' | 'accent' | 'warning';
}) {
  const toneClassName = tone === 'accent'
    ? 'border border-primary-500/20 bg-primary-500/10 text-primary-700 dark:bg-primary-500/20 dark:text-primary-200'
    : tone === 'warning'
      ? 'border border-warning-400/30 bg-warning-100 text-warning-800 dark:border-warning-600/40 dark:bg-warning-900/50 dark:text-warning-100'
      : 'border border-outline-200 bg-background-50 text-typography-700 dark:border-outline-700 dark:bg-background-900/70 dark:text-typography-200';

  return (
    <Box className={`max-w-full shrink rounded-full px-2 py-0.5 ${toneClassName}`}>
      <Text numberOfLines={1} className="text-[10px] font-semibold">
        {label}
      </Text>
    </Box>
  );
}

function HeaderStatus({
  label,
  tone = 'neutral',
}: {
  label: string;
  tone?: 'neutral' | 'accent' | 'warning';
}) {
  const dotClassName = tone === 'accent'
    ? 'bg-primary-500'
    : tone === 'warning'
      ? 'bg-warning-500'
      : 'bg-typography-400 dark:bg-typography-500';
  const textClassName = tone === 'accent'
    ? 'text-primary-600 dark:text-primary-300'
    : tone === 'warning'
      ? 'text-warning-700 dark:text-warning-200'
      : 'text-typography-500 dark:text-typography-400';

  return (
    <Box className="flex-row items-center gap-1">
      <Box className={`h-1.5 w-1.5 rounded-full ${dotClassName}`} />
      <Text numberOfLines={1} className={`text-[10px] font-medium ${textClassName}`}>
        {label}
      </Text>
    </Box>
  );
}

export const ChatHeader = ({
  title,
  presetLabel,
  modelLabel,
  statusLabel,
  statusTone = 'neutral',
  canStartNewChat = true,
  onStartNewChat,
  onOpenModelControls,
  canOpenModelControls = true,
  onBack,
  onMenu,
}: ChatHeaderProps) => {
  const { t } = useTranslation();
  const isModelUnavailable = modelLabel === t('chat.modelUnavailable');
  const modelTextClassName = isModelUnavailable
    ? 'text-warning-700 dark:text-warning-200'
    : 'text-typography-500 dark:text-typography-400';

  return (
    <ScreenHeaderShell maxWidthClassName="max-w-2xl">
      <Box className="flex-row items-start px-4 py-2">
        {onBack ? (
          <Pressable
            onPress={onBack}
            accessibilityRole="button"
            accessibilityLabel={t('chat.headerBackAccessibilityLabel')}
            hitSlop={8}
            className="mr-2.5 h-8 w-8 shrink-0 items-center justify-center rounded-full active:opacity-70"
          >
            <MaterialSymbols name="arrow-back-ios-new" size={21} className="text-primary-500" />
          </Pressable>
        ) : (
          <Box className="mr-2.5 h-8 w-8 shrink-0" />
        )}

        <Box className="min-w-0 flex-1 pr-1">
          <Box className="flex-row items-start gap-1.5">
            <Box className="min-w-0 flex-1 pr-1">
              <Text
                numberOfLines={1}
                className="text-[17px] font-semibold leading-tight text-typography-900 dark:text-typography-100"
              >
                {title}
              </Text>

              {(presetLabel || statusLabel) ? (
                <Box className="mt-1 flex-row flex-wrap items-center gap-x-1.5 gap-y-1">
                  {presetLabel ? <HeaderChip label={presetLabel} tone="accent" /> : null}
                  {statusLabel ? <HeaderStatus label={statusLabel} tone={statusTone} /> : null}
                </Box>
              ) : null}

              {modelLabel ? (
                <Box className="mt-1 flex-row items-center gap-1">
                  <MaterialSymbols
                    name={isModelUnavailable ? 'warning' : 'memory'}
                    size={12}
                    className={isModelUnavailable ? 'text-warning-600 dark:text-warning-200' : 'text-typography-400 dark:text-typography-500'}
                  />
                  <Text className={`min-w-0 flex-1 text-[11px] leading-4 ${modelTextClassName}`}>
                    {modelLabel}
                  </Text>
                </Box>
              ) : null}
            </Box>

            <Box className="shrink-0 flex-row items-center gap-1">
              {onOpenModelControls ? (
                <Pressable
                  onPress={onOpenModelControls}
                  disabled={!canOpenModelControls}
                  accessibilityRole="button"
                  accessibilityLabel={t('chat.headerModelControlsAccessibilityLabel')}
                  hitSlop={8}
                  className={`h-8 w-8 items-center justify-center rounded-full active:opacity-70 ${canOpenModelControls
                    ? 'bg-primary-500/10'
                    : 'bg-background-100 dark:bg-background-900/60'}`}
                >
                  <MaterialSymbols
                    name="tune"
                    size={17}
                    className={canOpenModelControls ? 'text-primary-500' : 'text-typography-400 dark:text-typography-500'}
                  />
                </Pressable>
              ) : null}

              {onStartNewChat ? (
                canStartNewChat ? (
                  <Pressable
                    onPress={onStartNewChat}
                    accessibilityRole="button"
                    accessibilityLabel={t('chat.headerNewChatAccessibilityLabel')}
                    hitSlop={8}
                    className="h-8 w-8 items-center justify-center rounded-full bg-primary-500/10 active:opacity-70"
                  >
                    <MaterialSymbols name="edit-square" size={17} className="text-primary-500" />
                  </Pressable>
                ) : (
                  <Box className="h-8 w-8 shrink-0" />
                )
              ) : null}

              <Pressable
                onPress={onMenu}
                accessibilityRole="button"
                accessibilityLabel={t('chat.headerMenuAccessibilityLabel')}
                hitSlop={8}
                className="h-8 w-8 items-center justify-center rounded-full active:opacity-70"
              >
                <MaterialSymbols name="more-horiz" size={19} className="text-typography-500 dark:text-typography-400" />
              </Pressable>
            </Box>
          </Box>
        </Box>
      </Box>
    </ScreenHeaderShell>
  );
};
