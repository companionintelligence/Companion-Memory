import Capacitor
import Foundation
import UIKit

/// On-device chat completion for iOS, implementing the **same JS contract** as the Android
/// `@ci/capacitor-local-llm` plugin — the v2 surface in that package's `definitions.ts`:
/// `isAvailable` / `getModelStatus` / `downloadModel` / `cancelDownload` / `deleteModel` /
/// `loadModel` / `getLoadedModel` / `resetConversation` / `unloadModel` / `generate` /
/// `generateStream` / `cancel` / `configureIntentTools`, plus the `llmToken` and
/// `modelDownloadProgress` events. That is deliberate: `@ci/common`'s `generateOffline()` already
/// drives that contract and falls back to the appliance's `/api/llm/generate` when the plugin is
/// absent, so implementing it here makes on-device inference work on iOS with **no web-layer
/// changes at all**.
///
/// Differences from Android, each forced by the platform rather than chosen:
///
/// - **Hand-written tools.** See `CompanionIntentTools.swift` — LiteRT-LM's Swift `Tool` reflects
///   over compile-time properties and has no runtime-schema equivalent of Android's `OpenApiTool`.
/// - **Two models, not four.** The Gemma 4 entries are Android-only: this app has no entitlements
///   file, so it lacks `com.apple.developer.kernel.increased-memory-limit`, and a 2.6–3.7 GB model
///   would be jetsam-killed. See `LocalLLMModels.swift`.
/// - **No image input.** No iOS model is multimodal; a call carrying `images` is rejected, never
///   silently stripped to its text.
///
/// This lives in the app target rather than in `@ci/capacitor-local-llm` (which declares itself
/// Android-only and has no `ios/`) because moving it into that package needs a podspec, a vendored
/// xcframework inside the pod, and a Podfile regeneration — mechanical, but a separate change.
@objc(LocalLLMPlugin)
public class LocalLLMPlugin: CAPPlugin, CAPBridgedPlugin {
  public let identifier = "LocalLLMPlugin"
  public let jsName = "LocalLLM"
  // Capacitor 7 dropped the Objective-C runtime scan: this array is the ONLY thing the bridge
  // consults, so an `@objc func` missing from it compiles and is unreachable from JS.
  // `capacitorPluginContract.test.ts` checks it against `LocalLlmPlugin` in `definitions.ts`.
  public let pluginMethods: [CAPPluginMethod] = [
    CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "getModelStatus", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "downloadModel", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "cancelDownload", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "deleteModel", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "loadModel", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "configureIntentTools", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "getLoadedModel", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "resetConversation", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "unloadModel", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "generate", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "generateStream", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
  ]

  private let engine = LocalLLMEngine()
  private var generationTask: Task<Void, Never>?

  /// Forwards every progress tick to JS as `modelDownloadProgress`, matching Android's event shape —
  /// including `error` on a failure, which is the only way the UI learns why.
  private lazy var downloader = ModelDownloader { [weak self] modelId, status, downloaded, total, error in
    var data: [String: Any] = [
      "modelId": modelId,
      "status": status.rawValue,
      "bytesDownloaded": downloaded,
      "totalBytes": total,
    ]
    if status == .error, let error { data["error"] = error }

    self?.notifyListeners(modelDownloadProgressEvent, data: data)
  }

  /// Capability probe, matching Android's: no side effects, no downloads.
  ///
  /// `available` means the device's RAM can run at least the *smallest* catalog model (iOS 15.5 is
  /// the deployment floor, so there is no separate OS gate). Free disk is deliberately not part of
  /// it — a nearly-full phone can still run a model it already has — so it is reported, and
  /// enforced per model in `downloadModel`, where the model's real size is known. Jetsam kills the
  /// app rather than failing an allocation, so refusing on RAM up front is the difference between
  /// "unavailable" and "the app disappeared mid-sentence".
  @objc func isAvailable(_ call: CAPPluginCall) {
    let totalMemory = ProcessInfo.processInfo.physicalMemory
    let available = LocalLLMPolicy.deviceCanRunAnyModel(
      physicalMemory: totalMemory, catalog: LocalLLMModels.all)

    var result: [String: Any] = [
      "available": available,
      "totalMemoryBytes": Int(clamping: totalMemory),
    ]

    if let freeDisk = LocalLLMModels.freeDiskBytes() {
      result["freeDiskBytes"] = freeDisk
    }
    if !available {
      result["reason"] = "This device does not have enough memory to run an on-device model."
    }

    call.resolve(result)
  }

