import { AppState, type AppStateStatus } from 'react-native';
import { ttsService, type TtsServiceState } from '../../src/services/TtsService';
import { continueAndroidQaTts, waitForAndroidQaTtsPublicControls } from '../../src/services/AndroidQaTts';

jest.mock('../../src/services/TtsService', () => ({ ttsService: { getState: jest.fn() }, resolveTtsBinding: jest.fn() }));
jest.mock('../../src/services/AndroidQaDocumentModelBootstrap', () => ({
  isAndroidQaDocumentModelBootstrapEnabled: () => true, ANDROID_QA_DOCUMENT_MODEL_ID: 'qa-model',
}));

describe('single-clip QA background acceptance', () => {
  let state: TtsServiceState;
  let notify: (next: AppStateStatus) => void;
  let remove: jest.Mock;
  let listener: jest.SpyInstance;
  beforeEach(() => {
    jest.useFakeTimers();
    state = { phase: 'ready', clipAvailable: true };
    jest.mocked(ttsService.getState).mockImplementation(() => state);
    remove = jest.fn();
    listener = jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, callback) => {
      notify = callback;
      return { remove };
    });
  });
  afterEach(() => { listener.mockRestore(); jest.useRealTimers(); });

  it('accepts background only while the retained clip is actually playing', async () => {
    const work = waitForAndroidQaTtsPublicControls();
    state = { phase: 'playing', clipAvailable: true };
    notify('background');
    state = { phase: null };
    notify('active');
    continueAndroidQaTts();
    await expect(work).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each<TtsServiceState>([
    { phase: null },
    { phase: 'paused', clipAvailable: true },
    { phase: 'stopped', clipAvailable: true },
    { phase: 'starting', clipAvailable: true },
    { phase: 'playing', clipAvailable: false },
    { phase: 'playing', clipAvailable: true, errorCode: 'playback_failed' },
  ])('rejects a stale prior playing state when background begins from %j', async inactive => {
    const work = waitForAndroidQaTtsPublicControls();
    state = { phase: 'playing', clipAvailable: true };
    state = inactive; // Close/clear, Pause or pending admission replaces the previous playback.
    notify('background');
    continueAndroidQaTts();
    await expect(work).rejects.toThrow('background_playback_missing');
    expect(remove).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('bounds the host-controls wait and removes its native app-state listener', async () => {
    const work = waitForAndroidQaTtsPublicControls();
    const rejection = expect(work).rejects.toThrow('public_controls_timeout');
    await jest.advanceTimersByTimeAsync(180000);
    await rejection;
    expect(remove).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
