const { createTtsPublicSnapshotReader, getTtsControlTap, runTtsPublicControls } = require('../../scripts/lib/tts-public-controls');
const { parseUiSnapshot, findResourceIdInSnapshot, findResourceIdClearOfOverlays,
  scrollTtsPublicControlsIntoView } = require('../../scripts/android-scenarios');

function createNativeUi({ nonIdle = false, initialPhase = 'playing', initialPosition = 0.4,
  pauseFails = false, progressFails = false, resumeFails = false, stopFails = false, screenshotFails = false,
  russianWidths = false, mutateSnapshot = snapshot => snapshot } = {}) {
  let time = 0;
  let phase = initialPhase;
  let position = initialPhase === 'stopped' ? 8 : initialPosition;
  let motionKind;
  const events = [];
  const advance = milliseconds => {
    time += milliseconds;
    if (phase === 'playing' && !progressFails && !(resumeFails && motionKind === 'tts-play')) {
      position = Math.min(8, position + milliseconds / 1000);
      if (position === 8) phase = 'stopped';
    }
  };
  const controls = () => {
    const first = phase === 'playing' ? 'tts-pause' : 'tts-play';
    const width = russianWidths && first === 'tts-play' ? 260 : 100;
    const node = (left, right) => ({ enabled: true, clickable: true,
      bounds: { left, top: 600, right, bottom: 660 } });
    return { [first]: node(20, 20 + width), 'tts-replay': node(28 + width, 178 + width),
      'tts-stop': node(186 + width, 286 + width) };
  };
  const readSnapshot = jest.fn(async () => {
    events.push(['snapshot', phase]);
    if (nonIdle && phase === 'playing') {
      advance(5000); // The adb deadline expires while waiting for accessibility idle.
      throw new Error('non-idle');
    }
    return mutateSnapshot({ state: { phase, position, duration: 8, sampleRate: 24000, sampleCount: 192000,
      errorCode: null, privatePayload: 'must never reach receipts' }, controls: controls(),
    viewport: { left: 0, top: 0, right: 1080, bottom: 1920 } });
  });
  const tap = jest.fn(async (point, sourceId) => {
    const rendered = Object.entries(controls()).find(([, { bounds: b }]) => point.x > b.left
      && point.x < b.right && point.y > b.top && point.y < b.bottom)?.[0];
    events.push(['tap', sourceId, rendered, { ...point }]);
    if (rendered !== sourceId) throw new Error('Cached point missed the actual native control.');
    if (sourceId === 'tts-pause') { if (!pauseFails) phase = 'paused'; }
    else if (sourceId === 'tts-stop') { if (!stopFails) phase = 'stopped'; }
    else {
      if (sourceId === 'tts-replay') position = 0;
      phase = 'playing';
      motionKind = sourceId;
    }
  });
  const captureScreenshot = jest.fn(async name => {
    events.push(['screenshot', phase, name]);
    advance(100);
    if (screenshotFails) throw new Error('screenshot failed');
  });
  const options = { readSnapshot, tap, captureScreenshot, delay: async ms => advance(ms), now: () => time,
    initialTimeoutMs: 20000, settleTimeoutMs: 1500,
    isTransientObservationError: error => error.message === 'non-idle' };
  return { options, events, phase: () => phase, advance };
}