  /// Current on-disk state of a model, with byte progress while downloading. Matches Android's
  /// `getModelStatus`.
  @objc func getModelStatus(_ call: CAPPluginCall) {
    guard let info = resolveModel(call) else { return }

    call.resolve(downloader.status(of: info).asDictionary)
  }

  /// Starts (or resumes) the model download, reporting progress via `modelDownloadProgress`.
  ///
  /// Resolves once the download is *enqueued*, not once it completes — same contract as Android, so
  /// callers listen for the terminal `ready`/`error` event or poll `getModelStatus`.
  ///
  /// The download is always the catalog's own commit-pinned URL. The `url` the caller sends is kept
  /// in the contract only so it can be *refused* when it is anything else — a native side that
  /// fetched whatever URL JS supplied would let a compromised WebView swap in any file on
  /// `huggingface.co` sized to the pin. Also refused up front, before a byte moves: a device below
  /// the model's RAM floor, and a volume without room for what is still to fetch plus headroom. A
  /// missing `url` is fine.
  @objc func downloadModel(_ call: CAPPluginCall) {
    guard let info = resolveModel(call) else { return }

    if let raw = call.getString("url") {
      do {
        try LocalLLMPolicy.verifyDownloadURL(raw, isPinnedURL: info.url, modelId: info.modelId)
      } catch {
        call.reject(error.localizedDescription)

        return
      }
    }

    if let shortfall = memoryShortfall(for: info) {
      call.reject(shortfall.localizedDescription)

      return
    }

    do {
      try downloader.start(info)
      call.resolve()
    } catch {
      call.reject("Could not start the download: \(error.localizedDescription)")
    }
  }

  /// Stops an in-flight download, drops its partial file and emits a final `modelDownloadProgress`
  /// with `not_downloaded`. A no-op for a model that is not downloading (or is already complete).
  @objc func cancelDownload(_ call: CAPPluginCall) {
    guard let info = resolveModel(call) else { return }

    downloader.cancelDownload(info)
    call.resolve()
  }

  /// Deletes the downloaded model and any partial, cancelling an in-flight download first.
  @objc func deleteModel(_ call: CAPPluginCall) {
    guard let info = resolveModel(call) else { return }

    // Unload first: deleting the file out from under a live engine leaves it holding a handle to a
    // path that no longer exists, and the failure only surfaces at the next generate(). The engine
    // decides whether it is using the file — including a load that has not finished yet, which a
    // check on the resident model's path would miss.
    Task {
      if let path = (try? LocalLLMModels.modelFile(info))?.path {
        await engine.unload(ifUsing: path)
      }
      downloader.delete(info)
      call.resolve()
    }
  }

