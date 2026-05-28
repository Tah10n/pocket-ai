const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  buildScenarios,
  buildSmokeLaunchArgs,
  captureAndroidScreenshot,
  dumpUiHierarchy,
  findCatalogRiskModelCard,
  findQuantizationSelectorNodeClearOfBottomOverlay,
  findBlockingSystemDialogAction,
  findAnyNodeClearOfBottomOverlay,
  findAnyNodeInSnapshot,
  findNodeInSnapshot,
  isBoundsClearOfBottomOverlay,
  isAppForegroundSnapshot,
  openFirstVisibleVariantPicker,
  parseCliOptions,
  parseUiSnapshot,
  pickClosestNodePair,
  prepareCatalogForVariantPickerSmokeScenario,
  selectScenarios,
  ScenarioSkipError,
  restoreLanguageAfterScenario,
  assertAttachmentPreviewRemovePreconditions,
  assertAttachmentActionBlocked,
  assertAttachmentActionAvailable,
  assertAttachmentTextOnlyFallbackState,
  ScenarioSkipFailureError,
  serializeReportResults,
  shouldAppendRunnerFailure,
} = require('../../scripts/android-scenarios');

describe('app image picker configuration', () => {
  const appConfig = require('../../app.json');

  it('declares gallery-only image picker permissions explicitly', () => {
    const imagePickerPlugin = appConfig.expo.plugins.find(
      (plugin) => Array.isArray(plugin) && plugin[0] === 'expo-image-picker'
    );

    expect(imagePickerPlugin).toEqual([
      'expo-image-picker',
      expect.objectContaining({
        photosPermission: expect.stringContaining('photo library'),
        cameraPermission: false,
        microphonePermission: false,
      }),
    ]);
    expect(appConfig.expo.android.permissions).not.toContain('CAMERA');
    expect(appConfig.expo.android.permissions).not.toContain('RECORD_AUDIO');
  });
});

describe('android-scenarios smoke bootstrap args', () => {
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

describe('android-scenarios screenshot capture', () => {
  const pngBuffer = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
  ]);

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
        return directAttempts === 1
          ? {
              status: 1,
              stdout: Buffer.alloc(0),
              stderr: "error: device 'device-1' not found",
            }
          : {
              status: 0,
              stdout: pngBuffer,
              stderr: '',
            };
      }

      if (args.includes('screencap')) {
        return {
          status: 1,
          stdout: '',
          stderr: 'adb.exe: device offline',
        };
      }

      return {
        status: 0,
        stdout: '',
        stderr: '',
      };
    });

    try {
      expect(captureAndroidScreenshot('adb', 'device-1', screenshotPath, {
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
      expect(fs.readFileSync(screenshotPath).subarray(0, 8)).toEqual(pngBuffer.subarray(0, 8));
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
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
    expect(packageJson.scripts['android:scenarios:attachments']).toContain('--pack attachments');
    expect(packageJson.scripts['android:scenarios:attachments-prepared']).toContain('--pack attachments-prepared');
    expect(packageJson.scripts['android:scenarios:dependency-ui']).toContain('--pack dependency-ui');
    expect(packageJson.scripts['android:scenarios:runtime']).toContain('--pack runtime');
    expect(packageJson.scripts['android:scenarios:native']).toContain('--pack native');
    expect(packageJson.scripts['android:scenarios:extended']).toContain('--pack extended');
  });

  it('keeps vision-adjacent smoke verification self-contained and leaves prepared coverage opt-in', () => {
    const smokeScript = packageJson.scripts['verify:mobile-change:android:vision-smoke'];

    expect(packageJson.scripts['verify:mobile-change:android:vision']).toBe(
      'npm run verify:mobile-change:android:vision-smoke'
    );
    expect(smokeScript).toContain('verify:mobile-change');
    expect(smokeScript).toContain('android:scenarios:runtime');
    expect(smokeScript).toContain('android:scenarios:catalog');
    expect(smokeScript).toContain('android:scenarios:attachments');
    expect(smokeScript).not.toContain('android:scenarios:attachments-prepared');
    expect(packageJson.scripts['android:scenarios:attachments-prepared']).toContain('--fail-on-skip');
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

  it('matches normalized content descriptions from the same snapshot', () => {
    const node = findNodeInSnapshot(snapshot, 'Settings', { visibleOnly: true });

    expect(node).toBeTruthy();
    expect(node.clickable).toBe(true);
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
      .mockResolvedValueOnce({ node: { bounds: { centerX: 100, centerY: 100 } } })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ label: 'Clear' })
      .mockResolvedValueOnce({ label: 'No token required' });

    await prepareCatalogForVariantPickerSmokeScenario(ctx, {
      resolveAdbPath: () => 'adb',
      findAnyNodeNow,
    });

    expect(ctx.tapAnyText).toHaveBeenNthCalledWith(
      1,
      expect.arrayContaining(['All Models']),
      expect.objectContaining({ timeoutMs: 5_000 })
    );
    expect(ctx.tapAnyText).toHaveBeenNthCalledWith(
      2,
      expect.arrayContaining(['Filters']),
      expect.objectContaining({ timeoutMs: 8_000 })
    );
    expect(ctx.tapAnyText).toHaveBeenNthCalledWith(
      3,
      expect.arrayContaining(['Clear']),
      expect.objectContaining({ timeoutMs: 5_000 })
    );
    expect(ctx.tapAnyText).toHaveBeenNthCalledWith(
      4,
      expect.arrayContaining(['Filters']),
      expect.objectContaining({ timeoutMs: 5_000 })
    );
    expect(ctx.expectAnyText).toHaveBeenCalledWith(expect.arrayContaining(['No token required']), { timeoutMs: 8_000 });
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
    expect(sleepSync).toHaveBeenCalledWith(1);
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

  it('runs the variant picker smoke check from the catalog pack', () => {
    expect(selectScenarios(scenarios, parseCliOptions(['--pack', 'catalog'])).map((scenario) => scenario.id)).toEqual([
      'variant-picker-smoke',
    ]);
  });

  it('selects deterministic composer image attachment checks from the attachments pack', () => {
    expect(selectScenarios(scenarios, parseCliOptions(['--pack', 'attachments'])).map((scenario) => scenario.id)).toEqual([
      'chat-attachment-text-only-fallback',
    ]);
  });

  it('keeps prepared image draft coverage in an explicit prepared attachments pack', () => {
    expect(selectScenarios(scenarios, parseCliOptions(['--pack', 'attachments-prepared'])).map((scenario) => scenario.id)).toEqual([
      'chat-attachment-preview-remove',
    ]);
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
    })).toThrow(/precondition failed: the composer is still showing text-only fallback copy/);

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
    })).toThrow(/deterministic text-only composer could not be established/);

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
    expect(() => assertAttachmentActionAvailable({ clickable: false, enabled: true })).not.toThrow();
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

  it('runs every scenario, including optional checks, only for the all pack', () => {
    const selectedIds = selectScenarios(scenarios, parseCliOptions(['--pack', 'all'])).map((scenario) => scenario.id);

    expect(selectedIds).toEqual(scenarios.map((scenario) => scenario.id));
    expect(selectedIds).toEqual(
      expect.arrayContaining([
        'variant-picker-smoke',
        'chat-attachment-text-only-fallback',
        'chat-attachment-preview-remove',
        'hf-catalog-hardening',
        'memory-fit-badges',
        'memory-fit-download-warning',
        'performance-logcat',
      ])
    );
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

  it('parses fail-on-skip for verification packs that require prepared state', () => {
    expect(parseCliOptions(['--pack', 'attachments-prepared', '--fail-on-skip'])).toEqual(
      expect.objectContaining({
        pack: 'attachments-prepared',
        failOnSkip: true,
      })
    );
  });

  it('does not append a runner failure for skips already recorded as failed scenarios', () => {
    expect(shouldAppendRunnerFailure(new ScenarioSkipFailureError('already recorded'))).toBe(false);
    expect(shouldAppendRunnerFailure(new Error('real runner failure'))).toBe(true);
  });
});

