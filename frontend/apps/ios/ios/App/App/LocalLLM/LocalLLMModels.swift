import Foundation

/// A backend a model can run on. `gpu` is Metal on iOS. Raw values are the strings the JS contract
/// (`LocalLlmAccelerator` in `@ci/capacitor-local-llm`) and LiteRT-LM's own backend names use.
enum LocalLLMAccelerator: String {
  case cpu
  case gpu
}

/// What a model can do beyond plain chat. Raw values match `LocalLlmCapability` in `definitions.ts`.
enum LocalLLMCapability: String {
  /// Emits a separate reasoning channel that `enableThinking` turns on.
  case thinking
  /// Accepts images. No iOS catalog entry has it — see ``LocalLLMModels``.
  case vision
  /// Its chat template carries tool-call slots, so the intent tools bind.
  case tools
}

/// Static metadata for a downloadable on-device model. The iOS twin of Android's
/// `LocalLlmModels.kt`, and it must stay in sync with `LOCAL_LLM_MODELS` in that plugin's
/// `src/definitions.ts` — `modelId`, file name, pinned `url`, `commitHash`, exact `sizeBytes`,
/// `minDeviceMemoryBytes`, `gpuMinDeviceMemoryBytes`, capabilities, accelerators and sampler defaults are all mirrored, and
/// `capacitorPluginContract.test.ts` reads this file to prove it.
struct LocalLLMModelInfo {
  let modelId: String
  /// File name written under ``LocalLLMModels/modelsDirectory()``.
  let fileName: String
  /// Direct download URL, **pinned to a Hugging Face commit** (`…/resolve/<commitHash>/…`). Never
  /// `resolve/main`: the bytes on `main` move, and the download is verified against ``sizeBytes``.
  let url: URL
  /// The exact size of the file at ``url``. A download that lands at any other size is not promoted
  /// to a usable model — it is a different file, not a slow one.
  let sizeBytes: Int64
  /// The Hugging Face commit ``url`` is pinned to.
  let commitHash: String
  /// Total physical RAM below which the model is neither downloaded nor loaded.
  let minDeviceMemoryBytes: UInt64
  /// Total physical RAM below which the GPU (Metal) backend is withheld and the model runs on the CPU,
  /// whatever was asked for. Never under ``minDeviceMemoryBytes``. Mirrors Android, where the GPU expands
  /// int4 weights to fp16 in graphics memory (Gemma 4 E2B: 3.3 GB resident on the GPU against 2.3 GB on
  /// the CPU, measured 2026-10-13); see ``LocalLLMPolicy/planAccelerator``.
  let gpuMinDeviceMemoryBytes: UInt64
  let capabilities: Set<LocalLLMCapability>
  /// Backends the model runs on, best first. The first entry is the default.
  let accelerators: [LocalLLMAccelerator]
  let defaultMaxTokens: Int
  let defaultTopK: Int
  let defaultTopP: Float
  let defaultTemperature: Float
}

enum LocalLLMModels {
  /// **No LiteRT-LM model ships on iOS (since 2026-10-13).** `definitions.ts` lists two, both Gemma 4,
  /// both `platforms: ['android']`. Qwen3-0.6B could not hold the tool protocol, Qwen2.5 had no tool
  /// slot, and Qwen3-1.7B's GPU working set (~3.3 GB on Android) would not fit the standard iOS memory
  /// envelope; iOS on-device chat is to come from Apple Intelligence instead. Loading a 2.6–3.7 GB model
  /// needs `com.apple.developer.kernel.increased-memory-limit`, an App ID capability only the
  /// Apple Developer account owner can switch on, and this app has no entitlements file at all —
  /// without it jetsam kills the process well before a Gemma 4 finishes loading. Add them back
  /// together with that entitlement, never before.
  ///
  /// **Why the URLs are pinned.** `resolve/main` for `litert-community/Qwen3-0.6B` (shipped until
  /// 2026-10-13) moved on 2026-09-20 to a re-export that needed a newer LiteRT-LM and failed every
  /// download's size check against the older revision. Change the commit and the size together, never
  /// one alone, and only to a revision that loads on the runtime both platforms link. Sizes are read
  /// from the pinned files (`content-range: bytes 0-0/<size>`), not from `main`.
  ///
  /// The entry is ungated — an anonymous ranged GET answers `206` with `accept-ranges: bytes`,
  /// which is what makes ``ModelDownloader``'s resume work. (The original Android entry, Gemma3-1B,
  /// was `gated: "auto"` and 401-ed every anonymous download; that is why gated repos stay out.)
  ///
  /// Every model this platform ships, in `definitions.ts` order.
  static let all: [LocalLLMModelInfo] = []

  private static let byId: [String: LocalLLMModelInfo] = Dictionary(
    uniqueKeysWithValues: all.map { ($0.modelId, $0) })

  static func find(_ modelId: String) -> LocalLLMModelInfo? { byId[modelId] }

  /// App-private directory models are downloaded into. `.applicationSupportDirectory` rather than
  /// `.documentDirectory` so a half-gigabyte blob never shows up in the user's Files app, and
  /// marked no-backup so it is not uploaded to iCloud — it is re-downloadable content, and Apple
  /// rejects apps that back up large regenerable files.
  static func modelsDirectory() throws -> URL {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    var directory = base.appendingPathComponent("local-llm-models", isDirectory: true)

    if !FileManager.default.fileExists(atPath: directory.path) {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

      var resourceValues = URLResourceValues()
      resourceValues.isExcludedFromBackup = true
      try? directory.setResourceValues(resourceValues)
    }

    return directory
  }

  static func modelFile(_ info: LocalLLMModelInfo) throws -> URL {
    try modelsDirectory().appendingPathComponent(info.fileName)
  }

  /// Partial download, resumed via HTTP `Range`. Same `.part` convention as Android.
  static func partialFile(_ info: LocalLLMModelInfo) throws -> URL {
    try modelsDirectory().appendingPathComponent(info.fileName + ".part")
  }

  /// Free space where models are stored, or `nil` when the volume will not say. Uses the
  /// "important usage" capacity, which counts space the OS will purge (caches, old downloads) to
  /// satisfy a user-initiated download — the same figure Settings > Storage shows.
  static func freeDiskBytes() -> Int64? {
    let location = (try? modelsDirectory()) ?? URL(fileURLWithPath: NSTemporaryDirectory())
    let values = try? location.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])

    return values?.volumeAvailableCapacityForImportantUsage
  }
}

let modelDownloadProgressEvent = "modelDownloadProgress"
