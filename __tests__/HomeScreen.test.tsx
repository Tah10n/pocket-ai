import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import HomeScreen from '../app/(tabs)/index';
import { SafeAreaProvider } from 'react-native-safe-area-context';

const mockPush = jest.fn();
const mockReplace = jest.fn();
const mockGetModels = jest.fn(() => []);
let mockEngineState = {
    activeModelId: 'author/model-q4',
};

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
    }),
}));

jest.mock('@/hooks/useLLMEngine', () => ({
    useLLMEngine: () => ({
        state: mockEngineState,
    }),
}));

jest.mock('@/services/LocalStorageRegistry', () => ({
    registry: {
        getModels: (...args: any[]) => mockGetModels(...args),
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
});
