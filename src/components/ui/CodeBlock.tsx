import React, { useEffect, useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import { useTranslation } from 'react-i18next';
import { Box } from '@/components/ui/box';
import { ScreenActionPill, ScreenCard } from '@/components/ui/ScreenShell';
import { Text } from '@/components/ui/text';

interface CodeBlockProps {
  code: string;
  language?: string;
  selectable?: boolean;
}

export function CodeBlock({ code, language, selectable = false }: CodeBlockProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) {
      return;
    }

    const timeout = setTimeout(() => {
      setCopied(false);
    }, 1500);

    return () => clearTimeout(timeout);
  }, [copied]);

  const handleCopy = async () => {
    await Clipboard.setStringAsync(code);
    setCopied(true);
  };

  return (
    <ScreenCard padding="none" className="px-3 py-3">
      <Box className="mb-2 flex-row items-center justify-between">
        <Text colorRole="tertiary" className="text-xs font-semibold uppercase tracking-wide  ">
          {language || t('common.code')}
        </Text>
        <ScreenActionPill testID="copy-code-button" onPress={handleCopy} tone="soft" size="sm" className="border-0">
          <Text colorRole="accent" className="text-xs font-semibold ">
            {copied ? t('common.copied') : t('common.copy')}
          </Text>
        </ScreenActionPill>
      </Box>
      <Text colorRole="primary" selectable={selectable} className="font-mono text-sm leading-6  ">
        {code}
      </Text>
    </ScreenCard>
  );
}
