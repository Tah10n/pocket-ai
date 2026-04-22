import React from 'react';
import { Alert } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import HomeScreen from '../app/(tabs)/index';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useBootstrapStore } from '../src/store/bootstrapStore';
import { screenLayoutMetrics } from '../src/utils/themeTokens';

const reactI18nextMock = jest.requireMock('react-i18next') as {
    __setTranslationOverride: (key: string, value: string, nextLanguage?: string) => void;
    __resetTranslations: () => void;
};

const mockPush = jest.fn();
const mockNavigate = jest.fn();
const mockReplace = jest.fn();
const mockGetModels = jest.fn((): any[] => []);
const mockStartNewChat = jest.fn();
const mockDeleteThread = jest.fn();
const mockOpenThread = jest.fn();
let mockEngineState: { activeModelId: string | null } = {
    activeModelId: 'author/model-q4',
};
const recentConversation = {
    id: 'thread-1',
    title: 'Trip ideas',
    lastMessagePreview: 'Pack light',
    modelId: 'author/model-q4',
    updatedAt: 0,
    messageCount: 1,
    presetId: null,
};

jest.mock('@react-navigation/bottom-tabs', () => ({
    useBottomTabBarHeight: () => 0,
}));

// Mock expo-router components
jest.mock('expo-router', () => ({
    Link: ({ children }: any) => <>{children}</>,
    useRouter: () => ({ push: mockPush, navigate: mockNavigate, replace: mockReplace }),
    Stack: {
        Screen: () => null,
    },
}));

jest.mock('expo-image', () => ({
    Image: () => 'Image',
}));

jest.mock('@/components/ui/ActiveModelCard', () => {
    const mockReact = require('react');
    const { Pressable, Text } = require('react-native');

    return {
        ActiveModelCard: ({ onSwapModel }: any) => (
            <Pressable testID="active-model-card" onPress={onSwapModel}>
                <Text>Active model card</Text>
            </Pressable>
        ),
    };
});

jest.mock('../src/hooks/useChatSession', () => ({
    useChatSession: () => ({
        deleteThread: mockDeleteThread,
        openThread: mockOpenThread,
        renameThread: jest.fn(),
        startNewChat: mockStartNewChat,
    }),
}));

jest.mock('@/hooks/useLLMEngine', () => ({
    useLLMEngine: () => ({
        state: mockEngineState,
    }),
}));

jest.mock('@/services/LocalStorageRegistry', () => ({
    registry: {
        getModels: () => mockGetModels(),
        hasAnyDownloadedModels: () => mockGetModels().some((model: any) => (
            model?.lifecycleStatus === 'downloaded' || model?.lifecycleStatus === 'active'
        )),
        getModelsRevision: () => 0,
        subscribeModels: () => () => {},
    },
}));

// Mock NativeEventEmitter
jest.mock('react-native/Libraries/EventEmitter/NativeEventEmitter');

jest.mock('@/components/ui/RecentConversationsList', () => {
    const mockReact = require('react');
    const { Pressable, Text, View } = require('react-native');

    return {
        RecentConversationsList: ({ onDeleteConversation, onOpenConversation, onViewAllConversations }: any) => (
            <View>
                <Pressable
                    accessibilityLabel="common.manage"
                    testID="manage-conversations-button"
                    onPress={onViewAllConversations}
                >
                    <Text>Manage conversations</Text>
                </Pressable>
                <Pressable
                    testID="open-conversation-button"
                    onPress={() => onOpenConversation(recentConversation)}
                >
                    <Text>Open conversation</Text>
                </Pressable>
                <Pressable
                    testID="delete-conversation-button"
                    onPress={() => onDeleteConversation(recentConversation)}
                >
                    <Text>Delete conversation</Text>
                </Pressable>
            </View>
        ),
    };
});

function flattenStyle(style: any) {
    if (Array.isArray(style)) {
        return style.reduce((result, entry) => ({ ...result, ...flattenStyle(entry) }), {});
    }

    return style ?? {};
}