describe('ordinary TTS native control observation', () => {
  it('waits for EOF when playing controls are offscreen, scrolls only static states, and then uses fresh visible bounds', async () => {
    let visible = false;
    const ui = createNativeUi({ mutateSnapshot: snapshot => {
      if (!visible) Object.values(snapshot.controls).forEach(node => {
        node.bounds.top += 2000; node.bounds.bottom += 2000;
      });
      return snapshot;
    } });
    const rawRead = ui.options.readSnapshot;
    const scroll = jest.fn(async () => {
      ui.events.push(['scroll', ui.phase()]); visible = true;
    });
    ui.options.readSnapshot = createTtsPublicSnapshotReader({ readSnapshot: rawRead, bringControlsIntoView: scroll });
    const result = await runTtsPublicControls(ui.options);
    expect(result.firstObservation).toBe('natural_eof');
    expect(scroll).toHaveBeenCalled();
    expect(ui.events.filter(event => event[0] === 'scroll').every(event => ['paused', 'stopped'].includes(event[1]))).toBe(true);
    const firstScroll = ui.events.findIndex(event => event[0] === 'scroll');
    const firstTap = ui.events.findIndex(event => event[0] === 'tap');
    expect(firstScroll).toBeLessThan(firstTap);
    expect(ui.events[firstTap][3].y).toBeLessThan(660);
    expect(ui.phase()).toBe('stopped');
  });

  it.each(['playing', 'loading', null])('never starts controls scrolling in moving or incomplete state %s', async phase => {
    const snapshot = { state: { phase, sampleCount: 192000 } };
    const readSnapshot = jest.fn(async () => snapshot);
    const bringControlsIntoView = jest.fn();
    const read = createTtsPublicSnapshotReader({ readSnapshot, bringControlsIntoView });
    expect(await read()).toBe(snapshot);
    expect(bringControlsIntoView).not.toHaveBeenCalled();
    expect(readSnapshot).toHaveBeenCalledTimes(1);
  });

  it.each(['paused', 'stopped'])('discards pre-scroll coordinates and reads fresh native controls for %s', async phase => {
    const initial = { state: { phase, sampleCount: 192000 }, controls: { 'tts-play': { bounds: { top: 2200 } } } };
    const fresh = { state: { phase, sampleCount: 192000 }, controls: { 'tts-play': { bounds: { top: 600 } } } };
    const readSnapshot = jest.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(fresh);
    const bringControlsIntoView = jest.fn();
    const read = createTtsPublicSnapshotReader({ readSnapshot, bringControlsIntoView });
    expect(await read()).toBe(fresh);
    expect(bringControlsIntoView).toHaveBeenCalledTimes(1);
    expect(readSnapshot).toHaveBeenCalledTimes(2);
  });

  it('does not return stale controls if static scrolling fails', async () => {
    const readSnapshot = jest.fn(async () => ({ state: { phase: 'stopped', sampleCount: 192000 } }));
    const read = createTtsPublicSnapshotReader({ readSnapshot, bringControlsIntoView: async () => {
      throw new Error('controls remain unavailable');
    } });
    await expect(read()).rejects.toThrow('controls remain unavailable');
    expect(readSnapshot).toHaveBeenCalledTimes(1);
  });

  it('recovers a playing window missed by non-idle dumps and proves all controls through paused native progress', async () => {
    const ui = createNativeUi({ nonIdle: true });
    const result = await runTtsPublicControls(ui.options);
    expect(result).toMatchObject({ status: 'passed', synthesis: 'passed', playback: 'passed', pause: 'passed',
      stop: 'passed', replay: 'passed', firstObservation: 'natural_eof', sampleRate: 24000, sampleCount: 192000,
      contentVerification: 'not_run' });
    expect(result.observedPausedPositions.map(value => value.sourceIds)).toEqual([
      ['tts-replay', 'tts-pause'], ['tts-play', 'tts-pause'], ['tts-replay', 'tts-pause'],
    ]);
    const positions = result.observedPausedPositions.map(value => value.position);
    expect(positions.every(value => value > 0 && value < 8)).toBe(true);
    expect(positions[1]).toBeGreaterThan(positions[0]);
    expect(result.fastScreenshots).toEqual(['tts-public-initial-playing.png',
      'tts-public-resume-playing.png', 'tts-public-replay-playing.png']);
    const firstTap = ui.events.findIndex(value => value[0] === 'tap');
    expect(ui.events.slice(firstTap).filter(value => value[0] === 'snapshot')
      .every(value => value[1] !== 'playing')).toBe(true);
    expect(ui.events.filter(value => value[0] === 'screenshot').every(value => value[1] === 'playing')).toBe(true);
    expect(ui.phase()).toBe('stopped');
    expect(JSON.stringify(result)).not.toContain('privatePayload');
    expect(JSON.stringify(result)).not.toContain('must never reach receipts');
  });

  it('pauses an initially observed playing clip immediately before any motion screenshot or another snapshot', async () => {
    const ui = createNativeUi();
    const result = await runTtsPublicControls(ui.options);
    expect(result.firstObservation).toBe('playing');
    expect(ui.events.slice(0, 3).map(value => value.slice(0, 2))).toEqual([
      ['snapshot', 'playing'], ['tap', 'tts-pause'], ['snapshot', 'paused'],
    ]);
    expect(result.fastScreenshots).toHaveLength(2);
  });

  it('uses the observed left/top interior when Russian Play is wider than the native Pause replacement', async () => {
    const ui = createNativeUi({ initialPhase: 'stopped', russianWidths: true });
    await runTtsPublicControls(ui.options);
    const pauses = ui.events.filter(value => value[0] === 'tap' && value[1] === 'tts-pause');
    expect(pauses).toHaveLength(3);
    expect(pauses.every(value => value[2] === 'tts-pause' && value[3].x < 120 && value[3].y < 660)).toBe(true);
  });

  it.each([
    [{ progressFails: true, initialPhase: 'stopped' }, 'a replay never advances'],
    [{ resumeFails: true }, 'resume stays at the previously observed paused position'],
    [{ pauseFails: true }, 'Pause never becomes paused'],
    [{ stopFails: true }, 'Stop never becomes stopped'],
  ])('refuses success when %s (%s)', async settings => {
    const ui = createNativeUi(settings);
    await expect(runTtsPublicControls(ui.options)).rejects.toThrow(/did not settle/);
  });

  it('still taps cached Pause when direct screenshot capture rejects', async () => {
    const ui = createNativeUi({ initialPhase: 'stopped', screenshotFails: true });
    await expect(runTtsPublicControls(ui.options)).rejects.toThrow('screenshot failed');
    expect(ui.events.filter(value => value[0] === 'tap').map(value => value[1])).toEqual(['tts-replay', 'tts-pause']);
    expect(ui.phase()).toBe('paused');
  });

  it('does not read hierarchy while a deferred screenshot is pending and pauses on its rejection', async () => {
    const ui = createNativeUi({ initialPhase: 'stopped' });
    let rejectScreenshot;
    let signalStarted;
    const started = new Promise(resolve => { signalStarted = resolve; });
    ui.options.captureScreenshot = jest.fn(() => new Promise((_, reject) => {
      rejectScreenshot = reject;
      signalStarted();
    }));
    const work = runTtsPublicControls(ui.options);
    const failure = expect(work).rejects.toThrow('deferred screenshot failed');
    await started;
    expect(ui.options.readSnapshot).toHaveBeenCalledTimes(1);
    expect(ui.phase()).toBe('playing');
    rejectScreenshot(new Error('deferred screenshot failed'));
    await failure;
    expect(ui.phase()).toBe('paused');
  });

  it.each([
    snapshot => { snapshot.controls['tts-play'].enabled = false; },
    snapshot => { snapshot.controls['tts-play'].clickable = false; },
    snapshot => { snapshot.controls['tts-play'].bounds.right = 20; },
    snapshot => { snapshot.controls['tts-play'].bounds.top = -1; },
    snapshot => { snapshot.controls['tts-play'].bounds.bottom = 1930; },
    snapshot => { snapshot.controls['tts-play'].bounds.left = Number.NaN; },
    snapshot => { snapshot.viewport = null; },
    snapshot => { delete snapshot.controls['tts-replay']; },
  ])('rejects unavailable, malformed, or off-screen cached controls before native taps: %#', async mutate => {
    const ui = createNativeUi({ initialPhase: 'stopped', mutateSnapshot: snapshot => { mutate(snapshot); return snapshot; } });
    await expect(runTtsPublicControls(ui.options)).rejects.toThrow(/cached bounds/);
    expect(ui.options.tap).not.toHaveBeenCalled();
  });

  it('rejects replaced clip metadata after Pause rather than accepting progress from another clip', async () => {
    const ui = createNativeUi({ mutateSnapshot: snapshot => {
      if (snapshot.state.phase === 'paused') snapshot.state.sampleCount -= 320;
      return snapshot;
    } });
    await expect(runTtsPublicControls(ui.options)).rejects.toThrow(/changed or lost/);
  });

  it('propagates native player errors without exposing their contents or taking more actions', async () => {
    const ui = createNativeUi({ mutateSnapshot: snapshot => {
      snapshot.state.errorCode = 'private underlying error text'; return snapshot;
    } });
    await expect(runTtsPublicControls(ui.options)).rejects.toThrow('Public TTS controls reported an error.');
    expect(ui.options.tap).not.toHaveBeenCalled();
  });

  it('does not hide unrelated UI driver failures as transient non-idle observation', async () => {
    const ui = createNativeUi();
    ui.options.readSnapshot.mockRejectedValue(new Error('unrelated failure'));
    await expect(runTtsPublicControls(ui.options)).rejects.toThrow('unrelated failure');
    expect(ui.options.tap).not.toHaveBeenCalled();
  });

  it.each([0, -1, Number.NaN, 600001])('rejects an invalid observation budget %s before reading the device', async initialTimeoutMs => {
    const ui = createNativeUi();
    await expect(runTtsPublicControls({ ...ui.options, initialTimeoutMs })).rejects.toThrow(/budget/);
    expect(ui.options.readSnapshot).not.toHaveBeenCalled();
  });

  it('derives a safe interior point only from an observed enabled control within the viewport', () => {
    expect(getTtsControlTap({ enabled: true, clickable: true,
      bounds: { left: 40, top: 70, right: 240, bottom: 130 } },
    { left: 0, top: 0, right: 1080, bottom: 1920 })).toEqual({ x: 52, y: 82 });
  });
});

