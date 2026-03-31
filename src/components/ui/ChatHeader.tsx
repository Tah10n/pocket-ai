import React from 'react';
import { useTranslation } from 'react-i18next';
import { Box } from '@/components/ui/box';
import { Text, composeTextRole } from '@/components/ui/text';
import { screenChromeTokens } from '../../utils/themeTokens';
import {
  HeaderActionButton,
  HeaderActionPlaceholder,
  HeaderBackButton,
  ScreenChip,
  ScreenHeaderShell,
} from './ScreenShell';

interface ChatHeaderProps {
  title: string;
  presetLabel?: string;
  modelLabel?: string;
  statusLabel?: string;
  statusTone?: 'neutral' | 'accent' | 'warning';
  canStartNewChat?: boolean;
  onStartNewChat?: () => void;
  onOpenPresetSelector?: () => void;
  canOpenPresetSelector?: boolean;
  onOpenModelControls?: () => void;
  canOpenModelControls?: boolean;
  onBack?: () => void;
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
      <Text numberOfLines={1} className={`${composeTextRole('caption')} ${textClassName}`}>
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
  onOpenPresetSelector,
  canOpenPresetSelector = true,
  onOpenModelControls,
  canOpenModelControls = true,
  onBack,
}: ChatHeaderProps) => {
  const { t } = useTranslation();
  const isModelUnavailable = modelLabel === t('chat.modelUnavailable');
  const modelTextClassName = isModelUnavailable
    ? 'text-warning-700 dark:text-warning-200'
    : 'text-typography-500 dark:text-typography-400';
  const shouldShowPills = Boolean(presetLabel || modelLabel);

  return (
    <ScreenHeaderShell>
      <Box className={screenChromeTokens.headerContentVerticalPaddingCompactClassName}>
        <Box className={`flex-row items-start ${screenChromeTokens.headerContentGapClassName} ${screenChromeTokens.headerHorizontalPaddingClassName}`}>
          <HeaderBackButton
            onPress={onBack}
            accessibilityLabel={t('chat.headerBackAccessibilityLabel')}
          />

          <Box className="min-w-0 flex-1">
            <Text
              numberOfLines={2}
              className={composeTextRole('screenTitle', 'text-[20px] leading-6')}
            >
              {title}
            </Text>
          </Box>

          <Box className={`shrink-0 flex-row items-center ${screenChromeTokens.headerContentGapClassName}`}>
            {onOpenModelControls ? (
              <HeaderActionButton
                iconName="tune"
                accessibilityLabel={t('chat.headerModelControlsAccessibilityLabel')}
                onPress={onOpenModelControls}
                disabled={!canOpenModelControls}
                tone="neutral"
              />
            ) : null}

            {onStartNewChat ? (
              <HeaderActionButton
                iconName="edit-square"
                accessibilityLabel={t('chat.headerNewChatAccessibilityLabel')}
                onPress={onStartNewChat}
                disabled={!canStartNewChat}
                tone="accent"
              />
            ) : (
              <HeaderActionPlaceholder />
            )}
          </Box>
        </Box>

        {(shouldShowPills || statusLabel) ? (
          <Box className={`mt-1.5 gap-1.5 ${screenChromeTokens.headerHorizontalPaddingClassName}`}>
            {shouldShowPills ? (
              <Box className="flex-row items-center gap-2">
                {presetLabel ? (
                  <ScreenChip
                    label={presetLabel}
                    tone="accent"
                    onPress={onOpenPresetSelector}
                    disabled={!canOpenPresetSelector}
                    accessibilityLabel={t('chat.headerPresetAccessibilityLabel')}
                    trailingIconName="keyboard-arrow-down"
                    className="flex-1 min-w-0"
                  />
                ) : null}

                {modelLabel ? (
                  <ScreenChip
                    label={modelLabel}
                    tone={isModelUnavailable ? 'warning' : 'neutral'}
                    leadingIconName={isModelUnavailable ? 'warning' : 'memory'}
                    className="min-w-0 flex-1"
                    textClassName={`${composeTextRole('chip', 'min-w-0 flex-1')} ${modelTextClassName}`}
                  />
                ) : null}
              </Box>
            ) : null}

            {statusLabel ? (
              <HeaderStatus label={statusLabel} tone={statusTone} />
            ) : null}
          </Box>
        ) : null}
      </Box>
    </ScreenHeaderShell>
  );
};
