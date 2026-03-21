import React from 'react';
import { render } from '@testing-library/react-native';
import HomeScreen from '../app/(tabs)/index';
import { SafeAreaProvider } from 'react-native-safe-area-context';

// Mock expo-router components
jest.mock('expo-router', () => ({
    Link: ({ children }: any) => <>{children}</>,
    useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
    Stack: {
        Screen: () => null,
    },
}));

jest.mock('expo-image', () => ({
    Image: () => 'Image',
}));

// Mock NativeEventEmitter
jest.mock('react-native/Libraries/EventEmitter/NativeEventEmitter');

describe('HomeScreen', () => {
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
});
