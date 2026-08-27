import Foundation

/// Static metadata for a downloadable on-device model. The iOS twin of Android's
/// `LocalLlmModels.kt`, and it must stay in sync with `LOCAL_LLM_MODELS` in that plugin's
/// `src/definitions.ts` — the JS side owns the download `url`, the native side owns everything
/// needed to write, verify and load the file.
struct LocalLLMModelInfo {
  let modelId: String
  /// File name written under ``LocalLLMModels/modelsDirectory()``.
  let fileName: String
  /// Direct download URL. Unlike Android — where JS passes the url into `downloadModel` — iOS keeps
  /// it here too so a caller can start a download knowing only the `modelId`.
  let url: URL
  /// Expected size. Used to detect a truncated file, and to report progress before the server's
  /// `Content-Length` arrives.
  let sizeBytes: Int64
  /// Approximate peak RSS while loaded, per the model card — the RAM floor `isAvailable()` applies.
  let estimatedPeakMemoryBytes: Int64
  let defaultMaxTokens: Int
  let defaultTopK: Int
  let defaultTopP: Float
  let defaultTemperature: Float
}

enum LocalLLMModels {
  /// The only model offered today: Qwen3-0.6B, INT4 block-32 weights / FP32 activations — and,
  /// as of `LocalLlmModels.kt`'s matching fix, the same model Android ships too.
  ///
  /// **Android originally listed Gemma3-1B instead; that repo is `gated: "auto"` on Hugging
  /// Face** — an HF account plus a Gemma-licence click-through — so an anonymous in-app download
  /// got `401 GatedRepo` for every user who had not already fetched the file by hand. Measured,
  /// not assumed, at the time:
  ///
  ///     $ curl -sIL -o /dev/null -w '%{http_code}' \
  ///         '…/Gemma3-1B-IT_multi-prefill-seq_q4_ekv2048.task?download=true'
  ///     401        (x-error-code: GatedRepo)
  ///
  /// That made Android's catalog entry unreachable for any new user — a real, shipping bug, now
  /// fixed by pointing Android at this same model instead of a different, gated one.
  ///
  /// Qwen3-0.6B is ungated and half the size, verified with no token in the environment:
  ///
  ///     $ curl -sL -r 0-0 -D - -o /dev/null '…/Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm'
  ///     HTTP/2 206 … content-range: bytes 0-0/344437808 … accept-ranges: bytes
  ///
  /// `accept-ranges: bytes` is what makes ``ModelDownloader``'s resume work.
  ///
  /// Its embedded Jinja chat template carries the `{%- if tools %}` / `<tool_call>` slots, so it
  /// works with the intent tools — but it also defaults **thinking on**, and the Swift
  /// `ConversationConfig` exposes no knob to disable it, so ``LocalLLMEngine`` strips
  /// `<think>…</think>` from the stream.
  static let qwen3_0_6b_int4 = LocalLLMModelInfo(
    modelId: "qwen3-0.6b-int4",
    fileName: "Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm",
    url: URL(
      string:
        "https://huggingface.co/litert-community/Qwen3-0.6B/resolve/main/Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm?download=true"
    )!,
    sizeBytes: 344_437_808,
    estimatedPeakMemoryBytes: 2_147_483_648,
    defaultMaxTokens: 1024,
    defaultTopK: 64,
    defaultTopP: 0.95,
    defaultTemperature: 1.0
  )

  private static let byId: [String: LocalLLMModelInfo] = [
    qwen3_0_6b_int4.modelId: qwen3_0_6b_int4
  ]

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
}

/// Minimum free disk to start (or resume) a download (~1 GiB), matching Android's floor.
let minimumFreeDiskBytes: Int64 = 1 * 1024 * 1024 * 1024

let modelDownloadProgressEvent = "modelDownloadProgress"
