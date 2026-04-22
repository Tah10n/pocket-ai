import { useBootstrapStore } from '../../src/store/bootstrapStore';

describe('bootstrapStore', () => {
  beforeEach(() => {
    useBootstrapStore.setState({
      criticalOutcome: 'success',
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

    useBootstrapStore.getState().setBackgroundState('error');
    useBootstrapStore.getState().setBackgroundError(null);

    expect(useBootstrapStore.getState()).toEqual(expect.objectContaining({
      criticalOutcome: 'active_model_blocked',
      backgroundState: 'error',
      backgroundError: null,
    }));
  });
});
