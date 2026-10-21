'use strict';

// Recorder lifecycle additions are composed with the accepted player patch.
// No capture API is enabled unless its caller explicitly opts in.
const replace = (text, before, after, count = 1) => {
  if (text.split(before).length - 1 !== count) throw new Error('expo-audio recorder patch anchor mismatch');
  return text.split(before).join(after);
};

const statusType = 'RecorderState & { recordingRequestId: number; isFinished?: boolean; hasError?: boolean; interrupted?: boolean }';
const upgrades = [
  ...['src/AudioModule.types.ts', 'build/AudioModule.types.d.ts'].map(file => ({
    file, after: {
      'src/AudioModule.types.ts': 'fdba9773b877f20cd04dde30709b563c4663d7ab7681832b87c9d575af5b41dd',
      'build/AudioModule.types.d.ts': '5683ce5db27dcab1d9f5ab1c81cf98a40e0515b00be889d62a79f1afd88d0461',
    }[file],
    transform: text => replace(text, 'export declare class AudioRecorder extends SharedObject<RecordingEvents> {',
      `export declare class AudioRecorder extends SharedObject<RecordingEvents> {
  /** Explicit capture lifecycle; opt-in is required and legacy recorders retain their behavior. */
  preventAutomaticResume: boolean;
  /** Synchronous request tombstone; pending native work must still be drained and disposed. */
  cancelRequest(requestId: number): void;
  prepareAsync(requestId: number, durationSeconds: number, maxBytes: number): Promise<${statusType}>;
  startAsync(requestId: number): Promise<${statusType}>;
  finishAsync(requestId: number): Promise<${statusType}>;
  /** Confirm capture teardown and registry removal before release or source deletion. */
  disposeAsync(): Promise<void>;`),
  })),
  {
    file: 'android/src/main/java/expo/modules/audio/AudioModule.kt', after: 'ffd2eedd5cdba35fc0ef38073c34f775b0cf634bd1124ab92c4a0983df4ce8db',
    transform(text) {
      text = replace(text, '  private var allowsBackgroundRecording = false',
        '  private var allowsBackgroundRecording = false\n  private var captureForeground = true');
      text = replace(text, '    OnActivityEntersBackground {', '    OnActivityEntersBackground {\n      captureForeground = false');
      text = replace(text, '    OnActivityEntersForeground {', '    OnActivityEntersForeground {\n      captureForeground = true');
      text = replace(text, `          if (recorder.isRecording) {
            recorder.pauseRecording()`, `          if (recorder.preventAutomaticResume) {
            recorder.finishExplicit(recorder.recordingRequestId, interrupted = true)
          } else if (recorder.isRecording) {
            recorder.pauseRecording()`);
      text = replace(text, '          if (recorder.isPaused) {',
        '          if (recorder.isPaused && !recorder.preventAutomaticResume && !recorder.disposalStarted) {');
      text = replace(text, `      Property("id") { recorder ->
        recorder.id
      }`, `      Property("id") { recorder ->
        recorder.id
      }

      Property("preventAutomaticResume") { recorder -> recorder.preventAutomaticResume }
        .set { recorder, value: Boolean ->
          runOnMain {
            recorder.preventAutomaticResume = value || recorder.disposalStarted
            if (recorder.preventAutomaticResume) recorder.useForegroundService = false
          }
        }

      Function("cancelRequest") { recorder: AudioRecorder, requestId: Int -> recorder.cancelRequest(requestId) }

      AsyncFunction("prepareAsync") Coroutine { recorder: AudioRecorder, requestId: Int, durationSeconds: Double, maxBytes: Int ->
        kotlinx.coroutines.withContext(Dispatchers.Main) {
          checkRecordingPermission()
          if (!captureForeground) throw CodedException("ERR_AUDIO_CAPTURE_BACKGROUND", "Recording requires the foreground.", null)
          recorder.prepareExplicit(requestId, durationSeconds, maxBytes)
        }
      }

      AsyncFunction("startAsync") { recorder: AudioRecorder, requestId: Int ->
        checkRecordingPermission()
        if (!captureForeground) throw CodedException("ERR_AUDIO_CAPTURE_BACKGROUND", "Recording requires the foreground.", null)
        recorder.startExplicit(requestId)
      }.runOnQueue(Queues.MAIN)

      AsyncFunction("finishAsync") { recorder: AudioRecorder, requestId: Int ->
        recorder.finishExplicit(requestId)
      }.runOnQueue(Queues.MAIN)

      AsyncFunction("disposeAsync") { recorder: AudioRecorder ->
        recorder.disposeExplicit()
        recorders.remove(recorder.id)
      }.runOnQueue(Queues.MAIN)`);
      return text;
    },
  },
  {
    file: 'android/src/main/java/expo/modules/audio/AudioRecorder.kt',
    before: 'd1ba647c0cc83019396ad996b206aa27a59b34130aa212659b4b99c33ceb2da8', after: '7bac2e7a080594e9359a1a54641993677472d4b45b11f7aacb7aa725deffd516',
    transform(text) {
      text = replace(text, '  var isPaused = false', `  var isPaused = false
  var preventAutomaticResume = false
  var recordingRequestId = 0
    private set
  var disposalStarted = false
    private set
  private var disposed = false
  private var explicitDurationSeconds = 0.0
  private var explicitMaxBytes = 0L
  private var explicitFinished: Bundle? = null
  @Volatile private var cancelledRequestId = 0

  // JSI invokes this synchronously before queued main-thread prepare/start may execute.
  fun cancelRequest(requestId: Int) { if (requestId > 0) cancelledRequestId = requestId }

  private fun captureError(code: String): Nothing = throw CodedException(code, "The recording operation is unavailable.", null)

  suspend fun prepareExplicit(requestId: Int, durationSeconds: Double, maxBytes: Int): Bundle {
    if (!preventAutomaticResume || disposalStarted) captureError("ERR_AUDIO_CAPTURE_NOT_OPTED_IN")
    if (cancelledRequestId == requestId) captureError("ERR_AUDIO_CAPTURE_CANCELLED")
    if (requestId <= 0 || !durationSeconds.isFinite() || durationSeconds <= 0 || durationSeconds > 30 || maxBytes <= 0 || maxBytes > 4 * 1024 * 1024) captureError("ERR_AUDIO_CAPTURE_LIMITS")
    if (isPrepared || isRecording || isPaused || recorder != null) captureError("ERR_AUDIO_CAPTURE_BUSY")
    recordingRequestId = requestId
    explicitDurationSeconds = durationSeconds
    explicitMaxBytes = maxBytes.toLong()
    explicitFinished = null
    useForegroundService = false
    prepareRecording(null)
    return explicitStatus()
  }

  fun startExplicit(requestId: Int): Bundle {
    if (!preventAutomaticResume || disposalStarted || cancelledRequestId == requestId || requestId != recordingRequestId || !isPrepared || recorder == null || explicitFinished != null) captureError("ERR_AUDIO_CAPTURE_STALE")
    recordWithOptions(forDurationSeconds = explicitDurationSeconds)
    return explicitStatus()
  }

  private fun explicitStatus(): Bundle = Bundle().apply {
    putBoolean("canRecord", isPrepared && !disposalStarted)
    putBoolean("isRecording", isRecording && !disposalStarted)
    putLong("durationMillis", getAudioRecorderDurationMillis())
    putInt("recordingRequestId", recordingRequestId)
    currentFileUrl()?.let { putString("url", it) }
  }

  // MediaRecorder.stop finalizes its container synchronously. Failure never yields a Ready URL.
  fun finishExplicit(requestId: Int, failed: Boolean = false, interrupted: Boolean = false): Bundle {
    if (!preventAutomaticResume) captureError("ERR_AUDIO_CAPTURE_NOT_OPTED_IN")
    if (requestId != recordingRequestId) captureError("ERR_AUDIO_CAPTURE_STALE")
    explicitFinished?.let { return it }
    val duration = getAudioRecorderDurationMillis()
    var stopFailed = failed || !(isRecording || isPaused)
    try {
      if (isRecording || isPaused) recorder?.stop()
    } catch (_: RuntimeException) {
      stopFailed = true
    } finally {
      reset()
    }
    val bytes = filePath?.let { File(it).length() } ?: 0
    stopFailed = stopFailed || bytes <= 0 || bytes > explicitMaxBytes
    val status = Bundle().apply {
      putBoolean("canRecord", false)
      putBoolean("isRecording", false)
      putBoolean("isFinished", true)
      putBoolean("hasError", stopFailed)
      putBoolean("interrupted", interrupted)
      putLong("durationMillis", duration)
      putInt("recordingRequestId", recordingRequestId)
      if (!stopFailed) currentFileUrl()?.let { putString("url", it) }
    }
    explicitFinished = status
    emit(RECORDING_STATUS_UPDATE, mapOf("id" to id, "recordingRequestId" to recordingRequestId,
      "isFinished" to true, "hasError" to stopFailed, "interrupted" to interrupted, "error" to if (stopFailed) "ERR_AUDIO_CAPTURE_FINALIZE" else null,
      "url" to if (stopFailed) null else currentFileUrl()))
    return status
  }

  // A failed release remains retryable; the caller keeps its audio-session lease.
  fun disposeExplicit() {
    if (disposed) return
    if (!preventAutomaticResume) captureError("ERR_AUDIO_CAPTURE_NOT_OPTED_IN")
    disposalStarted = true
    if (isRecording || isPaused) finishExplicit(recordingRequestId) else reset()
    serviceConnection.release()
    serviceConnection.unbind()
    serviceConnection.cleanup()
    disposed = true
  }`);
      text = replace(text, '  fun stopRecording(): Bundle {',
        '  fun stopRecording(): Bundle {\n    if (preventAutomaticResume) return finishExplicit(recordingRequestId)');
      text = replace(text, '      options.maxFileSize?.let {', `      if (preventAutomaticResume) {
        setMaxDuration((explicitDurationSeconds * 1000).toInt())
        setMaxFileSize(explicitMaxBytes)
      }
      options.maxFileSize?.let {`);
      text = replace(text, '    super.sharedObjectDidRelease()\n', `    super.sharedObjectDidRelease()
    if (preventAutomaticResume) {
      // Explicit callers already awaited disposal; this is only a last-resort legacy release fallback.
      if (!disposed) appContext?.mainQueue?.launch { disposeExplicit() }
      return
    }
`);
      text = replace(text, '  fun getAudioRecorderStatus() = if (hasRecordingPermissions()) {',
        '  fun getAudioRecorderStatus() = if (preventAutomaticResume) explicitFinished ?: explicitStatus() else if (hasRecordingPermissions()) {');
      text = replace(text, '  override fun onError(mr: MediaRecorder?, what: Int, extra: Int) {',
        '  override fun onError(mr: MediaRecorder?, what: Int, extra: Int) {\n    if (preventAutomaticResume) {\n      appContext?.mainQueue?.launch { if (!disposed) finishExplicit(recordingRequestId, true) }\n      return\n    }');
      text = replace(text, '  override fun onInfo(mr: MediaRecorder?, what: Int, extra: Int) {',
        '  override fun onInfo(mr: MediaRecorder?, what: Int, extra: Int) {\n    if (preventAutomaticResume && (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED || what == MEDIA_RECORDER_INFO_MAX_FILESIZE_REACHED)) {\n      appContext?.mainQueue?.launch { if (!disposed) finishExplicit(recordingRequestId) }\n      return\n    }');
      return text;
    },
  },
  {
    file: 'ios/AudioComponentRegistry.swift', after: '15ec31d7dcad820efa5e17c77284cf6f67662c25f71adf08ea04fd1a9105652f',
    transform: text => replace(text, '  func remove(_ recorder: AudioRecorder) {', `  func removeSynchronously(_ recorder: AudioRecorder) {
    registryQueue.sync(flags: .barrier) {
      _ = self.recorders.removeValue(forKey: recorder.id)
    }
  }

  func remove(_ recorder: AudioRecorder) {`),
  },
  {
    file: 'ios/AudioModule.swift', after: '8ad196fe10027b6cb0a7d3e14d7f7b8941f887b3befade1b94384c4f5323d088',
    transform(text) {
      text = replace(text, '  private var allowsBackgroundRecording = false',
        '  private var allowsBackgroundRecording = false\n  private var captureForeground = true');
      text = replace(text, '    OnAppEntersBackground {', '    OnAppEntersBackground {\n      captureForeground = false');
      text = replace(text, '    OnAppEntersForeground {', '    OnAppEntersForeground {\n      captureForeground = true');
      text = replace(text, `      Property("id") { recorder in
        recorder.id
      }`, `      Property("id") { recorder in
        recorder.id
      }

      Property("preventAutomaticResume") { recorder in recorder.preventAutomaticResume }
        .set { (recorder, value: Bool) in recorder.preventAutomaticResume = value || recorder.disposalStarted }

      Function("cancelRequest") { (recorder: AudioRecorder, requestId: Int) in recorder.cancelRequest(requestId: requestId) }

      AsyncFunction("prepareAsync") { (recorder: AudioRecorder, requestId: Int, durationSeconds: Double, maxBytes: Int) in
        try checkPermissions()
        guard self.captureForeground else { throw AudioRecordingException("ERR_AUDIO_CAPTURE_BACKGROUND") }
        return try recorder.prepareExplicit(requestId: requestId, durationSeconds: durationSeconds, maxBytes: maxBytes, sessionOptions: self.sessionOptions)
      }.runOnQueue(.main)

      AsyncFunction("startAsync") { (recorder: AudioRecorder, requestId: Int) in
        try checkPermissions()
        guard self.captureForeground else { throw AudioRecordingException("ERR_AUDIO_CAPTURE_BACKGROUND") }
        return try recorder.startExplicit(requestId: requestId)
      }.runOnQueue(.main)

      AsyncFunction("finishAsync") { (recorder: AudioRecorder, requestId: Int) in
        return try recorder.finishExplicit(requestId: requestId)
      }.runOnQueue(.main)

      AsyncFunction("disposeAsync") { (recorder: AudioRecorder) in
        try recorder.disposeExplicit()
      }.runOnQueue(.main)`);
      text = replace(text, '        recorder.pauseRecording()',
        '        if recorder.preventAutomaticResume { _ = try? recorder.finishExplicit(requestId: recorder.recordingRequestId, interrupted: true) } else { recorder.pauseRecording() }', 3);
      text = replace(text, '      if recorder.allowsRecording && !recorder.isRecording {',
        '      if recorder.allowsRecording && !recorder.isRecording && !recorder.preventAutomaticResume && !recorder.disposalStarted {', 2);
      // The Stage 6 deferred deactivation must not deactivate a recorder that acquired the next lease.
      text = replace(text, '      if !hasActivePlayers && !hasActivePlaylists {',
        '      if !hasActivePlayers && !hasActivePlaylists && !self.registry.allRecorders.values.contains(where: { $0.preventAutomaticResume && !$0.disposalStarted }) {');
      return text;
    },
  },
  {
    file: 'ios/AudioRecorder.swift', before: '064a9bbeb92b2649c94e3b316a5ce30c75c73b735aada0f3de238ba747a4f052', after: 'cc92065ea42e9f3ba4dcce4e3512664c77e33f62ac65467d9709f518b27020c5',
    transform(text) {
      text = replace(text, '  var allowsRecording = false', `  var allowsRecording = false
  var preventAutomaticResume = false
  private(set) var disposalStarted = false
  private(set) var recordingRequestId = 0
  private var disposed = false
  private var explicitDurationSeconds = 0.0
  private var explicitMaxBytes = 0
  private var explicitFinished: [String: Any]?
  private var captureSizeTimer: Timer?
  private let captureCancellationLock = NSLock()
  private var cancelledRequestId = 0

  // This tombstone crosses the JSI/main-queue boundary; it does not release resources.
  func cancelRequest(requestId: Int) {
    guard requestId > 0 else { return }
    captureCancellationLock.lock()
    cancelledRequestId = requestId
    captureCancellationLock.unlock()
  }
  private func requestCancelled(_ requestId: Int) -> Bool {
    captureCancellationLock.lock()
    defer { captureCancellationLock.unlock() }
    return cancelledRequestId == requestId
  }

  func prepareExplicit(requestId: Int, durationSeconds: Double, maxBytes: Int, sessionOptions: AVAudioSession.CategoryOptions) throws -> [String: Any] {
    guard preventAutomaticResume, !disposalStarted, requestId > 0, durationSeconds.isFinite, durationSeconds > 0, durationSeconds <= 30, maxBytes > 65536, maxBytes <= 4 * 1024 * 1024 else { throw AudioRecordingException("ERR_AUDIO_CAPTURE_LIMITS") }
    guard !requestCancelled(requestId) else { throw AudioRecordingException("ERR_AUDIO_CAPTURE_CANCELLED") }
    guard !isPrepared, !ref.isRecording else { throw AudioRecordingException("ERR_AUDIO_CAPTURE_BUSY") }
    recordingRequestId = requestId
    explicitDurationSeconds = durationSeconds
    explicitMaxBytes = maxBytes
    explicitFinished = nil
    try prepare(options: nil, sessionOptions: sessionOptions)
    return explicitStatus()
  }

  func startExplicit(requestId: Int) throws -> [String: Any] {
    guard preventAutomaticResume, !disposalStarted, !requestCancelled(requestId), allowsRecording, requestId == recordingRequestId, isPrepared, explicitFinished == nil else { throw AudioRecordingException("ERR_AUDIO_CAPTURE_STALE") }
    guard ref.record(forDuration: explicitDurationSeconds), ref.isRecording else { currentState = .error; throw AudioRecordingException("ERR_AUDIO_CAPTURE_START") }
    updateStateForDirectRecording()
    captureSizeTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
      guard let self, !self.disposalStarted else { return }
      let bytes = (try? self.ref.url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
      if bytes >= self.explicitMaxBytes - 65536 { _ = try? self.finishExplicit(requestId: self.recordingRequestId) }
    }
    return explicitStatus()
  }

  private func explicitStatus() -> [String: Any] {
    var status = getRecordingStatus()
    status["isRecording"] = ref.isRecording && !disposalStarted
    status["recordingRequestId"] = recordingRequestId
    return status
  }

  // AVAudioRecorder.stop closes the audio file; subsequent decoding remains a separate validation step.
  func finishExplicit(requestId: Int, failed: Bool = false, interrupted: Bool = false) throws -> [String: Any] {
    guard preventAutomaticResume, requestId == recordingRequestId else { throw AudioRecordingException("ERR_AUDIO_CAPTURE_STALE") }
    if let explicitFinished { return explicitFinished }
    let duration = totalDuration
    let didStart = currentState == .recording || currentState == .paused || currentState == .stopped
    captureSizeTimer?.invalidate()
    captureSizeTimer = nil
    ref.stop()
    currentState = .stopped
    let bytes = (try? ref.url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
    let hasError = failed || !didStart || ref.isRecording || bytes <= 0 || bytes > explicitMaxBytes
    var status: [String: Any] = ["canRecord": false, "isRecording": false, "isFinished": true,
      "hasError": hasError, "interrupted": interrupted, "durationMillis": duration, "recordingRequestId": recordingRequestId]
    if !hasError { status["url"] = ref.url.absoluteString }
    explicitFinished = status
    resetDurationTracking()
    emit(event: recordingStatus, arguments: ["id": id, "recordingRequestId": recordingRequestId,
      "isFinished": true, "hasError": hasError, "interrupted": interrupted, "error": hasError ? "ERR_AUDIO_CAPTURE_FINALIZE" : nil,
      "url": hasError ? nil : ref.url.absoluteString])
    return status
  }

  func disposeExplicit() throws {
    if disposed { return }
    guard preventAutomaticResume else { throw AudioRecordingException("ERR_AUDIO_CAPTURE_NOT_OPTED_IN") }
    disposalStarted = true
    if ref.isRecording { _ = try finishExplicit(requestId: recordingRequestId) } else { ref.stop() }
    captureSizeTimer?.invalidate()
    captureSizeTimer = nil
    ref.delegate = nil
    recordingDelegate = nil
    owningRegistry?.removeSynchronously(self)
    owningRegistry = nil
    disposed = true
  }`);
      text = replace(text, '  func getRecordingStatus() -> [String: Any] {',
        '  func getRecordingStatus() -> [String: Any] {\n    if preventAutomaticResume, let explicitFinished { return explicitFinished }');
      text = replace(text, '    return result', '    if preventAutomaticResume { result["recordingRequestId"] = recordingRequestId; result["isRecording"] = ref.isRecording && !disposalStarted }\n    return result');
      text = replace(text, '  func handleMediaServicesReset() {', `  func handleMediaServicesReset() {
    if preventAutomaticResume {
      mediaServicesDidReset = true
      _ = try? finishExplicit(requestId: recordingRequestId, failed: true)
      return
    }`);
      text = replace(text, '  func didFinish(_ recorder: AVAudioRecorder, successfully flag: Bool) {',
        '  func didFinish(_ recorder: AVAudioRecorder, successfully flag: Bool) {\n    if preventAutomaticResume {\n      _ = try? finishExplicit(requestId: recordingRequestId, failed: !flag)\n      return\n    }');
      text = replace(text, '  func encodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {',
        '  func encodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {\n    if preventAutomaticResume {\n      _ = try? finishExplicit(requestId: recordingRequestId, failed: true)\n      return\n    }');
      text = replace(text, '  override func sharedObjectWillRelease() {', `  override func sharedObjectWillRelease() {
    if preventAutomaticResume {
      if Thread.isMainThread { try? disposeExplicit() } else { DispatchQueue.main.async { try? self.disposeExplicit() } }
      return
    }`);
      return text;
    },
  },
];

module.exports = upgrades;
