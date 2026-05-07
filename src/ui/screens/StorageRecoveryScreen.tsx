import React, { useCallback, useMemo } from 'react';
import { Alert } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { ScreenBadge, ScreenCard, ScreenContent, ScreenIconTile, ScreenRoot, ScreenStack } from '@/components/ui/ScreenShell';
import { ScrollView } from '@/components/ui/scroll-view';
import { Text } from '@/components/ui/text';
import type { PrivateStorageBlockReason, PrivateStorageHealthSnapshot } from '../../services/storage';

export type StorageRecoveryBusyState = boolean | 'retry' | 'reset';

export interface StorageRecoveryScreenProps {
    readonly health: PrivateStorageHealthSnapshot;
    readonly onRetry: () => void | Promise<void>;
    readonly onReset: () => void | Promise<void>;
    readonly busy?: StorageRecoveryBusyState;
    readonly disabled?: boolean;
}

const reasonMessageKeyByReason: Record<PrivateStorageBlockReason, string> = {
    encryption_not_initialized: 'storageRecovery.reason.encryptionNotInitialized',
    encryption_initializing: 'storageRecovery.reason.encryptionInitializing',
    encryption_unavailable: 'storageRecovery.reason.encryptionUnavailable',
    secure_key_unavailable: 'storageRecovery.reason.secureKeyUnavailable',
    migration_failed: 'storageRecovery.reason.migrationFailed',
    encrypted_open_failed: 'storageRecovery.reason.encryptedOpenFailed',
    reset_failed: 'storageRecovery.reason.resetFailed',
    unknown: 'storageRecovery.reason.unknown',
};

function getStatusKey(status: PrivateStorageHealthSnapshot['status']) {
    switch (status) {
        case 'initializing':
            return 'storageRecovery.status.initializing';
        case 'ready':
            return 'storageRecovery.status.ready';
        case 'resetting':
            return 'storageRecovery.status.resetting';
        case 'blocked':
            return 'storageRecovery.status.blocked';
        case 'unknown':
        default:
            return 'storageRecovery.status.unknown';
    }
}

function getHealthMessageKey(health: PrivateStorageHealthSnapshot) {
    if (health.messageKey?.startsWith('storageRecovery.')) {
        return health.messageKey;
    }

    return health.reason ? reasonMessageKeyByReason[health.reason] : 'storageRecovery.unavailableMessage';
}

export function StorageRecoveryScreen({
    health,
    onRetry,
    onReset,
    busy = false,
    disabled = false,
}: StorageRecoveryScreenProps) {
    const { t } = useTranslation();
    const isAnyBusy = busy === true || busy === 'retry' || busy === 'reset';
    const isRetryBusy = busy === true || busy === 'retry';
    const isResetBusy = busy === true || busy === 'reset';
    const retryDisabled = disabled || isAnyBusy || !health.retryable || health.status === 'resetting';
    const resetDisabled = disabled || isAnyBusy || health.status === 'resetting';
    const statusLabel = t(getStatusKey(health.status));
    const healthMessage = t(getHealthMessageKey(health));
    const canShowReset = health.requiresExplicitReset;
    const canShowRetry = health.retryable;

    const handleRetry = useCallback(() => {
        if (retryDisabled) {
            return;
        }

        void onRetry();
    }, [onRetry, retryDisabled]);

    const resetConfirmationButtons = useMemo(() => [
        { text: t('storageRecovery.resetConfirmCancel'), style: 'cancel' as const },
        {
            text: t('storageRecovery.resetConfirmAction'),
            style: 'destructive' as const,
            onPress: () => {
                if (resetDisabled) {
                    return;
                }

                void onReset();
            },
        },
    ], [onReset, resetDisabled, t]);

    const handleReset = useCallback(() => {
        if (resetDisabled) {
            return;
        }

        Alert.alert(
            t('storageRecovery.resetConfirmTitle'),
            t('storageRecovery.resetConfirmMessage'),
            resetConfirmationButtons,
        );
    }, [resetConfirmationButtons, resetDisabled, t]);

    return (
        <ScreenRoot testID="storage-recovery-screen">
            <ScrollView className="flex-1" contentContainerStyle={{ flexGrow: 1 }} showsVerticalScrollIndicator={false}>
                <ScreenContent className="flex-1 justify-center py-8" includeBottomSafeArea>
                    <ScreenStack gap="loose">
                        <ScreenCard tone="error" padding="large" testID="storage-recovery-card">
                            <Box className="gap-5">
                                <Box className="flex-row items-start gap-3">
                                    <ScreenIconTile iconName="lock" tone="error" size="lg" iconSize={24} />
                                    <Box className="min-w-0 flex-1 gap-2">
                                        <Box className="flex-row flex-wrap items-center gap-2">
                                            <Text textRole="eyebrow" className="text-error-600 dark:text-error-300">
                                                {t('storageRecovery.eyebrow')}
                                            </Text>
                                            <ScreenBadge tone="error">{statusLabel}</ScreenBadge>
                                        </Box>

                                        <Text textRole="display">
                                            {t('storageRecovery.title')}
                                        </Text>
                                    </Box>
                                </Box>

                                <Text textRole="body">
                                    {t('storageRecovery.description')}
                                </Text>

                                <Box
                                    className="rounded-lg border border-warning-200 bg-warning-50 p-3 dark:border-warning-700 dark:bg-warning-950"
                                    testID="storage-recovery-health-message"
                                >
                                    <Text textRole="bodyMuted" className="text-typography-700 dark:text-typography-200">
                                        {healthMessage}
                                    </Text>
                                </Box>

                                <Box
                                    className="rounded-lg border border-outline-200 bg-background-0 p-3 dark:border-outline-700 dark:bg-background-950"
                                    testID="storage-recovery-data-preserved"
                                >
                                    <Box className="flex-row items-start gap-3">
                                        <ScreenIconTile iconName="verified-user" tone="accent" size="sm" iconSize={18} />
                                        <Box className="min-w-0 flex-1 gap-1">
                                            <Text textRole="sectionTitle">
                                                {t('storageRecovery.existingDataPreserved')}
                                            </Text>
                                            <Text textRole="bodyMuted">
                                                {t('storageRecovery.resetScope')}
                                            </Text>
                                        </Box>
                                    </Box>
                                </Box>

                                <Box className="gap-3 pt-1">
                                    {canShowRetry ? (
                                        <Button
                                            action="primary"
                                            disabled={retryDisabled}
                                            testID="storage-recovery-retry-button"
                                            onPress={handleRetry}
                                            className="w-full"
                                        >
                                            <ButtonText>{isRetryBusy ? t('storageRecovery.retryBusy') : t('storageRecovery.retry')}</ButtonText>
                                        </Button>
                                    ) : null}

                                    {canShowReset ? (
                                        <Button
                                            action="softDestructive"
                                            disabled={resetDisabled}
                                            testID="storage-recovery-reset-button"
                                            onPress={handleReset}
                                            className="w-full"
                                        >
                                            <ButtonText>{isResetBusy ? t('storageRecovery.resetBusy') : t('storageRecovery.reset')}</ButtonText>
                                        </Button>
                                    ) : null}

                                    {!canShowRetry && !canShowReset ? (
                                        <Text textRole="bodyMuted" testID="storage-recovery-unavailable-message">
                                            {t('storageRecovery.unavailableMessage')}
                                        </Text>
                                    ) : null}
                                </Box>
                            </Box>
                        </ScreenCard>
                    </ScreenStack>
                </ScreenContent>
            </ScrollView>
        </ScreenRoot>
    );
}
