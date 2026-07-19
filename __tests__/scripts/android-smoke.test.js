const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const {
  buildMetroBundlePath,
  buildMetroReverseSpecs,
  buildMetroStartArgs,
  buildWindowsProcessCommandLine,
  captureOwnedProcessOwnership,
  captureAndroidScreenshot,
  cleanupOwnedMetroAfterStartupFailure,
  createOwnedMetroProcessLifecycle,
  evaluateApkReuse,
  evaluateInstallReuse,
  isAppJsReadyUiHierarchy,
  isInsufficientStorageInstallFailure,
  parseCliOptions,
  parseApkVariant,
  parseDumpsysPackageOutput,
  parsePackagePathOutput,
  readAndroidUiHierarchy,
  readProcessIdentity,
  readWindowsProcessTreeIdentities,
  sanitizeForFileName,
  spawnWindowsJobProcess,
  stopOwnedMetroProcess,
  stopOwnedMetroProcessOrThrow,
  stopOwnedProcessTreeByPid,
  waitForAppJsReady,
  waitForAttachedMetroExit,
} = require('../../scripts/android-smoke');

describe('android-smoke Metro prewarm', () => {
  it('builds an Android bundle URL from the package entrypoint', () => {
    expect(buildMetroBundlePath()).toBe(
      '/node_modules/expo-router/entry.bundle?platform=android&dev=true&lazy=true&minify=false&app=com.github.tah10n.pocketai&modulesOnly=false&runModule=true&excludeSource=true&sourcePaths=url-server',
    );
  });

  it('keeps local entrypoints rooted at the app source tree', () => {
    const options = { appPackage: 'com.example.app' };

    expect(buildMetroBundlePath('./index', options)).toBe(
      '/index.bundle?platform=android&dev=true&lazy=true&minify=false&app=com.example.app&modulesOnly=false&runModule=true&excludeSource=true&sourcePaths=url-server',
    );
    expect(buildMetroBundlePath('./src/index.ts')).toBe(
      '/src/index.bundle?platform=android&dev=true&lazy=true&minify=false&app=com.github.tah10n.pocketai&modulesOnly=false&runModule=true&excludeSource=true&sourcePaths=url-server',
    );
  });
});

describe('android-smoke Metro adb reverse specs', () => {
  it('uses the standard React Native device Metro port when Metro is on the default host port', () => {
    expect(buildMetroReverseSpecs(8081)).toEqual([
      {
        devicePort: 8081,
        hostPort: 8081,
      },
    ]);
  });

  it('maps the standard device Metro port to the selected host port when Metro moves', () => {
    expect(buildMetroReverseSpecs('8082')).toEqual([
      {
        devicePort: 8081,
        hostPort: 8082,
      },
      {
        devicePort: 8082,
        hostPort: 8082,
      },
    ]);
  });
});

describe('android-smoke storage failure detection', () => {
  it('detects the explicit ADB insufficient-storage install failure code', () => {
    expect(isInsufficientStorageInstallFailure('Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]')).toBe(true);
  });

  it('detects generic insufficient storage phrasing', () => {
    expect(isInsufficientStorageInstallFailure('adb: failed to install apk: insufficient storage')).toBe(true);
  });

  it('detects not-enough-space phrasing', () => {
    expect(isInsufficientStorageInstallFailure('INSTALL_PARSE_FAILED: not enough space on device')).toBe(true);
  });

  it('does not match unrelated install failures', () => {
    expect(isInsufficientStorageInstallFailure('Failure [INSTALL_FAILED_VERSION_DOWNGRADE]')).toBe(false);
  });
});

describe('android-smoke APK variant parsing', () => {
  it('accepts supported APK variants', () => {
    expect(parseApkVariant('debug')).toBe('debug');
    expect(parseApkVariant('Release')).toBe('release');
  });

  it('rejects unsupported APK variants', () => {
    expect(() => parseApkVariant('qa')).toThrow('Invalid Android APK variant');
  });
});

