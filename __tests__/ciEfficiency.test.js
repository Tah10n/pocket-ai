const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const YAML = require('yaml');
const picomatch = require('picomatch');
const { evaluateCiGateResults } = require('../scripts/verify-ci-gate-results');
const { resolveIsolatedAndroidGradleUserHome } = require('../scripts/android-build-provenance');

const workflow = (name) => YAML.parse(fs.readFileSync(path.resolve(__dirname, '../.github/workflows', name), 'utf8'));
const ci = workflow('ci.yml');
const qa = workflow('android-qa.yml');
const title = workflow('pr-title.yml');

// Evaluate the checked-in boolean/string expressions, with missing Actions
// properties represented as null. actionlint validates their Actions syntax.
function evaluate(expression, context) {
  const source = expression.replace(/^\s*\$\{\{\s*|\s*\}\}\s*$/g, '')
    .replace(/\b(?:github|needs|matrix|steps|runner)(?:\.[a-zA-Z0-9_-]+)+/g, (key) =>
      JSON.stringify(key.split('.').reduce((value, segment) => value?.[segment], context) ?? null));
  return vm.runInNewContext(source, {
    always: () => true,
    failure: () => context.failed === true,
    cancelled: () => context.cancelled === true,
    startsWith: (value, prefix) => String(value || '').toLowerCase().startsWith(prefix.toLowerCase()),
    hashFiles: (...patterns) => {
      const entries = Object.entries(context.files || {})
        .filter(([file]) => patterns.some((pattern) => picomatch(pattern, { dot: true })(file)))
        .sort(([left], [right]) => left.localeCompare(right));
      return entries.length ? crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex') : '';
    },
  });
}

function interpolate(template, context) {
  return template.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, expression) => String(evaluate(expression, context)));
}

const context = (action, changes, number = 183, runId = 1) => ({
  github: { event_name: 'pull_request', run_id: runId, event: { action, changes, pull_request: { number } } },
  matrix: { 'api-level': 32 },
});

