import React from 'react';
import { render } from '@testing-library/react-native';
import HomeScreen from '../app/(tabs)/index';

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
        const { getByText } = render(<HomeScreen />);
        // Since i18next mock returns keys, check for them
        expect(getByText('models.title')).toBeTruthy();
        expect(getByText('models.featured')).toBeTruthy();
    });
});
