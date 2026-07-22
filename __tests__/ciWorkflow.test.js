const fs = require('fs');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');

const readAppFile = (...segments) => fs.readFileSync(path.join(appRoot, ...segments), 'utf8');

const packLabelPriority = [
  'android-pack-all',
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

  it('keeps CI pack label priority documented in the same order', () => {
    const selection = extractAndroidQaPackSelection(workflow);
    const documentedPriority = packLabelPriority.join('`, `').replace('`, `android-pack-extended', '`, then `android-pack-extended');

    for (const label of packLabelPriority) {
      expect(prTemplate).toContain(label);
      expect(contributing).toContain(label);
      expect(releaseChecklist).toContain(label);
    }

    expect(contributing).toContain(documentedPriority);
    expect(releaseChecklist).toContain(documentedPriority);
    expect(prTemplate).toContain(documentedPriority);

    const workflowIndexes = packLabelPriority.map((label) => selection.indexOf(`'${label}'`));
    expect(workflowIndexes.every((index) => index >= 0)).toBe(true);
    expect(workflowIndexes).toEqual([...workflowIndexes].sort((a, b) => a - b));
  });
});
