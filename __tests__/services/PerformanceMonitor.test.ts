import { performanceMonitor } from '../../src/services/PerformanceMonitor';

describe('PerformanceMonitor', () => {
  beforeEach(() => {
    performanceMonitor.clear();
    performanceMonitor.setEnabled(true);
  });

  it('exposes stable session metadata', () => {
    const session1 = performanceMonitor.getSessionInfo();
    const session2 = performanceMonitor.getSessionInfo();

    expect(session2).toEqual(session1);
    expect(session1.schemaVersion).toBe(1);
    expect(typeof session1.sessionId).toBe('string');
    expect(session1.sessionId.length).toBeGreaterThan(0);
    expect(typeof session1.startedWallTime).toBe('number');
  });

  it('public APIs are exception-safe (no-throw)', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => performanceMonitor.mark('test.mark', circular as unknown as Record<string, unknown>)).not.toThrow();
    expect(() => performanceMonitor.incrementCounter('test.counter', 1, circular as unknown as Record<string, unknown>)).not.toThrow();

    const span = performanceMonitor.startSpan('test.span', circular as unknown as Record<string, unknown>);
    expect(() => span.end(circular as unknown as Record<string, unknown>)).not.toThrow();
    expect(() => performanceMonitor.snapshot()).not.toThrow();
  });

  it('does not record when disabled', () => {
    performanceMonitor.setEnabled(false);

    performanceMonitor.mark('test.mark');
    performanceMonitor.incrementCounter('test.counter');
    performanceMonitor.startSpan('test.span').end();

    const snapshot = performanceMonitor.snapshot();
    expect(snapshot.enabled).toBe(false);
    expect(snapshot.events).toHaveLength(0);
    expect(snapshot.counters).toEqual({});
  });

  it('reuses one no-op span and records no metadata while disabled', () => {
    performanceMonitor.setEnabled(false);
    const metadata = Object.defineProperty({}, 'sensitiveValue', {
      enumerable: true,
      get: () => {
        throw new Error('disabled instrumentation inspected metadata');
      },
    });

    const first = performanceMonitor.startSpan('test.disabled.first', metadata);
    const second = performanceMonitor.startSpan('test.disabled.second', metadata);

    expect(first).toBe(second);
    expect(() => first.end(metadata)).not.toThrow();
    expect(performanceMonitor.snapshot().events).toEqual([]);
  });

  it('keeps event storage bounded while preserving aggregate counters', () => {
    for (let index = 0; index < 450; index += 1) {
      performanceMonitor.mark(`test.mark.${index}`);
    }
    performanceMonitor.incrementCounter('test.aggregate', 450);

    const snapshot = performanceMonitor.snapshot();
    expect(snapshot.events).toHaveLength(400);
    expect(snapshot.events[0]?.name).toBe('test.mark.50');
    expect(snapshot.events.at(-1)?.name).toBe('test.mark.449');
    expect(snapshot.counters['test.aggregate']).toBe(450);
  });

  it('reads one counter and replaces gauges without building a snapshot', () => {
    const snapshotSpy = jest.spyOn(performanceMonitor, 'snapshot');

    performanceMonitor.incrementCounter('test.counter', 2);
    expect(performanceMonitor.getCounter('test.counter')).toBe(2);
    expect(performanceMonitor.getCounter('test.missing')).toBe(0);

    performanceMonitor.setGauge('test.counter', 7, { source: 'test' });

    expect(performanceMonitor.getCounter('test.counter')).toBe(7);
    expect(snapshotSpy).not.toHaveBeenCalled();
    expect(performanceMonitor.snapshot().events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'gauge',
        name: 'test.counter',
        value: 7,
        meta: { source: 'test' },
      }),
    ]));
  });

  it('ignores disabled and non-finite gauge updates', () => {
    performanceMonitor.setGauge('test.gauge', 3);
    performanceMonitor.setGauge('test.gauge', Number.NaN);
    performanceMonitor.setGauge('test.gauge', Number.POSITIVE_INFINITY);
    performanceMonitor.setEnabled(false);
    performanceMonitor.setGauge('test.gauge', 9);

    expect(performanceMonitor.getCounter('test.gauge')).toBe(3);
  });
});
