'use strict';

// expo-audio 55.0.18 has fire-and-forget Android SharedObject destruction and
// automatically resumes interrupted players. Local speech needs confirmed
// disposal before deleting its private clip, and explicit-only resume.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const VERSION = '55.0.18';
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const normalize = text => text.replace(/\r\n/g, '\n');
function replace(text, before, after, count = 1) {
  const found = text.split(before).length - 1;
  if (found !== count) throw new Error(`expo-audio patch anchor mismatch: expected ${count}, found ${found}`);
  return text.split(before).join(after);
}
const patches = [
  {
    file: 'src/AudioModule.types.ts',
    before: '644be0e74595444fa20b8fcf925d8c26666dca152332c55b364e7af3affe03c7', after: '4c6bee96e983d5663e11f85e753442915a4425fae8bcc6dba5f43251a12ee91f',
    transform: text => replace(text, 'export declare class AudioPlayer extends SharedObject<AudioEvents> {',
      `export declare class AudioPlayer extends SharedObject<AudioEvents> {
  /** Opt-in native guard: interruptions, route changes and foreground never resume this player. Default false. */
  preventAutomaticResume: boolean;
  /** Resolves on native MAIN only after player teardown and registry removal. Call release() afterwards. */
  disposeAsync(): Promise<void>;`),
  },
  {
    file: 'build/AudioModule.types.d.ts',
    before: '2b422fb59dc81507caa207253b5e4642467e24b4b1519f8c80d76b4d68941e8b', after: 'b4e3da66b89bae304782d171ca381850093bd39c5c1882f6bf7b7305e4a9a357',
    transform: text => replace(text, 'export declare class AudioPlayer extends SharedObject<AudioEvents> {',
      `export declare class AudioPlayer extends SharedObject<AudioEvents> {
    /** Opt-in native explicit-only resume guard. Default false. */
    preventAutomaticResume: boolean;
    /** Confirm native disposal before releasing the SharedObject or deleting its source. */
    disposeAsync(): Promise<void>;`),
  },
  {
    file: 'android/src/main/java/expo/modules/audio/AudioModule.kt',
    before: 'af1931ea94b70acdbe49226c89719f01b1c57eaa3fbad4aaf622c393c788eb77', after: '489446e76b0fb1d3aea34e2db76e1dd0ce918157cde3b52cbad2b2d798a0f129',
    transform(text) {
      text = replace(text, 'playable.isPaused = true',
        'playable.isPaused = playable !is AudioPlayer || !playable.preventAutomaticResume', 3);
      text = replace(text, `          allPlayables.forEach { playable ->
            playable.setVolume(playable.previousVolume)`, `          allPlayables.forEach { playable ->
            if (playable is AudioPlayer && (playable.preventAutomaticResume || playable.disposalStarted)) return@forEach
            playable.setVolume(playable.previousVolume)`);
      text = replace(text, 'if (allPlayables.any { it.isPaused }) {',
        'if (allPlayables.any { it.isPaused && (it !is AudioPlayer || !it.preventAutomaticResume) }) {');
      text = replace(text, `          if (playable.isPaused) {
            playable.isPaused = false
            playable.play()`, `          if (playable.isPaused && (playable !is AudioPlayer || (!playable.preventAutomaticResume && !playable.disposalStarted))) {
            playable.isPaused = false
            playable.play()`);
      text = replace(text, `      Property("id") { player ->
        player.id
      }`, `      Property("id") { player ->
        player.id
      }

      Property("preventAutomaticResume") { player -> player.preventAutomaticResume }
        .set { player, value: Boolean ->
          runOnMain {
            player.preventAutomaticResume = value || player.disposalStarted
            if (player.preventAutomaticResume) player.isPaused = false
            if (!player.disposalStarted) player.ref.setHandleAudioBecomingNoisy(value)
          }
        }`);
      text = replace(text, `          player.ref.play()
        }
      }

      Function("pause") { player: AudioPlayer ->`, `          if (!player.disposalStarted && (!player.preventAutomaticResume || focusAcquired)) player.play()
        }
      }

      Function("pause") { player: AudioPlayer ->`);
      text = replace(text, `      Function("pause") { player: AudioPlayer ->
        runOnMain {
          player.ref.pause()`, `      Function("pause") { player: AudioPlayer ->
        runOnMain {
          if (player.preventAutomaticResume) player.isPaused = false
          player.pause()`);
      text = replace(text, `          if (player.ref.availableCommands.contains(Player.COMMAND_CHANGE_MEDIA_ITEMS)) {`,
        `          if (!player.disposalStarted && player.ref.availableCommands.contains(Player.COMMAND_CHANGE_MEDIA_ITEMS)) {`);
      text = replace(text, '              if (wasPlaying) {', '              if (wasPlaying && !player.preventAutomaticResume) {');
      text = replace(text, `      Function("remove") { player: AudioPlayer ->
        players.remove(player.id)
      }`, `      AsyncFunction("disposeAsync") { player: AudioPlayer ->
        player.dispose()
        players.remove(player.id)
        if (shouldReleaseFocus()) releaseAudioFocus()
      }.runOnQueue(Queues.MAIN)

      Function("remove") { player: AudioPlayer ->
        players.remove(player.id)
      }`);
      return text;
    },
  },
  {
    file: 'android/src/main/java/expo/modules/audio/AudioPlayer.kt',
    before: '6d00761ea79d6a31f7a3514251befb6aab011a69075c6799094db749ca2da90c', after: '277e34f79c7b8305d28e7a033ad93d4490d82e03402a957f1b6a070a866a7344',
    transform(text) {
      text = replace(text, 'import androidx.media3.common.PlaybackParameters',
        'import androidx.media3.common.PlaybackParameters\nimport androidx.media3.common.PlaybackException');
      text = replace(text, '  var preservesPitch = true', `  var preservesPitch = true
  var preventAutomaticResume = false
  var disposalStarted = false
    private set
  private var disposed = false
  private var mediaSessionDisposed = false
  private var visualizerDisposed = false
  private var refDisposed = false`);
      text = replace(text, '  fun setMediaSource(source: MediaSource) {', `  override fun play() {
    if (!disposalStarted) ref.play()
  }

  override fun pause() {
    if (!refDisposed) ref.pause()
  }

  override fun seekTo(seconds: Double) {
    if (!disposalStarted) ref.seekTo((seconds * 1000L).toLong())
  }

  fun setMediaSource(source: MediaSource) {
    if (disposalStarted) return`);
      text = replace(text, `      override fun onIsPlayingChanged(isPlaying: Boolean) {
        playing = isPlaying`, `      override fun onIsPlayingChanged(isPlaying: Boolean) {
        if (disposalStarted) return
        playing = isPlaying`);
      text = replace(text, `  private fun sendPlayerUpdate(map: Map<String, Any?>? = null) {
    val data = currentStatus()`, `  private fun sendPlayerUpdate(map: Map<String, Any?>? = null) {
    if (disposalStarted) return
    val data = currentStatus()`);
      text = replace(text, `      override fun onIsLoadingChanged(isLoading: Boolean) {`, `      override fun onPlayerError(error: PlaybackException) {
        if (preventAutomaticResume && !disposalStarted) {
          ref.pause()
          sendPlayerUpdate(mapOf("playbackState" to "failed", "playing" to false))
        }
      }

      override fun onIsLoadingChanged(isLoading: Boolean) {`);
      text = replace(text, `  @OptIn(DelicateCoroutinesApi::class)
  override fun sharedObjectDidRelease() {
    super.sharedObjectDidRelease()

    serviceConnection.release()

    // Run on global scope (not appContext.mainQueue) so that reloading doesn't cancel the release process
    // https://github.com/expo/expo/blob/cdf592a7fea56fc01b0149e9b2e5dbd294bcdc4c/packages/expo-modules-core/android/src/main/java/expo/modules/kotlin/AppContext.kt#L277-L279
    GlobalScope.launch(Dispatchers.Main) {
      mediaSession.release()
      if (isActiveForLockScreen) {
        serviceConnection.playbackServiceBinder?.service?.unregisterPlayer()
      }
      serviceConnection.unbind()
      playerListener?.let { ref.removeListener(it) }
      playerScope.cancel()
      visualizer?.release()
      ref.release()
    }
  }`, `  // Called by disposeAsync on MAIN. A failed stage remains retryable and cannot resume.
  fun dispose() {
    if (disposed) return
    disposalStarted = true
    preventAutomaticResume = true
    isPaused = false
    intendedPlayingState = false
    if (!refDisposed) ref.pause()
    serviceConnection.release()
    if (isActiveForLockScreen) {
      serviceConnection.playbackServiceBinder?.service?.unregisterPlayer()
      isActiveForLockScreen = false
    }
    serviceConnection.unbind()
    if (!refDisposed) playerListener?.let { ref.removeListener(it) }
    playerListener = null
    playerScope.cancel()
    onPlaybackStateChange = null
    if (!visualizerDisposed) {
      visualizer?.release()
      visualizer = null
      visualizerDisposed = true
    }
    if (!mediaSessionDisposed) {
      mediaSession.release()
      mediaSessionDisposed = true
    }
    if (!refDisposed) {
      ref.release()
      refDisposed = true
    }
    disposed = true
  }

  @OptIn(DelicateCoroutinesApi::class)
  override fun sharedObjectDidRelease() {
    super.sharedObjectDidRelease()
    // Legacy callers still get asynchronous teardown; explicit disposeAsync callers
    // have already completed it before releasing the SharedObject.
    if (!disposed) GlobalScope.launch(Dispatchers.Main) { dispose() }
  }`);
      return text;
    },
  },
  {
    file: 'ios/AudioComponentRegistry.swift',
    before: '9aa6eedee12b382a5566698d8cbe0c6f70b9c2f0008708dc8da7d51f97d3e101', after: '03069ca20eed0e948e2fed2009c0f598781d8099535bd21b8bb39519f60d18a6',
    transform: text => replace(text, `  func remove(_ player: AudioPlayer) {`, `  // Used by confirmed native disposal; all prior registry writes have completed.
  func removeSynchronously(_ player: AudioPlayer) {
    registryQueue.sync(flags: .barrier) {
      _ = self.players.removeValue(forKey: player.id)
    }
  }

  func remove(_ player: AudioPlayer) {`),
  },
  {
    file: 'ios/AudioModule.swift',
    before: '9e1f9aa00da09e4912d7072aa129582c3b559609b1d812a2871da673b0dd2875', after: '8e396c92ea6d12d635c5825d0a5fbb3bf366b85023d2daeefc0322103a1714b6',
    transform(text) {
      text = replace(text, `      Property("id") { player in
        player.id
      }`, `      Property("id") { player in
        player.id
      }

      Property("preventAutomaticResume") { player in player.preventAutomaticResume }
        .set { (player, value: Bool) in
          player.preventAutomaticResume = value || player.disposalStarted
          if player.preventAutomaticResume { player.wasPlaying = false }
        }`);
      text = replace(text, `      Function("play") { player in
        try activateSession()`, `      Function("play") { player in
        guard !player.disposalStarted else { return }
        try activateSession()`);
      text = replace(text, `      Function("pause") { player in
        player.ref.pause()`, `      Function("pause") { player in
        if player.preventAutomaticResume { player.wasPlaying = false }
        player.ref.pause()`);
      text = replace(text, `      Function("remove") { player in
        self.registry.remove(player)
      }`, `      AsyncFunction("disposeAsync") { (player: AudioPlayer) in
        player.dispose()
        self.interruptedPlayers.remove(player.id)
        self.playerVolumes.removeValue(forKey: player.id)
        if !player.keepAudioSessionActive { self.deactivateSession() }
      }.runOnQueue(.main)

      Function("remove") { player in
        self.registry.remove(player)
      }`);
      text = replace(text, `    registry.allPlayers.values.forEach { player in
      if player.isPlaying {
        interruptedPlayers.insert(player.id)`, `    registry.allPlayers.values.forEach { player in
      if player.preventAutomaticResume || player.disposalStarted {
        player.wasPlaying = false
        player.ref.pause()
        player.updateStatus(with: ["playing": false])
        return
      }
      if player.isPlaying {
        interruptedPlayers.insert(player.id)`);
      text = replace(text, '      if interruptedPlayers.contains(player.id) {',
        '      if !player.preventAutomaticResume && !player.disposalStarted && interruptedPlayers.contains(player.id) {');
      text = replace(text, `        player.wasPlaying = true
        player.ref.pause()`, `        player.wasPlaying = !player.preventAutomaticResume && !player.disposalStarted
        player.ref.pause()
        if player.preventAutomaticResume { player.updateStatus(with: ["playing": false]) }`);
      text = replace(text, '      if player.wasPlaying {', '      if player.wasPlaying && !player.preventAutomaticResume && !player.disposalStarted {');
      return text;
    },
  },
  {
    file: 'ios/AudioPlayer.swift',
    before: '93d88f9397ab31b4bf16ee3ebe758fa50c28797ccbb9b88921004666e49fedd6', after: 'c40a9cafa007c2f31e46878cdacc7492a3901ec98f7538c9591573d94e714d12',
    transform(text) {
      text = replace(text, '  var wasPlaying = false', `  var wasPlaying = false
  var preventAutomaticResume = false
  private(set) var disposalStarted = false
  private var disposed = false`);
      text = replace(text, '  func play(at rate: Float) {', '  func play(at rate: Float) {\n    guard !disposalStarted else { return }');
      text = replace(text, '  func updateStatus(with dict: [String: Any]) {',
        '  func updateStatus(with dict: [String: Any]) {\n    guard !disposalStarted else { return }');
      text = replace(text, '  func seekTo(seconds: Double, toleranceMillisBefore: Double? = nil, toleranceMillisAfter: Double? = nil) async {',
        '  func seekTo(seconds: Double, toleranceMillisBefore: Double? = nil, toleranceMillisAfter: Double? = nil) async {\n    guard !disposalStarted else { return }');
      text = replace(text, 'guard let self, let status else {', 'guard let self, !self.disposalStarted, let status else {');
      text = replace(text, '        if status == .readyToPlay {', `        if status == .failed && self.preventAutomaticResume {
          self.ref.pause()
          self.updateStatus(with: ["playbackState": "failed", "playing": false])
          return
        }
        if status == .readyToPlay {`);
      text = replace(text, '        guard let self else {', '        guard let self, !self.disposalStarted else {', 1);
      text = replace(text, '  func replaceWithPreloadedItem(_ item: AVPlayerItem?) {',
        '  func replaceWithPreloadedItem(_ item: AVPlayerItem?) {\n    guard !disposalStarted else { return }');
      text = replace(text, '  func replaceCurrentSource(source: AudioSource) {',
        '  func replaceCurrentSource(source: AudioSource) {\n    guard !disposalStarted else { return }');
      text = replace(text, '    if wasPlaying {', '    if wasPlaying && !preventAutomaticResume {', 2);
      text = replace(text, '        self?.ref.play()', `        guard let self, !self.disposalStarted, !self.preventAutomaticResume else { return }
        self.ref.play()`);
      text = replace(text, '  func handleMediaServicesReset() {', `  func handleMediaServicesReset() {
    guard !disposalStarted else { return }
    if preventAutomaticResume {
      wasPlaying = false
      ref.pause()
      updateStatus(with: ["mediaServicesDidReset": true])
      return
    }`);
      text = replace(text, '      guard let self else { return }', '      guard let self, !self.disposalStarted else { return }');
      text = replace(text, '      .sink { _ in completion() }', `      .sink { [weak self] _ in
        guard let self, !self.disposalStarted else { return }
        completion()
      }`);
      text = replace(text, '      guard let self, shouldResume else { return }',
        '      guard let self, !self.disposalStarted, !self.preventAutomaticResume, shouldResume else { return }');
      text = replace(text, '      guard let self else {', '      guard let self, !self.disposalStarted else {', 2);
      text = replace(text, '      if self.isLooping {', '      if self.isLooping && !self.preventAutomaticResume {');
      text = replace(text, `  public override func sharedObjectWillRelease() {
    ref.currentItem?.cancelPendingSeeks()
    owningRegistry?.remove(self)

    if isActiveForLockScreen {
      MediaController.shared.setActivePlayer(nil)
    }

    teardownPlayer()

    audioProcessor?.invalidate()
    audioProcessor = nil
  }`, `  // Executed on MAIN by disposeAsync before the JS SharedObject is released.
  func dispose() {
    guard !disposed else { return }
    disposalStarted = true
    preventAutomaticResume = true
    wasPlaying = false
    ref.currentItem?.cancelPendingSeeks()
    ref.cancelPendingPrerolls()
    if isActiveForLockScreen {
      MediaController.shared.setActivePlayer(nil)
      isActiveForLockScreen = false
    }
    teardownPlayer()
    audioProcessor?.invalidate()
    audioProcessor = nil
    ref.replaceCurrentItem(with: nil)
    onPlaybackComplete = nil
    owningRegistry?.removeSynchronously(self)
    owningRegistry = nil
    disposed = true
  }

  public override func sharedObjectWillRelease() {
    if Thread.isMainThread {
      dispose()
    } else {
      DispatchQueue.main.async { self.dispose() }
    }
  }`);
      return text;
    },
  },
];

