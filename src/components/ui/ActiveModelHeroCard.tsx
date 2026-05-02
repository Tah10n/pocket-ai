import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ImageBackground } from 'react-native';
import { Box } from '@/components/ui/box';
import { Text, composeTextRole } from '@/components/ui/text';
import { MaterialSymbols } from './MaterialSymbols';
import { ProgressBar } from './ProgressBar';
import { ScreenActionPill, ScreenBadge, ScreenCard, ScreenSurface, useScreenAppearance } from './ScreenShell';
import { getThemeActionContentClassName } from '@/utils/themeTokens';

interface ActiveModelHeroCardProps {
  name: string;
  fitsInRam: boolean;
  memoryUsedGB: number;
  memoryTotalGB: number;
  onChat?: () => void;
  onUnload?: () => void;
}

export const ActiveModelHeroCard = ({
  name,
  fitsInRam,
  memoryUsedGB,
  memoryTotalGB,
  onChat,
  onUnload,
}: ActiveModelHeroCardProps) => {
  const { t } = useTranslation();
  const appearance = useScreenAppearance();
  const neutralToneClassNames = appearance.classNames.toneClassNameByTone.neutral;
  const primaryActionContentClassName = getThemeActionContentClassName(appearance, 'primary');
  const softActionContentClassName = getThemeActionContentClassName(appearance, 'soft');
  const usedPercent = useMemo(() => {
    if (memoryTotalGB <= 0) return 0;
    return Math.min(100, Math.max(0, (memoryUsedGB / memoryTotalGB) * 100));
  }, [memoryUsedGB, memoryTotalGB]);

  return (
    <ScreenCard className="overflow-hidden" padding="none">
      <ImageBackground
        source={{ uri: "https://lh3.googleusercontent.com/aida-public/AB6AXuBgeacQzvDee5FRz4IolAFCYeRdjSi5o964zo1nH9_1RSd9jOXPsbeN7v2xGEizVFs5ap4YlxkkTvYwU7gAsmGYx5fdjy-EXVSDSplqL6g442DP_jqpWlBitLu19YImIfHJbZYQpZv3VcFmqTpeZ_4PyHInFynYgjtublbwQyS1CMUs9W381FQ7AEcDpX-74bUZcI2DZBNIMXsm5MVuPa4uPRBjhiiHrtM3aM-1xahPOz-5J7NEKxdVQg4hCDW573lexS2Kb4VbxWDV" }}
        className="h-36 w-full"
      >
        <Box className={`absolute inset-0 ${appearance.classNames.heroImageOverlayClassName}`} />
        <Box className={`absolute inset-0 ${appearance.classNames.heroImageScrimClassName}`} />
        <Box className="flex-1 justify-between p-4">
          <ScreenBadge tone="success" size="micro" className="self-start">
            {t('common.active')}
          </ScreenBadge>
          <ScreenSurface
            tone="neutral"
            withControlTint
            className={`self-start flex-row items-center gap-1.5 ${appearance.classNames.inlinePillClassName}`}
          >
            <MaterialSymbols name="memory" size="sm" className={neutralToneClassNames.iconClassName} />
            <Text className={composeTextRole('caption', neutralToneClassNames.valueClassName)}>
              {t('home.activeModelHeroMemory', { used: memoryUsedGB.toFixed(1) })}
            </Text>
          </ScreenSurface>
        </Box>
      </ImageBackground>

      <Box className="gap-4 p-4">
        <Box className="flex-row items-center justify-between">
          <Box className="flex-1 pr-3">
            <Text className={composeTextRole('screenTitle')} numberOfLines={1}>
              {name}
            </Text>
            <Box className="mt-2 flex-row items-center gap-2">
              <ScreenBadge tone="success" size="micro">{t('common.active')}</ScreenBadge>
              <ScreenBadge tone={fitsInRam ? 'success' : 'warning'} size="micro">
                {fitsInRam ? t('models.fitsInRam') : t('models.heavyLoad')}
              </ScreenBadge>
            </Box>
          </Box>
          <Box className="items-end">
            <Text className={composeTextRole('eyebrow')}>
              {t('home.activeModelMemoryOccupancy')}
            </Text>
            <Text className={composeTextRole('body', `mt-1 font-semibold ${neutralToneClassNames.valueClassName}`)}>
              {t('home.activeModelHeroMemoryRange', { used: memoryUsedGB.toFixed(1), total: memoryTotalGB.toFixed(0) })}
            </Text>
          </Box>
        </Box>

        <ProgressBar valuePercent={usedPercent} />

        <Box className="flex-row gap-3">
          <ScreenActionPill
            onPress={onChat}
            tone="primary"
            size="md"
            className="flex-1"
          >
            <Text className={composeTextRole('action', primaryActionContentClassName)}>{t('models.chat')}</Text>
          </ScreenActionPill>
          <ScreenActionPill
            onPress={onUnload}
            tone="soft"
            size="md"
            className="flex-1"
          >
            <Text className={composeTextRole('action', softActionContentClassName)}>{t('models.unload')}</Text>
          </ScreenActionPill>
        </Box>
      </Box>
    </ScreenCard>
  );
};
