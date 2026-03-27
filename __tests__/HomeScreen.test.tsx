import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import HomeScreen from '../app/(tabs)/index';
import { SafeAreaProvider } from 'react-native-safe-area-context';

const mockPush = jest.fn();
const mockReplace = jest.fn();
const mockGetModels = jest.fn(() => []);
const mockStartNewChat = jest.fn();
let mockEngineState: { activeModelId: string | null } = {
    activeModelId: 'author/model-q4',
};

jest.mock('@react-navigation/bottom-tabs', () => ({
    useBottomTabBarHeight: () => 0,
}));

// Mock expo-router components
jest.mock('expo-router', () => ({
    Link: ({ children }: any) => <>{children}</>,
    useRouter: () => ({ push: mockPush, replace: mockReplace }),
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
        deleteThread: jest.fn(),
        openThread: jest.fn(),
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
    },
}));

// Mock NativeEventEmitter
jest.mock('react-native/Libraries/EventEmitter/NativeEventEmitter');

describe('HomeScreen', () => {
    beforeEach(() => {
        mockPush.mockReset();
        mockReplace.mockReset();
        mockGetModels.mockReset();
        mockGetModels.mockReturnValue([]);
        mockStartNewChat.mockReset();
        mockEngineState = {
            activeModelId: 'author/model-q4',
        };
    });

    it('renders successfully with translation keys', () => {
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
        expect(getByText('Pocket AI')).toBeTruthy();
        expect(getByText('home.newChat')).toBeTruthy();
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

        expect(mockPush).toHaveBeenCalledWith({
            pathname: '/(tabs)/models',
            params: undefined,
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
        expect(mockPush).toHaveBeenCalledWith('/(tabs)/chat');
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
});
