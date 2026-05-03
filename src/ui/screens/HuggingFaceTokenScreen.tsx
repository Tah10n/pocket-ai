import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Linking } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { HeaderBar } from '@/components/ui/HeaderBar';
import { ScreenCard, ScreenContent, ScreenStack, ScreenTextField } from '@/components/ui/ScreenShell';
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

  const handleBack = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }

    router.replace('/(tabs)/settings');
  }, [router]);

  return (
    <Box className="flex-1 bg-background-0 dark:bg-background-950">
      <HeaderBar
        title={t('settings.huggingFaceToken')}
        subtitle={t('settings.huggingFaceTokenScreenDescription')}
        onBack={handleBack}
        backAccessibilityLabel={t('chat.headerBackAccessibilityLabel')}
      />

      <ScreenContent className="flex-1 pt-3">
        <ScrollView
          className="flex-1"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ flexGrow: 1 }}
        >
          <ScreenStack className="pb-2" gap="loose">
            <ScreenCard padding="large">
              <Text className="text-sm font-semibold text-typography-900 dark:text-typography-100">
                {hasToken
                  ? t('settings.huggingFaceTokenConfigured')
                  : t('settings.huggingFaceTokenMissing')}
              </Text>
              <Text className="mt-2 text-sm leading-6 text-typography-500 dark:text-typography-400">
                {t('settings.huggingFaceTokenHelper')}
              </Text>
            </ScreenCard>

            <ScreenTextField
              label={t('settings.huggingFaceTokenInputLabel')}
              size="prominent"
              value={tokenDraft}
              onChangeText={setTokenDraft}
              placeholder={t('settings.huggingFaceTokenInputPlaceholder')}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
            />

            <ScreenCard tone="accent" padding="large">
              <Text className="text-sm font-semibold text-typography-900 dark:text-typography-100">
                {t('settings.huggingFaceTokenEducationTitle')}
              </Text>
              <Text className="mt-2 text-sm leading-6 text-typography-500 dark:text-typography-400">
                {t('settings.huggingFaceTokenEducationBody')}
              </Text>
              <Text className="mt-2 text-sm leading-6 text-typography-500 dark:text-typography-400">
                {t('settings.huggingFaceTokenRecommendation')}
              </Text>
              <Text className="mt-4 text-sm text-primary-700 dark:text-primary-300">
                {t('settings.huggingFaceTokenGetTokenHelper')}
              </Text>
              <Button action="secondary" className="mt-4 self-start" onPress={() => { void handleOpenTokenSettings(); }}>
                <ButtonText className="text-typography-900 dark:text-typography-100">
                  {t('settings.huggingFaceTokenGetToken')}
                </ButtonText>
              </Button>
            </ScreenCard>
          </ScreenStack>
        </ScrollView>
      </ScreenContent>

      <ScreenContent className="pt-4" includeBottomSafeArea>
        <Box className="flex-row gap-3">
          <Button className="flex-1" onPress={() => { void handleSave(); }} disabled={busy !== null || tokenDraft.trim().length === 0}>
            <ButtonText>{busy === 'save' ? t('common.loading') : t('common.save')}</ButtonText>
          </Button>
          <Button action="secondary" className="flex-1" onPress={() => { void handleClear(); }} disabled={busy !== null || !hasToken}>
            <ButtonText>{busy === 'clear' ? t('common.loading') : t('common.clear')}</ButtonText>
          </Button>
        </Box>
      </ScreenContent>
    </Box>
  );
}
