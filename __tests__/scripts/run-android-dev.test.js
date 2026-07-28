const path = require('path');
const { EventEmitter } = require('events');
const { stopOwnedProcessTreeByPid } = require('../../scripts/android-smoke');

const {
  attachAndroidDevLifecycle,
  buildAndroidDevEnvironment,
  buildAndroidDevInvocation,
  startAndroidDev,
} = require('../../scripts/run-android-dev');

describe('Android development launcher', () => {
  const appConfig = {
    expo: {
      version: '1.6.0',
      android: {
        versionCode: 19,
      },
    },
  };

  it('forces USB loopback and tracked Expo version metadata', () => {
    const environment = buildAndroidDevEnvironment(
      {
        KEEP_ME: 'yes',
        REACT_NATIVE_PACKAGER_HOSTNAME: '192.168.1.50',
        POCKET_AI_VERSION_CODE: '12',
        POCKET_AI_VERSION_NAME: '1.2.0',
      },
      appConfig
    );

    expect(environment).toEqual(
      expect.objectContaining({
        KEEP_ME: 'yes',
        REACT_NATIVE_PACKAGER_HOSTNAME: '127.0.0.1',
        POCKET_AI_VERSION_CODE: '19',
        POCKET_AI_VERSION_NAME: '1.6.0',
      })
    );
  });

  it.each([
    [{ expo: { android: { versionCode: 19 } } }, 'expo.version'],
    [{ expo: { version: '1.6.0', android: { versionCode: 0 } } }, 'expo.android.versionCode'],
    [{ expo: { version: '1.6.0', android: { versionCode: 19.5 } } }, 'expo.android.versionCode'],
  ])('rejects incomplete or invalid version configuration', (config, expectedMessage) => {
    expect(() => buildAndroidDevEnvironment({}, config)).toThrow(expectedMessage);
  });

  it('passes extra Android launcher arguments without a shell wrapper', () => {
    const root = path.resolve('C:\\projects\\pocket-ai');
    const invocation = buildAndroidDevInvocation(['--serial', 'phone-1', '--port', '8082'], root);

    expect(invocation.command).toBe(process.execPath);
    expect(invocation.args).toEqual([
      path.join(root, 'scripts', 'android-smoke.js'),
      '--keep-metro-foreground',
      '--auto-target',
      '--serial',
      'phone-1',
      '--port',
      '8082',
    ]);
  });

  it('spawns the attached Android launcher with the hardened environment', () => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.kill = jest.fn();
    const ownershipBoundary = process.platform === 'win32'
      ? 'windows-job'
      : 'posix-process-group';
    child.pocketAiOwnershipBoundary = ownershipBoundary;
    const spawnOwnedProcessImpl = jest.fn(() => child);
    const ownershipSnapshot = {
      processIdentity: { startMarker: 'owned-start' },
      processTreeIdentities: [
        { pid: 4242, parentPid: null, startMarker: 'owned-start', depth: 0 },
      ],
      ownershipBoundary,
    };
    const captureOwnedProcessOwnership = jest.fn(() => ownershipSnapshot);
    const root = path.resolve(__dirname, '..', '..');

    expect(
      startAndroidDev({
        projectRoot: root,
        appConfig,
        environment: { KEEP_ME: 'yes' },
        extraArgs: ['--serial', 'phone-1'],
        spawnOwnedProcessImpl,
        captureOwnedProcessOwnership,
      })
    ).toBe(child);

    expect(spawnOwnedProcessImpl).toHaveBeenCalledWith(
      process.execPath,
      [
        path.join(root, 'scripts', 'android-smoke.js'),
        '--keep-metro-foreground',
        '--auto-target',
        '--serial',
        'phone-1',
      ],
      expect.objectContaining({
        cwd: root,
        stdio: 'inherit',
        windowsHide: false,
        env: expect.objectContaining({
          KEEP_ME: 'yes',
          REACT_NATIVE_PACKAGER_HOSTNAME: '127.0.0.1',
          POCKET_AI_VERSION_CODE: '19',
          POCKET_AI_VERSION_NAME: '1.6.0',
        }),
      })
    );
    expect(captureOwnedProcessOwnership).toHaveBeenCalledWith(4242, {
      platform: process.platform,
      ownershipBoundary,
    });
    expect(child.pocketAiOwnershipSnapshot).toBe(ownershipSnapshot);
  });

  it('forwards wrapper termination signals to the owned launcher', () => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.kill = jest.fn();
    child.pocketAiOwnershipBoundary = 'posix-process-group';
    child.pocketAiOwnershipSnapshot = {
      processIdentity: { startMarker: 'owned-start' },
      processTreeIdentities: [
        { pid: 4242, parentPid: null, startMarker: 'owned-start', depth: 0 },
      ],
      ownershipBoundary: 'posix-process-group',
    };
    const processRef = new EventEmitter();
    processRef.exitCode = undefined;
    const stopProcessTree = jest.fn(() => true);
    attachAndroidDevLifecycle(child, processRef, { stopProcessTree });

    processRef.emit('SIGINT');

    expect(stopProcessTree).toHaveBeenCalledWith(4242, expect.objectContaining({
      expectedIdentity: { startMarker: 'owned-start' },
      ownershipBoundary: 'posix-process-group',
      gracefulTimeoutMs: 15_000,
      trustedChildHandle: true,
      killRoot: expect.any(Function),
    }));
    expect(child.kill).not.toHaveBeenCalled();
    expect(processRef.exitCode).toBe(130);
    child.emit('exit', 1, null);
    expect(processRef.exitCode).toBe(130);
    expect(processRef.listenerCount('SIGTERM')).toBe(0);
  });

  it('falls back to the trusted Windows Job handle when native stop fails', () => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.kill = jest.fn(() => true);
    child.pocketAiOwnershipBoundary = 'windows-job';
    child.pocketAiOwnershipSnapshot = {
      processIdentity: { startMarker: '638885000000000000' },
      processTreeIdentities: [
        {
          pid: 4242,
          parentPid: null,
          startMarker: '638885000000000000',
          depth: 0,
        },
      ],
      ownershipBoundary: 'windows-job',
    };
    const processRef = new EventEmitter();
    processRef.exitCode = undefined;
    const spawnSync = jest.fn(() => ({ status: 42 }));
    const stopProcessTree = (processId, options) => stopOwnedProcessTreeByPid(processId, {
      ...options,
      platform: 'win32',
      spawnSync,
    });

    attachAndroidDevLifecycle(child, processRef, { stopProcessTree });
    processRef.emit('SIGTERM');

    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(processRef.exitCode).toBe(143);
    child.emit('exit', 1, null);
    expect(processRef.exitCode).toBe(143);
  });

  it('does not print malicious launcher errors while forwarding a signal', () => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.kill = jest.fn();
    child.pocketAiOwnershipBoundary = 'posix-process-group';
    child.pocketAiOwnershipSnapshot = {
      processIdentity: { startMarker: 'owned-start' },
      processTreeIdentities: [
        { pid: 4242, parentPid: null, startMarker: 'owned-start', depth: 0 },
      ],
      ownershipBoundary: 'posix-process-group',
    };
    const processRef = new EventEmitter();
    processRef.exitCode = undefined;
    const maliciousError = new Error(
      'PROMPT_SENTINEL hf_private_token C:\\Users\\private\\model.gguf'
    );
    maliciousError.name = 'PROMPT_SENTINEL';
    maliciousError.code = 'hf_private_token';
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      attachAndroidDevLifecycle(child, processRef, {
        stopProcessTree: jest.fn(() => {
          throw maliciousError;
        }),
      });
      processRef.emit('SIGTERM');

      const logged = consoleError.mock.calls.flat().join('\n');
      expect(logged).toContain('signal-forward-failed (name=Error, code=unknown)');
      expect(logged).not.toContain('PROMPT_SENTINEL');
      expect(logged).not.toContain('hf_private_token');
      expect(logged).not.toContain('C:\\Users\\private\\model.gguf');
      expect(processRef.exitCode).toBe(1);
    } finally {
      consoleError.mockRestore();
    }
  });
});
