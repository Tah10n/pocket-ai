import ExpoModulesCore
import Foundation

public final class PocketPhonemizerModule: Module {
  private let worker = DispatchQueue(label: "PocketPhonemizer.platform", qos: .userInitiated)
  private let lock = NSLock()
  private var owner: UInt64 = 0
  private var busy = false
  private var closing = false
  private var destroyed = false
  private func failure(_ code: String) -> [String: Any] {
    ["raw": [String](), "initMs": 0, "conversionMs": 0, "calls": 0, "offThread": false, "error": code]
  }
  private func operation(_ promise: Promise, request: String? = nil, work: @escaping (UInt64) -> [String: Any]) {
    lock.lock(); defer { lock.unlock() }
    if destroyed || closing { promise.resolve(failure("disposed")); return }
    if busy { promise.resolve(failure("busy")); return }
    if owner == 0 { owner = PocketPhonemizerBridge.openOwner() }
    if owner == 0 { promise.resolve(failure("busy")); return }
    let token = owner
    if let request {
      let error = PocketPhonemizerBridge.reserve(token, requestId: request)
      if !error.isEmpty { promise.resolve(failure(error)); return }
    }
    busy = true
    worker.async {
      let result = work(token)
      if result["error"] as? String == "native_failure" {
        PocketPhonemizerBridge.invalidate(token); PocketPhonemizerBridge.dispose(token)
        self.lock.lock(); if self.owner == token { self.owner = 0 }; self.lock.unlock()
      }
      self.lock.lock(); self.busy = false; self.lock.unlock()
      promise.resolve(result)
    }
  }
  private func release(_ promise: Promise?, destroy: Bool) {
    lock.lock(); defer { lock.unlock() }
    if destroyed { promise?.resolve(nil); return }
    if destroy { destroyed = true }
    if closing { promise?.reject("busy", "Phonemizer disposal is already draining"); return }
    closing = true; let token = owner
    if token != 0 { PocketPhonemizerBridge.invalidate(token) }
    // Admission permits one operation plus this one terminal drain; no unbounded queue.
    worker.async {
      if token != 0 { PocketPhonemizerBridge.dispose(token) }
      self.lock.lock(); self.owner = 0; self.closing = false; self.lock.unlock()
      promise?.resolve(nil)
    }
  }
  public func definition() -> ModuleDefinition {
    Name("PocketPhonemizer")
    AsyncFunction("initialize") { (promise: Promise) in
      self.operation(promise) { token in
        let begin = ProcessInfo.processInfo.systemUptime
        do {
          let path = try PhonemizerData.verifiedPath()
          var result = PocketPhonemizerBridge.initialize(token, dataPath: path)
          result["initMs"] = (ProcessInfo.processInfo.systemUptime - begin) * 1000
          return result
        } catch { return self.failure("data_invalid") }
      }
    }
    AsyncFunction("convert") { (requestId: String, chunks: [String], promise: Promise) in
      guard requestId.range(of: "^[A-Za-z0-9_-]{1,64}$", options: .regularExpression) != nil else {
        promise.resolve(self.failure("invalid_request")); return
      }
      let count = chunks.reduce(0) { $0 + $1.utf16.count }
      guard !chunks.isEmpty, chunks.count <= 240, count > 0, count <= 240 else {
        promise.resolve(self.failure("input_limit")); return
      }
      self.operation(promise, request: requestId) { token in
        PocketPhonemizerBridge.convert(token, requestId: requestId, chunks: chunks)
      }
    }
    AsyncFunction("cancel") { (requestId: String) in
      self.lock.lock(); defer { self.lock.unlock() }
      if self.owner != 0 { PocketPhonemizerBridge.cancel(self.owner, requestId: requestId) }
    }
    AsyncFunction("dispose") { (promise: Promise) in self.release(promise, destroy: false) }
    OnDestroy { self.release(nil, destroy: true) }
  }
}
