import { AudioSamplePreviewService } from '../../src/services/AudioSamplePreviewService';

const mockInstall = jest.fn<Promise<void>, unknown[]>(async () => undefined);
const mockPlay = jest.fn<Promise<void>, []>(async () => undefined);
const mockClear = jest.fn<Promise<void>, []>(async () => undefined);
const mockCancel = jest.fn();
jest.mock('../../src/services/TtsPlayback', () => ({ TtsPlaybackController: class {
  setBorrowedClip(...args: unknown[]) { return mockInstall(...args); }
  play() { return mockPlay(); }
  clear() { return mockClear(); }
  cancelStart() { mockCancel(); }
  getState() { return { phase: 'stopped' }; }
  subscribe() { return () => undefined; }
} }));
const options = (ownerKey: string) => ({ ownerKey, uri: 'file:///private/sample.wav', sampleRate: 24000, sampleCount: 24000 });
beforeEach(() => {
  jest.clearAllMocks(); mockInstall.mockResolvedValue(undefined); mockClear.mockResolvedValue(undefined);
});

it('late cleanup from an old sheet cannot stop a newer sample preview', async () => {
  const service = new AudioSamplePreviewService();
  await service.play(options('old-sheet')); await service.play(options('new-sheet'));
  await service.stop('old-sheet');
  expect(mockClear).not.toHaveBeenCalled(); expect(mockCancel).not.toHaveBeenCalled();
  await service.stop('new-sheet');
  expect(mockClear).toHaveBeenCalledTimes(1); expect(mockCancel).toHaveBeenCalledTimes(1);
});

it('a draining old clear does not erase the current owner token when a new play starts', async () => {
  const service = new AudioSamplePreviewService();
  await service.play(options('old-sheet'));
  let disposed!: () => void;
  mockClear.mockImplementationOnce(() => new Promise<void>(resolve => { disposed = resolve; }));
  const oldClear = service.stop('old-sheet');
  await service.play(options('new-sheet'));
  disposed(); await oldClear;
  await service.stop('old-sheet'); expect(mockClear).toHaveBeenCalledTimes(1);
  await service.stop('new-sheet'); expect(mockClear).toHaveBeenCalledTimes(2);
});

it('cancels stale installation and permits the deliberate global private-reset stop', async () => {
  const service = new AudioSamplePreviewService();
  let installed!: () => void;
  mockInstall.mockImplementationOnce(() => new Promise<void>(resolve => { installed = resolve; }));
  const pending = service.play(options('sheet')); await service.stop();
  installed(); await pending;
  expect(mockPlay).not.toHaveBeenCalled(); expect(mockClear).toHaveBeenCalledTimes(1);
});
