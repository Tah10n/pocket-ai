import React from 'react';
import { useTranslation } from 'react-i18next';
import { ImageBackground } from 'react-native';
import { Box } from '@/components/ui/box';
import { Text, composeTextRole } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { MaterialSymbols } from './MaterialSymbols';
import { ScreenActionPill, ScreenBadge, ScreenCard, ScreenSurface } from './ScreenShell';
import { useTheme } from '../../providers/ThemeProvider';

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
  const { colors } = useTheme();
  const progressPercent = Math.max(0, Math.min(100, (downloadProgress || 0) * 100));

  return (
    <ScreenCard className="flex-row overflow-hidden gap-3" padding="compact">
      <ImageBackground 
        source={{ uri: imageUrl || "https://lh3.googleusercontent.com/aida-public/AB6AXuClqJ0QsvXxhk32IfvK9KR5KtKAebI2v0rQoKXNy9mkHBiAObgp7YdhdUq5xwpkxuyWoQbIyMn0P30tRnXdEOKSYVGsploFFf1XtDHSwMsIPhjvSRFrDjPWgzhAljeVNZ3cZ6ym66vftvisNupauWLox5PJrkTbqhbloaqXDgiZj1qT0SsAuStE6i4Soe2hjJoI3nTW3JUsoxZIl4tHTOw3EuP3iOrvvHMD5CoSzAe7n2qDV2814t7j2xZ5BAeRiwiWaqLJHxzmwUzz" }}
        className="h-16 w-16 shrink-0 overflow-hidden rounded-2xl"
        style={{ backgroundColor: colors.thumbnailBackground }}
      />
      
      <Box className="flex-1 min-w-0">
        <Box className="flex-row items-start justify-between gap-2">
          <Text colorRole="primary" numberOfLines={2} className={composeTextRole('sectionTitle', 'flex-1 tracking-tight')}>{name}</Text>
          {fitsInRam ? (
            <ScreenBadge tone="success" size="micro">{t('models.fitsInRam')}</ScreenBadge>
          ) : (
            <ScreenBadge tone="warning" size="micro">{t('models.heavyLoad')}</ScreenBadge>
          )}
        </Box>
        
        <Text colorRole="tertiary" className={composeTextRole('caption', 'mt-1')}>{t('models.sizeLabel')} {(sizeMB / 1024).toFixed(1)} GB</Text>
        
        <Box className="mt-2.5 flex-row gap-2">
          {isDownloading ? (
            <ScreenSurface tone="accent" withControlTint className="relative flex-1 overflow-hidden">
              <Box className="absolute bottom-0 left-0 top-0 bg-primary-500" style={{ width: `${progressPercent}%` }} />
              <Pressable 
                onPress={() => onAction?.('cancel')} 
                className="flex-1 w-full items-center justify-center py-1.5 active:opacity-70"
              >
                <Text colorRole="accent" className={composeTextRole('chip', 'text-center')}>{t('models.cancel')} ({progressPercent.toFixed(0)}%)</Text>
              </Pressable>
            </ScreenSurface>
          ) : status === 'available' && (
            <ScreenActionPill
              onPress={() => onAction?.('download')} 
              tone="soft"
              size="sm"
              className="flex-1"
            >
                <Text colorRole="softAction" className={composeTextRole('chip')}>{t('models.download')}</Text>
            </ScreenActionPill>
          )}
          
          {status === 'downloaded' && (
            <ScreenActionPill
              onPress={() => onAction?.('load')} 
              tone="primary"
              size="sm"
              className="flex-1"
            >
              <Text colorRole="onAccent" className={composeTextRole('chip')}>{t('models.load')}</Text>
            </ScreenActionPill>
          )}

          {status === 'active' && (
            <ScreenActionPill
              onPress={() => onAction?.('unload')} 
              tone="soft"
              size="sm"
              className="flex-1"
            >
              <Text colorRole="softAction" className={composeTextRole('chip')}>{t('models.unload')}</Text>
            </ScreenActionPill>
          )}
          
          <ScreenSurface tone="neutral" withControlTint className="items-center justify-center px-3">
            <MaterialSymbols name="more-horiz" size="sm" colorRole="icon" />
          </ScreenSurface>
        </Box>
      </Box>
    </ScreenCard>
  );
};