  /// Loads a downloaded model, by `modelId` only — there is deliberately no `path`. A path from the
  /// WebView would let a compromised page probe the sandbox (the error text differs for a file that
  /// exists) and hand any app-readable file to the model parser; Android ignores it too.
  ///
  /// Idempotent: a load identical to the resident one is a no-op that returns the same result (see
  /// `LocalLLMEngine.load`), so the JS layer can ask every turn without paying for a reload.
  ///
  /// Resolves `{toolCount, accelerator, fellBackToCpu, speculativeDecoding}`: the backend the model
  /// actually loaded on (a `gpu` request that will not initialise retries on the CPU), and whether
  /// multi-token prediction is in force (only when asked for *and* the file carries it).
  @objc func loadModel(_ call: CAPPluginCall) {
    guard let info = resolveModel(call) else { return }

    if let shortfall = memoryShortfall(for: info) {
      call.reject(shortfall.localizedDescription)

      return
    }

    guard let file = try? LocalLLMModels.modelFile(info) else {
      call.reject("Could not resolve the models directory")

      return
    }
    guard FileManager.default.fileExists(atPath: file.path) else {
      call.reject("Model is not downloaded. Call downloadModel() first.")

      return
    }

    var requestedAccelerator: LocalLLMAccelerator?
    if let raw = call.getString("accelerator") {
      guard let parsed = LocalLLMAccelerator(rawValue: raw) else {
        call.reject("Unknown accelerator: \(raw). Expected \"cpu\" or \"gpu\".")

        return
      }
      requestedAccelerator = parsed
    }

    Task {
      do {
        // Fetched here, not lazily: LiteRT-LM fixes the tool set when the conversation is
        // created (done inside load(), not per-call — see LocalLLMEngine), so tools must exist
        // before load(). Matches Android's loadModel(), which fetches at the same point for the
        // same reason. Skipped outright for a model without the `tools` capability. No-ops (and
        // logs) when the appliance is unreachable or intent tools were never configured, leaving a
        // toolless — but working — local model.
        let tools = LocalLLMPolicy.toolsToBind(
          CompanionToolContext.executableTools(), capabilities: info.capabilities)

        let request = LocalLLMLoadRequest(
          path: file.path, info: info, tools: tools,
          requestedAccelerator: requestedAccelerator,
          wantsSpeculativeDecoding: call.getBool("enableSpeculativeDecoding") ?? false,
          maxTokens: call.getInt("maxTokens"), topK: call.getInt("topK"),
          topP: call.getDouble("topP"), temperature: call.getDouble("temperature"))

        // What a tool may hand back is the room the window has when it runs: a result bigger than that
        // cannot be taken in (see `ToolResultShaper`). The engine is asked at that moment; the share of
        // the window as configured is the fallback for when it cannot say.
        CompanionToolContext.resultBudgetBytes = LocalLLMPolicy.toolResultByteBudget(
          contextTokens: request.maxTokens)
        CompanionToolContext.windowTokensLeft = { [engine] in await engine.contextTokensLeft() }

        let outcome = try await engine.load(request)

        call.resolve([
          "toolCount": outcome.toolCount,
          "accelerator": outcome.accelerator.rawValue,
          "fellBackToCpu": outcome.fellBackToCpu,
          "speculativeDecoding": outcome.speculativeDecoding,
        ])
      } catch {
        call.reject("Failed to load model: \(error.localizedDescription)")
      }
    }
  }

  /// Which model is resident right now. Survives a WebView reload, which the JS side does not.
  @objc func getLoadedModel(_ call: CAPPluginCall) {
    Task {
      guard await engine.isLoaded else {
        call.resolve(["loaded": false])

        return
      }

      var result: [String: Any] = ["loaded": true]
      if let modelId = await engine.loadedModelId { result["modelId"] = modelId }
      if let accelerator = await engine.loadedAccelerator { result["accelerator"] = accelerator.rawValue }

      call.resolve(result)
    }
  }

  /// Starts a fresh conversation on the loaded engine — same sampler, same tools, no reload. Any
  /// generation in flight is cancelled first. Rejects when no model is loaded.
  @objc func resetConversation(_ call: CAPPluginCall) {
    Task {
      do {
        try await engine.resetConversation()
        call.resolve()
      } catch {
        call.reject("Could not reset the conversation: \(error.localizedDescription)")
      }
    }
  }

  /// Shared `modelId` → catalog lookup, rejecting the call on a miss. Returns nil when it rejected.
  private func resolveModel(_ call: CAPPluginCall) -> LocalLLMModelInfo? {
    guard let modelId = call.getString("modelId") else {
      call.reject("modelId is required")

      return nil
    }
    guard let info = LocalLLMModels.find(modelId) else {
      call.reject("Unknown modelId: \(modelId)")

      return nil
    }

    return info
  }

  /// The RAM check both `downloadModel` and `loadModel` apply, as an error to reject with.
  private func memoryShortfall(for info: LocalLLMModelInfo) -> LocalLLMError? {
    let physical = ProcessInfo.processInfo.physicalMemory

    guard
      !LocalLLMPolicy.meetsMemoryFloor(
        physicalMemory: physical, minDeviceMemoryBytes: info.minDeviceMemoryBytes)
    else { return nil }

    return .insufficientMemory(
      modelId: info.modelId, requiredBytes: info.minDeviceMemoryBytes, deviceBytes: physical)
  }

  @objc func unloadModel(_ call: CAPPluginCall) {
    Task {
      await engine.unload()
      call.resolve()
    }
  }

