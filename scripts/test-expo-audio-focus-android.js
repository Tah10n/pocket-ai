'use strict';

// Executes the installed, hash-guarded Android focus and Play bodies as Kotlin.
// Only Android/Expo/Media3 boundaries are substituted; this is deterministic
// native branch coverage, not a device audio-route or full-module instrumentation test.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { patches } = require('../patches/expo-audio-55.0.18');

function block(source, anchor) {
  const anchorAt = source.indexOf(anchor);
  if (anchorAt < 0) throw new Error(`Missing guarded native test anchor: ${anchor}`);
  const start = source.indexOf('{', anchorAt);
  let depth = 0;
  let quoted = false;
  let lineComment = false;
  for (let at = start; at < source.length; at += 1) {
    const char = source[at];
    if (lineComment) { if (char === '\n') lineComment = false; continue; }
    if (!quoted && char === '/' && source[at + 1] === '/') { lineComment = true; continue; }
    if (char === '"' && source[at - 1] !== '\\') quoted = !quoted;
    if (quoted) continue;
    if (char === '{') depth += 1;
    if (char === '}' && --depth === 0) return source.slice(start + 1, at);
  }
  throw new Error('Unclosed guarded native test anchor');
}

function method(source, name) {
  const match = source.match(new RegExp(`(?:private |override )?fun ${name}\\([^\\n]*?\\)(?:\\s*:[^{\\n]+)?\\s*\\{`));
  if (!match) return '';
  return match[0].slice(0, -1) + '{' + block(source, match[0]) + '}';
}

function guardedSource(root, relative) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8').replace(/\r\n/g, '\n');
  const patch = patches.find(item => item.file === relative);
  if (!patch || crypto.createHash('sha256').update(source).digest('hex') !== patch.after) {
    throw new Error(`Native harness refuses unverified source: ${relative}`);
  }
  return source;
}

