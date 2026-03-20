'use strict';

const NodeEnvironment = require('jest-environment-node').TestEnvironment;

function normalizeConfig(config) {
  if (config && config.projectConfig) {
    return {
      ...config,
      projectConfig: {
        ...config.projectConfig,
        globals: config.projectConfig.globals ?? {},
        testEnvironmentOptions: config.projectConfig.testEnvironmentOptions ?? {},
      },
    };
  }

  return {
    globalConfig: {},
    projectConfig: {
      ...(config ?? {}),
      globals: config?.globals ?? {},
      testEnvironmentOptions: config?.testEnvironmentOptions ?? {},
    },
  };
}

module.exports = class ReactNativeCompatibleEnv extends NodeEnvironment {
  customExportConditions = ['require', 'react-native'];

  constructor(config, context) {
    super(normalizeConfig(config), context);
  }
};
