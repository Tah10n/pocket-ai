/* global describe, it, expect */
const { STEP_IDS, IDENTITIES, sanitizeModelResourcesEvidence, validateModelResourcesEvidence,
  waitForModelResourcesEvidence } = require('../../scripts/lib/model-resources-evidence');
const fixture = () => ({ schemaVersion: 1, status: 'passed', phase: 'complete', requiresForceStop: false,
  ...IDENTITIES, steps: STEP_IDS.map(id => ({ id, status: 'passed', callbacks: 2, tokensPredicted: 2,
    tokensEvaluated: 12, outputCharacters: 8, dimensions: 384, finite: true,
    chatUnchanged: true, settingsUnchanged: true, contextChanged: true })) });
describe('stage 2 native resource evidence', () => {
  it('accepts complete A-B-A evidence with the pinned specialized model', () => {
    expect(validateModelResourcesEvidence(fixture()).status).toBe('passed');
  });
  it.each(['auxiliaryModelSha256', 'auxiliaryRevision', 'chatModelSha256'])('rejects a changed %s', field => {
    expect(() => validateModelResourcesEvidence({ ...fixture(), [field]: 'unverified' })).toThrow(/identities/);
  });
  it.each(['dimensions', 'finite', 'chatUnchanged', 'settingsUnchanged', 'contextChanged', 'callbacks'])(
    'does not infer missing %s from a passed label', field => {
      const value = fixture();
      value.steps.forEach(step => { delete step[field]; });
      expect(() => validateModelResourcesEvidence(value)).toThrow();
    });
  it('drops vectors, input, paths and arbitrary failure strings', () => {
    const value = fixture();
    value.prompt = 'PRIVATE'; value.vector = [1, 2]; value.failureCode = '/private/file';
    value.steps[3].vector = [1, 2]; value.steps[3].path = '/private/model';
    const safe = JSON.stringify(sanitizeModelResourcesEvidence(value));
    expect(safe).not.toMatch(/PRIVATE|private|vector/);
  });
  it('stops bounded polling on failed and never accepts a partial sequence', async () => {
    await expect(waitForModelResourcesEvidence(async () => ({ ...fixture(), status: 'failed', failureCode: 'timeout' }))).rejects.toThrow(/timeout/);
    const value = fixture(); value.steps.pop();
    await expect(waitForModelResourcesEvidence(async () => value)).rejects.toThrow(/Incomplete/);
  });
});
