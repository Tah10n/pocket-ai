import { AppState, type AppStateStatus } from 'react-native';
import { AudioRecordingService, AUDIO_RECORDING_LIMITS } from '../../src/services/AudioRecordingService';

const mockGetPermission = jest.fn();
const mockPermission = jest.fn();
const mockMode = jest.fn();
const mockReleaseLease = jest.fn();
const mockAcquire = jest.fn();
const mockFiles = new Map<string, Uint8Array>();
const mockDelete = jest.fn();
const mockConstruct = jest.fn();
const mockPreparationDrain = jest.fn();
let mockRecorder: ReturnType<typeof makeRecorder>;

jest.mock('../../src/services/AudioSessionCoordinator', () => ({ acquireAudioSession: (...args: unknown[]) => mockAcquire(...args) }));
jest.mock('../../src/services/AudioPreparationService', () => ({ waitForAudioPreparationDrain: () => mockPreparationDrain() }));
jest.mock('expo-audio', () => ({ getRecordingPermissionsAsync: () => mockGetPermission(),
  requestRecordingPermissionsAsync: () => mockPermission(), setAudioModeAsync: () => mockMode(),
  AudioQuality: { HIGH: 96 }, IOSOutputFormat: { MPEG4AAC: 'aac' },
  AudioModule: { AudioRecorder: function (...args: unknown[]) { mockConstruct(...args); return mockRecorder; } } }));