  /// Non-streaming: buffers the whole reply. Tools were attached when the conversation was
  /// created, at `loadModel()` — the model's turn history now lives inside that persistent
  /// conversation too, so this only ever sends the one new prompt.
  ///
  /// Resolves `{text, thought?, stats?}`. `thought` is the reasoning, present only when
  /// `enableThinking` produced some; `stats` only when the generation ran to completion.
  @objc func generate(_ call: CAPPluginCall) {
    guard let prompt = call.getString("prompt") else {
      rejectMissingPrompt(call, method: "generate")

      return
    }

    let enableThinking = call.getBool("enableThinking") ?? false
    let imageCount = call.getArray("images")?.count ?? 0

    let backgroundTask = beginBackgroundTask()
    Task {
      defer { endBackgroundTask(backgroundTask) }
      do {
        try await rejectImages(count: imageCount)

        let stream = try await engine.generate(prompt: prompt, enableThinking: enableThinking)
        var text = ""
        var thought = ""
        var stats: GenerationStats?

        for try await event in stream {
          switch event {
          case .delta(let answer, let reasoning):
            text += answer
            thought += reasoning
          case .finished(let outcome):
            stats = outcome.stats
          }
        }

        var result: [String: Any] = ["text": text]
        let reasoning = thought.trimmingCharacters(in: .whitespacesAndNewlines)
        if !reasoning.isEmpty { result["thought"] = reasoning }
        if let stats { result["stats"] = stats.asDictionary }

        call.resolve(result)
      } catch {
        rejectGeneration(call, method: "generate", error: error)
      }
    }
  }

  /// Streaming: emits `llmToken` events (`{partial, thought?, done}`), resolving once generation
  /// completes — the exact shape `generateOffline`'s `generateLocalStreaming` subscribes to. The
  /// terminal `done: true` event also carries `stats`, unless the generation was cancelled.
  @objc func generateStream(_ call: CAPPluginCall) {
    guard let prompt = call.getString("prompt") else {
      rejectMissingPrompt(call, method: "generateStream")

      return
    }

    let enableThinking = call.getBool("enableThinking") ?? false
    let imageCount = call.getArray("images")?.count ?? 0

    // A new stream replaces the one before it: the old consumer is cancelled so its call resolves,
    // and the engine stops the old native generation and waits for it before starting this one.
    generationTask?.cancel()

    let backgroundTask = beginBackgroundTask()
    generationTask = Task {
      defer { endBackgroundTask(backgroundTask) }

      do {
        try await rejectImages(count: imageCount)

        let stream = try await engine.generate(prompt: prompt, enableThinking: enableThinking)
        var outcome: GenerationOutcome?

        for try await event in stream {
          switch event {
          case .delta(let answer, let thought):
            var data: [String: Any] = ["partial": answer, "done": false]
            if !thought.isEmpty { data["thought"] = thought }
            notifyListeners("llmToken", data: data)
          case .finished(let finished):
            outcome = finished
          }
        }

        // Never stats on a cancelled run, even one whose consumer was cancelled just as the final
        // event was already buffered: the JS side reads "no stats" as "this one was cut short".
        notifyListeners("llmToken", data: terminalEvent(stats: Task.isCancelled ? nil : outcome?.stats))
        call.resolve()
      } catch {
        // A cancel() is a normal end, not a failure: report the terminal event and resolve, so the
        // JS side's `finally` unsubscribes cleanly instead of surfacing an error to the user.
        if Task.isCancelled {
          notifyListeners("llmToken", data: terminalEvent(stats: nil))
          call.resolve()
        } else {
          rejectGeneration(call, method: "generateStream", error: error)
        }
      }
    }
  }

  /// The final `llmToken` event. `stats` is omitted (not zeroed) for a generation that did not run
  /// to completion — a cancelled run's speed says nothing about the model.
  private func terminalEvent(stats: GenerationStats?) -> [String: Any] {
    var data: [String: Any] = ["partial": "", "done": true]
    if let stats { data["stats"] = stats.asDictionary }

    return data
  }

  /// Rejects a failed generation — and writes it to the device log first, which nothing did before:
  /// the JS promise rejected, the chat showed only "interrupted", and the cause was visible nowhere.
  /// The log line and the rejection carry the runtime's own error text (bounded) and how far the
  /// generation had got (``GenerationFailure``). Nothing here adds the prompt or a tool's result to
  /// either: those are the user's data.
  private func rejectGeneration(_ call: CAPPluginCall, method: String, error: Error) {
    NSLog("%@", GenerationFailure.logLine(for: error, method: method))
    call.reject(GenerationFailure.rejectionMessage(for: error))
  }

  private func rejectMissingPrompt(_ call: CAPPluginCall, method: String) {
    NSLog("[LocalLLM] %@ rejected: prompt is required", method)
    call.reject("prompt is required")
  }

