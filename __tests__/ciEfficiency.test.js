const fs = require('fs');
const path = require('path');
const vm = require('vm');
const YAML = require('yaml');

const workflow = (name) => YAML.parse(fs.readFileSync(path.resolve(__dirname, '../.github/workflows', name), 'utf8'));
const ci = workflow('ci.yml');
const qa = workflow('android-qa.yml');
const title = workflow('pr-title.yml');

// Evaluate the checked-in boolean/string expressions, with missing Actions
// properties represented as null. actionlint validates their Actions syntax.
function evaluate(expression, context) {
  const source = expression.replace(/^\s*\$\{\{\s*|\s*\}\}\s*$/g, '')
    .replace(/\b(?:github|needs|matrix)(?:\.[a-zA-Z0-9_-]+)+/g, (key) =>
      JSON.stringify(key.split('.').reduce((value, segment) => value?.[segment], context) ?? null));
  return vm.runInNewContext(source, {
    always: () => true,
    failure: () => context.failed === true,
    cancelled: () => context.cancelled === true,
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
});
