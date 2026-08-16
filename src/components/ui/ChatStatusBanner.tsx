import React from 'react';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { ScreenIconTile, ScreenSurface } from '@/components/ui/ScreenShell';
import { Text } from '@/components/ui/text';
import { type MaterialSymbolName } from './MaterialSymbols';

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
  const themeTone = tone === 'info' ? 'accent' : tone;
  const colorRole = themeTone === 'warning' ? 'warning' : themeTone === 'accent' ? 'accent' : 'primary';

  return (
    <ScreenSurface
      testID={testID}
      tone={themeTone}
      withControlTint
      className={`px-4 py-4 ${centered ? 'w-full max-w-md self-center' : ''}`}
    >
      <Box className={`flex-row gap-3 ${centered ? 'items-start' : 'items-start'}`}>
        <ScreenIconTile iconName={iconName} tone={themeTone} iconSize={18} className="mt-0.5 rounded-2xl" />

        <Box className="min-w-0 flex-1">
          <Text colorRole={colorRole} className="text-sm font-semibold">{title}</Text>
          {description ? (
            <Text colorRole={colorRole} className="mt-1 text-sm leading-5">{description}</Text>
          ) : null}
          {actionLabel && onAction ? (
            <Button
              onPress={onAction}
              action="secondary"
              size="sm"
              className="mt-3 self-start"
            >
              <ButtonText>{actionLabel}</ButtonText>
            </Button>
          ) : null}
        </Box>
      </Box>
    </ScreenSurface>
  );
}
