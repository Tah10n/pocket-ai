import { TtsLatencyMeasurement } from '../../src/utils/ttsLatency';
import { sanitizeTtsLatency } from '../../src/types/tts';

afterEach(() => jest.restoreAllMocks());
it('bounds storage, sums repeated suboperations, and ignores unmatched or duplicate completions', () => {
  let now = 100;
  jest.spyOn(performance, 'now').mockImplementation(() => now);
  const metric = new TtsLatencyMeasurement('first_in_process');
  metric.observe('decode', 'settled');
  metric.observe('phonemizer_conversion', 'started'); now += 10;
  metric.observe('phonemizer_conversion', 'started'); now += 10;
  metric.observe('phonemizer_conversion', 'settled');
  metric.observe('phonemizer_conversion', 'settled');
  metric.observe('phonemizer_conversion', 'started'); now += 15;
  metric.observe('phonemizer_conversion', 'settled');
  metric.observe('/private/text', 'started');
  metric.set('nativeGenerationMs', Infinity);
  expect(metric.snapshot()).toEqual({ runKind: 'first_in_process', stagesMs: { phonemizer_conversion: 35 } });
  metric.confirmPlayback(5, false);
  expect(metric.snapshot().actionToFirstPlaybackMs).toBeUndefined();
});
it('whitelists stage and numeric fields and never exports paths, text or payloads', () => {
  expect(sanitizeTtsLatency({ runKind: 'first_in_process', text: 'private', stagesMs: {
    completion: 17.4, '/private/file': 1, decode: -1, formatter: 600001,
  }, nativePrefillMs: 2, audioDurationMs: 16001, pcm: [1] })).toEqual({
    runKind: 'first_in_process', stagesMs: { completion: 17 }, nativePrefillMs: 2,
  });
  expect(sanitizeTtsLatency({ runKind: '/private', stagesMs: {} })).toBeUndefined();
});
it('keeps the first automatic playback receipt across later playback confirmations', () => {
  let now = 0; jest.spyOn(performance, 'now').mockImplementation(() => now);
  const metric = new TtsLatencyMeasurement('repeat_in_process');
  now = 130; metric.confirmPlayback(30, true);
  now = 900; metric.confirmPlayback(10, false);
  expect(metric.snapshot()).toMatchObject({ actionToFirstPlaybackMs: 130, playToPlayingMs: 10 });
});