function harnessSource(moduleSource, playerSource) {
  const explicit = moduleSource.includes('AsyncFunction("playAsync")');
  const playBody = block(moduleSource, explicit ? 'AsyncFunction("playAsync")' : 'Function("play")')
    .replace(/^[^\n]*->/, '').replaceAll('return@Function', 'return');
  const focusListener = block(moduleSource, 'private val audioFocusChangeListener');
  const focusMethods = ['shouldReleaseFocus', 'requestAudioFocus', 'releaseAudioFocus',
    'cancelExplicitAudioFocus', 'requestExplicitAudioFocus', 'handleAudioFocusChange'].map(name => method(moduleSource, name)).join('\n');
  return `
import java.util.concurrent.ConcurrentHashMap

// Android AudioManager is the substituted native boundary. Its returned result
// and queued callbacks are controlled; the module bodies below are unmodified.
class AudioManager(var result: Int) {
  fun interface OnAudioFocusChangeListener { fun onAudioFocusChange(change: Int) }
  var requestCount = 0
  var abandonCount = 0
  var lastListener: OnAudioFocusChangeListener? = null
  var lastRequest: AudioFocusRequest? = null
  val abandonedRequests = mutableListOf<AudioFocusRequest>()
  fun requestAudioFocus(request: AudioFocusRequest): Int {
    requestCount++; lastRequest = request; lastListener = request.listener; return result
  }
  fun requestAudioFocus(listener: OnAudioFocusChangeListener, stream: Int, type: Int): Int {
    requestCount++; lastListener = listener; return result
  }
  fun abandonAudioFocusRequest(request: AudioFocusRequest): Int { abandonedRequests.add(request); abandonCount++; return 1 }
  fun abandonAudioFocus(listener: OnAudioFocusChangeListener): Int { abandonCount++; return 1 }
  companion object {
    const val AUDIOFOCUS_REQUEST_FAILED = 0
    const val AUDIOFOCUS_REQUEST_GRANTED = 1
    const val AUDIOFOCUS_REQUEST_DELAYED = 2
    const val AUDIOFOCUS_LOSS = -1
    const val AUDIOFOCUS_LOSS_TRANSIENT = -2
    const val AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK = -3
    const val AUDIOFOCUS_GAIN = 1
    const val AUDIOFOCUS_GAIN_TRANSIENT = 2
    const val AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK = 3
    const val STREAM_MUSIC = 3
  }
}
class AudioAttributes {
  class Builder {
    fun setContentType(value: Int) = this
    fun build() = AudioAttributes()
  }
  companion object { const val CONTENT_TYPE_MUSIC = 2 }
}
class AudioFocusRequest(val listener: AudioManager.OnAudioFocusChangeListener?, val delayed: Boolean) {
  class Builder(value: Int) {
    private var listener: AudioManager.OnAudioFocusChangeListener? = null
    private var delayed = false
    fun setAudioAttributes(value: AudioAttributes) = this
    fun setAcceptsDelayedFocusGain(value: Boolean) = apply { delayed = value }
    fun setOnAudioFocusChangeListener(value: AudioManager.OnAudioFocusChangeListener) = apply { listener = value }
    fun build() = AudioFocusRequest(listener, delayed)
  }
}
object Build { object VERSION { var SDK_INT = 35 }; object VERSION_CODES { const val O = 26 } }
object Log { fun e(tag: String, message: String) = Unit }
class CodedException(val code: String, message: String, cause: Throwable?) : Exception(message, cause)
enum class InterruptionMode { MIX_WITH_OTHERS, DUCK_OTHERS, DO_NOT_MIX }
class MainQueue {
  private val callbacks = ArrayDeque<() -> Unit>()
  fun launch(callback: () -> Unit) { callbacks.addLast(callback) }
  fun drain() { while (callbacks.isNotEmpty()) callbacks.removeFirst().invoke() }
}
class AppContext { val mainQueue = MainQueue() }
const val PLAYBACK_STATUS_UPDATE = "playbackStatusUpdate"
object Player { const val STATE_READY = 3; const val STATE_BUFFERING = 2; const val STATE_ENDED = 4; const val STATE_IDLE = 1; const val REPEAT_MODE_ONE = 1 }
class Parameters { val speed = 1f }
open class Playable {
  open var isPaused = false
  open val isPlaying get() = false
  var previousVolume = 1f
  private var volumeValue = 1f
  val volume get() = volumeValue
  open fun pause() = Unit
  open fun play() = Unit
  fun setVolume(value: Float) { volumeValue = value }
}
class Ref {
  var playCalls = 0
  var isPlaying = false
  var volume = 1f
  var repeatMode = 0
  var playbackState = Player.STATE_READY
  val playbackParameters = Parameters()
  fun play() { playCalls++ }
  fun pause() { isPlaying = false }
}
class AudioPlayer(val id: String) : Playable() {
  var preventAutomaticResume = true
  var disposalStarted = false
  var playbackRequestId = 0
  var preservesPitch = true
  var intendedPlayingState = false
  private var playing = false
  private var previousPlaybackState = Player.STATE_IDLE
  var onPlaybackStateChange: ((Boolean) -> Unit)? = null
  val statuses = mutableListOf<Map<String, Any?>>()
  fun emit(event: String, body: Map<String, Any?>) { statuses.add(body) }
  var failDisposal = false
  val currentTime = 0f
  val duration = 1f
  val ref = Ref()
  override val isPlaying get() = ref.isPlaying
  ${method(playerSource, 'play') || 'override fun play() { ref.play() }'}
  ${method(playerSource, 'pause') || 'override fun pause() { ref.pause() }'}
  private var refDisposed = false
  fun dispose() { disposalStarted = true; preventAutomaticResume = true; isPaused = false; ref.pause(); if (failDisposal) throw Exception("fixture disposal rejection") }
  ${method(playerSource, 'currentStatus').replace('override ', '')}
  ${method(playerSource, 'playbackStateToString')}
  ${method(playerSource, 'sendPlayerUpdate')}
  ${method(playerSource, 'onIsPlayingChanged').replace('override ', '')}
  ${method(playerSource, 'onPlaybackStateChanged').replace('override ', '')}
}
class FocusModule(val audioManager: AudioManager) {
  private val TAG = "focus-fixture"
  val appContext = AppContext()
  val players = ConcurrentHashMap<String, AudioPlayer>()
  private val allPlayables: Sequence<Playable> get() = players.values.asSequence()
  var focusAcquired = false
  var audioEnabled = true
  var interruptionMode: InterruptionMode? = InterruptionMode.DO_NOT_MIX
  private var audioFocusRequest: AudioFocusRequest? = null
  private var explicitFocusRequest: AudioFocusRequest? = null
  private var explicitFocusListener: AudioManager.OnAudioFocusChangeListener? = null
  private var explicitFocusOwner: AudioPlayer? = null
  private var explicitFocusGeneration = 0
  private var explicitFocusAcquired = false
  private val audioFocusChangeListener = AudioManager.OnAudioFocusChangeListener {${focusListener}}
  private fun <T> runOnMain(callback: () -> T): T = callback()
  ${focusMethods}
  fun playAsync(player: AudioPlayer, requestId: Int) {${playBody}}
  fun play(player: AudioPlayer) {${block(moduleSource, 'Function("play")').replace(/^[^\n]*->/, '').replaceAll('return@Function', 'return')}}
  fun pause(player: AudioPlayer) {${block(moduleSource, 'Function("pause") { player: AudioPlayer').replace(/^[^\n]*->/, '')}}
  fun disposeAsync(player: AudioPlayer) {${block(moduleSource, 'AsyncFunction("disposeAsync")').replace(/^[^\n]*->/, '')}}
  fun background() { releaseAudioFocus(); players.values.forEach { it.pause() } }
}

var failed = 0
var passed = 0
fun test(name: String, body: () -> Unit) {
  try { body(); passed++; println("PASS " + name) }
  catch (error: Throwable) { failed++; println("FAIL " + name + ": " + error.message) }
}
fun fixture(result: Int): Triple<FocusModule, AudioManager, AudioPlayer> {
  val manager = AudioManager(result); val module = FocusModule(manager); val player = AudioPlayer("fixture-player")
  module.players[player.id] = player; return Triple(module, manager, player)
}
fun reject(module: FocusModule, player: AudioPlayer, expected: String) {
  val error = runCatching { module.playAsync(player, 11) }.exceptionOrNull()
  check(error is CodedException && error.code == expected) { "expected managed focus rejection" }
}
fun main() {
  test("initial FAILED rejects without playback") {
    val (module, manager, player) = fixture(AudioManager.AUDIOFOCUS_REQUEST_FAILED)
    reject(module, player, "ERR_TTS_AUDIO_FOCUS_FAILED")
    check(player.ref.playCalls == 0 && !player.isPlaying) { "rejected Play reached player" }
    check(manager.abandonCount == 1 && !module.focusAcquired) { "rejected focus was retained" }
  }
  test("initial DELAYED abandons while focusAcquired is false") {
    val (module, manager, player) = fixture(AudioManager.AUDIOFOCUS_REQUEST_DELAYED)
    reject(module, player, "ERR_TTS_AUDIO_FOCUS_DELAYED")
    check(manager.abandonCount == 1 && !module.focusAcquired && player.ref.playCalls == 0) { "delayed focus was retained or playback started" }
    check(manager.lastRequest?.delayed == false) { "explicit Play accepted uncontrolled delayed gain" }
    manager.lastListener!!.onAudioFocusChange(AudioManager.AUDIOFOCUS_GAIN); module.appContext.mainQueue.drain()
    check(!module.focusAcquired && player.ref.playCalls == 0) { "late rejected GAIN affected the module" }
  }
  test("GRANTED accepts command with loaded false-playing status") {
    val (module, _, player) = fixture(AudioManager.AUDIOFOCUS_REQUEST_GRANTED)
    module.playAsync(player, 17)
    check(player.ref.playCalls == 1 && !player.isPlaying) { "command admission fabricated playback" }
    val status = player.currentStatus()
    check(status["isLoaded"] == true && status["playing"] == false && status["playbackRequestId"] == 17) { "loaded/admitted/playing states lost correlation" }
    player.ref.isPlaying = true
    check(player.currentStatus()["playing"] == true && player.currentStatus()["playbackRequestId"] == 17) { "actual playback not correlated" }
  }
  test("queued late GAIN after Stop cannot start old or new owner") {
    val (module, manager, player) = fixture(AudioManager.AUDIOFOCUS_REQUEST_GRANTED)
    module.playAsync(player, 20); val oldListener = manager.lastListener!!
    oldListener.onAudioFocusChange(AudioManager.AUDIOFOCUS_GAIN)
    module.pause(player)
    val next = AudioPlayer("next-owner"); next.preventAutomaticResume = false; next.isPaused = true; module.players[next.id] = next
    module.appContext.mainQueue.drain()
    check(manager.abandonCount == 1 && !module.focusAcquired && player.ref.playCalls == 1 && next.ref.playCalls == 0) { "cancelled GAIN changed a later owner" }
  }
  test("dispose cancels focus even when teardown rejects") {
    val (module, manager, player) = fixture(AudioManager.AUDIOFOCUS_REQUEST_GRANTED)
    module.playAsync(player, 30); val oldListener = manager.lastListener!!; player.failDisposal = true
    check(runCatching { module.disposeAsync(player) }.isFailure) { "fixture did not reject teardown" }
    oldListener.onAudioFocusChange(AudioManager.AUDIOFOCUS_GAIN); module.appContext.mainQueue.drain()
    check(manager.abandonCount == 1 && !module.focusAcquired && player.ref.playCalls == 1 && module.players[player.id] === player) { "failed dispose retained focus or removed ownership" }
  }
  test("background cancellation ignores late GAIN") {
    val (module, manager, player) = fixture(AudioManager.AUDIOFOCUS_REQUEST_GRANTED)
    module.playAsync(player, 31); val listener = manager.lastListener!!
    module.background(); listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_GAIN); module.appContext.mainQueue.drain()
    check(!module.focusAcquired && player.ref.playCalls == 1 && manager.abandonCount == 1) { "background resumed cancelled playback" }
  }
  test("focus loss after playing pauses and never auto-resumes") {
    val (module, manager, player) = fixture(AudioManager.AUDIOFOCUS_REQUEST_GRANTED)
    module.playAsync(player, 32); player.ref.isPlaying = true
    manager.lastListener!!.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT); module.appContext.mainQueue.drain()
    check(!player.isPlaying && !player.isPaused) { "focus loss retained resume intent" }
    manager.lastListener!!.onAudioFocusChange(AudioManager.AUDIOFOCUS_GAIN); module.appContext.mainQueue.drain()
    check(player.ref.playCalls == 1 && !player.isPlaying) { "focus gain automatically resumed explicit player" }
  }
  test("explicit retry uses same player and replaces rejected focus token") {
    val (module, manager, player) = fixture(AudioManager.AUDIOFOCUS_REQUEST_DELAYED)
    reject(module, player, "ERR_TTS_AUDIO_FOCUS_DELAYED"); val oldListener = manager.lastListener!!
    manager.result = AudioManager.AUDIOFOCUS_REQUEST_GRANTED; module.playAsync(player, 40)
    oldListener.onAudioFocusChange(AudioManager.AUDIOFOCUS_GAIN); module.appContext.mainQueue.drain()
    check(manager.requestCount == 2 && manager.abandonCount == 1 && player.ref.playCalls == 1 && player.currentStatus()["playbackRequestId"] == 40) { "retry reused cancelled focus token" }
  }
  test("pre-O DELAYED request also abandons listener") {
    Build.VERSION.SDK_INT = 25
    try {
      val (module, manager, player) = fixture(AudioManager.AUDIOFOCUS_REQUEST_DELAYED)
      reject(module, player, "ERR_TTS_AUDIO_FOCUS_DELAYED")
      check(manager.abandonCount == 1 && player.ref.playCalls == 0) { "legacy API retained delayed focus" }
    } finally { Build.VERSION.SDK_INT = 35 }
  }
  test("old queued playing transition cannot confirm a new request") {
    val (_, _, player) = fixture(AudioManager.AUDIOFOCUS_REQUEST_GRANTED)
    player.playbackRequestId = 42
    player.onIsPlayingChanged(true)
    check(player.statuses.isEmpty()) { "stale true transition was attributed to new request" }
    player.ref.isPlaying = true; player.onIsPlayingChanged(true)
    val confirmed = player.statuses.last()
    check(confirmed["playing"] == true && confirmed["playbackRequestId"] == 42) { "matching real start was dropped" }
    player.playbackRequestId = 43; player.ref.isPlaying = false; player.onIsPlayingChanged(false)
    check(confirmed["playbackRequestId"] == 42) { "serialized status identity mutated after emission" }
    player.ref.playbackState = Player.STATE_READY; player.onPlaybackStateChanged(Player.STATE_ENDED)
    check(player.statuses.last()["didJustFinish"] != true) { "stale ended transition affected new request" }
  }
  test("legacy play retains focus failure and delayed behavior without opt-in") {
    val (module, manager, player) = fixture(AudioManager.AUDIOFOCUS_REQUEST_FAILED)
    player.preventAutomaticResume = false; module.play(player)
    check(player.ref.playCalls == 1 && manager.abandonCount == 0 && manager.lastRequest?.delayed == true) { "default player admission changed" }
    check(player.currentStatus()["playbackRequestId"] == null) { "default player received explicit identity" }
  }
  test("explicit disposal preserves a concurrently playing default player's focus") {
    val (module, manager, tts) = fixture(AudioManager.AUDIOFOCUS_REQUEST_GRANTED)
    module.playAsync(tts, 60); val explicitRequest = manager.lastRequest!!; val explicitListener = manager.lastListener!!
    val normal = AudioPlayer("default-player"); normal.preventAutomaticResume = false; module.players[normal.id] = normal
    module.play(normal); normal.ref.isPlaying = true
    val defaultRequest = manager.lastRequest!!
    check(manager.requestCount == 2 && defaultRequest !== explicitRequest && module.focusAcquired) { "default player borrowed explicit player's cancellable focus" }
    explicitListener.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT); module.appContext.mainQueue.drain()
    check(normal.isPlaying && module.focusAcquired) { "explicit focus callback changed default player's playback or focus" }
    module.disposeAsync(tts)
    explicitListener.onAudioFocusChange(AudioManager.AUDIOFOCUS_GAIN); module.appContext.mainQueue.drain()
    check(manager.abandonedRequests == listOf(explicitRequest) && module.focusAcquired && normal.isPlaying && normal.ref.playCalls == 1) { "disposing explicit player abandoned default player's focus" }
  }
  test("explicit disposal preserves borrowed active default focus") {
    val (module, manager, tts) = fixture(AudioManager.AUDIOFOCUS_REQUEST_GRANTED)
    val normal = AudioPlayer("default-first"); normal.preventAutomaticResume = false; module.players[normal.id] = normal
    module.play(normal); normal.ref.isPlaying = true; module.playAsync(tts, 61)
    check(manager.requestCount == 1) { "existing default focus was replaced" }
    module.disposeAsync(tts)
    check(manager.abandonCount == 0 && module.focusAcquired && normal.isPlaying) { "borrowed default focus was abandoned" }
  }
  test("explicit Stop cancels its own focus beside an active default player") {
    val (module, manager, tts) = fixture(AudioManager.AUDIOFOCUS_REQUEST_GRANTED)
    module.playAsync(tts, 62); val request = manager.lastRequest!!; val listener = manager.lastListener!!
    val normal = AudioPlayer("default-during-stop"); normal.preventAutomaticResume = false; module.players[normal.id] = normal
    module.play(normal); normal.ref.isPlaying = true
    module.pause(tts); listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_GAIN); module.appContext.mainQueue.drain()
    check(manager.abandonedRequests == listOf(request) && module.focusAcquired && normal.isPlaying && tts.ref.playCalls == 1) { "Stop retained explicit focus or affected default playback" }
  }
  println("native-focus-branches passed=" + passed + " failed=" + failed)
  if (failed > 0) kotlin.system.exitProcess(1)
}
`;
}

