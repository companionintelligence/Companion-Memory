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
    /// `true` when the GPU was wanted (asked for, or the model's default) but withheld because the device
    /// has less RAM than the model's `gpuMinDeviceMemoryBytes`. Android's `gpuWithheld`.
    let withheldFromGPU: Bool
  }

  /// Omitted → the model's first listed accelerator. A request the model does not list is answered
  /// with the CPU rather than refused: the persisted preference outlives the model it was chosen for.
  /// A GPU choice on a device under `gpuMinDeviceMemoryBytes` becomes the CPU (when the model lists it):
  /// a GPU load there can succeed and then have the app killed for memory mid-conversation, so it is
  /// not attempted at all.
  static func planAccelerator(
    requested: LocalLLMAccelerator?, supported: [LocalLLMAccelerator],
    physicalMemory: UInt64, gpuMinDeviceMemoryBytes: UInt64
  ) -> AcceleratorPlan {
    let wanted = requested ?? supported.first ?? .cpu

    if !supported.contains(wanted) {
      return AcceleratorPlan(preferred: .cpu, downgradedFromGPU: wanted == .gpu, withheldFromGPU: false)
    }

    if wanted == .gpu && physicalMemory < gpuMinDeviceMemoryBytes && supported.contains(.cpu) {
      return AcceleratorPlan(preferred: .cpu, downgradedFromGPU: false, withheldFromGPU: true)
    }

    return AcceleratorPlan(preferred: wanted, downgradedFromGPU: false, withheldFromGPU: false)
  }

  /// `enableThinking` only reaches the chat template for a model that has the capability.
  /// The most tokens a thinking model may spend reasoning before it has to answer: a quarter of the window,
  /// never under 64. Without a cap a small model reasons until the window is full and stops with no answer
  /// and no error (measured on Android: Qwen3-0.6B, 1,024 tokens, two thirds of it prompt). The same figure as
  /// Android's `LocalLlmPolicy.thinkingTokenBudget`; retune the two together.
  static func thinkingTokenBudget(contextTokens: Int) -> Int {
    max(contextTokens / 4, 64)
  }

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

  // MARK: Tool results

  /// What a tool result is sized against, and what the rest of a tool turn takes of the window.
  ///
  /// The numbers are measured, not guessed: `tests/local-llm-device` tokenizes with the model's own
  /// tokenizer (`Engine.tokenCount`) and reads the KV cache from the runtime.
  struct ToolResultProfile: Equatable {
    /// UTF-8 bytes per model token in a shaped result (JSON and English). Qwen3's tokenizer makes 2.3 to
    /// 3.0 of the shaped results the bench produced, depending on the budget they were cut to (2.6 over
    /// all of them); the low end is used so a result is never bigger than the room counted for it.
    var bytesPerToken = 2.3
    /// What carrying a result back costs besides the result itself: the `tool_response` wrapper of the
    /// chat template (18 tokens measured) and a little slack.
    var wrapperTokens = 24
    /// What the window must still have left **once the result is in**. It is not what the reply needs
    /// (a grounded one is 50 to 130 tokens) but what the runtime needs: the request that carries a tool's
    /// result back comes out garbled — `</think>` repeated to the end of the window, or "What is the
    /// user's question?" — when fewer than about 700 tokens remain after it. That held at every window
    /// measured, 1024 to 3072, while plain chat turns with 200 to 400 tokens left were fine. Garbled with
    /// 673 left, sound with 735 (`tests/local-llm-device`, Simulator); 768 is the margin.
    var reserveTokens = 768
    /// The user's question and the model's own tool call: in the cache by the time a tool runs, not yet
    /// when a new question arrives.
    var turnTokens = 80
    /// The most a result is ever allowed to be, however much room there is: the appliance's own cap on a
    /// tool result (`toolResultBudget.ts`).
    var maxBytes = 16_384
    /// The least. Under this the shaper has no room for the markers that say the result was cut.
    var minBytes = 128
    /// The smallest result still worth a tool call.
    var usefulResultBytes = 256

    static let standard = ToolResultProfile()
  }

  /// The most bytes of one tool result that go back into the model's context window, **given how much of
  /// the window is left right now**.
  ///
  /// `tokensLeft` is the window less what the KV cache holds at the moment the tool runs (see
  /// `LocalLLMEngine.contextTokensLeft`): the system instruction and the tool declarations
  /// (~430 tokens on Qwen3-0.6B with the three intent tools), every earlier turn, this question and the
  /// model's own tool call are already in it. What is left has to take the wrapper the result travels in
  /// and the profile's reserve, and the result gets what remains.
  ///
  /// Reading the cache instead of estimating means a long conversation shrinks the results it can take,
  /// and a larger tool catalogue (a bigger preface) does too, without anyone having to know either.
  static func toolResultByteBudget(
    tokensLeft: Int, profile: ToolResultProfile = .standard
  ) -> Int {
    // No room, or less than none, is the floor: a stub that says the result did not fit.
    let room = tokensLeft - profile.wrapperTokens - profile.reserveTokens

    return min(max(Int(Double(room) * profile.bytesPerToken), profile.minBytes), profile.maxBytes)
  }

  /// What a window must have left when a question arrives for a tool call in that turn to work: the
  /// question and the call, a result worth sending, its wrapper, and the reserve.
  static func toolTurnMinimumTokens(profile: ToolResultProfile = .standard) -> Int {
    let result = Int((Double(profile.usefulResultBytes) / profile.bytesPerToken).rounded(.up))

    return profile.turnTokens + result + profile.wrapperTokens + profile.reserveTokens
  }

  /// Whether a conversation that offers tools should start afresh before it takes another question.
  ///
  /// Below ``toolTurnMinimumTokens(profile:)`` a tool call in the next turn cannot work: the reply that
  /// follows it is garbled whatever the result says, however small. Forgetting the earlier turns is a
  /// better answer than that. A conversation with no history is never renewed — a fresh one is as roomy as
  /// it will get; if that is not enough, the window is too small for tools and a renewal cannot help.
  static func shouldRenewToolConversation(
    tokensLeft: Int?, hasHistory: Bool, profile: ToolResultProfile = .standard
  ) -> Bool {
    guard hasHistory, let tokensLeft else { return false }

    return tokensLeft < toolTurnMinimumTokens(profile: profile)
  }

  /// The same, when the cache cannot be read: half the window **in bytes**. JSON and English run ~2.3
  /// bytes a token, so that is about a fifth of the window in tokens (≈ 220 of 1024) — the fixed prompt
  /// takes about 430 of it and the reply a quarter. An estimate, so it errs small. The floor keeps a tiny
  /// window from rounding to nothing, the ceiling is the appliance's own cap on a tool result.
  static func toolResultByteBudget(contextTokens: Int) -> Int {
    min(max(contextTokens / 2, 256), 16_384)
  }
}

