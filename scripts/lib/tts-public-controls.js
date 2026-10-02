'use strict';

function getTtsControlTap(node, viewport) {
  const b = node?.bounds;
  const valid = value => value && ['left', 'top', 'right', 'bottom'].every(key => Number.isSafeInteger(value[key]))
    && value.left >= 0 && value.top >= 0 && value.right - value.left >= 8 && value.bottom - value.top >= 8;
  if (!node?.enabled || node.clickable !== true || !valid(b) || !valid(viewport)
    || b.left < viewport.left || b.top < viewport.top || b.right > viewport.right || b.bottom > viewport.bottom) {
    throw new Error('Public TTS control has invalid or unavailable cached bounds.');
  }
  // Play and Pause share the first flow slot; their EN/RU label widths can differ.
  return { x: b.left + Math.min(12, Math.floor((b.right - b.left) / 4)),
    y: b.top + Math.min(12, Math.floor((b.bottom - b.top) / 4)) };
}

/** Scroll only a static generated clip, then discard the old coordinates. */
function createTtsPublicSnapshotReader({ readSnapshot, bringControlsIntoView }) {
  return async () => {
    let snapshot = await readSnapshot();
    if (['paused', 'stopped'].includes(snapshot?.state?.phase)
      && Number.isSafeInteger(snapshot.state.sampleCount) && snapshot.state.sampleCount > 0
      && snapshot.state.sampleCount <= 768000) {
      await bringControlsIntoView();
      snapshot = await readSnapshot();
    }
    return snapshot;
  };
}

/** Native snapshots are read only initially and after a cached Pause/Stop settles. */
async function runTtsPublicControls({ readSnapshot, tap, captureScreenshot, delay, now = Date.now,
  initialTimeoutMs = 600000, settleTimeoutMs = 30000, isTransientObservationError = () => false }) {
  for (const budget of [initialTimeoutMs, settleTimeoutMs]) {
    if (!Number.isSafeInteger(budget) || budget < 1 || budget > 600000) throw new Error('Invalid TTS observation budget.');
  }
  const wait = async (predicate, timeoutMs) => {
    const deadline = now() + timeoutMs;
    do {
      let snapshot;
      try { snapshot = await readSnapshot(); }
      catch (error) { if (!isTransientObservationError(error)) throw error; }
      if (snapshot?.state?.errorCode) throw new Error('Public TTS controls reported an error.');
      if (snapshot && predicate(snapshot)) return snapshot;
      await delay(250);
    } while (now() < deadline);
    throw new Error('Public TTS player did not settle in the requested state.');
  };
  const controlsReady = snapshot => ['tts-pause', 'tts-replay', 'tts-stop'].every(id => {
    try { getTtsControlTap(snapshot.controls?.[id], snapshot.viewport); return true; }
    catch { return false; }
  });
  const initial = await wait(snapshot => {
    const s = snapshot.state;
    return s && Number.isFinite(s.position) && Number.isFinite(s.duration) && s.duration > 0
      && ((s.phase === 'playing' && s.position > 0 && s.position < s.duration && controlsReady(snapshot))
        || (s.phase === 'stopped' && s.position === s.duration));
  }, initialTimeoutMs);
  const clip = initial.state;
  if (!Number.isSafeInteger(clip.sampleRate) || clip.sampleRate < 8000 || clip.sampleRate > 192000
    || !Number.isSafeInteger(clip.sampleCount) || clip.sampleCount < 1 || clip.sampleCount > 768000
    || clip.duration > 16 || Math.abs(clip.duration - clip.sampleCount / clip.sampleRate) > 1 / clip.sampleRate) {
    throw new Error('Public TTS playback metadata is invalid.');
  }
  const sameClip = snapshot => {
    const s = snapshot.state;
    if (!s || s.sampleCount !== clip.sampleCount || s.sampleRate !== clip.sampleRate || s.duration !== clip.duration
      || !Number.isFinite(s.position) || s.position < 0 || s.position > s.duration) {
      throw new Error('Public TTS playback changed or lost its clip.');
    }
    return s;
  };
  const point = (snapshot, id) => getTtsControlTap(snapshot.controls?.[id], snapshot.viewport);
  const slot = snapshot => point(snapshot, snapshot.state.phase === 'playing' ? 'tts-pause' : 'tts-play');
  const pausedPositions = [];
  const fastScreenshots = [];
  const pauseProof = async (minimum, sourceIds) => {
    const snapshot = await wait(candidate => {
      const s = sameClip(candidate);
      return s.phase === 'paused' && s.position > minimum && s.position < s.duration;
    }, settleTimeoutMs);
    pausedPositions.push({ sourceIds, position: snapshot.state.position });
    return snapshot;
  };
  const motion = async (snapshot, startId, minimum, name) => {
    const pausePoint = slot(snapshot);
    await tap(point(snapshot, startId), startId);
    try {
      await delay(Math.min(800, Math.max(1, Math.floor((clip.duration - minimum) * 1000 / 4))));
      await captureScreenshot(name);
      fastScreenshots.push(name);
    } finally {
      // A failed screenshot must not leave playback running or postpone Pause for a hierarchy dump.
      await tap(pausePoint, 'tts-pause');
    }
    return pauseProof(minimum, [startId, 'tts-pause']);
  };
  const stop = async snapshot => {
    await tap(point(snapshot, 'tts-stop'), 'tts-stop');
    return wait(candidate => sameClip(candidate).phase === 'stopped', settleTimeoutMs);
  };
  const firstObservation = clip.phase === 'playing' ? 'playing' : 'natural_eof';
  let paused;
  if (firstObservation === 'playing') {
    await tap(slot(initial), 'tts-pause');
    paused = await pauseProof(0, ['tts-pause']);
  } else {
    paused = await motion(initial, 'tts-replay', 0, 'tts-public-initial-playing.png');
  }
  paused = await motion(paused, 'tts-play', paused.state.position, 'tts-public-resume-playing.png');
  const stopped = await stop(paused);
  paused = await motion(stopped, 'tts-replay', 0, 'tts-public-replay-playing.png');
  await stop(paused);
  return { status: 'passed', synthesis: 'passed', playback: 'passed', pause: 'passed', stop: 'passed', replay: 'passed',
    sampleRate: clip.sampleRate, sampleCount: clip.sampleCount, contentVerification: 'not_run',
    firstObservation, fastScreenshots, observedPausedPositions: pausedPositions };
}

module.exports = { createTtsPublicSnapshotReader, getTtsControlTap, runTtsPublicControls };