jest.mock('expo-file-system', () => ({
  Paths: { cache: { uri: 'file:///private-cache/' } },
  File: class {
    readonly uri: string;
    constructor(uri: string) { this.uri = uri; }
    get exists() { return mockFiles.has(this.uri); }
    get size() { return mockFiles.get(this.uri)?.length ?? 0; }
    delete() { mockDelete(this.uri); mockFiles.delete(this.uri); }
    open() { return { readBytes: (length: number) => mockFiles.get(this.uri)?.slice(0, length) ?? new Uint8Array(), close: jest.fn() }; }
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
const sourceUri = 'file:///private-cache/Audio/recording-owned.m4a';
const initial = () => ({ canRecord: true, isRecording: false, durationMillis: 0, recordingRequestId: 1, url: sourceUri, interrupted: false });
const finalized = () => ({ ...initial(), canRecord: false, isFinished: true, hasError: false, durationMillis: 1000 });
function makeRecorder() {
  let listener: ((event: unknown) => void) | null = null;
  let activeRequest = 1;
  const recorder = {
    id: 'recorder-owned', uri: sourceUri, preventAutomaticResume: false,
    prepareAsync: jest.fn(async (requestId: number) => { activeRequest = requestId; mockFiles.set(sourceUri, new Uint8Array(64)); return { ...initial(), recordingRequestId: activeRequest }; }),
    startAsync: jest.fn(async () => ({ ...initial(), isRecording: true, recordingRequestId: activeRequest })),
    finishAsync: jest.fn(async () => finalized()),
    getStatus: jest.fn(() => ({ ...initial(), isRecording: true, durationMillis: 500, recordingRequestId: activeRequest })),
    disposeAsync: jest.fn(async () => undefined), release: jest.fn(),
    cancelRequest: jest.fn(),
    addListener: jest.fn((_event: string, next: (event: unknown) => void) => { listener = next; return { remove: jest.fn(() => { listener = null; }) }; }),
    emit: (event: unknown) => listener?.(event),
  };
  return recorder;
}
let service: AudioRecordingService;
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks(); mockFiles.clear();
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
  mockGetPermission.mockResolvedValue({ granted: false, canAskAgain: true });
  mockPermission.mockResolvedValue({ granted: true, canAskAgain: true });
  mockMode.mockResolvedValue(undefined);
  mockAcquire.mockResolvedValue({ release: mockReleaseLease });
  mockPreparationDrain.mockResolvedValue(undefined);
  mockRecorder = makeRecorder();
  service = new AudioRecordingService();
});
afterEach(async () => { await service.dispose(); jest.useRealTimers(); });
async function start() { await service.start({ ownerKey: 'chat-a', purpose: 'chat' }); }
function writeContainer(length = 64) {
  const bytes = new Uint8Array(length);
  bytes.set([0, 0, 0, 24, 102, 116, 121, 112, 77, 52, 65, 32]);
  mockFiles.set(sourceUri, bytes);
}

it('supports detached external-store callbacks used by the recording sheet', () => {
  const { getState, subscribe } = service;
  const listener = jest.fn();
  expect(getState().phase).toBe('idle');
  const unsubscribe = subscribe(listener);
  expect(typeof unsubscribe).toBe('function');
  unsubscribe();
});

it('requests nothing on construction and publishes recording only after true native status', async () => {
  expect(mockGetPermission).not.toHaveBeenCalled(); expect(mockPermission).not.toHaveBeenCalled(); expect(mockConstruct).not.toHaveBeenCalled();
  const startGate = deferred<ReturnType<typeof initial>>();
  mockRecorder.startAsync.mockReturnValueOnce(startGate.promise);
  const work = service.start({ ownerKey: 'chat-a', purpose: 'chat' }); await flush();
  expect(service.getState().phase).toBe('starting');
  startGate.resolve({ ...initial(), isRecording: true }); await work;
  expect(service.getState().phase).toBe('recording');
  expect(mockRecorder.prepareAsync).toHaveBeenCalledWith(1, 29.5, AUDIO_RECORDING_LIMITS.chat.sourceBytes);
  expect(mockRecorder.preventAutomaticResume).toBe(true);
});

it('uses an existing Granted permission without another OS request', async () => {
  mockGetPermission.mockResolvedValue({ granted: true, canAskAgain: true });
  await start();
  expect(mockGetPermission).toHaveBeenCalledTimes(1);
  expect(mockPermission).not.toHaveBeenCalled();
  expect(service.getState().phase).toBe('recording');
  expect(mockRecorder.startAsync).toHaveBeenCalledTimes(1);
});

it.each([true, false])('late permission query with granted=%s after cancellation cannot ask or record', async granted => {
  const permission = deferred<{ granted: boolean; canAskAgain: boolean }>();
  mockGetPermission.mockReturnValueOnce(permission.promise);
  const work = start(); await flush();
  expect(service.getState().phase).toBe('requesting-permission');
  expect(mockGetPermission).toHaveBeenCalledTimes(1);
  const close = service.cancelAndClear();
  permission.resolve({ granted, canAskAgain: true }); await work; await close;
  expect(mockPermission).not.toHaveBeenCalled(); expect(mockAcquire).not.toHaveBeenCalled();
  expect(mockConstruct).not.toHaveBeenCalled(); expect(service.getState().phase).toBe('idle');
});

it.each([true, false])('background during a pending permission query with granted=%s cannot ask or record', async granted => {
  let onAppStateChange!: (state: AppStateStatus) => void;
  const subscription = jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
    onAppStateChange = listener;
    return { remove: jest.fn() };
  });
  try {
    const permission = deferred<{ granted: boolean; canAskAgain: boolean }>();
    mockGetPermission.mockReturnValueOnce(permission.promise);
    const work = start(); await flush();
    expect(mockGetPermission).toHaveBeenCalledTimes(1);
    Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'background' });
    onAppStateChange('background');
    permission.resolve({ granted, canAskAgain: true }); await work;
    await service.cancelAndClear();
    expect(mockPermission).not.toHaveBeenCalled(); expect(mockAcquire).not.toHaveBeenCalled();
    expect(mockConstruct).not.toHaveBeenCalled(); expect(service.getState().phase).toBe('idle');
  } finally { subscription.mockRestore(); }
});

it('rechecks AppState after a Granted query even before a background callback arrives', async () => {
  const permission = deferred<{ granted: boolean; canAskAgain: boolean }>();
  mockGetPermission.mockReturnValueOnce(permission.promise);
  const work = start(); await flush();
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'background' });
  permission.resolve({ granted: true, canAskAgain: true }); await work;
  expect(mockPermission).not.toHaveBeenCalled(); expect(mockAcquire).not.toHaveBeenCalled();
  expect(mockConstruct).not.toHaveBeenCalled();
});

it('a stale caller after the permission query cannot trigger an OS request', async () => {
  const permission = deferred<{ granted: boolean; canAskAgain: boolean }>();
  mockGetPermission.mockReturnValueOnce(permission.promise);
  let current = true;
  const work = service.start({ ownerKey: 'chat-a', purpose: 'chat', isCurrent: () => current }); await flush();
  current = false;
  permission.resolve({ granted: false, canAskAgain: true }); await work;
  expect(mockPermission).not.toHaveBeenCalled(); expect(mockAcquire).not.toHaveBeenCalled();
  expect(mockConstruct).not.toHaveBeenCalled(); expect(service.getState().phase).toBe('idle');
});

