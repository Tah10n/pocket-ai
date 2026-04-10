// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*', 'build/*', 'coverage/*', '.expo/*'],
  },
  {
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'react-native',
              importNames: ['InteractionManager'],
              message: 'InteractionManager is deprecated. Prefer requestAnimationFrame/requestIdleCallback scheduling (see scheduleAfterFirstFrame in AppBootstrap).',
            },
          ],
        },
      ],
    },
  },
]);
