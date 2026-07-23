const path = require('path');
const fs = require('fs');
const os = require('os');
const { EventEmitter } = require('events');
const { isCompletePngBuffer } = require('../../scripts/png-validation');
const {
  describeAndroidQaError,
  sanitizeAndroidQaText,
} = require('../../scripts/android-qa-sanitization');
const {
  collectAndroidEffectiveBuildContext,
  collectBuildProvenance,
  collectPrebuildInputState,
  createIsolatedAndroidBuildEnvironment,
  hashCanonicalJson,
  withAndroidProvenanceGradleExecutionArgs,
} = require('../../scripts/android-build-provenance');

const {
  BRANCH_REGENERATION_SCENARIOS,
  assertAuthoritativeThoughtClear,
  assertPreparedAttachmentGenerationEvidence,
  buildAppRouteDeepLinkArgs,
  buildConversationTopology,
  buildScenarios,
  buildPreparedAttachmentSendPrompt,
  buildScenarioLaunchPlan,
  buildSmokeLaunchArgs,
  captureAndroidScreenshot,
  captureSettledScenarioScreenshot,
  cleanupAndroidLogcatCollector,
  cleanupScenarioOwnedMetro,
  cleanupTransferredMetroOwnership,
  collectCurrentQaBuildProvenance,
  configureScenarioBuildEnvironment,
  createBranchRegenerationBaseline,
  activateClearedCatalogFilterOption,
  appPrivatePathExists,
  CLEAR_TEXT_INPUT_FALLBACK_TOTAL_TIMEOUT_MS,
  clearCatalogFiltersIfPresent,
  clearFocusedTextInput,
  DEFAULT_CLEAR_TEXT_INPUT_MAX_DELETE_COUNT,
  dumpUiHierarchy,
  dismissTransientSurfaceWithBack,
  findCatalogRiskModelCard,
  findQuantizationSelectorNodeClearOfBottomOverlay,
  findBlockingSystemDialogAction,
  escapeAdbInputText,
  extractVisibleConversationTokens,
  findAttachImageActionInSnapshot,
  findAttachMenuActionInSnapshot,
  findAnyNodeClearOfBottomOverlay,
  findBottomTabNodeInSnapshot,
  findAnyNodeInSnapshot,
  findPreparedAssistantResponseNode,
  findPreparedSentMessageContext,
  findResourceIdInSnapshot,
  hasConversationHistoryStartAnchor,
  findTextOnlySentMessageNode,
  findNodeInSnapshot,
  isBoundsClearOfBottomOverlay,
  getBottomTabTapPoint,
  goToHome,
  goToModelCatalog,
  inputFocusedTextAndConfirm,
  installScenarioResourceSignalHandlers,
  isAppForegroundSnapshot,
  openFirstVisibleVariantPicker,
  parseCliOptions,
  parseUiSnapshot,
  pickClosestNodePair,
  prepareCatalogForVariantPickerSmokeScenario,
  readAndroidLogcatCollector,
  readTransferredMetroOwnership,
  resolveBranchRegenerationReplacement,
  resolveAndroidPackageUid,
  resolveAndroidQaGenerationGateObservation,
  resolveTargetAttachmentIds,
  selectScenarios,
  ScenarioSkipError,
  restoreLanguageAfterScenario,
  assertAttachmentPreviewRemovePreconditions,
  assertAttachmentActionBlocked,
  assertAttachmentActionAvailable,
  assertAttachmentTextOnlyFallbackState,
  isAttachmentActionBusy,
  isPreparedAssistantResponseLabel,
  markScenarioFailureRecorded,
  mergeOlderConversationOrder,
  normalizeAndroidResourceId,
  resolveBranchFixture,
  sanitizeQaLogcat,
  scanFatalAndroidLogs,
  ScenarioPreconditionFailureError,
  ScenarioSkipFailureError,
  serializeReportResults,
  setCatalogFilterPanelOpen,
  shouldPrepareMetroForScenarioLaunch,
  shouldAppendRunnerFailure,
  startAndroidLogcatCollector,
  stopAndroidLogcatCollector,
  tapBottomTabUntilVisible,
  tapBoundsUntilAnyNode,
  validateQaProvenance,
  areExactGitProvenancesEqual,
  waitForAnyNode,
  waitForEnabledAnyNode,
  waitForModelWarmupToSettleIfPresent,
  waitForSettledAttachImageAction,
} = require('../../scripts/android-scenarios');

const withAndroidReleaseConfig = require('../../plugins/withAndroidReleaseConfig');

describe('Android private-path verification', () => {
  const relativePath = 'cache/storage-qa/sentinel.bin';

  it('distinguishes a confirmed missing path from a successful lookup', () => {
    const existsSpawn = jest.fn(() => ({
      status: 0,
      stdout: `${relativePath}\n`,
      stderr: '',
    }));
    const missingSpawn = jest.fn(() => ({
      status: 1,
      stdout: '',
      stderr: `ls: ${relativePath}: No such file or directory`,
    }));

    expect(appPrivatePathExists('adb', 'device-1', relativePath, { spawnSync: existsSpawn })).toBe(true);
    expect(appPrivatePathExists('adb', 'device-1', relativePath, { spawnSync: missingSpawn })).toBe(false);
    expect(existsSpawn.mock.calls[0][2]).toEqual(expect.objectContaining({ timeout: 15_000 }));
  });

  it('fails closed when adb cannot verify the path', () => {
    expect(() => appPrivatePathExists('adb', 'device-1', relativePath, {
      spawnSync: () => ({ status: 1, stdout: '', stderr: 'error: device offline' }),
    })).toThrow('device offline');
    expect(() => appPrivatePathExists('adb', 'device-1', relativePath, {
      spawnSync: () => ({ error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) }),
    })).toThrow('timed out');
  });
});

describe('Android scenario Metro ownership', () => {
  const ownershipBoundary = process.platform === 'win32'
    ? 'windows-job'
    : 'posix-process-group';

  it('reads identity-bound ownership and removes only that process tree', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-ai-metro-owner-'));
    const ownershipPath = path.join(tempDir, 'owner.json');
    fs.writeFileSync(ownershipPath, JSON.stringify({
      pid: 4242,
      port: 8081,
      processIdentity: { startMarker: '638885000000000000' },
      processTreeIdentities: [{
        pid: 4242,
        parentPid: null,
        startMarker: '638885000000000000',
        depth: 0,
      }],
      ownershipBoundary,
    }));
    const ownership = readTransferredMetroOwnership(ownershipPath);
    const stopProcessTree = jest.fn(() => true);

    cleanupTransferredMetroOwnership(ownership, { stopProcessTree });

    expect(stopProcessTree).toHaveBeenCalledWith(4242, {
      expectedIdentity: { startMarker: '638885000000000000' },
      expectedProcessTreeIdentities: [{
        pid: 4242,
        parentPid: null,
        startMarker: '638885000000000000',
        depth: 0,
      }],
      ownershipBoundary,
    });
    expect(fs.existsSync(ownershipPath)).toBe(false);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects ownership records without a process identity', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-ai-metro-owner-'));
    const ownershipPath = path.join(tempDir, 'owner.json');
    fs.writeFileSync(ownershipPath, JSON.stringify({ pid: 4242, port: 8081 }));

    expect(() => readTransferredMetroOwnership(ownershipPath)).toThrow('without process identity');
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects ownership records without a matching process-tree snapshot', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-ai-metro-owner-'));
    const ownershipPath = path.join(tempDir, 'owner.json');
    fs.writeFileSync(ownershipPath, JSON.stringify({
      pid: 4242,
      port: 8081,
      processIdentity: { startMarker: '638885000000000000' },
      processTreeIdentities: [],
    }));

    expect(() => readTransferredMetroOwnership(ownershipPath)).toThrow(
      'without a valid process-tree identity snapshot',
    );
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects ownership records without the platform kernel boundary', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-ai-metro-owner-'));
    const ownershipPath = path.join(tempDir, 'owner.json');
    fs.writeFileSync(ownershipPath, JSON.stringify({
      pid: 4242,
      port: 8081,
      processIdentity: { startMarker: '638885000000000000' },
      processTreeIdentities: [{
        pid: 4242,
        parentPid: null,
        startMarker: '638885000000000000',
        depth: 0,
      }],
    }));

    expect(() => readTransferredMetroOwnership(ownershipPath)).toThrow(
      'incompatible Metro ownership boundary: missing',
    );
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('retains identity-bound ownership when cleanup fails so it can be retried safely', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-ai-metro-owner-'));
    const ownershipPath = path.join(tempDir, 'owner.json');
    fs.writeFileSync(ownershipPath, JSON.stringify({
      pid: 4242,
      port: 8081,
      processIdentity: { startMarker: '638885000000000000' },
      processTreeIdentities: [{
        pid: 4242,
        parentPid: null,
        startMarker: '638885000000000000',
        depth: 0,
      }],
      ownershipBoundary,
    }));
    const ownership = readTransferredMetroOwnership(ownershipPath);

    expect(() => cleanupTransferredMetroOwnership(ownership, {
      stopProcessTree: () => false,
    })).toThrow('Failed to stop scenario-owned Metro process tree 4242.');
    expect(fs.existsSync(ownershipPath)).toBe(true);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('stops only a Metro instance started and owned by the scenario runner', () => {
    const lifecycle = { process: { pid: 4242 } };
    const removeSignalHandlers = jest.fn();
    const stopOwnedMetroProcessOrThrow = jest.fn();

    cleanupScenarioOwnedMetro({
      started: true,
      lifecycle,
      removeSignalHandlers,
    }, { stopOwnedMetroProcessOrThrow });

    expect(removeSignalHandlers).toHaveBeenCalledTimes(1);
    expect(stopOwnedMetroProcessOrThrow).toHaveBeenCalledWith(lifecycle);

    cleanupScenarioOwnedMetro({ started: false, port: 8081 }, { stopOwnedMetroProcessOrThrow });
    cleanupScenarioOwnedMetro(null, { stopOwnedMetroProcessOrThrow });
    expect(stopOwnedMetroProcessOrThrow).toHaveBeenCalledTimes(1);
  });

  it('fails closed when an owned Metro has no lifecycle handle', () => {
    const removeSignalHandlers = jest.fn();

    expect(() => cleanupScenarioOwnedMetro({
      started: true,
      removeSignalHandlers,
    })).toThrow('missing its process lifecycle');
    expect(removeSignalHandlers).toHaveBeenCalledTimes(1);
  });

  it('cleans up the active logcat collector and Metro through one signal owner', () => {
    const processRef = new EventEmitter();
    processRef.pid = 5151;
    processRef.kill = jest.fn();
    const metro = { started: true, lifecycle: {} };
    const logcatCollector = { started: true, closed: false };
    const cleanupLogcat = jest.fn();
    const cleanupMetro = jest.fn();

    installScenarioResourceSignalHandlers(
      () => ({ metro, logcatCollector }),
      processRef,
      {
        cleanupAndroidLogcatCollector: cleanupLogcat,
        cleanupScenarioOwnedMetro: cleanupMetro,
      },
    );
    processRef.emit('SIGINT');

    expect(cleanupLogcat).toHaveBeenCalledWith(logcatCollector);
    expect(cleanupMetro).toHaveBeenCalledWith(metro);
    expect(processRef.kill).toHaveBeenCalledWith(5151, 'SIGINT');
    expect(processRef.listenerCount('SIGINT')).toBe(0);
    expect(processRef.listenerCount('SIGTERM')).toBe(0);
  });

  it('does not terminate the runner while an owned logcat process is still unsafe to release', () => {
    const processRef = new EventEmitter();
    processRef.pid = 5152;
    processRef.kill = jest.fn();
    const cleanupLogcat = jest
      .fn()
      .mockImplementationOnce(() => {
        const error = new Error(
          'owned collector PROMPT_SENTINEL hf_private_token C:\\Users\\private\\model.gguf'
        );
        error.name = 'PROMPT_SENTINEL';
        error.code = 'hf_private_token';
        throw error;
      })
      .mockImplementationOnce(() => undefined);
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    installScenarioResourceSignalHandlers(
      () => ({ logcatCollector: { started: true }, metro: null }),
      processRef,
      {
        cleanupAndroidLogcatCollector: cleanupLogcat,
        cleanupScenarioOwnedMetro: jest.fn(),
      },
    );

    processRef.emit('SIGTERM');
    expect(processRef.kill).not.toHaveBeenCalled();
    expect(processRef.listenerCount('SIGINT')).toBe(1);
    expect(processRef.listenerCount('SIGTERM')).toBe(1);

    processRef.emit('SIGTERM');
    expect(cleanupLogcat).toHaveBeenCalledTimes(2);
    expect(processRef.kill).toHaveBeenCalledWith(5152, 'SIGTERM');
    expect(processRef.listenerCount('SIGINT')).toBe(0);
    expect(processRef.listenerCount('SIGTERM')).toBe(0);
    const logged = consoleError.mock.calls.flat().join('\n');
    expect(logged).toContain('logcat-cleanup-failed');
    expect(logged).toContain('name=Error');
    expect(logged).toContain('code=unknown');
    expect(logged).not.toContain('PROMPT_SENTINEL');
    expect(logged).not.toContain('hf_private_token');
    expect(logged).not.toContain('C:\\Users\\private\\model.gguf');
    consoleError.mockRestore();
  });

  it('prepares Metro only for debug launches that need a development bundle', () => {
    expect(shouldPrepareMetroForScenarioLaunch({})).toBe(true);
    expect(shouldPrepareMetroForScenarioLaunch({ ANDROID_SMOKE_APK_VARIANT: 'release' })).toBe(false);
    expect(shouldPrepareMetroForScenarioLaunch({ ANDROID_SMOKE_SKIP_METRO: '1' })).toBe(false);
    expect(shouldPrepareMetroForScenarioLaunch({ ANDROID_SMOKE_APK_VARIANT: ' DEBUG ' })).toBe(true);
  });
});

describe('Android scenario route deep links', () => {
  it('builds a deterministic app-route intent for diagnostics screens', () => {
    expect(
      buildAppRouteDeepLinkArgs('device-1', '/performance', {
        packageName: 'com.example.app',
        scheme: 'example',
      })
    ).toEqual([
      '-s',
      'device-1',
      'shell',
      'am',
      'start',
      '-W',
      '-a',
      'android.intent.action.VIEW',
      '-d',
      'example://performance',
      'com.example.app',
    ]);
  });
});

describe('app image picker configuration', () => {
  const appConfig = require('../../app.json');

  it('declares gallery-only image picker permissions explicitly', () => {
    const imagePickerPlugin = appConfig.expo.plugins.find(
      (plugin) => Array.isArray(plugin) && plugin[0] === 'expo-image-picker'
    );

    expect(imagePickerPlugin).toEqual([
      'expo-image-picker',
      expect.objectContaining({
        photosPermission: expect.stringContaining('attach images'),
        cameraPermission: false,
        microphonePermission: false,
      }),
    ]);
    expect(appConfig.expo.plugins).toContain('./plugins/withIosPhotoLibraryPermissionLocalization');
    expect(appConfig.expo.android.permissions).not.toContain('CAMERA');
    expect(appConfig.expo.android.permissions).not.toContain('RECORD_AUDIO');
    expect(appConfig.expo.android.permissions).toContain('READ_EXTERNAL_STORAGE');
    expect(appConfig.expo.android.permissions).not.toContain('WRITE_EXTERNAL_STORAGE');
    expect(appConfig.expo.android.blockedPermissions).toEqual(
      expect.arrayContaining([
        'android.permission.CAMERA',
        'android.permission.RECORD_AUDIO',
        'android.permission.WRITE_EXTERNAL_STORAGE',
      ])
    );
    expect(appConfig.expo.android.blockedPermissions).not.toContain('android.permission.READ_EXTERNAL_STORAGE');
  });

  it('release config plugin removes blocked Android capture/write permissions and caps legacy gallery read', () => {
    const nextConfig = {
      modResults: {
        manifest: {
          application: [{ $: {} }],
          'uses-permission': [
            { $: { 'android:name': 'android.permission.INTERNET' } },
            { $: { 'android:name': 'android.permission.CAMERA' } },
            { $: { 'android:name': 'android.permission.CAMERA', 'tools:node': 'remove' } },
            { $: { 'android:name': 'android.permission.RECORD_AUDIO' } },
            { $: { 'android:name': 'android.permission.READ_EXTERNAL_STORAGE' } },
            { $: { 'android:name': 'android.permission.WRITE_EXTERNAL_STORAGE' } },
          ],
        },
      },
    };

    const result = withAndroidReleaseConfig._internal.applyAndroidManifestReleaseConfig(nextConfig);
    const permissionNames = result.modResults.manifest['uses-permission'].map(
      (permission) => permission.$['android:name']
    );

    expect(result.modResults.manifest.application[0].$['android:allowBackup']).toBe('false');
    expect(permissionNames).toEqual([
      'android.permission.INTERNET',
      'android.permission.CAMERA',
      'android.permission.READ_EXTERNAL_STORAGE',
    ]);
    expect(result.modResults.manifest['uses-permission']).toEqual([
      { $: { 'android:name': 'android.permission.INTERNET' } },
      { $: { 'android:name': 'android.permission.CAMERA', 'tools:node': 'remove' } },
      {
        $: {
          'android:name': 'android.permission.READ_EXTERNAL_STORAGE',
          'android:maxSdkVersion': '32',
        },
      },
    ]);
  });
});

describe('android-scenarios smoke bootstrap args', () => {
  it('configures release and the QA seam before current-head launch, and rejects debug', () => {
    const releaseEnv = {};
    expect(configureScenarioBuildEnvironment({ apkVariant: 'release' }, true, releaseEnv)).toEqual({
      androidQaEvidence: true,
      apkVariant: 'release',
    });
    expect(releaseEnv).toEqual({
      ANDROID_SMOKE_APK_VARIANT: 'release',
      EXPO_PUBLIC_ANDROID_QA: '1',
      POCKET_AI_ALLOW_DEBUG_RELEASE_SIGNING: 'true',
    });
    expect(() => configureScenarioBuildEnvironment(
      { apkVariant: 'debug' },
      true,
      {},
    )).toThrow(ScenarioPreconditionFailureError);
  });

  it('uses fast smoke reuse flags when skip-build is enabled', () => {
    const args = buildSmokeLaunchArgs(
      {
        emulator: true,
        skipBuild: true,
        bootstrapScreenshot: false,
        avd: 'Pixel_9',
        serial: null,
        port: '8088',
      },
      null
    );

    expect(args[0].endsWith(path.join('scripts', 'android-smoke.js'))).toBe(true);
    expect(args).toEqual(
      expect.arrayContaining([
        '--emulator',
        '--avd',
        'Pixel_9',
        '--skip-build',
        '--port',
        '8088',
      ])
    );
    expect(args).not.toContain('--transfer-metro-ownership');
    expect(args).not.toContain('--screenshot');
    expect(args).not.toContain('--launch-delay-ms');
    expect(args).not.toContain('--reuse-install');
  });

  it('adds bootstrap screenshot only when explicitly requested', () => {
    const args = buildSmokeLaunchArgs(
      {
        emulator: false,
        skipBuild: false,
        bootstrapScreenshot: true,
        avd: null,
        serial: 'emulator-5554',
        port: null,
      },
      null
    );

    expect(args).toEqual(
      expect.arrayContaining([
        '--screenshot',
        path.join('artifacts', 'android-scenarios', 'bootstrap.png'),
        '--serial',
        'emulator-5554',
      ])
    );
  });
});

describe('android-scenarios command capture', () => {
  it('returns captured output instead of throwing for allowed command failures', () => {
    const spawnSync = jest.fn(() => ({
      status: 1,
      stdout: 'partial logcat output',
      stderr: 'logcat read failed',
    }));
    let isolatedRunCapture;

    jest.isolateModules(() => {
      jest.doMock('child_process', () => ({ spawnSync }));
      ({ runCapture: isolatedRunCapture } = require('../../scripts/android-scenarios'));
    });

    try {
      expect(isolatedRunCapture('adb', ['-s', 'device-1', 'logcat', '-d'], { allowFailure: true })).toBe(
        'partial logcat output'
      );
      expect(() => isolatedRunCapture('adb', ['-s', 'device-1', 'logcat', '-d'])).toThrow('Command failed');
    } finally {
      jest.dontMock('child_process');
    }
  });
});

