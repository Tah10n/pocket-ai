import Darwin
import CoreFoundation
import CryptoKit
import ExpoModulesCore
import Foundation
import UIKit

private let moduleName = "PocketAnydoc"
private let attachmentDirectory = "chat-attachments"
private let maxRequestBytes = 64 * 1024
private let maxResponseBytes = 1024 * 1024
private let maxSourceBytes: Int64 = 32 * 1024 * 1024
private let maxRequestDepth = 8
private let maxRequestNodes = 512
private let maxStringCharacters = 16 * 1024
private let maxRequestIdentifierCharacters = 128
private let maxHandleCharacters = 256
private let maxSelectedCharacters = 64 * 1024
private let maxSelectedChunks = 64
private let maxOutstandingHeavyJobs = 16
private let maxAssetDescriptors = 128
private let maxAssetBytes = 8 * 1024 * 1024
private let maxAssetIdentifier = Int(Int32.max)
private let maxTrackedHandles = 16
private let assetDirectory = "pocket-anydoc-assets"
private let assetExtensions = [
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
]
private let materializeRequestKeys = Set(["requestId", "handle", "assetId"])

private enum HeavyOperation {
  case prepare
  case selectContext
  case materializeAsset
}

private struct RequestFailure: Error {
  let code: String
  let message: String
}

private struct JobInvalidated: Error {
  let envelope: [String: Any]
}

private struct FileIdentity: Equatable {
  let device: UInt64
  let inode: UInt64
  let size: Int64
  let modifiedSeconds: Int64
  let modifiedNanoseconds: Int64

  var json: [String: Any] {
    [
      "device": device,
      "inode": inode,
      "size": size,
      "modifiedSeconds": modifiedSeconds,
      "modifiedNanoseconds": modifiedNanoseconds,
    ]
  }
}

private struct ValidatedSource {
  let fileURL: URL
  let rootURL: URL
  let identity: FileIdentity
}

private struct AssetMetadata {
  let mediaType: String
  let byteLength: Int
  let sha256: String
  let width: Int
  let height: Int
}

private struct OwnedAsset: Equatable {
  let handle: String
  let requestId: String
  let fileURL: URL
}

private final class NativeEngineGate {
  private let condition = NSCondition()
  private var engine: OpaquePointer?
  private var activeCalls = 0
  private var retirementRequested = false

  func withEngine<T>(create: Bool, _ body: (OpaquePointer) throws -> T) throws -> T {
    condition.lock()
    while retirementRequested {
      condition.wait()
    }
    if engine == nil && create {
      engine = pocket_anydoc_engine_new()
    }
    guard let current = engine else {
      condition.unlock()
      throw RequestFailure(code: "engine_initialization_failed", message: "The native document engine could not be initialized.")
    }
    activeCalls += 1
    condition.unlock()

    defer {
      condition.lock()
      activeCalls -= 1
      if activeCalls == 0 {
        condition.broadcast()
      }
      condition.unlock()
    }
    return try body(current)
  }

  func withExistingEngine<T>(_ body: (OpaquePointer) throws -> T) rethrows -> T? {
    condition.lock()
    guard let current = engine else {
      condition.unlock()
      return nil
    }
    activeCalls += 1
    condition.unlock()

    defer {
      condition.lock()
      activeCalls -= 1
      if activeCalls == 0 {
        condition.broadcast()
      }
      condition.unlock()
    }
    return try body(current)
  }

  func requestRetirement() -> Bool {
    condition.lock()
    defer { condition.unlock() }
    guard !retirementRequested else { return false }
    retirementRequested = true
    return true
  }

  func retireRequested() {
    condition.lock()
    guard retirementRequested else {
      condition.unlock()
      return
    }
    while activeCalls > 0 {
      condition.wait()
    }
    let current = engine
    engine = nil
    condition.unlock()
    if let current {
      pocket_anydoc_engine_free(current)
    }
    condition.lock()
    retirementRequested = false
    condition.broadcast()
    condition.unlock()
  }
}

private final class HeavyJob {
  let identifier = UUID()
  let operation: HeavyOperation
  let request: [String: Any]
  let requestId: String
  let submittedGeneration: UInt64
  let promise: Promise

  init(
    operation: HeavyOperation,
    request: [String: Any],
    requestId: String,
    submittedGeneration: UInt64,
    promise: Promise
  ) {
    self.operation = operation
    self.request = request
    self.requestId = requestId
    self.submittedGeneration = submittedGeneration
    self.promise = promise
  }
}

public final class PocketAnyDocModule: Module {
  private let workerQueue = DispatchQueue(label: "com.github.tah10n.pocketanydoc.worker", qos: .utility)
  private let retirementQueue = DispatchQueue(label: "com.github.tah10n.pocketanydoc.retirement", qos: .utility)
  private let stateLock = NSLock()
  private let engineGate = NativeEngineGate()
  private var destroyed = false
  private var generation: UInt64 = 0
  private var activeRequestIdentifiers = Set<String>()
  private var cancelledRequestIdentifiers = Set<String>()
  private var pendingJobs: [UUID: HeavyJob] = [:]
  private var assetMetadataByHandle: [String: [Int: AssetMetadata]] = [:]
  private var releasedAssetHandles = Set<String>()
  private var pendingAssetDestinations: [String: OwnedAsset] = [:]
  private var ownedAssetsByHandle: [String: [OwnedAsset]] = [:]
  private var memoryObserver: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name(moduleName)

    OnCreate {
      installMemoryObserver()
    }

    AsyncFunction("getCapabilities") { () -> [String: Any] in
      staticCall(pocket_anydoc_capabilities)
    }