function prepare(packageRoot) {
  const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  if (metadata.version !== VERSION) throw new Error(`expo-audio patch requires ${VERSION}; refusing changed version`);
  // Validate the entire package before any mutation. A partially applied known
  // patch is recoverable; unknown bytes in any file fail closed without writes.
  return patches.map(patch => {
    const target = path.join(packageRoot, patch.file);
    const original = normalize(fs.readFileSync(target, 'utf8'));
    const originalHash = hash(original);
    if (originalHash === patch.after) return { target, text: original, changed: false, file: patch.file };
    if (originalHash !== patch.before) throw new Error(`expo-audio patch source hash mismatch: ${patch.file}`);
    const updated = patch.transform(original);
    if (hash(updated) !== patch.after) throw new Error(`expo-audio patch result hash mismatch: ${patch.file}`);
    return { target, text: updated, changed: true, file: patch.file };
  });
}
function applyExpoAudioTtsPatch(packageRoot = path.join(__dirname, '..', 'node_modules', 'expo-audio')) {
  const plan = prepare(packageRoot);
  for (const item of plan) if (item.changed) fs.writeFileSync(item.target, item.text);
  return plan.filter(item => item.changed).map(item => item.file);
}

module.exports = { applyExpoAudioTtsPatch, patches, VERSION };
if (require.main === module) {
  if (process.argv.includes('--hashes')) {
    const packageRoot = path.join(__dirname, '..', 'node_modules', 'expo-audio');
    for (const patch of patches) {
      const original = normalize(fs.readFileSync(path.join(packageRoot, patch.file), 'utf8'));
      if (hash(original) !== patch.before) throw new Error(`Unexpected source: ${patch.file}`);
      process.stdout.write(`${patch.file} ${hash(patch.transform(original))}\n`);
    }
  } else {
    const changed = applyExpoAudioTtsPatch();
    process.stdout.write(`expo-audio ${VERSION} explicit speech playback guard: ${changed.length ? 'applied' : 'verified'}\n`);
  }
}
