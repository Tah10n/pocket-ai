const { prepareEasLlamaBuild } = require('../../scripts/eas-llama-build-setup');

describe('EAS pinned llama native setup', () => {
  it.each([undefined, 'ios'])('does not download an Android SDK for %s', async platform => {
    const setup = jest.fn();
    const execute = jest.fn();
    await expect(prepareEasLlamaBuild({ env: { EAS_BUILD_PLATFORM: platform }, setup, spawnSync: execute }))
      .resolves.toEqual({ status: 'not_required' });
    expect(setup).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
  it('publishes only verified roots to subsequent EAS build phases', async () => {
    const env = { EAS_BUILD_PLATFORM: 'android' };
    const setup = jest.fn().mockResolvedValue({ status: 'verified', env: { HEXAGON_SDK_ROOT: '/sdk', HEXAGON_TOOLS_ROOT: '/sdk/tools' } });
    const execute = jest.fn().mockReturnValue({ status: 0 });
    await expect(prepareEasLlamaBuild({ env, projectRoot: '/project', setup, spawnSync: execute }))
      .resolves.toEqual({ status: 'verified' });
    expect(setup).toHaveBeenCalledWith('/project', { abi: 'universal', env });
    expect(execute.mock.calls.map(call => call.slice(0, 2))).toEqual([
      ['set-env', ['HEXAGON_SDK_ROOT', '/sdk']], ['set-env', ['HEXAGON_TOOLS_ROOT', '/sdk/tools']],
    ]);
  });
  it('fails when a verified root cannot be exported', async () => {
    await expect(prepareEasLlamaBuild({ env: { EAS_BUILD_PLATFORM: 'android' },
      setup: jest.fn().mockResolvedValue({ status: 'verified', env: { HEXAGON_SDK_ROOT: '/sdk' } }),
      spawnSync: jest.fn().mockReturnValue({ status: 1 }),
    })).rejects.toThrow(/Could not export/);
  });
});
