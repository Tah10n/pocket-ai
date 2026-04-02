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
});