describe('android-smoke app JS readiness', () => {
  const appPackage = 'com.github.tah10n.pocketai';
  const readyHierarchy = `<hierarchy><node package="${appPackage}" resource-id="home-screen-content" /></hierarchy>`;

  it('requires an app-owned React surface instead of accepting the native activity alone', () => {
    expect(isAppJsReadyUiHierarchy(
      `<hierarchy><node package="${appPackage}" resource-id="" /></hierarchy>`,
      appPackage,
    )).toBe(false);
    expect(isAppJsReadyUiHierarchy(readyHierarchy, appPackage)).toBe(true);
  });

  it('waits until a rendered JS marker is present', async () => {
    const readUiHierarchy = jest.fn()
      .mockReturnValueOnce(`<hierarchy><node package="${appPackage}" resource-id="" /></hierarchy>`)
      .mockReturnValueOnce(readyHierarchy);

    await expect(waitForAppJsReady('adb', 'device-1', appPackage, {
      timeoutMs: 1_000,
      pollIntervalMs: 0,
      readUiHierarchy,
      delay: () => Promise.resolve(),
    })).resolves.toBeUndefined();
    expect(readUiHierarchy).toHaveBeenCalledTimes(2);
  });

  it('fails readiness immediately when the owned Metro exits', async () => {
    await expect(waitForAppJsReady('adb', 'device-1', appPackage, {
      timeoutMs: 1_000,
      readUiHierarchy: jest.fn(),
      lifecycle: {
        getOutcome: () => ({ type: 'exit', code: 1, signal: null }),
        isStopRequested: () => false,
      },
    })).rejects.toThrow('while waiting for the app JS surface');
  });

  it('bounds and cleans up Android UI hierarchy commands', () => {
    const spawnSync = jest.fn()
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 0, stdout: readyHierarchy })
      .mockReturnValueOnce({ status: 0 });

    expect(readAndroidUiHierarchy('adb', 'device-1', {
      spawnSync,
      remotePath: '/sdcard/readiness.xml',
    })).toBe(readyHierarchy);
    expect(spawnSync).toHaveBeenCalledTimes(3);
    expect(spawnSync.mock.calls[0][2]).toEqual(expect.objectContaining({ timeout: 5_000 }));
    expect(spawnSync.mock.calls[1][2]).toEqual(expect.objectContaining({ timeout: 5_000 }));
    expect(spawnSync.mock.calls[2][1]).toEqual([
      '-s',
      'device-1',
      'shell',
      'rm',
      '-f',
      '/sdcard/readiness.xml',
    ]);
  });
});