it.each([true, false])('handles denied permission with canAskAgain=%s without recorder construction', async canAskAgain => {
  mockPermission.mockResolvedValue({ granted: false, canAskAgain });
  await expect(start()).rejects.toMatchObject({ code: canAskAgain ? 'permission_denied' : 'permission_permanently_denied' });
  expect(mockConstruct).not.toHaveBeenCalled(); expect(mockAcquire).not.toHaveBeenCalled();
});

it('late Granted after closure cannot prepare or record', async () => {
  const permission = deferred<{ granted: boolean; canAskAgain: boolean }>(); mockPermission.mockReturnValue(permission.promise);
  const work = start(); await flush(); const close = service.cancelAndClear();
  permission.resolve({ granted: true, canAskAgain: true }); await work; await close;
  expect(mockConstruct).not.toHaveBeenCalled(); expect(service.getState().phase).toBe('idle');
});

it('Stop during prepare waits for native drain and never starts or publishes partial Ready', async () => {
  const prepare = deferred<ReturnType<typeof initial>>(); mockRecorder.prepareAsync.mockReturnValueOnce(prepare.promise);
  const work = start(); await flush(); const stop = service.stop();
  expect(mockRecorder.disposeAsync).not.toHaveBeenCalled();
  mockFiles.set(sourceUri, new Uint8Array(64)); prepare.resolve(initial()); await work; await stop;
  expect(mockRecorder.startAsync).not.toHaveBeenCalled(); expect(mockRecorder.disposeAsync).toHaveBeenCalledTimes(1);
  expect(mockFiles.has(sourceUri)).toBe(false); expect(service.getState().phase).toBe('idle');
});

it('does not mistake false native start status for recording', async () => {
  mockRecorder.startAsync.mockResolvedValueOnce(initial());
  await expect(start()).rejects.toMatchObject({ code: 'start_failed' });
  expect(mockRecorder.disposeAsync).toHaveBeenCalled(); expect(mockFiles.has(sourceUri)).toBe(false);
});

it('finalizes and disposes before exposing a bounded MP4 source and retains it for preparation', async () => {
  await start(); writeContainer();
  const finish = deferred<ReturnType<typeof finalized>>(); mockRecorder.finishAsync.mockReturnValueOnce(finish.promise);
  const stop = service.stop(); await flush(); expect(service.getState().phase).toBe('finalizing');
  expect(mockRecorder.disposeAsync).not.toHaveBeenCalled();
  finish.resolve(finalized()); const recording = await stop;
  expect(recording).toMatchObject({ uri: sourceUri, container: 'm4a', byteSize: 64, durationMillis: 1000 });
  expect(mockRecorder.disposeAsync).toHaveBeenCalled(); expect(mockRecorder.release).toHaveBeenCalled();
  expect(mockReleaseLease).toHaveBeenCalledTimes(1); expect(mockFiles.has(sourceUri)).toBe(true);
});

it.each(['empty', 'wrong-container', 'oversized', 'native-error'])('rejects finalized %s without Ready', async kind => {
  await start();
  if (kind === 'empty') mockFiles.set(sourceUri, new Uint8Array());
  if (kind === 'wrong-container') mockFiles.set(sourceUri, new Uint8Array(64));
  if (kind === 'oversized') writeContainer(AUDIO_RECORDING_LIMITS.chat.sourceBytes + 1);
  if (kind === 'native-error') { writeContainer(); mockRecorder.finishAsync.mockResolvedValueOnce({ ...finalized(), hasError: true }); }
  await expect(service.stop()).rejects.toMatchObject({ code: kind === 'native-error' ? 'finalize_failed' : 'file_invalid' });
  expect(service.getState().phase).toBe('error'); expect(service.getState().recording).toBeUndefined(); expect(mockFiles.has(sourceUri)).toBe(false);
});

it('cancel during finalization drains native work before deletion and prevents late Ready', async () => {
  await start(); writeContainer(); const finish = deferred<ReturnType<typeof finalized>>(); mockRecorder.finishAsync.mockReturnValueOnce(finish.promise);
  const stop = service.stop(); await flush(); const close = service.cancelAndClear();
  expect(mockFiles.has(sourceUri)).toBe(true); finish.resolve(finalized()); await stop; await close;
  expect(service.getState().phase).toBe('idle'); expect(mockFiles.has(sourceUri)).toBe(false);
});