// MARK: - Tool results

/// Bounds a tool's result before it goes back into the model's context window.
///
/// The appliance answers a tool call with the whole result, pretty-printed — 25 hydrated entities from
/// `knowledge.search` is ~40 KB of JSON, which its own chat harness measured and now bounds with
/// `boundToolResultForPrompt` (`backend/apps/api/src/domains/llm/toolResultBudget.ts`). On the phone
/// that text went straight into a window that is a few thousand tokens at best, so it has to be cut.
/// What survives the cut is what the model reads, and measured on a device (`tests/local-llm-device`)
/// the way it is cut decides whether the answer is grounded:
///
/// - **An unset column is most of a hit.** The appliance writes every column of an entity, so a typical
///   hit is `null`, `false`, `[]`, `{}` and foreign-key UUIDs around a few readable fields. They cost
///   bytes and tell the model nothing, so they go first (``prune(_:depth:)``).
/// - **What is left is written answer-first.** Identity (`type`, `link`, `title`…), then when, then what
///   it says, then everything else shortest-first, then bookkeeping (`sourceId`, scores…). A hit that
///   has to lose members loses them from the end, so the cut takes bookkeeping before the date.
/// - **The first few hits share the room.** One long hit gives the model one fact; three short ones give
///   it three. Each of the first ``maximumBreadth`` hits is held to an equal share, shortening its strings
///   a step at a time and only then dropping members.
/// - **Never JSON inside a string.** The first version fell back to the hit's JSON *as a string* when it
///   did not fit. A string result is written into the chat template escaped, and that one was escaped
///   three times over: `\\\"type\\\"`. A hit stays an object, however few members it keeps.
///
/// Through all of it the guarantees hold:
///
/// - a result that already fits is returned untouched;
/// - the output is never longer than the budget, in UTF-8 bytes (those are what a token budget is
///   estimated from);
/// - JSON in is JSON out — valid, never cut mid-token — from a budget big enough for a header, one hit and
///   the closing note (about 340 bytes on the realistic results; the tests hold 400). A search envelope
///   (`{summary, …, items:[…]}`) keeps its header and closes its list with an element that says how many
///   results were left out, so the model knows the list was cut rather than exhaustive;
/// - anything that is not JSON — or is nested deeper than ``maximumParseDepth``, which Foundation's own
///   recursive parser cannot be trusted with on a small stack — is cut at the budget on a character
///   boundary and says so, as is JSON under that budget.
enum ToolResultShaper {
  /// Below this a budget cannot hold the markers, so it is raised to it.
  static let minimumBudgetBytes = 64
  static let truncationMarker = "…[truncated]"
  /// The closing element of a list that lost hits, and its size: held back, exactly, so it cannot itself overflow.
  private static func omissionNote(_ omitted: Int) -> String? {
    quoted("[\(omitted) more results omitted — refine the query to narrow them down]")
  }

