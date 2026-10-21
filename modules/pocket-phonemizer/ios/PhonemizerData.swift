import Foundation
import CryptoKit

internal enum PhonemizerData {
  private struct Manifest: Decodable { let schemaVersion: Int; let files: [Entry] }
  private struct Entry: Decodable { let path: String; let bytes: Int; let sha256: String }
  private struct Invalid: Error {}
  private static func check(_ condition: Bool) throws { if !condition { throw Invalid() } }
  private static func safe(_ url: URL) throws {
    try check(url.resolvingSymlinksInPath().standardizedFileURL.path == url.standardizedFileURL.path)
    let values = try url.resourceValues(forKeys: [.isSymbolicLinkKey]); try check(values.isSymbolicLink == false)
  }
  static func verifiedPath() throws -> String {
    let ownerBundle = Bundle(for: PocketPhonemizerBridge.self)
    guard let url = ownerBundle.url(forResource: "PocketPhonemizerData", withExtension: "bundle") ?? Bundle.main.url(forResource: "PocketPhonemizerData", withExtension: "bundle"),
      let bundle = Bundle(url: url), let base = bundle.resourceURL else { throw Invalid() }
    let canonical = base.resolvingSymlinksInPath().standardizedFileURL
    let manifestURL = canonical.appendingPathComponent("data-manifest.json"); try safe(manifestURL)
    let attributes = try FileManager.default.attributesOfItem(atPath: manifestURL.path)
    try check(((attributes[.size] as? NSNumber)?.intValue ?? Int.max) <= 512 * 1024)
    let bytes = try Data(contentsOf: manifestURL)
    let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    try check(digest == PocketPhonemizerBridge.manifestSha())
    let manifest = try JSONDecoder().decode(Manifest.self, from: bytes)
    try check(manifest.schemaVersion == 1 && !manifest.files.isEmpty && manifest.files.count <= 4096)
    var expected: [String: Entry] = [:]; var total = 0
    for entry in manifest.files {
      try check(entry.path.count <= 240 && !entry.path.isEmpty && entry.path.split(separator: "/", omittingEmptySubsequences: false).allSatisfy {
        !$0.isEmpty && $0 != "." && $0 != ".." && $0.range(of: "^[A-Za-z0-9_+.! -]+$", options: .regularExpression) != nil
      })
      try check(entry.bytes >= 0 && entry.bytes <= 32 * 1024 * 1024 && entry.sha256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil)
      try check(expected[entry.path] == nil); expected[entry.path] = entry; total += entry.bytes
    }
    try check(total <= 64 * 1024 * 1024)
    let root = canonical.appendingPathComponent("espeak-ng-data", isDirectory: true); try safe(root)
    guard let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey], options: [], errorHandler: { _, _ in false }) else { throw Invalid() }
    var seen = Set<String>(); var nodes = 0
    while let file = enumerator.nextObject() as? URL {
      nodes += 1; try check(nodes <= 8192); try safe(file)
      let path = String(file.path.dropFirst(root.path.count + 1))
      let values = try file.resourceValues(forKeys: [.isDirectoryKey, .isRegularFileKey])
      if values.isDirectory == true { try check(expected.keys.contains { $0.hasPrefix(path + "/") }); continue }
      try check(values.isRegularFile == true)
      guard let entry = expected[path], let stream = InputStream(url: file) else { throw Invalid() }
      try check(seen.insert(path).inserted)
      stream.open(); defer { stream.close() }; var hash = SHA256(); var count = 0; var buffer = [UInt8](repeating: 0, count: 65536)
      while true {
        let read = stream.read(&buffer, maxLength: buffer.count); try check(read >= 0); if read == 0 { break }
        count += read; try check(count <= entry.bytes); hash.update(data: Data(buffer.prefix(read)))
      }
      try check(count == entry.bytes && hash.finalize().map { String(format: "%02x", $0) }.joined() == entry.sha256)
    }
    try check(seen == Set(expected.keys)); return root.path
  }
}
