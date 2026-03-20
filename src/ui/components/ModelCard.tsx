import React from 'react';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { Button, ButtonText } from '@/components/ui/button';
import { MaterialSymbols } from '@/components/ui/MaterialSymbols';

interface ModelCardProps {
    model: any;
    onDownload: (model: any) => void;
    onCancel: (modelId: string) => void;
    progress?: { status: string; percent: number } | null;
    isDownloaded: boolean;
}

export const ModelCard = ({ model, onDownload, onCancel, progress, isDownloaded }: ModelCardProps) => {
    const isDownloading = progress && (progress.status === 'downloading' || progress.status === 'pending');

    return (
        <Box className="bg-background-0 dark:bg-background-900 rounded-xl p-4 mb-4 border border-outline-200 dark:border-outline-800 shadow-sm">
            <Box className="flex-row justify-between items-start mb-2">
                <Box className="flex-1">
                    <Text className="text-lg font-bold text-typography-900 dark:text-typography-100">{model.name}</Text>
                    <Text className="text-sm text-typography-500 dark:text-typography-400">{model.description || `Parameters: ${model.parameters}`}</Text>
                </Box>
                <Box className="bg-primary-500/10 px-2 py-1 rounded-md">
                    <Text className="text-xs font-bold text-primary-600">{(model.sizeBytes / 1024 / 1024 / 1024).toFixed(2)} GB</Text>
                </Box>
            </Box>

            <Box className="flex-row items-center gap-4 mt-2">
                <Box className="flex-row items-center gap-1">
                    <MaterialSymbols name="memory" size={16} className="text-typography-400" />
                    <Text className="text-xs text-typography-500 dark:text-typography-400">{model.parameters || model.params}</Text>
                </Box>
                <Box className="flex-row items-center gap-1">
                    <MaterialSymbols name="analytics" size={16} className="text-typography-400" />
                    <Text className="text-xs text-typography-500 dark:text-typography-400">{model.quantization}</Text>
                </Box>
            </Box>

            {isDownloaded ? (
                <Text className="text-success-600 font-bold mt-4">Ready to use</Text>
            ) : isDownloading ? (
                <Box className="mt-4">
                    <Box className="h-2 w-full bg-background-200 dark:bg-background-800 rounded-full overflow-hidden">
                        <Box className="h-full bg-primary-500" style={{ width: `${(progress?.percent || 0) * 100}%` }} />
                    </Box>
                    <Box className="flex-row justify-between items-center mt-2">
                        <Text className="text-xs text-typography-600 dark:text-typography-400">Downloading... {((progress?.percent || 0) * 100).toFixed(1)}%</Text>
                        <Button action="negative" size="xs" onPress={() => onCancel(model.id)}>
                            <ButtonText>Cancel</ButtonText>
                        </Button>
                    </Box>
                </Box>
            ) : (
                <Box className="mt-4 flex-row gap-3">
                    <Button 
                        className="flex-1"
                        action="primary" 
                        onPress={() => onDownload(model)}
                    >
                        <ButtonText>Download</ButtonText>
                    </Button>
                </Box>
            )}
        </Box>
    );
};
