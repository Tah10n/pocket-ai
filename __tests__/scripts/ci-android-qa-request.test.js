const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { selectQaPack, evaluateQaRequest } = require('../../scripts/ci-android-qa-request');

const pr = (labels = [], body = '') => ({ labels: labels.map((name) => ({ name })), body });
const event = (action, pullRequest = pr(), extra = {}) => ({ action, pull_request: pullRequest, ...extra });

describe('optional Android QA event routing', () => {
  it.each([
    ['run-android-checks', 'runtime'],
    ['run-android-scenarios', 'extended'],
    ['android-pack-all', 'all'],
    ['android-pack-documents', 'documents'],
    ['android-pack-native', 'native'],
    ['android-pack-runtime', 'runtime'],
    ['android-pack-dependency-ui', 'dependency-ui'],
    ['android-pack-catalog', 'catalog'],
    ['android-pack-extended', 'extended'],
  ])('preserves the %s label', (label, pack) => {
    expect(evaluateQaRequest('pull_request', event('labeled', pr([label]), { label: { name: label } })))
      .toEqual({ run: true, pack, diagnostics: true });
  });

  it.each(['x', 'X'])('preserves checked %s boxes and ignores unchecked boxes', (mark) => {
    for (const [text, pack] of [
      ['Run Android checks', 'runtime'],
      ['Run Android scenarios', 'extended'],
      ['Run Android document pack', 'documents'],
    ]) {
      expect(selectQaPack(pr([], `- [${mark}] ${text}`))).toBe(pack);
      expect(selectQaPack(pr([], `- [ ] ${text}`))).toBe('');
    }
  });

  it.each(['opened', 'reopened', 'synchronize'])('runs a persistent request on %s', (action) => {
    expect(evaluateQaRequest('pull_request', event(action, pr(['android-pack-native']))).run).toBe(true);
    expect(evaluateQaRequest('pull_request', event(action)).run).toBe(false);
  });

  it('ignores title and unrelated prose edits, even while QA is requested', () => {
    const requested = pr(['android-pack-runtime'], 'Summary updated');
    expect(evaluateQaRequest('pull_request', event('edited', requested, { changes: { title: { from: 'old' } } })).run).toBe(false);
    expect(evaluateQaRequest('pull_request', event('edited', requested, { changes: { body: { from: 'old prose' } } })).run).toBe(false);
  });

  it('runs a newly checked request and a changed effective pack', () => {
    expect(evaluateQaRequest('pull_request', event('edited', pr([], '- [x] Run Android checks'), { changes: { body: { from: '- [ ] Run Android checks' } } })).run).toBe(true);
    expect(evaluateQaRequest('pull_request', event('edited', pr([], '- [x] Run Android document pack'), { changes: { body: { from: '- [x] Run Android checks' } } })).pack).toBe('documents');
    expect(evaluateQaRequest('pull_request', event('edited', pr([], '- [x] Run Android document pack'), { changes: { body: { from: '- [x] Run Android checks' } } })).run).toBe(true);
  });

  it('runs requested QA after base retargeting', () => {
    expect(evaluateQaRequest('pull_request', event('edited', pr(['android-pack-native']), { changes: { base: { ref: { from: 'main' } } } })).run).toBe(true);
  });

  it.each(['labeled', 'unlabeled'])('ignores unrelated %s events without cancelling requested QA', (action) => {
    expect(evaluateQaRequest('pull_request', event(action, pr(['android-pack-runtime', 'reviewed']), { label: { name: 'reviewed' } })).run).toBe(false);
  });

  it('does not repeat an unchanged higher-priority request', () => {
    expect(evaluateQaRequest('pull_request', event('labeled', pr(['android-pack-all', 'android-pack-native']), { label: { name: 'android-pack-native' } })).run).toBe(false);
  });

  it('runs the remaining lower-priority pack when the selected pack is removed', () => {
    expect(evaluateQaRequest('pull_request', event('unlabeled', pr(['android-pack-catalog']), { label: { name: 'android-pack-all' } })))
      .toEqual({ run: true, pack: 'catalog', diagnostics: true });
  });

  it('does not run after the last request is removed', () => {
    expect(evaluateQaRequest('pull_request', event('unlabeled', pr(), { label: { name: 'android-pack-all' } })))
      .toEqual({ run: false, pack: '', diagnostics: false });
  });

  it('keeps label priority ahead of checkbox fallbacks', () => {
    expect(selectQaPack(pr(['android-pack-all'], '- [x] Run Android document pack'))).toBe('all');
    expect(selectQaPack(pr(['android-pack-native'], '- [X] Run Android document pack'))).toBe('documents');
    expect(selectQaPack(pr(['android-pack-catalog'], '- [x] Run Android scenarios'))).toBe('catalog');
  });

  it('does not turn unrelated events, null bodies or unknown labels into requests', () => {
    expect(evaluateQaRequest('push', {})).toEqual({ run: false, pack: '', diagnostics: false });
    expect(selectQaPack({ body: null, labels: [{ name: 'android-pack-branch-regeneration' }] })).toBe('');
    expect(() => evaluateQaRequest('pull_request', {})).toThrow('Missing pull_request');
    expect(() => evaluateQaRequest('pull_request', event('labeled', pr(['android-pack-all'])))).toThrow('Missing changed label');
  });

  it('writes only bounded output values from the event file, without executing PR text', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-ai-qa-event-'));
    try {
      const eventPath = path.join(directory, 'event.json');
      const outputPath = path.join(directory, 'output.txt');
      fs.writeFileSync(eventPath, JSON.stringify(event('opened', pr([], '- [x] Run Android checks\n$(exit 1)\npack=all'))));
      execFileSync(process.execPath, [path.resolve(__dirname, '../../scripts/ci-android-qa-request.js')], {
        env: { ...process.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath },
      });
      expect(fs.readFileSync(outputPath, 'utf8')).toBe('run=true\npack=runtime\ndiagnostics=true\n');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
