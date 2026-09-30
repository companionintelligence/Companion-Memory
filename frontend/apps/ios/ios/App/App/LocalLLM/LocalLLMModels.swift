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
/// `minDeviceMemoryBytes`, capabilities, accelerators and sampler defaults are all mirrored, and
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
  let capabilities: Set<LocalLLMCapability>
  /// Backends the model runs on, best first. The first entry is the default.
  let accelerators: [LocalLLMAccelerator]
  let defaultMaxTokens: Int
  let defaultTopK: Int
  let defaultTopP: Float
  let defaultTemperature: Float
}

enum LocalLLMModels {
  /// **Two models ship on iOS, not four.** `definitions.ts` lists four; the two Gemma 4 entries
  /// carry `platforms: ['android']` and are deliberately absent here. Loading a 2.6–3.7 GB model
  /// needs `com.apple.developer.kernel.increased-memory-limit`, an App ID capability only the
  /// Apple Developer account owner can switch on, and this app has no entitlements file at all —
  /// without it jetsam kills the process well before a Gemma 4 finishes loading. Add them back
  /// together with that entitlement, never before.
  ///
  /// **Why the URLs are pinned, and Qwen3 to this commit.** `resolve/main` for `litert-community/Qwen3-0.6B`
  /// moved on 2026-09-20 to a re-export (344,671,744 bytes) that needs LiteRT-LM 0.17.1 or newer. This app
  /// links 0.14.0, where it fails to load, and it also failed every download's size check against the
  /// 344,437,808 recorded here. The pin below is the last revision that loads on 0.14.0 (exercised on the
  /// Android AAR of the same version). Bumping the xcframework is what unlocks `main`; change the commit and
  /// the size together, never one alone. Both sizes were read from the pinned files
  /// (`content-range: bytes 0-0/<size>`), not from `main`.
  ///
  /// Both entries are ungated — an anonymous ranged GET answers `206` with `accept-ranges: bytes`,
  /// which is what makes ``ModelDownloader``'s resume work. (The original Android entry, Gemma3-1B,
  /// was `gated: "auto"` and 401-ed every anonymous download; that is why gated repos stay out.)
  ///
  /// Qwen3-0.6B's embedded chat template carries the `{%- if tools %}` / `<tool_call>` slots, so it
  /// works with the intent tools, and defaults **thinking on** — ``LocalLLMEngine`` passes
  /// `enable_thinking` per message and separates the reasoning from the answer.
  static let qwen3_0_6b_int4 = LocalLLMModelInfo(
    modelId: "qwen3-0.6b-int4",
    fileName: "Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm",
    url: URL(
      string:
        "https://huggingface.co/litert-community/Qwen3-0.6B/resolve/154c5de0fc0fc5002a7da570ba8c67edffa32ca2/Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm?download=true"
    )!,
    sizeBytes: 344_437_808,
    commitHash: "154c5de0fc0fc5002a7da570ba8c67edffa32ca2",
    minDeviceMemoryBytes: 4_294_967_296,
    capabilities: [.thinking, .tools],
    accelerators: [.cpu],
    defaultMaxTokens: 1024,
    defaultTopK: 64,
    defaultTopP: 0.95,
    defaultTemperature: 1.0
  )

  /// Qwen2.5-1.5B-Instruct, int8. A steadier general-purpose chat model with no tool-call slots and
  /// no reasoning channel, so it never binds the intent tools and never thinks.
  static let qwen2_5_1_5b_instruct = LocalLLMModelInfo(
    modelId: "qwen2.5-1.5b-instruct",
    fileName: "Qwen2.5-1.5B-Instruct_multi-prefill-seq_q8_ekv4096.litertlm",
    url: URL(
      string:
        "https://huggingface.co/litert-community/Qwen2.5-1.5B-Instruct/resolve/19edb84c69a0212f29a6ef17ba0d6f278b6a1614/Qwen2.5-1.5B-Instruct_multi-prefill-seq_q8_ekv4096.litertlm?download=true"
    )!,
    sizeBytes: 1_597_931_520,
    commitHash: "19edb84c69a0212f29a6ef17ba0d6f278b6a1614",
    minDeviceMemoryBytes: 6_442_450_944,
    capabilities: [],
    accelerators: [.gpu, .cpu],
    defaultMaxTokens: 4096,
    defaultTopK: 20,
    defaultTopP: 0.8,
    defaultTemperature: 0.7
  )

  /// Every model this platform ships, in `definitions.ts` order.
  static let all: [LocalLLMModelInfo] = [qwen3_0_6b_int4, qwen2_5_1_5b_instruct]

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
