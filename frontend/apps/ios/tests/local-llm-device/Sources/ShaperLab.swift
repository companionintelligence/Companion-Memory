import Foundation

/// Candidate changes to what `ToolResultShaper` does, tried here before any of them moves into the
/// app. Each is a step in front of the production shaper, so the production code under test is
/// unchanged: `ToolResultShaper.shape(ShaperLab.prepare(raw, variant), budgetBytes:)`.
enum ShaperLab {
  /// What the model is handed for `raw` under `variant`, within `budget` bytes.
  ///
  /// - `legacy`: `ToolResultShaper` as it was on main (a snapshot, `LegacyShaper.swift`).
  /// - `prod`: `ToolResultShaper` as it is in the app now.
  /// - `lean`: the legacy shaper after dropping what carries no information.
  /// - `digest`: one line of prose per hit instead of the hit's JSON, still a valid JSON document.
  static func shape(_ raw: String, variant: String, budget: Int) -> String {
    switch variant {
    case "lean":
      return LegacyToolResultShaper.shape(lean(raw, dropIdsWhenLinked: true), budgetBytes: budget)
    case "lean2":
      return lean2Shape(raw, budget: budget, breadth: 1)
    case "lean3":
      return lean2Shape(raw, budget: budget, breadth: 3)
    case "lean4":
      return lean4Shape(raw, budget: budget, breadth: 3)
    case "digest":
      return digestShape(raw, budget: budget)
    case "prod":
      return ToolResultShaper.shape(raw, budgetBytes: budget)
    default:
      // `legacy`, and `shipped` as the first plans called it: the shaper on main before the redesign.
      return LegacyToolResultShaper.shape(raw, budgetBytes: budget)
    }
  }

  // MARK: lean2

  // What identifies a hit, then when it happened, then what it says; the bookkeeping the appliance
  // stores with every row goes last, where a cut costs least. Unknown keys sit in between, shortest
  // value first, as in the shipped shaper.
  private static let identityKeys = ["type", "link", "title", "name", "subject"]
  private static let timeKeys = [
    "startTime", "endTime", "time", "dueDate", "date", "createdAt", "takenAt", "birthDate",
  ]
  private static let bodyKeys = ["content", "text", "description", "notes"]
  private static let bookkeepingKeys: Set<String> = [
    "id", "updatedAt", "sourceId", "sourceType", "sourceSystem", "externalId", "externalIdKind",
    "timeSource", "timePrecision", "sentimentScore", "importanceScore", "urgencyScore",
    "energyLevel", "confidenceScore", "isInferred", "isPredicted", "inferenceSources", "metadata",
    "searchContent", "preview", "isActive", "isSelf", "mimeCategory", "mimetype", "priority",
    "communicationType", "importance",
  ]

  private static func rank(_ key: String) -> (Int, Int) {
    if let index = identityKeys.firstIndex(of: key) { return (0, index) }
    if let index = timeKeys.firstIndex(of: key) { return (1, index) }
    if let index = bodyKeys.firstIndex(of: key) { return (2, index) }
    if bookkeepingKeys.contains(key) { return (4, 0) }

    return (3, 0)
  }

  /// A pruned value written as compact JSON, strings capped at `cap` characters and members ordered
  /// by `rank`. Returns the text and the members of the top object in the order they were written.
  private static func write(_ value: Any, cap: Int, dropFrom keep: Int? = nil) -> String {
    switch value {
    case let string as String:
      return J.quote(string.count > cap ? String(string.prefix(cap)) + "…" : string)
    case let array as [Any]:
      return "[" + array.map { write($0, cap: cap) }.joined(separator: ",") + "]"
    case let object as [String: Any]:
      // A link is only useful whole, and it is short: it is never shortened.
      let members = object.map {
        (key: $0.key, text: write($0.value, cap: $0.key == "link" ? Int.max : cap))
      }
        .sorted { lhs, rhs in
          let (a, b) = (rank(lhs.key), rank(rhs.key))
          if a != b { return a < b }

          return (lhs.text.utf8.count, lhs.key) < (rhs.text.utf8.count, rhs.key)
        }
      let kept = keep.map { Array(members.prefix($0)) } ?? members

      return "{" + kept.map { J.quote($0.key) + ":" + $0.text }.joined(separator: ",") + "}"
    case let number as NSNumber:
      if CFGetTypeID(number) == CFBooleanGetTypeID() { return number.boolValue ? "true" : "false" }

      return number.stringValue
    default:
      return "null"
    }
  }