  /// The deepest a value is kept. Real results are under ten levels deep; a nested object is written by
  /// recursion, and a deep one overflowed the 512 KB stack of a background thread (400 levels), which Swift
  /// cannot catch. Anything deeper is dropped, so nothing the shaper recurses into is deeper than this.
  static let maximumDepth = 16
  /// The deepest a document may be and still be handed to Foundation's parser, which is recursive too and
  /// overflowed a 512 KB stack at 512 levels (and a 256 KB one at 400) before any of this code ran. A
  /// deeper one is cut as text, which is what anything that is not JSON gets.
  static let maximumParseDepth = 64
  /// How many leading hits share the room at most, and the least one is given before fewer share it.
  static let maximumBreadth = 3
  private static let minimumShareBytes = 220
  /// How long a string may be, longest first; a hit over its share steps down this list.
  private static let stringCaps = [320, 200, 140, 100, 70, 50, 36, 24]
  /// A hit that has to lose members keeps at least this many: what it is, where it lives, what it is called.
  private static let minimumMembers = 3
  /// The cap on the strings of an envelope's own header (its summary is one sentence).
  private static let headerStringCap = 200

  static func shape(_ text: String, budgetBytes: Int) -> String {
    let budget = max(budgetBytes, minimumBudgetBytes)

    guard text.utf8.count > budget else { return text }

    guard
      nests(text, atMost: maximumParseDepth),
      let value = try? JSONSerialization.jsonObject(
        with: Data(text.utf8), options: [.fragmentsAllowed])
    else { return truncated(text, to: budget) }

    let shaped: String?

    switch prune(value, depth: 0) {
    case let items as [Any]:
      shaped = bound(items, lead: "[", tail: "]", budget: budget)
    case let object as [String: Any]:
      shaped = lists(in: object, budget: budget)
    case let scalar?:
      shaped = json(capStrings(in: scalar, to: stringCaps[0]))
    case nil:
      shaped = value is [Any] ? "[]" : "{}"
    }

    // A capped-but-broken tail beats an overflowed window, which loses the whole turn. What is cut is
    // the pruned, compact text where there is one: several times denser than what the appliance sent.
    guard let shaped else { return truncated(compact(value) ?? text, to: budget) }

    return shaped.utf8.count <= budget ? shaped : truncated(shaped, to: budget)
  }

