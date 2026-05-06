const path = require('path');

const {
  buildScenarios,
  buildSmokeLaunchArgs,
  findCatalogRiskModelCard,
  findAnyNodeClearOfBottomOverlay,
  findAnyNodeInSnapshot,
  findNodeInSnapshot,
  isBoundsClearOfBottomOverlay,
  isAppForegroundSnapshot,
  parseCliOptions,
  parseUiSnapshot,
  pickClosestNodePair,
  selectScenarios,
  ScenarioSkipError,
  restoreLanguageAfterScenario,
} = require('../../scripts/android-scenarios');

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

describe('android-scenarios npm defaults', () => {
  const packageJson = require('../../package.json');

  it('keeps the default npm scenario scripts on the fast core pack', () => {
    expect(packageJson.scripts['android:scenarios']).toContain('--pack core');
    expect(packageJson.scripts['android:scenarios:emulator']).toContain('--pack core');
  });

  it('exposes targeted scenario packs for dependency checks', () => {
    expect(packageJson.scripts['android:scenarios:dependency-ui']).toContain('--pack dependency-ui');
    expect(packageJson.scripts['android:scenarios:runtime']).toContain('--pack runtime');
    expect(packageJson.scripts['android:scenarios:native']).toContain('--pack native');
    expect(packageJson.scripts['android:scenarios:extended']).toContain('--pack extended');
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

  it('runs only core scenarios by default', () => {
    expect(selectScenarios(scenarios, parseCliOptions([])).map((scenario) => scenario.id)).toEqual([
      'home-smoke',
      'bottom-tabs',
      'new-chat-cta',
    ]);
  });

  it('includes secondary scenarios in the extended pack', () => {
    expect(selectScenarios(scenarios, parseCliOptions(['--pack', 'extended'])).map((scenario) => scenario.id)).toEqual([
      'home-smoke',
      'bottom-tabs',
      'new-chat-cta',
      'swap-model-cta',
      'hf-token-education',
      'conversations-management',
    ]);
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

  it('runs every scenario, including optional checks, only for the all pack', () => {
    const selectedIds = selectScenarios(scenarios, parseCliOptions(['--pack', 'all'])).map((scenario) => scenario.id);

    expect(selectedIds).toEqual(scenarios.map((scenario) => scenario.id));
    expect(selectedIds).toEqual(
      expect.arrayContaining([
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
});
