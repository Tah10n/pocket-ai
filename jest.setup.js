// Ensure React is globally available and consistent
import 'react-native/jest/setup';
import 'react-native-gesture-handler/jestSetup';

// Mock Expo Constants
jest.mock('expo-constants', () => ({
  expoConfig: {
    extra: {},
  },
  manifest: {},
}));

// Mock Appearance
jest.mock('react-native/Libraries/Utilities/Appearance', () => {
    return {
        getColorScheme: jest.fn().mockReturnValue('light'),
        addChangeListener: jest.fn(),
        removeChangeListener: jest.fn(),
    };
});

window.matchMedia = window.matchMedia || function() {
    return {
        matches: false,
        addListener: function() {},
        removeListener: function() {}
    };
};

jest.mock('react-native-css-interop', () => ({
    cssInterop: jest.fn(),
    remapProps: jest.fn(),
}));

jest.mock('nativewind', () => ({
    styled: (Component) => Component,
}));

// Mocking react-native-fs
jest.mock('react-native-fs', () => ({
    DocumentDirectoryPath: '/mock/path',
    downloadFile: jest.fn(),
    hash: jest.fn(),
    unlink: jest.fn(),
    stopDownload: jest.fn(),
    getFSInfo: jest.fn().mockResolvedValue({ freeSpace: 10 * 1024 * 1024 * 1024, totalSpace: 100 * 1024 * 1024 * 1024 }),
    exists: jest.fn(),
    RNFSFileTypeRegular: 'regular',
}));

// Mocking react-native-device-info
jest.mock('react-native-device-info', () => ({
    getTotalMemory: jest.fn().mockResolvedValue(8 * 1024 * 1024 * 1024),
    getFreeDiskStorage: jest.fn().mockResolvedValue(10 * 1024 * 1024 * 1024),
}));

// Mocking @expo-device
jest.mock('expo-device', () => ({
    totalMemory: 16 * 1024 * 1024 * 1024
}));

// Mocking NetInfo
jest.mock('@react-native-community/netinfo', () => ({
    addEventListener: jest.fn(),
    fetch: jest.fn().mockResolvedValue({ type: 'wifi', isConnected: true }),
}));

// Mocking MMKV
jest.mock('react-native-mmkv', () => ({
    MMKV: jest.fn().mockImplementation(() => ({
        set: jest.fn(),
        getString: jest.fn(),
        delete: jest.fn(),
        getAllKeys: jest.fn().mockReturnValue([]),
    })),
}));

// Mocking Clipboard
jest.mock('react-native/Libraries/Components/Clipboard/Clipboard', () => ({
    setString: jest.fn(),
}));

// Mocking Reanimated
jest.mock('react-native-reanimated', () => {
    const Reanimated = require('react-native-reanimated/mock');
    Reanimated.default.call = () => { };
    return Reanimated;
});

// Mocking llama.rn
jest.mock('llama.rn', () => ({
    initLlama: jest.fn(),
    releaseAllLlama: jest.fn().mockResolvedValue(undefined),
}));

// Mocking react-i18next
jest.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (key) => key,
        i18n: {
            changeLanguage: () => Promise.resolve(),
        },
    }),
    initReactI18next: {
        type: '3rdParty',
        init: () => { },
    },
}));

// More robust AccessibilityInfo mock
jest.mock('react-native/Libraries/Components/AccessibilityInfo/AccessibilityInfo', () => ({
    __esModule: true,
    default: {
        announceForAccessibility: jest.fn(),
        isScreenReaderEnabled: jest.fn().mockResolvedValue(false),
        isReduceMotionEnabled: jest.fn().mockResolvedValue(false),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
    },
    announceForAccessibility: jest.fn(),
    isScreenReaderEnabled: jest.fn().mockResolvedValue(false),
    isReduceMotionEnabled: jest.fn().mockResolvedValue(false),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
}));