describe('HomeScreen', () => {
    const originalDev = (globalThis as any).__DEV__;

    beforeEach(() => {
        mockPush.mockReset();
        mockNavigate.mockReset();
        mockReplace.mockReset();
        mockGetModels.mockReset();
        mockGetModels.mockReturnValue([]);
        mockStartNewChat.mockReset();
        mockDeleteThread.mockReset();
        mockOpenThread.mockReset();
        mockEngineState = {
            activeModelId: 'author/model-q4',
        };
        reactI18nextMock.__resetTranslations();
        reactI18nextMock.__setTranslationOverride('home.deleteConversationMessage', 'Delete {{title}}?');
        useBootstrapStore.setState({
            criticalOutcome: 'success',
            backgroundState: 'idle',
            backgroundError: null,
        });
        (globalThis as any).__DEV__ = originalDev ?? true;
    });

    afterAll(() => {
        (globalThis as any).__DEV__ = originalDev;
    });

    it('renders successfully with translation keys and root chrome accessibility affordances', () => {
        const { getByLabelText, getByText, queryByLabelText } = render(
            <SafeAreaProvider
                initialMetrics={{
                    frame: { x: 0, y: 0, width: 390, height: 844 },
                    insets: { top: 0, left: 0, right: 0, bottom: 0 },
                }}
            >
                <HomeScreen />
            </SafeAreaProvider>
        );
        expect(getByText('Pocket AI')).toBeTruthy();
        expect(getByText('home.newChat')).toBeTruthy();
        expect(getByLabelText('home.newChat')).toBeTruthy();
        expect(getByLabelText('common.manage')).toBeTruthy();
        expect(queryByLabelText('Go back')).toBeNull();
    });

    it('opens the full catalog when there is no active or downloaded model', () => {
        mockEngineState = {
            activeModelId: null,
        };
        mockGetModels.mockReturnValue([]);

        const { getByTestId } = render(
            <SafeAreaProvider
                initialMetrics={{
                    frame: { x: 0, y: 0, width: 390, height: 844 },
                    insets: { top: 0, left: 0, right: 0, bottom: 0 },
                }}
            >
                <HomeScreen />
            </SafeAreaProvider>
        );

        fireEvent.press(getByTestId('active-model-card'));

        expect(mockNavigate).toHaveBeenCalledWith('/(tabs)/models');
    });

    it('opens the downloaded tab when there is no active model but local models exist', () => {
        mockEngineState = {
            activeModelId: null,
        };
        mockGetModels.mockReturnValue([{ id: 'author/model-q4', lifecycleStatus: 'downloaded' }]);

        const { getByTestId } = render(
            <SafeAreaProvider
                initialMetrics={{
                    frame: { x: 0, y: 0, width: 390, height: 844 },
                    insets: { top: 0, left: 0, right: 0, bottom: 0 },
                }}
            >
                <HomeScreen />
            </SafeAreaProvider>
        );

        fireEvent.press(getByTestId('active-model-card'));

        expect(mockNavigate).toHaveBeenCalledWith({
            pathname: '/(tabs)/models',
            params: { initialTab: 'downloaded' },
        });
    });

    it('starts a fresh chat before navigating to the chat tab', () => {
        const { getByText } = render(
            <SafeAreaProvider
                initialMetrics={{
                    frame: { x: 0, y: 0, width: 390, height: 844 },
                    insets: { top: 0, left: 0, right: 0, bottom: 0 },
                }}
            >
                <HomeScreen />
            </SafeAreaProvider>
        );

        fireEvent.press(getByText('home.newChat'));

        expect(mockStartNewChat).toHaveBeenCalled();
        expect(mockNavigate).toHaveBeenCalledWith('/(tabs)/chat');
    });

    it('shows an error alert when starting a chat fails', async () => {
        const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
        const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        mockStartNewChat.mockImplementation(() => {
            throw new Error('boot failed');
        });

        try {
            const { getByText } = render(
                <SafeAreaProvider
                    initialMetrics={{
                        frame: { x: 0, y: 0, width: 390, height: 844 },
                        insets: { top: 0, left: 0, right: 0, bottom: 0 },
                    }}
                >
                    <HomeScreen />
                </SafeAreaProvider>
            );

            fireEvent.press(getByText('home.newChat'));

            await waitFor(() => {
                expect(alertSpy).toHaveBeenCalledWith('conversations.startNewChatErrorTitle', expect.any(String));
            });
            expect(mockNavigate).not.toHaveBeenCalledWith('/(tabs)/chat');
        } finally {
            consoleErrorSpy.mockRestore();
            alertSpy.mockRestore();
        }
    });

    it('opens a conversation and navigates to chat', () => {
        const { getByTestId } = render(
            <SafeAreaProvider
                initialMetrics={{
                    frame: { x: 0, y: 0, width: 390, height: 844 },
                    insets: { top: 0, left: 0, right: 0, bottom: 0 },
                }}
            >
                <HomeScreen />
            </SafeAreaProvider>
        );

        fireEvent.press(getByTestId('open-conversation-button'));

        expect(mockOpenThread).toHaveBeenCalledWith('thread-1');
        expect(mockNavigate).toHaveBeenCalledWith('/(tabs)/chat');
    });

    it('shows an alert when opening a conversation fails', async () => {
        const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
        const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        mockOpenThread.mockImplementation(() => {
            throw new Error('missing thread');
        });

        try {
            const { getByTestId } = render(
                <SafeAreaProvider
                    initialMetrics={{
                        frame: { x: 0, y: 0, width: 390, height: 844 },
                        insets: { top: 0, left: 0, right: 0, bottom: 0 },
                    }}
                >
                    <HomeScreen />
                </SafeAreaProvider>
            );

            fireEvent.press(getByTestId('open-conversation-button'));

            await waitFor(() => {
                expect(alertSpy).toHaveBeenCalledWith('home.openConversationErrorTitle', expect.any(String));
            });
        } finally {
            consoleErrorSpy.mockRestore();
            alertSpy.mockRestore();
        }
    });

    it('confirms deletion and deletes the selected conversation', () => {
        const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

        try {
            const { getByTestId } = render(
                <SafeAreaProvider
                    initialMetrics={{
                        frame: { x: 0, y: 0, width: 390, height: 844 },
                        insets: { top: 0, left: 0, right: 0, bottom: 0 },
                    }}
                >
                    <HomeScreen />
                </SafeAreaProvider>
            );

            fireEvent.press(getByTestId('delete-conversation-button'));

            expect(alertSpy).toHaveBeenCalledWith(
                'home.deleteConversationTitle',
                'Delete Trip ideas?',
                expect.any(Array),
            );

            const deleteAction = alertSpy.mock.calls[0]?.[2]?.[1] as { onPress?: () => void } | undefined;
            deleteAction?.onPress?.();

            expect(mockDeleteThread).toHaveBeenCalledWith('thread-1');
        } finally {
            alertSpy.mockRestore();
        }
    });

    it('shows an alert when deleting a conversation fails after confirmation', async () => {
        const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
        const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        mockDeleteThread.mockImplementation(() => {
            throw new Error('delete failed');
        });

        try {
            const { getByTestId } = render(
                <SafeAreaProvider
                    initialMetrics={{
                        frame: { x: 0, y: 0, width: 390, height: 844 },
                        insets: { top: 0, left: 0, right: 0, bottom: 0 },
                    }}
                >
                    <HomeScreen />
                </SafeAreaProvider>
            );

            fireEvent.press(getByTestId('delete-conversation-button'));
            const deleteAction = alertSpy.mock.calls[0]?.[2]?.[1] as { onPress?: () => void } | undefined;
            deleteAction?.onPress?.();

            await waitFor(() => {
                expect(alertSpy).toHaveBeenLastCalledWith('home.deleteConversationErrorTitle', expect.any(String));
            });
        } finally {
            consoleErrorSpy.mockRestore();
            alertSpy.mockRestore();
        }
    });

    it('opens conversation history management from the recent chats header', () => {
        const { getByTestId } = render(
            <SafeAreaProvider
                initialMetrics={{
                    frame: { x: 0, y: 0, width: 390, height: 844 },
                    insets: { top: 0, left: 0, right: 0, bottom: 0 },
                }}
            >
                <HomeScreen />
            </SafeAreaProvider>
        );

        fireEvent.press(getByTestId('manage-conversations-button'));

        expect(mockPush).toHaveBeenCalledWith('/conversations');
    });

    it('keeps the home scroll area flush with the tab chrome without extra footer gap', () => {
        const { getByTestId } = render(
            <SafeAreaProvider
                initialMetrics={{
                    frame: { x: 0, y: 0, width: 390, height: 844 },
                    insets: { top: 0, left: 0, right: 0, bottom: 0 },
                }}
            >
                <HomeScreen />
            </SafeAreaProvider>
        );

        const screenContentStyle = flattenStyle(getByTestId('home-screen-content').props.style);
        const scrollViewContentStyle = flattenStyle(getByTestId('home-scroll-view').props.contentContainerStyle);

        expect(screenContentStyle.paddingBottom).toBe(0);
        expect(scrollViewContentStyle.paddingBottom).toBe(screenLayoutMetrics.contentBottomInset);
    });

    it('renders the bootstrap progress and error banners from store state', () => {
        useBootstrapStore.setState({
            criticalOutcome: 'success',
            backgroundState: 'running',
            backgroundError: null,
        });

        const running = render(
            <SafeAreaProvider
                initialMetrics={{
                    frame: { x: 0, y: 0, width: 390, height: 844 },
                    insets: { top: 0, left: 0, right: 0, bottom: 0 },
                }}
            >
                <HomeScreen />
            </SafeAreaProvider>
        );

        expect(running.getByText('home.initializing')).toBeTruthy();

        running.unmount();
        useBootstrapStore.setState({
            criticalOutcome: 'success',
            backgroundState: 'error',
            backgroundError: 'background bootstrap failed',
        });
        (globalThis as any).__DEV__ = true;

        const failed = render(
            <SafeAreaProvider
                initialMetrics={{
                    frame: { x: 0, y: 0, width: 390, height: 844 },
                    insets: { top: 0, left: 0, right: 0, bottom: 0 },
                }}
            >
                <HomeScreen />
            </SafeAreaProvider>
        );

        expect(failed.getByText('home.initializationFailedTitle')).toBeTruthy();
        expect(failed.getByText('home.initializationFailedMessage')).toBeTruthy();
        expect(failed.getByText('background bootstrap failed')).toBeTruthy();
    });
});