describe('android-scenarios screenshot capture', () => {
  const pngBuffer = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );

  it('requires a complete PNG stream rather than accepting the signature alone', () => {
    expect(isCompletePngBuffer(pngBuffer)).toBe(true);
    expect(isCompletePngBuffer(pngBuffer.subarray(0, pngBuffer.length - 1))).toBe(false);
    expect(isCompletePngBuffer(pngBuffer.subarray(0, 9))).toBe(false);
    expect(isCompletePngBuffer(Buffer.concat([pngBuffer, Buffer.from([0x00])]))).toBe(false);

    const corruptedImageData = Buffer.from(pngBuffer);
    let chunkOffset = 8;
    while (chunkOffset + 12 <= corruptedImageData.length) {
      const dataLength = corruptedImageData.readUInt32BE(chunkOffset);
      const chunkType = corruptedImageData.toString('ascii', chunkOffset + 4, chunkOffset + 8);
      if (chunkType === 'IDAT' && dataLength > 0) {
        corruptedImageData[chunkOffset + 8] ^= 0x01;
        break;
      }
      chunkOffset += 12 + dataLength;
    }
    expect(isCompletePngBuffer(corruptedImageData)).toBe(false);
  });

  it('retries transient invalid screenshots before failing the scenario', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-ai-screenshot-'));
    const screenshotPath = path.join(tempDir, 'capture.png');
    const sleepSync = jest.fn();
    let directAttempts = 0;
    const spawn = jest.fn((_command, args) => {
      if (args.includes('exec-out')) {
        directAttempts += 1;
        return {
          status: 0,
          stdout: directAttempts === 1 ? Buffer.from('not a png') : pngBuffer,
          stderr: '',
        };
      }

      if (args.includes('pull')) {
        fs.writeFileSync(screenshotPath, Buffer.from('still not a png'));
      }

      return {
        status: 0,
        stdout: '',
        stderr: '',
      };
    });

    try {
      expect(captureAndroidScreenshot('adb', 'device-1', screenshotPath, {
        copyRemoteFileInChunks: false,
        maxAttempts: 2,
        retryDelayMs: 1,
        sleepSync,
        spawnSync: spawn,
      })).toBe(screenshotPath);

      expect(sleepSync).toHaveBeenCalledWith(1);
      expect(directAttempts).toBe(2);
      expect(fs.readFileSync(screenshotPath).subarray(0, 8)).toEqual(pngBuffer.subarray(0, 8));
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it('waits for the target serial when adb temporarily reports the device offline', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-ai-screenshot-'));
    const screenshotPath = path.join(tempDir, 'capture.png');
    const sleepSync = jest.fn();
    let directAttempts = 0;
    let remoteAttempts = 0;
    const spawn = jest.fn((_command, args) => {
      if (args.includes('wait-for-device')) {
        return {
          status: 0,
          stdout: '',
          stderr: '',
        };
      }

      if (args.includes('exec-out')) {
        directAttempts += 1;
        return {
          status: 0,
          stdout: pngBuffer,
          stderr: '',
        };
      }

      if (args.includes('screencap')) {
        remoteAttempts += 1;
        return remoteAttempts === 1
          ? {
              status: 1,
              stdout: '',
              stderr: 'adb.exe: device offline',
            }
          : {
              status: 0,
              stdout: '',
              stderr: '',
            };
      }

      if (args.includes('pull')) {
        fs.writeFileSync(screenshotPath, pngBuffer);
      }

      return {
        status: 0,
        stdout: '',
        stderr: '',
      };
    });

    try {
      expect(captureAndroidScreenshot('adb', 'device-1', screenshotPath, {
        copyRemoteFileInChunks: false,
        maxAttempts: 2,
        retryDelayMs: 1,
        sleepSync,
        spawnSync: spawn,
      })).toBe(screenshotPath);

      expect(spawn).toHaveBeenCalledWith(
        'adb',
        ['-s', 'device-1', 'wait-for-device'],
        expect.objectContaining({ timeout: 15000 })
      );
      expect(remoteAttempts).toBe(2);
      expect(directAttempts).toBe(0);
      expect(fs.readFileSync(screenshotPath).subarray(0, 8)).toEqual(pngBuffer.subarray(0, 8));
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it('copies physical-device screenshots in bounded chunks instead of one large adb pull', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-ai-screenshot-'));
    const screenshotPath = path.join(tempDir, 'capture.png');
    const spawn = jest.fn((_command, args) => {
      if (args.includes('stat')) {
        return { status: 0, stdout: `${pngBuffer.length}\n`, stderr: '' };
      }

      if (args.includes('dd')) {
        return { status: 0, stdout: pngBuffer, stderr: '' };
      }

      return { status: 0, stdout: '', stderr: '' };
    });

    try {
      expect(captureAndroidScreenshot('adb', 'device-1', screenshotPath, {
        maxAttempts: 1,
        spawnSync: spawn,
      })).toBe(screenshotPath);

      expect(spawn.mock.calls.some(([, args]) => args.includes('pull'))).toBe(false);
      expect(spawn.mock.calls.some(([, args]) => args.includes('exec-out') && args.includes('screencap'))).toBe(false);
      expect(spawn).toHaveBeenCalledWith(
        'adb',
        expect.arrayContaining(['exec-out', 'dd', 'bs=32768', 'skip=0', 'count=1', 'status=none']),
        expect.objectContaining({ maxBuffer: 65536, timeout: 15000 })
      );
      for (const [, , spawnOptions] of spawn.mock.calls) {
        expect(spawnOptions).toEqual(expect.objectContaining({ timeout: 15000 }));
      }
      expect(fs.readFileSync(screenshotPath)).toEqual(pngBuffer);
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it('waits for the rendered surface before capturing a passed scenario', async () => {
    const events = [];
    const delayFn = jest.fn(async (delayMs) => {
      events.push(`wait:${delayMs}`);
    });
    const context = {
      captureScreenshot: jest.fn((fileName) => {
        events.push(`capture:${fileName}`);
        return fileName;
      }),
    };

    await expect(captureSettledScenarioScreenshot(context, 'bottom-tabs.png', {
      delayFn,
      settleDelayMs: 25,
    })).resolves.toBe('bottom-tabs.png');

    expect(delayFn).toHaveBeenCalledWith(25);
    expect(context.captureScreenshot).toHaveBeenCalledWith('bottom-tabs.png');
    expect(events).toEqual(['wait:25', 'capture:bottom-tabs.png']);
  });
});

describe('android-scenarios focused text clearing', () => {
  it('uses bounded timeouts on the primary clear success path', () => {
    const runCommand = jest.fn();

    clearFocusedTextInput('adb', 'device-1', 3, runCommand);

    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(runCommand).toHaveBeenNthCalledWith(
      1,
      'adb',
      ['-s', 'device-1', 'shell', 'input', 'keycombination', 'KEYCODE_CTRL_LEFT', 'KEYCODE_A'],
      expect.objectContaining({ timeout: 2_000 })
    );
    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      'adb',
      ['-s', 'device-1', 'shell', 'input', 'keyevent', 'KEYCODE_DEL'],
      expect.objectContaining({ timeout: 2_000 })
    );
  });

  it('uses timeouts for fallback keyevents and respects maxDeleteCount', () => {
    const runCommand = jest.fn();
    runCommand.mockImplementationOnce(() => {
      throw new Error('keycombination unsupported');
    });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    try {
      clearFocusedTextInput('adb', 'device-1', 3, runCommand);
    } finally {
      logSpy.mockRestore();
    }

    expect(runCommand).toHaveBeenCalledTimes(5);
    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      'adb',
      ['-s', 'device-1', 'shell', 'input', 'keyevent', 'KEYCODE_MOVE_END'],
      expect.objectContaining({ timeout: expect.any(Number) })
    );

    const deleteCalls = runCommand.mock.calls.slice(2);
    expect(deleteCalls).toHaveLength(3);
    for (const call of deleteCalls) {
      expect(call).toEqual([
        'adb',
        ['-s', 'device-1', 'shell', 'input', 'keyevent', 'KEYCODE_DEL'],
        expect.objectContaining({ timeout: expect.any(Number) }),
      ]);
    }
  });

  it('uses a bounded default max delete count for fallback clearing', () => {
    const runCommand = jest.fn();
    runCommand.mockImplementationOnce(() => {
      throw new Error('keycombination unsupported');
    });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    try {
      clearFocusedTextInput('adb', 'device-1', undefined, runCommand);
    } finally {
      logSpy.mockRestore();
    }

    expect(DEFAULT_CLEAR_TEXT_INPUT_MAX_DELETE_COUNT).toBeLessThanOrEqual(128);
    expect(runCommand).toHaveBeenCalledTimes(2 + DEFAULT_CLEAR_TEXT_INPUT_MAX_DELETE_COUNT);

    const deleteCalls = runCommand.mock.calls.slice(2);
    expect(deleteCalls).toHaveLength(DEFAULT_CLEAR_TEXT_INPUT_MAX_DELETE_COUNT);
  });

  it('stops fallback deletes when the total budget is exhausted', () => {
    const runCommand = jest.fn();
    runCommand.mockImplementationOnce(() => {
      throw new Error('keycombination unsupported');
    });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const nowSpy = jest.spyOn(Date, 'now');
    const nearBudgetEnd = CLEAR_TEXT_INPUT_FALLBACK_TOTAL_TIMEOUT_MS - 1;
    const nowValues = [0, 0, 3_000, nearBudgetEnd, CLEAR_TEXT_INPUT_FALLBACK_TOTAL_TIMEOUT_MS];
    nowSpy.mockImplementation(() => (nowValues.length > 0 ? nowValues.shift() : CLEAR_TEXT_INPUT_FALLBACK_TOTAL_TIMEOUT_MS));

    try {
      clearFocusedTextInput('adb', 'device-1', 100, runCommand);
    } finally {
      nowSpy.mockRestore();
      logSpy.mockRestore();
    }

    expect(runCommand).toHaveBeenCalledTimes(4);
    expect(runCommand.mock.calls[1][2]).toEqual(expect.objectContaining({ timeout: 2_000 }));
    expect(runCommand.mock.calls[2][2]).toEqual(expect.objectContaining({ timeout: 2_000 }));
    expect(runCommand.mock.calls[3][2]).toEqual(expect.objectContaining({ timeout: 1 }));
  });

  it('passes timeout options through runChecked to spawnSync', () => {
    jest.isolateModules(() => {
      const spawnSync = jest.fn(() => ({ status: 0 }));
      jest.doMock('child_process', () => ({ spawnSync }));
      const { runChecked } = require('../../scripts/android-scenarios');

      runChecked('adb', ['devices'], { stdio: 'ignore', timeout: 1_234 });

      expect(spawnSync).toHaveBeenCalledWith(
        'adb',
        ['devices'],
        expect.objectContaining({ stdio: 'ignore', timeout: 1_234 })
      );
      jest.dontMock('child_process');
    });
  });
});

describe('android-scenarios asynchronous interaction settlement', () => {
  const immediateDelay = jest.fn().mockResolvedValue(undefined);

  function composerSnapshot(text, sendEnabled = false) {
    return parseUiSnapshot(`
      <hierarchy>
        <node text="" content-desc="" clickable="false" enabled="true" bounds="[0,0][1080,2400]" />
        <node text="${text}" content-desc="Chat message input" clickable="true" enabled="true" bounds="[200,1840][860,1980]" />
        <node text="" content-desc="Send message" clickable="true" enabled="${sendEnabled ? 'true' : 'false'}" bounds="[900,1840][1040,1980]" />
      </hierarchy>
    `);
  }

  it('retries the full ADB prompt when the first injected character is lost', async () => {
    const prompt = 'Text fallback smoke 123 456';
    let typedValue = '';
    let inputAttempts = 0;
    const runCommand = jest.fn((_adbPath, args) => {
      if (args.includes('text')) {
        inputAttempts += 1;
        const decoded = args[args.length - 1].replace(/%s/g, ' ');
        typedValue = inputAttempts === 1 ? decoded.slice(1) : decoded;
      }
    });

    await inputFocusedTextAndConfirm('adb', 'device-1', prompt, {
      maxAttempts: 2,
      confirmTimeoutMs: 0,
      focusSettleMs: 0,
      retryDelayMs: 0,
      runCommand,
      clearInput: jest.fn(),
      createSnapshot: () => composerSnapshot(typedValue, true),
      delayFn: immediateDelay,
    });

    expect(inputAttempts).toBe(2);
    expect(typedValue).toBe(prompt);
    expect(runCommand).toHaveBeenLastCalledWith(
      'adb',
      ['-s', 'device-1', 'shell', 'input', 'text', escapeAdbInputText(prompt)],
      expect.objectContaining({ timeout: 5_000 })
    );
  });

  it('waits for the send action to become enabled instead of trusting a stale snapshot', async () => {
    const createSnapshot = jest.fn()
      .mockReturnValueOnce(composerSnapshot('Prompt', false))
      .mockReturnValue(composerSnapshot('Prompt', true));

    const match = await waitForEnabledAnyNode('adb', 'device-1', ['Send message'], {
      timeoutMs: 1_000,
      pollIntervalMs: 0,
      createSnapshot,
      delayFn: immediateDelay,
    });

    expect(match.node.enabled).toBe(true);
    expect(createSnapshot).toHaveBeenCalledTimes(2);
  });

  it('keeps polling after the attachment menu tap until the sheet action appears', async () => {
    const closedSnapshot = parseUiSnapshot(`
      <hierarchy>
        <node text="" content-desc="" clickable="false" enabled="true" bounds="[0,0][1080,2400]" />
        <node resource-id="chat-attach-menu-button" text="" content-desc="Attach file" clickable="true" enabled="true" bounds="[40,1840][180,1980]" />
      </hierarchy>
    `);
    const openSnapshot = parseUiSnapshot(`
      <hierarchy>
        <node text="" content-desc="" clickable="false" enabled="true" bounds="[0,0][1080,2400]" />
        <node resource-id="chat-attach-image-button" text="" content-desc="Attach an image from the photo library" clickable="false" enabled="false" bounds="[40,1480][1040,1620]" />
      </hierarchy>
    `);
    const createSnapshot = jest.fn()
      .mockReturnValueOnce(closedSnapshot)
      .mockReturnValueOnce(closedSnapshot)
      .mockReturnValue(openSnapshot);
    const tap = jest.fn();
    const dismissMenu = jest.fn();

    const match = await waitForSettledAttachImageAction('adb', 'device-1', {
      timeoutMs: 1_000,
      pollIntervalMs: 0,
      afterMenuOpenDelayMs: 0,
      afterMenuDismissDelayMs: 0,
      createSnapshot,
      tapBounds: tap,
      dismissAttachmentMenu: dismissMenu,
      delayFn: immediateDelay,
    });

    expect(match.node.resourceId).toBe('chat-attach-image-button');
    expect(tap).toHaveBeenCalledTimes(1);
    expect(dismissMenu).toHaveBeenCalledTimes(1);
  });

  it('waits for the model warmup banner to disappear before chat interaction', async () => {
    let warmingUp = true;
    const createSnapshot = () => parseUiSnapshot(`
      <hierarchy>
        <node text="" content-desc="" clickable="false" enabled="true" bounds="[0,0][1080,2400]" />
        ${warmingUp ? '<node resource-id="model-warmup-banner-container" text="Initializing" content-desc="" clickable="false" enabled="true" bounds="[40,200][1040,400]" />' : ''}
      </hierarchy>
    `);
    const delayFn = jest.fn(async () => {
      warmingUp = false;
    });

    const waited = await waitForModelWarmupToSettleIfPresent('adb', 'device-1', {
      timeoutMs: 1_000,
      pollIntervalMs: 0,
      createSnapshot,
      delayFn,
    });

    expect(waited).toBe(true);
    expect(warmingUp).toBe(false);
    expect(delayFn).toHaveBeenCalled();
  });

  it('observes a warmup marker that appears after the first Home snapshot', async () => {
    let phase = 0;
    const createSnapshot = () => parseUiSnapshot(`
      <hierarchy>
        <node text="" content-desc="" clickable="false" enabled="true" bounds="[0,0][1080,2400]" />
        ${phase === 1 ? '<node text="WARMING UP MODEL..." content-desc="" clickable="false" enabled="true" bounds="[40,200][1040,400]" />' : ''}
      </hierarchy>
    `);
    const delayFn = jest.fn(async () => {
      phase += 1;
    });

    const waited = await waitForModelWarmupToSettleIfPresent('adb', 'device-1', {
      detectionTimeoutMs: 1_000,
      timeoutMs: 1_000,
      pollIntervalMs: 0,
      createSnapshot,
      delayFn,
    });

    expect(waited).toBe(true);
    expect(phase).toBeGreaterThanOrEqual(2);
    expect(delayFn).toHaveBeenCalledTimes(2);
  });

  it('retries stable catalog testID taps until the requested filter state is observable', async () => {
    let panelOpen = false;
    let hasActiveFilter = true;
    let panelTapAttempts = 0;
    let clearTapAttempts = 0;
    let optionTapAttempts = 0;
    const createSnapshot = () => parseUiSnapshot(`
      <hierarchy>
        <node text="" content-desc="" clickable="false" enabled="true" bounds="[0,0][1080,2400]" />
        <node resource-id="models-filter-toggle" text="Filters" content-desc="Filters" clickable="true" enabled="true" bounds="[40,100][520,200]" />
        ${panelOpen ? '<node resource-id="models-filter-panel" text="" content-desc="" clickable="false" enabled="true" bounds="[40,220][1040,1200]" />' : ''}
        ${panelOpen ? '<node resource-id="filter-option-no-token-required" text="No token required" content-desc="" clickable="true" enabled="true" bounds="[60,400][1020,500]" />' : ''}
        ${panelOpen && hasActiveFilter ? '<node resource-id="models-filter-clear" text="Clear" content-desc="" clickable="true" enabled="true" bounds="[800,240][1020,340]" />' : ''}
      </hierarchy>
    `);
    const tap = jest.fn((_adbPath, _serial, bounds) => {
      if (bounds.centerY === 150) {
        panelTapAttempts += 1;
        if (panelTapAttempts === 2) panelOpen = true;
      } else if (bounds.centerY === 290) {
        clearTapAttempts += 1;
        if (clearTapAttempts === 2) hasActiveFilter = false;
      } else if (bounds.centerY === 450) {
        optionTapAttempts += 1;
        if (optionTapAttempts === 2) hasActiveFilter = true;
      }
    });
    const options = {
      maxAttempts: 2,
      timeoutMs: 0,
      createSnapshot,
      tapBounds: tap,
      delayFn: immediateDelay,
    };

    await setCatalogFilterPanelOpen('adb', 'device-1', true, options);
    await clearCatalogFiltersIfPresent('adb', 'device-1', options);
    await activateClearedCatalogFilterOption('adb', 'device-1', 'filter-option-no-token-required', options);

    expect(panelTapAttempts).toBe(2);
    expect(clearTapAttempts).toBe(2);
    expect(optionTapAttempts).toBe(2);
    expect(hasActiveFilter).toBe(true);
  });

  it('gives catalog filter taps a quiet window before capturing the first post-tap snapshot', async () => {
    let panelOpen = false;
    let tapIssued = false;
    let quietWindowObserved = false;
    let capturedTooEarly = false;
    const createSnapshot = () => {
      if (tapIssued && !quietWindowObserved) {
        capturedTooEarly = true;
      }
      return parseUiSnapshot(`
        <hierarchy>
          <node text="" content-desc="" clickable="false" enabled="true" bounds="[0,0][1080,2400]" />
          <node resource-id="models-filter-toggle" text="Filters" content-desc="Filters" clickable="true" enabled="true" bounds="[40,100][520,200]" />
          ${panelOpen ? '<node resource-id="models-filter-panel" text="" content-desc="" clickable="false" enabled="true" bounds="[40,220][1040,1200]" />' : ''}
        </hierarchy>
      `);
    };
    const tapBounds = jest.fn(() => {
      tapIssued = true;
    });
    const delayFn = jest.fn(async () => {
      quietWindowObserved = true;
      panelOpen = true;
    });

    await setCatalogFilterPanelOpen('adb', 'device-1', true, {
      maxAttempts: 1,
      timeoutMs: 0,
      afterTapDelayMs: 1,
      createSnapshot,
      tapBounds,
      delayFn,
    });

    expect(tapBounds).toHaveBeenCalledTimes(1);
    expect(delayFn).toHaveBeenCalled();
    expect(capturedTooEarly).toBe(false);
    expect(panelOpen).toBe(true);
  });

  it('retries Back only while the transient sheet remains visible', async () => {
    let sheetOpen = true;
    const createSnapshot = () => parseUiSnapshot(`
      <hierarchy>
        <node text="" content-desc="" clickable="false" enabled="true" bounds="[0,0][1080,2400]" />
        <node text="${sheetOpen ? 'Choose GGUF file' : 'Model Catalog'}" content-desc="" clickable="false" enabled="true" bounds="[40,100][1040,220]" />
      </hierarchy>
    `);
    const pressBack = jest.fn(async () => {
      if (pressBack.mock.calls.length === 2) sheetOpen = false;
    });
    const quietDelay = jest.fn().mockResolvedValue(undefined);

    await dismissTransientSurfaceWithBack(
      { pressBack },
      'adb',
      'device-1',
      ['Choose GGUF file'],
      ['Model Catalog'],
      {
        maxAttempts: 2,
        timeoutMs: 0,
        afterBackDelayMs: 1,
        createSnapshot,
        delayFn: quietDelay,
      }
    );

    expect(pressBack).toHaveBeenCalledTimes(2);
    expect(quietDelay).toHaveBeenCalledTimes(2);
  });

  it('retries a route tap only while the source screen remains visible', async () => {
    let detailsVisible = false;
    let tapAttempts = 0;
    let quietWindows = 0;
    let capturedTooEarly = false;
    const createSnapshot = () => {
      if (tapAttempts > quietWindows) {
        capturedTooEarly = true;
      }
      return parseUiSnapshot(`
        <hierarchy>
          <node text="" content-desc="" clickable="false" enabled="true" bounds="[0,0][1080,2400]" />
          <node text="${detailsVisible ? 'Model details' : 'Model Catalog'}" content-desc="" clickable="false" enabled="true" bounds="[40,100][1040,220]" />
        </hierarchy>
      `);
    };
    const tap = jest.fn(() => {
      tapAttempts += 1;
      if (tapAttempts === 2) detailsVisible = true;
    });
    const quietDelay = jest.fn(async () => {
      quietWindows += 1;
    });

    await tapBoundsUntilAnyNode(
      'adb',
      'device-1',
      { centerX: 900, centerY: 500 },
      ['Model details'],
      {
        sourceLabels: ['Model Catalog'],
        maxAttempts: 2,
        timeoutMs: 0,
        afterTapDelayMs: 1,
        createSnapshot,
        tapBounds: tap,
        delayFn: quietDelay,
      }
    );

    expect(tap).toHaveBeenCalledTimes(2);
    expect(quietDelay).toHaveBeenCalledTimes(2);
    expect(capturedTooEarly).toBe(false);
  });

  it('retries bottom-tab navigation when the first transition assertion times out', async () => {
    const firstTimeout = new Error('first transition timed out');
    const ctx = {
      tapBottomTab: jest.fn().mockResolvedValue(undefined),
      expectAnyText: jest.fn()
        .mockRejectedValueOnce(firstTimeout)
        .mockResolvedValueOnce(undefined),
    };

    await tapBottomTabUntilVisible(ctx, ['Settings'], ['Language'], {
      maxAttempts: 2,
      timeoutMs: 1_000,
    });

    expect(ctx.tapBottomTab).toHaveBeenCalledTimes(2);
    expect(ctx.expectAnyText).toHaveBeenCalledTimes(2);
  });
});

describe('android-scenarios npm defaults', () => {
  const packageJson = require('../../package.json');

  it('keeps the default npm scenario scripts on the fast core pack', () => {
    expect(packageJson.scripts['android:scenarios']).toContain('--pack core');
    expect(packageJson.scripts['android:scenarios:emulator']).toContain('--pack core');
  });

  it('exposes targeted scenario packs for dependency checks', () => {
    expect(packageJson.scripts['android:scenarios:catalog']).toContain('--pack catalog');
    expect(packageJson.scripts['android:scenarios:storage']).toContain('--pack storage');
    expect(packageJson.scripts['android:scenarios:storage']).toContain('--fail-on-skip');
    expect(packageJson.scripts['android:scenarios:attachments']).toContain('--pack attachments');
    expect(packageJson.scripts['android:scenarios:attachments-preconditioned']).toContain('--pack attachments-preconditioned');
    expect(packageJson.scripts['android:scenarios:attachments-preconditioned']).toContain('--preserve-running-app');
    expect(packageJson.scripts['android:scenarios:attachments-preconditioned']).toContain('--fail-on-skip');
    expect(packageJson.scripts['android:scenarios:attachments-prepared']).toContain('--pack attachments-prepared');
    expect(packageJson.scripts['android:scenarios:attachments-prepared']).toContain('--preserve-running-app');
    expect(packageJson.scripts['android:scenarios:attachments-prepared']).toContain('--fail-on-skip');
    expect(packageJson.scripts['android:scenarios:attachments-prepared-send']).toContain('--pack attachments-prepared-send');
    expect(packageJson.scripts['android:scenarios:attachments-prepared-send']).toContain('--preserve-running-app');
    expect(packageJson.scripts['android:scenarios:attachments-prepared-send']).toContain('--fail-on-skip');
    expect(packageJson.scripts['android:scenarios:dependency-ui']).toContain('--pack dependency-ui');
    expect(packageJson.scripts['android:scenarios:runtime']).toContain('--pack runtime');
    expect(packageJson.scripts['android:scenarios:runtime']).toContain('--fail-on-skip');
    expect(packageJson.scripts['android:scenarios:branch-regeneration']).toBe(
      'node ./scripts/android-scenarios.js --pack branch-regeneration --apk-variant release --fail-on-skip'
    );
    expect(packageJson.scripts['android:scenarios:native']).toContain('--pack native');
    expect(packageJson.scripts['android:scenarios:extended']).toContain('--pack extended');
  });

  it('keeps smoke verification on current-state attachments and prepared send opt-in', () => {
    const smokeScript = packageJson.scripts['verify:mobile-change:android:vision-smoke'];
    const preparedScript = packageJson.scripts['verify:mobile-change:android:vision-prepared'];
    const fullVisionScript = packageJson.scripts['verify:mobile-change:android:vision'];

    expect(smokeScript).toContain('verify:mobile-change');
    expect(smokeScript).toContain('android:scenarios:runtime');
    expect(smokeScript).toContain('android:scenarios:catalog');
    expect(smokeScript).toContain('android:scenarios:attachments');
    expect(smokeScript).toContain('android:scenarios:attachments -- --fail-on-skip');
    expect(smokeScript).not.toContain('android:scenarios:attachments-preconditioned');
    expect(smokeScript).not.toContain('android:scenarios:attachments-prepared');
    expect(smokeScript).not.toContain('android:scenarios:attachments-prepared-send');
    expect(preparedScript).toBe('npm run android:scenarios:attachments-prepared-send');
    expect(fullVisionScript).toBe('npm run verify:mobile-change:android:vision-smoke');
    expect(fullVisionScript).not.toContain('vision-prepared');
  });

  it('keeps prepared send ADB text input constrained and escaped', () => {
    expect(escapeAdbInputText('Describe prepared image')).toBe('Describe%sprepared%simage');
    expect(escapeAdbInputText('Describe prepared image 123')).toBe('Describe%sprepared%simage%s123');
    expect(() => escapeAdbInputText('Describe: prepared image')).toThrow(/ASCII letters/);
  });

  it('skips bootstrap launch when preserving a prepared running app', () => {
    const resolveSerial = jest.fn(() => 'emulator-5554');

    expect(buildScenarioLaunchPlan({ preserveRunningApp: true, emulator: true }, resolveSerial)).toEqual({
      shouldLaunch: false,
      serialBeforeLaunch: 'emulator-5554',
    });
    expect(resolveSerial).toHaveBeenCalledTimes(1);
  });

  it('keeps emulator bootstrap launch serial resolution after launch', () => {
    const resolveSerial = jest.fn(() => 'emulator-5554');

    expect(buildScenarioLaunchPlan({ preserveRunningApp: false, emulator: true }, resolveSerial)).toEqual({
      shouldLaunch: true,
      serialBeforeLaunch: null,
    });
    expect(resolveSerial).not.toHaveBeenCalled();
  });
});

describe('android-scenarios UI snapshot matching', () => {
  const snapshot = parseUiSnapshot(`
    <hierarchy>
      <node text="" content-desc="" clickable="false" bounds="[0,0][1080,2400]" />
      <node text="Home" content-desc="" clickable="true" bounds="[10,20][210,120]" />
      <node text="" content-desc="tab, Settings, 4 of 4" clickable="true" bounds="[800,2200][1000,2350]" />
    </hierarchy>
  `);

  it('matches any label from one parsed snapshot', () => {
    const match = findAnyNodeInSnapshot(snapshot, ['Missing', 'Home'], { visibleOnly: true });

    expect(match).toEqual(
      expect.objectContaining({
        label: 'Home',
      })
    );
    expect(match.node.text).toBe('Home');
  });

  it('accepts a node from the final timeout-boundary snapshot', async () => {
    const finalSnapshot = parseUiSnapshot(`
      <hierarchy>
        <node text="" content-desc="" clickable="false" bounds="[0,0][1080,2400]" />
        <node text="Model Catalog" content-desc="" clickable="false" bounds="[100,120][980,220]" />
      </hierarchy>
    `);
    const createSnapshot = jest.fn(() => finalSnapshot);

    await expect(waitForAnyNode('adb', 'serial', ['Model Catalog'], {
      timeoutMs: 0,
      visibleOnly: true,
      createSnapshot,
    })).resolves.toEqual(expect.objectContaining({ label: 'Model Catalog' }));
    expect(createSnapshot).toHaveBeenCalledTimes(1);
  });

  it('uses the same final snapshot for timeout diagnostics', async () => {
    const finalSnapshot = parseUiSnapshot(`
      <hierarchy>
        <node text="" content-desc="" clickable="false" bounds="[0,0][1080,2400]" />
        <node text="Still loading" content-desc="" clickable="false" bounds="[100,120][980,220]" />
      </hierarchy>
    `);
    const createSnapshot = jest.fn(() => finalSnapshot);

    await expect(waitForAnyNode('adb', 'serial', ['Model Catalog'], {
      timeoutMs: 0,
      visibleOnly: true,
      createSnapshot,
    })).rejects.toThrow(/Visible UI: Still loading/);
    expect(createSnapshot).toHaveBeenCalledTimes(1);
  });

  it('accepts Home when it appears on the final recovery snapshot', async () => {
    const findAnyNodeNow = jest.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ label: 'Active model' });
    const ctx = {
      serial: 'device-1',
      ensureAppVisible: jest.fn().mockResolvedValue(undefined),
      dismissDebuggerBanner: jest.fn().mockResolvedValue(undefined),
      expectAnyText: jest.fn().mockRejectedValueOnce(new Error('boundary timeout')),
    };

    await expect(goToHome(ctx, {
      resolveAdbPath: () => 'adb',
      findAnyNodeNow,
      tryReachHome: jest.fn().mockResolvedValue(false),
    })).resolves.toBeUndefined();

    expect(findAnyNodeNow).toHaveBeenCalledTimes(2);
    expect(ctx.expectAnyText).toHaveBeenCalledTimes(1);
  });

  it('opens catalog scenarios through the bottom tab independently of the active-model CTA', async () => {
    const ctx = {
      tapBottomTab: jest.fn().mockResolvedValue(undefined),
      expectAnyText: jest.fn().mockResolvedValue(undefined),
    };
    const goHome = jest.fn().mockResolvedValue(undefined);
    const waitForModelWarmup = jest.fn().mockResolvedValue(undefined);

    await goToModelCatalog(ctx, { goToHome: goHome, waitForModelWarmup });

    expect(goHome).toHaveBeenCalledWith(ctx);
    expect(waitForModelWarmup).toHaveBeenCalledWith(ctx);
    expect(ctx.tapBottomTab).toHaveBeenCalledWith(expect.arrayContaining(['Models']));
    expect(ctx.expectAnyText).toHaveBeenCalledWith(expect.arrayContaining(['Model Catalog']));
  });

  it('matches a visible namespaced resource id and ignores offscreen duplicates', () => {
    const resourceSnapshot = parseUiSnapshot(`
      <hierarchy>
        <node text="" content-desc="" clickable="false" bounds="[0,0][1080,2400]" />
        <node resource-id="chat-list-viewport" text="" content-desc="" clickable="false" bounds="[20,2500][1060,3000]" />
        <node resource-id="com.github.tah10n.pocketai:id/chat-list-viewport" text="" content-desc="" clickable="false" bounds="[20,300][1060,1800]" />
      </hierarchy>
    `);

    const node = findResourceIdInSnapshot(resourceSnapshot, 'chat-list-viewport', {
      visibleOnly: true,
    });

    expect(node?.resourceId).toBe('com.github.tah10n.pocketai:id/chat-list-viewport');
  });

  it('does not treat stale composer text with an appended prompt as an exact prepared-send prompt match', () => {
    const uniquePrompt = 'Describe prepared image 12345 67890';
    const staleComposerSnapshot = parseUiSnapshot(`
      <hierarchy>
        <node text="Old draft ${uniquePrompt}" content-desc="" clickable="true" bounds="[40,1900][900,2050]" />
        <node text="" content-desc="Send message" clickable="true" enabled="true" bounds="[920,2050][1040,2170]" />
      </hierarchy>
    `);

    expect(findAnyNodeInSnapshot(staleComposerSnapshot, [uniquePrompt], { visibleOnly: true })).toBeNull();
  });

  it('pairs prepared sent prompts with the adjacent message image preview', () => {
    const uniquePrompt = 'Describe prepared image 12345 67890';
    const sentSnapshot = parseUiSnapshot(`
      <hierarchy>
        <node text="" content-desc="" clickable="false" bounds="[0,0][1080,2400]" />
        <node text="Message image 1 of 1 preview" content-desc="" clickable="false" bounds="[40,120][1040,520]" />
        <node text="Message image 1 of 1 preview" content-desc="" clickable="false" bounds="[40,820][1040,1180]" />
        <node text="${uniquePrompt}" content-desc="" clickable="false" bounds="[40,1200][1040,1320]" />
      </hierarchy>
    `);

    const match = findPreparedSentMessageContext(sentSnapshot, uniquePrompt);

    expect(match?.promptMatch.node.text).toBe(uniquePrompt);
    expect(match?.messagePreviewMatch.node.bounds.top).toBe(820);
  });

  it('does not pair prepared sent prompts with distant stale image previews', () => {
    const uniquePrompt = 'Describe prepared image 12345 67890';
    const stalePreviewSnapshot = parseUiSnapshot(`
      <hierarchy>
        <node text="" content-desc="" clickable="false" bounds="[0,0][1080,2400]" />
        <node text="Message image 1 of 1 preview" content-desc="" clickable="false" bounds="[40,120][1040,520]" />
        <node text="${uniquePrompt}" content-desc="" clickable="false" bounds="[40,1200][1040,1320]" />
      </hierarchy>
    `);

    expect(findPreparedSentMessageContext(stalePreviewSnapshot, uniquePrompt)).toBeNull();
  });

  it('matches normalized content descriptions from the same snapshot', () => {
    const node = findNodeInSnapshot(snapshot, 'Settings', { visibleOnly: true });

    expect(node).toBeTruthy();
    expect(node.clickable).toBe(true);
  });

  it('finds image attachment action by resource id but rejects lingering busy state', () => {
    const attachmentSnapshot = parseUiSnapshot(`
      <hierarchy>
        <node text="" content-desc="" clickable="false" bounds="[0,0][1080,2400]" />
        <node resource-id="chat-attach-image-button" text="" content-desc="Attach an image from the photo library, busy" clickable="true" enabled="true" bounds="[58,1981][142,2065]" />
      </hierarchy>
    `);

    const match = findAttachImageActionInSnapshot(attachmentSnapshot, { visibleOnly: true });

    expect(match).toBeTruthy();
    expect(isAttachmentActionBusy(match.node)).toBe(true);
    expect(() => assertAttachmentActionAvailable(match)).toThrow(/still busy/);
  });

  it('finds the collapsed attachment menu action by resource id', () => {
    const attachmentSnapshot = parseUiSnapshot(`
      <hierarchy>
        <node text="" content-desc="" clickable="false" bounds="[0,0][1080,2400]" />
        <node resource-id="chat-attach-menu-button" text="" content-desc="Attach file" clickable="true" enabled="true" bounds="[58,1981][142,2065]" />
      </hierarchy>
    `);

    const match = findAttachMenuActionInSnapshot(attachmentSnapshot, { visibleOnly: true });

    expect(match).toBeTruthy();
    expect(match.node.resourceId).toBe('chat-attach-menu-button');
  });

  it('treats any visible Pocket AI route as app foreground', () => {
    const appRouteSnapshot = parseUiSnapshot(`
      <hierarchy>
        <node text="" content-desc="" package="android" clickable="false" bounds="[0,0][1080,2400]" />
        <node text="Access token" content-desc="" package="com.github.tah10n.pocketai" clickable="false" bounds="[10,20][300,120]" />
      </hierarchy>
    `);

    expect(isAppForegroundSnapshot(appRouteSnapshot)).toBe(true);
  });

  it('does not confuse launcher UI with app foreground content', () => {
    const launcherSnapshot = parseUiSnapshot(`
      <hierarchy>
        <node text="Pocket AI" content-desc="" package="com.google.android.apps.nexuslauncher" clickable="true" bounds="[10,20][300,120]" />
      </hierarchy>
    `);

    expect(isAppForegroundSnapshot(launcherSnapshot)).toBe(false);
  });

  it('recognizes app foreground content when package names are hidden by the UI dump', () => {
    const appSnapshot = parseUiSnapshot(`
      <hierarchy>
        <node text="" content-desc="" package="android" clickable="false" bounds="[0,0][1080,2400]" />
        <node text="Pocket AI" content-desc="" package="android" clickable="false" bounds="[148,177][396,216]" />
        <node text="NO MODEL LOADED" content-desc="" package="android" clickable="false" bounds="[78,337][373,377]" />
        <node text="Choose a local model" content-desc="" package="android" clickable="false" bounds="[78,496][588,535]" />
        <node text="Browse models" content-desc="" package="android" clickable="true" bounds="[714,581][1003,649]" />
      </hierarchy>
    `);

    expect(isAppForegroundSnapshot(appSnapshot)).toBe(true);
  });

  it('prefers waiting over closing the app when an ANR dialog appears', () => {
    const snapshot = parseUiSnapshot(`
      <hierarchy>
        <node text="" content-desc="" package="android" clickable="false" bounds="[0,0][1080,2400]" />
        <node text="Pocket AI isn't responding" content-desc="" package="android" clickable="false" bounds="[70,1200][1000,1300]" />
        <node text="Close app" content-desc="" package="android" clickable="true" bounds="[200,1400][820,1510]" />
        <node text="Wait" content-desc="" package="android" clickable="true" bounds="[200,1560][820,1670]" />
      </hierarchy>
    `);

    expect(findBlockingSystemDialogAction(snapshot)).toEqual(
      expect.objectContaining({
        kind: 'wait',
        label: 'Wait',
      })
    );
  });

  it('treats text under the floating tab bar as visible but unsafe to tap', () => {
    const snapshot = parseUiSnapshot(`
      <hierarchy>
        <node text="" content-desc="" clickable="false" bounds="[0,0][1080,2400]" />
        <node text="" content-desc="icon, Language, English (US)" clickable="true" bounds="[37,2174][1043,2378]" />
        <node text="" content-desc="icon, Language, English (US)" clickable="true" bounds="[37,1600][1043,1804]" />
      </hierarchy>
    `);

    const bottomLanguage = findAnyNodeInSnapshot(snapshot, ['Language'], { visibleOnly: true });
    const safeLanguage = findAnyNodeClearOfBottomOverlay(snapshot, ['Language']);

    expect(bottomLanguage).toBeTruthy();
    expect(isBoundsClearOfBottomOverlay(bottomLanguage.node.bounds, snapshot.viewportBounds)).toBe(false);
    expect(safeLanguage.node.bounds.centerY).toBe(1702);
    expect(isBoundsClearOfBottomOverlay(safeLanguage.node.bounds, snapshot.viewportBounds)).toBe(true);
  });

  it('finds quantization selector rows by the compact value text', () => {
    const compactSelectorSnapshot = parseUiSnapshot(`
      <hierarchy>
        <node text="" content-desc="" clickable="false" bounds="[0,0][1080,2400]" />
        <node text="Q4_K_M - 3.80 GB" content-desc="" clickable="true" bounds="[40,500][1040,590]" />
        <node text="Quantization" content-desc="" clickable="true" bounds="[40,2100][1040,2190]" />
      </hierarchy>
    `);

    const match = findQuantizationSelectorNodeClearOfBottomOverlay(compactSelectorSnapshot);

    expect(match).toBeTruthy();
    expect(match.node.text).toBe('Q4_K_M - 3.80 GB');
  });

  it('ignores read-only quantization text when opening variant picker rows', () => {
    const compactSelectorSnapshot = parseUiSnapshot(`
      <hierarchy>
        <node text="" content-desc="" clickable="false" bounds="[0,0][1080,2400]" />
        <node text="Q4_K_M - 3.80 GB" content-desc="" clickable="false" bounds="[40,500][1040,590]" />
        <node text="" content-desc="Choose GGUF file, current: Q8_0 - 7.20 GB" clickable="true" bounds="[40,700][1040,790]" />
      </hierarchy>
    `);

    const match = findQuantizationSelectorNodeClearOfBottomOverlay(compactSelectorSnapshot);

    expect(match).toBeTruthy();
    expect(match.node.contentDesc).toBe('Choose GGUF file, current: Q8_0 - 7.20 GB');
  });

  it('recognizes a generic GGUF variant row by its stable selector resource id', () => {
    const genericSelectorSnapshot = parseUiSnapshot(`
      <hierarchy>
        <node text="" content-desc="" clickable="false" bounds="[0,0][1080,2400]" />
        <node resource-id="model-variant-selector-deepseek-v4-gguf" text="" content-desc="Choose GGUF file, current: GGUF - 86.72 GB" clickable="true" bounds="[40,500][1040,620]" />
        <node text="GGUF - 86.72 GB" content-desc="" clickable="false" bounds="[80,520][760,600]" />
      </hierarchy>
    `);

    const match = findQuantizationSelectorNodeClearOfBottomOverlay(genericSelectorSnapshot);

    expect(match).toBeTruthy();
    expect(match.node.resourceId).toBe('model-variant-selector-deepseek-v4-gguf');
  });

  it('finds i-quant and float selector rows by the compact value text', () => {
    const compactSelectorSnapshot = parseUiSnapshot(`
      <hierarchy>
        <node text="" content-desc="" clickable="false" bounds="[0,0][1080,2400]" />
        <node text="IQ4_XS - 2.10 GB" content-desc="" clickable="true" bounds="[40,500][1040,590]" />
        <node text="F16 - unknown" content-desc="" clickable="true" bounds="[40,700][1040,790]" />
      </hierarchy>
    `);

    const match = findQuantizationSelectorNodeClearOfBottomOverlay(compactSelectorSnapshot);

    expect(match).toBeTruthy();
    expect(match.node.text).toBe('IQ4_XS - 2.10 GB');

    const f16SelectorSnapshot = parseUiSnapshot(`
      <hierarchy>
        <node text="" content-desc="" clickable="false" bounds="[0,0][1080,2400]" />
        <node text="F16 - unknown" content-desc="" clickable="true" bounds="[40,700][1040,790]" />
      </hierarchy>
    `);

    const f16Match = findQuantizationSelectorNodeClearOfBottomOverlay(f16SelectorSnapshot);

    expect(f16Match).toBeTruthy();
    expect(f16Match.node.text).toBe('F16 - unknown');
  });
});

describe('android-scenarios variant picker helpers', () => {
  it('does not tap catalog rows when the variant picker is already open', async () => {
    const tapBounds = jest.fn();
    const createUiSnapshot = jest.fn();
    const waitForAnyNode = jest.fn();

    await openFirstVisibleVariantPicker(
      {
        serial: 'emulator-5554',
        swipeUp: jest.fn(),
      },
      {
        resolveAdbPath: () => 'adb',
        findAnyNodeNow: jest.fn().mockResolvedValue({ label: 'Choose GGUF file' }),
        createUiSnapshot,
        tapBounds,
        waitForAnyNode,
      }
    );

    expect(createUiSnapshot).not.toHaveBeenCalled();
    expect(tapBounds).not.toHaveBeenCalled();
    expect(waitForAnyNode).not.toHaveBeenCalled();
  });

  it('uses a bounded title wait after tapping a quantization candidate', async () => {
    const ctx = {
      serial: 'emulator-5554',
      swipeUp: jest.fn(),
    };
    const tapBounds = jest.fn();
    const waitForAnyNode = jest.fn().mockResolvedValue({ label: 'Choose GGUF file' });

    await openFirstVisibleVariantPicker(ctx, {
      resolveAdbPath: () => 'adb',
      findAnyNodeNow: jest.fn().mockResolvedValue(null),
      createUiSnapshot: jest.fn(() => parseUiSnapshot(`
        <hierarchy>
          <node text="" content-desc="" clickable="false" bounds="[0,0][1080,2400]" />
          <node text="Q4_K_M - 3.80 GB" content-desc="" clickable="true" bounds="[40,500][1040,590]" />
        </hierarchy>
      `)),
      tapBounds,
      waitForAnyNode,
      waitAfterTapTimeoutMs: 123,
    });

    expect(tapBounds).toHaveBeenCalledWith(
      'adb',
      'emulator-5554',
      expect.objectContaining({ centerY: 545 })
    );
    expect(waitForAnyNode).toHaveBeenCalledWith(
      'adb',
      'emulator-5554',
      expect.arrayContaining(['Choose GGUF file']),
      { timeoutMs: 123, visibleOnly: true }
    );
    expect(ctx.swipeUp).not.toHaveBeenCalled();
  });

  it('waits for catalog loading to finish before scanning variant picker rows', async () => {
    const ctx = {
      serial: 'emulator-5554',
      swipeUp: jest.fn(),
    };
    const createUiSnapshot = jest.fn()
      .mockReturnValueOnce(parseUiSnapshot(`
        <hierarchy>
          <node text="" content-desc="" clickable="false" bounds="[0,0][1080,2400]" />
          <node text="Searching Hugging Face..." content-desc="" clickable="false" bounds="[40,500][1040,590]" />
        </hierarchy>
      `))
      .mockReturnValueOnce(parseUiSnapshot(`
        <hierarchy>
          <node text="" content-desc="" clickable="false" bounds="[0,0][1080,2400]" />
          <node text="Q4_K_M - 3.80 GB" content-desc="" clickable="true" bounds="[40,500][1040,590]" />
        </hierarchy>
      `))
      .mockReturnValueOnce(parseUiSnapshot(`
        <hierarchy>
          <node text="" content-desc="" clickable="false" bounds="[0,0][1080,2400]" />
          <node text="Q4_K_M - 3.80 GB" content-desc="" clickable="true" bounds="[40,500][1040,590]" />
        </hierarchy>
      `));
    const delayFn = jest.fn().mockResolvedValue(undefined);

    await openFirstVisibleVariantPicker(ctx, {
      resolveAdbPath: () => 'adb',
      findAnyNodeNow: jest.fn().mockResolvedValue(null),
      createUiSnapshot,
      tapBounds: jest.fn(),
      waitForAnyNode: jest.fn().mockResolvedValue({ label: 'Choose GGUF file' }),
      delayFn,
      catalogReadyPollIntervalMs: 1,
    });

    expect(delayFn).toHaveBeenCalledWith(1);
    expect(createUiSnapshot).toHaveBeenCalledTimes(3);
  });

  it('scrolls an open filter panel out of the way while looking for catalog variant rows', async () => {
    let rowsVisible = false;
    const ctx = {
      serial: 'emulator-5554',
      swipeUp: jest.fn(async () => {
        rowsVisible = true;
      }),
    };
    const createUiSnapshot = jest.fn(() => parseUiSnapshot(`
      <hierarchy>
        <node text="" content-desc="" clickable="false" bounds="[0,0][1080,2400]" />
        ${rowsVisible
          ? '<node text="Q4_K_M - 3.80 GB" content-desc="" clickable="true" bounds="[40,500][1040,590]" />'
          : '<node resource-id="models-filter-panel" text="" content-desc="" clickable="false" bounds="[40,220][1040,1200]" />'}
      </hierarchy>
    `));
    const tapBounds = jest.fn();

    await openFirstVisibleVariantPicker(ctx, {
      resolveAdbPath: () => 'adb',
      findAnyNodeNow: jest.fn().mockResolvedValue(null),
      createUiSnapshot,
      tapBounds,
      waitForAnyNode: jest.fn().mockResolvedValue({ label: 'Choose GGUF file' }),
      delayFn: jest.fn().mockResolvedValue(undefined),
      catalogReadyPollIntervalMs: 0,
    });

    expect(ctx.swipeUp).toHaveBeenCalledTimes(1);
    expect(tapBounds).toHaveBeenCalledWith(
      'adb',
      'emulator-5554',
      expect.objectContaining({ centerY: 545 })
    );
  });

  it('rethrows non-timeout errors from the post-tap picker title wait', async () => {
    const ctx = {
      serial: 'emulator-5554',
      swipeUp: jest.fn(),
    };
    const waitError = new Error('adb device offline');

    await expect(openFirstVisibleVariantPicker(ctx, {
      resolveAdbPath: () => 'adb',
      findAnyNodeNow: jest.fn().mockResolvedValue(null),
      createUiSnapshot: jest.fn(() => parseUiSnapshot(`
        <hierarchy>
          <node text="" content-desc="" clickable="false" bounds="[0,0][1080,2400]" />
          <node text="Q4_K_M - 3.80 GB" content-desc="" clickable="true" bounds="[40,500][1040,590]" />
        </hierarchy>
      `)),
      tapBounds: jest.fn(),
      waitForAnyNode: jest.fn().mockRejectedValue(waitError),
    })).rejects.toThrow('adb device offline');

    expect(ctx.swipeUp).not.toHaveBeenCalled();
  });

  it('normalizes catalog tab and filters before variant-picker smoke opens rows', async () => {
    const ctx = {
      serial: 'emulator-5554',
      tapAnyText: jest.fn().mockResolvedValue(undefined),
      expectAnyText: jest.fn().mockResolvedValue(undefined),
    };
    const findAnyNodeNow = jest.fn()
      .mockResolvedValueOnce({ node: { bounds: { centerX: 100, centerY: 100 } } });
    const setFilterPanelOpen = jest.fn().mockResolvedValue(undefined);
    const clearFilters = jest.fn().mockResolvedValue(undefined);

    await prepareCatalogForVariantPickerSmokeScenario(ctx, {
      resolveAdbPath: () => 'adb',
      findAnyNodeNow,
      setCatalogFilterPanelOpen: setFilterPanelOpen,
      clearCatalogFiltersIfPresent: clearFilters,
    });

    expect(ctx.tapAnyText).toHaveBeenNthCalledWith(
      1,
      expect.arrayContaining(['All Models']),
      expect.objectContaining({ timeoutMs: 5_000 })
    );
    expect(setFilterPanelOpen).toHaveBeenNthCalledWith(1, 'adb', 'emulator-5554', true);
    expect(clearFilters).toHaveBeenCalledWith('adb', 'emulator-5554');
    expect(setFilterPanelOpen).toHaveBeenCalledTimes(1);
    expect(ctx.tapAnyText).toHaveBeenCalledTimes(1);
    expect(ctx.expectAnyText).toHaveBeenCalledWith(expect.arrayContaining(['Model Catalog']), { timeoutMs: 8_000 });
  });
});

describe('android-scenarios UI hierarchy capture', () => {
  it('waits for the target serial when uiautomator temporarily loses adb', () => {
    const sleepSync = jest.fn();
    let dumpAttempts = 0;
    const spawn = jest.fn((_command, args) => {
      if (args.includes('wait-for-device')) {
        return {
          status: 0,
          stdout: '',
          stderr: '',
        };
      }

      if (args.includes('uiautomator')) {
        dumpAttempts += 1;
        return dumpAttempts === 1
          ? {
              status: 1,
              stdout: '',
              stderr: "error: device 'device-1' not found",
            }
          : {
              status: 0,
              stdout: 'UI hierchary dumped to: /sdcard/window_dump.xml',
              stderr: '',
            };
      }

      if (args.includes('cat')) {
        return {
          status: 0,
          stdout: '<hierarchy><node text="Pocket AI" bounds="[0,0][1,1]" /></hierarchy>',
          stderr: '',
        };
      }

      return {
        status: 0,
        stdout: '',
        stderr: '',
      };
    });

    const xml = dumpUiHierarchy('adb', 'device-1', {
      maxAttempts: 2,
      retryDelayMs: 1,
      sleepSync,
      spawnSync: spawn,
    });

    expect(xml).toContain('Pocket AI');
    expect(spawn).toHaveBeenCalledWith(
      'adb',
      ['-s', 'device-1', 'wait-for-device'],
      expect.objectContaining({ timeout: 15000 })
    );
    expect(spawn).toHaveBeenCalledWith(
      'adb',
      ['-s', 'device-1', 'shell', 'uiautomator', 'dump', '/sdcard/window_dump.xml'],
      expect.objectContaining({ timeout: 5000 })
    );
    expect(spawn).toHaveBeenCalledWith(
      'adb',
      ['-s', 'device-1', 'exec-out', 'cat', '/sdcard/window_dump.xml'],
      expect.objectContaining({ timeout: 5000 })
    );
    expect(sleepSync).toHaveBeenCalledWith(1);
  });

  it('retries when uiautomator dump times out before succeeding', () => {
    const sleepSync = jest.fn();
    let dumpAttempts = 0;
    const spawn = jest.fn((_command, args) => {
      if (args.includes('uiautomator')) {
        dumpAttempts += 1;
        return dumpAttempts === 1
          ? { error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) }
          : {
              status: 0,
              stdout: 'UI hierchary dumped to: /sdcard/window_dump.xml',
              stderr: '',
            };
      }

      if (args.includes('cat')) {
        return {
          status: 0,
          stdout: '<hierarchy><node text="Pocket AI" bounds="[0,0][1,1]" /></hierarchy>',
          stderr: '',
        };
      }

      return { status: 0, stdout: '', stderr: '' };
    });

    const xml = dumpUiHierarchy('adb', 'device-1', {
      maxAttempts: 2,
      retryDelayMs: 7,
      sleepSync,
      spawnSync: spawn,
    });

    expect(xml).toContain('Pocket AI');
    expect(dumpAttempts).toBe(2);
    expect(sleepSync).toHaveBeenCalledWith(7);
  });

  it('retries when UI hierarchy cat times out before succeeding', () => {
    const sleepSync = jest.fn();
    let catAttempts = 0;
    const spawn = jest.fn((_command, args) => {
      if (args.includes('uiautomator')) {
        return {
          status: 0,
          stdout: 'UI hierchary dumped to: /sdcard/window_dump.xml',
          stderr: '',
        };
      }

      if (args.includes('cat')) {
        catAttempts += 1;
        return catAttempts === 1
          ? { error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) }
          : {
              status: 0,
              stdout: '<hierarchy><node text="Pocket AI" bounds="[0,0][1,1]" /></hierarchy>',
              stderr: '',
            };
      }

      return { status: 0, stdout: '', stderr: '' };
    });

    const xml = dumpUiHierarchy('adb', 'device-1', {
      maxAttempts: 2,
      retryDelayMs: 3,
      sleepSync,
      spawnSync: spawn,
    });

    expect(xml).toContain('Pocket AI');
    expect(catAttempts).toBe(2);
    expect(sleepSync).toHaveBeenCalledWith(3);
  });

  it('summarizes exhausted UI hierarchy timeouts after bounded retries', () => {
    const sleepSync = jest.fn();
    const spawn = jest.fn((_command, args) => {
      if (args.includes('uiautomator')) {
        return { error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) };
      }

      return { status: 0, stdout: '', stderr: '' };
    });

    expect(() => dumpUiHierarchy('adb', 'device-1', {
      maxAttempts: 2,
      retryDelayMs: 5,
      sleepSync,
      spawnSync: spawn,
    })).toThrow(/ETIMEDOUT/);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(sleepSync).toHaveBeenCalledTimes(1);
  });
});