  /// The shipped shaper's job, done so that a hit stays a hit: pruned, its fields in an order that
  /// puts the answer first, strings shortened a step at a time and — only when that is not enough —
  /// its last fields dropped, instead of falling back to a cut-off string of escaped JSON.
  static func lean2Shape(_ raw: String, budget: Int, breadth: Int) -> String {
    guard
      let parsed = try? JSONSerialization.jsonObject(with: Data(raw.utf8), options: [.fragmentsAllowed]),
      let value = prune(parsed, dropIdsWhenLinked: true)
    else { return ToolResultShaper.shape(raw, budgetBytes: budget) }

    var summary: String?
    var total: Any?
    var items: [Any]

    if let object = value as? [String: Any], let list = object["items"] as? [Any] {
      summary = object["summary"] as? String
      total = object["totalMatches"]
      items = list
    } else if let list = value as? [Any] {
      items = list
    } else {
      return ToolResultShaper.shape(raw, budgetBytes: budget)
    }

    var header = ""
    if let summary { header += "\(J.quote("summary")):\(J.quote(summary))," }
    if let total { header += "\(J.quote("totalMatches")):\(write(total, cap: 40))," }

    let lead = "{" + header + "\"items\":["
    let tail = "]}"
    var room = max(0, budget - lead.utf8.count - tail.utf8.count - 64)
    var lines: [String] = []

    // How long a string may be: the longest cap at which the first `breadth` hits all fit whole. One
    // hit (`breadth` 1) gets as much text as the room allows; three share it.
    let caps = [320, 200, 140, 100, 70, 50, 36, 24]
    let want = min(breadth, items.count)
    var chosen = caps.last ?? 24

    for cap in caps {
      var spent = 0
      var fitting = 0

      for item in items.prefix(want) {
        let cost = write(item, cap: cap).utf8.count + (fitting == 0 ? 0 : 1)
        guard spent + cost <= room else { break }
        spent += cost
        fitting += 1
      }

      if fitting >= want {
        chosen = cap

        break
      }
    }

    for item in items {
      var line = write(item, cap: chosen)
      var cost = line.utf8.count + (lines.isEmpty ? 0 : 1)

      if cost > room, lines.isEmpty, let object = item as? [String: Any] {
        // Even the smallest strings leave the first hit too big: drop members from the end of the
        // order until it fits.
        var keep = object.count
        while keep > 2 {
          keep -= 1
          line = write(object, cap: chosen, dropFrom: keep)
          cost = line.utf8.count
          if cost <= room { break }
        }
      }

      guard cost <= room else { break }

      lines.append(line)
      room -= cost
    }

    let omitted = items.count - lines.count
    var out = lines
    if omitted > 0 { out.append(J.quote("[\(omitted) more results omitted]")) }

    return lead + out.joined(separator: ",") + tail
  }

  // MARK: lean4

