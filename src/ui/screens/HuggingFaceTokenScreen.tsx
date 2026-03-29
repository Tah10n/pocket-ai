import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Linking } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { Input, InputField } from '@/components/ui/input';
import { MaterialSymbols } from '@/components/ui/MaterialSymbols';
import { Pressable } from '@/components/ui/pressable';
import { ScreenContent, ScreenHeaderShell } from '@/components/ui/ScreenShell';
import { ScrollView } from '@/components/ui/scroll-view';
import { Text } from '@/components/ui/text';
import { huggingFaceTokenService } from '../../services/HuggingFaceTokenService';
import { getReportedErrorMessage } from '../../services/AppError';
import { HUGGING_FACE_TOKEN_SETTINGS_URL } from '../../services/ModelCatalogService';

export function HuggingFaceTokenScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const [tokenDraft, setTokenDraft] = useState('');
  const [hasToken, setHasToken] = useState(() => huggingFaceTokenService.getCachedState().hasToken);
  const [busy, setBusy] = useState<'save' | 'clear' | null>(null);

  useEffect(() => {
    return huggingFaceTokenService.subscribe((state) => {
      setHasToken(state.hasToken);
    });
  }, []);

  useEffect(() => {
    void huggingFaceTokenService.refreshState().then((state) => {
      setHasToken(state.hasToken);
    });
  }, []);

  const handleSave = useCallback(async () => {
    const trimmed = tokenDraft.trim();
    if (!trimmed) {
      return;
    }

    try {
      setBusy('save');
      await huggingFaceTokenService.saveToken(trimmed);
      setTokenDraft('');
    } catch (error) {
      Alert.alert(
        t('models.actionFailedTitle'),
        getReportedErrorMessage('HuggingFaceTokenScreen.handleSave', error, t),
      );
    } finally {
      setBusy(null);
    }
  }, [t, tokenDraft]);

  const handleClear = useCallback(async () => {
    try {
      setBusy('clear');
      await huggingFaceTokenService.clearToken();
      setTokenDraft('');
    } catch (error) {
      Alert.alert(
        t('models.actionFailedTitle'),
        getReportedErrorMessage('HuggingFaceTokenScreen.handleClear', error, t),
      );
    } finally {
      setBusy(null);
    }
  }, [t]);

  const handleOpenTokenSettings = useCallback(async () => {
    try {
      await Linking.openURL(HUGGING_FACE_TOKEN_SETTINGS_URL);
    } catch (error) {
      Alert.alert(
        t('models.actionFailedTitle'),
        getReportedErrorMessage('HuggingFaceTokenScreen.handleOpenTokenSettings', error, t),
      );
    }
  }, [t]);

  return (
    <Box className="flex-1 bg-background-0 dark:bg-background-950">
      <ScreenHeaderShell contentClassName="px-4 pb-3 pt-1">
        <Box className="flex-row items-center gap-3">
          <Pressable
            onPress={() => {
              if (router.canGoBack()) {
                router.back();
                return;
              }

              router.replace('/(tabs)/settings' as any);
            }}
            className="h-11 w-11 items-center justify-center rounded-full bg-background-50 active:opacity-70 dark:bg-background-900/60"
          >
            <MaterialSymbols name="arrow-back-ios-new" size={20} className="text-primary-500" />
          </Pressable>

          <Box className="flex-1">
            <Text className="text-xl font-bold text-typography-900 dark:text-typography-100">
              {t('settings.huggingFaceToken')}
            </Text>
            <Text className="mt-1 text-sm text-typography-500 dark:text-typography-400">
              {t('settings.huggingFaceTokenScreenDescription')}
            </Text>
          </Box>
        </Box>
      </ScreenHeaderShell>

      <ScrollView className="flex-1">
        <ScreenContent className="flex-1 px-4 pb-6 pt-3">
          <Box className="rounded-2xl border border-outline-200 bg-background-50 p-4 dark:border-outline-800 dark:bg-background-900/60">
            <Text className="text-sm font-semibold text-typography-900 dark:text-typography-100">
              {hasToken
                ? t('settings.huggingFaceTokenConfigured')
                : t('settings.huggingFaceTokenMissing')}
            </Text>
            <Text className="mt-2 text-sm text-typography-500 dark:text-typography-400">
              {t('settings.huggingFaceTokenHelper')}
            </Text>

            <Box className="mt-4 rounded-2xl border border-outline-200 bg-background-0 p-3 dark:border-outline-700 dark:bg-background-950">
              <Text className="text-sm font-semibold text-typography-900 dark:text-typography-100">
                {t('settings.huggingFaceTokenEducationTitle')}
              </Text>
              <Text className="mt-2 text-sm text-typography-500 dark:text-typography-400">
                {t('settings.huggingFaceTokenEducationBody')}
              </Text>
              <Text className="mt-2 text-sm text-typography-500 dark:text-typography-400">
                {t('settings.huggingFaceTokenRecommendation')}
              </Text>
            </Box>

            <Box className="mt-4">
              <Text className="mb-2 text-xs font-semibold uppercase tracking-wide text-typography-500 dark:text-typography-400">
                {t('settings.huggingFaceTokenInputLabel')}
              </Text>
              <Input className="rounded-2xl border border-outline-200 bg-background-0 px-3 py-1 dark:border-outline-700 dark:bg-background-950">
                <InputField
                  value={tokenDraft}
                  onChangeText={setTokenDraft}
                  placeholder={t('settings.huggingFaceTokenInputPlaceholder')}
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry
                  className="min-h-[48px] text-base text-typography-900 dark:text-typography-100"
                  placeholderTextColor="#94a3b8"
                />
              </Input>
            </Box>

            <Box className="mt-4 flex-row gap-3">
              <Button className="flex-1" onPress={() => { void handleSave(); }} disabled={busy !== null || tokenDraft.trim().length === 0}>
                <ButtonText>{busy === 'save' ? t('common.loading') : t('common.save')}</ButtonText>
              </Button>
              <Button action="secondary" className="flex-1" onPress={() => { void handleClear(); }} disabled={busy !== null || !hasToken}>
                <ButtonText>{busy === 'clear' ? t('common.loading') : t('common.clear')}</ButtonText>
              </Button>
            </Box>

            <Box className="mt-4 rounded-2xl border border-primary-200 bg-primary-500/10 p-3 dark:border-primary-800">
              <Text className="text-sm text-primary-700 dark:text-primary-300">
                {t('settings.huggingFaceTokenGetTokenHelper')}
              </Text>
              <Button action="secondary" className="mt-3 self-start" onPress={() => { void handleOpenTokenSettings(); }}>
                <ButtonText className="text-typography-900 dark:text-typography-100">
                  {t('settings.huggingFaceTokenGetToken')}
                </ButtonText>
              </Button>
            </Box>
          </Box>
        </ScreenContent>
      </ScrollView>
    </Box>
  );
}