  /// Whether the brackets of `text` nest no deeper than `limit`, counted without parsing: a string's contents
  /// (and an escaped quote in it) are skipped, everything else that opens or closes a container is counted.
  private static func nests(_ text: String, atMost limit: Int) -> Bool {
    var depth = 0
    var inString = false
    var escaped = false

    for byte in text.utf8 {
      if inString {
        if escaped { escaped = false } else if byte == 0x5C { escaped = true } else if byte == 0x22 { inString = false }
        continue
      }

      switch byte {
      case 0x22: inString = true
      case 0x7B, 0x5B:
        depth += 1
        if depth > limit { return false }
      case 0x7D, 0x5D: depth -= 1
      default: break
      }
    }

    return true
  }

  /// The pruned value as compact JSON, or nil when there is none to write.
  private static func compact(_ value: Any) -> String? {
    prune(value, depth: 0).flatMap { json($0) }
  }

  /// Cuts `text` to `budget` bytes, at a character boundary, ending in ``truncationMarker``.
  static func truncated(_ text: String, to budget: Int) -> String {
    guard text.utf8.count > budget else { return text }

    let room = max(0, budget - truncationMarker.utf8.count)
    var used = 0
    var kept = String.UnicodeScalarView()

    for scalar in text.unicodeScalars {
      let width = UTF8.width(scalar)
      guard used + width <= room else { break }
      kept.append(scalar)
      used += width
    }

    return String(kept) + truncationMarker
  }

  // MARK: Pruning

  /// Removes what tells the model nothing, recursively; `nil` when nothing is left.
  ///
  /// - `null`, `""`, `false`, `[]` and `{}`: an unset column.
  /// - a string that is a bare UUID, except an `id` that is the hit's only address: a foreign key
  ///   (`threadId`, `connectionId`, `userId`…). The model cannot read one and no tool it has takes an id.
  /// - `id` when the hit has a `link`, which already carries it, and `entityType` next to a `type`.
  ///
  /// Numbers, `true` and every non-empty string stay, and so does the order of an array. A container
  /// deeper than ``maximumDepth`` goes.
  private static func prune(_ value: Any, depth: Int) -> Any? {
    switch value {
    case let string as String:
      return string.isEmpty ? nil : string
    case let array as [Any]:
      guard depth < maximumDepth else { return nil }

      let kept = array.compactMap { element -> Any? in
        if let string = element as? String, isUUID(string) { return nil }

        return prune(element, depth: depth + 1)
      }

      return kept.isEmpty ? nil : kept
    case let object as [String: Any]:
      guard depth < maximumDepth else { return nil }

      // Only a link and a type that survive make the id and the entityType redundant: an empty `link` and a
      // null `type` are pruned themselves, and dropping the id or entityType beside them left nothing at all.
      let linked = (object["link"] as? String).map { !$0.isEmpty } ?? false
      let typed = object["type"].flatMap { prune($0, depth: depth + 1) } != nil
      var kept: [String: Any] = [:]

      for (key, member) in object {
        if key == "entityType", typed { continue }
        if key == "id", linked { continue }
        if let string = member as? String, key != "id", key != "link", isUUID(string) { continue }
        if timeKeys.contains(key), let string = member as? String {
          guard let rendered = renderedTime(string) else { continue }

          kept[key] = rendered
          continue
        }
        guard let pruned = prune(member, depth: depth + 1) else { continue }

        kept[key] = pruned
      }

      return kept.isEmpty ? nil : kept
    case let number as NSNumber:
      if CFGetTypeID(number) == CFBooleanGetTypeID() { return number.boolValue ? number : nil }

      return number
    case is NSNull:
      return nil
    default:
      return value
    }
  }

  private static func isUUID(_ string: String) -> Bool {
    string.utf8.count == 36 && UUID(uuidString: string) != nil
  }

  // MARK: Fitting