describe('android-scenarios catalog risk matching', () => {
  it('picks the details CTA closest to a visible RAM-risk badge', () => {
    const snapshot = parseUiSnapshot(`
      <hierarchy>
        <node text="" content-desc="" clickable="false" bounds="[0,0][1080,2400]" />
        <node text="RAM Warning" content-desc="" clickable="false" bounds="[40,500][260,560]" />
        <node text="Details" content-desc="" clickable="true" bounds="[820,500][1020,560]" />
        <node text="Details" content-desc="" clickable="true" bounds="[820,1200][1020,1260]" />
      </hierarchy>
    `);

    const card = findCatalogRiskModelCard('ignored', 'ignored', snapshot);

    expect(card).toBeTruthy();
    expect(card.detailsNode.bounds.centerY).toBe(530);
  });

  it('ignores catalog detail CTAs hidden under the floating tab bar', () => {
    const snapshot = parseUiSnapshot(`
      <hierarchy>
        <node text="" content-desc="" clickable="false" bounds="[0,0][1080,2400]" />
        <node text="RAM Warning" content-desc="" clickable="false" bounds="[40,500][260,560]" />
        <node text="Details" content-desc="" clickable="true" bounds="[820,2174][1020,2378]" />
      </hierarchy>
    `);

    expect(findCatalogRiskModelCard('ignored', 'ignored', snapshot)).toBeNull();
  });

  it('scores the closest node pair by vertical proximity first', () => {
    const pair = pickClosestNodePair(
      [{ bounds: { centerX: 100, centerY: 400 } }],
      [
        { bounds: { centerX: 900, centerY: 420 } },
        { bounds: { centerX: 900, centerY: 900 } },
      ]
    );

    expect(pair.targetNode.bounds.centerY).toBe(420);
  });
});

