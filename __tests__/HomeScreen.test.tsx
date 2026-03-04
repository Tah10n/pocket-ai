import React from 'react';
import { render } from '@testing-library/react-native';
import HomeScreen from '../app/(tabs)/index';

// Mock expo-router components
jest.mock('expo-router', () => ({
    Link: ({ children }: any) => <>{children}</>,
    useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

jest.mock('expo-image', () => ({
    Image: () => 'Image',
}));

jest.mock('react-native-device-info', () => ({
    getVersion: () => '1.0.0',
    getBuildNumber: () => '1',
}));

// Mock NativeEventEmitter
jest.mock('react-native/Libraries/EventEmitter/NativeEventEmitter');


describe('HomeScreen', () => {
    it('renders successfully', () => {
        const { getByText } = render(<HomeScreen />);
        expect(getByText('Welcome!')).toBeTruthy();
        expect(getByText('Step 1: Try it')).toBeTruthy();
    });
});