it('background finalizes a real capture into an interrupted explicit draft without a restart', async () => {
  await start(); writeContainer(); await service.onBackground();
  expect(service.getState()).toMatchObject({ phase: 'ready', interrupted: true });
  expect(mockRecorder.startAsync).toHaveBeenCalledTimes(1);
});

it('stale completion events do not finalize the active request', async () => {
  await start(); mockRecorder.emit({ isFinished: true, recordingRequestId: 99 }); await flush();
  expect(mockRecorder.finishAsync).not.toHaveBeenCalled(); expect(service.getState().phase).toBe('recording');
});

it('dispose failure retains hardware ownership and blocks a new recording until a confirmed retry', async () => {
  await start(); writeContainer(); mockRecorder.disposeAsync.mockRejectedValue(new Error('native release'));
  await expect(service.stop()).rejects.toMatchObject({ code: 'release_failed' });
  expect(mockReleaseLease).not.toHaveBeenCalled(); expect(mockFiles.has(sourceUri)).toBe(true);
  await expect(start()).rejects.toMatchObject({ code: 'busy' });
  mockRecorder.disposeAsync.mockResolvedValue(undefined); await service.cancelAndClear();
  expect(mockReleaseLease).toHaveBeenCalledTimes(1); expect(mockFiles.has(sourceUri)).toBe(false);
});

it('reference recording is independent of chat capability and receives the smaller native bound', async () => {
  await service.start({ ownerKey: 'reference-ui', purpose: 'reference' });
  expect(mockRecorder.prepareAsync).toHaveBeenCalledWith(1, 7.5, AUDIO_RECORDING_LIMITS.reference.sourceBytes);
});

it.each(['chat', 'reference'] as const)('keeps delayed %s native finalization within its unchanged decoder duration limit', async purpose => {
  const limits = AUDIO_RECORDING_LIMITS[purpose];
  await service.start({ ownerKey: 'capture-limit', purpose }); writeContainer();
  const finish = deferred<ReturnType<typeof finalized>>();
  mockRecorder.finishAsync.mockReturnValueOnce(finish.promise);
  mockRecorder.emit({ isFinished: true, recordingRequestId: 1 }); await flush();
  expect(service.getState().phase).toBe('finalizing');
  expect(mockRecorder.disposeAsync).not.toHaveBeenCalled();
  expect(mockRecorder.prepareAsync).toHaveBeenCalledWith(1, limits.durationSeconds - 0.5, limits.sourceBytes);
  // Native finalization observed 95ms beyond the scheduled deadline in emulator QA.
  const durationMillis = (limits.durationSeconds - 0.5) * 1000 + 95;
  finish.resolve({ ...finalized(), durationMillis }); await flush();
  expect(service.getState()).toMatchObject({ phase: 'ready', recording: { durationMillis } });
  expect(durationMillis).toBeLessThanOrEqual(limits.durationSeconds * 1000);
  expect(mockRecorder.disposeAsync).toHaveBeenCalledTimes(1);
  expect(mockReleaseLease).toHaveBeenCalledTimes(1);
});

it.each(['chat', 'reference'] as const)('accepts the exact %s duration boundary but rejects delay exceeding the reserve', async purpose => {
  const limits = AUDIO_RECORDING_LIMITS[purpose];
  await service.start({ ownerKey: 'capture-limit', purpose }); writeContainer();
  mockRecorder.finishAsync.mockResolvedValueOnce({ ...finalized(), durationMillis: limits.durationSeconds * 1000 });
  await expect(service.stop()).resolves.toMatchObject({ durationMillis: limits.durationSeconds * 1000 });
  await service.cancelAndClear();

  await service.start({ ownerKey: 'capture-limit-new', purpose }); writeContainer();
  mockRecorder.finishAsync.mockResolvedValueOnce({ ...finalized(), recordingRequestId: 2, durationMillis: limits.durationSeconds * 1000 + 1 });
  await expect(service.stop()).rejects.toMatchObject({ code: 'file_invalid' });
  expect(service.getState()).toMatchObject({ phase: 'error', recording: undefined });
  expect(mockFiles.has(sourceUri)).toBe(false);
});

