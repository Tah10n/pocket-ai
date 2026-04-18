import React from 'react';
import { useTranslation } from 'react-i18next';
import { ImageBackground } from 'react-native';
import { Box } from '@/components/ui/box';
import { Text, composeTextRole } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { MaterialSymbols } from './MaterialSymbols';
import { ScreenBadge, ScreenCard } from './ScreenShell';

export interface ModelListItemProps {
  id: string;
  name: string;
  sizeMB: number;
  status: 'active' | 'downloaded' | 'available';
  fitsInRam: boolean;
  onAction?: (action: 'download' | 'load' | 'unload' | 'cancel') => void;
  imageUrl?: string;
  isDownloading?: boolean;
  downloadProgress?: number;
}

export const ModelListItem = ({ name, sizeMB, status, fitsInRam, onAction, imageUrl, isDownloading, downloadProgress }: ModelListItemProps) => {
  const { t } = useTranslation();

  return (
    <ScreenCard className="flex-row overflow-hidden gap-3" padding="compact">
      <ImageBackground 
        source={{ uri: imageUrl || "https://lh3.googleusercontent.com/aida-public/AB6AXuClqJ0QsvXxhk32IfvK9KR5KtKAebI2v0rQoKXNy9mkHBiAObgp7YdhdUq5xwpkxuyWoQbIyMn0P30tRnXdEOKSYVGsploFFf1XtDHSwMsIPhjvSRFrDjPWgzhAljeVNZ3cZ6ym66vftvisNupauWLox5PJrkTbqhbloaqXDgiZj1qT0SsAuStE6i4Soe2hjJoI3nTW3JUsoxZIl4tHTOw3EuP3iOrvvHMD5CoSzAe7n2qDV2814t7j2xZ5BAeRiwiWaqLJHxzmwUzz" }}
        className="h-16 w-16 shrink-0 rounded-2xl bg-background-200 overflow-hidden dark:bg-background-800"
      />
      
      <Box className="flex-1 min-w-0">
        <Box className="flex-row items-start justify-between gap-2">
          <Text numberOfLines={2} className={composeTextRole('sectionTitle', 'flex-1 tracking-tight')}>{name}</Text>
          {fitsInRam ? (
            <ScreenBadge tone="success" size="micro">{t('models.fitsInRam')}</ScreenBadge>
          ) : (
            <ScreenBadge tone="warning" size="micro">{t('models.heavyLoad')}</ScreenBadge>
          )}
        </Box>
        
        <Text className={composeTextRole('caption', 'mt-1')}>{t('models.sizeLabel')} {(sizeMB / 1024).toFixed(1)} GB</Text>
        
        <Box className="mt-2.5 flex-row gap-2">
          {isDownloading ? (
            <Box className="relative flex-1 overflow-hidden rounded-2xl border border-outline-200 bg-background-100 py-1.5 dark:border-outline-700 dark:bg-background-800">
              <Box className="absolute left-0 top-0 bottom-0 bg-primary-500/20" style={{ width: `${(downloadProgress || 0) * 100}%` }} />
              <Pressable 
                onPress={() => onAction?.('cancel')} 
                className="flex-1 w-full items-center justify-center active:opacity-70"
              >
                <Text className="text-xs font-bold text-primary-500">{t('models.cancel')} ({((downloadProgress || 0) * 100).toFixed(0)}%)</Text>
              </Pressable>
            </Box>
          ) : status === 'available' && (
            <Pressable 
              onPress={() => onAction?.('download')} 
              className="flex-1 items-center justify-center rounded-2xl border border-outline-200 bg-background-100 py-1.5 active:opacity-70 dark:border-outline-700 dark:bg-background-800"
            >
                <Text className="text-xs font-bold text-typography-900 dark:text-typography-100">{t('models.download')}</Text>
            </Pressable>
          )}
          
          {status === 'downloaded' && (
            <Pressable 
              onPress={() => onAction?.('load')} 
              className="flex-1 items-center justify-center rounded-2xl bg-primary-500 py-1.5 active:opacity-80"
            >
              <Text className="text-xs font-bold text-typography-0">{t('models.load')}</Text>
            </Pressable>
          )}

          {status === 'active' && (
            <Pressable 
              onPress={() => onAction?.('unload')} 
              className="flex-1 items-center justify-center rounded-2xl bg-background-200 py-1.5 active:opacity-70 dark:bg-background-0/10"
            >
              <Text className="text-xs font-bold text-typography-900 dark:text-typography-0">{t('models.unload')}</Text>
            </Pressable>
          )}
          
          <Box className="items-center justify-center rounded-2xl border border-outline-200 bg-background-100 px-3 dark:border-outline-700 dark:bg-background-800">
            <MaterialSymbols name="more-horiz" size="sm" className="text-typography-500" />
          </Box>
        </Box>
      </Box>
    </ScreenCard>
  );
};
