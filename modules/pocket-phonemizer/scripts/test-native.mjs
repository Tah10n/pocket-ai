// SPDX-License-Identifier: GPL-3.0-or-later
// Run under the caller's bounded process/job owner. No downloads or device operations.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { root, prepareSource } from './prepare-source.mjs';
const cmake = process.env.CMAKE ?? 'cmake';
if (!process.env.JAVA_HOME || !existsSync(path.join(process.env.JAVA_HOME, 'include/jni.h'))) {
  throw new Error('phonemizer_native_tests_require_jdk_java_home');
}
const started = Date.now();
function run(command, args, timeout = 180000) {
  const remaining = 330000 - (Date.now() - started);
  if (remaining <= 0) throw new Error('phonemizer_native_test_deadline');
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true, timeout: Math.min(timeout, remaining) });
  if (result.error || result.status !== 0) throw new Error('phonemizer_native_test_failed');
}
prepareSource();
run(process.execPath, [path.join(root, 'scripts/verify-data.mjs')]);
const output = path.join(root, 'generated/native-tests');
mkdirSync(output, { recursive: true });
const corpusPath = path.resolve(root, '../../__tests__/fixtures/tts/eSpeak-canonical-corpus.json');
const corpusBytes = readFileSync(corpusPath);
const corpus = JSON.parse(corpusBytes);
assert(Array.isArray(corpus) && corpus.length > 0 && corpus.length <= 64);
const nativeCases = corpus.filter(item => {
  assert(typeof item.id === 'string' && Array.isArray(item.chunks) && Array.isArray(item.raw));
  assert(item.chunks.length === item.raw.length && item.chunks.length <= 240);
  assert(item.chunks.every(chunk => typeof chunk === 'string') && item.raw.every(value => typeof value === 'string'));
  assert(item.chunks.reduce((sum, chunk) => sum + chunk.length, 0) <= 240);
  return item.chunks.length > 0;
});
const input = path.join(output, 'input.tsv');
const actualFile = path.join(output, 'actual.tsv');
const hexRow = values => values.map(value => Buffer.from(value, 'utf8').toString('hex')).join('\t');
writeFileSync(input, nativeCases.map(item => hexRow(item.chunks)).join('\n') + '\n');
run(cmake, ['-S', path.join(root, 'cpp/tests'), '-B', output, '-DCMAKE_BUILD_TYPE=Release']);
run(cmake, ['--build', output, '--config', 'Release', '--target', 'core_lifecycle', 'core_real', 'jni_failures', '--parallel', '2']);
const executable = name => path.join(output, 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
run(executable('core_lifecycle'), [path.join(root, 'assets/espeak-ng-data')], 15000);
run(executable('jni_failures'), [], 15000);
run(executable('core_real'), [path.join(root, 'assets/espeak-ng-data'), input, actualFile], 30000);
const actual = readFileSync(actualFile, 'utf8').replaceAll('\r\n', '\n');
const expected = nativeCases.map(item => hexRow(item.raw)).join('\n') + '\n';
assert.equal(actual, expected, 'same-source mobile Core output differs from independent canonical corpus');
writeFileSync(path.join(output, 'verification.json'), JSON.stringify({
  schemaVersion: 1, status: 'passed', scope: 'host_actual_mobile_core_and_fault_injected_jni_not_device_proof',
  corpusSha256: createHash('sha256').update(corpusBytes).digest('hex'),
  corpusCases: corpus.length, nativeCases: nativeCases.length, rawParity: true,
  lifecycle: 'passed', jniAllocationFailures: 'passed', elapsedMs: Date.now() - started,
}, null, 2) + '\n');
console.log(`Phonemizer native checks passed: lifecycle, JNI faults, ${nativeCases.length} actual-C corpus rows.`);
