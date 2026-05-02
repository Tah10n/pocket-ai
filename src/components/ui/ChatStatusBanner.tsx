import React from 'react';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { ScreenIconTile, ScreenSurface, useScreenAppearance } from '@/components/ui/ScreenShell';
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
  const appearance = useScreenAppearance();
  const themeTone = tone === 'info' ? 'accent' : tone;
  const toneClassNames = appearance.classNames.toneClassNameByTone[themeTone];

  return (
    <ScreenSurface
      testID={testID}
      tone={themeTone}
      withControlTint
      className={`rounded-3xl border px-4 py-4 ${toneClassNames.surfaceClassName} ${centered ? 'w-full max-w-md self-center' : ''}`}
    >
      <Box className={`flex-row gap-3 ${centered ? 'items-start' : 'items-start'}`}>
        <ScreenIconTile iconName={iconName} tone={themeTone} iconSize={18} className="mt-0.5 rounded-2xl" />

        <Box className="min-w-0 flex-1">
          <Text className={`text-sm font-semibold ${toneClassNames.textClassName}`}>{title}</Text>
          {description ? (
            <Text className={`mt-1 text-sm leading-5 ${toneClassNames.labelClassName}`}>{description}</Text>
          ) : null}
          {actionLabel && onAction ? (
            <Button
              onPress={onAction}
              action="secondary"
              size="sm"
              className={`mt-3 self-start ${toneClassNames.surfaceClassName}`}
            >
              <ButtonText className={toneClassNames.textClassName}>{actionLabel}</ButtonText>
            </Button>
          ) : null}
        </Box>
      </Box>
    </ScreenSurface>
  );
}