describe('android-scenarios CLI parsing', () => {
  it('parses the bootstrap screenshot flag', () => {
    expect(parseCliOptions(['--bootstrap-screenshot'])).toEqual(
      expect.objectContaining({
        bootstrapScreenshot: true,
      })
    );
  });

  it('defaults to the core scenario pack', () => {
    expect(parseCliOptions([])).toEqual(
      expect.objectContaining({
        pack: 'core',
      })
    );
  });

  it('parses the requested scenario pack', () => {
    expect(parseCliOptions(['--pack', 'all'])).toEqual(
      expect.objectContaining({
        pack: 'all',
      })
    );
  });

  it('does not expose optional scenarios as a named pack', () => {
    expect(() => parseCliOptions(['--pack', 'optional'])).toThrow('Unknown scenario pack "optional"');
  });
});

describe('android-scenarios pack selection', () => {
  const scenarios = buildScenarios();

  it('keeps the live-catalog variant picker smoke check targeted', () => {
    expect(scenarios).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'variant-picker-smoke',
          tier: 'optional',
        }),
      ])
    );
  });

  it('runs only core scenarios by default', () => {
    expect(selectScenarios(scenarios, parseCliOptions([])).map((scenario) => scenario.id)).toEqual([
      'home-smoke',
      'bottom-tabs',
      'new-chat-cta',
    ]);
  });

  it('taps the clickable upper portion of a bottom tab when a warning banner covers its center', () => {
    const tabSnapshot = parseUiSnapshot(`
      <hierarchy>
        <node text="" content-desc="" clickable="false" bounds="[0,0][1080,2400]" />
        <node text="Models" content-desc="" clickable="true" bounds="[50,200][350,320]" />
        <node text="" content-desc="icon, Models" clickable="true" bounds="[540,2142][810,2286]" />
        <node text="Models" content-desc="" clickable="false" bounds="[625,2250][724,2286]" />
        <node text="Open debugger to view warnings." content-desc="" clickable="true" bounds="[30,2194][1050,2337]" />
      </hierarchy>
    `);

    const match = findBottomTabNodeInSnapshot(tabSnapshot, ['Models']);
    const tapPoint = getBottomTabTapPoint(match.node);

    expect(match.node.clickable).toBe(true);
    expect(match.node.bounds.top).toBe(2142);
    expect(tapPoint).toEqual({ centerX: 675, centerY: 2174 });
    expect(tapPoint.centerY).toBeLessThan(2194);
  });

  it('uses stable route anchors in core navigation scenarios without scanning Settings content', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-ai-adb-'));
    const previousAndroidHome = process.env.ANDROID_HOME;
    const previousAndroidSdkRoot = process.env.ANDROID_SDK_ROOT;
    const adbDir = path.join(tempDir, 'platform-tools');
    const adbPath = path.join(adbDir, process.platform === 'win32' ? 'adb.exe' : 'adb');
    const homeHierarchyXml = `
      <hierarchy>
        <node text="" content-desc="" clickable="false" bounds="[0,0][1080,2400]" />
        <node text="Pocket AI" content-desc="" clickable="false" bounds="[20,40][420,120]" />
        <node text="Recent Conversations" content-desc="" clickable="false" bounds="[20,160][720,240]" />
        <node text="Theme Mode" content-desc="" clickable="true" bounds="[40,400][1040,520]" />
        <node text="Language" content-desc="" clickable="true" bounds="[40,600][1040,720]" />
        <node text="Storage Manager" content-desc="" clickable="true" bounds="[40,800][1040,920]" />
      </hierarchy>
    `;

    fs.mkdirSync(adbDir, { recursive: true });
    fs.writeFileSync(adbPath, '');
    process.env.ANDROID_HOME = tempDir;
    delete process.env.ANDROID_SDK_ROOT;

    try {
      const spawnSync = jest.fn((_command, args) => {
        if (args.includes('exec-out')) {
          return { status: 0, stdout: homeHierarchyXml, stderr: '' };
        }

        return { status: 0, stdout: '', stderr: '' };
      });
      let isolatedBuildScenarios;
      jest.isolateModules(() => {
        jest.doMock('child_process', () => ({ spawnSync }));
        ({ buildScenarios: isolatedBuildScenarios } = require('../../scripts/android-scenarios'));
      });

      const isolatedScenarios = isolatedBuildScenarios();
      const events = [];
      const newChatContext = {
        serial: 'device-1',
        ensureAppVisible: jest.fn().mockResolvedValue(undefined),
        dismissDebuggerBanner: jest.fn().mockResolvedValue(undefined),
        expectAnyText: jest.fn(async (labels) => {
          events.push(labels.includes('No messages yet') ? 'empty-copy' : 'text');
        }),
        expectResourceId: jest.fn(async () => {
          events.push('chat-viewport');
        }),
        tapAnyText: jest.fn().mockResolvedValue(undefined),
        tapBottomTab: jest.fn().mockResolvedValue(undefined),
      };

      await isolatedScenarios.find((scenario) => scenario.id === 'new-chat-cta').run(newChatContext);

      expect(newChatContext.expectResourceId).toHaveBeenCalledWith('chat-list-viewport', {
        timeoutMs: 120_000,
      });
      expect(newChatContext.expectAnyText).toHaveBeenCalledWith(
        expect.arrayContaining(['No messages yet']),
        { timeoutMs: 120_000 }
      );
      expect(events.indexOf('chat-viewport')).toBeLessThan(events.indexOf('empty-copy'));

      const dumpsBeforeBottomTabs = spawnSync.mock.calls.filter(([, args]) => args.includes('exec-out')).length;
      const bottomTabsContext = {
        serial: 'device-1',
        ensureAppVisible: jest.fn().mockResolvedValue(undefined),
        dismissDebuggerBanner: jest.fn().mockResolvedValue(undefined),
        expectAnyText: jest.fn().mockResolvedValue(undefined),
        tapBottomTab: jest.fn().mockResolvedValue(undefined),
        swipeDown: jest.fn().mockResolvedValue(undefined),
        swipeUp: jest.fn().mockResolvedValue(undefined),
      };

      await isolatedScenarios.find((scenario) => scenario.id === 'bottom-tabs').run(bottomTabsContext);

      const dumpsAfterBottomTabs = spawnSync.mock.calls.filter(([, args]) => args.includes('exec-out')).length;
      expect(dumpsAfterBottomTabs - dumpsBeforeBottomTabs).toBe(1);
      expect(bottomTabsContext.swipeDown).not.toHaveBeenCalled();
      expect(bottomTabsContext.swipeUp).not.toHaveBeenCalled();
    } finally {
      jest.dontMock('child_process');
      if (previousAndroidHome === undefined) {
        delete process.env.ANDROID_HOME;
      } else {
        process.env.ANDROID_HOME = previousAndroidHome;
      }
      if (previousAndroidSdkRoot === undefined) {
        delete process.env.ANDROID_SDK_ROOT;
      } else {
        process.env.ANDROID_SDK_ROOT = previousAndroidSdkRoot;
      }
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it('runs the variant picker smoke check from the catalog pack', () => {
    expect(selectScenarios(scenarios, parseCliOptions(['--pack', 'catalog'])).map((scenario) => scenario.id)).toEqual([
      'variant-picker-smoke',
    ]);
  });

  it('selects deterministic composer image attachment checks from the attachments pack', () => {
    expect(selectScenarios(scenarios, parseCliOptions(['--pack', 'attachments'])).map((scenario) => scenario.id)).toEqual([
      'chat-attachment-current-state-smoke',
    ]);
  });

  it('keeps loaded text-only fallback coverage in an explicit preconditioned pack', () => {
    expect(selectScenarios(scenarios, parseCliOptions(['--pack', 'attachments-preconditioned'])).map((scenario) => scenario.id)).toEqual([
      'chat-attachment-text-only-fallback',
    ]);
  });

  it('passes no-model current-state smoke without typing a fallback prompt', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-ai-adb-'));
    const previousAndroidHome = process.env.ANDROID_HOME;
    const previousAndroidSdkRoot = process.env.ANDROID_SDK_ROOT;
    const adbDir = path.join(tempDir, 'platform-tools');
    const adbPath = path.join(adbDir, process.platform === 'win32' ? 'adb.exe' : 'adb');
    const noModelClosedHierarchyXml = `
      <hierarchy>
        <node text="" content-desc="" clickable="false" enabled="true" bounds="[0,0][1080,2400]" />
        <node text="Pocket AI" content-desc="" clickable="false" enabled="true" bounds="[20,40][420,120]" />
        <node text="Recent Conversations" content-desc="" clickable="false" enabled="true" bounds="[20,160][720,240]" />
        <node text="Load a model to continue chatting" content-desc="" clickable="false" enabled="true" bounds="[40,500][1040,580]" />
        <node text="Download Model" content-desc="" clickable="true" enabled="true" bounds="[360,620][720,720]" />
        <node text="Choose and load a vision-capable model before attaching images." content-desc="" clickable="false" enabled="true" bounds="[40,1720][1040,1800]" />
        <node resource-id="chat-attach-menu-button" text="" content-desc="Attach file" clickable="true" enabled="true" bounds="[40,1840][180,1980]" />
        <node text="" content-desc="Chat message input" clickable="true" enabled="true" bounds="[200,1840][860,1980]" />
        <node text="" content-desc="Send message" clickable="true" enabled="false" bounds="[900,1840][1040,1980]" />
      </hierarchy>
    `;
    const noModelOpenHierarchyXml = `
      <hierarchy>
        <node text="" content-desc="" clickable="false" enabled="true" bounds="[0,0][1080,2400]" />
        <node text="Choose and load a vision-capable model before attaching images." content-desc="" clickable="false" enabled="true" bounds="[40,1720][1040,1800]" />
        <node resource-id="chat-attach-image-button" text="" content-desc="Attach an image from the photo library" clickable="false" enabled="false" bounds="[40,1480][1040,1620]" />
      </hierarchy>
    `;

    fs.mkdirSync(adbDir, { recursive: true });
    fs.writeFileSync(adbPath, '');
    process.env.ANDROID_HOME = tempDir;
    delete process.env.ANDROID_SDK_ROOT;

    try {
      let attachmentMenuOpened = false;
      const spawnSync = jest.fn((_command, args) => {
        if (args.includes('text')) {
          throw new Error('No-model smoke should not type a fallback prompt');
        }
        if (args.includes('tap')) {
          attachmentMenuOpened = true;
        }
        if (args.includes('keyevent') && args.includes('KEYCODE_BACK')) {
          attachmentMenuOpened = false;
        }
        if (args.includes('exec-out')) {
          return {
            status: 0,
            stdout: attachmentMenuOpened ? noModelOpenHierarchyXml : noModelClosedHierarchyXml,
            stderr: '',
          };
        }

        return { status: 0, stdout: '', stderr: '' };
      });
      let isolatedBuildScenarios;
      jest.isolateModules(() => {
        jest.doMock('child_process', () => ({ spawnSync }));
        ({ buildScenarios: isolatedBuildScenarios } = require('../../scripts/android-scenarios'));
      });

      const scenario = isolatedBuildScenarios().find((candidate) => candidate.id === 'chat-attachment-current-state-smoke');
      const tapAnyText = jest.fn().mockResolvedValue(undefined);
      const ctx = {
        serial: 'device-1',
        ensureAppVisible: jest.fn().mockResolvedValue(undefined),
        dismissDebuggerBanner: jest.fn().mockResolvedValue(undefined),
        expectAnyText: jest.fn().mockResolvedValue(undefined),
        tapAnyText,
        tapBottomTab: jest.fn().mockResolvedValue(undefined),
      };

      await scenario.run(ctx);

      expect(ctx.tapAnyText).toHaveBeenCalledWith(expect.arrayContaining(['New Chat']));
      expect(ctx.tapAnyText).not.toHaveBeenCalledWith(expect.arrayContaining(['Chat message input']), expect.anything());
      expect(ctx.tapAnyText).not.toHaveBeenCalledWith(expect.arrayContaining(['Send message']), expect.anything());
      expect(ctx.tapBottomTab).toHaveBeenCalledWith(expect.arrayContaining(['Home']));
    } finally {
      jest.dontMock('child_process');
      if (previousAndroidHome === undefined) {
        delete process.env.ANDROID_HOME;
      } else {
        process.env.ANDROID_HOME = previousAndroidHome;
      }
      if (previousAndroidSdkRoot === undefined) {
        delete process.env.ANDROID_SDK_ROOT;
      } else {
        process.env.ANDROID_SDK_ROOT = previousAndroidSdkRoot;
      }
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it('fails no-model current-state smoke when the attachment affordance is missing', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-ai-adb-'));
    const previousAndroidHome = process.env.ANDROID_HOME;
    const previousAndroidSdkRoot = process.env.ANDROID_SDK_ROOT;
    const adbDir = path.join(tempDir, 'platform-tools');
    const adbPath = path.join(adbDir, process.platform === 'win32' ? 'adb.exe' : 'adb');
    const noModelHierarchyXml = `
      <hierarchy>
        <node text="" content-desc="" clickable="false" enabled="true" bounds="[0,0][1080,2400]" />
        <node text="Load a model to continue chatting" content-desc="" clickable="false" enabled="true" bounds="[40,500][1040,580]" />
        <node text="Choose and load a vision-capable model before attaching images." content-desc="" clickable="false" enabled="true" bounds="[40,1720][1040,1800]" />
        <node text="" content-desc="Chat message input" clickable="true" enabled="true" bounds="[200,1840][860,1980]" />
      </hierarchy>
    `;

    fs.mkdirSync(adbDir, { recursive: true });
    fs.writeFileSync(adbPath, '');
    process.env.ANDROID_HOME = tempDir;
    delete process.env.ANDROID_SDK_ROOT;

    try {
      const spawnSync = jest.fn((_command, args) => {
        if (args.includes('exec-out')) {
          return {
            status: 0,
            stdout: noModelHierarchyXml,
            stderr: '',
          };
        }

        return { status: 0, stdout: '', stderr: '' };
      });
      let isolatedBuildScenarios;
      jest.isolateModules(() => {
        jest.doMock('child_process', () => ({ spawnSync }));
        ({ buildScenarios: isolatedBuildScenarios } = require('../../scripts/android-scenarios'));
      });

      const scenario = isolatedBuildScenarios().find((candidate) => candidate.id === 'chat-attachment-current-state-smoke');
      const ctx = {
        serial: 'device-1',
        ensureAppVisible: jest.fn().mockResolvedValue(undefined),
        dismissDebuggerBanner: jest.fn().mockResolvedValue(undefined),
        expectAnyText: jest.fn().mockResolvedValue(undefined),
        tapAnyText: jest.fn().mockResolvedValue(undefined),
        tapBottomTab: jest.fn().mockResolvedValue(undefined),
      };

      await expect(scenario.run(ctx)).rejects.toThrow(/no-model chat state/);
      expect(ctx.tapBottomTab).not.toHaveBeenCalled();
    } finally {
      jest.dontMock('child_process');
      if (previousAndroidHome === undefined) {
        delete process.env.ANDROID_HOME;
      } else {
        process.env.ANDROID_HOME = previousAndroidHome;
      }
      if (previousAndroidSdkRoot === undefined) {
        delete process.env.ANDROID_SDK_ROOT;
      } else {
        process.env.ANDROID_SDK_ROOT = previousAndroidSdkRoot;
      }
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it('sends a text prompt for current-state loaded fallback smoke', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-ai-adb-'));
    const previousAndroidHome = process.env.ANDROID_HOME;
    const previousAndroidSdkRoot = process.env.ANDROID_SDK_ROOT;
    const adbDir = path.join(tempDir, 'platform-tools');
    const adbPath = path.join(adbDir, process.platform === 'win32' ? 'adb.exe' : 'adb');
    const events = [];
    let prompt = null;
    let sendTapped = false;
    let attachmentMenuOpened = false;
    const textOnlyHierarchyXml = () => `
      <hierarchy>
        <node text="" content-desc="" clickable="false" enabled="true" bounds="[0,0][1080,2400]" />
        <node text="Pocket AI" content-desc="" clickable="false" enabled="true" bounds="[20,40][420,120]" />
        <node text="Recent Conversations" content-desc="" clickable="false" enabled="true" bounds="[20,160][720,240]" />
        <node text="Active model" content-desc="" clickable="false" enabled="true" bounds="[20,260][720,340]" />
        <node text="This model supports text chat only." content-desc="" clickable="false" enabled="true" bounds="[40,1720][1040,1800]" />
        <node resource-id="chat-attach-menu-button" text="" content-desc="Attach file" clickable="true" enabled="true" bounds="[40,1840][180,1980]" />
        <node text="${prompt || ''}" content-desc="Chat message input" clickable="true" enabled="true" bounds="[200,1840][860,1980]" />
        <node text="" content-desc="Send message" clickable="true" enabled="${prompt ? 'true' : 'false'}" bounds="[900,1840][1040,1980]" />
      </hierarchy>
    `;
    const textOnlyMenuHierarchyXml = () => `
      <hierarchy>
        <node text="" content-desc="" clickable="false" enabled="true" bounds="[0,0][1080,2400]" />
        <node text="This model supports text chat only." content-desc="" clickable="false" enabled="true" bounds="[40,1720][1040,1800]" />
        <node resource-id="chat-attach-image-button" text="" content-desc="Attach an image from the photo library" clickable="false" enabled="false" bounds="[40,1480][1040,1620]" />
      </hierarchy>
    `;
    const sentHierarchyXml = () => `
      <hierarchy>
        <node text="" content-desc="" clickable="false" enabled="true" bounds="[0,0][1080,2400]" />
        <node text="Pocket AI" content-desc="" clickable="false" enabled="true" bounds="[20,40][420,120]" />
        <node text="Recent Conversations" content-desc="" clickable="false" enabled="true" bounds="[20,160][720,240]" />
        <node text="${prompt || ''}" content-desc="" clickable="false" enabled="true" bounds="[40,1200][1040,1320]" />
        <node text="" content-desc="" resource-id="com.pocketai:id/assistant-message-state-complete-text-fallback" clickable="false" enabled="true" bounds="[40,1360][1040,1560]">
          <node text="" content-desc="" resource-id="com.pocketai:id/assistant-message-content-text-fallback" clickable="false" enabled="true" bounds="[40,1380][1040,1540]">
            <node text="Fallback text response is visible." content-desc="" clickable="false" enabled="true" bounds="[60,1400][1020,1520]" />
          </node>
        </node>
      </hierarchy>
    `;

    fs.mkdirSync(adbDir, { recursive: true });
    fs.writeFileSync(adbPath, '');
    process.env.ANDROID_HOME = tempDir;
    delete process.env.ANDROID_SDK_ROOT;

    try {
      const spawnSync = jest.fn((_command, args) => {
        if (args.includes('keycombination') && args.includes('KEYCODE_A')) {
          events.push('clear-select-all');
        }
        if (args.includes('keyevent') && args.includes('KEYCODE_DEL')) {
          events.push('clear-delete');
        }
        if (args.includes('text')) {
          prompt = args[args.length - 1].replace(/%s/g, ' ');
          events.push(`input-text:${prompt}`);
        }
        if (args.includes('tap')) {
          attachmentMenuOpened = true;
        }
        if (args.includes('keyevent') && args.includes('KEYCODE_BACK')) {
          attachmentMenuOpened = false;
        }
        if (args.includes('exec-out')) {
          return {
            status: 0,
            stdout: sendTapped
              ? sentHierarchyXml()
              : attachmentMenuOpened
                ? textOnlyMenuHierarchyXml()
                : textOnlyHierarchyXml(),
            stderr: '',
          };
        }

        return { status: 0, stdout: '', stderr: '' };
      });
      let isolatedBuildScenarios;
      jest.isolateModules(() => {
        jest.doMock('child_process', () => ({ spawnSync }));
        ({ buildScenarios: isolatedBuildScenarios } = require('../../scripts/android-scenarios'));
      });

      const scenario = isolatedBuildScenarios().find((candidate) => candidate.id === 'chat-attachment-current-state-smoke');
      const tapAnyText = jest.fn((labels) => {
        if (labels.includes('Chat message input')) {
          events.push('tap-input');
        }
        if (labels.includes('Send message')) {
          events.push('tap-send');
          sendTapped = true;
        }
        return Promise.resolve();
      });
      const ctx = {
        serial: 'device-1',
        ensureAppVisible: jest.fn().mockResolvedValue(undefined),
        dismissDebuggerBanner: jest.fn().mockResolvedValue(undefined),
        expectAnyText: jest.fn().mockResolvedValue(undefined),
        tapAnyText,
        tapBottomTab: jest.fn().mockResolvedValue(undefined),
      };

      await scenario.run(ctx);

      expect(prompt).toMatch(/^Text fallback smoke \d+ \d+$/);
      expect(prompt).not.toBe('Text fallback smoke');
      expect(ctx.tapAnyText).toHaveBeenCalledWith(expect.arrayContaining(['New Chat']));
      expect(events).toEqual(expect.arrayContaining([
        'tap-input',
        'clear-select-all',
        'clear-delete',
        `input-text:${prompt}`,
        'tap-send',
      ]));
      expect(ctx.tapBottomTab).toHaveBeenCalledWith(expect.arrayContaining(['Home']));
    } finally {
      jest.dontMock('child_process');
      if (previousAndroidHome === undefined) {
        delete process.env.ANDROID_HOME;
      } else {
        process.env.ANDROID_HOME = previousAndroidHome;
      }
      if (previousAndroidSdkRoot === undefined) {
        delete process.env.ANDROID_SDK_ROOT;
      } else {
        process.env.ANDROID_SDK_ROOT = previousAndroidSdkRoot;
      }
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it('runs the text-only attachment fallback scenario against a mocked ADB hierarchy', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-ai-adb-'));
    const previousAndroidHome = process.env.ANDROID_HOME;
    const previousAndroidSdkRoot = process.env.ANDROID_SDK_ROOT;
    const adbDir = path.join(tempDir, 'platform-tools');
    const adbPath = path.join(adbDir, process.platform === 'win32' ? 'adb.exe' : 'adb');
    let typedPrompt = '';
    let sendTapped = false;
    let attachmentMenuOpened = false;
    const textOnlyHierarchyXml = () => `
      <hierarchy>
        <node text="" content-desc="" clickable="false" enabled="true" bounds="[0,0][1080,2400]" />
        <node text="Pocket AI" content-desc="" clickable="false" enabled="true" bounds="[20,40][420,120]" />
        <node text="Recent Conversations" content-desc="" clickable="false" enabled="true" bounds="[20,160][720,240]" />
        <node text="Active model" content-desc="" clickable="false" enabled="true" bounds="[20,260][720,340]" />
        <node text="" content-desc="New Chat" clickable="true" enabled="true" bounds="[800,1600][1040,1720]" />
        <node text="This model supports text chat only." content-desc="" clickable="false" enabled="true" bounds="[40,1720][1040,1800]" />
        <node resource-id="chat-attach-menu-button" text="" content-desc="Attach file" clickable="true" enabled="true" bounds="[40,1840][180,1980]" />
        <node text="${typedPrompt}" content-desc="Chat message input" clickable="true" enabled="true" bounds="[200,1840][860,1980]" />
        <node text="" content-desc="Send message" clickable="true" enabled="true" bounds="[900,1840][1040,1980]" />
      </hierarchy>
    `;
    const textOnlyMenuHierarchyXml = () => `
      <hierarchy>
        <node text="" content-desc="" clickable="false" enabled="true" bounds="[0,0][1080,2400]" />
        <node text="This model supports text chat only." content-desc="" clickable="false" enabled="true" bounds="[40,1720][1040,1800]" />
        <node resource-id="chat-attach-image-button" text="" content-desc="Attach an image from the photo library" clickable="false" enabled="false" bounds="[40,1480][1040,1620]" />
      </hierarchy>
    `;
    const sentTextOnlyHierarchyXml = () => `
      <hierarchy>
        <node text="" content-desc="" clickable="false" enabled="true" bounds="[0,0][1080,2400]" />
        <node text="${typedPrompt}" content-desc="" clickable="false" enabled="true" bounds="[40,1200][1040,1320]" />
        <node text="" content-desc="" resource-id="com.pocketai:id/assistant-message-state-complete-text-only" clickable="false" enabled="true" bounds="[40,1330][1040,1540]">
          <node text="" content-desc="" resource-id="com.pocketai:id/assistant-message-content-text-only" clickable="false" enabled="true" bounds="[40,1340][1040,1520]">
            <node text="Text fallback assistant response" content-desc="" clickable="false" enabled="true" bounds="[60,1360][1020,1500]" />
          </node>
        </node>
        <node text="" content-desc="Chat message input" clickable="true" enabled="true" bounds="[200,1840][860,1980]" />
        <node text="" content-desc="Send message" clickable="true" enabled="false" bounds="[900,1840][1040,1980]" />
      </hierarchy>
    `;

    fs.mkdirSync(adbDir, { recursive: true });
    fs.writeFileSync(adbPath, '');
    process.env.ANDROID_HOME = tempDir;
    delete process.env.ANDROID_SDK_ROOT;

    try {
      const spawnSync = jest.fn((_command, args) => {
        if (args.includes('text')) {
          typedPrompt = args[args.length - 1].replace(/%s/g, ' ');
        }
        if (args.includes('tap')) {
          attachmentMenuOpened = true;
        }
        if (args.includes('keyevent') && args.includes('KEYCODE_BACK')) {
          attachmentMenuOpened = false;
        }
        if (args.includes('exec-out')) {
          return {
            status: 0,
            stdout: sendTapped
              ? sentTextOnlyHierarchyXml()
              : attachmentMenuOpened
                ? textOnlyMenuHierarchyXml()
                : textOnlyHierarchyXml(),
            stderr: '',
          };
        }

        return { status: 0, stdout: '', stderr: '' };
      });
      let isolatedBuildScenarios;
      jest.isolateModules(() => {
        jest.doMock('child_process', () => ({ spawnSync }));
        ({ buildScenarios: isolatedBuildScenarios } = require('../../scripts/android-scenarios'));
      });

      const scenario = isolatedBuildScenarios().find((candidate) => candidate.id === 'chat-attachment-text-only-fallback');
      const tapAnyText = jest.fn((labels) => {
        if (labels.includes('Send message')) {
          sendTapped = true;
        }
        return Promise.resolve();
      });
      const ctx = {
        serial: 'device-1',
        ensureAppVisible: jest.fn().mockResolvedValue(undefined),
        dismissDebuggerBanner: jest.fn().mockResolvedValue(undefined),
        expectAnyText: jest.fn().mockResolvedValue(undefined),
        tapAnyText,
        tapBottomTab: jest.fn().mockResolvedValue(undefined),
      };

      await scenario.run(ctx);

      expect(ctx.ensureAppVisible).toHaveBeenCalled();
      expect(ctx.tapAnyText).toHaveBeenCalledWith(expect.arrayContaining(['New Chat']));
      expect(ctx.tapAnyText).toHaveBeenCalledWith(expect.arrayContaining(['Chat message input']), expect.anything());
      expect(ctx.tapAnyText).toHaveBeenCalledWith(expect.arrayContaining(['Send message']), expect.anything());
      expect(typedPrompt).toMatch(/^Text fallback smoke \d+ \d+$/);
      expect(typedPrompt).not.toBe('Text fallback smoke');
      expect(ctx.tapBottomTab).toHaveBeenCalledWith(expect.arrayContaining(['Home']));
      expect(spawnSync).toHaveBeenCalledWith(
        adbPath,
        ['-s', 'device-1', 'exec-out', 'cat', '/sdcard/window_dump.xml'],
        expect.objectContaining({ timeout: 5_000 })
      );
    } finally {
      jest.dontMock('child_process');
      if (previousAndroidHome === undefined) {
        delete process.env.ANDROID_HOME;
      } else {
        process.env.ANDROID_HOME = previousAndroidHome;
      }
      if (previousAndroidSdkRoot === undefined) {
        delete process.env.ANDROID_SDK_ROOT;
      } else {
        process.env.ANDROID_SDK_ROOT = previousAndroidSdkRoot;
      }
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it('does not treat text still in the composer input as a sent fallback message', () => {
    const prompt = 'Text fallback smoke';
    const inputOnlySnapshot = parseUiSnapshot(`
      <hierarchy>
        <node text="" content-desc="" clickable="false" enabled="true" bounds="[0,0][1080,2400]" />
        <node text="${prompt}" content-desc="Chat message input" clickable="true" enabled="true" bounds="[200,1840][860,1980]" />
      </hierarchy>
    `);
    const sentSnapshot = parseUiSnapshot(`
      <hierarchy>
        <node text="" content-desc="" clickable="false" enabled="true" bounds="[0,0][1080,2400]" />
        <node text="${prompt}" content-desc="" clickable="false" enabled="true" bounds="[40,1200][1040,1320]" />
        <node text="" content-desc="Chat message input" clickable="true" enabled="true" bounds="[200,1840][860,1980]" />
      </hierarchy>
    `);

    expect(findTextOnlySentMessageNode(inputOnlySnapshot, prompt)).toBeNull();
    expect(findTextOnlySentMessageNode(sentSnapshot, prompt)).toEqual(expect.objectContaining({ text: prompt }));
  });

  it('keeps prepared image draft coverage in an explicit preserve-running-app pack', () => {
    expect(selectScenarios(scenarios, parseCliOptions(['--pack', 'attachments-prepared'])).map((scenario) => scenario.id)).toEqual([
      'chat-attachment-preview-remove',
    ]);
  });

  it('verifies prepared attachment preview/remove controls disappear after tapping remove', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-ai-adb-'));
    const previousAndroidHome = process.env.ANDROID_HOME;
    const previousAndroidSdkRoot = process.env.ANDROID_SDK_ROOT;
    const adbDir = path.join(tempDir, 'platform-tools');
    const adbPath = path.join(adbDir, process.platform === 'win32' ? 'adb.exe' : 'adb');
    const preparedDraftHierarchyXml = `
      <hierarchy>
        <node text="" content-desc="" clickable="false" bounds="[0,0][1080,2400]" />
        <node text="" content-desc="Attach an image from the photo library" clickable="true" enabled="true" bounds="[40,1800][180,1940]" />
        <node text="Attached image 1 of 1 preview" content-desc="" clickable="false" bounds="[40,500][1040,900]" />
        <node text="Remove attached image 1 of 1" content-desc="" clickable="true" enabled="true" bounds="[900,500][1040,640]" />
      </hierarchy>
    `;
    const previewRemovedHierarchyXml = `
      <hierarchy>
        <node text="" content-desc="" clickable="false" bounds="[0,0][1080,2400]" />
        <node text="" content-desc="Attach an image from the photo library" clickable="true" enabled="true" bounds="[40,1800][180,1940]" />
        <node text="Remove attached image 1 of 1" content-desc="" clickable="true" enabled="true" bounds="[900,500][1040,640]" />
      </hierarchy>
    `;
    const fullyRemovedDraftHierarchyXml = `
      <hierarchy>
        <node text="" content-desc="" clickable="false" bounds="[0,0][1080,2400]" />
        <node text="" content-desc="Attach an image from the photo library" clickable="true" enabled="true" bounds="[40,1800][180,1940]" />
      </hierarchy>
    `;

    fs.mkdirSync(adbDir, { recursive: true });
    fs.writeFileSync(adbPath, '');
    process.env.ANDROID_HOME = tempDir;
    delete process.env.ANDROID_SDK_ROOT;

    try {
      let removeTapped = false;
      let postRemoveHierarchyReads = 0;
      const postRemoveSnapshots = [];
      const spawnSync = jest.fn((command, args) => {
        if (args.includes('exec-out')) {
          let stdout = preparedDraftHierarchyXml;
          if (removeTapped) {
            postRemoveHierarchyReads += 1;
            stdout = postRemoveHierarchyReads === 1
              ? preparedDraftHierarchyXml
              : postRemoveHierarchyReads === 2
                ? previewRemovedHierarchyXml
                : fullyRemovedDraftHierarchyXml;
            postRemoveSnapshots.push({
              hasPreview: stdout.includes('Attached image 1 of 1 preview'),
              hasRemove: stdout.includes('Remove attached image 1 of 1'),
            });
          }

          return {
            status: 0,
            stdout,
            stderr: '',
          };
        }

        return { status: 0, stdout: '', stderr: '' };
      });
      let isolatedBuildScenarios;
      jest.isolateModules(() => {
        jest.doMock('child_process', () => ({ spawnSync }));
        ({ buildScenarios: isolatedBuildScenarios } = require('../../scripts/android-scenarios'));
      });

      const scenario = isolatedBuildScenarios().find((candidate) => candidate.id === 'chat-attachment-preview-remove');
      const expectAnyText = jest.fn().mockResolvedValue(undefined);
      const tapAnyText = jest.fn((labels) => {
        if (labels.includes('Remove attached image 1 of 1')) {
          removeTapped = true;
        }
        return Promise.resolve();
      });

      await scenario.run({
        serial: 'device-1',
        expectAnyText,
        tapAnyText,
      });

      expect(tapAnyText).toHaveBeenCalledWith(
        expect.arrayContaining(['Remove attached image 1 of 1']),
        expect.objectContaining({ timeoutMs: 5_000 })
      );
      expect(postRemoveSnapshots).toEqual([
        { hasPreview: true, hasRemove: true },
        { hasPreview: false, hasRemove: true },
        { hasPreview: false, hasRemove: false },
        { hasPreview: false, hasRemove: false },
      ]);
      expect(expectAnyText).not.toHaveBeenCalled();
    } finally {
      jest.dontMock('child_process');
      if (previousAndroidHome === undefined) {
        delete process.env.ANDROID_HOME;
      } else {
        process.env.ANDROID_HOME = previousAndroidHome;
      }
      if (previousAndroidSdkRoot === undefined) {
        delete process.env.ANDROID_SDK_ROOT;
      } else {
        process.env.ANDROID_SDK_ROOT = previousAndroidSdkRoot;
      }
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it('accepts prepared preview/remove preconditions when the add-image action is busy from the attachment limit', () => {
    expect(() => assertAttachmentPreviewRemovePreconditions({
      fallbackNode: null,
      attachNode: {
        node: {
          clickable: true,
          enabled: true,
          contentDesc: 'Attach an image from the photo library, busy',
        },
      },
      previewNode: { label: 'Attached image preview' },
      removeNode: { label: 'Remove image attachment' },
    })).not.toThrow();
  });

  it('fails prepared attachment preview/remove when post-remove attach action is not actionable', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-ai-adb-'));
    const previousAndroidHome = process.env.ANDROID_HOME;
    const previousAndroidSdkRoot = process.env.ANDROID_SDK_ROOT;
    const adbDir = path.join(tempDir, 'platform-tools');
    const adbPath = path.join(adbDir, process.platform === 'win32' ? 'adb.exe' : 'adb');
    const preparedDraftHierarchyXml = `
      <hierarchy>
        <node text="" content-desc="" clickable="false" bounds="[0,0][1080,2400]" />
        <node text="" content-desc="Attach an image from the photo library, busy" clickable="true" enabled="true" bounds="[40,1800][180,1940]" />
        <node text="Attached image 1 of 1 preview" content-desc="" clickable="false" bounds="[40,500][1040,900]" />
        <node text="Remove attached image 1 of 1" content-desc="" clickable="true" enabled="true" bounds="[900,500][1040,640]" />
      </hierarchy>
    `;
    const disabledRemovedDraftHierarchyXml = `
      <hierarchy>
        <node text="" content-desc="" clickable="false" bounds="[0,0][1080,2400]" />
        <node text="" content-desc="Attach an image from the photo library" clickable="false" enabled="false" bounds="[40,1800][180,1940]" />
      </hierarchy>
    `;

    fs.mkdirSync(adbDir, { recursive: true });
    fs.writeFileSync(adbPath, '');
    process.env.ANDROID_HOME = tempDir;
    delete process.env.ANDROID_SDK_ROOT;

    try {
      let removeTapped = false;
      const spawnSync = jest.fn((_command, args) => {
        if (args.includes('exec-out')) {
          return {
            status: 0,
            stdout: removeTapped ? disabledRemovedDraftHierarchyXml : preparedDraftHierarchyXml,
            stderr: '',
          };
        }

        return { status: 0, stdout: '', stderr: '' };
      });
      let isolatedBuildScenarios;
      jest.isolateModules(() => {
        jest.doMock('child_process', () => ({ spawnSync }));
        ({ buildScenarios: isolatedBuildScenarios } = require('../../scripts/android-scenarios'));
      });

      const scenario = isolatedBuildScenarios().find((candidate) => candidate.id === 'chat-attachment-preview-remove');
      const tapAnyText = jest.fn((labels) => {
        if (labels.includes('Remove attached image 1 of 1')) {
          removeTapped = true;
        }
        return Promise.resolve();
      });

      await expect(scenario.run({
        serial: 'device-1',
        expectAnyText: jest.fn().mockResolvedValue(undefined),
        tapAnyText,
      })).rejects.toThrow(/disabled|not actionable/);
    } finally {
      jest.dontMock('child_process');
      if (previousAndroidHome === undefined) {
        delete process.env.ANDROID_HOME;
      } else {
        process.env.ANDROID_HOME = previousAndroidHome;
      }
      if (previousAndroidSdkRoot === undefined) {
        delete process.env.ANDROID_SDK_ROOT;
      } else {
        process.env.ANDROID_SDK_ROOT = previousAndroidSdkRoot;
      }
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it('keeps prepared image send coverage in a separate preserve-running-app pack', () => {
    expect(selectScenarios(scenarios, parseCliOptions(['--pack', 'attachments-prepared-send'])).map((scenario) => scenario.id)).toEqual([
      'chat-attachment-prepared-send',
    ]);
  });

  it('bounds prepared send adb text input', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-ai-adb-'));
    const previousAndroidHome = process.env.ANDROID_HOME;
    const previousAndroidSdkRoot = process.env.ANDROID_SDK_ROOT;
    const adbDir = path.join(tempDir, 'platform-tools');
    const adbPath = path.join(adbDir, process.platform === 'win32' ? 'adb.exe' : 'adb');
    const preparedDraftHierarchyXml = `
      <hierarchy>
        <node text="" content-desc="" clickable="false" bounds="[0,0][1080,2400]" />
        <node text="" content-desc="Attach an image from the photo library" clickable="true" enabled="true" bounds="[40,1800][180,1940]" />
        <node text="Attached image 1 of 1 preview" content-desc="" clickable="false" bounds="[40,500][1040,900]" />
        <node text="Remove attached image 1 of 1" content-desc="" clickable="true" bounds="[900,500][1040,640]" />
        <node text="Chat message input" content-desc="" clickable="true" bounds="[40,1900][900,2050]" />
        <node text="" content-desc="Send message" clickable="true" enabled="true" bounds="[920,2050][1040,2170]" />
      </hierarchy>
    `;

    fs.mkdirSync(adbDir, { recursive: true });
    fs.writeFileSync(adbPath, '');
    process.env.ANDROID_HOME = tempDir;
    delete process.env.ANDROID_SDK_ROOT;

    try {
      let hierarchyReads = 0;
      let preparedPrompt = null;
      let sendTapped = false;
      const events = [];
      const spawnSync = jest.fn((command, args) => {
        if (args.includes('keycombination') && args.includes('KEYCODE_A')) {
          events.push('clear-select-all');
        }
        if (args.includes('keyevent') && args.includes('KEYCODE_DEL')) {
          events.push('clear-delete');
        }
        if (args.includes('text')) {
          const escapedPrompt = args[args.length - 1];
          preparedPrompt = escapedPrompt.replace(/%s/g, ' ');
          events.push(`input-text:${preparedPrompt}`);
        }
        if (args.includes('exec-out')) {
          hierarchyReads += 1;
          const composerHierarchyXml = `
            <hierarchy>
              <node text="" content-desc="" clickable="false" bounds="[0,0][1080,2400]" />
              <node text="" content-desc="Attach an image from the photo library, busy" clickable="true" enabled="true" bounds="[40,1800][180,1940]" />
              <node text="Attached image 1 of 1 preview" content-desc="" clickable="false" bounds="[40,500][1040,900]" />
              <node text="Remove attached image 1 of 1" content-desc="" clickable="true" bounds="[900,500][1040,640]" />
              <node text="${preparedPrompt || ''}" content-desc="Chat message input" clickable="true" bounds="[40,1900][900,2050]" />
              <node text="" content-desc="Send message" clickable="true" enabled="true" bounds="[920,2050][1040,2170]" />
            </hierarchy>
          `;
          const sentMessageHierarchyXml = `
            <hierarchy>
              <node text="" content-desc="" clickable="false" bounds="[0,0][1080,2400]" />
              <node text="Message image 1 of 1 preview" content-desc="" clickable="false" bounds="[40,120][1040,520]" />
              <node text="Message image 1 of 1 preview" content-desc="" clickable="false" bounds="[40,820][1040,1180]" />
              <node text="${preparedPrompt || ''}" content-desc="" clickable="false" bounds="[40,1200][1040,1320]" />
              <node text="" content-desc="" resource-id="com.pocketai:id/assistant-message-state-complete-prepared" clickable="false" bounds="[40,1360][1040,1560]">
                <node text="" content-desc="" resource-id="com.pocketai:id/assistant-message-content-prepared" clickable="false" bounds="[40,1380][1040,1540]">
                  <node text="The prepared image response is visible." content-desc="" clickable="false" bounds="[60,1400][1020,1520]" />
                </node>
              </node>
            </hierarchy>
          `;
          return {
            status: 0,
            stdout: sendTapped ? sentMessageHierarchyXml : (preparedPrompt ? composerHierarchyXml : preparedDraftHierarchyXml),
            stderr: '',
          };
        }

        return { status: 0, stdout: '', stderr: '' };
      });
      let isolatedBuildScenarios;
      jest.isolateModules(() => {
        jest.doMock('child_process', () => ({ spawnSync }));
        ({ buildScenarios: isolatedBuildScenarios } = require('../../scripts/android-scenarios'));
      });

      const scenario = isolatedBuildScenarios().find((candidate) => candidate.id === 'chat-attachment-prepared-send');
      const expectAnyText = jest.fn().mockResolvedValue(undefined);
      const tapAnyText = jest.fn((labels) => {
        if (labels.includes('Chat message input')) {
          events.push('tap-input');
        }
        if (labels.includes('Send message')) {
          events.push('tap-send');
          sendTapped = true;
        }
        return Promise.resolve();
      });
      await scenario.run({
        serial: 'device-1',
        expectAnyText,
        tapAnyText,
      });

      expect(preparedPrompt).toMatch(
        /^Read the exact text in the image and reply with the words you see ignore test id qa[a-z0-9]{10}$/,
      );
      expect(spawnSync).toHaveBeenCalledWith(
        adbPath,
        ['-s', 'device-1', 'shell', 'input', 'text', escapeAdbInputText(preparedPrompt)],
        expect.objectContaining({ timeout: 5_000 })
      );
      expect(events).toEqual(expect.arrayContaining([
        'tap-input',
        'clear-select-all',
        'clear-delete',
        expect.stringMatching(
          /^input-text:Read the exact text in the image and reply with the words you see ignore test id qa[a-z0-9]{10}$/,
        ),
        'tap-send',
      ]));
      expect(events.indexOf('tap-input')).toBeLessThan(events.indexOf('clear-select-all'));
      expect(events.indexOf('clear-select-all')).toBeLessThan(events.indexOf('clear-delete'));
      expect(events.indexOf('clear-delete')).toBeLessThan(events.findIndex((event) => event.startsWith('input-text:')));
      expect(events.findIndex((event) => event.startsWith('input-text:'))).toBeLessThan(events.indexOf('tap-send'));
      expect(tapAnyText).toHaveBeenCalledWith(
        expect.arrayContaining(['Send message']),
        expect.objectContaining({ afterTapDelayMs: 1_500 })
      );
      expect(expectAnyText).toHaveBeenCalledWith(
        [preparedPrompt],
        expect.objectContaining({ timeoutMs: 10_000 })
      );
      expect(expectAnyText).not.toHaveBeenCalledWith(
        ['Read the exact text in the image and reply with the words you see ignore test id'],
        expect.anything(),
      );
      expect(hierarchyReads).toBeGreaterThanOrEqual(6);
    } finally {
      jest.dontMock('child_process');
      if (previousAndroidHome === undefined) {
        delete process.env.ANDROID_HOME;
      } else {
        process.env.ANDROID_HOME = previousAndroidHome;
      }
      if (previousAndroidSdkRoot === undefined) {
        delete process.env.ANDROID_SDK_ROOT;
      } else {
        process.env.ANDROID_SDK_ROOT = previousAndroidSdkRoot;
      }
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it('does not treat generic status or error labels as a prepared assistant response', () => {
    expect(isPreparedAssistantResponseLabel('Thinking...', 'Describe prepared image 123')).toBe(false);
    expect(isPreparedAssistantResponseLabel('Response failed', 'Describe prepared image 123')).toBe(false);
    expect(isPreparedAssistantResponseLabel('Vision chat is not ready for image attachments.', 'Describe prepared image 123')).toBe(false);
    expect(isPreparedAssistantResponseLabel('Load a local model before continuing.', 'Describe prepared image 123')).toBe(false);
    expect(isPreparedAssistantResponseLabel('The current model is unloading. Wait a moment and try again.', 'Describe prepared image 123')).toBe(false);
    expect(isPreparedAssistantResponseLabel('Engine not ready', 'Describe prepared image 123')).toBe(false);
    expect(isPreparedAssistantResponseLabel('Загрузите локальную модель, прежде чем продолжить.', 'Describe prepared image 123')).toBe(false);
    expect(isPreparedAssistantResponseLabel('12969972853', 'Describe prepared image 123')).toBe(false);
    expect(isPreparedAssistantResponseLabel('123.45', 'Describe prepared image 123')).toBe(false);
    expect(isPreparedAssistantResponseLabel('OK', 'Describe prepared image 123')).toBe(false);
    expect(isPreparedAssistantResponseLabel('Native runtime aborted unexpectedly', 'Describe prepared image 123')).toBe(true);
    expect(isPreparedAssistantResponseLabel('The photo shows a small red car.', 'Describe prepared image 123')).toBe(true);

    const prompt = 'Describe prepared image 123';
    const sentContext = {
      promptMatch: { node: { bounds: { bottom: 1320 } } },
      messagePreviewMatch: { node: { bounds: { bottom: 1180 } } },
    };
    const statusOnlySnapshot = parseUiSnapshot(`
      <hierarchy>
        <node text="" content-desc="" clickable="false" bounds="[0,0][1080,2400]" />
        <node text="${prompt}" content-desc="" clickable="false" bounds="[40,1200][1040,1320]" />
        <node text="Thinking..." content-desc="" clickable="false" bounds="[40,1400][1040,1520]" />
      </hierarchy>
    `);
    const answerSnapshot = parseUiSnapshot(`
      <hierarchy>
        <node text="" content-desc="" clickable="false" bounds="[0,0][1080,2400]" />
        <node text="${prompt}" content-desc="" clickable="false" bounds="[40,1200][1040,1320]" />
        <node text="" content-desc="" resource-id="com.pocketai:id/assistant-message-state-complete-assistant-1" clickable="false" bounds="[40,1360][1040,1560]">
          <node text="" content-desc="" resource-id="com.pocketai:id/assistant-message-content-assistant-1" clickable="false" bounds="[40,1380][1040,1540]">
            <node text="The photo shows a small red car." content-desc="" clickable="false" bounds="[60,1400][1020,1520]" />
          </node>
        </node>
      </hierarchy>
    `);
    const streamingAnswerSnapshot = parseUiSnapshot(`
      <hierarchy>
        <node text="" content-desc="" clickable="false" bounds="[0,0][1080,2400]" />
        <node text="${prompt}" content-desc="" clickable="false" bounds="[40,1200][1040,1320]" />
        <node text="" content-desc="" resource-id="com.pocketai:id/assistant-message-state-streaming-assistant-1" clickable="false" bounds="[40,1360][1040,1560]">
          <node text="" content-desc="" resource-id="com.pocketai:id/assistant-message-content-assistant-1" clickable="false" bounds="[40,1380][1040,1540]">
            <node text="Read" content-desc="" clickable="false" bounds="[60,1400][1020,1520]" />
          </node>
        </node>
      </hierarchy>
    `);
    const unanchoredUnknownErrorSnapshot = parseUiSnapshot(`
      <hierarchy>
        <node text="" content-desc="" clickable="false" bounds="[0,0][1080,2400]" />
        <node text="${prompt}" content-desc="" clickable="false" bounds="[40,1200][1040,1320]" />
        <node text="Native runtime aborted unexpectedly" content-desc="" clickable="false" bounds="[40,1400][1040,1520]" />
      </hierarchy>
    `);
    const clickableChromeSnapshot = parseUiSnapshot(`
      <hierarchy>
        <node text="" content-desc="" clickable="false" bounds="[0,0][1080,2400]" />
        <node text="${prompt}" content-desc="" clickable="false" bounds="[40,1200][1040,1320]" />
        <node text="The photo shows a small red car." content-desc="" class="android.widget.Button" resource-id="com.pocketai:id/bottom_navigation" clickable="true" bounds="[40,1400][1040,1520]" />
      </hierarchy>
    `);
    const tabChromeSnapshot = parseUiSnapshot(`
      <hierarchy>
        <node text="" content-desc="" clickable="false" bounds="[0,0][1080,2400]" />
        <node text="${prompt}" content-desc="" clickable="false" bounds="[40,1200][1040,1320]" />
        <node text="" content-desc="Models, tab, 3 of 4" clickable="false" bounds="[40,1400][1040,1520]" />
      </hierarchy>
    `);
    const errorOnlySnapshot = parseUiSnapshot(`
      <hierarchy>
        <node text="" content-desc="" clickable="false" bounds="[0,0][1080,2400]" />
        <node text="${prompt}" content-desc="" clickable="false" bounds="[40,1200][1040,1320]" />
        <node text="Load a local model before continuing." content-desc="" clickable="false" bounds="[40,1400][1040,1520]" />
      </hierarchy>
    `);

    expect(findPreparedAssistantResponseNode(statusOnlySnapshot, sentContext, prompt)).toBeNull();
    expect(findPreparedAssistantResponseNode(clickableChromeSnapshot, sentContext, prompt)).toBeNull();
    expect(findPreparedAssistantResponseNode(tabChromeSnapshot, sentContext, prompt)).toBeNull();
    expect(findPreparedAssistantResponseNode(errorOnlySnapshot, sentContext, prompt)).toBeNull();
    expect(findPreparedAssistantResponseNode(unanchoredUnknownErrorSnapshot, sentContext, prompt)).toBeNull();
    expect(findPreparedAssistantResponseNode(streamingAnswerSnapshot, sentContext, prompt)).toBeNull();
    expect(findPreparedAssistantResponseNode(answerSnapshot, sentContext, prompt)).toEqual(expect.objectContaining({
      text: 'The photo shows a small red car.',
    }));
  });

  it('keeps the real cache-clear verifier in an explicit state-mutating pack', () => {
    expect(selectScenarios(scenarios, parseCliOptions(['--pack', 'storage'])).map((scenario) => scenario.id)).toEqual([
      'storage-cache-clear',
    ]);
  });

  it('builds a natural prepared vision prompt with a short unique id', () => {
    const prompt = buildPreparedAttachmentSendPrompt();

    expect(prompt).toMatch(
      /^Read the exact text in the image and reply with the words you see ignore test id qa[a-z0-9]{10}$/,
    );
    expect(prompt).not.toMatch(/\b\d{7,}\b/);
  });

  it('signals unmet prepared attachment preview/remove preconditions as skips', () => {
    expect(() => assertAttachmentPreviewRemovePreconditions({
      fallbackNode: { label: 'Text-only fallback' },
      previewNode: null,
      removeNode: null,
    })).toThrow(ScenarioSkipError);
    expect(() => assertAttachmentPreviewRemovePreconditions({
      fallbackNode: { label: 'Text-only fallback' },
      previewNode: null,
      removeNode: null,
    })).toThrow(/preserve-running-app/);

    expect(() => assertAttachmentPreviewRemovePreconditions({
      fallbackNode: null,
      previewNode: { label: 'Attached image preview' },
      removeNode: null,
    })).toThrow(ScenarioSkipError);
    expect(() => assertAttachmentPreviewRemovePreconditions({
      fallbackNode: null,
      previewNode: { label: 'Attached image preview' },
      removeNode: null,
    })).toThrow(/missing remove attached image action/);

    expect(() => assertAttachmentPreviewRemovePreconditions({
      fallbackNode: null,
      previewNode: null,
      removeNode: { label: 'Remove image attachment' },
    })).toThrow(ScenarioSkipError);
    expect(() => assertAttachmentPreviewRemovePreconditions({
      fallbackNode: null,
      previewNode: null,
      removeNode: { label: 'Remove image attachment' },
    })).toThrow(/missing attached image preview/);

    expect(() => assertAttachmentPreviewRemovePreconditions({
      fallbackNode: null,
      attachNode: { clickable: true, enabled: true },
      previewNode: { label: 'Attached image preview' },
      removeNode: { label: 'Remove image attachment' },
    })).not.toThrow();
    expect(() => assertAttachmentPreviewRemovePreconditions({
      fallbackNode: null,
      attachNode: { clickable: true, enabled: false },
      previewNode: { label: 'Attached image preview' },
      removeNode: { label: 'Remove image attachment' },
    })).not.toThrow();
  });

  it('requires known fallback copy and a blocked affordance for text-only attachment smoke', () => {
    expect(() => assertAttachmentTextOnlyFallbackState({
      fallbackNode: { label: 'This model supports text chat only.' },
      attachNode: { clickable: true, enabled: false },
    })).not.toThrow();

    expect(() => assertAttachmentTextOnlyFallbackState({
      fallbackNode: null,
      attachNode: { clickable: true, enabled: false },
    })).toThrow(ScenarioSkipError);
    expect(() => assertAttachmentTextOnlyFallbackState({
      fallbackNode: null,
      attachNode: { clickable: true, enabled: false },
    })).toThrow(/prepare a loaded text-only model/);

    expect(() => assertAttachmentTextOnlyFallbackState({
      fallbackNode: { label: 'This model supports text chat only.' },
      attachNode: { clickable: true, enabled: true },
    })).toThrow(/still enabled/);
  });

  it('asserts text-only attachment affordances are blocked', () => {
    expect(() => assertAttachmentActionBlocked({ clickable: false, enabled: false })).not.toThrow();
    expect(() => assertAttachmentActionBlocked({ clickable: true, enabled: false })).not.toThrow();
    expect(() => assertAttachmentActionBlocked({ clickable: true, enabled: true })).toThrow(
      /still enabled/
    );
  });

  it('asserts matched text-only attachment affordance wrappers are blocked', () => {
    const blockedMatch = findAnyNodeInSnapshot(parseUiSnapshot(`
      <hierarchy>
        <node text="" content-desc="Attach an image from the photo library" clickable="true" enabled="false" bounds="[10,20][210,120]" />
      </hierarchy>
    `), ['Attach an image from the photo library'], { visibleOnly: true });
    const enabledMatch = findAnyNodeInSnapshot(parseUiSnapshot(`
      <hierarchy>
        <node text="" content-desc="Attach an image from the photo library" clickable="true" enabled="true" bounds="[10,20][210,120]" />
      </hierarchy>
    `), ['Attach an image from the photo library'], { visibleOnly: true });

    expect(blockedMatch).toEqual(expect.objectContaining({
      label: 'Attach an image from the photo library',
      node: expect.objectContaining({ enabled: false }),
    }));
    expect(() => assertAttachmentActionBlocked(blockedMatch)).not.toThrow();

    expect(() => assertAttachmentActionBlocked(enabledMatch)).toThrow(/still enabled/);
  });

  it('asserts vision-ready attachment affordances are visible and enabled', () => {
    expect(() => assertAttachmentActionAvailable({ clickable: true, enabled: true })).not.toThrow();
    expect(() => assertAttachmentActionAvailable({ clickable: false, enabled: true })).toThrow(
      /not actionable/
    );
    expect(() => assertAttachmentActionAvailable({ clickable: true, enabled: false })).toThrow(
      /disabled/
    );
    expect(() => assertAttachmentActionAvailable(null)).toThrow(/not visible/);
  });

  it('includes stable secondary scenarios in the extended pack without live catalog smoke', () => {
    const selectedIds = selectScenarios(scenarios, parseCliOptions(['--pack', 'extended'])).map((scenario) => scenario.id);

    expect(selectedIds).toEqual([
      'home-smoke',
      'bottom-tabs',
      'new-chat-cta',
      'swap-model-cta',
      'hf-token-education',
      'conversations-management',
    ]);
    expect(selectedIds).not.toContain('variant-picker-smoke');
  });

  it('uses the stable secondary surface for native dependency checks', () => {
    expect(selectScenarios(scenarios, parseCliOptions(['--pack', 'native'])).map((scenario) => scenario.id)).toEqual([
      'home-smoke',
      'bottom-tabs',
      'new-chat-cta',
      'swap-model-cta',
      'hf-token-education',
      'conversations-management',
    ]);
  });

  it('selects styling-focused screenshots for dependency-ui checks', () => {
    expect(selectScenarios(scenarios, parseCliOptions(['--pack', 'dependency-ui'])).map((scenario) => scenario.id)).toEqual([
      'home-smoke',
      'bottom-tabs',
      'new-chat-cta',
      'style-screenshots',
    ]);
  });

  it('selects language switching for runtime dependency checks', () => {
    expect(selectScenarios(scenarios, parseCliOptions(['--pack', 'runtime'])).map((scenario) => scenario.id)).toEqual([
      'home-smoke',
      'bottom-tabs',
      'new-chat-cta',
      'language-switch',
      'conversations-management',
    ]);
  });

  it('keeps direct scenario selection working for optional checks', () => {
    expect(selectScenarios(scenarios, parseCliOptions(['--scenario', 'memory-fit-download-warning'])).map((scenario) => scenario.id)).toEqual([
      'memory-fit-download-warning',
    ]);
  });

  it('keeps direct scenario selection working for the variant picker smoke check', () => {
    expect(selectScenarios(scenarios, parseCliOptions(['--scenario', 'variant-picker-smoke'])).map((scenario) => scenario.id)).toEqual([
      'variant-picker-smoke',
    ]);
  });

  it('broadens the default mobile Android verifier to the fail-closed runtime pack', () => {
    const packageScripts = require('../../package.json').scripts;
    const androidVerifier = packageScripts['verify:mobile-change:android'];

    expect(androidVerifier).toContain('verify:mobile-change');
    expect(androidVerifier).toContain('android:scenarios:runtime');
    expect(androidVerifier).not.toMatch(/android:scenarios(?:\s|$)/);
    expect(packageScripts['android:scenarios:runtime']).toContain('--fail-on-skip');
    expect(packageScripts['android:scenarios:branch-regeneration']).toContain('--apk-variant release');
  });

  it('selects the destructive branch-regeneration pack in its exact 15-step order', () => {
    const selected = selectScenarios(
      scenarios,
      parseCliOptions(['--pack', 'branch-regeneration', '--fail-on-skip'])
    );

    expect(selected.map((scenario) => scenario.id)).toEqual(BRANCH_REGENERATION_SCENARIOS);
    expect(selected.map((scenario) => scenario.step)).toEqual(
      Array.from({ length: 15 }, (_, index) => index + 1)
    );
    expect(selected.every((scenario) => (
      scenario.tier === 'critical'
      && scenario.captureFullEvidence
      && scenario.requiresCurrentHeadProvenance
    ))).toBe(true);
    expect(selected.filter((scenario) => scenario.expectedJsSurface === 'stopped').map((scenario) => scenario.step)).toEqual([3, 5]);
  });

  it('runs broad non-prepared scenarios only for the all pack', () => {
    const selectedIds = selectScenarios(scenarios, parseCliOptions(['--pack', 'all'])).map((scenario) => scenario.id);

    expect(selectedIds).toEqual(scenarios
      .map((scenario) => scenario.id)
      .filter((scenarioId) => ![
        'chat-attachment-preview-remove',
        'chat-attachment-prepared-send',
        'storage-cache-clear',
        ...BRANCH_REGENERATION_SCENARIOS,
      ].includes(scenarioId)));
    expect(selectedIds).toEqual(
      expect.arrayContaining([
        'variant-picker-smoke',
        'chat-attachment-current-state-smoke',
        'chat-attachment-text-only-fallback',
        'hf-catalog-hardening',
        'memory-fit-badges',
        'memory-fit-download-warning',
        'performance-logcat',
      ])
    );
    expect(selectedIds).not.toContain('chat-attachment-preview-remove');
    expect(selectedIds).not.toContain('chat-attachment-prepared-send');
    expect(selectedIds).not.toContain('storage-cache-clear');
    expect(selectedIds).not.toEqual(expect.arrayContaining(BRANCH_REGENERATION_SCENARIOS));
  });
});

describe('android-scenarios branch-regeneration fixture contract', () => {
  function buildFixtureSnapshot({ includeAudio = true, includeDocument = true } = {}) {
    let top = 80;
    const nodes = [
      '<node resource-id="" package="com.github.tah10n.pocketai" bounds="[0,0][1080,2400]" />',
    ];
    const add = (resourceId, offset = 0) => {
      nodes.push(
        `<node resource-id="com.github.tah10n.pocketai:id/${resourceId}" package="com.github.tah10n.pocketai" enabled="true" clickable="true" bounds="[40,${top + offset}][1040,${top + offset + 70}]" />`
      );
    };
    const addTurn = (kind, userId, assistantId, { thought = false } = {}) => {
      add(`user-message-state-complete-${userId}`);
      if (kind) {
        add(`message-attachment-${kind}-${userId}-attachment-${kind}`, 5);
      }
      add(`regenerate-message-${userId}`, 10);
      top += 100;
      add(`assistant-message-state-complete-${assistantId}`);
      if (thought) {
        add(`thought-toggle-${assistantId}`, 5);
      }
      top += 100;
    };

    if (includeAudio) {
      addTurn('audio', 'user-audio', 'assistant-audio');
    }
    if (includeDocument) {
      addTurn('document', 'user-document', 'assistant-document');
    }
    addTurn('image', 'user-image', 'assistant-image');
    addTurn(null, 'user-reasoning', 'assistant-reasoning', { thought: true });
    addTurn(null, 'user-main', 'assistant-main');
    add('chat-model-switch-row-switch-tail');

    return parseUiSnapshot(`<hierarchy>${nodes.join('')}</hierarchy>`);
  }

  function topologyFromSnapshot(snapshot) {
    return buildConversationTopology(extractVisibleConversationTokens(snapshot), [snapshot]);
  }

  function topologyFromOrder(order, thoughtAssistantIds = []) {
    const thoughtNodes = thoughtAssistantIds.map((assistantId, index) => (
      `<node resource-id="com.github.tah10n.pocketai:id/thought-toggle-${assistantId}" package="com.github.tah10n.pocketai" bounds="[40,${80 + index * 80}][1040,${140 + index * 80}]" />`
    ));
    const snapshot = parseUiSnapshot(`<hierarchy>${thoughtNodes.join('')}</hierarchy>`);
    return buildConversationTopology(order, [snapshot]);
  }

  function conversationToken(kind, id, state = 'complete') {
    return {
      key: `${kind}:${id}`,
      kind,
      id,
      state,
    };
  }

  it('resolves the required oldest-to-newest fixture without inspecting message content', () => {
    const fixture = resolveBranchFixture(topologyFromSnapshot(buildFixtureSnapshot()), {
      audioSupported: true,
    });

    expect(fixture.trailingModelSwitchId).toBe('switch-tail');
    expect(fixture.targets).toEqual(expect.objectContaining({
      audio: expect.objectContaining({ userId: 'user-audio', assistantId: 'assistant-audio' }),
      document: expect.objectContaining({ userId: 'user-document', assistantId: 'assistant-document' }),
      image: expect.objectContaining({ userId: 'user-image', assistantId: 'assistant-image' }),
      reasoning: expect.objectContaining({ userId: 'user-reasoning', assistantId: 'assistant-reasoning' }),
      main: expect.objectContaining({ userId: 'user-main', assistantId: 'assistant-main' }),
    }));
    expect(fixture.targets.image.attachmentResourceIds).toEqual([
      'message-attachment-image-user-image-attachment-image',
    ]);
  });

  it('treats missing required fixtures as precondition failures instead of skips', () => {
    const missingDocument = topologyFromSnapshot(buildFixtureSnapshot({ includeDocument: false }));
    expect(() => resolveBranchFixture(missingDocument, { audioSupported: true }))
      .toThrow(ScenarioPreconditionFailureError);

    const noAudio = topologyFromSnapshot(buildFixtureSnapshot({ includeAudio: false }));
    expect(() => resolveBranchFixture(noAudio, { audioSupported: true }))
      .toThrow(/missing required turns: audio/);
    expect(() => resolveBranchFixture(noAudio, { audioSupported: false })).not.toThrow();

    const missingDocumentAnswerSnapshot = buildFixtureSnapshot();
    missingDocumentAnswerSnapshot.nodes = missingDocumentAnswerSnapshot.nodes.filter(
      (node) => !node.resourceId.endsWith('assistant-message-state-complete-assistant-document')
    );
    expect(() => resolveBranchFixture(topologyFromSnapshot(missingDocumentAnswerSnapshot), {
      audioSupported: true,
    })).toThrow(/missing required turns: document/);
  });

  it('merges overlapping viewport sequences without dropping ordered message identity', () => {
    const older = [
      { key: 'user:1', id: '1' },
      { key: 'assistant:1', id: '1a' },
      { key: 'user:2', id: '2' },
    ];
    const newer = [
      { key: 'user:2', id: '2' },
      { key: 'assistant:2', id: '2a' },
    ];

    expect(mergeOlderConversationOrder(older, newer).map((token) => token.key)).toEqual([
      'user:1',
      'assistant:1',
      'user:2',
      'assistant:2',
    ]);
    expect(normalizeAndroidResourceId('com.example:id/chat-primary-action-send'))
      .toBe('chat-primary-action-send');
  });

  it('recognizes only the stable visible history-start anchor as a complete topology scan', () => {
    const anchored = parseUiSnapshot(`
      <hierarchy>
        <node resource-id="" bounds="[0,0][1080,2400]" />
        <node resource-id="com.example:id/chat-history-start-anchor" bounds="[0,20][1080,21]" />
      </hierarchy>
    `);
    const offscreen = parseUiSnapshot(`
      <hierarchy>
        <node resource-id="" bounds="[0,0][1080,2400]" />
        <node resource-id="com.example:id/chat-history-start-anchor" bounds="[0,-20][1080,-19]" />
      </hierarchy>
    `);

    expect(hasConversationHistoryStartAnchor(anchored)).toBe(true);
    expect(hasConversationHistoryStartAnchor(offscreen)).toBe(false);
  });

  it('binds precise generation-gate observations to a new streaming assistant and one UI snapshot', () => {
    const buildGateSnapshot = ({ phase, assistantId, content = '' }) => parseUiSnapshot(`
      <hierarchy>
        <node resource-id="" bounds="[0,0][1080,2400]" />
        <node resource-id="com.example:id/chat-qa-generation-gate-${phase}-${assistantId}" bounds="[0,10][1,11]" />
        <node resource-id="com.example:id/assistant-message-state-streaming-${assistantId}" bounds="[40,300][1040,500]" />
        ${content ? `<node resource-id="com.example:id/assistant-message-content-${assistantId}" text="${content}" bounds="[40,330][1040,450]" />` : ''}
        <node resource-id="com.example:id/chat-primary-action-stop" clickable="true" enabled="true" bounds="[900,2100][1040,2240]" />
      </hierarchy>
    `);
    const beforeSnapshot = buildGateSnapshot({
      phase: 'before-first-output',
      assistantId: 'assistant-before',
    });
    const before = resolveAndroidQaGenerationGateObservation(beforeSnapshot, {
      phase: 'before-first-output',
      baselineAssistantIds: new Set(['assistant-old']),
    });
    expect(before).toEqual(expect.objectContaining({
      assistantId: 'assistant-before',
      phase: 'before-first-output',
      stopBounds: expect.objectContaining({
        left: 900,
        top: 2100,
        right: 1040,
        bottom: 2240,
      }),
      surface: null,
      snapshot: beforeSnapshot,
    }));

    const after = resolveAndroidQaGenerationGateObservation(buildGateSnapshot({
      phase: 'after-first-durable-output',
      assistantId: 'assistant-after',
      content: 'first durable patch',
    }), {
      phase: 'after-first-durable-output',
      baselineAssistantIds: new Set(['assistant-old']),
    });
    expect(after).toEqual(expect.objectContaining({
      assistantId: 'assistant-after',
      surface: 'content',
    }));

    expect(resolveAndroidQaGenerationGateObservation(parseUiSnapshot(
      '<hierarchy><node resource-id="" bounds="[0,0][1080,2400]" /></hierarchy>'
    ), {
      phase: 'before-first-output',
      baselineAssistantIds: new Set(),
    })).toBeNull();
    expect(() => resolveAndroidQaGenerationGateObservation(beforeSnapshot, {
      phase: 'before-first-output',
      baselineAssistantIds: new Set(['assistant-before']),
    })).toThrow(/not tied to a new branch assistant/);
  });

  it('rejects a before-output gate that already exposes output and waits for durable after-output evidence', () => {
    const beforeWithOutput = parseUiSnapshot(`
      <hierarchy>
        <node resource-id="" bounds="[0,0][1080,2400]" />
        <node resource-id="chat-qa-generation-gate-before-first-output-assistant-new" bounds="[0,10][1,11]" />
        <node resource-id="assistant-message-state-streaming-assistant-new" bounds="[40,300][1040,500]" />
        <node resource-id="assistant-message-content-assistant-new" text="unexpected" bounds="[40,330][1040,450]" />
        <node resource-id="chat-primary-action-stop" clickable="true" enabled="true" bounds="[900,2100][1040,2240]" />
      </hierarchy>
    `);
    expect(() => resolveAndroidQaGenerationGateObservation(beforeWithOutput, {
      phase: 'before-first-output',
      baselineAssistantIds: new Set(),
    })).toThrow(/exposed content/);

    const afterWithoutOutput = parseUiSnapshot(beforeWithOutput.xml
      .replace('before-first-output', 'after-first-durable-output')
      .replace('<node resource-id="assistant-message-content-assistant-new" text="unexpected" bounds="[40,330][1040,450]" />', ''));
    expect(resolveAndroidQaGenerationGateObservation(afterWithoutOutput, {
      phase: 'after-first-durable-output',
      baselineAssistantIds: new Set(),
    })).toBeNull();
  });

  it('requires every stable attachment identity in the exact prepared generation request', () => {
    const target = {
      userId: 'user-document',
      attachmentResourceIds: [
        'message-attachment-document-user-document-attachment-1',
        'message-attachment-document-user-document-attachment-2',
      ],
    };
    const evidence = parseUiSnapshot(`
      <hierarchy>
        <node resource-id="" bounds="[0,0][1080,2400]" />
        <node resource-id="chat-prepared-generation-user-document-assistant-new" bounds="[0,10][1,11]" />
        <node resource-id="chat-prepared-attachment-assistant-new-document-attachment-1" bounds="[0,12][1,13]" />
        <node resource-id="chat-prepared-attachment-assistant-new-document-attachment-2" bounds="[0,14][1,15]" />
      </hierarchy>
    `);

    expect(resolveTargetAttachmentIds(target, 'document')).toEqual([
      'attachment-1',
      'attachment-2',
    ]);
    expect(assertPreparedAttachmentGenerationEvidence(
      evidence,
      target,
      'assistant-new',
      'document'
    )).toEqual(['attachment-1', 'attachment-2']);

    const staleGeneration = parseUiSnapshot(evidence.xml.replace(
      'chat-prepared-generation-user-document-assistant-new',
      'chat-prepared-generation-user-document-assistant-old'
    ));
    expect(() => assertPreparedAttachmentGenerationEvidence(
      staleGeneration,
      target,
      'assistant-new',
      'document'
    )).toThrow(/absent or stale/);

    const missingAttachment = parseUiSnapshot(evidence.xml.replace(
      '<node resource-id="chat-prepared-attachment-assistant-new-document-attachment-2" bounds="[0,14][1,15]" />',
      ''
    ));
    expect(() => assertPreparedAttachmentGenerationEvidence(
      missingAttachment,
      target,
      'assistant-new',
      'document'
    )).toThrow(/non-exact attachment evidence/);

    const extraAttachment = parseUiSnapshot(evidence.xml.replace(
      '</hierarchy>',
      '<node resource-id="chat-prepared-attachment-assistant-new-audio-stale-audio" bounds="[0,16][1,17]" /></hierarchy>'
    ));
    expect(() => assertPreparedAttachmentGenerationEvidence(
      extraAttachment,
      target,
      'assistant-new',
      'document'
    )).toThrow(/audio-stale-audio/);
  });

  it('parses the Android selected attribute for authoritative model-control verification', () => {
    const snapshot = parseUiSnapshot(`
      <hierarchy>
        <node resource-id="reasoning-effort-off" selected="true" bounds="[0,0][100,100]" />
      </hierarchy>
    `);
    expect(snapshot.nodes[0].selected).toBe(true);
  });

  it('requires a new completed assistant directly adjacent to the target user', () => {
    const before = topologyFromOrder([
      conversationToken('user', 'user-older'),
      conversationToken('assistant', 'assistant-older'),
      conversationToken('user', 'user-target'),
      conversationToken('assistant', 'assistant-target-old'),
    ]);
    const baseline = createBranchRegenerationBaseline(before, 'user-target');
    const after = topologyFromOrder([
      conversationToken('user', 'user-older'),
      conversationToken('assistant', 'assistant-older'),
      conversationToken('user', 'user-target'),
      conversationToken('assistant', 'assistant-target-new'),
    ]);

    expect(resolveBranchRegenerationReplacement(after, baseline)).toEqual(
      expect.objectContaining({ id: 'assistant-target-new', state: 'complete' })
    );
    expect([...baseline.assistantIds]).toEqual([
      'assistant-older',
      'assistant-target-old',
    ]);
  });

  it('rejects unrelated, reused, and non-complete branch replacements', () => {
    const before = topologyFromOrder([
      conversationToken('user', 'user-older'),
      conversationToken('assistant', 'assistant-older'),
      conversationToken('user', 'user-target'),
      conversationToken('assistant', 'assistant-target-old'),
    ]);
    const baseline = createBranchRegenerationBaseline(before, 'user-target');

    const unrelatedOnly = topologyFromOrder([
      conversationToken('user', 'user-older'),
      conversationToken('assistant', 'assistant-older'),
      conversationToken('user', 'user-target'),
    ]);
    expect(() => resolveBranchRegenerationReplacement(unrelatedOnly, baseline))
      .toThrow(/directly adjacent/);

    const reused = topologyFromOrder([
      conversationToken('user', 'user-target'),
      conversationToken('assistant', 'assistant-older'),
    ]);
    expect(() => resolveBranchRegenerationReplacement(reused, baseline))
      .toThrow(/reused pre-operation assistant/);

    const stopped = topologyFromOrder([
      conversationToken('user', 'user-target'),
      conversationToken('assistant', 'assistant-target-new', 'stopped'),
    ]);
    expect(() => resolveBranchRegenerationReplacement(stopped, baseline))
      .toThrow(/ended in stopped instead of complete/);
  });

  it('rejects a new completed assistant that belongs to another user', () => {
    const before = topologyFromOrder([
      conversationToken('user', 'user-target'),
      conversationToken('assistant', 'assistant-target-old'),
    ]);
    const baseline = createBranchRegenerationBaseline(before, 'user-target');
    const after = topologyFromOrder([
      conversationToken('user', 'user-target'),
      conversationToken('user', 'user-other'),
      conversationToken('assistant', 'assistant-other-new'),
    ]);

    expect(() => resolveBranchRegenerationReplacement(after, baseline))
      .toThrow(/directly adjacent/);
  });

  it('verifies authoritative thought clear on settle and rehydrate', () => {
    const before = topologyFromOrder([
      conversationToken('user', 'user-reasoning'),
      conversationToken('assistant', 'assistant-reasoning-old'),
    ], ['assistant-reasoning-old']);
    const baseline = createBranchRegenerationBaseline(before, 'user-reasoning');
    const settled = topologyFromOrder([
      conversationToken('user', 'user-reasoning'),
      conversationToken('assistant', 'assistant-reasoning-new'),
    ]);

    expect(assertAuthoritativeThoughtClear({
      beforeTopology: before,
      topology: settled,
      baseline,
      replacementAssistantId: 'assistant-reasoning-new',
    })).toEqual({
      replacedThoughtAbsent: true,
      replacementThoughtAbsent: true,
    });

    const rehydrated = topologyFromOrder([
      conversationToken('user', 'user-reasoning'),
      conversationToken('assistant', 'assistant-reasoning-new'),
    ]);
    expect(() => assertAuthoritativeThoughtClear({
      beforeTopology: before,
      topology: rehydrated,
      baseline,
      replacementAssistantId: 'assistant-reasoning-new',
    })).not.toThrow();
  });

  it('fails reasoning clear when thought is missing from the fixture or survives replacement', () => {
    const beforeWithoutThought = topologyFromOrder([
      conversationToken('user', 'user-reasoning'),
      conversationToken('assistant', 'assistant-reasoning-old'),
    ]);
    const missingThoughtBaseline = createBranchRegenerationBaseline(
      beforeWithoutThought,
      'user-reasoning'
    );
    const cleared = topologyFromOrder([
      conversationToken('user', 'user-reasoning'),
      conversationToken('assistant', 'assistant-reasoning-new'),
    ]);
    expect(() => assertAuthoritativeThoughtClear({
      beforeTopology: beforeWithoutThought,
      topology: cleared,
      baseline: missingThoughtBaseline,
      replacementAssistantId: 'assistant-reasoning-new',
    })).toThrow(ScenarioPreconditionFailureError);

    const before = topologyFromOrder([
      conversationToken('user', 'user-reasoning'),
      conversationToken('assistant', 'assistant-reasoning-old'),
    ], ['assistant-reasoning-old']);
    const baseline = createBranchRegenerationBaseline(before, 'user-reasoning');
    const replacementWithThought = topologyFromOrder([
      conversationToken('user', 'user-reasoning'),
      conversationToken('assistant', 'assistant-reasoning-new'),
    ], ['assistant-reasoning-new']);
    expect(() => assertAuthoritativeThoughtClear({
      beforeTopology: before,
      topology: replacementWithThought,
      baseline,
      replacementAssistantId: 'assistant-reasoning-new',
    })).toThrow(/still exposes thought content/);

    const staleThoughtResource = topologyFromOrder([
      conversationToken('user', 'user-reasoning'),
      conversationToken('assistant', 'assistant-reasoning-new'),
    ], ['assistant-reasoning-old']);
    expect(() => assertAuthoritativeThoughtClear({
      beforeTopology: before,
      topology: staleThoughtResource,
      baseline,
      replacementAssistantId: 'assistant-reasoning-new',
    })).toThrow(/still present/);
  });

  it('redacts local paths and credentials while retaining fatal-log classification', () => {
    const raw = [
      `source=${path.resolve(__dirname, '..', '..', 'src', 'index.ts')}`,
      'Authorization: Bearer secret.token.value',
      'token=hf_12345678901234567890',
      'uri=file:///C:/Users/example/private.txt',
    ].join('\n');
    const sanitized = sanitizeQaLogcat(raw);

    expect(sanitized).toContain('<local-path>');
    expect(sanitized).toContain('Bearer <redacted>');
    expect(sanitized).toContain('<hugging-face-token>');
    expect(sanitized).toContain('<local-file-uri>');
    expect(sanitized).not.toContain('secret.token.value');
    expect(scanFatalAndroidLogs('E/AndroidRuntime: FATAL EXCEPTION: main')).toEqual(
      expect.arrayContaining([expect.stringContaining('FATAL EXCEPTION')])
    );
    expect(scanFatalAndroidLogs('F/libc: Fatal signal 7 (SIGBUS), code 1')).toEqual(
      expect.arrayContaining([expect.stringContaining('Fatal signal')])
    );
    expect(scanFatalAndroidLogs('I/ReactNativeJS: branch regeneration complete')).toEqual([]);
  });

  it('redacts complete sensitive assignments and bounds arbitrary QA text', () => {
    const raw = [
      'prompt: confidential user text here',
      'Authorization: Basic dXNlcjpwYXNzd29yZA==',
      'secret=alpha beta gamma',
      'token="quoted credential with spaces" normal=retained',
      'windows=D:\\private folder\\model.gguf',
      'posix=/home/private-user/models/model.gguf',
      'ordinary precondition reason',
    ].join('\n');
    const sanitized = sanitizeAndroidQaText(raw, { maxChars: 2_000 });

    for (const secret of [
      'confidential user text here',
      'dXNlcjpwYXNzd29yZA',
      'alpha beta gamma',
      'quoted credential with spaces',
      'D:\\private folder',
      '/home/private-user',
    ]) {
      expect(sanitized).not.toContain(secret);
    }
    expect(sanitized).toContain('ordinary precondition reason');
    const bounded = sanitizeAndroidQaText('x'.repeat(100), { maxChars: 16 });
    expect(bounded).toBe(`${'x'.repeat(16)}\n<truncated:84>`);
  });

  it('reduces malicious host errors to allowlisted metadata', () => {
    const error = new Error(
      'PROMPT_SENTINEL hf_private_token C:\\Users\\private\\model.gguf'
    );
    error.name = 'PROMPT_SENTINEL';
    error.code = 'hf_private_token';

    const sanitized = describeAndroidQaError(error, 'scenario-run-failed');

    expect(sanitized).toBe('scenario-run-failed (name=Error, code=unknown)');
    expect(sanitized).not.toContain('PROMPT_SENTINEL');
    expect(sanitized).not.toContain('hf_private_token');
    expect(sanitized).not.toContain('C:\\Users\\private\\model.gguf');

    const permissionError = Object.assign(new Error('private detail'), { code: 'EPERM' });
    expect(describeAndroidQaError(permissionError, 'cleanup-failed'))
      .toBe('cleanup-failed (name=Error, code=EPERM)');

    const hostileError = new Proxy({}, {
      get: (_target, property) => {
        throw new Error(
          `${String(property)} PROMPT_SENTINEL hf_private_token C:\\Users\\private\\model.gguf`
        );
      },
    });
    expect(describeAndroidQaError(hostileError, 'proxy-failed'))
      .toBe('proxy-failed (name=Error, code=unknown)');

    const sourceError = new ReferenceError(
      'PROMPT_SENTINEL hf_private_token C:\\Users\\private\\model.gguf'
    );
    sourceError.stack = [
      'ReferenceError: PROMPT_SENTINEL hf_private_token',
      '    at readAndroidUiHierarchy (/home/private-user/project/scripts/android-smoke.js:2688:17)',
      '    at /home/private-user/project/private-secret.js:9:3',
    ].join('\n');
    const sourceDiagnostic = describeAndroidQaError(
      sourceError,
      'smoke-run-failed',
      { allowedSourceFiles: ['android-smoke.js'] }
    );
    expect(sourceDiagnostic)
      .toBe('smoke-run-failed (name=ReferenceError, code=unknown, site=android-smoke.js:2688:17)');
    expect(sourceDiagnostic).not.toContain('PROMPT_SENTINEL');
    expect(sourceDiagnostic).not.toContain('private-user');
    expect(sourceDiagnostic).not.toContain('private-secret.js');
  });

  it('requires the source snapshot to remain exact across device identity hashing', () => {
    const baseline = {
      headSha: 'head-1',
      treeSha: 'tree-1',
      dirty: true,
      dirtyDigest: 'dirty-1',
      dirtyEntryCount: 2,
    };

    expect(areExactGitProvenancesEqual(baseline, { ...baseline })).toBe(true);
    expect(areExactGitProvenancesEqual(baseline, {
      ...baseline,
      dirtyDigest: 'dirty-2',
    })).toBe(false);
    expect(areExactGitProvenancesEqual(baseline, {
      ...baseline,
      dirtyEntryCount: 3,
    })).toBe(false);
  });

  it('recomputes current QA provenance through the same isolated Gradle home as the build', () => {
    const appRoot = path.resolve(__dirname, '..', '..');
    const setupGradleHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-ai-setup-gradle-'));
    const setupGradleInitDirectory = path.join(setupGradleHome, 'init.d');
    const hmacKeyPath = path.join(setupGradleHome, 'reuse-hmac.key');
    const previousGradleUserHome = process.env.GRADLE_USER_HOME;
    fs.mkdirSync(setupGradleInitDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(setupGradleInitDirectory, 'gradle-actions.build-result-capture.init.gradle'),
      'allprojects {}\n',
    );
    fs.writeFileSync(path.join(setupGradleHome, 'gradle.properties'), 'privateValue=setup-gradle\n');
    const currentGit = {
      headSha: 'fixture-head',
      treeSha: 'fixture-tree',
      dirty: true,
      dirtyDigest: 'fixture-dirty',
      dirtyEntryCount: 1,
    };
    const variant = 'release';
    const abi = 'x86_64';
    const nodeEnv = 'production';
    const isolatedEnvironment = createIsolatedAndroidBuildEnvironment(
      appRoot,
      process.env,
      { NODE_ENV: nodeEnv },
    );
    const gradleArgs = withAndroidProvenanceGradleExecutionArgs([
      'app:assembleRelease',
      '-PreactNativeArchitectures=x86_64',
    ]);
    const prebuildInputState = collectPrebuildInputState(appRoot, {
      env: isolatedEnvironment,
      hmacKeyPath,
      nodeEnv,
      variant,
    });
    const buildContext = {
      androidQaEvidence: false,
      effectiveBuild: collectAndroidEffectiveBuildContext(appRoot, {
        env: isolatedEnvironment,
        gradleArgs,
        variant,
      }),
      prebuildInputDigest: prebuildInputState.digest,
    };
    const storedManifest = collectBuildProvenance(appRoot, {
      abi,
      androidRoot: path.join(appRoot, 'android'),
      buildContext,
      env: isolatedEnvironment,
      git: currentGit,
      gradleArgs,
      includeBundleInputs: true,
      hmacKeyPath,
      variant,
    });

    try {
      process.env.GRADLE_USER_HOME = setupGradleHome;
      const currentManifest = collectCurrentQaBuildProvenance({
        abi,
        build: { provenance: storedManifest },
        variant,
      }, currentGit, { hmacKeyPath });
      expect(currentManifest.digest).toBe(storedManifest.digest);
    } finally {
      if (previousGradleUserHome == null) {
        delete process.env.GRADLE_USER_HOME;
      } else {
        process.env.GRADLE_USER_HOME = previousGradleUserHome;
      }
      fs.rmSync(setupGradleHome, { force: true, recursive: true });
    }
  });

  it('rejects tampered stamps, stale source state, and a replaced installed APK', () => {
    const apkSha256 = 'a'.repeat(64);
    const currentGit = {
      headSha: 'head-sha',
      treeSha: 'tree-sha',
      dirtyDigest: 'dirty-digest',
    };
    const manifest = {
      schemaVersion: 2,
      variant: 'release',
      abi: 'x86_64',
      embeddedBundle: true,
      buildContext: {
        androidQaEvidence: true,
        effectiveBuild: {
          version: { code: '16', name: '1.6.0' },
        },
      },
      toolchains: { node: 'v22.0.0', java: '17', gradleWrapper: { version: '8.14.3' } },
      git: currentGit,
      entries: [{ path: 'src/app.ts', type: 'file', size: 1, sha256: 'b'.repeat(64) }],
    };
    const manifestDigest = hashCanonicalJson(manifest);
    const provenance = {
      schemaVersion: 2,
      serial: 'emulator-5554',
      packageName: 'com.github.tah10n.pocketai',
      variant: 'release',
      abi: 'x86_64',
      build: {
        schemaVersion: 2,
        variant: 'release',
        abi: 'x86_64',
        provenanceDigest: manifestDigest,
        provenance: { ...manifest, digest: manifestDigest },
        apk: {
          sha256: apkSha256,
          packagedAbis: ['x86_64'],
          matchedAbi: 'x86_64',
        },
      },
      install: {
        schemaVersion: 2,
        serial: 'emulator-5554',
        packageName: 'com.github.tah10n.pocketai',
        variant: 'release',
        abi: 'x86_64',
        buildProvenanceDigest: manifestDigest,
        apkSha256,
        installedApkSha256: apkSha256,
        packagedAbis: ['x86_64'],
        matchedAbi: 'x86_64',
        packagePath: '/data/app/fixture/base.apk',
        versionCode: '16',
        versionName: '1.6.0',
      },
    };
    const installedIdentity = {
      installed: true,
      packagePath: '/data/app/fixture/base.apk',
      apkSha256,
      versionCode: '16',
      versionName: '1.6.0',
      supportedAbis: ['x86_64', 'x86'],
    };
    const validation = {
      provenance,
      currentGit,
      currentBuildProvenance: { ...manifest, digest: manifestDigest },
      installedIdentity,
      serial: 'emulator-5554',
      packageName: 'com.github.tah10n.pocketai',
    };

    expect(() => validateQaProvenance(validation)).not.toThrow();
    expect(() => validateQaProvenance({
      ...validation,
      installedIdentity: { ...installedIdentity, apkSha256: 'c'.repeat(64) },
    })).toThrow(/currently installed/);
    expect(() => validateQaProvenance({
      ...validation,
      provenance: {
        ...provenance,
        install: { ...provenance.install, versionCode: '17' },
      },
      installedIdentity: { ...installedIdentity, versionCode: '17' },
    })).toThrow(/stale, tampered, or incomplete/);
    expect(() => validateQaProvenance({
      ...validation,
      currentGit: { ...currentGit, dirtyDigest: 'new-dirty-digest' },
    })).toThrow(/current source/);
    expect(() => validateQaProvenance({
      ...validation,
      currentBuildProvenance: { ...manifest, digest: 'stale-input-digest' },
    })).toThrow(/stale, tampered, or incomplete/);
    expect(() => validateQaProvenance({
      ...validation,
      provenance: {
        ...provenance,
        build: {
          ...provenance.build,
          provenance: {
            ...provenance.build.provenance,
            entries: [],
          },
        },
      },
    })).toThrow(/tampered/);
    expect(() => validateQaProvenance({
      ...validation,
      provenance: {
        ...provenance,
        build: { ...provenance.build, variant: 'debug' },
      },
    })).toThrow(/stale, tampered, or incomplete/);
    expect(() => validateQaProvenance({
      ...validation,
      provenance: {
        ...provenance,
        build: {
          ...provenance.build,
          provenance: {
            ...provenance.build.provenance,
            embeddedBundle: false,
          },
        },
      },
    })).toThrow(/stale, tampered, or incomplete/);
    expect(() => validateQaProvenance({
      ...validation,
      provenance: {
        ...provenance,
        build: {
          ...provenance.build,
          apk: {
            ...provenance.build.apk,
            packagedAbis: ['arm64-v8a', 'x86_64'],
          },
        },
        install: {
          ...provenance.install,
          packagedAbis: ['arm64-v8a', 'x86_64'],
        },
      },
    })).toThrow(/package and select exactly requested ABI/);

    const universalManifest = { ...manifest, abi: 'universal' };
    const universalDigest = hashCanonicalJson(universalManifest);
    const universalProvenance = {
      ...provenance,
      abi: 'universal',
      build: {
        ...provenance.build,
        abi: 'universal',
        provenanceDigest: universalDigest,
        provenance: { ...universalManifest, digest: universalDigest },
        apk: {
          ...provenance.build.apk,
          packagedAbis: ['arm64-v8a', 'x86_64'],
          matchedAbi: 'x86_64',
        },
      },
      install: {
        ...provenance.install,
        abi: 'universal',
        buildProvenanceDigest: universalDigest,
        packagedAbis: ['arm64-v8a', 'x86_64'],
        matchedAbi: 'x86_64',
      },
    };
    expect(() => validateQaProvenance({
      ...validation,
      provenance: {
        ...universalProvenance,
        build: {
          ...universalProvenance.build,
          apk: {
            ...universalProvenance.build.apk,
            packagedAbis: ['x86_64'],
          },
        },
        install: {
          ...universalProvenance.install,
          packagedAbis: ['x86_64'],
        },
      },
      currentBuildProvenance: { ...universalManifest, digest: universalDigest },
    })).toThrow(/canonical Android ABI set/);
    expect(() => validateQaProvenance({
      ...validation,
      provenance: universalProvenance,
      currentBuildProvenance: { ...universalManifest, digest: universalDigest },
    })).not.toThrow();
  });

  it('resolves Android package UIDs across platform package metadata formats', () => {
    const packageName = 'com.github.tah10n.pocketai';
    const legacyCapture = jest.fn(() => (
      `Package [${packageName}]\n  userId=10234\n`
    ));

    expect(resolveAndroidPackageUid(
      'adb',
      'device-1',
      packageName,
      { runCapture: legacyCapture }
    )).toBe('10234');
    expect(legacyCapture).toHaveBeenCalledTimes(1);

    const vendorCapture = jest.fn((command, args) => (
      args.includes('dumpsys')
        ? `Package [${packageName}]\n  uid=10338 gids=[]\n  appId=10338\n`
        : `package:${packageName} uid:10338\n`
    ));
    expect(resolveAndroidPackageUid(
      'adb',
      'device-1',
      packageName,
      { runCapture: vendorCapture }
    )).toBe('10338');
    expect(vendorCapture).toHaveBeenNthCalledWith(
      2,
      'adb',
      [
        '-s',
        'device-1',
        'shell',
        'cmd',
        'package',
        'list',
        'packages',
        '-U',
        packageName,
      ]
    );
  });

  it('fails closed when the package UID fallback is mismatched or ambiguous', () => {
    const packageName = 'com.github.tah10n.pocketai';
    const resolveWithPackageList = (packageList) => resolveAndroidPackageUid(
      'adb',
      'device-1',
      packageName,
      {
        runCapture: jest.fn((command, args) => (
          args.includes('dumpsys')
            ? `Package [${packageName}]\n  appId=10338\n`
            : packageList
        )),
      }
    );

    expect(() => resolveWithPackageList(
      'package:com.github.tah10n.pocketai.preview uid:10338\n'
    )).toThrow(/no unambiguous exact-package UID/);
    expect(() => resolveWithPackageList(
      `package:${packageName} uid:10338\npackage:${packageName} uid:20338\n`
    )).toThrow(/no unambiguous exact-package UID/);
  });

  it('streams app UID logs and a server-filtered exact system ANR interval into private owned files', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-ai-logcat-'));
    const children = [4101, 4102].map((pid) => {
      const child = new EventEmitter();
      child.pid = pid;
      child.kill = jest.fn(() => {
        setImmediate(() => child.emit('close', null, 'SIGTERM'));
        return true;
      });
      return child;
    });
    const spawn = jest.fn(() => {
      const child = children[spawn.mock.calls.length - 1];
      setImmediate(() => child.emit('spawn'));
      return child;
    });
    const runCapture = jest.fn((command, args) => (
      args.includes('dumpsys')
        ? 'Package [com.github.tah10n.pocketai]\n  userId=10234\n'
        : '1784700000.123\n'
    ));

    try {
      const collector = await startAndroidLogcatCollector({
        adbPath: 'adb',
        serial: 'device-1',
        packageName: 'com.github.tah10n.pocketai',
        stem: 'branch-step',
      }, {
        privateRoot: tempDir,
        runCapture,
        spawn,
      });
      fs.appendFileSync(
        collector.rawLogPath,
        'complete app interval\n',
      );
      fs.appendFileSync(
        collector.systemRawLogPath,
        '--------- beginning of system\n07-22 12:00:00.000  1000  1000 E ActivityManager: ANR in com.github.tah10n.pocketai\n',
      );

      expect(spawn).toHaveBeenNthCalledWith(
        1,
        'adb',
        [
          '-s',
          'device-1',
          'logcat',
          '-b',
          'all',
          '--uid=10234',
          '-T',
          '1784700000.123',
          '-v',
          'threadtime',
        ],
        expect.objectContaining({
          stdio: ['ignore', expect.any(Number), expect.any(Number)],
          windowsHide: true,
        })
      );
      expect(spawn).toHaveBeenNthCalledWith(
        2,
        'adb',
        [
          '-s',
          'device-1',
          'logcat',
          '-b',
          'all',
          '--uid=1000',
          '-T',
          '1784700000.123',
          '-v',
          'threadtime',
          '--regex',
          'ANR in com\\.github\\.tah10n\\.pocketai',
          'ActivityManager:V',
          '*:S',
        ],
        expect.objectContaining({
          stdio: ['ignore', expect.any(Number), expect.any(Number)],
          windowsHide: true,
        })
      );
      expect(spawn.mock.calls[0][1]).not.toContain('-d');
      expect(spawn.mock.calls[0][1]).not.toContain('-c');
      expect(() => readAndroidLogcatCollector(collector)).toThrow(/not stopped cleanly/);
      expect(readAndroidLogcatCollector(collector, { requireStopped: false }))
        .toContain('complete app interval');
      expect(scanFatalAndroidLogs(readAndroidLogcatCollector(
        collector,
        { requireStopped: false },
      ))).toEqual([expect.stringContaining('ANR')]);

      fs.appendFileSync(
        collector.systemRawLogPath,
        '07-22 12:00:01.000  1000  1000 I ActivityManager: unrelated system event\n',
      );
      expect(() => readAndroidLogcatCollector(collector, { requireStopped: false }))
        .toThrow(/unrelated output/);
      fs.writeFileSync(
        collector.systemRawLogPath,
        '07-22 12:00:00.000  1000  1000 E ActivityManager: ANR in com.github.tah10n.pocketai\n',
      );
      expect(() => readAndroidLogcatCollector(collector, {
        requireStopped: false,
        maxBytes: 1,
      })).toThrow(/safety limit/);

      await stopAndroidLogcatCollector(collector);
      expect(readAndroidLogcatCollector(collector)).toContain('complete app interval');
      expect(children.every((child) => child.kill.mock.calls.length === 1)).toBe(true);
      cleanupAndroidLogcatCollector(collector);
      expect(fs.existsSync(collector.rawLogPath)).toBe(false);
      expect(fs.existsSync(collector.systemRawLogPath)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it('fails closed when the owned collector exits before the scenario completes', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-ai-logcat-exit-'));
    const children = [4201, 4202].map((pid) => {
      const child = new EventEmitter();
      child.pid = pid;
      child.kill = jest.fn(() => {
        setImmediate(() => child.emit('close', null, 'SIGTERM'));
        return true;
      });
      return child;
    });
    const spawn = jest.fn(() => {
      const child = children[spawn.mock.calls.length - 1];
      setImmediate(() => child.emit('spawn'));
      return child;
    });
    const runCapture = jest.fn((command, args) => (
      args.includes('dumpsys') ? 'userId=10234' : '1784700000.123'
    ));

    try {
      const collector = await startAndroidLogcatCollector({
        adbPath: 'adb',
        serial: 'device-1',
        packageName: 'com.github.tah10n.pocketai',
        stem: 'unexpected-exit',
      }, { privateRoot: tempDir, runCapture, spawn });
      children[0].emit('close', 1, null);

      expect(() => readAndroidLogcatCollector(collector, { requireStopped: false }))
        .toThrow(/exited before the step completed/);
      await expect(stopAndroidLogcatCollector(collector))
        .rejects.toThrow(/exited before the step completed/);
      expect(children[1].kill).toHaveBeenCalledTimes(1);
      cleanupAndroidLogcatCollector(collector);
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it('fails closed on collector spawn errors and owned-stop timeouts', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-ai-logcat-failure-'));
    const runCapture = jest.fn((command, args) => (
      args.includes('dumpsys') ? 'userId=10234' : '1784700000.123'
    ));
    const spawnFailures = [4301, 4302].map((pid, index) => {
      const child = new EventEmitter();
      child.pid = pid;
      child.kill = jest.fn(() => {
        setImmediate(() => child.emit('close', -1, null));
        return true;
      });
      child.failStart = index === 1;
      return child;
    });

    try {
      const onCollectorCreated = jest.fn();
      const failingSpawn = jest.fn(() => {
        const child = spawnFailures[failingSpawn.mock.calls.length - 1];
        setImmediate(() => child.emit(child.failStart ? 'error' : 'spawn', new Error('spawn denied')));
        return child;
      });
      await expect(startAndroidLogcatCollector({
        adbPath: 'adb',
        serial: 'device-1',
        packageName: 'com.github.tah10n.pocketai',
        stem: 'spawn-error',
      }, {
        privateRoot: tempDir,
        runCapture,
        spawn: failingSpawn,
        onCollectorCreated,
      })).rejects.toThrow(/spawn denied/);
      expect(onCollectorCreated).toHaveBeenLastCalledWith(null);

      const stuckChildren = [4242, 4243].map((pid) => {
        const child = new EventEmitter();
        child.pid = pid;
        child.kill = jest.fn(() => true);
        return child;
      });
      const stuckSpawn = jest.fn(() => {
        const child = stuckChildren[stuckSpawn.mock.calls.length - 1];
        setImmediate(() => child.emit('spawn'));
        return child;
      });
      const stopOwnedProcessTree = jest.fn(() => true);
      const collector = await startAndroidLogcatCollector({
        adbPath: 'adb',
        serial: 'device-1',
        packageName: 'com.github.tah10n.pocketai',
        stem: 'stop-timeout',
      }, {
        privateRoot: tempDir,
        runCapture,
        spawn: stuckSpawn,
        captureOwnership: (pid) => ({
          processIdentity: { startMarker: `owned-logcat-process-${pid}` },
          processTreeIdentities: [{
            pid,
            parentPid: null,
            startMarker: `owned-logcat-process-${pid}`,
            depth: 0,
          }],
          ownershipBoundary: 'test-owned-boundary',
        }),
        stopOwnedProcessTreeByPid: stopOwnedProcessTree,
      });
      await expect(stopAndroidLogcatCollector(collector, {
        stopTimeoutMs: 1,
        forceStopTimeoutMs: 1,
      })).rejects.toThrow(/Timed out/);
      expect(stuckChildren.every((child) => child.kill.mock.calls.length === 2)).toBe(true);
      expect(stopOwnedProcessTree).toHaveBeenCalledWith(4242, expect.objectContaining({
        expectedIdentity: { startMarker: 'owned-logcat-process-4242' },
        ownershipBoundary: 'test-owned-boundary',
      }));
      expect(stopOwnedProcessTree).toHaveBeenCalledWith(4243, expect.objectContaining({
        expectedIdentity: { startMarker: 'owned-logcat-process-4243' },
        ownershipBoundary: 'test-owned-boundary',
      }));
      cleanupAndroidLogcatCollector(collector);
      expect(fs.existsSync(collector.rawLogPath)).toBe(false);
      expect(fs.existsSync(collector.systemRawLogPath)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it('retains a failed-start collector until a later authenticated cleanup retry succeeds', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-ai-logcat-start-retain-'));
    const children = [4401, 4402].map((pid, index) => {
      const child = new EventEmitter();
      child.pid = pid;
      child.kill = jest.fn(() => true);
      child.failStart = index === 1;
      return child;
    });
    const spawn = jest.fn(() => {
      const child = children[spawn.mock.calls.length - 1];
      setImmediate(() => child.emit(child.failStart ? 'error' : 'spawn', new Error('system collector failed')));
      return child;
    });
    const runCapture = jest.fn((command, args) => (
      args.includes('dumpsys') ? 'userId=10234' : '1784700000.123'
    ));
    let allowOwnedCleanup = false;
    const stopOwnedProcessTreeByPid = jest.fn(() => allowOwnedCleanup);
    const onCollectorCreated = jest.fn();

    try {
      await expect(startAndroidLogcatCollector({
        adbPath: 'adb',
        serial: 'device-1',
        packageName: 'com.github.tah10n.pocketai',
        stem: 'failed-start-retained',
      }, {
        privateRoot: tempDir,
        runCapture,
        spawn,
        forceStopTimeoutMs: 1,
        captureOwnership: (pid) => ({
          processIdentity: { startMarker: `retained-${pid}` },
          processTreeIdentities: [{
            pid,
            parentPid: null,
            startMarker: `retained-${pid}`,
            depth: 0,
          }],
          ownershipBoundary: 'retained-test-boundary',
        }),
        stopOwnedProcessTreeByPid,
        onCollectorCreated,
      })).rejects.toThrow(/remain retained for a later authenticated cleanup retry/);

      const retainedCollector = onCollectorCreated.mock.calls[0][0];
      expect(retainedCollector).toEqual(expect.objectContaining({
        started: false,
        closed: false,
      }));
      expect(onCollectorCreated).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(retainedCollector.rawLogPath)).toBe(true);
      expect(fs.existsSync(retainedCollector.systemRawLogPath)).toBe(true);
      expect(() => cleanupAndroidLogcatCollector(retainedCollector))
        .toThrow(/collector may still be running/);
      expect(fs.existsSync(retainedCollector.rawLogPath)).toBe(true);

      allowOwnedCleanup = true;
      cleanupAndroidLogcatCollector(retainedCollector);
      expect(fs.existsSync(retainedCollector.rawLogPath)).toBe(false);
      expect(fs.existsSync(retainedCollector.systemRawLogPath)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });
});

describe('android-scenarios language restore', () => {
  function createRestoreContext() {
    return {
      serial: 'emulator-5554',
      tapAnyText: jest.fn().mockResolvedValue(undefined),
      tapBottomTab: jest.fn().mockResolvedValue(undefined),
      expectAnyText: jest.fn().mockResolvedValue(undefined),
    };
  }

  it('returns home without toggling when the original language is already restored', async () => {
    const ctx = createRestoreContext();

    await restoreLanguageAfterScenario(ctx, ['Original'], ['Alternate'], ['Restored Home'], {
      findAnyNodeNow: jest.fn().mockResolvedValue({ label: 'Original' }),
      goToSettings: jest.fn().mockResolvedValue(undefined),
      resolveAdbPath: () => 'adb',
      scrollToAnyText: jest.fn().mockResolvedValue(undefined),
    });

    expect(ctx.tapAnyText).not.toHaveBeenCalled();
    expect(ctx.tapBottomTab).toHaveBeenCalledWith(expect.arrayContaining(['Home']));
    expect(ctx.expectAnyText).toHaveBeenCalledWith(['Restored Home'], { timeoutMs: 10_000 });
  });

  it('toggles back before returning home when the alternate language is still active', async () => {
    const ctx = createRestoreContext();

    await restoreLanguageAfterScenario(ctx, ['Original'], ['Alternate'], ['Restored Home'], {
      findAnyNodeNow: jest.fn().mockResolvedValue(null),
      goToSettings: jest.fn().mockResolvedValue(undefined),
      resolveAdbPath: () => 'adb',
      scrollToAnyText: jest.fn().mockResolvedValue(undefined),
    });

    expect(ctx.tapAnyText).toHaveBeenCalledWith(['Alternate'], { afterTapDelayMs: 1_200 });
    expect(ctx.expectAnyText).toHaveBeenCalledWith(['Original'], { timeoutMs: 10_000 });
    expect(ctx.tapBottomTab).toHaveBeenCalledWith(expect.arrayContaining(['Home']));
    expect(ctx.expectAnyText).toHaveBeenCalledWith(['Restored Home'], { timeoutMs: 10_000 });
  });
});

describe('android-scenarios skip signaling', () => {
  it('uses a dedicated skip error for non-verifiable optional scenarios', () => {
    const error = new ScenarioSkipError('skip this');

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('skip this');
  });

  it('parses fail-on-skip for opt-in verification runs', () => {
    expect(parseCliOptions(['--pack', 'attachments', '--fail-on-skip'])).toEqual(
      expect.objectContaining({
        pack: 'attachments',
        failOnSkip: true,
      })
    );
  });

  it('parses preserve-running-app for prepared state scenarios', () => {
    expect(parseCliOptions(['--pack', 'attachments-prepared', '--preserve-running-app', '--fail-on-skip'])).toEqual(
      expect.objectContaining({
        pack: 'attachments-prepared',
        preserveRunningApp: true,
        failOnSkip: true,
      })
    );
  });

  it('does not append a runner failure for skips already recorded as failed scenarios', () => {
    expect(shouldAppendRunnerFailure(new ScenarioSkipFailureError('already recorded'))).toBe(false);
    expect(shouldAppendRunnerFailure(
      markScenarioFailureRecorded(new Error('scenario evidence already recorded'))
    )).toBe(false);
    expect(shouldAppendRunnerFailure(new Error('real runner failure'))).toBe(true);
  });

  it('parses and forwards an explicit release APK variant for current-head packs', () => {
    const options = parseCliOptions(['--pack', 'branch-regeneration', '--apk-variant', 'Release']);
    expect(options).toEqual(expect.objectContaining({ apkVariant: 'release' }));
    expect(buildSmokeLaunchArgs({
      ...options,
      bootstrapScreenshot: false,
    }, 'emulator-5554')).toEqual(expect.arrayContaining([
      '--apk-variant',
      'release',
    ]));
    expect(() => parseCliOptions(['--apk-variant', 'profile'])).toThrow(/Unsupported Android APK variant/);
  });
});

describe('android-scenarios report path serialization', () => {
  it('stores artifact paths as relative report paths for all result outcomes', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-ai-report-paths-'));
    const projectRoot = path.join(tempDir, 'project');
    const artifactsRoot = path.join(projectRoot, 'artifacts', 'android-scenarios');
    const deepDiagnostic = {};
    let deepCursor = deepDiagnostic;
    for (let depth = 0; depth < 12; depth += 1) {
      deepCursor.next = {};
      deepCursor = deepCursor.next;
    }
    deepCursor.secret = 'must-not-survive-depth-bound';
    const results = [
      {
        id: 'home-smoke',
        status: 'passed',
        screenshotPath: path.join(artifactsRoot, 'home-smoke.png'),
        rawLogPath: path.join(projectRoot, 'node_modules', '.cache', 'private.raw.log'),
        rawLogPaths: [path.join(projectRoot, 'node_modules', '.cache', 'private.raw.log')],
        systemRawLogPath: path.join(projectRoot, 'node_modules', '.cache', 'private.system.raw.log'),
        logcatCollector: { privateLogcatPath: path.join(tempDir, 'secret.raw.log') },
        checkpoints: [{
          screenshotPath: path.join(artifactsRoot, 'branch-regeneration', 'checkpoint.png'),
          uiDumpPath: path.join(artifactsRoot, 'branch-regeneration', 'checkpoint.xml'),
          logcatPath: path.join(artifactsRoot, 'branch-regeneration', 'checkpoint-logcat.txt'),
        }],
      },
      {
        id: 'bottom-tabs',
        status: 'failed',
        screenshotPath: path.join(artifactsRoot, 'bottom-tabs-failed.png'),
      },
      {
        id: 'chat-attachment-text-only-fallback',
        status: 'failed',
        screenshotPath: path.join(artifactsRoot, 'chat-attachment-text-only-fallback-skipped.png'),
        skipReason: 'prepared image draft missing',
      },
      {
        id: 'runner-failure',
        status: 'failed',
        screenshotPath: path.join(artifactsRoot, 'run-failed.png'),
        uiDumpPath: path.join(artifactsRoot, 'run-failed.xml'),
        logcatPath: path.join(artifactsRoot, 'run-failed-logcat.txt'),
        error: [
          'prompt: confidential report prompt words',
          'Authorization: Basic dXNlcjpwYXNzd29yZA==',
        ].join('\n'),
        details: [{ captureError: `secret=alpha beta gamma\npath=${path.join(tempDir, 'private', 'file.bin')}` }],
        deepDiagnostic,
        repeatedDiagnostics: Array.from({ length: 150 }, (_value, index) => `reason-${index}`),
        oversized: 'x'.repeat(4_096),
      },
      {
        id: 'project-root-artifact',
        status: 'failed',
        screenshotPath: path.join(projectRoot, 'artifacts', 'other-captures', 'capture.png'),
      },
      {
        id: 'outside-root-artifact',
        status: 'failed',
        screenshotPath: path.join(tempDir, 'outside-project', 'private-capture.png'),
      },
    ];

    try {
      const serializedResults = serializeReportResults(results, { artifactsRoot, projectRoot });

      expect(serializedResults).toEqual([
        expect.objectContaining({
          screenshotPath: 'home-smoke.png',
          checkpoints: [expect.objectContaining({
            screenshotPath: 'branch-regeneration/checkpoint.png',
            uiDumpPath: 'branch-regeneration/checkpoint.xml',
            logcatPath: 'branch-regeneration/checkpoint-logcat.txt',
          })],
        }),
        expect.objectContaining({ screenshotPath: 'bottom-tabs-failed.png' }),
        expect.objectContaining({
          screenshotPath: 'chat-attachment-text-only-fallback-skipped.png',
          skipReason: 'prepared image draft missing',
        }),
        expect.objectContaining({
          screenshotPath: 'run-failed.png',
          uiDumpPath: 'run-failed.xml',
          logcatPath: 'run-failed-logcat.txt',
        }),
        expect.objectContaining({ screenshotPath: 'artifacts/other-captures/capture.png' }),
        expect.objectContaining({ screenshotPath: '<external-artifact>' }),
      ]);
      expect(serializedResults[0]).not.toHaveProperty('rawLogPath');
      expect(serializedResults[0]).not.toHaveProperty('rawLogPaths');
      expect(serializedResults[0]).not.toHaveProperty('systemRawLogPath');
      expect(serializedResults[0]).not.toHaveProperty('logcatCollector');
      expect(JSON.stringify(serializedResults)).not.toContain('private.raw.log');
      expect(JSON.stringify(serializedResults)).not.toContain('secret.raw.log');
      expect(JSON.stringify(serializedResults)).not.toContain('confidential report prompt words');
      expect(JSON.stringify(serializedResults)).not.toContain('dXNlcjpwYXNzd29yZA');
      expect(JSON.stringify(serializedResults)).not.toContain('alpha beta gamma');
      expect(JSON.stringify(serializedResults)).not.toContain(tempDir);
      expect(serializedResults[3].details[0].captureError).toContain('<redacted>');
      expect(JSON.stringify(serializedResults[3].deepDiagnostic)).toContain('<max-depth>');
      expect(JSON.stringify(serializedResults[3].deepDiagnostic)).not.toContain('must-not-survive-depth-bound');
      expect(serializedResults[3].repeatedDiagnostics).toHaveLength(100);
      expect(serializedResults[3].oversized).toContain('<truncated:');

      for (const result of serializedResults) {
        for (const field of ['screenshotPath', 'uiDumpPath', 'logcatPath']) {
          if (result[field]) {
            expect(path.isAbsolute(result[field])).toBe(false);
            expect(result[field]).not.toContain(tempDir);
          }
        }
      }

      expect(results[0].screenshotPath).toBe(path.join(artifactsRoot, 'home-smoke.png'));
      expect(results[0].checkpoints[0].uiDumpPath).toBe(
        path.join(artifactsRoot, 'branch-regeneration', 'checkpoint.xml')
      );
      expect(results[3].uiDumpPath).toBe(path.join(artifactsRoot, 'run-failed.xml'));
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it('normalizes already-relative report paths', () => {
    expect(
      serializeReportResults([
        {
          id: 'relative-path',
          status: 'passed',
          screenshotPath: 'nested\\capture.png',
        },
      ])[0].screenshotPath
    ).toBe('nested/capture.png');
  });
});
