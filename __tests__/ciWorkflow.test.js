const fs = require('fs');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');

const readAppFile = (...segments) => fs.readFileSync(path.join(appRoot, ...segments), 'utf8');

const packLabelPriority = [
  'android-pack-all',
  'android-pack-branch-regeneration',
  'android-pack-native',
  'android-pack-runtime',
  'android-pack-dependency-ui',
  'android-pack-catalog',
  'android-pack-extended',
];

const extractAndroidQaPackSelection = (workflow) => {
  const match = workflow.match(/- name: Select Android QA pack[\s\S]+?echo "ANDROID_QA_PACK=\$pack"/);
  if (!match) {
    throw new Error('Could not find Android QA pack selection step in CI workflow.');
  }

  return match[0];
};

const extractWorkflowJob = (workflow, jobName) => {
  const lines = workflow.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${jobName}:`);
  if (start < 0) {
    throw new Error(`Could not find ${jobName} in CI workflow.`);
  }
  const nextJobOffset = lines
    .slice(start + 1)
    .findIndex((line) => /^  [a-z0-9-]+:$/.test(line));
  const end = nextJobOffset < 0 ? lines.length : start + 1 + nextJobOffset;
  return lines.slice(start, end).join('\n');
};

const extractWorkflowStep = (workflowSection, stepName) => {
  const lines = workflowSection.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  if (start < 0) {
    throw new Error(`Could not find ${stepName} in CI workflow.`);
  }

  const indentation = lines[start].match(/^\s*/)?.[0].length ?? 0;
  const nextStepOffset = lines
    .slice(start + 1)
    .findIndex(
      (line) =>
        line.trimStart().startsWith('- name:') &&
        (line.match(/^\s*/)?.[0].length ?? -1) === indentation
    );
  const end = nextStepOffset < 0 ? lines.length : start + 1 + nextStepOffset;
  return lines.slice(start, end).join('\n');
};

const normalizeWhitespace = (value) => value.replace(/\s+/g, ' ').trim();

describe('Android catalog QA CI configuration', () => {
  const workflow = readAppFile('.github', 'workflows', 'ci.yml');
  const prTemplate = readAppFile('.github', 'PULL_REQUEST_TEMPLATE.md');
  const contributing = readAppFile('CONTRIBUTING.md');
  const releaseChecklist = readAppFile('docs', 'release-checklist.md');

  it('lets the catalog pack label trigger Android QA and select the catalog pack', () => {
    const selection = extractAndroidQaPackSelection(workflow);

    expect(workflow).toContain("contains(github.event.pull_request.labels.*.name, 'android-pack-catalog')");
    expect(selection).toContain("contains(github.event.pull_request.labels.*.name, 'android-pack-catalog')");
    expect(selection).toContain('pack="catalog"');
    expect(workflow).toContain('--pack "$ANDROID_QA_PACK"');
  });

  it('routes destructive branch regeneration only to a serialized prepared runner', () => {
    const hostedJob = extractWorkflowJob(workflow, 'android-qa');
    const branchJob = extractWorkflowJob(workflow, 'android-branch-regeneration');
    const hostedSelection = extractAndroidQaPackSelection(workflow);

    expect(branchJob).toContain(
      "contains(github.event.pull_request.labels.*.name, 'android-pack-branch-regeneration')"
    );
    expect(branchJob).toContain(
      "!contains(github.event.pull_request.labels.*.name, 'android-pack-all')"
    );
    expect(branchJob).toContain('- self-hosted');
    expect(branchJob).toContain('- pocket-ai-branch-regeneration');
    expect(branchJob).toContain('persist-credentials: false');
    expect(branchJob).toContain('group: pocket-ai-branch-regeneration');
    expect(branchJob).toContain('cancel-in-progress: false');
    expect(branchJob).toContain('POCKET_AI_BRANCH_QA_SERIAL');
    expect(branchJob).toContain('shell pm path com.github.tah10n.pocketai');
    expect(branchJob).toContain('npm run android:scenarios:branch-regeneration');
    expect(branchJob).toContain('--fail-on-skip');
    expect(branchJob).not.toContain('--skip-build');
    expect(branchJob).not.toContain('--preserve-running-app');
    expect(branchJob).not.toContain('android-emulator-runner');
    expect(branchJob).toContain('ANDROID_SMOKE_APK_VARIANT: release');
    expect(hostedJob).toContain(
      "!contains(github.event.pull_request.labels.*.name, 'android-pack-branch-regeneration')"
    );
    expect(hostedSelection).not.toContain('android-pack-branch-regeneration');
  });

  it('defaults Android QA to runtime and delegates build reuse to the provenance-aware launcher', () => {
    const selection = extractAndroidQaPackSelection(workflow);
    const scenarioStep = workflow.match(/- name: Run Android scenarios[\s\S]+?script: ([^\n]+)/)?.[0] || '';

    expect(selection).toContain('pack="runtime"');
    expect(scenarioStep).toContain('--fail-on-skip');
    expect(scenarioStep).not.toContain('--skip-build');
    expect(workflow).not.toContain('npx expo prebuild');
    expect(workflow).not.toContain('run: ./gradlew app:assembleRelease');
    expect(workflow).not.toContain('gradle/actions/setup-gradle');
    expect(workflow).toContain('POCKET_AI_ALLOW_DEBUG_RELEASE_SIGNING: "true"');
  });

  it('keeps diagnostics short-lived and uploads APKs only for explicit provenance runs', () => {
    const hostedJob = extractWorkflowJob(workflow, 'android-qa');
    const branchJob = extractWorkflowJob(workflow, 'android-branch-regeneration');
    const hostedDiagnostics = extractWorkflowStep(hostedJob, 'Upload Android QA diagnostics');
    const hostedApk = extractWorkflowStep(hostedJob, 'Upload Android QA APK');
    const branchDiagnostics = extractWorkflowStep(
      branchJob,
      'Upload branch-regeneration QA diagnostics'
    );
    const branchApk = extractWorkflowStep(branchJob, 'Upload branch-regeneration QA APK');

    for (const diagnostics of [hostedDiagnostics, branchDiagnostics]) {
      expect(diagnostics).toContain('if: always()');
      expect(diagnostics).toContain('retention-days: 3');
      expect(diagnostics).toContain('artifacts/android-scenarios/**');
      expect(diagnostics).toContain('artifacts/bootstrap-logcat.txt');
      expect(diagnostics).not.toContain('app-release.apk');
    }

    expect(hostedApk).toContain('success()');
    expect(hostedApk).toContain(
      "contains(github.event.pull_request.labels.*.name, 'android-pack-all')"
    );
    expect(hostedApk).toContain('name: android-qa-apk');
    expect(branchApk).toContain('if: success()');
    expect(branchApk).toContain('name: android-branch-regeneration-apk');

    for (const apk of [hostedApk, branchApk]) {
      expect(apk).toContain('if-no-files-found: error');
      expect(apk).toContain('retention-days: 3');
      expect(apk).toContain('android/app/build/outputs/apk/release/app-release.apk');
    }
  });

  it('keeps CI pack label priority documented in the same order', () => {
    const selection = extractAndroidQaPackSelection(workflow);
    const documentedPriority = packLabelPriority.join('`, `').replace('`, `android-pack-extended', '`, then `android-pack-extended');
    const hostedPackLabelPriority = packLabelPriority.filter(
      (label) => label !== 'android-pack-branch-regeneration'
    );

    for (const label of packLabelPriority) {
      expect(prTemplate).toContain(label);
      expect(contributing).toContain(label);
      expect(releaseChecklist).toContain(label);
    }

    expect(normalizeWhitespace(contributing)).toContain(documentedPriority);
    expect(normalizeWhitespace(releaseChecklist)).toContain(documentedPriority);
    expect(normalizeWhitespace(prTemplate)).toContain(documentedPriority);

    const workflowIndexes = hostedPackLabelPriority.map((label) => selection.indexOf(`'${label}'`));
    expect(workflowIndexes.every((index) => index >= 0)).toBe(true);
    expect(workflowIndexes).toEqual([...workflowIndexes].sort((a, b) => a - b));
  });
});