  /// An object that carries lists: the members that are not lists whole (strings capped, `summary` first —
  /// the one sentence a small model reads reliably), then each list bounded to an equal share of what the
  /// rest left. A search envelope (`{summary, …, items:[…]}`) is the one-list case; `memory.recall`'s graph
  /// (`{nodes:[…], edges:[…]}`) is two, and keeping a few edges beside a few nodes beats keeping every
  /// node and no edge, because the edges are what says how the people relate. An object with no list is
  /// ``fit(_:into:)``.
  private static func lists(in object: [String: Any], budget: Int) -> String? {
    let listKeys = object.filter { isList($0.value) }.map(\.key).sorted { lhs, rhs in
      // `items` first, then the rest by the order `members(of:)` writes them in, then by name.
      let (left, right) = (lhs == "items" ? (-1, 0) : rank(lhs), rhs == "items" ? (-1, 0) : rank(rhs))
      if left.0 != right.0 { return left.0 < right.0 }
      if left.1 != right.1 { return left.1 < right.1 }

      return lhs < rhs
    }

    guard !listKeys.isEmpty else { return fit(object, into: budget) }

    var header = object
    for key in listKeys { header[key] = nil }

    guard
      let capped = capStrings(in: header, to: headerStringCap) as? [String: Any],
      let members = header.isEmpty ? [] : members(of: capped)
    else { return nil }

    var text = "{" + members.map { $0 + "," }.joined()
    var room = budget - text.utf8.count - 1  // the closing brace

    for (index, key) in listKeys.enumerated() {
      guard let items = object[key] as? [Any], let name = quoted(key) else { return nil }

      let share = room / (listKeys.count - index)
      let lead = name + ":["
      guard let list = bound(items, lead: lead, tail: "]", budget: share) else { return nil }

      text += list + (index < listKeys.count - 1 ? "," : "")
      room -= list.utf8.count + 1
    }

    return text + "}"
  }

  /// A list is an array of two or more things with parts of their own — hits, nodes, edges. An array of
  /// plain values (`tags`, `labels`) is one member of the object it is in, and is dropped like one when the
  /// object has to lose members: treating it as a list left the object's other members written whole.
  private static func isList(_ value: Any) -> Bool {
    guard let array = value as? [Any], array.count > 1 else { return false }

    return array.contains { $0 is [String: Any] }
  }

  /// Leading hits written in `lead … tail`, each held to an equal share of the room (the first
  /// ``maximumBreadth`` of them; the rest take what is left), then a closing element saying how many
  /// were left out. Nil when not even the first hit can be made to fit. `lead` and `tail` are the list's
  /// own text, brackets included: `[` and `]` for a bare list, `"items":[` and `]` inside an object.
  private static func bound(_ items: [Any], lead: String, tail: String, budget: Int) -> String? {
    let frame = lead.utf8.count + tail.utf8.count

    // First every hit, with nothing held back: when all of them fit there is no note to make room for.
    if let everything = take(items, room: budget - frame), everything.count == items.count {
      return lead + everything.joined(separator: ",") + tail
    }

    // Otherwise some are left out, and the closing note has to fit as well: room for it (and the comma
    // before it) is held back, sized for the largest count it could carry, so it cannot overflow.
    guard
      let note = omissionNote(items.count),
      let kept = take(items, room: budget - frame - note.utf8.count - 1),
      !kept.isEmpty || items.isEmpty
    else { return nil }

    guard items.count > kept.count else { return lead + kept.joined(separator: ",") + tail }
    guard let closing = omissionNote(items.count - kept.count) else { return nil }

    return lead + (kept + [closing]).joined(separator: ",") + tail
  }

  /// The leading hits that fit in `room`, each as JSON, the first ``maximumBreadth`` held to an equal share.
  private static func take(_ items: [Any], room: Int) -> [String]? {
    var room = room
    let breadth = breadth(of: items.count, room: room)
    var kept: [String] = []

    for (index, item) in items.enumerated() {
      let separator = kept.isEmpty ? 0 : 1
      let share = index < breadth ? room / (breadth - index) : room

      guard let text = fit(item, into: share - separator) else { break }

      kept.append(text)
      room -= text.utf8.count + separator
    }

    return kept
  }

  /// How many hits share `room`: ``maximumBreadth``, fewer when a share would be under
  /// ``minimumShareBytes`` — two readable hits beat three that are only addresses.
  private static func breadth(of count: Int, room: Int) -> Int {
    var breadth = min(maximumBreadth, max(count, 1))

    while breadth > 1, room / breadth < minimumShareBytes { breadth -= 1 }

    return breadth
  }

