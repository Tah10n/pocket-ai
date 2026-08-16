import React, { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Box } from '@/components/ui/box';
import { ScreenSurface } from '@/components/ui/ScreenShell';
import { Text } from '@/components/ui/text';
import { getShortModelLabel } from '@/utils/modelLabel';

export interface ChatSystemEventRowProps {
  id?: string;
  fromModelId: string;
  toModelId: string;
  onLayout?: React.ComponentProps<typeof Box>['onLayout'];
}

function arePropsEqual(prev: ChatSystemEventRowProps, next: ChatSystemEventRowProps) {
  return (
    prev.id === next.id
    && prev.fromModelId === next.fromModelId
    && prev.toModelId === next.toModelId
    && prev.onLayout === next.onLayout
  );
}

export const ChatSystemEventRow = memo(({
  id,
  fromModelId,
  toModelId,
  onLayout,
}: ChatSystemEventRowProps) => {
  const { t } = useTranslation();
  const fromLabel = getShortModelLabel(fromModelId) || t('common.unknown');
  const toLabel = getShortModelLabel(toModelId) || t('common.unknown');

  return (
    <Box
      testID={id ? `chat-model-switch-row-${id}` : 'chat-model-switch-row'}
      onLayout={onLayout}
      className="w-full items-center py-2"
    >
      <ScreenSurface material={{ role: 'control', variant: 'inline' }} shape="full" className="max-w-full px-3 py-1">
        <Text colorRole="tertiary" className="text-center text-xs font-semibold">
          {t('chat.modelSwitchedLine', { from: fromLabel, to: toLabel })}
        </Text>
      </ScreenSurface>
    </Box>
  );
}, arePropsEqual);

ChatSystemEventRow.displayName = 'ChatSystemEventRow';
