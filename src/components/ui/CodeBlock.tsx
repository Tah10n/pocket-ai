import React, { useEffect, useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import { useTranslation } from 'react-i18next';
import { Box } from '@/components/ui/box';
import { ScreenActionPill } from '@/components/ui/ScreenShell';
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
    <Box className="rounded-xl border border-outline-200 bg-background-50 px-3 py-3 dark:border-outline-800 dark:bg-background-900/60">
      <Box className="mb-2 flex-row items-center justify-between">
        <Text className="text-xs font-semibold uppercase tracking-wide text-typography-500 dark:text-typography-400">
          {language || t('common.code')}
        </Text>
        <ScreenActionPill testID="copy-code-button" onPress={handleCopy} tone="soft" size="sm" className="border-0 bg-primary-500/10">
          <Text className="text-xs font-semibold text-primary-500">
            {copied ? t('common.copied') : t('common.copy')}
          </Text>
        </ScreenActionPill>
      </Box>
      <Text selectable={selectable} className="font-mono text-sm leading-6 text-typography-900 dark:text-typography-100">
        {code}
      </Text>
    </Box>
  );
}
