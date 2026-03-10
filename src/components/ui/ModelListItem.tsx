import React from 'react';
import { View, Text, TouchableOpacity, ImageBackground } from 'react-native';
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
    <View className="flex-row rounded-xl overflow-hidden bg-white dark:bg-slate-800/40 border border-slate-200 dark:border-slate-800 p-3 gap-4 mb-4">
      <ImageBackground 
        source={{ uri: imageUrl || "https://lh3.googleusercontent.com/aida-public/AB6AXuClqJ0QsvXxhk32IfvK9KR5KtKAebI2v0rQoKXNy9mkHBiAObgp7YdhdUq5xwpkxuyWoQbIyMn0P30tRnXdEOKSYVGsploFFf1XtDHSwMsIPhjvSRFrDjPWgzhAljeVNZ3cZ6ym66vftvisNupauWLox5PJrkTbqhbloaqXDgiZj1qT0SsAuStE6i4Soe2hjJoI3nTW3JUsoxZIl4tHTOw3EuP3iOrvvHMD5CoSzAe7n2qDV2814t7j2xZ5BAeRiwiWaqLJHxzmwUzz" }}
        className="size-20 shrink-0 rounded-lg bg-slate-200 dark:bg-slate-800 overflow-hidden" 
      />
      
      <View className="flex-1 min-w-0">
        <View className="flex-row justify-between items-start">
          <Text className="text-sm font-bold truncate text-slate-900 dark:text-slate-100">{name}</Text>
          {fitsInRam ? (
            <View className="bg-green-500/10 px-2 py-0.5 rounded-full">
              <Text className="text-green-500 text-[10px] font-bold">Fits in RAM</Text>
            </View>
          ) : (
            <View className="bg-orange-500/10 px-2 py-0.5 rounded-full">
              <Text className="text-orange-500 text-[10px] font-bold">Heavy Load</Text>
            </View>
          )}
        </View>
        
        <Text className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">Size: {(sizeMB / 1024).toFixed(1)} GB</Text>
        
        <View className="mt-3 flex-row gap-2">
          {isDownloading ? (
            <View className="flex-1 bg-slate-100 dark:bg-slate-800 items-center justify-center py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden relative">
              <View className="absolute left-0 top-0 bottom-0 bg-primary/20" style={{ width: `${(downloadProgress || 0) * 100}%` }} />
              <TouchableOpacity onPress={() => onAction?.('cancel')} className="flex-1 w-full items-center justify-center">
                <Text className="text-primary dark:text-primary text-[11px] font-bold">Cancel ({( (downloadProgress || 0) * 100).toFixed(0)}%)</Text>
              </TouchableOpacity>
            </View>
          ) : status === 'available' && (
            <TouchableOpacity onPress={() => onAction?.('download')} className="flex-1 bg-slate-100 dark:bg-slate-800 items-center justify-center py-1.5 rounded-lg border border-slate-200 dark:border-slate-700">
              <Text className="text-slate-900 dark:text-slate-100 text-[11px] font-bold">Download</Text>
            </TouchableOpacity>
          )}
          
          {status === 'downloaded' && (
            <TouchableOpacity onPress={() => onAction?.('load')} className="flex-1 bg-primary items-center justify-center py-1.5 rounded-lg">
              <Text className="text-white text-[11px] font-bold">Load Model</Text>
            </TouchableOpacity>
          )}

          {status === 'active' && (
            <TouchableOpacity onPress={() => onAction?.('unload')} className="flex-1 bg-slate-200 dark:bg-white/10 items-center justify-center py-1.5 rounded-lg">
              <Text className="text-slate-900 dark:text-white text-[11px] font-bold">Unload</Text>
            </TouchableOpacity>
          )}
          
          <TouchableOpacity className="px-3 bg-slate-100 dark:bg-slate-800 items-center justify-center rounded-lg border border-slate-200 dark:border-slate-700">
            <MaterialSymbols name="more_horiz" size={16} className="text-slate-500" />
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
};