  /// `lean2`'s pruning and ordering, but the room is shared: each of the first `breadth` hits gets an
  /// equal share, and a hit that is over its share first shortens its strings, then loses members from
  /// the end of its order. Three different hits beat one long one for "what do I know about…".
  static func lean4Shape(_ raw: String, budget: Int, breadth: Int) -> String {
    guard
      let parsed = try? JSONSerialization.jsonObject(with: Data(raw.utf8), options: [.fragmentsAllowed]),
      let value = prune(parsed, dropIdsWhenLinked: true)
    else { return ToolResultShaper.shape(raw, budgetBytes: budget) }

    var header = ""
    var items: [Any]

    if let object = value as? [String: Any], let list = object["items"] as? [Any] {
      if let summary = object["summary"] as? String { header += "\(J.quote("summary")):\(J.quote(summary))," }
      if let total = object["totalMatches"] { header += "\(J.quote("totalMatches")):\(write(total, cap: 40))," }
      items = list
    } else if let list = value as? [Any] {
      items = list
    } else {
      return ToolResultShaper.shape(raw, budgetBytes: budget)
    }

    let lead = "{" + header + "\"items\":["
    var room = max(0, budget - lead.utf8.count - 2 - 64)
    var lines: [String] = []

    for (index, item) in items.enumerated() {
      let remaining = max(1, min(breadth, items.count) - index)
      let share = index < breadth ? room / remaining : room
      let separator = lines.isEmpty ? 0 : 1

      guard let line = fit(item, into: share - separator) else { break }

      lines.append(line)
      room -= line.utf8.count + separator
    }

    var out = lines
    let omitted = items.count - lines.count
    if omitted > 0 { out.append(J.quote("[\(omitted) more results omitted]")) }

    return lead + out.joined(separator: ",") + "]}"
  }

  /// `item` as compact JSON in at most `limit` bytes: whole if it fits, else strings shortened a step
  /// at a time, else members dropped from the end of the order (never below three).
  private static func fit(_ item: Any, into limit: Int) -> String? {
    guard limit > 0 else { return nil }

    let whole = write(item, cap: 320)
    if whole.utf8.count <= limit { return whole }

    for cap in [200, 140, 100, 70, 50, 36, 24] {
      let line = write(item, cap: cap)
      if line.utf8.count <= limit { return line }
    }

    guard let object = item as? [String: Any] else { return nil }

    for cap in [100, 50, 24] {
      var keep = object.count
      while keep > 3 {
        keep -= 1
        let line = write(object, cap: cap, dropFrom: keep)
        if line.utf8.count <= limit { return line }
      }
    }

    return nil
  }

  // MARK: digest

  /// `{"summary":"…","items":["note \"Title\" 2025-03-08: the start of the text… /notes/…", …]}`.
  ///
  /// The shipped shaper keeps a hit as JSON, so when the first hit alone is bigger than the room it
  /// falls back to a preview: that hit's JSON written *as a string*, every quote escaped, cut
  /// wherever the budget ends. This writes what the model needs to read — what the hit is, what it
  /// is called, when, where, who, the start of its text, and its link last, where a cut costs least.
  static func digestShape(_ raw: String, budget: Int) -> String {
    guard
      let value = try? JSONSerialization.jsonObject(with: Data(raw.utf8), options: [.fragmentsAllowed])
    else { return ToolResultShaper.truncated(raw, to: budget) }

    var summary: String?
    var items: [Any] = []

    if let object = value as? [String: Any], let list = object["items"] as? [Any] {
      summary = object["summary"] as? String
      items = list
    } else if let list = value as? [Any] {
      items = list
    } else {
      return ToolResultShaper.shape(raw, budgetBytes: budget)
    }

    let lead = "{" + (summary.map { "\(J.quote("summary")):\(J.quote($0))," } ?? "") + "\"items\":["
    let tail = "]}"
    let noteReserve = 40
    var room = max(0, budget - lead.utf8.count - tail.utf8.count - noteReserve)
    var lines: [String] = []

    for item in items {
      let full = digestLine(item, bodyLimit: 240, link: true)
      let cost = J.quote(full).utf8.count + (lines.isEmpty ? 0 : 1)

      if cost <= room {
        lines.append(full)
        room -= cost

        continue
      }

      // The first hit that does not fit whole is cut to the room that is left, rather than dropped,
      // and without its link: the start of what it says matters more than where it lives.
      var limit = 240
      while limit >= 16, room >= 48 {
        let cut = digestLine(item, bodyLimit: limit, link: false)

        if J.quote(cut).utf8.count + (lines.isEmpty ? 0 : 1) <= room {
          lines.append(cut)

          break
        }

        limit -= 16
      }

      let omitted = items.count - lines.count
      if omitted > 0 { lines.append("[\(omitted) more results omitted]") }

      return lead + lines.map { J.quote($0) }.joined(separator: ",") + tail
    }

    return lead + lines.map { J.quote($0) }.joined(separator: ",") + tail
  }