it('private cancellation waits for real preprocessing drain before deleting its original source', async () => {
  await start(); writeContainer(); await service.stop();
  const preparation = deferred<void>(); mockPreparationDrain.mockReturnValueOnce(preparation.promise);
  const clear = service.cancelAndClear(); await flush();
  expect(mockFiles.has(sourceUri)).toBe(true); expect(mockDelete).not.toHaveBeenCalled();
  preparation.resolve(); await clear;
  expect(mockFiles.has(sourceUri)).toBe(false);
});

it('keeps native interrupted status even when its final event arrives before JS background', async () => {
  await start(); writeContainer();
  mockRecorder.finishAsync.mockResolvedValueOnce({ ...finalized(), interrupted: true });
  mockRecorder.emit({ isFinished: true, interrupted: true, recordingRequestId: 1 });
  await flush();
  expect(service.getState()).toMatchObject({ phase: 'ready', interrupted: true });
});

it('background during a pending ordinary finalization preserves the interrupted draft flag', async () => {
  await start(); writeContainer();
  const finish = deferred<ReturnType<typeof finalized>>(); mockRecorder.finishAsync.mockReturnValueOnce(finish.promise);
  const stop = service.stop(); await flush(); await service.onBackground();
  finish.resolve(finalized()); await stop;
  expect(service.getState()).toMatchObject({ phase: 'ready', interrupted: true });
});

it('unmount during native start retains its lease until actual start and disposal drain', async () => {
  const gate = deferred<ReturnType<typeof initial>>(); mockRecorder.startAsync.mockReturnValueOnce(gate.promise);
  const pending = start(); await flush(); const closed = service.cancelAndClear();
  expect(mockRecorder.cancelRequest).toHaveBeenCalledWith(1);
  expect(mockRecorder.disposeAsync).not.toHaveBeenCalled(); expect(mockReleaseLease).not.toHaveBeenCalled();
  gate.resolve({ ...initial(), isRecording: true }); await pending; await closed;
  expect(service.getState().phase).toBe('idle'); expect(mockRecorder.disposeAsync).toHaveBeenCalled();
  expect(mockReleaseLease).toHaveBeenCalledTimes(1); expect(mockFiles.has(sourceUri)).toBe(false);
});

it('synchronous cancellation rejects a queued native start without exposing Recording', async () => {
  const gate = deferred<ReturnType<typeof initial>>(); mockRecorder.startAsync.mockReturnValueOnce(gate.promise);
  const pending = start(); await flush(); const clear = service.cancelAndClear('chat-a');
  expect(mockRecorder.cancelRequest).toHaveBeenCalledWith(1);
  gate.reject(new Error('ERR_AUDIO_CAPTURE_STALE')); await pending; await clear;
  expect(service.getState().phase).toBe('idle'); expect(mockRecorder.disposeAsync).toHaveBeenCalled();
  expect(mockReleaseLease).toHaveBeenCalledTimes(1); expect(mockFiles.has(sourceUri)).toBe(false);
});

it('late cleanup from an old sheet cannot invalidate or dispose a new sheet recorder', async () => {
  await start(); writeContainer(); await service.stop();
  await service.cancelAndClear('chat-a');
  await service.start({ ownerKey: 'chat-b-unique', purpose: 'chat' });
  const disposals = mockRecorder.disposeAsync.mock.calls.length;
  await service.cancelAndClear('chat-a');
  expect(service.getState()).toMatchObject({ phase: 'recording', ownerKey: 'chat-b-unique' });
  expect(mockRecorder.disposeAsync).toHaveBeenCalledTimes(disposals);
});

it('queued old owner cleanup stays harmless when the next explicit start already owns its token', async () => {
  await start(); writeContainer(); await service.stop();
  const drain = deferred<void>(); mockPreparationDrain.mockReturnValueOnce(drain.promise);
  const oldClear = service.cancelAndClear('chat-a'); await flush();
  const next = service.start({ ownerKey: 'chat-b-unique', purpose: 'reference' });
  drain.resolve(); await oldClear; await next;
  expect(service.getState()).toMatchObject({ phase: 'recording', ownerKey: 'chat-b-unique', purpose: 'reference' });
  expect(mockRecorder.startAsync).toHaveBeenCalledTimes(2);
  await service.cancelAndClear('chat-a'); expect(service.getState().phase).toBe('recording');
});
