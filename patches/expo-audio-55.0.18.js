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

// Upgrade only known prior patched bytes; fresh installations still transform
// the pinned upstream hashes above. Admission is opt-in and separate from play().
const admissionUpgrades = [
  ...['src/AudioModule.types.ts', 'build/AudioModule.types.d.ts'].map(file => ({
    file, after: {
      'src/AudioModule.types.ts': '48c7b5c7b3ce29186944f072996e8b1835e3c1810f8184bb6a47eca20ff720cc',
      'build/AudioModule.types.d.ts': '550f1e0d735cb03978b1f211e1da3161691e679b36e8337eeedf431fddee8950',
    }[file],
    transform: text => replace(text, '  disposeAsync(): Promise<void>;',
      '  disposeAsync(): Promise<void>;\n  /** Opt-in command admission on native MAIN. Playback requires a matching playing status. */\n  playAsync(requestId: number): Promise<void>;'),
  })),
  ...['src/Audio.types.ts', 'build/Audio.types.d.ts'].map(file => ({
    file, before: {
      'src/Audio.types.ts': 'fea7cf9120fd50db808e8b8428027deff211d39a904ac222b682142a3951d0af',
      'build/Audio.types.d.ts': 'cd5da0a2c30e2420e147d370ee34318e8f1611aa5e3728018a5e255c8369e4d1',
    }[file], after: {
      'src/Audio.types.ts': '81f98785bb4e80cd87c9c60067e3528d1c09e6b7a7f8b74fa21de33393a1dbfc',
      'build/Audio.types.d.ts': '36fb0bc74a5aab78ce8a7cb644b755115ab448e187ddecd1d04697a45c4c7c3e',
    }[file],
    transform: text => replace(text, 'export type AudioStatus = {',
      'export type AudioStatus = {\n  /** Native request identity captured when an explicit-only player serializes this status. */\n  playbackRequestId?: number;'),
  })),
  {
    file: 'android/src/main/java/expo/modules/audio/AudioModule.kt', after: '8486424bfa8f6289f0421081a063bdf833f08b241e4a5e31630e6720033f2f4b',
    transform(text) {
      text = replace(text, 'import expo.modules.kotlin.exception.Exceptions',
        'import expo.modules.kotlin.exception.Exceptions\nimport expo.modules.kotlin.exception.CodedException');
      text = replace(text, '  private var audioFocusRequest: AudioFocusRequest? = null', `  private var audioFocusRequest: AudioFocusRequest? = null
  // Explicit players own their request even before focus is acquired. Never let
  // a cancelled listener affect global focus or a later player/request.
  private var explicitFocusRequest: AudioFocusRequest? = null
  private var explicitFocusListener: AudioManager.OnAudioFocusChangeListener? = null
  private var explicitFocusOwner: AudioPlayer? = null
  private var explicitFocusGeneration = 0
  private var explicitFocusAcquired = false`);
      text = replace(text, `    appContext.mainQueue.launch {
      when (focusChange) {`, `    appContext.mainQueue.launch { handleAudioFocusChange(focusChange) }
  }

  private fun handleAudioFocusChange(focusChange: Int) {
      when (focusChange) {`);
      text = replace(text, `      }
    }
  }

  private fun shouldReleaseFocus()`, `      }
  }

  private fun cancelExplicitAudioFocus(player: AudioPlayer? = null) {
    val owner = explicitFocusOwner ?: return
    if (player != null && owner !== player) return
    // Invalidate before abandon: Android may already have queued a GAIN.
    explicitFocusGeneration += 1
    // Explicit acquisition never changes the legacy global focus flag.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      explicitFocusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
    } else {
      @Suppress("DEPRECATION")
      explicitFocusListener?.let { audioManager.abandonAudioFocus(it) }
    }
    // If abandon throws, retain ownership for a confirmed retry, with the old
    // listener invalidated so it still cannot play or change a later owner.
    explicitFocusRequest = null
    explicitFocusListener = null
    explicitFocusOwner = null
    explicitFocusAcquired = false
  }

  private fun requestExplicitAudioFocus(player: AudioPlayer): Int {
    if (explicitFocusOwner === player && explicitFocusAcquired) return AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    cancelExplicitAudioFocus()
    // Existing legacy focus can be borrowed; this player never owns or abandons it.
    if (focusAcquired) return AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    explicitFocusOwner = player
    val generation = ++explicitFocusGeneration
    val listener = AudioManager.OnAudioFocusChangeListener { focusChange ->
      appContext.mainQueue.launch {
        if (generation != explicitFocusGeneration || explicitFocusOwner !== player || player.disposalStarted) return@launch
        handleAudioFocusChange(focusChange, player)
      }
    }
    explicitFocusListener = listener
    val requestType = if (interruptionMode == InterruptionMode.DUCK_OTHERS) {
      AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK
    } else {
      AudioManager.AUDIOFOCUS_GAIN_TRANSIENT
    }
    val result = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val request = AudioFocusRequest.Builder(requestType).run {
        setAudioAttributes(AudioAttributes.Builder().setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
        setAcceptsDelayedFocusGain(false)
        setOnAudioFocusChangeListener(listener)
        build()
      }
      explicitFocusRequest = request
      audioManager.requestAudioFocus(request)
    } else {
      @Suppress("DEPRECATION")
      audioManager.requestAudioFocus(listener, AudioManager.STREAM_MUSIC, requestType)
    }
    if (result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
      explicitFocusAcquired = true
    } else {
      // FAILED and defensive DELAYED are explicit refusals. Abandon even when
      // focusAcquired is false; no unbounded pending request survives admission.
      cancelExplicitAudioFocus(player)
    }
    return result
  }

  private fun shouldReleaseFocus()`);
      // Keep legacy focus and its all-player callback behavior independent.
      // A default player starting beside TTS requests and owns its own focus.
      const handlerStart = text.indexOf('  private fun handleAudioFocusChange(');
      const handlerEnd = text.indexOf('  private fun cancelExplicitAudioFocus(', handlerStart);
      let handler = text.slice(handlerStart, handlerEnd);
      handler = replace(handler, 'handleAudioFocusChange(focusChange: Int)',
        'handleAudioFocusChange(focusChange: Int, explicitPlayer: AudioPlayer? = null)');
      handler = replace(handler, '      when (focusChange) {',
        '      val affectedPlayables = explicitPlayer?.let { sequenceOf<Playable>(it) } ?: allPlayables\n      when (focusChange) {');
      handler = replace(handler, 'allPlayables.forEach', 'affectedPlayables.forEach', 5);
      handler = replace(handler, '          focusAcquired = false',
        '          if (explicitPlayer != null) explicitFocusAcquired = false else focusAcquired = false', 2);
      handler = replace(handler, '          focusAcquired = true',
        '          if (explicitPlayer != null) explicitFocusAcquired = true else focusAcquired = true');
      text = text.slice(0, handlerStart) + handler + text.slice(handlerEnd);
      text = replace(text, `  private fun releaseAudioFocus() {
    if (!focusAcquired) {`, `  private fun releaseAudioFocus() {
    cancelExplicitAudioFocus()
    if (!focusAcquired) {`);
      text = replace(text, `      Function("pause") { player: AudioPlayer ->`, `      // Resolving means command admission, never proof that ExoPlayer started.
      AsyncFunction("playAsync") { player: AudioPlayer, requestId: Int ->
        if (!player.preventAutomaticResume) throw CodedException("ERR_TTS_AUDIO_PLAY_NOT_OPTED_IN", "Explicit playback admission requires opt-in.", null)
        if (player.disposalStarted) throw CodedException("ERR_TTS_AUDIO_DISPOSED", "The audio player has been disposed.", null)
        if (requestId <= 0) throw CodedException("ERR_TTS_AUDIO_REQUEST_INVALID", "The playback request is invalid.", null)
        if (!audioEnabled) throw CodedException("ERR_TTS_AUDIO_DISABLED", "Audio playback is disabled.", null)
        player.isPaused = false
        player.pause()
        player.playbackRequestId = requestId
        val result = requestExplicitAudioFocus(player)
        if (result != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
          val code = if (result == AudioManager.AUDIOFOCUS_REQUEST_DELAYED) "ERR_TTS_AUDIO_FOCUS_DELAYED" else "ERR_TTS_AUDIO_FOCUS_FAILED"
          throw CodedException(code, "Audio focus did not permit playback. Try Play again.", null)
        }
        player.play()
      }.runOnQueue(Queues.MAIN)

      Function("pause") { player: AudioPlayer ->`);
      text = replace(text, `          player.pause()
        }
      }

      Function("replace")`, `          player.pause()
          if (player.preventAutomaticResume) cancelExplicitAudioFocus(player)
        }
      }

      Function("replace")`);
      text = replace(text, `      AsyncFunction("disposeAsync") { player: AudioPlayer ->
        player.dispose()`, `      AsyncFunction("disposeAsync") { player: AudioPlayer ->
        cancelExplicitAudioFocus(player)
        player.dispose()`);
      return text;
    },
  },
  {
    file: 'android/src/main/java/expo/modules/audio/AudioPlayer.kt', after: '6f99ef319485dd5920aee83bb9a913e2264b3de56c60dca276188c729d805cad',
    transform(text) {
      text = replace(text, '  var preventAutomaticResume = false', '  var preventAutomaticResume = false\n  var playbackRequestId = 0');
      text = replace(text, `        if (disposalStarted) return
        playing = isPlaying`, `        if (disposalStarted) return
        // Media3 can deliver an older transition after a new Play request.
        if (preventAutomaticResume && isPlaying != ref.isPlaying) return
        playing = isPlaying`);
      text = replace(text, `      override fun onPlaybackStateChanged(playbackState: Int) {
        val justFinished`, `      override fun onPlaybackStateChanged(playbackState: Int) {
        if (preventAutomaticResume && playbackState != ref.playbackState) return
        val justFinished`);
      text = replace(text, '    val playingStatus = if (isBuffering) intendedPlayingState else ref.isPlaying',
        '    val playingStatus = if (preventAutomaticResume) ref.isPlaying else if (isBuffering) intendedPlayingState else ref.isPlaying');
      text = replace(text, `      "isBuffering" to isBuffering
    )`, `      "isBuffering" to isBuffering
    ) + if (preventAutomaticResume) mapOf("playbackRequestId" to playbackRequestId) else emptyMap()`);
      return text;
    },
  },
  {
    file: 'ios/AudioModule.swift', after: '406782c024ab1a3ced1026851ed409ae03e4c99aac29058e18b94afb4beb98fc',
    transform: text => replace(text, `      Function("setPlaybackRate") { (player, rate: Double, pitchCorrectionQuality: PitchCorrectionQuality?) in`, `      // Resolving means command admission; matching native status proves playback.
      AsyncFunction("playAsync") { (player: AudioPlayer, requestId: Int, promise: Promise) in
        guard player.preventAutomaticResume else {
          promise.reject("ERR_TTS_AUDIO_PLAY_NOT_OPTED_IN", "Explicit playback admission requires opt-in.")
          return
        }
        guard !player.disposalStarted else {
          promise.reject("ERR_TTS_AUDIO_DISPOSED", "The audio player has been disposed.")
          return
        }
        guard requestId > 0 else {
          promise.reject("ERR_TTS_AUDIO_REQUEST_INVALID", "The playback request is invalid.")
          return
        }
        guard self.sessionIsActive else {
          promise.reject("ERR_TTS_AUDIO_DISABLED", "Audio playback is disabled.")
          return
        }
        player.wasPlaying = false
        player.ref.pause()
        player.playbackRequestId = requestId
        do {
          try self.activateSession()
          let rate = player.currentRate > 0 ? player.currentRate : 1.0
          player.play(at: rate)
          promise.resolve()
        } catch {
          promise.reject("ERR_TTS_AUDIO_FOCUS_FAILED", "The audio session did not permit playback. Try Play again.")
        }
      }.runOnQueue(.main)

      Function("setPlaybackRate") { (player, rate: Double, pitchCorrectionQuality: PitchCorrectionQuality?) in`),
  },
  {
    file: 'ios/AudioPlayer.swift', after: '84b33494fcfe9e58f1d0b92a161c717b7b53180b7336be98629cd20534857d71',
    transform(text) {
      text = replace(text, '  var preventAutomaticResume = false', '  var preventAutomaticResume = false\n  var playbackRequestId = 0');
      text = replace(text, `    let rate = isPlaying ? ref.rate : currentRate
    return [`, `    let rate = isPlaying ? ref.rate : currentRate
    var status: [String: Any] = [`);
      text = replace(text, `      "isBuffering": isBuffering
    ]
  }`, `      "isBuffering": isBuffering
    ]
    if preventAutomaticResume { status["playbackRequestId"] = playbackRequestId }
    return status
  }`);
      return text;
    },
  },
];
for (const upgrade of admissionUpgrades) {
  const previous = patches.find(patch => patch.file === upgrade.file);
  if (previous) {
    const previousTransform = previous.transform;
    previous.legacyAfter = previous.after;
    previous.after = upgrade.after;
    previous.upgrade = upgrade.transform;
    previous.transform = text => upgrade.transform(previousTransform(text));
  } else {
    patches.push(upgrade);
  }
}

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
    if (originalHash !== patch.before && originalHash !== patch.legacyAfter) throw new Error(`expo-audio patch source hash mismatch: ${patch.file}`);
    const updated = originalHash === patch.legacyAfter ? patch.upgrade(original) : patch.transform(original);
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
