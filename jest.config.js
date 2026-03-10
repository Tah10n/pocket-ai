module.exports = {
    preset: 'jest-expo',
    setupFilesAfterEnv: ['./jest.setup.js'],
    transformIgnorePatterns: [
        'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@sentry/react-native|native-base|react-native-svg|react-native-fs|react-native-device-info|react-native-mmkv|llama.rn)'
    ],
    moduleNameMapper: {
        '^react$': '<rootDir>/node_modules/react',
        '^react-native$': '<rootDir>/node_modules/react-native',
    },
    testPathIgnorePatterns: ['/node_modules/', '/.expo/'],
};
