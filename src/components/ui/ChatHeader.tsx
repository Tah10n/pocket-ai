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
import type { AndroidBlurTargetRef } from '../../utils/androidBlur';
import type { SemanticForegroundRole } from '../../design-system/themes/foreground';

interface ChatHeaderProps {
  androidContentBlurTargetRef?: AndroidBlurTargetRef | null;
  title: string;
  presetLabel?: string;
  modelLabel?: string;
  modelSelectable?: boolean;
  statusLabel?: string;
  statusTone?: 'neutral' | 'accent' | 'warning';
  canStartNewChat?: boolean;
  onStartNewChat?: () => void;
  onOpenPresetSelector?: () => void;
  canOpenPresetSelector?: boolean;
  onOpenModelSelector?: () => void;
  canOpenModelSelector?: boolean;
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
  const textColorRole: SemanticForegroundRole = tone === 'accent'
    ? 'statusAccent'
    : tone === 'warning'
      ? 'statusWarning'
      : 'tertiary';

  return (
    <Box className="flex-row items-center gap-1">
      <Box className={`h-1.5 w-1.5 rounded-full ${dotClassName}`} />
      <Text colorRole={textColorRole} numberOfLines={1} className={composeTextRole('caption')}>
        {label}
      </Text>
    </Box>
  );
}

export const ChatHeader = ({
  androidContentBlurTargetRef,
  title,
  presetLabel,
  modelLabel,
  modelSelectable = false,
  statusLabel,
  statusTone = 'neutral',
  canStartNewChat = true,
  onStartNewChat,
  onOpenPresetSelector,
  canOpenPresetSelector = true,
  onOpenModelSelector,
  canOpenModelSelector = true,
  onOpenModelControls,
  canOpenModelControls = true,
  onBack,
}: ChatHeaderProps) => {
  const { t } = useTranslation();
  const isModelUnavailable = modelLabel === t('chat.modelUnavailable');
  const shouldShowPills = Boolean(presetLabel || modelLabel);

  return (
    <ScreenHeaderShell androidBlurTargetRef={androidContentBlurTargetRef}>
      <Box className={screenChromeTokens.headerContentVerticalPaddingCompactClassName}>
        <Box className={`flex-row items-start ${screenChromeTokens.headerContentGapClassName} ${screenChromeTokens.headerHorizontalPaddingClassName}`}>
          <HeaderBackButton
            onPress={onBack}
            accessibilityLabel={t('chat.headerBackAccessibilityLabel')}
          />

          <Box className="min-w-0 flex-1">
            <Text colorRole="primary"
              testID="chat-header-title"
              numberOfLines={2}
              className={composeTextRole('screenTitle')}
            >
              {title}
            </Text>
          </Box>

          <Box className={`shrink-0 flex-row items-center ${screenChromeTokens.headerContentGapClassName}`}>
            {onOpenModelControls ? (
              <HeaderActionButton
                testID="chat-header-model-controls"
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
              <Box testID="chat-header-pill-row" className="min-w-0 flex-row items-center gap-2">
                {presetLabel ? (
                  <ScreenChip
                    label={presetLabel}
                    tone="accent"
                    onPress={onOpenPresetSelector}
                    disabled={!canOpenPresetSelector}
                    accessibilityLabel={t('chat.headerPresetAccessibilityLabel')}
                    trailingIconName="keyboard-arrow-down"
                    className="min-w-0"
                  />
                ) : null}

                {modelLabel ? (
                  <ScreenChip
                    testID="chat-header-model-selector"
                    label={modelLabel}
                    tone={isModelUnavailable ? 'warning' : 'neutral'}
                    leadingIconName={isModelUnavailable ? 'warning' : 'memory'}
                    onPress={onOpenModelSelector}
                    disabled={!canOpenModelSelector}
                    trailingIconName={modelSelectable || Boolean(onOpenModelSelector) ? 'keyboard-arrow-down' : undefined}
                    className="min-w-0"
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
