'use strict';

// Actual guarded recorder state methods, compiled and executed against bounded
// MediaRecorder/Expo substitutes. This does not establish device capture/content.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { block, guardedSource, cachedJar, run } = require('./test-expo-audio-focus-android');

function extract(source, anchor) {
  const at = source.indexOf(anchor);
  if (at < 0) throw new Error(`Missing recorder method: ${anchor}`);
  return source.slice(at, source.indexOf('{', at)) + '{' + block(source, anchor) + '}';
}
function harness(source, module) {
  const methods = ['fun cancelRequest(', 'suspend fun prepareExplicit(', 'fun startExplicit(', 'private fun explicitStatus(',
    'fun finishExplicit(', 'fun disposeExplicit('].map(anchor => extract(source, anchor)).join('\n');
  const errorLine = source.split('\n').find(line => line.includes('private fun captureError('));
  const nativeLimits = block(block(source, 'private fun setRecordingOptions('), 'if (preventAutomaticResume)');
  const timerLine = block(source, 'fun recordWithOptions(').split('\n').find(line => line.trim().startsWith('delay('));
  const timerExpression = timerLine?.match(/^\s*delay\((.+)\)\s*$/)?.[1];
  if (!timerExpression) throw new Error('Missing native recorder timer conversion');
  const foregroundBody = block(module, 'OnActivityEntersForeground').slice(
    block(module, 'OnActivityEntersForeground').indexOf('      if (!allowsBackgroundRecording)'),
    block(module, 'OnActivityEntersForeground').indexOf('      if (shouldRouteThroughEarpiece)'));
  const backgroundBody = block(module, 'OnActivityEntersBackground').slice(
    block(module, 'OnActivityEntersBackground').indexOf('      if (!allowsBackgroundRecording)'));
  return `
import java.io.File
class CodedException(val code: String, message: String, cause: Throwable?) : RuntimeException(message)
class Bundle : HashMap<String, Any?>() {
  fun putBoolean(key: String, value: Boolean) { put(key, value) }
  fun putLong(key: String, value: Long) { put(key, value) }
  fun putInt(key: String, value: Int) { put(key, value) }
  fun putString(key: String, value: String) { put(key, value) }
}
const val RECORDING_STATUS_UPDATE = "recordingStatusUpdate"
class NativeRecorder {
  var starts = 0; var stops = 0; var releases = 0
  var maxDurationMillis = 0; var maxFileBytes = 0L
  var failStart = false; var failStop = false; var failRelease = false
  fun setMaxDuration(value: Int) { maxDurationMillis = value }
  fun setMaxFileSize(value: Long) { maxFileBytes = value }
  fun start() { if (failStart) throw RuntimeException("start failed"); starts++ }
  fun stop() { stops++; if (failStop) throw RuntimeException("stop failed") }
  fun release() { if (failRelease) throw RuntimeException("release failed"); releases++ }
}
class ServiceConnection { fun release() {}; fun unbind() {}; fun cleanup() {} }
class AudioRecorder(val filePath: String) {
  val id = "owned"
  var preventAutomaticResume = false
  var recordingRequestId = 0
  var disposalStarted = false
  var disposed = false
  var explicitDurationSeconds = 0.0
  var explicitMaxBytes = 0L
  var explicitFinished: Bundle? = null
  @Volatile private var cancelledRequestId = 0
  var useForegroundService = false
  var isPrepared = false; var isRecording = false; var isPaused = false
  var recorder: NativeRecorder? = null
  var duration = 1000L
  var timerDeadlineMillis = 0L
  var events = 0
  val serviceConnection = ServiceConnection()
  ${errorLine}
  suspend fun prepareRecording(options: Any?) {
    recorder = NativeRecorder()
    if (preventAutomaticResume) { with(recorder!!) { ${nativeLimits} } }
    isPrepared = true; File(filePath).writeBytes(ByteArray(64))
  }
  fun recordWithOptions(forDurationSeconds: Double) {
    recorder!!.start(); isRecording = true; isPaused = false
    // Execute the installed coroutine's exact Double-to-milliseconds expression.
    val it = forDurationSeconds
    timerDeadlineMillis = ${timerExpression}
  }
  fun record() { recorder!!.start(); isRecording = true; isPaused = false }
  fun pauseRecording() { isRecording = false; isPaused = true }
  fun reset() { recorder?.release(); recorder = null; isPrepared = false; isRecording = false; isPaused = false }
  fun currentFileUrl(): String = File(filePath).toURI().toString()
  fun getAudioRecorderDurationMillis(): Long = duration
  fun emit(event: String, args: Map<String, Any?>) { events++ }
  ${methods}
}
class AudioModule {
  val recorders = linkedMapOf<String, AudioRecorder>()
  var allowsBackgroundRecording = false
  fun background() { ${backgroundBody} }
  fun foreground() { ${foregroundBody} }
}
suspend fun main(args: Array<String>) {
  var passed = 0
  suspend fun test(name: String, action: suspend () -> Unit) { action(); passed++; println("PASS " + name) }
  fun recorder(): AudioRecorder = AudioRecorder(File(args[0], "capture-" + System.nanoTime() + ".m4a").path).apply { preventAutomaticResume = true }
  suspend fun started(): AudioRecorder = recorder().apply { prepareExplicit(1, 8.0, 2 * 1024 * 1024); startExplicit(1) }
  fun refused(code: String, action: () -> Unit) { try { action(); error("expected refusal") } catch (error: CodedException) { check(error.code == code) } }
  test("unopted prepare is refused") { val r = recorder(); r.preventAutomaticResume = false; try { r.prepareExplicit(1, 8.0, 1000); error("accepted") } catch (error: CodedException) { check(error.code == "ERR_AUDIO_CAPTURE_NOT_OPTED_IN") } }
  test("oversized duration refuses before native prepare") { val r = recorder(); try { r.prepareExplicit(1, 31.0, 1000); error("accepted") } catch (error: CodedException) { check(error.code == "ERR_AUDIO_CAPTURE_LIMITS" && r.recorder == null) } }
  test("prepare is status, not capture") { val r = recorder(); val status = r.prepareExplicit(2, 8.0, 1000); check(status["canRecord"] == true && status["isRecording"] == false && status["recordingRequestId"] == 2); r.disposeExplicit() }
  for ((captureSeconds, admissionMillis, maxBytes) in listOf(Triple(29.5, 30000L, 4 * 1024 * 1024), Triple(7.5, 8000L, 2 * 1024 * 1024))) {
    test("fractional native capture reserve " + captureSeconds + " survives delayed finalization") {
      val r = recorder(); r.prepareExplicit(1, captureSeconds, maxBytes); val native = r.recorder!!
      check(native.maxDurationMillis.toLong() == admissionMillis - 500 && native.maxFileBytes == maxBytes.toLong())
      r.startExplicit(1)
      check(r.timerDeadlineMillis == admissionMillis - 500 && native.starts == 1)
      r.duration = r.timerDeadlineMillis + 95
      val status = r.finishExplicit(1)
      check(status["durationMillis"] == admissionMillis - 405 && status["hasError"] == false && status["isFinished"] == true)
      check(native.stops == 1 && native.releases == 1 && !r.isRecording)
      r.disposeExplicit(); refused("ERR_AUDIO_CAPTURE_STALE") { r.startExplicit(1) }; check(native.starts == 1)
    }
  }
  test("stale start cannot capture") { val r = recorder(); r.prepareExplicit(2, 8.0, 1000); refused("ERR_AUDIO_CAPTURE_STALE") { r.startExplicit(1) }; check(r.recorder!!.starts == 0); r.disposeExplicit() }
  test("cancel before queued prepare prevents hidden capture and remains disposable") { val r = recorder(); r.cancelRequest(1); try { r.prepareExplicit(1, 8.0, 1000); error("accepted") } catch (error: CodedException) { check(error.code == "ERR_AUDIO_CAPTURE_CANCELLED") }; check(r.recorder == null); r.disposeExplicit(); check(r.disposed) }
  test("synchronous cancellation before queued start prevents real recorder start") { val r = recorder(); r.prepareExplicit(1, 8.0, 1000); val native = r.recorder!!; r.cancelRequest(1); refused("ERR_AUDIO_CAPTURE_STALE") { r.startExplicit(1) }; check(native.starts == 0 && !r.isRecording); r.disposeExplicit(); check(native.releases == 1) }
  test("real native start failure remains nonrecording") { val r = recorder(); r.prepareExplicit(1, 8.0, 1000); r.recorder!!.failStart = true; try { r.startExplicit(1); error("accepted") } catch (_: RuntimeException) {}; check(!r.isRecording); r.disposeExplicit() }
  test("finish finalizes and releases, repeated finish is idempotent") { val r = started(); val native = r.recorder!!; val status = r.finishExplicit(1); check(status["isFinished"] == true && status["hasError"] == false && native.stops == 1 && native.releases == 1); check(r.finishExplicit(1) === status && r.events == 1); r.disposeExplicit() }
  test("native stop failure cannot publish a source") { val r = started(); r.recorder!!.failStop = true; val status = r.finishExplicit(1); check(status["hasError"] == true && status["url"] == null && !r.isRecording); r.disposeExplicit() }
  test("oversized finalized source refuses") { val r = started(); File(r.filePath).writeBytes(ByteArray(2 * 1024 * 1024 + 1)); check(r.finishExplicit(1)["hasError"] == true); r.disposeExplicit() }
  test("background stops explicit capture and foreground does not resume") { val r = started(); val native = r.recorder!!; val module = AudioModule(); module.recorders[r.id] = r; module.background(); module.foreground(); check(native.starts == 1 && native.stops == 1 && !r.isRecording && r.explicitFinished?.get("interrupted") == true); r.disposeExplicit() }
  test("legacy background pause and foreground resume remain") { val r = started(); val native = r.recorder!!; r.preventAutomaticResume = false; val module = AudioModule(); module.recorders[r.id] = r; module.background(); check(r.isPaused); module.foreground(); check(native.starts == 2 && r.isRecording); r.preventAutomaticResume = true; r.disposeExplicit() }
  test("release failure retains exact owner for retry") { val r = started(); val native = r.recorder!!; native.failRelease = true; try { r.disposeExplicit(); error("accepted") } catch (_: RuntimeException) {}; check(r.disposalStarted && !r.disposed && r.recorder === native); native.failRelease = false; r.disposeExplicit(); check(r.disposed && r.recorder == null) }
  test("disposed recorder never starts again") { val r = started(); r.disposeExplicit(); refused("ERR_AUDIO_CAPTURE_STALE") { r.startExplicit(1) }; r.disposeExplicit() }
  println("native-recorder-branches passed=" + passed + " failed=0")
}
`;
}
async function main() {
  process.stdout.write(`Recorder native harness PID ${process.pid}\n`);
  const packageRoot = path.resolve(__dirname, '../node_modules/expo-audio');
  const recorder = guardedSource(packageRoot, 'android/src/main/java/expo/modules/audio/AudioRecorder.kt');
  const module = guardedSource(packageRoot, 'android/src/main/java/expo/modules/audio/AudioModule.kt');
  const cache = path.join(process.env.GRADLE_USER_HOME || path.join(os.homedir(), '.gradle'), 'caches/modules-2/files-2.1');
  const specifications = [['org.jetbrains.kotlin', 'kotlin-compiler-embeddable', '2.1.20'],
    ['org.jetbrains.kotlin', 'kotlin-stdlib', '2.1.20'], ['org.jetbrains.kotlin', 'kotlin-script-runtime', '2.1.20'],
    ['org.jetbrains.kotlin', 'kotlin-reflect', '1.6.10'], ['org.jetbrains.kotlin', 'kotlin-daemon-embeddable', '2.1.20'],
    ['org.jetbrains.intellij.deps', 'trove4j', '1.0.20200330'], ['org.jetbrains.kotlinx', 'kotlinx-coroutines-core-jvm', '1.8.0'],
    ['org.jetbrains', 'annotations', '13.0']];
  const jars = specifications.map(item => cachedJar(cache, ...item));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-native-recorder-'));
  try {
    const source = path.join(temp, 'RecorderLifecycle.kt'); const classes = path.join(temp, 'classes');
    fs.writeFileSync(source, harness(recorder, module));
    const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin/java') : 'java';
    await run(java, ['-Xms32m', '-Xmx256m', '-XX:ActiveProcessorCount=2', '-cp', jars.join(path.delimiter),
      'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-classpath', [jars[1], jars[7]].join(path.delimiter),
      '-nowarn', '-d', classes, source], 'compile guarded recorder methods', temp);
    process.stdout.write(await run(java, ['-Xms16m', '-Xmx96m', '-XX:ActiveProcessorCount=2', '-cp', [classes, jars[1]].join(path.delimiter),
      'RecorderLifecycleKt', temp], 'execute recorder native boundary tests', temp));
  } finally {
    const resolved = path.resolve(temp);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('pocket-native-recorder-')) throw new Error('Unsafe recorder fixture cleanup target');
    fs.rmSync(resolved, { recursive: true, force: true });
    if (fs.existsSync(resolved)) throw new Error('Recorder fixture cleanup failed');
  }
}
module.exports = { extract, harness };
if (require.main === module) main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
