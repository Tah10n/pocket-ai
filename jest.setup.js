// Ensure React is globally available and consistent
import 'react-native/jest/setup';
import 'react-native-gesture-handler/jestSetup';

process.env.EXPO_OS = process.env.EXPO_OS || 'web';

const mockExpoRouter = {
  push: jest.fn(),
  replace: jest.fn(),
  back: jest.fn(),
  canGoBack: jest.fn().mockReturnValue(true),
  setParams: jest.fn(),
};

jest.mock('expo-router', () => {
  const React = require('react');

  const Passthrough = ({ children }: any) => children ?? null;
  const ScreenOnly = () => null;
  const Stack = Object.assign(Passthrough, { Screen: ScreenOnly });
  const Tabs = Object.assign(Passthrough, { Screen: ScreenOnly });

  return {
    Stack,
    Tabs,
    Slot: Passthrough,
    Redirect: () => null,
    Link: ({ children }: any) => children ?? null,
    useRouter: () => mockExpoRouter,
    usePathname: jest.fn(() => '/'),
    useLocalSearchParams: jest.fn(() => ({})),
    useSegments: jest.fn(() => []),
    router: mockExpoRouter,
  };
});

// Mock Expo Constants
jest.mock('expo-constants', () => ({
  expoConfig: {
    extra: {},
  },
  manifest: {},
}));

jest.mock('expo-blur', () => ({
  BlurView: ({ children }: any) => children ?? null,
}));

jest.mock('expo-file-system/legacy', () => ({
  createDownloadResumable: jest.fn().mockReturnValue({
    downloadAsync: jest.fn().mockResolvedValue({ status: 200 }),
    pauseAsync: jest.fn().mockResolvedValue({ resumeData: 'resume-data' }),
    savable: jest.fn().mockReturnValue({ resumeData: 'resume-data' }),
  }),
  getInfoAsync: jest.fn().mockResolvedValue({ exists: true, size: 1024 }),
  readDirectoryAsync: jest.fn().mockResolvedValue([]),
  deleteAsync: jest.fn().mockResolvedValue(undefined),
  getFreeDiskStorageAsync: jest.fn().mockResolvedValue(10 * 1024 * 1024 * 1024),
  getTotalDiskCapacityAsync: jest.fn().mockResolvedValue(100 * 1024 * 1024 * 1024),
  makeDirectoryAsync: jest.fn().mockResolvedValue(undefined),
  documentDirectory: 'test-dir/',
  cacheDirectory: 'test-cache/',
}));

jest.mock('expo-file-system', () => ({
  Paths: { cache: 'cache://', document: 'document://' },
  File: class MockFile {
    uri = 'file://mock';
    create = jest.fn();
    write = jest.fn();
  },
}));

jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn().mockResolvedValue(false),
  shareAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('expo-secure-store', () => {
  let storage = {};

  return {
    setItemAsync: jest.fn(async (key, value) => {
      storage[key] = value;
    }),
    getItemAsync: jest.fn(async (key) => storage[key] ?? null),
    deleteItemAsync: jest.fn(async (key) => {
      delete storage[key];
    }),
    isAvailableAsync: jest.fn(async () => true),
    __resetMock: () => {
      storage = {};
    },
  };
}, { virtual: true });

jest.mock('@expo/vector-icons', () => ({
  MaterialIcons: () => null,
}));

jest.mock('@expo/vector-icons/MaterialIcons', () => () => null);

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

jest.mock('nativewind', () => {
    let colorScheme = 'light';

    return {
        cssInterop: (Component) => Component,
        styled: (Component) => Component,
        useColorScheme: () => ({
            colorScheme,
            setColorScheme: jest.fn((nextColorScheme) => {
                colorScheme = nextColorScheme;
            }),
        }),
        __setColorScheme: (nextColorScheme) => {
            colorScheme = nextColorScheme;
        },
    };
});

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
    getUsedMemory: jest.fn().mockResolvedValue(5 * 1024 * 1024 * 1024),
    getTotalDiskCapacity: jest.fn().mockResolvedValue(100 * 1024 * 1024 * 1024),
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
jest.mock('react-native-reanimated');

jest.mock('@react-navigation/native', () => {
    const React = require('react');
    const actual = jest.requireActual('@react-navigation/native');

    return {
        ...actual,
        useIsFocused: () => true,
        useFocusEffect: (effect) => {
            React.useEffect(() => effect(), [effect]);
        },
    };
});

// Mocking llama.rn
jest.mock('llama.rn', () => ({
    initLlama: jest.fn(),
    releaseAllLlama: jest.fn().mockResolvedValue(undefined),
}));

// Mocking react-i18next
jest.mock('react-i18next', () => {
    const overrides = new Map();
    let language = 'en';

    const applyInterpolation = (template, options) => template.replace(/\{\{(.*?)\}\}/g, (_, key) => {
        const trimmedKey = key.trim();
        return options?.[trimmedKey] == null ? '' : String(options[trimmedKey]);
    });

    const t = (key, options) => {
        const overrideKey = `${language}:${key}`;
        const overrideValue = overrides.get(overrideKey) ?? overrides.get(key);
        if (typeof overrideValue === 'string') {
            return applyInterpolation(overrideValue, options);
        }

        return key;
    };

    return {
        useTranslation: () => ({
            t,
            i18n: {
                language,
                changeLanguage: (nextLanguage) => {
                    language = nextLanguage;
                    return Promise.resolve();
                },
            },
        }),
        initReactI18next: {
            type: '3rdParty',
            init: () => { },
        },
        __setMockLanguage: (nextLanguage) => {
            language = nextLanguage;
        },
        __setTranslationOverride: (key, value, nextLanguage) => {
            const overrideKey = nextLanguage ? `${nextLanguage}:${key}` : key;
            overrides.set(overrideKey, value);
        },
        __resetTranslations: () => {
            overrides.clear();
            language = 'en';
        },
    };
});

// More robust AccessibilityInfo mock
jest.mock('react-native/Libraries/Components/AccessibilityInfo/AccessibilityInfo', () => {
    let screenReaderEnabled = false;
    let reduceMotionEnabled = false;
    const listeners = {
        screenReaderChanged: new Set(),
        reduceMotionChanged: new Set(),
    };

    const addEventListener = jest.fn((eventName, listener) => {
        listeners[eventName]?.add(listener);
        return {
            remove: () => {
                listeners[eventName]?.delete(listener);
            },
        };
    });

    const api = {
        announceForAccessibility: jest.fn(),
        isScreenReaderEnabled: jest.fn().mockImplementation(async () => screenReaderEnabled),
        isReduceMotionEnabled: jest.fn().mockImplementation(async () => reduceMotionEnabled),
        addEventListener,
        removeEventListener: jest.fn(),
        __setReduceMotionEnabled: (nextValue) => {
            reduceMotionEnabled = nextValue;
            listeners.reduceMotionChanged.forEach((listener) => listener(nextValue));
        },
        __setScreenReaderEnabled: (nextValue) => {
            screenReaderEnabled = nextValue;
            listeners.screenReaderChanged.forEach((listener) => listener(nextValue));
        },
        __resetAccessibilityState: () => {
            screenReaderEnabled = false;
            reduceMotionEnabled = false;
            listeners.screenReaderChanged.clear();
            listeners.reduceMotionChanged.clear();
        },
    };

    return {
        __esModule: true,
        default: api,
        ...api,
    };
});
