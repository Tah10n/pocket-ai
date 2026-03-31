import { StatusBar } from 'expo-status-bar';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Platform } from 'react-native';
import { Box } from '@/components/ui/box';
import { HeaderBar } from '@/components/ui/HeaderBar';
import { ScreenContent } from '@/components/ui/ScreenShell';
import { Text } from '@/components/ui/text';
import { useTheme } from '../src/providers/ThemeProvider';

export default function ModalScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const { colors } = useTheme();

  return (
    <Box className="flex-1 bg-background-0 dark:bg-background-950">
      <HeaderBar
        title={t('common.more')}
        subtitle={t('modal.description')}
        onBack={router.canGoBack() ? () => router.back() : undefined}
        backAccessibilityLabel={t('chat.headerBackAccessibilityLabel')}
      />

      <ScreenContent className="flex-1 items-center justify-center px-4 py-10">
        <Box className="w-full max-w-xl rounded-3xl border border-outline-200 bg-background-50 p-6 dark:border-outline-800 dark:bg-background-900/60">
          <Text textRole="screenTitle" className="text-center">
            {t('common.more')}
          </Text>
          <Box className="my-5 h-px w-full bg-outline-200 dark:bg-outline-800" />
          <Text textRole="body" className="text-center text-typography-700 dark:text-typography-300">
            {t('modal.body')}
          </Text>
        </Box>
      </ScreenContent>

      <StatusBar style={Platform.OS === 'ios' ? 'light' : colors.statusBarStyle} />
    </Box>
  );
}