describe('CI efficiency event and condition matrix', () => {
  it.each(['opened', 'reopened', 'synchronize'])('retains every source gate for %s', (action) => {
    const event = context(action);
    expect(evaluate(ci.jobs['native-scope'].if, event)).toBe(true);
    expect(evaluate(ci.jobs.deterministic.if, event)).toBe(true);
    expect(evaluate(ci.jobs.verify.if, event)).toBe(true);
    expect(interpolate(ci.jobs.verify.name, event)).toBe('verify');
    expect(evaluate(ci.concurrency['cancel-in-progress'], event)).toBe(true);
  });

  it.each([
    ['title', { title: { from: 'old' } }],
    ['body', { body: { from: 'old report' } }],
    ['metadata with no changes object', undefined],
  ])('keeps %s edits lightweight without superseding required checks', (_, changes) => {
    const event = context('edited', changes);
    expect(evaluate(ci.jobs.metadata.if, event)).toBe(true);
    expect(evaluate(ci.jobs['native-scope'].if, event)).toBe(false);
    expect(evaluate(ci.jobs.deterministic.if, event)).toBe(false);
    expect(evaluate(ci.jobs.verify.if, event)).toBe(false);
    for (const job of ['native-scope', 'deterministic', 'android-native-release', 'ios-native-release', 'verify']) {
      expect(interpolate(ci.jobs[job].name, event)).toContain(' (metadata)');
    }
    expect(evaluate(ci.concurrency['cancel-in-progress'], event)).toBe(false);
    expect(interpolate(ci.concurrency.group, event)).not.toBe(interpolate(ci.concurrency.group, context('synchronize')));
  });

  it('recomputes required native scope after base retargeting', () => {
    const event = context('edited', { base: { ref: { from: 'main' } } });
    expect(evaluate(ci.jobs.metadata.if, event)).toBe(false);
    for (const job of ['native-scope', 'deterministic', 'verify']) {
      expect(evaluate(ci.jobs[job].if, event)).toBe(true);
    }
    expect(interpolate(ci.jobs.verify.name, event)).toBe('verify');
    expect(interpolate(ci.concurrency.group, event)).toBe(interpolate(ci.concurrency.group, context('synchronize')));
  });

  it('isolates PRs, metadata runs, push runs and QA from each other', () => {
    expect(interpolate(ci.concurrency.group, context('synchronize', undefined, 183)))
      .not.toBe(interpolate(ci.concurrency.group, context('synchronize', undefined, 180)));
    expect(interpolate(ci.concurrency.group, context('edited', undefined, 183, 1)))
      .not.toBe(interpolate(ci.concurrency.group, context('edited', undefined, 183, 2)));
    const push = { github: { event_name: 'push', run_id: 3, event: {} } };
    expect(evaluate(ci.jobs['native-scope'].if, push)).toBe(false);
    expect(evaluate(ci.jobs.deterministic.if, push)).toBe(true);
    expect(evaluate(ci.jobs.verify.if, push)).toBe(true);
    expect(interpolate(ci.jobs.verify.name, push)).toBe('verify');
    expect(evaluate(ci.concurrency['cancel-in-progress'], push)).toBe(false);
    expect(interpolate(ci.concurrency.group, push)).not.toBe(interpolate(ci.concurrency.group, context('synchronize')));
    expect(interpolate(qa.jobs['android-qa'].concurrency.group, context('synchronize')))
      .not.toBe(interpolate(ci.concurrency.group, context('synchronize')));
  });

  it('routes labels to QA and keeps the semantic title check on metadata edits', () => {
    expect(ci.on.pull_request.types).not.toContain('labeled');
    expect(ci.on.pull_request.types).not.toContain('unlabeled');
    expect(qa.on.pull_request.types).toEqual(expect.arrayContaining(['edited', 'labeled', 'unlabeled', 'synchronize']));
    expect(title.on.pull_request.types).toEqual(expect.arrayContaining(['edited', 'labeled', 'unlabeled']));
    expect(title.jobs['semantic-pull-request'].name).toBe('semantic-pull-request');
  });

  it('does not schedule or cancel expensive QA on an unchanged request', () => {
    expect(qa.concurrency).toBeUndefined();
    for (const job of ['deterministic', 'android-qa']) {
      expect(evaluate(qa.jobs[job].if, { needs: { request: { outputs: { run: 'false' } } } })).toBe(false);
      expect(evaluate(qa.jobs[job].if, { needs: { request: { outputs: { run: 'true' } } } })).toBe(true);
      expect(qa.jobs[job].concurrency['cancel-in-progress']).toBe(true);
    }
    expect(qa.jobs['android-qa'].needs).toEqual(['request', 'deterministic']);
    expect(qa.jobs.deterministic.steps.some((step) => step.run === 'npm run verify:release')).toBe(true);
  });

  it('preserves conservative scope, the native matrix, fail-closed aggregate and cancellation cleanup', () => {
    expect(ci.jobs['android-native-release'].strategy.matrix['api-level']).toEqual([32, 33, 34, 35]);
    for (const job of ['android-native-release', 'ios-native-release']) {
      expect(ci.jobs[job].needs).toEqual(['native-scope', 'deterministic']);
      expect(ci.jobs[job].if).not.toContain('always()');
      expect(ci.jobs[job].steps.every((step) => step['continue-on-error'] !== true)).toBe(true);
    }
    expect(ci.jobs['android-native-release'].steps.some((step) =>
      step.uses === 'reactivecircus/android-emulator-runner@v2' && step.with.script.includes('--fail-on-skip'))).toBe(true);
    expect(ci.jobs.verify.steps.at(-1).run).toBe('node scripts/verify-ci-gate-results.js');
    const failed = { ...context('synchronize'), failed: true };
    expect(evaluate(ci.jobs.verify.if, failed)).toBe(true);
  });

  it('stores only the compact report on unrequested native success and keeps diagnostics on failure/cancellation/request', () => {
    const steps = ci.jobs['android-native-release'].steps;
    const results = steps.find((step) => step.name === 'Upload Android native results');
    const diagnostics = steps.find((step) => step.name === 'Upload Android native diagnostics');
    expect(results.with.path).toBe('artifacts/android-scenarios/latest-report.json');
    expect(results.with['retention-days']).toBe(1);
    expect(diagnostics.with['retention-days']).toBe(1);
    for (const [failed, cancelled, requested, upload] of [
      [false, false, 'false', false], [true, false, 'false', true],
      [false, true, 'false', true], [false, false, 'true', true],
    ]) {
      expect(evaluate(diagnostics.if, { failed, cancelled, needs: { 'native-scope': { outputs: { diagnostics: requested } } } })).toBe(upload);
    }
    expect(diagnostics.with.path).toContain('artifacts/bootstrap-logcat.txt');
  });

  it('isolates the PR186 report body edit from source CI on identical head/base', () => {
    const source = context('synchronize', undefined, 186, 37509527950);
    source.github.event.pull_request.head = { sha: '379866fbfa04918e33beb8cc8aeb8b40bb35523e' };
    source.github.event.pull_request.base = { sha: 'fb970529608beeac90f272106f45ad7a97a330df' };
    const edited = { ...source, github: { ...source.github, run_id: 37510159860,
      event: { ...source.github.event, action: 'edited', changes: { body: { from: 'Earlier CI snapshot' } } } } };

    expect(evaluate(ci.jobs.verify.if, source)).toBe(true);
    expect(evaluate(ci.jobs.verify.if, edited)).toBe(false);
    expect(evaluate(ci.jobs.deterministic.if, edited)).toBe(false);
    expect(evaluate(ci.jobs['native-scope'].if, edited)).toBe(false);
    expect(interpolate(ci.jobs.verify.name, edited)).toBe('verify (metadata)');
    expect(evaluate(ci.concurrency['cancel-in-progress'], edited)).toBe(false);
    expect(interpolate(ci.concurrency.group, source)).not.toBe(interpolate(ci.concurrency.group, edited));
  });

  it('supersedes duplicate source events even when the source SHA is unchanged', () => {
    const first = context('synchronize', undefined, 186, 37509527950);
    const second = context('reopened', undefined, 186, 37510159860);
    for (const event of [first, second]) {
      event.github.event.pull_request.head = { sha: '379866fbfa04918e33beb8cc8aeb8b40bb35523e' };
      expect(evaluate(ci.concurrency['cancel-in-progress'], event)).toBe(true);
    }
    expect(interpolate(ci.concurrency.group, first)).toBe(interpolate(ci.concurrency.group, second));
  });

  it('uses whole-PR paths, including native patches, instead of only the latest report commit', () => {
    const filters = YAML.parse(ci.jobs['native-scope'].steps.find((step) => step.id === 'scope').with.filters);
    const native = (paths) => paths.some((file) => filters.native.some((pattern) => picomatch(pattern, { dot: true })(file)));
    const reportCommit = ['docs/local-tts.md', 'docs/validation/llama-rn-stage7/acceptance-default-v6.json',
      'docs/validation/llama-rn-stage7/recommended-voice.json', 'docs/validation/llama-rn-stage7/recommended-voice.md',
      'docs/validation/llama-rn-stage7/ui-recommended-voice.png'];
    expect(native(reportCommit)).toBe(false);
    expect(native([...reportCommit, 'modules/pocket-audio-preparation/android/build.gradle', 'package-lock.json'])).toBe(true);
    for (const path of ['patches/llama-rn-0.13.0-rc.3.js', 'scripts/llama-hexagon-sdk.js',
      'scripts/llama-hexagon-sdk-manifest.json', 'scripts/eas-llama-build-setup.js']) {
      expect(native([path])).toBe(true);
    }
    for (const required of ['true', 'false']) {
      expect(evaluate(ci.jobs['native-scope'].outputs.required, {
        github: { head_ref: 'release-please--branches--main' }, steps: { scope: { outputs: { native: required } } },
      })).toBe(true);
    }
  });

  it.each(['failure', 'cancelled', 'skipped', ''])('rejects %s native jobs on a docs/report head with whole-PR native scope', (result) => {
    const gate = { eventName: 'pull_request', nativeScopeResult: 'success', nativeRequired: 'true',
      deterministicResult: 'success', androidNativeResult: result, iosNativeResult: 'success' };
    expect(evaluateCiGateResults(gate).ok).toBe(false);
    expect(evaluateCiGateResults({ ...gate, androidNativeResult: 'success', iosNativeResult: result }).ok).toBe(false);
    expect(evaluateCiGateResults({ ...gate, nativeScopeResult: result, androidNativeResult: 'success' }).ok).toBe(false);
  });

  it('caches Rust dependencies by platform and build inputs without skipping workspace compilation', () => {
    const android = ci.jobs['android-native-release'].steps.find((step) => step.uses === 'Swatinem/rust-cache@v2');
    const optional = qa.jobs['android-qa'].steps.find((step) => step.uses === 'Swatinem/rust-cache@v2');
    const ios = ci.jobs['ios-native-release'].steps.find((step) => step.uses === 'Swatinem/rust-cache@v2');
    expect(android.with).toEqual(optional.with);
    expect(android.with['shared-key']).toMatch(/^anydoc-android-cargo-ndk-4\.1\.2-/);
    expect(ios.with['shared-key']).toMatch(/^anydoc-ios-/);
    for (const [cache, job, buildScript] of [[android, ci.jobs['android-native-release'], 'build-android.mjs'],
      [ios, ci.jobs['ios-native-release'], 'build-ios.mjs']]) {
      expect(cache.with['cache-workspace-crates']).toBe(false);
      // rust-cache ignores `key` when `shared-key` is set. Keep the build-input
      // hash in the shared key itself so a script/toolchain policy change isolates it.
      expect(cache.with.key).toBeUndefined();
      expect(cache.with['shared-key']).toContain('modules/pocket-anydoc/scripts/build-utils.mjs');
      const files = { [`modules/pocket-anydoc/scripts/${buildScript}`]: 'platform build',
        'modules/pocket-anydoc/scripts/build-utils.mjs': 'pinned NDK and targets', 'docs/report.md': 'old report' };
      const key = (snapshot) => interpolate(cache.with['shared-key'], { files: snapshot });
      expect(key({ ...files, 'docs/report.md': 'new report' })).toBe(key(files));
      expect(key({ ...files, [`modules/pocket-anydoc/scripts/${buildScript}`]: 'new platform flags' })).not.toBe(key(files));
      expect(key({ ...files, 'modules/pocket-anydoc/scripts/build-utils.mjs': 'new NDK or targets' })).not.toBe(key(files));
      expect(job.steps.findIndex((step) => step === cache)).toBeGreaterThan(job.steps.findIndex((step) => step.uses?.startsWith('dtolnay/rust-toolchain@')));
      expect(job.steps.every((step) => !String(step.if || '').includes('cache-hit'))).toBe(true);
    }
  });

  it('restores only isolated Gradle downloads after npm ci and leaves APK/provenance/build state uncached', () => {
    for (const job of [ci.jobs['android-native-release'], qa.jobs['android-qa']]) {
      const cache = job.steps.find((step) => step.name === 'Cache isolated Gradle downloads');
      expect(job.steps.indexOf(cache)).toBeGreaterThan(job.steps.findIndex((step) => step.run === 'npm ci'));
      const projectRoot = path.resolve(__dirname, '..');
      const isolatedHome = path.relative(projectRoot, resolveIsolatedAndroidGradleUserHome(projectRoot, { platform: 'linux' }));
      expect(cache.with.path.trim().split('\n')).toEqual([
        `${isolatedHome}/caches/modules-2/files-2.1`, `${isolatedHome}/wrapper/dists`,
      ]);
      expect(cache.with.key).toContain('scripts/android-build-provenance.js');
      expect(cache.with.path).not.toMatch(/build-cache|\.cxx|gradle\.properties|apk|provenance|android\/app/);
      const files = { 'package-lock.json': 'locked dependencies', 'plugins/withAndroidReleaseConfig.js': 'config',
        'scripts/android-build-provenance.js': 'build policy', 'docs/report.md': 'old report' };
      const key = (snapshot) => interpolate(cache.with.key, { runner: { os: 'Linux' }, files: snapshot });
      expect(key({ ...files, 'docs/report.md': 'new report' })).toBe(key(files));
      expect(key({ ...files, 'package-lock.json': 'new dependencies' })).not.toBe(key(files));
      expect(key({ ...files, 'scripts/android-build-provenance.js': 'new build policy' })).not.toBe(key(files));
      expect(job.steps.every((step) => !String(step.if || '').includes('cache-hit'))).toBe(true);
    }
  });
});
