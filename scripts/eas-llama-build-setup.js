const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { setupLlamaHexagonSdk } = require('./llama-hexagon-sdk');

async function prepareEasLlamaBuild(options = {}) {
  const env = options.env || process.env;
  if (env.EAS_BUILD_PLATFORM !== 'android') return { status: 'not_required' };
  const setup = options.setup || setupLlamaHexagonSdk;
  const execute = options.spawnSync || spawnSync;
  const result = await setup(options.projectRoot || path.resolve(__dirname, '..'), { abi: 'universal', env });
  for (const [key, value] of Object.entries(result.env)) {
    const published = execute('set-env', [key, value], { env, encoding: 'utf8', timeout: 30_000 });
    if (published.error || published.status !== 0) throw new Error('Could not export verified native SDK configuration to EAS.');
  }
  return { status: result.status };
}

if (require.main === module) {
  prepareEasLlamaBuild().catch(() => {
    console.error('Pinned llama.rn host SDK setup failed.');
    process.exitCode = 1;
  });
}
module.exports = { prepareEasLlamaBuild };
