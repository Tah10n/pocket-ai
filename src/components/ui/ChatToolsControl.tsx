import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box } from './box';
import { Pressable } from './pressable';
import { Text } from './text';
import { LOCAL_TOOL_NAMES, type LocalToolSettings } from '../../types/localTools';

export function ChatToolsControl({ settings, onChange, disabled = false }: {
  settings: LocalToolSettings;
  onChange: (settings: LocalToolSettings) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  return <Box className="mx-3 mb-1 rounded-xl border border-outline-200 bg-background-50 px-3">
    <Box className="flex-row items-center justify-between">
      <Pressable testID="chat-tools-toggle" accessibilityRole="switch"
        accessibilityLabel={t('chat.tools.enable')} accessibilityState={{ checked: settings.enabled, disabled }}
        disabled={disabled} onPress={() => onChange({ enabled: !settings.enabled, allowedTools: [...LOCAL_TOOL_NAMES], toolChoice: 'auto' })}
        className="min-h-11 flex-1 justify-center">
        <Text colorRole="primary" className="text-sm">{t('chat.tools.title')} · {t(settings.enabled ? 'chat.tools.on' : 'chat.tools.off')}</Text>
      </Pressable>
      <Pressable testID="chat-tools-info" accessibilityRole="button" accessibilityState={{ expanded }}
        accessibilityLabel={t('chat.tools.available')} onPress={() => setExpanded(!expanded)} className="min-h-11 justify-center px-2">
        <Text colorRole="accent" className="text-sm">{t('chat.tools.available')}</Text>
      </Pressable>
    </Box>
    {expanded ? <Box className="gap-1 pb-3">
      <Text colorRole="secondary" className="text-xs">{t('chat.tools.description')}</Text>
      {LOCAL_TOOL_NAMES.map(name => <Text key={name} colorRole="primary" className="text-xs">{t(`chat.tools.names.${name}`)}</Text>)}
    </Box> : null}
  </Box>;
}