  /// Rejects a call that carries `images`. No iOS model has the `vision` capability and this port
  /// does no image decoding, so the honest answer is no — dropping them and answering the text alone
  /// would describe a photo the model never saw.
  private func rejectImages(count: Int) async throws {
    let modelId = await engine.loadedModelId

    if let rejection = LocalLLMPolicy.imageRejection(modelId: modelId, imageCount: count) {
      throw rejection
    }
  }

  /// Requests a little extra runtime from the OS so a brief backgrounding mid-generation (a
  /// notification banner, a quick app-switch) doesn't get the process suspended mid-token —
  /// before this, nothing protected an in-flight generation at all. `beginBackgroundTask` is
  /// bounded (historically ~30s, longer on some iOS versions) and best-effort, not a guarantee;
  /// `BGContinuedProcessingTask` (iOS 26+) is the fuller answer but needs a mandatory visible
  /// system progress UI and its own Info.plist wiring, which is a UX feature, not a bug fix — see
  /// doc 01, "Competitive Landscape, Offline and Local Mobile AI" §6.
  ///
  /// Returns a `BackgroundTask` box rather than the raw `UIBackgroundTaskIdentifier`: the normal
  /// completion path and the expiration handler both want to end the same task, and
  /// `endBackgroundTask` called twice on one identifier is a hard runtime crash — the box makes
  /// "exactly once" a property of the type instead of something both call sites have to agree on.
  private func beginBackgroundTask() -> BackgroundTask {
    let box = BackgroundTask()
    let id = UIApplication.shared.beginBackgroundTask(withName: "LocalLLM.generate") { [weak self] in
      // Expiration handler: the OS is about to suspend us. Cancel cleanly rather than being
      // killed mid-token, then release the task so we are not force-terminated for overrunning it.
      Task { await self?.engine.cancel() }
      if let endedID = box.end() {
        UIApplication.shared.endBackgroundTask(endedID)
      }
    }
    box.begin(id)
    return box
  }

  private func endBackgroundTask(_ box: BackgroundTask) {
    if let endedID = box.end() {
      UIApplication.shared.endBackgroundTask(endedID)
    }
  }

  @objc func cancel(_ call: CAPPluginCall) {
    generationTask?.cancel()
    generationTask = nil
    Task {
      await engine.cancel()
      call.resolve()
    }
  }

  /// Points the on-device model's tool calling at a CI-Server, or turns it off.
  ///
  /// Credentials are passed in from the web layer (which already holds the configured origin and the
  /// minted API key) rather than read from the Keychain here, so this matches the Android plugin's
  /// contract exactly and only one place knows how the app stores credentials.
  ///
  /// Fetches the catalog immediately, so `toolCount` reflects what the appliance will actually allow.
  @objc func configureIntentTools(_ call: CAPPluginCall) {
    let enabled = call.getBool("enabled") ?? true

    guard enabled else {
      CompanionToolContext.disable()
      call.resolve(["toolCount": 0])

      return
    }

    guard
      let baseUrlString = call.getString("baseUrl"),
      let baseURL = URL(string: baseUrlString),
      let apiKey = call.getString("apiKey"),
      !apiKey.isEmpty
    else {
      call.reject("baseUrl and apiKey are required to enable intent tools")

      return
    }

    CompanionToolContext.client = CompanionIntentClient(baseURL: baseURL, apiKey: apiKey)

    Task {
      let tools = await CompanionToolContext.refreshRulings()
      call.resolve(["toolCount": tools.count])
    }
  }
}

/// Ensures a `UIBackgroundTaskIdentifier` is ended exactly once, no matter which of two racing
/// call sites — the normal completion path and the OS's expiration handler — gets there first.
/// Calling `UIApplication.endBackgroundTask` twice on the same identifier is a hard runtime crash,
/// not just a logic bug, so "exactly once" has to be a property of the type, not a convention both
/// call sites remember to follow.
private final class BackgroundTask {
  private let lock = NSLock()
  private var identifier: UIBackgroundTaskIdentifier = .invalid
  private var ended = false

  func begin(_ identifier: UIBackgroundTaskIdentifier) {
    lock.lock()
    defer { lock.unlock() }
    self.identifier = identifier
  }

  /// Returns the identifier to end, or `nil` if it was already ended (or never began).
  func end() -> UIBackgroundTaskIdentifier? {
    lock.lock()
    defer { lock.unlock() }
    guard !ended, identifier != .invalid else { return nil }
    ended = true
    return identifier
  }
}
