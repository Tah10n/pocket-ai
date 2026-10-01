import { isAndroidQaDocumentModelBootstrapEnabled } from '../../src/services/AndroidQaDocumentModelBootstrap';
import { observeAndroidQaDocumentIndexNativeOperations, recordAndroidQaDocumentIndexNativeOperation } from '../../src/services/AndroidQaDocumentIndexObservation';

jest.mock('../../src/services/AndroidQaDocumentModelBootstrap', () => ({ isAndroidQaDocumentModelBootstrapEnabled: jest.fn() }));

describe('explicit publication QA native observation', () => {
  it('collects nothing when the isolated QA gate is disabled', () => {
    (isAndroidQaDocumentModelBootstrapEnabled as jest.Mock).mockReturnValue(false);
    const onStarted = jest.fn(); const observation = observeAndroidQaDocumentIndexNativeOperations(onStarted);
    try {
      recordAndroidQaDocumentIndexNativeOperation({ operation: 'embedding', phase: 'started', kind: 'document' });
      recordAndroidQaDocumentIndexNativeOperation('restored');
      expect(onStarted).not.toHaveBeenCalled();
      expect(Object.values(observation.counters)).toEqual([0, 0, 0, 0, 0, 0]);
    } finally { observation.release(); }
  });

  it('counts actual starts, settlements and restoration separately and releases only its own observation', () => {
    (isAndroidQaDocumentModelBootstrapEnabled as jest.Mock).mockReturnValue(true);
    const observation = observeAndroidQaDocumentIndexNativeOperations();
    try {
      expect(() => observeAndroidQaDocumentIndexNativeOperations()).toThrow('already owned');
      recordAndroidQaDocumentIndexNativeOperation({ operation: 'embedding', phase: 'started', kind: 'document' });
      expect(observation.counters.nativeSettled).toBe(0);
      recordAndroidQaDocumentIndexNativeOperation({ operation: 'embedding', phase: 'settled', kind: 'document' });
      recordAndroidQaDocumentIndexNativeOperation({ operation: 'embedding', phase: 'started', kind: 'query' });
      recordAndroidQaDocumentIndexNativeOperation({ operation: 'embedding', phase: 'settled', kind: 'query' });
      recordAndroidQaDocumentIndexNativeOperation({ operation: 'rerank', phase: 'started' });
      recordAndroidQaDocumentIndexNativeOperation({ operation: 'rerank', phase: 'settled' });
      recordAndroidQaDocumentIndexNativeOperation('restored');
      expect(observation.counters).toEqual({ documentEmbeddings: 1, queryEmbeddings: 1, rerankCalls: 1,
        nativeStarted: 3, nativeSettled: 3, restored: 1 });
    } finally { observation.release(); }
    const next = observeAndroidQaDocumentIndexNativeOperations();
    try {
      observation.release();
      recordAndroidQaDocumentIndexNativeOperation('restored');
      expect(next.counters.restored).toBe(1); expect(observation.counters.restored).toBe(1);
    } finally { next.release(); }
  });
});
