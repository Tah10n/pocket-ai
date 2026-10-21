'use strict';

// Compile the actual pure path helper and JVM tests. This is not device decode proof.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cachedJar, run } = require('./test-expo-audio-focus-android');

async function main(options = {}) {
  process.stdout.write(`Preparation path harness PID ${process.pid}\n`);
  const cache = path.join(options.gradleHome || process.env.GRADLE_USER_HOME || path.join(os.homedir(), '.gradle'),
    'caches/modules-2/files-2.1');
  const specifications = [['org.jetbrains.kotlin', 'kotlin-compiler-embeddable', '2.1.20'],
    ['org.jetbrains.kotlin', 'kotlin-stdlib', '2.1.20'], ['org.jetbrains.kotlin', 'kotlin-script-runtime', '2.1.20'],
    ['org.jetbrains.kotlin', 'kotlin-reflect', '1.6.10'], ['org.jetbrains.kotlin', 'kotlin-daemon-embeddable', '2.1.20'],
    ['org.jetbrains.intellij.deps', 'trove4j', '1.0.20200330'], ['org.jetbrains.kotlinx', 'kotlinx-coroutines-core-jvm', '1.8.0'],
    ['org.jetbrains', 'annotations', '13.0'], ['junit', 'junit', '4.13.2'], ['org.hamcrest', 'hamcrest-core', '1.3']];
  const jars = specifications.map(item => cachedJar(cache, ...item));
  const fixtureParent = path.resolve(options.fixtureParent || os.tmpdir());
  const temp = fs.mkdtempSync(path.join(fixtureParent, 'pocket-preparation-path-'));
  try {
    const moduleRoot = path.resolve(__dirname, '../modules/pocket-audio-preparation/android/src');
    const packagePath = path.join('com', 'github', 'tah10n', 'pocketaudio');
    const source = path.join(moduleRoot, 'main/java', packagePath);
    const tests = path.join(moduleRoot, 'test/java', packagePath);
    const classes = path.join(temp, 'classes');
    const runtime = [jars[1], jars[7], jars[8], jars[9]];
    const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin/java') : 'java';
    await run(java, ['-Xms32m', '-Xmx256m', '-XX:ActiveProcessorCount=2', '-cp', jars.join(path.delimiter),
      'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-classpath', runtime.join(path.delimiter),
      '-d', classes, path.join(source, 'PreparedAudioPath.kt'), path.join(tests, 'PreparedAudioPathTest.kt'),
      path.join(source, 'BoundedAudioPcm.kt'), path.join(tests, 'BoundedAudioPcmTest.kt')],
    'compile actual preparation paths and bounded PCM tests', temp);
    process.stdout.write(await run(java, ['-Xms16m', '-Xmx96m', '-XX:ActiveProcessorCount=2', `-Djava.io.tmpdir=${temp}`, '-cp',
      [classes, ...runtime].join(path.delimiter), 'org.junit.runner.JUnitCore',
      'com.github.tah10n.pocketaudio.PreparedAudioPathTest', 'com.github.tah10n.pocketaudio.BoundedAudioPcmTest'],
    'execute preparation alias containment and PCM regressions', temp));
  } finally {
    if (path.dirname(path.resolve(temp)) !== fixtureParent
      || !path.basename(temp).startsWith('pocket-preparation-path-')) throw new Error('Unsafe preparation fixture cleanup target');
    fs.rmSync(temp, { recursive: true, force: true });
    if (fs.existsSync(temp)) throw new Error('Preparation fixture cleanup failed');
  }
}
module.exports = { main };
if (require.main === module) main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