function cachedJar(cache, group, artifact, version) {
  const root = path.join(cache, group, artifact, version);
  if (!fs.existsSync(root)) throw new Error(`Missing cached native harness dependency: ${artifact} ${version}`);
  for (const directory of fs.readdirSync(root)) {
    const jar = path.join(root, directory, `${artifact}-${version}.jar`);
    if (fs.existsSync(jar)) return jar;
  }
  throw new Error(`Missing cached native harness jar: ${artifact} ${version}`);
}

async function run(executable, args, purpose, temp) {
  const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  process.stdout.write(`native harness PID=${child.pid} purpose=${purpose}\n`);
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output += data.toString(); });
  const deadline = setTimeout(() => child.kill(), 60000);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => resolve(code));
    });
    const safeOutput = output.split(temp).join('<fixture>').split(path.resolve(__dirname, '..')).join('<app>');
    if (result !== 0) throw new Error(`${purpose} failed (${result})\n${safeOutput}`);
    return safeOutput;
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise(resolve => child.once('exit', resolve));
    }
    process.stdout.write(`native harness PID=${child.pid} exited=true\n`);
  }
}

async function main() {
  const packageRoot = path.resolve(__dirname, '../node_modules/expo-audio');
  const moduleSource = guardedSource(packageRoot, 'android/src/main/java/expo/modules/audio/AudioModule.kt');
  const playerSource = guardedSource(packageRoot, 'android/src/main/java/expo/modules/audio/AudioPlayer.kt');
  const cache = path.join(process.env.GRADLE_USER_HOME || path.join(os.homedir(), '.gradle'), 'caches/modules-2/files-2.1');
  const specifications = [
    ['org.jetbrains.kotlin', 'kotlin-compiler-embeddable', '2.1.20'],
    ['org.jetbrains.kotlin', 'kotlin-stdlib', '2.1.20'],
    ['org.jetbrains.kotlin', 'kotlin-script-runtime', '2.1.20'],
    ['org.jetbrains.kotlin', 'kotlin-reflect', '1.6.10'],
    ['org.jetbrains.kotlin', 'kotlin-daemon-embeddable', '2.1.20'],
    ['org.jetbrains.intellij.deps', 'trove4j', '1.0.20200330'],
    ['org.jetbrains.kotlinx', 'kotlinx-coroutines-core-jvm', '1.8.0'],
    ['org.jetbrains', 'annotations', '13.0'],
  ];
  const jars = specifications.map(item => cachedJar(cache, ...item));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-native-focus-'));
  try {
    const source = path.join(temp, 'FocusAdmission.kt');
    const classes = path.join(temp, 'classes');
    fs.writeFileSync(source, harnessSource(moduleSource, playerSource));
    await run(process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin/java') : 'java', [
      '-Xms32m', '-Xmx256m', '-XX:ActiveProcessorCount=2', '-cp', jars.join(path.delimiter), 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect',
      '-classpath', [jars[1], jars[7]].join(path.delimiter), '-nowarn', '-d', classes, source,
    ], 'compile actual Android focus branches', temp);
    const result = await run(process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin/java') : 'java', [
      '-Xms16m', '-Xmx96m', '-XX:ActiveProcessorCount=2', '-cp', [classes, jars[1]].join(path.delimiter), 'FocusAdmissionKt',
    ], 'execute deterministic AudioManager boundary tests', temp);
    process.stdout.write(result);
  } finally {
    const resolved = path.resolve(temp);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('pocket-native-focus-')) {
      throw new Error('Unsafe native fixture cleanup target');
    }
    fs.rmSync(resolved, { recursive: true, force: true });
    if (fs.existsSync(resolved)) throw new Error('Native fixture cleanup failed');
  }
}
module.exports = { block, method, harnessSource, guardedSource, cachedJar, run };
if (require.main === module) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