describe('android-smoke development Metro lifecycle', () => {
  it('keeps an owned Metro attached only when explicitly requested', () => {
    expect(parseCliOptions(['--keep-metro-foreground'])).toEqual(
      expect.objectContaining({
        keepMetroForeground: true,
      })
    );
    expect(parseCliOptions([])).toEqual(
      expect.objectContaining({
        keepMetroForeground: false,
      })
    );
  });

  it('supports parent ownership transfer only where the handoff is durable', () => {
    if (process.platform === 'win32') {
      expect(() => parseCliOptions([
        '--transfer-metro-ownership',
        'artifacts/owner.json',
      ])).toThrow('not supported on Windows');
    } else {
      expect(parseCliOptions(['--transfer-metro-ownership', 'artifacts/owner.json'])).toEqual(
        expect.objectContaining({
          keepMetroForeground: false,
          transferMetroOwnership: 'artifacts/owner.json',
        }),
      );
    }
    expect(() => parseCliOptions([
      '--keep-metro-foreground',
      '--transfer-metro-ownership',
      'artifacts/owner.json',
    ])).toThrow('cannot be combined');
  });

  it('enables phone-first emulator fallback only for the canonical dev launcher', () => {
    expect(parseCliOptions(['--auto-target'])).toEqual(
      expect.objectContaining({ autoTarget: true }),
    );
    expect(parseCliOptions([])).toEqual(
      expect.objectContaining({ autoTarget: false }),
    );
  });

  it('starts a fresh Metro cache only when explicitly requested', () => {
    expect(parseCliOptions(['--clear-metro-cache'])).toEqual(
      expect.objectContaining({
        clearMetroCache: true,
      })
    );
    expect(parseCliOptions([])).toEqual(
      expect.objectContaining({
        clearMetroCache: false,
      })
    );
    expect(buildMetroStartArgs(8082, { clearCache: true })).toEqual([
      'start',
      '--dev-client',
      '--localhost',
      '--port',
      '8082',
      '--clear',
    ]);
  });

  it('observes an owned Metro exit even when waiting starts after the event', async () => {
    const metroProcess = new EventEmitter();
    metroProcess.kill = jest.fn();
    const lifecycle = createOwnedMetroProcessLifecycle(metroProcess);

    metroProcess.emit('exit', 1, null);

    await expect(waitForAttachedMetroExit(lifecycle)).rejects.toThrow(
      'Attached Metro exited unexpectedly with code 1.',
    );
  });

  it('starts Windows children inside a kill-on-close Job Object host', () => {
    const child = new EventEmitter();
    child.pid = 4242;
    const spawnImpl = jest.fn(() => child);

    expect(spawnWindowsJobProcess(
      'C:\\Program Files\\nodejs\\node.exe',
      ['script with space.js', '--flag'],
      {
        cwd: 'C:\\projects\\pocket ai',
        detached: true,
        stdio: 'inherit',
        env: { KEEP_ME: 'yes' },
        windowsHide: true,
        spawnImpl,
      },
    )).toBe(child);
    expect(child.pocketAiOwnershipBoundary).toBe('windows-job');
    const [, powershellArgs, spawnOptions] = spawnImpl.mock.calls[0];
    const payloadBase64 = powershellArgs[powershellArgs.indexOf('-PayloadBase64') + 1];
    const payload = JSON.parse(Buffer.from(payloadBase64, 'base64').toString('utf8'));
    expect(powershellArgs).toEqual(expect.arrayContaining([
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      expect.stringMatching(/windows-job-process-host\.ps1$/u),
    ]));
    expect(payload).toEqual({
      applicationPath: 'C:\\Program Files\\nodejs\\node.exe',
      commandLine: '"C:\\Program Files\\nodejs\\node.exe" "script with space.js" --flag',
      currentDirectory: 'C:\\projects\\pocket ai',
    });
    expect(spawnOptions).toEqual(expect.objectContaining({
      cwd: 'C:\\projects\\pocket ai',
      detached: false,
      stdio: 'inherit',
      env: { KEEP_ME: 'yes' },
      windowsHide: true,
    }));
    expect(buildWindowsProcessCommandLine(
      'C:\\Program Files\\nodejs\\node.exe',
      ['script with space.js', '--flag'],
    )).toBe('"C:\\Program Files\\nodejs\\node.exe" "script with space.js" --flag');

    const jobHostSource = fs.readFileSync(
      path.join(__dirname, '..', '..', 'scripts', 'windows-job-process-host.ps1'),
      'utf8',
    );
    const assignHostIndex = jobHostSource.indexOf(
      'AssignProcessToJobObject(job, GetCurrentProcess())',
    );
    expect(jobHostSource).toContain('JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE');
    expect(assignHostIndex).toBeGreaterThanOrEqual(0);
    expect(jobHostSource.indexOf('if (!CreateProcess(', assignHostIndex)).toBeGreaterThan(
      assignHostIndex,
    );
    expect(jobHostSource).toContain('Environment.Exit(unchecked((int)exitCode))');
  });

  it('terminates an authenticated Windows Job host with post-kill readback', () => {
    const metroProcess = new EventEmitter();
    metroProcess.pid = 4242;
    metroProcess.kill = jest.fn();
    metroProcess.pocketAiOwnershipBoundary = 'windows-job';
    const lifecycle = createOwnedMetroProcessLifecycle(metroProcess);
    const spawnSync = jest.fn(() => ({ status: 0 }));
    const processIdentity = { startMarker: '638885000000000000' };
    lifecycle.setOwnershipSnapshot({
      processIdentity,
      processTreeIdentities: [
        { pid: 4242, parentPid: null, startMarker: processIdentity.startMarker, depth: 0 },
      ],
      ownershipBoundary: 'windows-job',
    });

    expect(stopOwnedMetroProcess(lifecycle, {
      platform: 'win32',
      spawnSync,
    })).toBe(true);
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(spawnSync).toHaveBeenCalledWith(
      'powershell.exe',
      expect.arrayContaining([
        '-NoProfile',
        '-NonInteractive',
        '-File',
        expect.stringMatching(/windows-job-process-stop\.ps1$/u),
        '-ProcessId',
        '4242',
        '-StartMarker',
        '638885000000000000',
      ]),
      expect.objectContaining({ timeout: 10_000, windowsHide: true }),
    );
    const stopSource = fs.readFileSync(
      path.join(__dirname, '..', '..', 'scripts', 'windows-job-process-stop.ps1'),
      'utf8',
    );
    const openProcessIndex = stopSource.indexOf('IntPtr process = OpenProcess(');
    const identityCheckIndex = stopSource.indexOf('if (ToDateTimeTicks(creationTime)', openProcessIndex);
    const terminateIndex = stopSource.indexOf('TerminateProcess(process, 1)', identityCheckIndex);
    expect(openProcessIndex).toBeGreaterThanOrEqual(0);
    expect(identityCheckIndex).toBeGreaterThan(openProcessIndex);
    expect(terminateIndex).toBeGreaterThan(identityCheckIndex);
    expect(stopSource).not.toContain('Stop-Process');
    expect(metroProcess.kill).not.toHaveBeenCalled();
  });

  it('refuses Windows tree cleanup without a kernel ownership boundary', () => {
    const spawnSync = jest.fn();

    expect(stopOwnedProcessTreeByPid(4242, {
      platform: 'win32',
      spawnSync,
      expectedIdentity: { startMarker: '638885000000000000' },
      ownershipBoundary: 'windows-process-tree-snapshot',
    })).toBe(false);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('does not terminate a reused PID after the Windows Job host has exited', () => {
    const spawnSync = jest.fn(() => ({ status: 0 }));

    expect(stopOwnedProcessTreeByPid(4242, {
      platform: 'win32',
      spawnSync,
      expectedIdentity: { startMarker: '638885000000000000' },
      ownershipBoundary: 'windows-job',
    })).toBe(true);
    const stopSource = fs.readFileSync(
      path.join(__dirname, '..', '..', 'scripts', 'windows-job-process-stop.ps1'),
      'utf8',
    );
    expect(stopSource).toContain('if (ToDateTimeTicks(creationTime) != expectedStartMarker)');
  });

  it('uses the trusted local ChildProcess handle when initial Job identity capture failed', () => {
    const metroProcess = new EventEmitter();
    metroProcess.pid = 4242;
    metroProcess.kill = jest.fn(() => true);
    metroProcess.pocketAiOwnershipBoundary = 'windows-job';
    const lifecycle = createOwnedMetroProcessLifecycle(metroProcess);
    const spawnSync = jest.fn();

    expect(stopOwnedMetroProcess(lifecycle, { platform: 'win32', spawnSync })).toBe(true);
    expect(spawnSync).not.toHaveBeenCalled();
    expect(metroProcess.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('uses the trusted local ChildProcess handle when native Job stop fails', () => {
    const metroProcess = new EventEmitter();
    metroProcess.pid = 4242;
    metroProcess.kill = jest.fn(() => true);
    metroProcess.pocketAiOwnershipBoundary = 'windows-job';
    const lifecycle = createOwnedMetroProcessLifecycle(metroProcess);
    lifecycle.setOwnershipSnapshot({
      processIdentity: { startMarker: '638885000000000000' },
      processTreeIdentities: [
        { pid: 4242, parentPid: null, startMarker: '638885000000000000', depth: 0 },
      ],
      ownershipBoundary: 'windows-job',
    });
    const spawnSync = jest.fn(() => ({ status: 42 }));

    expect(stopOwnedMetroProcess(lifecycle, { platform: 'win32', spawnSync })).toBe(true);
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(metroProcess.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('allows a failed Windows Job cleanup to be retried with the same identity', () => {
    const metroProcess = new EventEmitter();
    metroProcess.pid = 4242;
    metroProcess.kill = jest.fn();
    metroProcess.pocketAiOwnershipBoundary = 'windows-job';
    const lifecycle = createOwnedMetroProcessLifecycle(metroProcess);
    lifecycle.setOwnershipSnapshot({
      processIdentity: { startMarker: '638885000000000000' },
      processTreeIdentities: [
        { pid: 4242, parentPid: null, startMarker: '638885000000000000', depth: 0 },
      ],
      ownershipBoundary: 'windows-job',
    });
    const spawnSync = jest.fn()
      .mockReturnValueOnce({ status: 45 })
      .mockReturnValueOnce({ status: 0 });

    expect(stopOwnedMetroProcess(lifecycle, { platform: 'win32', spawnSync })).toBe(false);
    expect(stopOwnedMetroProcess(lifecycle, { platform: 'win32', spawnSync })).toBe(true);
    expect(spawnSync).toHaveBeenCalledTimes(2);
  });

  it('preserves both startup and cleanup failures when Metro startup aborts', () => {
    const lifecycle = { process: { pid: 4242 } };
    const removeSignalHandlers = jest.fn();

    expect(() => cleanupOwnedMetroAfterStartupFailure(
      lifecycle,
      removeSignalHandlers,
      new Error('readiness failed'),
      { stopProcess: () => false },
    )).toThrow('Metro startup failed (readiness failed) and owned-process cleanup also failed');
    expect(removeSignalHandlers).toHaveBeenCalledTimes(1);
  });

  it('surfaces an owned Metro cleanup failure to the command', () => {
    const lifecycle = { process: { pid: 4242 } };

    expect(() => stopOwnedMetroProcessOrThrow(lifecycle, {
      stopProcess: () => false,
    })).toThrow('Failed to stop owned Metro process tree 4242.');
  });

  it('terminates the owned POSIX Metro process group', () => {
    const metroProcess = new EventEmitter();
    metroProcess.pid = 4242;
    metroProcess.kill = jest.fn();
    const lifecycle = createOwnedMetroProcessLifecycle(metroProcess);
    const killProcessGroup = jest.fn();

    expect(stopOwnedMetroProcess(lifecycle, {
      platform: 'linux',
      killProcessGroup,
      waitForProcessTreeExit: () => true,
    })).toBe(true);
    expect(killProcessGroup).toHaveBeenCalledWith(-4242, 'SIGTERM');
    expect(metroProcess.kill).not.toHaveBeenCalled();
  });

  it('confirms POSIX process-group exit after escalating to SIGKILL', () => {
    const killProcessGroup = jest.fn();
    const waitForProcessTreeExit = jest.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    expect(stopOwnedProcessTreeByPid(4242, {
      platform: 'linux',
      killProcessGroup,
      waitForProcessTreeExit,
    })).toBe(true);
    expect(killProcessGroup.mock.calls).toEqual([
      [-4242, 'SIGTERM'],
      [-4242, 'SIGKILL'],
    ]);
    expect(waitForProcessTreeExit).toHaveBeenCalledTimes(2);
  });

  it('does not report POSIX cleanup success while the group survives SIGKILL', () => {
    const killProcessGroup = jest.fn();

    expect(stopOwnedProcessTreeByPid(4242, {
      platform: 'linux',
      killProcessGroup,
      waitForProcessTreeExit: () => false,
      killRoot: () => false,
    })).toBe(false);
  });

  it('terminates the owned POSIX process group after its leader exits', () => {
    const metroProcess = new EventEmitter();
    metroProcess.pid = 4242;
    metroProcess.kill = jest.fn();
    const lifecycle = createOwnedMetroProcessLifecycle(metroProcess);
    const killProcessGroup = jest.fn();
    metroProcess.emit('exit', 1, null);

    expect(stopOwnedMetroProcess(lifecycle, {
      platform: 'linux',
      killProcessGroup,
      waitForProcessTreeExit: () => true,
    })).toBe(true);
    expect(killProcessGroup).toHaveBeenCalledWith(-4242, 'SIGTERM');
    expect(metroProcess.kill).not.toHaveBeenCalled();
  });

  it('terminates a transferred POSIX process group after its authenticated leader exits', () => {
    const killProcessGroup = jest.fn();

    expect(stopOwnedProcessTreeByPid(4242, {
      platform: 'linux',
      expectedIdentity: { startMarker: 'owned-start' },
      readProcessIdentity: () => null,
      isProcessAlive: () => false,
      isProcessGroupAlive: () => true,
      killProcessGroup,
      waitForProcessTreeExit: () => true,
    })).toBe(true);
    expect(killProcessGroup).toHaveBeenCalledWith(-4242, 'SIGTERM');
  });

  it('reads a Windows process identity using an embedded validated PID', () => {
    const spawnSync = jest.fn(() => ({
      status: 0,
      stdout: '638885000000000000|C:\\Program Files\\nodejs\\node.exe',
    }));

    expect(readProcessIdentity(4242, { platform: 'win32', spawnSync })).toEqual({
      startMarker: '638885000000000000',
      executablePath: 'C:\\Program Files\\nodejs\\node.exe',
    });
    expect(spawnSync.mock.calls[0][1]).toHaveLength(4);
    expect(spawnSync.mock.calls[0][1][3]).toContain('Get-Process -Id 4242');
  });

  it('captures identity-bound Windows descendants for leader-exit cleanup', () => {
    const processIdentity = { startMarker: '638885000000000000' };
    const processTreeIdentities = [
      { pid: 4242, parentPid: null, startMarker: processIdentity.startMarker, depth: 0 },
      { pid: 4343, parentPid: 4242, startMarker: '638885000000100000', depth: 1 },
    ];
    const spawnSync = jest.fn(() => ({
      status: 0,
      stdout: JSON.stringify(processTreeIdentities),
    }));

    expect(readWindowsProcessTreeIdentities(4242, processIdentity, { spawnSync })).toEqual(
      processTreeIdentities,
    );
    expect(spawnSync.mock.calls[0][1][3]).toContain(
      '$candidateStartMarker -lt $parentStartMarker',
    );
    expect(captureOwnedProcessOwnership(4242, {
      platform: 'win32',
      readProcessIdentity: () => processIdentity,
      readWindowsProcessTreeIdentities: () => processTreeIdentities,
    })).toEqual({
      processIdentity,
      processTreeIdentities,
      ownershipBoundary: 'windows-process-tree-snapshot',
    });
    expect(captureOwnedProcessOwnership(4242, {
      platform: 'win32',
      ownershipBoundary: 'windows-job',
      readProcessIdentity: () => processIdentity,
      readWindowsProcessTreeIdentities: () => {
        throw new Error('Job ownership must not depend on PPID snapshots.');
      },
    })).toEqual({
      processIdentity,
      processTreeIdentities: [processTreeIdentities[0]],
      ownershipBoundary: 'windows-job',
    });
  });
});

describe('android-smoke screenshot capture', () => {
  const pngBuffer = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );

  it('bounds direct and fallback adb screenshot commands', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-ai-smoke-screenshot-'));
    const screenshotPath = path.join(tempDir, 'capture.png');
    const spawnSync = jest.fn((_command, args) => {
      if (args.includes('exec-out')) {
        return { status: 1, stdout: Buffer.alloc(0), stderr: 'direct capture failed' };
      }
      if (args.includes('pull')) {
        fs.writeFileSync(screenshotPath, pngBuffer);
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    try {
      captureAndroidScreenshot('adb', 'device-1', screenshotPath, { spawnSync });

      expect(fs.readFileSync(screenshotPath)).toEqual(pngBuffer);
      for (const [, , spawnOptions] of spawnSync.mock.calls) {
        expect(spawnOptions).toEqual(expect.objectContaining({ timeout: 15_000 }));
      }
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });
});

describe('android-smoke APK reuse decisions', () => {
  it('reuses the APK when the tracked fingerprint matches', () => {
    expect(
      evaluateApkReuse({
        apkExists: true,
        abiCompatible: true,
        fingerprintMatches: true,
        apkIsFreshByTime: false,
      })
    ).toEqual(
      expect.objectContaining({
        canReuse: true,
      })
    );
  });

  it('rebuilds when tracked native inputs are newer than the APK', () => {
    expect(
      evaluateApkReuse({
        apkExists: true,
        abiCompatible: true,
        fingerprintMatches: false,
        apkIsFreshByTime: false,
      })
    ).toEqual(
      expect.objectContaining({
        canReuse: false,
      })
    );
  });
});

describe('android-smoke install reuse decisions', () => {
  it('reuses an installed app only when stamp and device metadata still match', () => {
    expect(
      evaluateInstallReuse({
        packageInstalled: true,
        didBuildDebugApk: false,
        installStamp: {
          apkFingerprint: 'apk-1',
          packagePath: '/data/app/base.apk',
          lastUpdateTime: '2026-04-22 10:15:00',
          versionCode: '42',
        },
        apkFingerprint: { fingerprint: 'apk-1' },
        devicePackageInfo: {
          installed: true,
          packagePath: '/data/app/base.apk',
          lastUpdateTime: '2026-04-22 10:15:00',
          versionCode: '42',
        },
      })
    ).toEqual(
      expect.objectContaining({
        canReuse: true,
      })
    );
  });

  it('forces reinstall when the install stamp points to another APK', () => {
    expect(
      evaluateInstallReuse({
        packageInstalled: true,
        didBuildDebugApk: false,
        installStamp: {
          apkFingerprint: 'apk-old',
          packagePath: '/data/app/base.apk',
        },
        apkFingerprint: { fingerprint: 'apk-new' },
        devicePackageInfo: {
          installed: true,
          packagePath: '/data/app/base.apk',
          lastUpdateTime: '2026-04-22 10:15:00',
          versionCode: '42',
        },
      })
    ).toEqual(
      expect.objectContaining({
        canReuse: false,
      })
    );
  });
});

describe('android-smoke package metadata parsing', () => {
  it('extracts the base package path from pm output', () => {
    expect(
      parsePackagePathOutput('package:/data/app/~~abc/base.apk\npackage:/data/app/~~abc/split_config.en.apk\n')
    ).toBe('/data/app/~~abc/base.apk');
  });

  it('extracts lastUpdateTime and versionCode from dumpsys output', () => {
    expect(
      parseDumpsysPackageOutput('Packages:\n  Package [com.test.app] (123):\n    versionCode=42 minSdk=24\n    lastUpdateTime=2026-04-22 10:15:00\n')
    ).toEqual({
      lastUpdateTime: '2026-04-22 10:15:00',
      versionCode: '42',
    });
  });

  it('sanitizes device identifiers for cache file names', () => {
    expect(sanitizeForFileName('emulator-5554/com.test.app')).toBe('emulator-5554_com.test.app');
  });
});
