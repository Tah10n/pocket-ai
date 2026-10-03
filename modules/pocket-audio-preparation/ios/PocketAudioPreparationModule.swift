import ExpoModulesCore
import AVFoundation
import CryptoKit

private enum AudioPreparationFailure: Error { case invalid, limit, busy, cleanup }

public final class PocketAudioPreparationModule: Module {
  private let worker = DispatchQueue(label: "com.github.tah10n.pocketaudio.prepare", qos: .userInitiated)
  private let lock = NSLock()
  private var busy = false
  private var cleanupFailed = false

  public func definition() -> ModuleDefinition {
    Name("PocketAudioPreparation")
    AsyncFunction("prepare") { (source: String, rate: Int, seconds: Int, bytes: Int, promise: Promise) in
      self.lock.lock()
      guard !self.cleanupFailed else { self.lock.unlock(); promise.reject("ERR_AUDIO_CLEANUP", "cleanup_failed"); return }
      guard !self.busy else { self.lock.unlock(); promise.reject("ERR_AUDIO_BUSY", "preparation_busy"); return }
      self.busy = true
      self.lock.unlock()
      self.worker.async {
        defer { self.lock.lock(); self.busy = false; self.lock.unlock() }
        do { promise.resolve(try self.prepare(source, rate: rate, seconds: seconds, maxBytes: bytes)) }
        catch {
          self.lock.lock(); let failedCleanup = self.cleanupFailed; self.lock.unlock()
          if failedCleanup { promise.reject("ERR_AUDIO_CLEANUP", "cleanup_failed") }
          else { promise.reject("ERR_AUDIO_PREPARATION", "invalid_or_oversized_audio") }
        }
      }
    }
    AsyncFunction("remove") { (uri: String) in
      let source = try self.managed(uri)
      let root = try self.cacheRoot()
      guard source.deletingLastPathComponent() == root,
        source.lastPathComponent.range(of: "^[a-f0-9-]+\\.wav$", options: .regularExpression) != nil else {
        throw AudioPreparationFailure.cleanup
      }
      if FileManager.default.fileExists(atPath: source.path) { try FileManager.default.removeItem(at: source) }
      if try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil).isEmpty {
        self.lock.lock(); self.cleanupFailed = false; self.lock.unlock()
      }
    }
  }

  private func cacheRoot() throws -> URL {
    let cache = try FileManager.default.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    return cache.appendingPathComponent("audio-preparation", isDirectory: true).resolvingSymlinksInPath()
  }
  private func managed(_ uri: String) throws -> URL {
    guard let url = URL(string: uri), url.isFileURL, url.host == nil || url.host == "" else { throw AudioPreparationFailure.invalid }
    let path = url.standardizedFileURL.resolvingSymlinksInPath()
    let roots = [FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first,
      FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first].compactMap { $0?.resolvingSymlinksInPath() }
    guard roots.contains(where: { path.path.hasPrefix($0.path + "/") }) else { throw AudioPreparationFailure.invalid }
    return path
  }
  private func digest(_ url: URL) throws -> String {
    let input = try FileHandle(forReadingFrom: url)
    defer { try? input.close() }
    var hash = SHA256()
    var count = 0
    while let chunk = try input.read(upToCount: 65536), !chunk.isEmpty {
      count += chunk.count
      guard count <= 4 * 1024 * 1024 else { throw AudioPreparationFailure.limit }
      hash.update(data: chunk)
    }
    return hash.finalize().map { String(format: "%02x", $0) }.joined()
  }

  private func validateWave(_ url: URL, bytes: Int, seconds: Int) throws -> (rate: Int, channels: Int) {
    let input = try FileHandle(forReadingFrom: url)
    defer { try? input.close() }
    func exact(_ count: Int) throws -> Data {
      let value = try input.read(upToCount: count) ?? Data()
      guard value.count == count else { throw AudioPreparationFailure.invalid }
      return value
    }
    func u16(_ data: Data, _ offset: Int) -> Int { Int(data[offset]) | (Int(data[offset + 1]) << 8) }
    func u32(_ data: Data, _ offset: Int) -> Int { u16(data, offset) | (u16(data, offset + 2) << 16) }
    let header = try exact(12)
    guard u32(header, 4) + 8 == bytes else { throw AudioPreparationFailure.invalid }
    var rate = 0; var channels = 0; var alignment = 0; var dataBytes: Int?; var chunks = 0
    while try input.offset() + 8 <= UInt64(bytes) {
      chunks += 1
      guard chunks <= 64 else { throw AudioPreparationFailure.invalid }
      let chunk = try exact(8)
      let length = u32(chunk, 4)
      let start = try input.offset()
      guard start + UInt64(length + (length & 1)) <= UInt64(bytes) else { throw AudioPreparationFailure.invalid }
      switch String(data: chunk[0..<4], encoding: .ascii) {
      case "fmt ":
        guard rate == 0, (16...40).contains(length) else { throw AudioPreparationFailure.invalid }
        let format = try exact(16)
        let kind = u16(format, 0); channels = u16(format, 2); rate = u32(format, 4)
        alignment = u16(format, 12)
        let bits = u16(format, 14)
        guard (1...2).contains(channels), (8000...192000).contains(rate),
          (kind == 1 && bits == 16) || (kind == 3 && bits == 32),
          alignment == channels * bits / 8, u32(format, 8) == rate * alignment else { throw AudioPreparationFailure.invalid }
      case "data":
        guard dataBytes == nil else { throw AudioPreparationFailure.invalid }
        dataBytes = length
      default: break
      }
      try input.seek(toOffset: start + UInt64(length + (length & 1)))
    }
    guard try input.offset() == UInt64(bytes), rate > 0, alignment > 0, let length = dataBytes, length > 0, length % alignment == 0,
      length / alignment <= rate * seconds else { throw AudioPreparationFailure.limit }
    return (rate, channels)
  }

  private func prepare(_ uri: String, rate: Int, seconds: Int, maxBytes: Int) throws -> [String: Any] {
    guard (8000...48000).contains(rate), (1...30).contains(seconds), (1...4 * 1024 * 1024).contains(maxBytes) else {
      throw AudioPreparationFailure.limit
    }
    let source = try managed(uri)
    guard PAPMemoryAdmission.availableBytes() >= 64 * 1024 * 1024 else { throw AudioPreparationFailure.limit }
    let attributes = try FileManager.default.attributesOfItem(atPath: source.path)
    guard attributes[.type] as? FileAttributeType == .typeRegular,
      let bytes = attributes[.size] as? NSNumber, bytes.intValue > 0, bytes.intValue <= maxBytes else { throw AudioPreparationFailure.limit }
    let sourceHash = try digest(source)
    let sniff = try FileHandle(forReadingFrom: source)
    let prefix = try sniff.read(upToCount: 12) ?? Data()
    try sniff.close()
    guard prefix.count == 12 else { throw AudioPreparationFailure.invalid }
    let wave = String(data: prefix[0..<4], encoding: .ascii) == "RIFF" && String(data: prefix[8..<12], encoding: .ascii) == "WAVE"
    let compressed = String(data: prefix[4..<8], encoding: .ascii) == "ftyp"
      || String(data: prefix[0..<3], encoding: .ascii) == "ID3" || (prefix[0] == 255 && prefix[1] & 224 == 224)
    guard wave || compressed else { throw AudioPreparationFailure.invalid }
    let declared: (rate: Int, channels: Int)?
    if wave { declared = try validateWave(source, bytes: bytes.intValue, seconds: seconds) }
    else { declared = nil }
    let asset = AVURLAsset(url: source)
    guard asset.tracks(withMediaType: .video).isEmpty else { throw AudioPreparationFailure.invalid }
    let audio = try AVAudioFile(forReading: source, commonFormat: .pcmFormatFloat32, interleaved: false)
    let format = audio.processingFormat
    let channels = Int(format.channelCount)
    let sourceRate = Int(format.sampleRate)
    guard channels >= 1 && channels <= 2, (8000...192000).contains(sourceRate), format.sampleRate == Double(sourceRate),
      audio.length > 0 && audio.length <= Int64(sourceRate * seconds) else { throw AudioPreparationFailure.limit }
    // On WAV, require a real PCM source, never accept renamed AAC/MP3 as a WAV container.
    if wave {
      guard audio.fileFormat.commonFormat == .pcmFormatInt16 || audio.fileFormat.commonFormat == .pcmFormatFloat32 else {
        throw AudioPreparationFailure.invalid
      }
      guard declared?.rate == sourceRate && declared?.channels == channels else { throw AudioPreparationFailure.invalid }
    }
    let root = try cacheRoot()
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    var excluded = root
    var values = URLResourceValues(); values.isExcludedFromBackup = true
    try excluded.setResourceValues(values)
    let target = root.appendingPathComponent(UUID().uuidString.lowercased() + ".wav")
    guard FileManager.default.createFile(atPath: target.path, contents: Data(repeating: 0, count: 44)) else { throw AudioPreparationFailure.cleanup }
    var success = false
    defer {
      if !success {
        do { try FileManager.default.removeItem(at: target) }
        catch { self.lock.lock(); self.cleanupFailed = true; self.lock.unlock() }
      }
    }
    let output = try FileHandle(forWritingTo: target)
    defer { try? output.close() }
    try output.seekToEnd()
    guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 8192) else { throw AudioPreparationFailure.invalid }
    let step = Double(sourceRate) / Double(rate)
    var filled = 0.0; var sum = 0.0; var decoded = 0; var samples = 0
    var pcm = Data(); pcm.reserveCapacity(32768)
    let deadline = Date().addingTimeInterval(30)
    while true {
      guard Date() < deadline else { throw AudioPreparationFailure.limit }
      try audio.read(into: buffer, frameCount: 8192)
      if buffer.frameLength == 0 { break }
      guard let channelData = buffer.floatChannelData else { throw AudioPreparationFailure.invalid }
      for index in 0..<Int(buffer.frameLength) {
        decoded += 1
        guard decoded <= sourceRate * seconds else { throw AudioPreparationFailure.limit }
        var mono = 0.0
        for channel in 0..<channels {
          let value = channelData[channel][index]
          guard value.isFinite else { throw AudioPreparationFailure.invalid }
          mono += Double(max(-1, min(1, value))) / Double(channels)
        }
        var remaining = 1.0
        while remaining > 1e-9 {
          let weight = min(remaining, step - filled)
          sum += mono * weight; filled += weight; remaining -= weight
          if filled >= step - 1e-9 {
            samples += 1
            guard samples <= rate * seconds else { throw AudioPreparationFailure.limit }
            let normalized = sum / step
            let integer = Int16(max(-32768, min(32767, Int((normalized * (normalized < 0 ? 32768 : 32767)).rounded()))))
            let unsigned = UInt16(bitPattern: integer)
            pcm.append(UInt8(unsigned & 255)); pcm.append(UInt8(unsigned >> 8))
            if pcm.count >= 32768 { try output.write(contentsOf: pcm); pcm.removeAll(keepingCapacity: true) }
            sum = 0; filled = 0
          }
        }
      }
    }
    guard decoded > 0 && samples > 0 else { throw AudioPreparationFailure.invalid }
    if !pcm.isEmpty { try output.write(contentsOf: pcm) }
    var header = Data()
    func u16(_ value: Int) { header.append(UInt8(value & 255)); header.append(UInt8((value >> 8) & 255)) }
    func u32(_ value: Int) { for shift in stride(from: 0, to: 32, by: 8) { header.append(UInt8((value >> shift) & 255)) } }
    header.append(contentsOf: "RIFF".utf8); u32(36 + samples * 2); header.append(contentsOf: "WAVEfmt ".utf8)
    u32(16); u16(1); u16(1); u32(rate); u32(rate * 2); u16(2); u16(16)
    header.append(contentsOf: "data".utf8); u32(samples * 2)
    try output.seek(toOffset: 0); try output.write(contentsOf: header); try output.synchronize()
    guard try digest(source) == sourceHash else { throw AudioPreparationFailure.invalid }
    let size = try FileManager.default.attributesOfItem(atPath: target.path)[.size] as? NSNumber
    guard size?.intValue == 44 + samples * 2 else { throw AudioPreparationFailure.invalid }
    let result: [String: Any] = ["uri": target.absoluteString, "sourceSha256": sourceHash, "sha256": try digest(target),
      "sampleRate": rate, "channels": 1, "sampleCount": samples, "sizeBytes": 44 + samples * 2]
    success = true
    return result
  }
}
