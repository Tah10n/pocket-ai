const fs = require('node:fs');
const path = require('node:path');
const { BUILD_FILES, SOURCE_PATCHES, applyReplacements } = require('../../patches/llama-rn-0.13.0-rc.3');

// Copy the three pinned patch inputs and their source/build contracts only,
// never binaries or the dependency tree. Reversal also accepts partial installs.
function copyLlamaPatchSources(root, { pristine = false } = {}) {
  const installed = path.resolve(__dirname, '../../node_modules/llama.rn');
  for (const relative of [...SOURCE_PATCHES.map((patch) => patch.source), ...Object.keys(BUILD_FILES)]) {
    const target = path.join(root, 'node_modules/llama.rn', relative);
    let text = fs.readFileSync(path.join(installed, relative), 'utf8').replace(/\r\n/gu, '\n');
    const patch = SOURCE_PATCHES.find((entry) => entry.source === relative);
    if (patch) {
      for (const [before, after] of [...patch.replacements].reverse()) text = text.replace(after, before);
      if (!pristine) text = applyReplacements(text, patch.replacements);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
}

module.exports = { copyLlamaPatchSources };