  /// `item` as compact JSON in at most `limit` bytes: whole if it fits, else with its strings
  /// shortened a step at a time, else with members dropped from the end of its order, never below
  /// ``minimumMembers``. A string element becomes a quoted string, so every hit is a JSON value.
  private static func fit(_ item: Any, into limit: Int) -> String? {
    guard limit > 0 else { return nil }

    for cap in stringCaps {
      guard let text = json(capStrings(in: item, to: cap)) else { return nil }
      if text.utf8.count <= limit { return text }
    }

    guard
      let object = item as? [String: Any],
      let ordered = members(of: capStrings(in: object, to: stringCaps.last ?? 24) as? [String: Any] ?? object)
    else { return nil }

    // The longest run of leading members that fits, in one pass: measuring every prefix afresh is
    // quadratic, and 8 000 members took 45 seconds.
    var size = 2  // the braces
    var keep = 0

    for (index, member) in ordered.enumerated() {
      size += member.utf8.count + (index > 0 ? 1 : 0)
      if size > limit { break }

      keep = index + 1
    }

    guard keep >= minimumMembers else { return nil }

    return "{" + ordered.prefix(keep).joined(separator: ",") + "}"
  }

  /// Caps every string in `value` at `cap` characters. A communication's `content` is unbounded; the
  /// model needs the gist and the identifiers, not the transcript. A `link` is only useful whole, and
  /// it is short: it is never shortened.
  private static func capStrings(in value: Any, to cap: Int) -> Any {
    switch value {
    case let string as String:
      return string.count > cap ? String(string.prefix(cap)) + "…" : string
    case let array as [Any]:
      return array.map { capStrings(in: $0, to: cap) }
    case let object as [String: Any]:
      return object.reduce(into: [String: Any]()) { result, member in
        result[member.key] =
          member.key == "link" && member.value is String
          ? member.value : capStrings(in: member.value, to: cap)
      }
    default:
      return value
    }
  }

  // MARK: Writing JSON

  /// Compact JSON for a parsed value, or nil when it has none (a non-finite number).
  ///
  /// Written out here instead of through `JSONSerialization.data` for three reasons. Foundation
  /// prints 0.8123 as 0.81230000000000002, which costs tokens and reads as noise. It raises an
  /// Objective-C exception on a non-finite number, which Swift cannot catch. And it orders keys
  /// alphabetically, where ``members(of:)`` writes what identifies an object first, so a cut that has
  /// to lose something loses bookkeeping before the identifiers.
  private static func json(_ value: Any) -> String? {
    switch value {
    case let string as String:
      return quoted(string)
    case let array as [Any]:
      var elements: [String] = []

      for element in array {
        guard let text = json(element) else { return nil }
        elements.append(text)
      }

      return "[" + elements.joined(separator: ",") + "]"
    case let object as [String: Any]:
      return members(of: object).map { "{" + $0.joined(separator: ",") + "}" }
    case let number as NSNumber:
      return literal(number)
    case is NSNull:
      return "null"
    default:
      return nil
    }
  }

  /// Keys written ahead of every other, in this order. `summary` is the search envelope's one
  /// sentence, which a small model reads reliably; `type` and `link` are on every search hit (the
  /// appliance adds them) and `link` is the only address the model may hand the user; `title`,
  /// `name` and `subject` are what the entities call themselves.
  private static let identityKeys = ["summary", "type", "link", "title", "name", "subject"]

  /// When it happened, then what it says: the two things a question about the user's own memory asks.
  private static let timeKeys = [
    "startTime", "endTime", "time", "dueDate", "date", "createdAt", "takenAt", "birthDate",
  ]

