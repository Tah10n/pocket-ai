import { useBootstrapStore } from '../../src/store/bootstrapStore';
import type { PrivateStorageHealthSnapshot } from '../../src/services/storage';

function buildBlockedStorageHealth(): PrivateStorageHealthSnapshot {
  return {
    status: 'blocked',
    reason: 'secure_key_unavailable',
    retryable: true,
    requiresExplicitReset: false,
    messageKey: 'storage.private.secureKeyUnavailable',
    lastUpdatedAt: 1_700_000_000_000,
  };
}

describe('bootstrapStore', () => {
  beforeEach(() => {
    useBootstrapStore.setState({
      criticalOutcome: 'success',
      criticalStorageHealth: null,
      backgroundState: 'idle',
      backgroundError: null,
    });
  });

  it('updates bootstrap outcome and background status via store actions', () => {
    const state = useBootstrapStore.getState();

    state.setCriticalOutcome('active_model_blocked');
    state.setBackgroundState('running');
    state.setBackgroundError('disk full');

    expect(useBootstrapStore.getState()).toEqual(expect.objectContaining({
      criticalOutcome: 'active_model_blocked',
      backgroundState: 'running',
      backgroundError: 'disk full',
    }));

    useBootstrapStore.getState().setBackgroundState('blocked');
    useBootstrapStore.getState().setBackgroundError(null);

    expect(useBootstrapStore.getState()).toEqual(expect.objectContaining({
      criticalOutcome: 'active_model_blocked',
      backgroundState: 'blocked',
      backgroundError: null,
    }));
  });

  it('stores a storage-blocked critical outcome with sanitized storage health', () => {
    const blockedStorageHealth = {
      ...buildBlockedStorageHealth(),
      errorMessage: 'raw secure-store failure',
    } as PrivateStorageHealthSnapshot & { errorMessage: string };

    useBootstrapStore.getState().setCriticalOutcome('storage_blocked', blockedStorageHealth);

    expect(useBootstrapStore.getState()).toEqual(expect.objectContaining({
      criticalOutcome: 'storage_blocked',
      criticalStorageHealth: buildBlockedStorageHealth(),
    }));
    expect(useBootstrapStore.getState().criticalStorageHealth).not.toHaveProperty('errorMessage');

    useBootstrapStore.getState().setCriticalOutcome('success');

    expect(useBootstrapStore.getState()).toEqual(expect.objectContaining({
      criticalOutcome: 'success',
      criticalStorageHealth: null,
    }));
  });
});