  private static func digestLine(_ item: Any, bodyLimit: Int, link: Bool) -> String {
    guard let object = item as? [String: Any] else { return String(describing: item) }

    func text(_ keys: [String], in source: [String: Any]? = nil) -> String? {
      for key in keys {
        if let value = (source ?? object)[key] as? String, !value.isEmpty { return value }
      }

      return nil
    }

    let type = text(["type"]) ?? "item"
    let source = object["sourceData"] as? [String: Any]
    let properties = object["properties"] as? [String: Any]
    let from = ((object["participantsMetadata"] as? [String: Any])?["from"] as? [String: Any])
      .flatMap { text(["name"], in: $0) }
    let title = text(["title", "name", "subject"])
    let body = text(["content", "text", "description"]) ?? properties.flatMap { text(["notes"], in: $0) }

    var head = type
    if let from { head += " from \(from)" }
    if let title { head += " \"\(title)\"" }

    if type == "person" {
      // What a person *is* — not when the row was created.
      let facts = [
        [text(["jobTitle"]), text(["organization"])].compactMap { $0 }.joined(separator: " at "),
        text(["city"]).map { "in \($0)" } ?? "",
        text(["birthDate"]).map { "born \($0)" } ?? "",
      ].filter { !$0.isEmpty }

      if !facts.isEmpty { head += " (" + facts.joined(separator: ", ") + ")" }
    } else {
      let when = text(["startTime", "time", "createdAt", "dueDate"]).map { String($0.prefix(16)) + "Z" }
      let place = text(["locationName"]) ?? source.flatMap { text(["place"], in: $0) }

      if let when { head += " " + when }
      if let place { head += " at \(place)" }
    }

    var line = head
    if let body {
      let clipped = body.count > bodyLimit ? String(body.prefix(bodyLimit)) + "…" : body
      line += ": " + clipped
    }
    if link, let address = text(["link"]) { line += " " + address }

    return line
  }

  /// Removes members that tell the model nothing and cost bytes the budget cannot spare:
  ///
  /// - `null`, `""`, `[]`, `{}` and `false` — an unset column. The appliance writes every column of
  ///   an entity, so most members of a hit are one of these.
  /// - a string that is a bare UUID — a foreign key (`threadId`, `connectionId`, `userId`…). The
  ///   model cannot read it and none of the tools it has takes an id.
  /// - `id` when the hit has a `link`, which already carries it.
  /// - `entityType`, which repeats `type`.
  ///
  /// A result that is not JSON is returned as it came. Valid JSON in, valid JSON out.
  static func lean(_ text: String, dropIdsWhenLinked: Bool) -> String {
    guard
      let value = try? JSONSerialization.jsonObject(with: Data(text.utf8), options: [.fragmentsAllowed]),
      let pruned = prune(value, dropIdsWhenLinked: dropIdsWhenLinked),
      let data = try? JSONSerialization.data(
        withJSONObject: pruned, options: [.fragmentsAllowed, .withoutEscapingSlashes])
    else { return text }

    return String(decoding: data, as: UTF8.self)
  }

  private static func prune(_ value: Any, dropIdsWhenLinked: Bool) -> Any? {
    switch value {
    case let string as String:
      return string.isEmpty || isUUID(string) ? nil : string
    case let array as [Any]:
      let kept = array.compactMap { prune($0, dropIdsWhenLinked: dropIdsWhenLinked) }

      return kept.isEmpty ? nil : kept
    case let object as [String: Any]:
      var kept: [String: Any] = [:]
      let linked = object["link"] is String

      for (key, member) in object {
        if key == "entityType" || (dropIdsWhenLinked && linked && key == "id") { continue }
        guard let pruned = prune(member, dropIdsWhenLinked: dropIdsWhenLinked) else { continue }

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
}