describe('android-scenarios report path serialization', () => {
  it('stores artifact paths as relative report paths for all result outcomes', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-ai-report-paths-'));
    const projectRoot = path.join(tempDir, 'project');
    const artifactsRoot = path.join(projectRoot, 'artifacts', 'android-scenarios');
    const results = [
      {
        id: 'home-smoke',
        status: 'passed',
        screenshotPath: path.join(artifactsRoot, 'home-smoke.png'),
      },
      {
        id: 'bottom-tabs',
        status: 'failed',
        screenshotPath: path.join(artifactsRoot, 'bottom-tabs-failed.png'),
      },
      {
        id: 'chat-attachment-preview-remove',
        status: 'failed',
        screenshotPath: path.join(artifactsRoot, 'chat-attachment-preview-remove-skipped.png'),
        skipReason: 'prepared image draft missing',
      },
      {
        id: 'runner-failure',
        status: 'failed',
        screenshotPath: path.join(artifactsRoot, 'run-failed.png'),
        uiDumpPath: path.join(artifactsRoot, 'run-failed.xml'),
        logcatPath: path.join(artifactsRoot, 'run-failed-logcat.txt'),
      },
      {
        id: 'project-root-artifact',
        status: 'failed',
        screenshotPath: path.join(projectRoot, 'artifacts', 'other-captures', 'capture.png'),
      },
    ];

    try {
      const serializedResults = serializeReportResults(results, { artifactsRoot, projectRoot });

      expect(serializedResults).toEqual([
        expect.objectContaining({ screenshotPath: 'home-smoke.png' }),
        expect.objectContaining({ screenshotPath: 'bottom-tabs-failed.png' }),
        expect.objectContaining({
          screenshotPath: 'chat-attachment-preview-remove-skipped.png',
          skipReason: 'prepared image draft missing',
        }),
        expect.objectContaining({
          screenshotPath: 'run-failed.png',
          uiDumpPath: 'run-failed.xml',
          logcatPath: 'run-failed-logcat.txt',
        }),
        expect.objectContaining({ screenshotPath: 'artifacts/other-captures/capture.png' }),
      ]);

      for (const result of serializedResults) {
        for (const field of ['screenshotPath', 'uiDumpPath', 'logcatPath']) {
          if (result[field]) {
            expect(path.isAbsolute(result[field])).toBe(false);
            expect(result[field]).not.toContain(tempDir);
          }
        }
      }

      expect(results[0].screenshotPath).toBe(path.join(artifactsRoot, 'home-smoke.png'));
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
