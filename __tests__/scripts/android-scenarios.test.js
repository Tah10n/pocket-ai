const path = require('path');

const {
  buildScenarios,
  buildSmokeLaunchArgs,
  findCatalogRiskModelCard,
  findAnyNodeInSnapshot,
  findNodeInSnapshot,
  isAppForegroundSnapshot,
  parseCliOptions,
  parseUiSnapshot,
  pickClosestNodePair,
  selectScenarios,
  ScenarioSkipError,
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

  it('keeps the npm scenario script on the extended stable pack', () => {
    expect(packageJson.scripts['android:scenarios']).toContain('--pack extended');
    expect(packageJson.scripts['android:scenarios:emulator']).toContain('--pack extended');
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

  it('keeps direct scenario selection working for optional checks', () => {
    expect(selectScenarios(scenarios, parseCliOptions(['--scenario', 'memory-fit-download-warning'])).map((scenario) => scenario.id)).toEqual([
      'memory-fit-download-warning',
    ]);
  });
});

describe('android-scenarios skip signaling', () => {
  it('uses a dedicated skip error for non-verifiable optional scenarios', () => {
    const error = new ScenarioSkipError('skip this');

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('skip this');
  });
});
