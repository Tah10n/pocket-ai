import React from 'react';
import { ImageBackground } from 'react-native';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { Pressable } from '@/components/ui/pressable';
import { MaterialSymbols } from './MaterialSymbols';

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
  return (
    <Box className="flex-row rounded-xl overflow-hidden bg-background-50 dark:bg-background-900/40 border border-outline-200 dark:border-outline-800 p-4 gap-4">
      <ImageBackground 
        source={{ uri: imageUrl || "https://lh3.googleusercontent.com/aida-public/AB6AXuClqJ0QsvXxhk32IfvK9KR5KtKAebI2v0rQoKXNy9mkHBiAObgp7YdhdUq5xwpkxuyWoQbIyMn0P30tRnXdEOKSYVGsploFFf1XtDHSwMsIPhjvSRFrDjPWgzhAljeVNZ3cZ6ym66vftvisNupauWLox5PJrkTbqhbloaqXDgiZj1qT0SsAuStE6i4Soe2hjJoI3nTW3JUsoxZIl4tHTOw3EuP3iOrvvHMD5CoSzAe7n2qDV2814t7j2xZ5BAeRiwiWaqLJHxzmwUzz" }}
        className="size-20 shrink-0 rounded-lg bg-background-200 dark:bg-background-800 overflow-hidden" 
      />
      
      <Box className="flex-1 min-w-0">
        <Box className="flex-row justify-between items-start">
          <Text className="text-sm font-bold truncate text-typography-900 dark:text-typography-100">{name}</Text>
          {fitsInRam ? (
            <Box className="bg-success-500/10 px-2 py-0.5 rounded-full">
              <Text className="text-success-500 text-xs font-bold">Fits in RAM</Text>
            </Box>
          ) : (
            <Box className="bg-warning-500/10 px-2 py-0.5 rounded-full">
              <Text className="text-warning-500 text-xs font-bold">Heavy Load</Text>
            </Box>
          )}
        </Box>
        
        <Text className="text-xs text-typography-500 dark:text-typography-400 mt-1">Size: {(sizeMB / 1024).toFixed(1)} GB</Text>
        
        <Box className="mt-3 flex-row gap-2">
          {isDownloading ? (
            <Box className="flex-1 bg-background-100 dark:bg-background-800 items-center justify-center py-1.5 rounded-lg border border-outline-200 dark:border-outline-700 overflow-hidden relative">
              <Box className="absolute left-0 top-0 bottom-0 bg-primary-500/20" style={{ width: `${(downloadProgress || 0) * 100}%` }} />
              <Pressable 
                onPress={() => onAction?.('cancel')} 
                className="flex-1 w-full items-center justify-center active:opacity-70"
              >
                <Text className="text-primary-500 text-xs font-bold">Cancel ({( (downloadProgress || 0) * 100).toFixed(0)}%)</Text>
              </Pressable>
            </Box>
          ) : status === 'available' && (
            <Pressable 
              onPress={() => onAction?.('download')} 
              className="flex-1 bg-background-100 dark:bg-background-800 items-center justify-center py-1.5 rounded-lg border border-outline-200 dark:border-outline-700 active:opacity-70"
            >
                <Text className="text-typography-900 dark:text-typography-100 text-xs font-bold">Download</Text>
            </Pressable>
          )}
          
          {status === 'downloaded' && (
            <Pressable 
              onPress={() => onAction?.('load')} 
              className="flex-1 bg-primary-500 items-center justify-center py-1.5 rounded-lg active:opacity-80"
            >
              <Text className="text-typography-0 text-xs font-bold">Load Model</Text>
            </Pressable>
          )}

          {status === 'active' && (
            <Pressable 
              onPress={() => onAction?.('unload')} 
              className="flex-1 bg-background-200 dark:bg-background-0/10 items-center justify-center py-1.5 rounded-lg active:opacity-70"
            >
              <Text className="text-typography-900 dark:text-typography-0 text-xs font-bold">Unload</Text>
            </Pressable>
          )}
          
          <Pressable 
            className="px-3 bg-background-100 dark:bg-background-800 items-center justify-center rounded-lg border border-outline-200 dark:border-outline-700 active:opacity-70"
          >
            <MaterialSymbols name="more-horiz" size={16} className="text-typography-500" />
          </Pressable>
        </Box>
      </Box>
    </Box>
  );
};
