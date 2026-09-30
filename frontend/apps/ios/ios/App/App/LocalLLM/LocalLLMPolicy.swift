import Foundation

/// Errors the plugin raises for a request it refuses up front. Each message is what the user ends
/// up reading, so they say what to do about it rather than what failed internally.
enum LocalLLMError: Error, LocalizedError, Equatable {
  case insufficientMemory(modelId: String, requiredBytes: UInt64, deviceBytes: UInt64)
  case insufficientDisk(requiredBytes: Int64, availableBytes: Int64)
  case downloadURLRejected(String)
  case imageInputUnsupported(modelId: String?)

  var errorDescription: String? {
    switch self {
    case .insufficientMemory(let modelId, let required, let device):
      return
        "\(modelId) needs at least \(Self.gigabytes(required)) of memory; this device has \(Self.gigabytes(device))."
    case .insufficientDisk(let required, let available):
      return
        "Not enough free space for the model: it needs \(Self.gigabytes(UInt64(max(required, 0)))) free, and \(Self.gigabytes(UInt64(max(available, 0)))) is available."
    case .downloadURLRejected(let reason):
      return "Refusing to download from that URL: \(reason)"
    case .imageInputUnsupported(let modelId):
      return "Image input is not supported by \(modelId ?? "the on-device model") on iOS"
    }
  }

  private static func gigabytes(_ bytes: UInt64) -> String {
    String(format: "%.1f GB", Double(bytes) / 1_073_741_824)
  }
}

/// The decisions the plugin makes before it touches the network, the disk or the engine — pulled out
/// as pure functions so they are checked without a device, a model or a filesystem.
enum LocalLLMPolicy {
  /// Slack kept free on top of the bytes a download still needs, so filling the volume to the last
  /// byte does not take the rest of the app (SQLite, the WebView cache) down with it.
  static let diskHeadroomBytes: Int64 = 512 * 1024 * 1024

  // MARK: Storage

  /// Free space a download needs before it starts: what is still to fetch, plus ``diskHeadroomBytes``.
  /// Bytes already on disk (a resumable `.part`) are not needed again.
  static func requiredFreeDiskBytes(sizeBytes: Int64, bytesAlreadyOnDisk: Int64) -> Int64 {
    max(sizeBytes - max(bytesAlreadyOnDisk, 0), 0) + diskHeadroomBytes
  }

  /// `true` when a download may start. An unreadable volume (`nil`) is allowed through: refusing on
  /// "unknown" would lock out a device whose only fault is a missing capacity key.
  static func hasEnoughDisk(freeBytes: Int64?, sizeBytes: Int64, bytesAlreadyOnDisk: Int64) -> Bool {
    guard let freeBytes else { return true }

    return freeBytes >= requiredFreeDiskBytes(sizeBytes: sizeBytes, bytesAlreadyOnDisk: bytesAlreadyOnDisk)
  }

  // MARK: Memory

  /// `true` when the device has at least the model's floor. `minDeviceMemoryBytes` is compared with
  /// `ProcessInfo.physicalMemory`, which is the RAM the OS reports, not the marketing figure.
  static func meetsMemoryFloor(physicalMemory: UInt64, minDeviceMemoryBytes: UInt64) -> Bool {
    physicalMemory >= minDeviceMemoryBytes
  }

  /// `true` when the device can run at least the smallest model in `catalog` — `isAvailable`'s
  /// definition of "available". It is a capability probe, not a promise about disk or downloads.
  static func deviceCanRunAnyModel(physicalMemory: UInt64, catalog: [LocalLLMModelInfo]) -> Bool {
    guard let smallestFloor = catalog.map(\.minDeviceMemoryBytes).min() else { return false }

    return meetsMemoryFloor(physicalMemory: physicalMemory, minDeviceMemoryBytes: smallestFloor)
  }

  // MARK: Downloads

  /// Checks a caller-supplied download URL against the catalog's pinned one and refuses anything
  /// else. The plugin never downloads from the caller's URL — it always fetches `pinned` — so this
  /// exists only to tell a caller that thinks it is downloading something else that it is not.
  ///
  /// Scheme, host and path must match **exactly**; the query (`?download=true`) and fragment are
  /// ignored. A host allow-list alone is not enough: `huggingface.co` also serves any file anyone
  /// uploads, and size is the only other check the download gets, so a URL like
  /// `huggingface.co/attacker/repo/resolve/main/…` padded to the pinned size would otherwise be
  /// promoted as the "pinned" model. Compared on the parsed components, so `huggingface.co@evil.example`
  /// and `huggingface.co.evil.example` name other hosts and fail.
  static func verifyDownloadURL(_ raw: String, isPinnedURL pinned: URL, modelId: String) throws {
    guard let given = URLComponents(string: raw), given.url != nil,
      let expected = URLComponents(url: pinned, resolvingAgainstBaseURL: false)
    else {
      throw LocalLLMError.downloadURLRejected("it is not a valid URL")
    }
    guard given.scheme?.lowercased() == "https" else {
      throw LocalLLMError.downloadURLRejected("it must use https")
    }
    guard given.user == nil, given.password == nil else {
      throw LocalLLMError.downloadURLRejected("it must not carry credentials")
    }
    guard given.port == nil || given.port == 443 else {
      throw LocalLLMError.downloadURLRejected("it must use the default https port")
    }
    guard
      given.host?.lowercased() == expected.host?.lowercased(),
      given.percentEncodedPath == expected.percentEncodedPath
    else {
      throw LocalLLMError.downloadURLRejected(
        "it is not the pinned download for \(modelId); models are only fetched from the catalog's own commit-pinned URL")
    }
  }

