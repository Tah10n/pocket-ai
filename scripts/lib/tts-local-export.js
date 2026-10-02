const fs = require('node:fs');
const path = require('node:path');
const { validateTtsWav } = require('./tts-evidence');

const within = (parent, child) => {
  const relative = path.relative(parent, child);
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

/** Resolve existing ancestors before creating anything, including Windows junctions. */
function resolveExternalTtsDirectory(value, publicRoot) {
  if (!value || !path.isAbsolute(value)) throw new Error('An explicit absolute local TTS export directory is required.');
  const requested = path.resolve(value);
  let ancestor = requested;
  const suffix = [];
  while (!fs.existsSync(ancestor)) {
    suffix.unshift(path.basename(ancestor));
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error('The local TTS export ancestor is unavailable.');
    ancestor = parent;
  }
  const target = path.resolve(fs.realpathSync(ancestor), ...suffix);
  const root = fs.realpathSync(publicRoot);
  if (within(root, target) || within(target, root)) throw new Error('Speech exports must remain outside the public checkout and its artifacts.');
  fs.mkdirSync(target, { recursive: true });
  const actual = fs.realpathSync(target);
  if (!fs.statSync(actual).isDirectory() || within(root, actual) || within(actual, root)) {
    throw new Error('The local TTS export directory is unsafe.');
  }
  return actual;
}

/** Own the exact new file immediately; a failed write must not leave an unrecorded partial clip. */
function exportLocalTtsClip(directory, id, bytes, step) {
  if (!/^(tokens|continuous_embd)-(1|2|retry)$/u.test(id)) throw new Error('Invalid TTS clip identity.');
  const receipt = validateTtsWav(bytes, step);
  const filename = `${id}.wav`;
  const target = path.join(directory, filename);
  let descriptor;
  let created = false;
  try {
    descriptor = fs.openSync(target, 'wx', 0o600);
    created = true;
    fs.writeFileSync(descriptor, bytes);
    fs.closeSync(descriptor);
    descriptor = undefined;
    const saved = validateTtsWav(fs.readFileSync(target), step);
    if (saved.sha256 !== receipt.sha256) throw new Error('The local TTS export was not written completely.');
    return { id, filename, ...receipt, contentVerification: 'not_run' };
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* Still attempt exact owned-file cleanup. */ }
    }
    if (created) {
      fs.unlinkSync(target);
      if (fs.existsSync(target)) throw new Error('An incomplete local TTS export could not be removed.');
    }
    throw error;
  }
}

module.exports = { resolveExternalTtsDirectory, exportLocalTtsClip };
