const packageJson = require('../../package.json');
const packageLock = require('../../package-lock.json');

describe('llama.rn dependency contract', () => {
  it('pins package and lockfile to exactly 0.12.8', () => {
    expect(packageJson.dependencies['llama.rn']).toBe('0.12.8');
    expect(packageLock.packages[''].dependencies['llama.rn']).toBe('0.12.8');
    expect(packageLock.packages['node_modules/llama.rn'].version).toBe('0.12.8');
  });
});