function modalSnapshot(state, { visible = true, sheet = '[0,450][1080,1100]',
  scroll = '[0,500][1080,1000]', extraScroll = '', controlTop = 600 } = {}) {
  const marker = JSON.stringify(state).replace(/"/gu, '&quot;');
  const top = visible ? controlTop : 2600;
  const firstControl = state.phase === 'playing' ? 'tts-pause' : 'tts-play';
  return parseUiSnapshot(`<hierarchy><node bounds="[0,0][1080,2400]" />
    <node resource-id="tts-preview-sheet" bounds="${sheet}" />
    <node resource-id="chat-qa-tts-playback-state" content-desc="${marker}" bounds="[0,451][1,452]" />
    <node class="android.widget.ScrollView" bounds="${scroll}" />${extraScroll}
    <node resource-id="${firstControl}" bounds="[20,${top}][120,${top + 60}]" clickable="true" />
    <node resource-id="tts-replay" bounds="[128,${top}][278,${top + 60}]" clickable="true" />
    <node resource-id="tts-stop" bounds="[286,${top}][386,${top + 60}]" clickable="true" />
  </hierarchy>`);
}

const staticClip = { phase: 'stopped', position: 8, duration: 8, sampleRate: 24000, sampleCount: 192000 };

describe('public TTS observer with actual Modal scroll integration', () => {
  it('recovers missed EOF through observed Modal gestures, then verifies native Pause/Play/Stop/Replay using fresh controls', async () => {
    let visible = false;
    const ui = createNativeUi({ mutateSnapshot: snapshot => {
      if (!visible) Object.values(snapshot.controls).forEach(node => {
        node.bounds.top += 2000; node.bounds.bottom += 2000;
      });
      return snapshot;
    } });
    const rawRead = ui.options.readSnapshot;
    const createSnapshot = jest.fn(async () => {
      const raw = await rawRead();
      return modalSnapshot(raw.state, { visible });
    });
    const swipe = jest.fn(async gesture => {
      expect(ui.phase()).toBe('stopped');
      // The old full-screen gesture starts at 1700, outside this actual ScrollView.
      expect(gesture.startY).toBeGreaterThan(500);
      expect(gesture.startY).toBeLessThan(1000);
      expect(gesture.endY).toBeGreaterThan(500);
      expect(gesture.endY).toBeLessThan(gesture.startY);
      expect(gesture.startX).toBeGreaterThan(0);
      expect(gesture.startX).toBeLessThan(1080);
      ui.events.push(['modal-swipe', ui.phase()]);
      visible = true;
    });
    const readSnapshot = async () => {
      const snapshot = await createSnapshot();
      const state = JSON.parse(findResourceIdInSnapshot(snapshot, 'chat-qa-tts-playback-state').contentDesc);
      return { state, viewport: snapshot.viewportBounds, controls: Object.fromEntries(
        ['tts-play', 'tts-pause', 'tts-replay', 'tts-stop'].map(id => [id, findResourceIdInSnapshot(snapshot, id)])) };
    };
    ui.options.readSnapshot = createTtsPublicSnapshotReader({ readSnapshot,
      bringControlsIntoView: () => scrollTtsPublicControlsIntoView({ serial: 'observed-device' }, {
        adbPath: 'unused-adb', createSnapshot, swipe, now: ui.options.now,
      }) });
    const result = await runTtsPublicControls(ui.options);
    expect(result).toMatchObject({ status: 'passed', firstObservation: 'natural_eof', pause: 'passed',
      playback: 'passed', stop: 'passed', replay: 'passed' });
    expect(swipe).toHaveBeenCalledTimes(1);
    const firstSwipe = ui.events.findIndex(event => event[0] === 'modal-swipe');
    const firstTap = ui.events.findIndex(event => event[0] === 'tap');
    expect(firstTap).toBeGreaterThan(firstSwipe);
    expect(ui.events[firstTap][3].y).toBeLessThan(660);
    expect(ui.events.slice(firstTap).filter(event => event[0] === 'snapshot')
      .every(event => event[1] !== 'playing')).toBe(true);
  });

  it('accepts controls wholly inside the observed Modal viewport without applying the screen bottom-tab overlay', async () => {
    const snapshot = modalSnapshot(staticClip, { sheet: '[0,1800][1080,2400]',
      scroll: '[0,1900][1080,2340]', controlTop: 2240 });
    expect(findResourceIdClearOfOverlays(snapshot, 'tts-stop')).toBeNull();
    const createSnapshot = jest.fn(() => snapshot);
    const swipe = jest.fn();
    expect(await scrollTtsPublicControlsIntoView({ serial: 'device' }, { adbPath: 'unused', createSnapshot, swipe }))
      .toBe(snapshot);
    expect(swipe).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', { scroll: '[0,0][0,0]' }],
    ['ambiguous', { extraScroll: '<node class="android.widget.ScrollView" bounds="[0,500][1080,1000]" />' }],
    ['clipped scroll', { scroll: '[0,500][1080,1200]' }],
    ['clipped sheet', { sheet: '[0,450][1080,2500]' }],
  ])('rejects %s viewport instead of sending a fallback gesture', async (_label, geometry) => {
    const createSnapshot = jest.fn(() => modalSnapshot(staticClip, { ...geometry, visible: false }));
    const swipe = jest.fn();
    await expect(scrollTtsPublicControlsIntoView({ serial: 'device' }, { adbPath: 'unused', createSnapshot, swipe }))
      .rejects.toThrow(/viewport/);
    expect(swipe).not.toHaveBeenCalled();
  });

  it.each(['playing', 'loading', null])('rejects motion/incomplete state %s before scrolling', async phase => {
    const createSnapshot = jest.fn(() => modalSnapshot({ ...staticClip, phase }, { visible: false }));
    const swipe = jest.fn();
    await expect(scrollTtsPublicControlsIntoView({ serial: 'device' }, { adbPath: 'unused', createSnapshot, swipe }))
      .rejects.toThrow(/static generated clip/);
    expect(swipe).not.toHaveBeenCalled();
  });

  it('rechecks the static state after a gesture and refuses another swipe when playback changed', async () => {
    const createSnapshot = jest.fn()
      .mockReturnValueOnce(modalSnapshot(staticClip, { visible: false }))
      .mockReturnValue(modalSnapshot({ ...staticClip, phase: 'playing' }, { visible: false }));
    const swipe = jest.fn();
    await expect(scrollTtsPublicControlsIntoView({ serial: 'device' }, { adbPath: 'unused', createSnapshot, swipe }))
      .rejects.toThrow(/static generated clip/);
    expect(swipe).toHaveBeenCalledTimes(1);
  });

  it('fails closed after four observed gestures when controls remain clipped', async () => {
    const createSnapshot = jest.fn(() => modalSnapshot(staticClip, { visible: false }));
    const swipe = jest.fn();
    await expect(scrollTtsPublicControlsIntoView({ serial: 'device' }, { adbPath: 'unused', createSnapshot, swipe }))
      .rejects.toThrow(/controls remain outside/);
    expect(swipe).toHaveBeenCalledTimes(4);
    expect(createSnapshot).toHaveBeenCalledTimes(5);
  });
});