  /// An ISO 8601 instant as the appliance writes one (`2022-11-28T06:45:59.000Z`, with or without
  /// fractional seconds, `Z` or an offset): the date, the hour-and-minute and the offset part.
  private static let isoInstant = try! NSRegularExpression(
    pattern: #"^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$"#)

  /// A time key's value as the model should read it: `2022-11-28 06:45 UTC` for an instant, a date
  /// (`1980-01-01`) untouched, anything else as it came. A 2B model copying the 24-character instant
  /// wrote `20202-1-128T06:5:59.00Z`; it copies a 16-character date-and-minute. Not converted to local
  /// time: both platforms must shape identically wherever the phone is. Same rule as the Kotlin shaper.
  private static func renderedTime(_ value: String) -> String? {
    if value.isEmpty { return nil }

    let whole = NSRange(value.startIndex..., in: value)

    guard let match = isoInstant.firstMatch(in: value, range: whole), match.numberOfRanges == 4,
      let date = Range(match.range(at: 1), in: value), let clock = Range(match.range(at: 2), in: value),
      let zone = Range(match.range(at: 3), in: value)
    else { return value }

    let offset = value[zone] == "Z" ? "UTC" : String(value[zone])

    return "\(value[date]) \(value[clock]) \(offset)"
  }
  private static let bodyKeys = ["content", "text", "description", "notes"]

  /// What the appliance stores with every row and a question never asks about. Written last, so a hit
  /// that has to lose members loses these first. They stay in when there is room: nothing here is
  /// wrong, only rarely the answer.
  private static let bookkeepingKeys: Set<String> = [
    "id", "updatedAt", "sourceId", "sourceType", "sourceSystem", "externalId", "externalIdKind",
    "timeSource", "timePrecision", "sentimentScore", "importanceScore", "urgencyScore",
    "energyLevel", "confidenceScore", "isInferred", "isPredicted", "inferenceSources", "metadata",
    "searchContent", "preview", "isActive", "isSelf", "mimeCategory", "mimetype", "priority",
    "communicationType", "importance",
  ]

  /// Where a key sorts: identity, then time, then body, then everything unknown, then bookkeeping.
  private static func rank(_ key: String) -> (group: Int, index: Int) {
    if let index = identityKeys.firstIndex(of: key) { return (0, index) }
    if let index = timeKeys.firstIndex(of: key) { return (1, index) }
    if let index = bodyKeys.firstIndex(of: key) { return (2, index) }
    if bookkeepingKeys.contains(key) { return (4, 0) }

    return (3, 0)
  }

  /// An object's members as `"key":value` text in the order of ``rank(_:)``; within a group the
  /// shortest value first (ties by key). Nil when any value has no JSON form.
  private static func members(of object: [String: Any]) -> [String]? {
    var entries: [(key: String, size: Int, member: String)] = []

    for (key, value) in object {
      guard let name = quoted(key), let text = json(value) else { return nil }
      entries.append((key, text.utf8.count, "\(name):\(text)"))
    }

    entries.sort { lhs, rhs in
      let (left, right) = (rank(lhs.key), rank(rhs.key))
      if left.group != right.group { return left.group < right.group }
      if left.index != right.index { return left.index < right.index }

      if lhs.size != rhs.size { return lhs.size < rhs.size }
      if lhs.key != rhs.key { return lhs.key < rhs.key }

      // Two keys that are canonically equivalent compare equal as Strings; the code points settle it, so the
      // order does not depend on the dictionary's.
      return lhs.key.unicodeScalars.lexicographicallyPrecedes(rhs.key.unicodeScalars)
    }

    return entries.map(\.member)
  }

  /// A string as a JSON literal. Slashes stay as they are: `\/` costs a byte apiece in every link.
  private static func quoted(_ string: String) -> String? {
    guard
      let data = try? JSONSerialization.data(
        withJSONObject: [string], options: [.withoutEscapingSlashes])
    else { return nil }

    // Without the brackets that were added around it.
    return String(decoding: data.dropFirst().dropLast(), as: UTF8.self)
  }

  /// A number as a JSON literal: `true`/`false` for a boolean (identified by type — 1 and 0 are
  /// numbers), the shortest form that reads back for a double, nil for one JSON cannot carry.
  private static func literal(_ number: NSNumber) -> String? {
    if CFGetTypeID(number) == CFBooleanGetTypeID() { return number.boolValue ? "true" : "false" }

    switch String(cString: number.objCType) {
    case "f", "d":
      let value = number.doubleValue

      return value.isFinite ? value.description : nil
    case "Q":
      return String(number.uint64Value)
    default:
      return String(number.int64Value)
    }
  }
}
