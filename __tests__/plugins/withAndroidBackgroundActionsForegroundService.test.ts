import fs from 'fs';
import os from 'os';
import path from 'path';

jest.mock('expo/config-plugins', () => ({
  withAndroidManifest: (config: any, action: (nextConfig: any) => any) => action(config),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const withAndroidBackgroundActionsForegroundService = require('../../plugins/withAndroidBackgroundActionsForegroundService');

describe('withAndroidBackgroundActionsForegroundService', () => {
  it('adds permissions and overrides background-actions service type', () => {
    const projectRoot = path.resolve(__dirname, '..', '..');
    const serviceName = 'com.asterinet.react.bgactions.RNBackgroundActionsTask';

    const config = {
      modRequest: { projectRoot },
      modResults: {
        manifest: {
          $: {},
          'uses-permission': [],
          application: [
            {
              service: [
                {
                  $: {
                    'android:name': serviceName,
                  },
                },
              ],
            },
          ],
        },
      },
    };

    const result = withAndroidBackgroundActionsForegroundService(config);
    const manifest = result.modResults.manifest;

    expect(manifest.$['xmlns:tools']).toBe('http://schemas.android.com/tools');

    const permissions = (manifest['uses-permission'] ?? []).map((permission: any) => permission?.$?.['android:name']);
    expect(permissions).toEqual(expect.arrayContaining([
      'android.permission.FOREGROUND_SERVICE',
      'android.permission.FOREGROUND_SERVICE_DATA_SYNC',
    ]));

    const serviceEntries = manifest.application?.[0]?.service ?? [];
    const matchedService = serviceEntries.find((service: any) => service?.$?.['android:name'] === serviceName);
    expect(matchedService).toBeTruthy();
    expect(matchedService.$['android:foregroundServiceType']).toBe('dataSync');
    expect(String(matchedService.$['tools:replace'] ?? '')).toContain('android:foregroundServiceType');
  });

  it('uses Kotlin service fallback when the upstream manifest is missing', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bgactions-'));
    const packageRoot = path.join(tempRoot, 'node_modules', 'react-native-background-actions');
    const serviceDir = path.join(
      packageRoot,
      'android',
      'src',
      'main',
      'java',
      'com',
      'asterinet',
      'react',
      'bgactions',
    );

    try {
      fs.mkdirSync(serviceDir, { recursive: true });
      fs.writeFileSync(
        path.join(packageRoot, 'package.json'),
        JSON.stringify({ name: 'react-native-background-actions', version: '0.0.0-test' }),
        'utf8',
      );
      fs.writeFileSync(
        path.join(serviceDir, 'RNBackgroundActionsTask.kt'),
        'package com.asterinet.react.bgactions\nclass RNBackgroundActionsTask {}\n',
        'utf8',
      );

      const fallbackServiceName = 'com.asterinet.react.bgactions.RNBackgroundActionsTask';
      const config = {
        modRequest: { projectRoot: tempRoot },
        modResults: {
          manifest: {
            $: {},
            application: [{}],
          },
        },
      };

      const result = withAndroidBackgroundActionsForegroundService(config);
      const manifest = result.modResults.manifest;
      const serviceEntries = manifest.application?.[0]?.service ?? [];
      const matchedService = serviceEntries.find((service: any) => service?.$?.['android:name'] === fallbackServiceName);
      expect(matchedService).toBeTruthy();
      expect(matchedService.$['android:foregroundServiceType']).toBe('dataSync');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

