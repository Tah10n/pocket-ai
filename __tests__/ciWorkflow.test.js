const fs = require('fs');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');

const readAppFile = (...segments) => fs.readFileSync(path.join(appRoot, ...segments), 'utf8');

const packLabelPriority = [
  'android-pack-all',
  'android-pack-documents',
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
  const packageJson = JSON.parse(readAppFile('package.json'));
  const dependabot = readAppFile('.github', 'dependabot.yml');
  const androidSmoke = readAppFile('scripts', 'android-smoke.js');
  const androidBuildProvenance = readAppFile('scripts', 'android-build-provenance.js');
  const releaseWorkflow = readAppFile('.github', 'workflows', 'release-please.yml');

  it('lets the catalog pack label trigger Android QA and select the catalog pack', () => {
    const selection = extractAndroidQaPackSelection(workflow);

    expect(workflow).toContain("contains(github.event.pull_request.labels.*.name, 'android-pack-catalog')");
    expect(selection).toContain("contains(github.event.pull_request.labels.*.name, 'android-pack-catalog')");
    expect(selection).toContain('pack="catalog"');
    expect(workflow).toContain('--pack "$ANDROID_QA_PACK"');
  });

  it('lets the document label and checkbox run the hosted release document pack', () => {
    const selection = extractAndroidQaPackSelection(workflow);
    const hostedJob = extractWorkflowJob(workflow, 'android-qa');

    expect(hostedJob).toContain('timeout-minutes: 120');
    expect(workflow).toContain("contains(github.event.pull_request.labels.*.name, 'android-pack-documents')");
    expect(workflow).toContain("contains(github.event.pull_request.body, '- [x] Run Android document pack')");
    expect(selection).toContain("contains(github.event.pull_request.labels.*.name, 'android-pack-documents')");
    expect(selection).toContain('pack="documents"');
    expect(workflow).toContain('ANDROID_SMOKE_APK_VARIANT: release');
    expect(androidSmoke).toContain('ANDROID_UNIVERSAL_ABIS');
    expect(androidBuildProvenance).toContain('libpocket_anydoc.so');
    expect(androidBuildProvenance).toContain('"arm64-v8a"');
    expect(androidBuildProvenance).toContain('"x86_64"');
    expect(packageJson.scripts['android:scenarios:documents']).toContain('--pack documents');
  });

  it('keeps destructive branch regeneration local-only', () => {
    expect(workflow).not.toContain('android-pack-branch-regeneration');
    expect(workflow).not.toContain('android-branch-regeneration');
    expect(workflow).not.toContain('pocket-ai-branch-regeneration');
    expect(workflow).not.toContain('POCKET_AI_BRANCH_QA_SERIAL');
    expect(workflow).not.toContain('self-hosted');
    expect(packageJson.scripts['android:scenarios:branch-regeneration']).toBe(
      'node ./scripts/android-scenarios.js --pack branch-regeneration --apk-variant release --fail-on-skip'
    );
    expect(contributing).toContain('branch-regeneration` pack is local-only');
    expect(releaseChecklist).toContain('intentionally local-only');
  });

  it('defaults Android QA to runtime and delegates build reuse to the provenance-aware launcher', () => {
    const selection = extractAndroidQaPackSelection(workflow);
    const hostedJob = extractWorkflowJob(workflow, 'android-qa');
    const scenarioStep = workflow.match(/- name: Run Android scenarios[\s\S]+?script: ([^\n]+)/)?.[0] || '';

    expect(selection).toContain('pack="runtime"');
    expect(scenarioStep).toContain('--fail-on-skip');
    expect(scenarioStep).not.toContain('--skip-build');
    expect(hostedJob).not.toContain('npx expo prebuild');
    expect(hostedJob).not.toContain('run: ./gradlew app:assembleRelease');
    expect(hostedJob).not.toContain('gradle/actions/setup-gradle');
    expect(workflow).toContain('POCKET_AI_ALLOW_DEBUG_RELEASE_SIGNING: "true"');
  });

  it('uses the pinned Rust toolchain in existing jobs and tracks Cargo dependencies', () => {
    const verifyJob = extractWorkflowJob(workflow, 'verify');
    const androidJob = extractWorkflowJob(workflow, 'android-qa');

    expect(verifyJob).toContain('uses: dtolnay/rust-toolchain@1.97.1');
    expect(verifyJob).toContain('components: rustfmt, clippy');
    expect(verifyJob).toContain('run: npm run verify:release');
    expect(packageJson.scripts['verify:mobile-change']).toContain('npm run anydoc:verify');
    expect(packageJson.scripts['anydoc:fmt:check']).toContain('--package pocket-anydoc');
    expect(packageJson.scripts['anydoc:fmt:check']).not.toContain('--all');
    expect(androidJob).toContain('uses: dtolnay/rust-toolchain@1.97.1');
    expect(androidJob).toContain('targets: aarch64-linux-android, x86_64-linux-android');
    expect(androidJob).toContain('cargo install cargo-ndk --version 4.1.2 --locked');
    expect(verifyJob).not.toContain('runs-on: macos');
    expect(androidJob).not.toContain('self-hosted');
    expect(dependabot).toContain('package-ecosystem: cargo');
    expect(dependabot).toContain('directory: /modules/pocket-anydoc/rust');
  });

  it('keeps hosted diagnostics short-lived and uploads APKs for explicit all/document runs', () => {
    const hostedJob = extractWorkflowJob(workflow, 'android-qa');
    const hostedDiagnostics = extractWorkflowStep(hostedJob, 'Upload Android QA diagnostics');
    const hostedApk = extractWorkflowStep(hostedJob, 'Upload Android QA APK');

    expect(hostedDiagnostics).toContain('if: always()');
    expect(hostedDiagnostics).toContain('retention-days: 1');
    expect(hostedDiagnostics).toContain('artifacts/android-scenarios/**');
    expect(hostedDiagnostics).toContain('artifacts/bootstrap-logcat.txt');
    expect(hostedDiagnostics).not.toContain('app-release.apk');

    expect(hostedApk).toContain('success()');
    expect(hostedApk).toContain(
      "contains(github.event.pull_request.labels.*.name, 'android-pack-all')"
    );
    expect(hostedApk).toContain(
      "contains(github.event.pull_request.labels.*.name, 'android-pack-documents')"
    );
    expect(hostedApk).toContain('name: android-qa-apk');
    expect(hostedApk).toContain('if-no-files-found: error');
    expect(hostedApk).toContain('retention-days: 1');
    expect(hostedApk).toContain('android/app/build/outputs/apk/release/app-release.apk');
  });

  it('keeps CI pack label priority documented in the same order', () => {
    const selection = extractAndroidQaPackSelection(workflow);
    const documentedPriority = packLabelPriority.join('`, `').replace('`, `android-pack-extended', '`, then `android-pack-extended');
    for (const label of packLabelPriority) {
      expect(prTemplate).toContain(label);
      expect(contributing).toContain(label);
      expect(releaseChecklist).toContain(label);
    }

    expect(normalizeWhitespace(contributing)).toContain(documentedPriority);
    expect(normalizeWhitespace(releaseChecklist)).toContain(documentedPriority);
    expect(normalizeWhitespace(prTemplate)).toContain(documentedPriority);

    const workflowIndexes = packLabelPriority.map((label) => selection.indexOf(`'${label}'`));
    expect(workflowIndexes.every((index) => index >= 0)).toBe(true);
    expect(workflowIndexes).toEqual([...workflowIndexes].sort((a, b) => a - b));
  });

  it('requires release-sensitive PRs to exercise Android 32-35 and production iOS native projects', () => {
    const nativeScope = extractWorkflowJob(workflow, 'native-scope');
    const androidGate = extractWorkflowJob(workflow, 'android-native-release');
    const iosGate = extractWorkflowJob(workflow, 'ios-native-release');

    expect(workflow).toContain("startsWith(github.head_ref, 'release-please--')");
    expect(nativeScope).toContain('contents: read');
    expect(nativeScope).toContain('pull-requests: read');
    expect(nativeScope).toContain("'.github/workflows/ci.yml'");
    expect(nativeScope).toContain("'.github/workflows/release-please.yml'");
    expect(nativeScope).toContain("'scripts/android-*.js'");
    expect(nativeScope).toContain("'scripts/build-android-release.js'");
    expect(nativeScope).toContain("'src/services/BackgroundTaskService.ts'");
    expect(nativeScope).toContain("'src/services/NotificationService.ts'");
    expect(androidGate).toContain('api-level: [32, 33, 34, 35]');
    expect(androidGate).toContain('--pack native');
    expect(androidGate).toContain('--apk-variant release');
    expect(androidGate).toContain('--isolated-qa-install');
    expect(androidGate).toContain('npm run verify:native-config -- --require-android');
    expect(iosGate).toContain('npm run anydoc:build:ios');
    expect(iosGate).toContain('npm run verify:native-config -- --require-ios');
    expect(iosGate).toContain('runs-on: macos-26');
    expect(iosGate).not.toContain('runs-on: macos-15');
    expect(iosGate).toContain('xcodebuild -workspace ios/pocketai.xcworkspace -scheme PocketAI');
    expect(iosGate).toContain('CODE_SIGNING_ALLOWED=NO build');
    expect(iosGate).not.toContain('CLANG_ENABLE_EXPLICIT_MODULES=NO');
    expect(iosGate).not.toContain('-scheme pocketai');
    expect(iosGate).toContain('NODE_ENV: production');
    expect(iosGate).toContain('EAS_BUILD_PROFILE: production');
  });

  it('does not create a release tag before Android and iOS release gates pass', () => {
    const androidGate = extractWorkflowJob(releaseWorkflow, 'android-release-gate');
    const iosGate = extractWorkflowJob(releaseWorkflow, 'ios-release-gate');
    const releaseJob = extractWorkflowJob(releaseWorkflow, 'release-please');

    expect(releaseWorkflow).toContain('concurrency:');
    expect(releaseWorkflow).toContain('group: release-please-${{ github.ref }}');
    expect(releaseWorkflow).toContain('cancel-in-progress: true');
    expect(releaseWorkflow).toMatch(/permissions:\r?\n  contents: read/);
    expect(androidGate).toContain('permissions:\n      contents: read');
    expect(androidGate).toContain('persist-credentials: false');
    expect(androidGate).not.toContain('contents: write');
    expect(iosGate).toContain('permissions:\n      contents: read');
    expect(iosGate).toContain('persist-credentials: false');
    expect(iosGate).not.toContain('contents: write');
    expect(releaseJob).toContain('contents: write');
    expect(releaseJob).toContain('pull-requests: write');
    expect(releaseWorkflow).toContain('android-release-gate:');
    expect(releaseWorkflow).toContain('ios-release-gate:');
    expect(releaseWorkflow).toContain('build:android:production:clean');
    expect(iosGate).toContain('runs-on: macos-26');
    expect(iosGate).not.toContain('runs-on: macos-15');
    expect(releaseWorkflow).toContain('xcodebuild -workspace ios/pocketai.xcworkspace -scheme PocketAI');
    expect(releaseWorkflow).toContain('CODE_SIGNING_ALLOWED=NO build');
    expect(releaseWorkflow).not.toContain('CLANG_ENABLE_EXPLICIT_MODULES=NO');
    expect(releaseWorkflow).not.toContain('-scheme pocketai');
    expect(iosGate).toContain('NODE_ENV: production');
    expect(iosGate).toContain('EAS_BUILD_PROFILE: production');
    expect(releaseJob).toContain('- android-release-gate');
    expect(releaseJob).toContain('- ios-release-gate');
    expect(releaseJob).toContain('name: Verify gated revision is still main HEAD');
    expect(releaseJob).toContain('git ls-remote origin refs/heads/main');
    expect(releaseJob).toContain('current_head" != "$GITHUB_SHA');
    expect(releaseJob.indexOf('Verify gated revision is still main HEAD')).toBeLessThan(
      releaseJob.indexOf('Run Release Please'),
    );
  });
});