    AsyncFunction("getVersion") { () -> [String: Any] in
      staticCall(pocket_anydoc_version)
    }

    AsyncFunction("prepareDocument") { (request: [String: Any], promise: Promise) in
      enqueueHeavy(.prepare, request: request, promise: promise)
    }

    AsyncFunction("selectContext") { (request: [String: Any], promise: Promise) in
      enqueueHeavy(.selectContext, request: request, promise: promise)
    }

    AsyncFunction("materializeAsset") { (request: [String: Any], promise: Promise) in
      enqueueHeavy(.materializeAsset, request: request, promise: promise)
    }

    AsyncFunction("cancel") { (requestId: String) -> [String: Any] in
      cancelDirect(requestId)
    }

    AsyncFunction("release") { (handle: String) -> [String: Any] in
      releaseDirect(handle)
    }

    OnDestroy {
      close()
    }
  }

  private func installMemoryObserver() {
    stateLock.lock()
    defer { stateLock.unlock() }
    guard memoryObserver == nil else { return }
    memoryObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.didReceiveMemoryWarningNotification,
      object: nil,
      queue: nil
    ) { [weak self] _ in
      self?.handleMemoryPressure()
    }
  }

  private func staticCall(_ call: () -> PocketAnyDocBuffer) -> [String: Any] {
    stateLock.lock()
    let unavailable = destroyed
    stateLock.unlock()
    if unavailable {
      return errorEnvelope("module_destroyed", "The document module is no longer available.", retryable: true)
    }
    do {
      return try decodeEnvelope(consume(call()))
    } catch {
      return requestFailure(error)
    }
  }

  private func enqueueHeavy(_ operation: HeavyOperation, request: [String: Any], promise: Promise) {
    let requestId: String
    do {
      requestId = try requiredIdentifier(request["requestId"], field: "requestId", maximum: maxRequestIdentifierCharacters)
    } catch {
      promise.resolve(requestFailure(error))
      return
    }

    stateLock.lock()
    if destroyed {
      stateLock.unlock()
      promise.resolve(errorEnvelope("module_destroyed", "The document module is no longer available.", retryable: true))
      return
    }
    if activeRequestIdentifiers.contains(requestId) {
      stateLock.unlock()
      promise.resolve(errorEnvelope("duplicate_request", "A request with this identifier is already active.", retryable: false))
      return
    }
    if activeRequestIdentifiers.count >= maxOutstandingHeavyJobs {
      stateLock.unlock()
      promise.resolve(errorEnvelope("resource_limit", "Too many document requests are pending.", retryable: true))
      return
    }
    activeRequestIdentifiers.insert(requestId)
    let submittedGeneration = generation
    let job = HeavyJob(
      operation: operation,
      request: request,
      requestId: requestId,
      submittedGeneration: submittedGeneration,
      promise: promise
    )
    pendingJobs[job.identifier] = job
    stateLock.unlock()

    workerQueue.async { [weak self] in
      guard let self else {
        promise.resolve([
          "ok": false,
          "error": ["code": "module_destroyed", "message": "The document module is no longer available.", "retryable": true],
        ])
        return
      }
      self.execute(job)
    }
  }

  private func execute(_ job: HeavyJob) {
    stateLock.lock()
    guard pendingJobs.removeValue(forKey: job.identifier) != nil else {
      stateLock.unlock()
      return
    }
    let invalidated: [String: Any]?
    if destroyed {
      invalidated = errorEnvelope("module_destroyed", "The document module is no longer available.", retryable: true)
    } else if cancelledRequestIdentifiers.contains(job.requestId) {
      invalidated = cancelledEnvelope()
    } else if generation != job.submittedGeneration {
      invalidated = staleEnvelope()
    } else {
      invalidated = nil
    }
    if invalidated != nil {
      activeRequestIdentifiers.remove(job.requestId)
      cancelledRequestIdentifiers.remove(job.requestId)
    }
    stateLock.unlock()

    if let invalidated {
      job.promise.resolve(invalidated)
      return
    }

    defer { cleanupRequest(job.requestId) }
    do {
      let result: [String: Any]
      switch job.operation {
      case .prepare:
        result = try prepareOnWorker(
          job.request,
          requestId: job.requestId,
          submittedGeneration: job.submittedGeneration
        )
      case .selectContext:
        result = try selectContextOnWorker(
          job.request,
          requestId: job.requestId,
          submittedGeneration: job.submittedGeneration
        )
      case .materializeAsset:
        result = try materializeAssetOnWorker(
          job.request,
          requestId: job.requestId,
          submittedGeneration: job.submittedGeneration
        )
      }
      job.promise.resolve(result)
    } catch let invalidated as JobInvalidated {
      job.promise.resolve(invalidated.envelope)
    } catch {
      job.promise.resolve(requestFailure(error))
    }
  }

  private func prepareOnWorker(
    _ request: [String: Any],
    requestId: String,
    submittedGeneration: UInt64
  ) throws -> [String: Any] {
    let source = try validatePrivateAttachment(request["localUri"])
    let declaredSize = try requiredBoundedInteger(
      request["sourceSizeBytes"],
      field: "sourceSizeBytes",
      minimum: 0,
      maximum: Int(maxSourceBytes)
    )
    guard Int64(declaredSize) == source.identity.size else {
      throw RequestFailure(code: "source_size_mismatch", message: "The source file size changed before parsing.")
    }
    var payload = try boundedJSONObject(request)
    payload["schemaVersion"] = 1
    payload["sourcePath"] = source.fileURL.path
    payload["privateRoot"] = source.rootURL.path
    payload["sourceIdentity"] = source.identity.json
    payload.removeValue(forKey: "localUri")
    let bytes = try encode(payload)
    let response = try engineGate.withEngine(create: true) { engine in
      if let invalidated = currentInvalidationEnvelope(
        requestId: requestId,
        submittedGeneration: submittedGeneration
      ) {
        throw JobInvalidated(envelope: invalidated)
      }
      return try invoke(bytes) { pointer, length in
        pocket_anydoc_prepare(engine, pointer, length)
      }
    }

    let currentIdentity = try? validatePrivateAttachment(source.fileURL.path).identity
    if currentIdentity != source.identity {
      releaseReturnedHandle(response, reason: "source_changed")
      return errorEnvelope("source_changed", "The source file changed while it was being parsed.", retryable: true)
    }
    let result = finishHeavyResponse(response, requestId: requestId, submittedGeneration: submittedGeneration)
    rememberPreparedAssets(result)
    return result
  }

  private func selectContextOnWorker(
    _ request: [String: Any],
    requestId: String,
    submittedGeneration: UInt64
  ) throws -> [String: Any] {
    _ = try requiredIdentifier(request["handle"], field: "handle", maximum: maxHandleCharacters)
    _ = try requiredBoundedInteger(request["maxChars"], field: "maxChars", minimum: 1, maximum: maxSelectedCharacters)
    _ = try requiredBoundedInteger(request["maxChunks"], field: "maxChunks", minimum: 1, maximum: maxSelectedChunks)
    var payload = try boundedJSONObject(request)
    payload["schemaVersion"] = 1
    let bytes = try encode(payload)
    let response = try engineGate.withEngine(create: true) { engine in
      if let invalidated = currentInvalidationEnvelope(
        requestId: requestId,
        submittedGeneration: submittedGeneration
      ) {
        throw JobInvalidated(envelope: invalidated)
      }
      return try invoke(bytes) { pointer, length in
        pocket_anydoc_select_context(engine, pointer, length)
      }
    }
    return finishHeavyResponse(response, requestId: requestId, submittedGeneration: submittedGeneration)
  }

  private func materializeAssetOnWorker(
    _ request: [String: Any],
    requestId: String,
    submittedGeneration: UInt64
  ) throws -> [String: Any] {
    guard Set(request.keys) == materializeRequestKeys else {
      throw RequestFailure(code: "invalid_request", message: "The asset request contains unsupported fields.")
    }
    let handle = try requiredIdentifier(request["handle"], field: "handle", maximum: maxHandleCharacters)
    let assetId = try requiredBoundedInteger(
      request["assetId"],
      field: "assetId",
      minimum: 0,
      maximum: maxAssetIdentifier
    )
    stateLock.lock()
    let metadata = releasedAssetHandles.contains(handle) ? nil : assetMetadataByHandle[handle]?[assetId]
    stateLock.unlock()
    guard let metadata, let fileExtension = assetExtensions[metadata.mediaType] else {
      throw RequestFailure(code: "invalid_asset", message: "The requested asset is not available for this document.")
    }

    let rootURL = try createAssetCacheRoot()
    let destinationURL = try createUniqueAssetDestination(root: rootURL, fileExtension: fileExtension)
    let pending = OwnedAsset(handle: handle, requestId: requestId, fileURL: destinationURL)
    var retained = false
    stateLock.lock()
    pendingAssetDestinations[requestId] = pending
    stateLock.unlock()
    defer {
      stateLock.lock()
      if let current = pendingAssetDestinations[requestId], current == pending {
        pendingAssetDestinations.removeValue(forKey: requestId)
      }
      stateLock.unlock()
      if !retained {
        deleteOwnedFile(destinationURL)
      }
    }

    if let invalidated = currentInvalidationEnvelope(
      requestId: requestId,
      submittedGeneration: submittedGeneration
    ) {
      return invalidated
    }
    if isReleasedAssetHandle(handle) {
      return errorEnvelope("invalid_handle", "The document handle is no longer available.", retryable: false)
    }

    let bytes = try encode([
      "schemaVersion": 1,
      "requestId": requestId,
      "handle": handle,
      "assetId": assetId,
      "destinationPath": destinationURL.path,
      "privateRoot": rootURL.path,
    ])
    let response = try engineGate.withEngine(create: true) { engine in
      if let invalidated = currentInvalidationEnvelope(
        requestId: requestId,
        submittedGeneration: submittedGeneration
      ) {
        throw JobInvalidated(envelope: invalidated)
      }
      if isReleasedAssetHandle(handle) {
        throw JobInvalidated(
          envelope: errorEnvelope("invalid_handle", "The document handle is no longer available.", retryable: false)
        )
      }
      return try invoke(bytes) { pointer, length in
        pocket_anydoc_materialize_asset(engine, pointer, length)
      }
    }
    guard response["ok"] as? Bool == true else { return response }
    if let invalidated = currentInvalidationEnvelope(
      requestId: requestId,
      submittedGeneration: submittedGeneration
    ) {
      return invalidated
    }
    let sanitized: [String: Any]
    do {
      sanitized = try validateMaterializedAsset(
        response,
        expectedHandle: handle,
        expectedAssetId: assetId,
        expectedMetadata: metadata,
        rootURL: rootURL,
        destinationURL: destinationURL
      )
    } catch {
      if let invalidated = currentInvalidationEnvelope(
        requestId: requestId,
        submittedGeneration: submittedGeneration
      ) {
        return invalidated
      }
      if isReleasedAssetHandle(handle) {
        return errorEnvelope("invalid_handle", "The document handle is no longer available.", retryable: false)
      }
      throw error
    }

    let invalidated: [String: Any]?
    stateLock.lock()
    if destroyed {
      invalidated = errorEnvelope("module_destroyed", "The document module is no longer available.", retryable: true)
    } else if cancelledRequestIdentifiers.contains(requestId) {
      invalidated = cancelledEnvelope()
    } else if generation != submittedGeneration {
      invalidated = staleEnvelope()
    } else if releasedAssetHandles.contains(handle) {
      invalidated = errorEnvelope("invalid_handle", "The document handle is no longer available.", retryable: false)
    } else {
      pendingAssetDestinations.removeValue(forKey: requestId)
      ownedAssetsByHandle[handle, default: []].append(pending)
      retained = true
      invalidated = nil
    }
    stateLock.unlock()
    return invalidated ?? sanitized
  }

  private func finishHeavyResponse(
    _ response: [String: Any],
    requestId: String,
    submittedGeneration: UInt64
  ) -> [String: Any] {
    stateLock.lock()
    let cancelled = cancelledRequestIdentifiers.contains(requestId)
    let stale = destroyed || generation != submittedGeneration
    stateLock.unlock()
    if cancelled {
      releaseReturnedHandle(response, reason: "cancelled")
      return cancelledEnvelope()
    }
    if stale {
      releaseReturnedHandle(response, reason: "stale_result")
      return errorEnvelope("stale_result", "The result became stale before delivery.", retryable: true)
    }
    return response
  }

  private func currentInvalidationEnvelope(
    requestId: String,
    submittedGeneration: UInt64
  ) -> [String: Any]? {
    stateLock.lock()
    defer { stateLock.unlock() }
    if destroyed {
      return errorEnvelope("module_destroyed", "The document module is no longer available.", retryable: true)
    }
    if cancelledRequestIdentifiers.contains(requestId) {
      return cancelledEnvelope()
    }
    if generation != submittedGeneration {
      return staleEnvelope()
    }
    return nil
  }

  private func rememberPreparedAssets(_ response: [String: Any]) {
    guard
      response["ok"] as? Bool == true,
      let data = response["data"] as? [String: Any],
      let handle = data["handle"] as? String,
      isSafeIdentifier(handle, maximum: maxHandleCharacters)
    else { return }
    let assets = data["assets"] as? [Any] ?? []
    guard assets.count <= maxAssetDescriptors else { return }
    var metadata: [Int: AssetMetadata] = [:]
    for value in assets {
      guard
        let descriptor = value as? [String: Any],
        let id = try? requiredBoundedInteger(
          descriptor["id"],
          field: "assetId",
          minimum: 0,
          maximum: maxAssetIdentifier
        ),
        let mediaType = (descriptor["mediaType"] as? String)?.lowercased(),
        let byteLength = try? requiredBoundedInteger(
          descriptor["byteLength"],
          field: "byteLength",
          minimum: 1,
          maximum: maxAssetBytes
        ),
        let sha256 = descriptor["sha256"] as? String,
        isSha256(sha256),
        let width = try? requiredBoundedInteger(
          descriptor["width"],
          field: "width",
          minimum: 1,
          maximum: 16_384
        ),
        let height = try? requiredBoundedInteger(
          descriptor["height"],
          field: "height",
          minimum: 1,
          maximum: 16_384
        ),
        width * height <= 40_000_000,
        assetExtensions[mediaType] != nil,
        metadata[id] == nil
      else { return }
      metadata[id] = AssetMetadata(
        mediaType: mediaType,
        byteLength: byteLength,
        sha256: sha256,
        width: width,
        height: height
      )
    }

    var evicted: [URL] = []
    stateLock.lock()
    if assetMetadataByHandle[handle] == nil,
       assetMetadataByHandle.count >= maxTrackedHandles,
       let oldest = assetMetadataByHandle.keys.first {
      assetMetadataByHandle.removeValue(forKey: oldest)
      evicted = ownedAssetsByHandle.removeValue(forKey: oldest)?.map(\.fileURL) ?? []
    }
    assetMetadataByHandle[handle] = metadata
    releasedAssetHandles.remove(handle)
    stateLock.unlock()
    evicted.forEach(deleteOwnedFile)
  }

  private func createAssetCacheRoot() throws -> URL {
    guard let cacheURL = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else {
      throw RequestFailure(code: "asset_cache_unavailable", message: "Private asset cache storage is unavailable.")
    }
    let rawRoot = cacheURL.appendingPathComponent(assetDirectory, isDirectory: true).standardizedFileURL
    do {
      try FileManager.default.createDirectory(
        at: rawRoot,
        withIntermediateDirectories: true,
        attributes: [.posixPermissions: NSNumber(value: 0o700)]
      )
    } catch {
      throw RequestFailure(code: "asset_cache_unavailable", message: "Private asset cache storage is unavailable.")
    }
    var info = stat()
    guard
      lstat(rawRoot.path, &info) == 0,
      (info.st_mode & S_IFMT) == S_IFDIR,
      (info.st_mode & S_IFMT) != S_IFLNK
    else {
      throw RequestFailure(code: "asset_cache_unavailable", message: "Private asset cache storage is unavailable.")
    }
    let canonicalCache = cacheURL.resolvingSymlinksInPath().standardizedFileURL
    let canonicalRoot = rawRoot.resolvingSymlinksInPath().standardizedFileURL
    guard canonicalRoot.deletingLastPathComponent().path == canonicalCache.path else {
      throw RequestFailure(code: "asset_cache_unavailable", message: "Private asset cache storage is unavailable.")
    }
    do {
      try FileManager.default.setAttributes(
        [.posixPermissions: NSNumber(value: 0o700)],
        ofItemAtPath: canonicalRoot.path
      )
    } catch {
      throw RequestFailure(code: "asset_cache_unavailable", message: "Private asset cache storage is unavailable.")
    }
    return canonicalRoot
  }

  private func createUniqueAssetDestination(root: URL, fileExtension: String) throws -> URL {
    for _ in 0..<8 {
      let name = "\(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()).\(fileExtension)"
      let candidate = root.appendingPathComponent(name, isDirectory: false).standardizedFileURL
      if isOwnedAssetName(name), candidate.deletingLastPathComponent().path == root.path,
         !FileManager.default.fileExists(atPath: candidate.path) {
        return candidate
      }
    }
    throw RequestFailure(code: "asset_cache_unavailable", message: "A private asset cache destination could not be reserved.")
  }

  private func validateMaterializedAsset(
    _ response: [String: Any],
    expectedHandle: String,
    expectedAssetId: Int,
    expectedMetadata: AssetMetadata,
    rootURL: URL,
    destinationURL: URL
  ) throws -> [String: Any] {
    guard
      let data = response["data"] as? [String: Any],
      let returnedHandle = data["handle"] as? String,
      returnedHandle == expectedHandle
    else {
      throw RequestFailure(code: "invalid_native_response", message: "The native asset response is invalid.")
    }
    let assetId = try requiredBoundedInteger(
      data["assetId"],
      field: "assetId",
      minimum: 0,
      maximum: maxAssetIdentifier
    )
    let byteLength = try requiredBoundedInteger(
      data["byteLength"],
      field: "byteLength",
      minimum: 1,
      maximum: maxAssetBytes
    )
    let width = try requiredBoundedInteger(data["width"], field: "width", minimum: 1, maximum: 16_384)
    let height = try requiredBoundedInteger(data["height"], field: "height", minimum: 1, maximum: 16_384)
    guard
      assetId == expectedAssetId,
      let mediaType = data["mediaType"] as? String,
      mediaType == expectedMetadata.mediaType,
      let expectedSha256 = data["sha256"] as? String,
      isSha256(expectedSha256),
      byteLength == expectedMetadata.byteLength,
      expectedSha256 == expectedMetadata.sha256,
      width == expectedMetadata.width,
      height == expectedMetadata.height,
      width * height <= 40_000_000
    else {
      throw RequestFailure(code: "invalid_native_response", message: "The native asset response is invalid.")
    }
    let canonicalDestination = destinationURL.resolvingSymlinksInPath().standardizedFileURL
    guard
      canonicalDestination.deletingLastPathComponent().path == rootURL.path,
      isOwnedAssetName(canonicalDestination.lastPathComponent)
    else {
      throw RequestFailure(code: "invalid_native_response", message: "The native asset destination is invalid.")
    }
    let digest = try sha256Hex(
      fileURL: destinationURL,
      expectedByteLength: byteLength
    )
    guard digest == expectedSha256 else {
      throw RequestFailure(code: "invalid_native_response", message: "The materialized asset digest is invalid.")
    }
    return [
      "ok": true,
      "data": [
        "assetId": assetId,
        "mediaType": mediaType,
        "byteLength": byteLength,
        "sha256": expectedSha256,
        "width": width,
        "height": height,
        "localUri": canonicalDestination.absoluteString,
      ],
    ]
  }

  private func sha256Hex(fileURL: URL, expectedByteLength: Int) throws -> String {
    let descriptor = Darwin.open(fileURL.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
    guard descriptor >= 0 else {
      throw RequestFailure(code: "invalid_native_response", message: "The materialized asset file is invalid.")
    }
    defer { Darwin.close(descriptor) }
    var info = stat()
    guard
      fstat(descriptor, &info) == 0,
      (info.st_mode & S_IFMT) == S_IFREG,
      info.st_size == Int64(expectedByteLength),
      info.st_size > 0,
      info.st_size <= Int64(maxAssetBytes),
      (info.st_mode & 0o077) == 0
    else {
      throw RequestFailure(code: "invalid_native_response", message: "The materialized asset file is invalid.")
    }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: false)
    let contents: Data
    do {
      contents = try handle.readToEnd() ?? Data()
    } catch {
      throw RequestFailure(code: "invalid_native_response", message: "The materialized asset file is unreadable.")
    }
    guard contents.count == expectedByteLength else {
      throw RequestFailure(code: "invalid_native_response", message: "The materialized asset file changed before delivery.")
    }
    return SHA256.hash(data: contents).map { String(format: "%02x", $0) }.joined()
  }

  private func isSha256(_ value: String) -> Bool {
    value.count == 64 && value.unicodeScalars.allSatisfy {
      ($0.value >= 48 && $0.value <= 57) || ($0.value >= 97 && $0.value <= 102)
    }
  }

  private func isOwnedAssetName(_ value: String) -> Bool {
    let components = value.split(separator: ".", omittingEmptySubsequences: false)
    guard components.count == 2, components[0].count == 32,
          ["png", "jpg", "gif", "webp"].contains(String(components[1])) else { return false }
    return components[0].unicodeScalars.allSatisfy {
      ($0.value >= 48 && $0.value <= 57) || ($0.value >= 97 && $0.value <= 102)
    }
  }

  private func isReleasedAssetHandle(_ handle: String) -> Bool {
    stateLock.lock()
    defer { stateLock.unlock() }
    return releasedAssetHandles.contains(handle)
  }

  private func deleteOwnedFile(_ fileURL: URL) {
    guard let cacheURL = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else { return }
    let rawRoot = cacheURL.appendingPathComponent(assetDirectory, isDirectory: true).standardizedFileURL
    let canonicalRoot = rawRoot.resolvingSymlinksInPath().standardizedFileURL
    let candidate = fileURL.standardizedFileURL
    guard
      candidate.deletingLastPathComponent().path == canonicalRoot.path,
      isOwnedAssetName(candidate.lastPathComponent)
    else { return }
    try? FileManager.default.removeItem(at: candidate)
  }

  private func cleanupAssets(forRequestId requestId: String) {
    var files: [URL] = []
    stateLock.lock()
    if let pending = pendingAssetDestinations.removeValue(forKey: requestId) {
      files.append(pending.fileURL)
    }
    for handle in Array(ownedAssetsByHandle.keys) {
      let assets = ownedAssetsByHandle[handle] ?? []
      files.append(contentsOf: assets.filter { $0.requestId == requestId }.map(\.fileURL))
      ownedAssetsByHandle[handle] = assets.filter { $0.requestId != requestId }
    }
    stateLock.unlock()
    Set(files).forEach(deleteOwnedFile)
  }

  private func cleanupAssets(forHandle handle: String) {
    var files: [URL] = []
    stateLock.lock()
    assetMetadataByHandle.removeValue(forKey: handle)
    let pendingRequestIds = pendingAssetDestinations.compactMap { requestId, pending in
      pending.handle == handle ? requestId : nil
    }
    for requestId in pendingRequestIds {
      if let pending = pendingAssetDestinations.removeValue(forKey: requestId) {
        files.append(pending.fileURL)
      }
    }
    files.append(contentsOf: ownedAssetsByHandle.removeValue(forKey: handle)?.map(\.fileURL) ?? [])
    stateLock.unlock()
    Set(files).forEach(deleteOwnedFile)
  }

  private func cleanupAllAssets() {
    stateLock.lock()
    let files = pendingAssetDestinations.values.map(\.fileURL)
      + ownedAssetsByHandle.values.flatMap { $0.map(\.fileURL) }
    pendingAssetDestinations.removeAll(keepingCapacity: true)
    ownedAssetsByHandle.removeAll(keepingCapacity: true)
    assetMetadataByHandle.removeAll(keepingCapacity: true)
    stateLock.unlock()
    Set(files).forEach(deleteOwnedFile)
  }

  private func cancelDirect(_ value: String) -> [String: Any] {
    do {
      let requestId = try requiredIdentifier(value, field: "requestId", maximum: maxRequestIdentifierCharacters)
      stateLock.lock()
      let active = activeRequestIdentifiers.contains(requestId)
      if active {
        cancelledRequestIdentifiers.insert(requestId)
      }
      stateLock.unlock()
      defer { cleanupAssets(forRequestId: requestId) }
      let bytes = try encode(["schemaVersion": 1, "requestId": requestId])
      if let result = try engineGate.withExistingEngine({ engine in
        try invoke(bytes) { pointer, length in
          pocket_anydoc_cancel(engine, pointer, length)
        }
      }) {
        return result
      }
      return ["ok": true, "data": ["cancelledCount": active ? 1 : 0]]
    } catch {
      return requestFailure(error)
    }
  }

  private func releaseDirect(_ value: String) -> [String: Any] {
    do {
      let handle = try requiredIdentifier(value, field: "handle", maximum: maxHandleCharacters)
      stateLock.lock()
      releasedAssetHandles.insert(handle)
      if releasedAssetHandles.count > maxTrackedHandles * 4, let first = releasedAssetHandles.first {
        releasedAssetHandles.remove(first)
      }
      stateLock.unlock()
      defer { cleanupAssets(forHandle: handle) }
      let bytes = try encode(["schemaVersion": 1, "handle": handle])
      if let result = try engineGate.withExistingEngine({ engine in
        try invoke(bytes) { pointer, length in
          pocket_anydoc_release(engine, pointer, length)
        }
      }) {
        return result
      }
      return ["ok": true, "data": ["releasedCount": 0]]
    } catch {
      return requestFailure(error)
    }
  }

  private func releaseReturnedHandle(_ response: [String: Any], reason: String) {
    guard
      let data = response["data"] as? [String: Any],
      let handle = data["handle"] as? String,
      isSafeIdentifier(handle, maximum: maxHandleCharacters),
      let request = try? encode(["schemaVersion": 1, "handle": handle, "reason": reason])
    else { return }
    _ = try? engineGate.withExistingEngine { engine in
      try invokeAndDiscard(request) { pointer, length in
        pocket_anydoc_release(engine, pointer, length)
      }
    }
  }

  private func handleMemoryPressure() {
    stateLock.lock()
    guard !destroyed else {
      stateLock.unlock()
      return
    }
    generation &+= 1
    let pending = drainPendingJobsLocked()
    let shouldRetire = engineGate.requestRetirement()
    stateLock.unlock()
    scheduleRetirement(if: shouldRetire)
    pending.forEach { $0.promise.resolve(staleEnvelope()) }
    cancelAllAndReleaseCached(reason: "memory_pressure")
    cleanupAllAssets()
  }

  private func cancelAllAndReleaseCached(reason: String) {
    guard
      let cancelRequest = try? encode(["schemaVersion": 1, "scope": "all", "reason": reason]),
      let releaseRequest = try? encode(["schemaVersion": 1, "scope": "all_cached", "reason": reason])
    else { return }
    _ = try? engineGate.withExistingEngine { engine in
      try invokeAndDiscard(cancelRequest) { pointer, length in
        pocket_anydoc_cancel(engine, pointer, length)
      }
    }
    _ = try? engineGate.withExistingEngine { engine in
      try invokeAndDiscard(releaseRequest) { pointer, length in
        pocket_anydoc_release(engine, pointer, length)
      }
    }
  }

  private func close() {
    stateLock.lock()
    guard !destroyed else {
      stateLock.unlock()
      return
    }
    destroyed = true
    generation &+= 1
    let pending = drainPendingJobsLocked()
    let shouldRetire = engineGate.requestRetirement()
    let observer = memoryObserver
    memoryObserver = nil
    stateLock.unlock()
    scheduleRetirement(if: shouldRetire)
    pending.forEach {
      $0.promise.resolve(errorEnvelope("module_destroyed", "The document module is no longer available.", retryable: true))
    }
    if let observer {
      NotificationCenter.default.removeObserver(observer)
    }
    cancelAllAndReleaseCached(reason: "module_destroyed")
    cleanupAllAssets()
  }

  private func cleanupRequest(_ requestId: String) {
    stateLock.lock()
    activeRequestIdentifiers.remove(requestId)
    cancelledRequestIdentifiers.remove(requestId)
    stateLock.unlock()
  }

  private func drainPendingJobsLocked() -> [HeavyJob] {
    let jobs = Array(pendingJobs.values)
    pendingJobs.removeAll(keepingCapacity: true)
    for job in jobs {
      activeRequestIdentifiers.remove(job.requestId)
      cancelledRequestIdentifiers.remove(job.requestId)
    }
    return jobs
  }

  private func scheduleRetirement(if requested: Bool) {
    guard requested else { return }
    retirementQueue.async { [engineGate] in
      engineGate.retireRequested()
    }
  }

  private func staleEnvelope() -> [String: Any] {
    errorEnvelope("stale_result", "The result became stale before delivery.", retryable: true)
  }

  private func validatePrivateAttachment(_ value: Any?) throws -> ValidatedSource {
    guard let sourcePath = value as? String, !sourcePath.isEmpty, !sourcePath.contains("\0") else {
      throw RequestFailure(code: "invalid_source_path", message: "sourcePath must be a local file path.")
    }
    let sourceURL: URL
    if let parsed = URL(string: sourcePath), parsed.scheme != nil {
      guard parsed.isFileURL else {
        throw RequestFailure(code: "unsupported_source_uri", message: "The source must be copied into private app storage first.")
      }
      sourceURL = parsed
    } else {
      sourceURL = URL(fileURLWithPath: sourcePath)
    }
    if sourceURL.pathComponents.contains("..") || sourceURL.pathComponents.contains(".") {
      throw RequestFailure(code: "unsafe_source_path", message: "The source path is not allowed.")
    }

    guard let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else {
      throw RequestFailure(code: "attachment_root_unavailable", message: "Private attachment storage is unavailable.")
    }
    let rawRoot = documents.appendingPathComponent(attachmentDirectory, isDirectory: true).standardizedFileURL
    let rawCandidate = sourceURL.standardizedFileURL
    guard rawCandidate.path.hasPrefix(rawRoot.path + "/") else {
      throw RequestFailure(code: "source_outside_private_root", message: "The source is outside private attachment storage.")
    }
    try rejectSymlinks(root: rawRoot, candidate: rawCandidate)

    let canonicalRoot = rawRoot.resolvingSymlinksInPath().standardizedFileURL
    let canonicalCandidate = rawCandidate.resolvingSymlinksInPath().standardizedFileURL
    guard canonicalCandidate.path.hasPrefix(canonicalRoot.path + "/") else {
      throw RequestFailure(code: "source_outside_private_root", message: "The source is outside private attachment storage.")
    }

    let descriptor = Darwin.open(canonicalCandidate.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
    guard descriptor >= 0 else {
      throw RequestFailure(code: "source_unreadable", message: "The source file cannot be read.")
    }
    defer { Darwin.close(descriptor) }
    var info = stat()
    guard fstat(descriptor, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else {
      throw RequestFailure(code: "source_not_file", message: "The source must be a regular file.")
    }
    guard info.st_size >= 0, info.st_size <= maxSourceBytes else {
      throw RequestFailure(code: "source_too_large", message: "The source exceeds the mobile document limit.")
    }
    return ValidatedSource(
      fileURL: canonicalCandidate,
      rootURL: canonicalRoot,
      identity: FileIdentity(
        device: UInt64(info.st_dev),
        inode: UInt64(info.st_ino),
        size: Int64(info.st_size),
        modifiedSeconds: Int64(info.st_mtimespec.tv_sec),
        modifiedNanoseconds: Int64(info.st_mtimespec.tv_nsec)
      )
    )
  }

  private func rejectSymlinks(root: URL, candidate: URL) throws {
    let relative = String(candidate.path.dropFirst(root.path.count)).split(separator: "/")
    var rootInfo = stat()
    guard lstat(root.path, &rootInfo) == 0 else {
      throw RequestFailure(code: "attachment_root_unavailable", message: "Private attachment storage is unavailable.")
    }
    if (rootInfo.st_mode & S_IFMT) == S_IFLNK {
      throw RequestFailure(code: "symlink_source_rejected", message: "Symlinked attachment paths are not allowed.")
    }
    var current = root
    for component in relative {
      current.appendPathComponent(String(component))
      var info = stat()
      guard lstat(current.path, &info) == 0 else {
        throw RequestFailure(code: "source_missing", message: "The source file no longer exists.")
      }
      if (info.st_mode & S_IFMT) == S_IFLNK {
        throw RequestFailure(code: "symlink_source_rejected", message: "Symlinked attachment paths are not allowed.")
      }
    }
  }

  private func boundedJSONObject(_ request: [String: Any]) throws -> [String: Any] {
    var nodes = 0
    guard let result = try normalizeJSON(request, depth: 0, nodes: &nodes) as? [String: Any] else {
      throw RequestFailure(code: "invalid_request", message: "The request must be an object.")
    }
    _ = try encode(result)
    return result
  }

  private func normalizeJSON(_ value: Any, depth: Int, nodes: inout Int) throws -> Any {
    nodes += 1
    if depth > maxRequestDepth || nodes > maxRequestNodes {
      throw RequestFailure(code: "request_too_complex", message: "The request object is too complex.")
    }
    switch value {
    case is NSNull:
      return NSNull()
    case let string as String:
      guard string.utf16.count <= maxStringCharacters, !string.contains("\0") else {
        throw RequestFailure(code: "request_value_too_large", message: "A request string exceeds the bridge limit.")
      }
      return string
    case let number as NSNumber:
      guard number.doubleValue.isFinite else {
        throw RequestFailure(code: "invalid_number", message: "Request numbers must be finite.")
      }
      return number
    case let dictionary as [String: Any]:
      var result: [String: Any] = [:]
      for key in dictionary.keys.sorted() {
        guard key.utf16.count <= 128 else {
          throw RequestFailure(code: "invalid_request_key", message: "A request key is too long.")
        }
        result[key] = try normalizeJSON(dictionary[key] ?? NSNull(), depth: depth + 1, nodes: &nodes)
      }
      return result
    case let array as [Any]:
      guard array.count <= 128 else {
        throw RequestFailure(code: "request_array_too_large", message: "A request array is too large.")
      }
      return try array.map { try normalizeJSON($0, depth: depth + 1, nodes: &nodes) }
    default:
      throw RequestFailure(code: "invalid_request_value", message: "The request contains an unsupported value.")
    }
  }

  private func encode(_ object: [String: Any]) throws -> Data {
    guard JSONSerialization.isValidJSONObject(object) else {
      throw RequestFailure(code: "invalid_request", message: "The request is not valid JSON.")
    }
    let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    guard data.count <= maxRequestBytes else {
      throw RequestFailure(code: "request_too_large", message: "The request exceeds the native bridge limit.")
    }
    return data
  }

  private func consume(_ buffer: PocketAnyDocBuffer) throws -> Data {
    defer { pocket_anydoc_buffer_free(buffer) }
    guard let pointer = buffer.ptr, buffer.len > 0, buffer.len <= UInt(maxResponseBytes) else {
      throw RequestFailure(code: "invalid_native_response", message: "The native response is invalid.")
    }
    return Data(bytes: pointer, count: Int(buffer.len))
  }

  private func decodeEnvelope(_ data: Data) throws -> [String: Any] {
    guard data.count <= maxResponseBytes else {
      throw RequestFailure(code: "invalid_native_response", message: "The native response is invalid.")
    }
    let value = try JSONSerialization.jsonObject(with: data)
    guard let object = value as? [String: Any], object["ok"] is Bool else {
      throw RequestFailure(code: "invalid_native_response", message: "The native response envelope is invalid.")
    }
    return object
  }

  private func invoke(
    _ data: Data,
    _ call: (UnsafePointer<UInt8>?, UInt) -> PocketAnyDocBuffer
  ) throws -> [String: Any] {
    let buffer = data.withUnsafeBytes { rawBuffer in
      call(rawBuffer.bindMemory(to: UInt8.self).baseAddress, UInt(rawBuffer.count))
    }
    return try decodeEnvelope(consume(buffer))
  }

  private func invokeAndDiscard(
    _ data: Data,
    _ call: (UnsafePointer<UInt8>?, UInt) -> PocketAnyDocBuffer
  ) throws {
    let buffer = data.withUnsafeBytes { rawBuffer in
      call(rawBuffer.bindMemory(to: UInt8.self).baseAddress, UInt(rawBuffer.count))
    }
    _ = try consume(buffer)
  }

  private func requiredIdentifier(_ value: Any?, field: String, maximum: Int) throws -> String {
    guard let identifier = value as? String, isSafeIdentifier(identifier, maximum: maximum) else {
      throw RequestFailure(code: "invalid_\(field)", message: "\(field) is invalid.")
    }
    return identifier
  }

  private func isSafeIdentifier(_ value: String, maximum: Int) -> Bool {
    guard !value.isEmpty, value.utf16.count <= maximum else { return false }
    return value.unicodeScalars.allSatisfy { scalar in
      CharacterSet.alphanumerics.contains(scalar) || "._:-".unicodeScalars.contains(scalar)
    }
  }

  private func requiredBoundedInteger(_ value: Any?, field: String, minimum: Int, maximum: Int) throws -> Int {
    guard
      let number = value as? NSNumber,
      CFGetTypeID(number) != CFBooleanGetTypeID()
    else {
      throw RequestFailure(code: "invalid_\(field)", message: "\(field) must be an integer.")
    }
    let numeric = number.doubleValue
    guard numeric.isFinite, numeric.rounded() == numeric, numeric >= Double(minimum), numeric <= Double(maximum) else {
      throw RequestFailure(code: "invalid_\(field)", message: "\(field) is outside the supported range.")
    }
    return Int(numeric)
  }

  private func cancelledEnvelope() -> [String: Any] {
    errorEnvelope("conversion_cancelled", "Document processing was cancelled.", retryable: true)
  }

  private func requestFailure(_ error: Error) -> [String: Any] {
    if let failure = error as? RequestFailure {
      return errorEnvelope(failure.code, failure.message, retryable: false)
    }
    return errorEnvelope("native_bridge_failed", "The native document bridge failed.", retryable: true)
  }

  private func errorEnvelope(_ code: String, _ message: String, retryable: Bool) -> [String: Any] {
    [
      "ok": false,
      "error": [
        "code": code,
        "message": message,
        "retryable": retryable,
      ],
    ]
  }
}