  enum ResumePlan: Equatable {
    /// Nothing on disk: fetch the whole file.
    case fresh
    /// A shorter `.part` exists: ask for `bytes=<n>-`.
    case resume(from: Int64)
    /// A `.part` already as long as (or longer than) the whole file, yet never promoted. It is not
    /// resumable — `Range` past the end answers 416 — and its bytes cannot be trusted, so it is
    /// dropped and the download starts over. Real case: the pre-pinning Qwen3 download, which
    /// finished at the new size, failed the old size check and left exactly this behind.
    case restart
  }

  static func resumePlan(partialBytes: Int64, expectedBytes: Int64) -> ResumePlan {
    if partialBytes <= 0 { return .fresh }
    if partialBytes >= expectedBytes { return .restart }

    return .resume(from: partialBytes)
  }

  /// What an unfinished `.part` on disk means when no download is running.
  enum PartialState: Equatable {
    /// No bytes: nothing to resume, nothing to report.
    case empty
    /// Fewer bytes than the file: a download that was interrupted (a dropped connection, the app
    /// backgrounded or killed). Resumable, but not *in progress* — reporting it as `downloading`
    /// leaves the UI with nothing to press but Cancel.
    case interrupted
    /// Exactly the size of the file yet not promoted. Indistinguishable from the instant between the
    /// last byte arriving and the rename, so it is reported as still finishing; `start` restarts it
    /// if it never was.
    case finishing
    /// More bytes than the file: a different file than the catalog pins.
    case oversize
  }

  static func partialState(partialBytes: Int64, expectedBytes: Int64) -> PartialState {
    if partialBytes <= 0 { return .empty }
    if partialBytes < expectedBytes { return .interrupted }
    if partialBytes == expectedBytes { return .finishing }

    return .oversize
  }

  static let interruptedDownloadMessage =
    "The download was interrupted. Retry to resume from where it stopped."

  // MARK: Loading

  struct AcceleratorPlan: Equatable {
    /// The backend to try first.
    let preferred: LocalLLMAccelerator
    /// `true` when a `gpu` request was answered with the CPU because the model does not list `gpu`.
    /// (A `gpu` init that fails at load time is a separate fallback, decided by the engine.)
    let downgradedFromGPU: Bool
  }

  /// Omitted → the model's first listed accelerator. A request the model does not list is answered
  /// with the CPU rather than refused: the persisted preference outlives the model it was chosen for.
  static func planAccelerator(
    requested: LocalLLMAccelerator?, supported: [LocalLLMAccelerator]
  ) -> AcceleratorPlan {
    let wanted = requested ?? supported.first ?? .cpu

    if supported.contains(wanted) {
      return AcceleratorPlan(preferred: wanted, downgradedFromGPU: false)
    }

    return AcceleratorPlan(preferred: .cpu, downgradedFromGPU: wanted == .gpu)
  }

  /// `enableThinking` only reaches the chat template for a model that has the capability.
  static func effectiveThinking(requested: Bool, capabilities: Set<LocalLLMCapability>) -> Bool {
    requested && capabilities.contains(.thinking)
  }

  /// Multi-token prediction runs only when the caller asked *and* the model file carries it — the
  /// runtime throws on `true` for a file without it, so the ask alone is never enough.
  static func effectiveSpeculativeDecoding(requested: Bool, fileSupports: Bool) -> Bool {
    requested && fileSupports
  }

  /// The hand-written intent tools bind only to a model whose chat template has tool-call slots.
  static func toolsToBind<T>(_ tools: [T], capabilities: Set<LocalLLMCapability>) -> [T] {
    capabilities.contains(.tools) ? tools : []
  }

  // MARK: Generating

  /// A call that carries images is refused, never trimmed to its text: answering a "what is in this
  /// photo?" prompt as if no photo had been attached is worse than saying no. No iOS model has the
  /// `vision` capability and this port does no image decoding.
  static func imageRejection(modelId: String?, imageCount: Int) -> LocalLLMError? {
    imageCount > 0 ? .imageInputUnsupported(modelId: modelId) : nil
  }
}
