import Foundation

// A synthetic memory — one made-up person's notes, messages, photos, calendar and contacts — shaped
// like what the appliance's `knowledge.search` hydrates and sends through MCP as
// `JSON.stringify(result, null, 2)`. Nothing in it is real: the bench is committed, so it must not
// carry anyone's data, and a fixed corpus is what makes two runs comparable.
//
// The *structure* is the real one (field names and nesting from the appliance's entity classes,
// UUIDv7 ids, ISO timestamps, `type` and `link` on every hit, the `summary`/`totalMatches`/
// `truncated`/`limit`/`mode` header) because what a token budget is spent on is mostly that
// structure, not the prose.

// MARK: - JSON, written the way JavaScript writes it

/// A JSON value with its keys in the order they were written, which `JSONSerialization` cannot keep.
indirect enum J: ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByFloatLiteral,
  ExpressibleByBooleanLiteral, ExpressibleByNilLiteral
{
  case string(String)
  case number(Double)
  case int(Int)
  case bool(Bool)
  case null
  case array([J])
  case object([(String, J)])

  init(stringLiteral value: String) { self = .string(value) }
  init(integerLiteral value: Int) { self = .int(value) }
  init(floatLiteral value: Double) { self = .number(value) }
  init(booleanLiteral value: Bool) { self = .bool(value) }
  init(nilLiteral: ()) { self = .null }

  static func obj(_ pairs: (String, J)...) -> J { .object(pairs) }

  /// `JSON.stringify(value, null, 2)`: two-space indent, `"key": value`, empty containers as
  /// `[]` / `{}`, slashes and non-ASCII left alone.
  func pretty(_ depth: Int = 0) -> String {
    let pad = String(repeating: "  ", count: depth + 1)
    let close = String(repeating: "  ", count: depth)

    switch self {
    case .string(let value): return J.quote(value)
    case .int(let value): return String(value)
    case .number(let value):
      return value == value.rounded() && abs(value) < 1e15 ? String(Int(value)) : String(value)
    case .bool(let value): return value ? "true" : "false"
    case .null: return "null"
    case .array(let elements):
      if elements.isEmpty { return "[]" }

      return "[\n" + elements.map { pad + $0.pretty(depth + 1) }.joined(separator: ",\n") + "\n" + close + "]"
    case .object(let pairs):
      if pairs.isEmpty { return "{}" }

      return "{\n"
        + pairs.map { pad + J.quote($0.0) + ": " + $0.1.pretty(depth + 1) }.joined(separator: ",\n")
        + "\n" + close + "}"
    }
  }

  static func quote(_ string: String) -> String {
    var out = "\""

    for scalar in string.unicodeScalars {
      switch scalar {
      case "\"": out += "\\\""
      case "\\": out += "\\\\"
      case "\n": out += "\\n"
      case "\r": out += "\\r"
      case "\t": out += "\\t"
      default:
        if scalar.value < 0x20 {
          out += String(format: "\\u%04x", scalar.value)
        } else {
          out.unicodeScalars.append(scalar)
        }
      }
    }

    return out + "\""
  }
}

// MARK: - Deterministic ids and times

/// SplitMix64: the same ids and the same distractors on every run, on every machine.
struct Rng {
  private var state: UInt64

  init(seed: UInt64) { state = seed }

  mutating func next() -> UInt64 {
    state &+= 0x9E37_79B9_7F4A_7C15
    var z = state
    z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
    z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB

    return z ^ (z >> 31)
  }

  mutating func pick<T>(_ items: [T]) -> T { items[Int(next() % UInt64(items.count))] }

  mutating func hex(_ digits: Int) -> String {
    var out = ""

    while out.count < digits { out += String(next(), radix: 16) }

    return String(out.prefix(digits))
  }

  /// A UUIDv7-shaped id, as `gen_uuid_v7()` writes them.
  mutating func uuid() -> String {
    "0199\(hex(4))-\(hex(4))-7\(hex(3))-9\(hex(3))-\(hex(12))"
  }
}

// MARK: - Entities, with the real field sets

private let userId = "0198f0aa-3b52-7c10-8e2d-6a9f01c4d377"
private let connectionId = "0198f0ab-91de-7a44-b5c1-2e07d8a6f410"

private func iso(_ year: Int, _ month: Int, _ day: Int, _ hour: Int, _ minute: Int) -> String {
  String(format: "%04d-%02d-%02dT%02d:%02d:00.000Z", year, month, day, hour, minute)
}

private func hit(_ type: String, _ id: String, _ page: String, _ fields: [(String, J)]) -> J {
  .object(fields + [("type", .string(type)), ("link", .string("\(page)/\(id)"))])
}

private func communication(
  _ rng: inout Rng, id: String, time: String, kind: String, inbound: Bool, from: String,
  subject: String?, content: String, tags: [String], category: String
) -> J {
  let preview = String(content.prefix(60)) + (content.count > 60 ? "…" : "")
  let address =
    kind == "email"
    ? "\(from.lowercased().replacingOccurrences(of: " ", with: "."))@example.com"
    : "+1510555\(String(format: "%04d", Int(rng.next() % 10_000)))"

  return hit(
    "communication", id, "/communications",
    [
      ("id", .string(id)), ("entityType", "communication"), ("time", .string(time)),
      ("userId", .string(userId)), ("communicationType", .string(kind)), ("deviceId", nil),
      ("direction", .string(inbound ? "inbound" : "outbound")),
      ("threadId", .string(rng.uuid())), ("fromEntityId", .string(rng.uuid())),
      ("toEntityIds", .array([.string(rng.uuid())])),
      (
        "participantsMetadata",
        .obj(
          ("from", .obj(("name", .string(from)), ("address", .string(address)))))
      ),
      (
        "metadata",
        .obj(
          ("platform", .string(kind == "email" ? "gmail" : "imessage")),
          ("service", .string(kind == "email" ? "Gmail" : "iMessage")),
          ("importBatch", .string("takeout-2026-09")), ("labels", .array(tags.map { .string($0) })))
      ),
      ("subject", subject.map { .string($0) } ?? .null), ("content", .string(content)),
      ("attachments", .array([])), ("durationSeconds", nil), ("sentimentScore", 0.42),
      ("importanceScore", 0.3), ("urgencyScore", 0.1), ("category", .string(category)),
      ("summary", nil), ("tags", .array(tags.map { .string($0) })),
      ("connectionId", .string(connectionId)), ("isEncrypted", false), ("isArchived", false),
      ("preview", .string(preview)), ("sourceType", "import"),
      ("sourceSystem", .string(kind == "email" ? "google_takeout" : "apple_messages")),
      ("sourceId", .string("msg-\(rng.hex(16))")),
    ])
}

private func event(
  _ rng: inout Rng, id: String, title: String, start: String, end: String, location: String?,
  category: String, status: String = "confirmed", tags: [String] = []
) -> J {
  hit(
    "event", id, "/events",
    [
      ("id", .string(id)), ("entityType", "event"), ("title", .string(title)),
      ("eventType", "calendar"), ("category", .string(category)), ("startTime", .string(start)),
      ("endTime", .string(end)), ("timeSource", "source"), ("timePrecision", "minute"),
      ("observedAt", nil), ("durationMinutes", 60),
      ("locationName", location.map { .string($0) } ?? .null),
      (
        "locationCoordinates",
        location == nil ? .null : .obj(("x", -122.2612), ("y", 37.8044))
      ),
      ("locationEntityId", location == nil ? .null : .string(rng.uuid())),
      ("participantEntityIds", .array([.string(rng.uuid())])),
      ("organizerEntityId", .string(rng.uuid())), ("sourceType", "calendar"),
      ("sourceSystem", "google_calendar"), ("sourceId", .string("evt_\(rng.hex(20))")),
      ("connectionId", .string(connectionId)), ("captureTickId", nil), ("confidenceScore", 1),
      ("isRecurring", false), ("recurrencePattern", nil), ("isAllDay", false),
      ("isPrivate", false), ("priority", 0),
      ("metadata", .obj(("htmlLink", .string("https://calendar.example.com/event?eid=\(rng.hex(24))")), ("reminders", .array([.obj(("method", "popup"), ("minutes", 30))])))),
      ("isPredicted", false), ("isInferred", false), ("inferenceSources", .obj()),
      ("tags", .array(tags.map { .string($0) })), ("sentimentScore", nil), ("energyLevel", nil),
      ("status", .string(status)), ("sourceStatus", .string(status)),
      ("sourceStartTime", .string(start)), ("sourceEndTime", .string(end)),
      ("sourceRecurrence", nil), ("sourceTitle", .string(title)),
    ])
}

private func note(_ rng: inout Rng, id: String, title: String, content: String, created: String) -> J {
  hit(
    "note", id, "/notes",
    [
      ("id", .string(id)), ("title", .string(title)), ("content", .string(content)),
      ("userId", .string(userId)), ("createdAt", .string(created)),
      ("updatedAt", .string(created)),
    ])
}

private func photo(
  _ rng: inout Rng, id: String, file: String, description: String, taken: String, place: String?
) -> J {
  hit(
    "content", id, "/content",
    [
      ("id", .string(id)), ("entityType", "content"), ("type", "photo"), ("title", .string(file)),
      ("text", .string(description)), ("mimetype", "image/jpeg"),
      ("externalId", .string("IMG-\(rng.hex(10))")), ("externalIdKind", "apple_photos"),
      ("sourceUrl", nil),
      (
        "sourceData",
        .obj(
          ("width", 4032), ("height", 3024), ("takenAt", .string(taken)),
          ("camera", "iPhone 15 Pro"), ("place", place.map { .string($0) } ?? .null))
      ),
      ("sourceType", "import"), ("sourceSystem", "apple_photos"),
      ("sourceId", .string("asset-\(rng.hex(16))")), ("connectionId", .string(connectionId)),
      ("userId", .string(userId)), ("eventId", nil), ("createdAt", .string(taken)),
      ("updatedAt", .string(taken)), ("mimeCategory", "image"), ("tags", .array([])),
    ])
}

private func person(
  _ rng: inout Rng, id: String, first: String, last: String, job: String?, org: String?,
  city: String, birthday: String?, notes: String
) -> J {
  hit(
    "person", id, "/people",
    [
      ("id", .string(id)), ("entityType", "person"), ("name", .string("\(first) \(last)")),
      ("firstName", .string(first)), ("middleName", nil), ("lastName", .string(last)),
      ("nickname", nil), ("pronouns", nil), ("gender", nil),
      ("birthDate", birthday.map { .string($0) } ?? .null),
      ("email", .string("\(first.lowercased()).\(last.lowercased())@example.com")),
      ("jobTitle", job.map { .string($0) } ?? .null),
      ("organization", org.map { .string($0) } ?? .null), ("department", nil), ("website", nil),
      ("addresses", .array([])), ("streetAddress", nil), ("city", .string(city)),
      ("region", "CA"), ("country", "US"), ("postalCode", nil), ("isSelf", false),
      ("isActive", true), ("mergedIntoEntityId", nil), ("linkedTable", nil), ("linkedId", nil),
      ("searchContent", .string("\(first) \(last) \(job ?? "") \(org ?? "") \(city)")),
      ("properties", .obj(("relationship", "friend"), ("notes", .string(notes)), ("importance", 0.7))),
      ("createdAt", .string(iso(2024, 11, 3, 18, 20))), ("updatedAt", .string(iso(2026, 9, 14, 9, 5))),
    ])
}

private func task(_ rng: inout Rng, id: String, title: String, due: String?, done: Bool) -> J {
  hit(
    "task", id, "/tasks",
    [
      ("id", .string(id)), ("title", .string(title)), ("description", nil),
      ("status", .string(done ? "completed" : "pending")), ("priority", "medium"),
      ("dueDate", due.map { .string($0) } ?? .null), ("completedAt", nil),
      ("userId", .string(userId)), ("tags", .array([])), ("createdAt", .string(iso(2026, 9, 1, 8, 0))),
      ("updatedAt", .string(iso(2026, 9, 1, 8, 0))),
    ])
}

// MARK: - The scenarios

/// A question the bench asks, what a good answer must carry, and what would show the model confused
/// a decoy for the answer.
struct BenchPrompt {
  let id: String
  let text: String
  /// Groups of acceptable spellings. An answer is *grounded* when it carries at least one group.
  let facts: [[String]]
  /// Present in a decoy hit and nowhere in the answer: an answer that says one of these took the
  /// wrong hit.
  let wrong: [String]
  /// What a query for this scenario is matched on in the fake appliance.
  let keys: [String]
}

enum Corpus {
  static let prompts: [String: BenchPrompt] = [
    "p1": BenchPrompt(
      id: "p1", text: "search my memory for blue heron",
      facts: [["Lake Merritt"], ["March 8", "Mar 8", "8 March", "2025-03-08"], ["Maria"]],
      wrong: ["Heron Street"], keys: ["heron"]),
    "p2": BenchPrompt(
      id: "p2", text: "what do I know about Maria Alvarez",
      facts: [["Lakeside Bakery", "baker"], ["Oakland"], ["June 14", "1989-06-14"]],
      wrong: ["Gonzalez", "Taqueria"], keys: ["maria", "alvarez"]),
    "p3": BenchPrompt(
      id: "p3", text: "when is my dentist appointment?",
      facts: [["October 9", "Oct 9", "9 October", "2025-10-09", "Thursday"], ["2:30", "14:30"]],
      wrong: ["April 2", "2024"], keys: ["dentist", "appointment", "dental"]),
  ]

  /// What the appliance answers a tool call with: the text of an MCP `CallToolResult`. A scenario
  /// is chosen by the words of the query; anything else is an honest empty result. `memory_recall` is a
  /// graph (`nodes`, `edges`), not a search envelope.
  static func result(tool: String, arguments: [String: Any]) -> String {
    if tool == "memory_recall" { return graph(around: (arguments["personName"] as? String) ?? "").pretty() }

    let query = ((arguments["query"] as? String) ?? (arguments["personName"] as? String) ?? "")
      .lowercased()

    for prompt in prompts.values.sorted(by: { $0.id < $1.id })
    where prompt.keys.contains(where: { query.contains($0) }) {
      return scenario(prompt.id).pretty()
    }

    return J.obj(
      ("summary", "No entries match."), ("totalMatches", 0), ("truncated", false), ("limit", 25),
      ("mode", "hybrid"), ("items", .array([]))
    ).pretty()
  }

  /// `memory.recall`'s output: `{seedEntityIds, nodes, edges, stats}`, with the real summaries — a node
  /// carries its id, type, name, description, a few properties and metadata; an edge carries its type and
  /// both endpoints by id and name. Around Maria Alvarez, or around the user when no one is named.
  static func graph(around name: String) -> J {
    var rng = Rng(seed: 0xFEED)
    let around = name.lowercased().contains("maria") || name.lowercased().contains("alvarez")

    func node(_ type: String, _ title: String, _ description: String?, _ properties: [(String, J)]) -> (id: String, json: J) {
      let id = rng.uuid()
      var fields: [(String, J)] = [("id", .string(id)), ("type", .string(type)), ("name", .string(title))]
      if let description { fields.append(("description", .string(description))) }
      if !properties.isEmpty { fields.append(("properties", .object(properties))) }
      fields.append((
        "metadata",
        .obj(("createdAt", .string(iso(2024, 11, 3, 18, 20))), ("updatedAt", .string(iso(2026, 9, 14, 9, 5))),
             ("linkedTable", nil), ("linkedId", .string(rng.uuid())))))

      return (id, .object(fields))
    }

    let me = node("person", "Sam Rivera", "The user.", [])
    let maria = node(
      "person", "Maria Alvarez", "Pastry chef at Lakeside Bakery in Oakland. Close friend since the 2019 pottery class.",
      [("relationship", "friend"), ("birthDate", "1989-06-14"), ("email", "maria.alvarez@example.com")])
    let bakery = node("organization", "Lakeside Bakery", "A bakery on the north shore of Lake Merritt.", [("category", "food")])
    let oakland = node("place", "Oakland", nil, [("region", "CA"), ("country", "US")])
    let pottery = node("concept", "Pottery class 2019", "Wheel-throwing evening class at the community studio.", [("year", 2019)])
    let tom = node("person", "Tom Becker", "Neighbor two doors down.", [("relationship", "neighbor")])
    let priya = node("person", "Dr. Priya Nair", "Dentist at Fremont Smile Dental.", [("relationship", "dentist")])

    let nodes = around ? [maria, me, bakery, oakland, pottery] : [me, maria, tom, priya, bakery, oakland, pottery]

    func edge(_ type: String, _ from: (id: String, json: J), _ to: (id: String, json: J), _ fromName: String, _ toName: String,
              _ properties: [(String, J)], strength: Double) -> J {
      .obj(
        ("id", .string(rng.uuid())), ("type", .string(type)),
        ("from", .obj(("id", .string(from.id)), ("name", .string(fromName)))),
        ("to", .obj(("id", .string(to.id)), ("name", .string(toName)))),
        ("properties", .object(properties)), ("strength", .number(strength)), ("bidirectional", .bool(type == "FRIEND_OF")))
    }

    var edges = [
      edge("FRIEND_OF", me, maria, "Sam Rivera", "Maria Alvarez", [("since", "2019")], strength: 0.8),
      edge("WORKS_AT", maria, bakery, "Maria Alvarez", "Lakeside Bakery", [("role", "Pastry chef")], strength: 0.9),
      edge("LIVES_IN", maria, oakland, "Maria Alvarez", "Oakland", [], strength: 0.9),
      edge("ATTENDED", maria, pottery, "Maria Alvarez", "Pottery class 2019", [], strength: 0.6),
      edge("ATTENDED", me, pottery, "Sam Rivera", "Pottery class 2019", [], strength: 0.6),
    ]
    if !around {
      edges += [
        edge("NEIGHBOR_OF", me, tom, "Sam Rivera", "Tom Becker", [], strength: 0.5),
        edge("PATIENT_OF", me, priya, "Sam Rivera", "Dr. Priya Nair", [("since", "2022")], strength: 0.4),
        edge("LIVES_IN", me, oakland, "Sam Rivera", "Oakland", [], strength: 0.9),
      ]
    }

    return .obj(
      ("seedEntityIds", .array([.string(maria.id)])), ("nodes", .array(nodes.map(\.json))), ("edges", .array(edges)),
      ("stats", .obj(("nodeCount", .int(nodes.count)), ("edgeCount", .int(edges.count)),
                      ("truncatedNodes", false), ("truncatedEdges", false))))
  }

  static func scenario(_ id: String) -> J {
    var rng = Rng(seed: 0xC0FFEE ^ id.utf8.reduce(UInt64(0)) { $0 &* 31 &+ UInt64($1) })
    let relevant = relevantItems(id, &rng)
    let decoys = decoyItems(id, count: 25 - relevant.count, &rng)

    return .obj(
      ("summary", .string("Showing the top 25 of at least 25 matches. The count is not exact.")),
      ("totalMatches", nil), ("truncated", true), ("limit", 25), ("mode", "hybrid"),
      ("items", .array(relevant + decoys)))
  }

  // MARK: Scenario p1 — "blue heron"

  private static func relevantItems(_ id: String, _ rng: inout Rng) -> [J] {
    switch id {
    case "p1":
      return [
        note(
          &rng, id: rng.uuid(), title: "Heron spotting at Lake Merritt",
          content:
            "Saturday March 8, 2025. Got to Lake Merritt at 7:15 am, before the joggers. A great blue heron was standing in the shallows near the boathouse for almost twenty minutes, perfectly still, then caught a fish and flew off toward the Rotary Nature Center. Maria met me there with the good camera. Want to go back in April when the nesting starts.",
          created: iso(2025, 3, 8, 18, 4)),
        communication(
          &rng, id: rng.uuid(), time: iso(2025, 3, 8, 17, 42), kind: "sms", inbound: true,
          from: "Maria Alvarez", subject: nil,
          content:
            "Did you see the blue heron by the boathouse this morning?? I sent the best photo to your email. Lake Merritt never disappoints. Same time next Saturday?",
          tags: ["birding"], category: "personal"),
        photo(
          &rng, id: rng.uuid(), file: "IMG_4412.jpeg",
          description:
            "A great blue heron standing in shallow water at the edge of a lake, early morning light, reeds in the background.",
          taken: iso(2025, 3, 8, 15, 21), place: "Lake Merritt, Oakland"),
        event(
          &rng, id: rng.uuid(), title: "Birding at Lake Merritt", start: iso(2025, 3, 8, 15, 0),
          end: iso(2025, 3, 8, 17, 0), location: "Lake Merritt, Oakland", category: "hobby",
          tags: ["birding", "outdoors"]),
        communication(
          &rng, id: rng.uuid(), time: iso(2025, 3, 11, 12, 0), kind: "email", inbound: true,
          from: "Golden Gate Audubon", subject: "Bay Area Bird Report: herons return to the lake",
          content:
            "Great blue herons are returning to their nesting colonies around Lake Merritt and the East Bay shoreline. The best viewing is early morning on the north shore. Bring binoculars and keep a respectful distance from the nests.",
          tags: ["newsletter"], category: "newsletter"),
      ]
    case "p2":
      return [
        person(
          &rng, id: rng.uuid(), first: "Maria", last: "Alvarez", job: "Pastry chef",
          org: "Lakeside Bakery", city: "Oakland", birthday: "1989-06-14",
          notes:
            "Close friend since the 2019 pottery class. Birthday June 14. Allergic to walnuts. Runs the morning shift at Lakeside Bakery and brings leftover croissants on Fridays."),
        communication(
          &rng, id: rng.uuid(), time: iso(2026, 9, 12, 8, 31), kind: "sms", inbound: true,
          from: "Maria Alvarez", subject: nil,
          content:
            "Saved you a box of the cardamom buns, come by Lakeside before 10 and ask for me. Also are we still on for Lake Merritt on Saturday?",
          tags: [], category: "personal"),
        event(
          &rng, id: rng.uuid(), title: "Dinner with Maria", start: iso(2026, 8, 22, 1, 30),
          end: iso(2026, 8, 22, 3, 30), location: "Nido Oakland", category: "social"),
        note(
          &rng, id: rng.uuid(), title: "Gift ideas",
          content:
            "Maria's birthday is June 14: a good pastry brush set, the Tartine book, or plant cuttings for her balcony. She hates anything scented.",
          created: iso(2026, 5, 2, 20, 11)),
      ]
    default:
      return [
        event(
          &rng, id: rng.uuid(), title: "Dentist: Dr. Priya Nair", start: iso(2025, 10, 9, 21, 30),
          end: iso(2025, 10, 9, 22, 30), location: "Fremont Smile Dental, Fremont", category: "health",
          tags: ["health"]),
        communication(
          &rng, id: rng.uuid(), time: iso(2025, 9, 25, 16, 5), kind: "email", inbound: true,
          from: "Fremont Smile Dental", subject: "Your appointment is confirmed",
          content:
            "Hello! This confirms your cleaning and exam with Dr. Priya Nair on Thursday, October 9 at 2:30 PM at Fremont Smile Dental, 39100 Liberty St. Please arrive ten minutes early. Reply to this message or call us to reschedule.",
          tags: ["health"], category: "appointment"),
        communication(
          &rng, id: rng.uuid(), time: iso(2025, 10, 8, 17, 0), kind: "sms", inbound: true,
          from: "Fremont Smile Dental", subject: nil,
          content:
            "Reminder: you have an appointment with Dr. Nair tomorrow, Thu Oct 9 at 2:30 PM. Reply C to confirm or R to reschedule.",
          tags: [], category: "appointment"),
        task(&rng, id: rng.uuid(), title: "Floss more before the dentist", due: "2025-10-09", done: false),
      ]
    }
  }

  // MARK: Decoys

  private static let smsLines = [
    "Running ten minutes late, save me a seat",
    "Can you pick up oat milk on the way home?",
    "Thanks for dinner last night, the soup was perfect",
    "Did the package come? The tracking says it was left at the front desk",
    "Heron Street is closed this weekend for repaving, park on Alder instead",
    "Happy birthday!! Hope it is a great one",
    "The blue folder is on the printer, grab it before the three o'clock",
    "Forgot my charger at your place, can I swing by tomorrow?",
    "Alvarez and Sons is quoting the fence repair at nine hundred dollars",
    "Maria's Taqueria has a new al pastor special, want to try it Friday?",
    "Do you still have the number for the plumber?",
    "Landing at 6:40, the Uber is booked",
  ]
  private static let emailSubjects = [
    "Your order has shipped", "Receipt from Maria's Taqueria", "Your statement is ready",
    "Weekly digest: 12 new items", "Invitation: team offsite", "Dentist office closing early on Fridays",
    "Re: Blue ceramic mugs, second batch", "Heron Street neighborhood association minutes",
    "Maria Gonzalez shared a document with you", "Confirmation: appointment with your accountant",
  ]
  private static let emailBodies = [
    "Thanks for your order. Your package is on its way and should arrive in three to five business days. Track it from your account page at any time. If anything looks wrong with the shipment, reply to this message and we will make it right.",
    "Here is your monthly summary. Your balance changed by a small amount this period, and there are two transactions that need your review. Sign in to see the details and to download the statement as a PDF for your records.",
    "The neighborhood association met on Tuesday evening. Items discussed: the repaving schedule for Heron Street, a proposal for a community garden on the vacant lot, and the annual block party. Minutes are attached. The next meeting is the first Tuesday of next month.",
    "We are updating our office hours starting next month. The front desk will close at noon on Fridays. Appointments scheduled for Friday afternoons will be moved to Thursday, and we will contact each affected patient by phone before the change.",
    "Maria Gonzalez shared the document Q3 planning notes with you. Open it to view and comment. You are receiving this because your address was entered as a collaborator.",
    "Your appointment with the accountant is confirmed for Tuesday, November 18 at 10:00 AM. Please bring last year's return and any new forms. Parking is available behind the building.",
  ]
  private static let noteTitles = [
    "Grocery list", "Book notes: The Overstory", "Meeting notes: Q3 planning", "Packing list: Tahoe",
    "Recipe: lemon olive oil cake", "Ideas for the garden", "Birthday dinner thoughts", "Podcast notes",
  ]
  private static let noteBodies = [
    "Oat milk, lemons, eggs, sourdough, bananas, the good butter, parsley, two limes, olive oil if we are low. Check whether the farmers market still has the plums.",
    "Chapter three is where it turns. The idea that trees communicate through the soil is less settled than the book makes it sound, but the writing about the chestnut is worth rereading. Quote to remember on page 61.",
    "Agreed to move the launch review to the second week. Open question on the budget line for tooling. Action items: send the revised timeline, book the room, ask finance about the Q4 forecast. Next sync is Thursday.",
    "Layers, rain shell, the blue headlamp, charger, two liters of water each, snacks, map, first aid kit, sunscreen. Leave a note with the plan for Alex.",
    "Whisk the eggs and sugar until pale, fold in the olive oil, zest and juice of two lemons, then the flour. Bake at 350 for forty minutes until a skewer comes out clean.",
  ]
  private static let photoDescriptions = [
    "A blue bicycle leaning against a brick wall under a window with green shutters.",
    "A plate of pastries on a wooden table next to a cup of coffee.",
    "Two people laughing on a park bench, trees behind them, late afternoon light.",
    "A heron-shaped weather vane on top of a barn roof against a cloudy sky.",
    "A hand-painted sign reading Heron Street at a corner with parked cars.",
    "A whiteboard covered in boxes and arrows from a planning meeting.",
    "A shelf of ceramic mugs in different shades of blue.",
    "A trail marker in a pine forest with a map of the loop.",
  ]
  private static let taskTitles = [
    "Renew library card", "Call dentist to confirm", "Pick up dry cleaning", "Water the plants",
    "Send revised timeline", "Book Tahoe cabin", "Return the blue folder",
  ]

  private static func decoyItems(_ scenario: String, count: Int, _ rng: inout Rng) -> [J] {
    var items: [J] = []

    for index in 0..<count {
      let id = rng.uuid()
      let day = 1 + (index * 3) % 27
      let month = 1 + (index * 5) % 12
      let year = [2024, 2025, 2026][index % 3]
      let time = iso(year, month, day, 6 + (index * 7) % 15, (index * 11) % 60)

      switch index % 5 {
      case 0, 3:
        let sms = rng.pick(smsLines)
        items.append(
          communication(
            &rng, id: id, time: time, kind: "sms", inbound: index % 2 == 0,
            from: rng.pick(["Alex Kim", "Jordan Lee", "Sam Patel", "Robin Okafor", "Maria Gonzalez"]),
            subject: nil, content: sms, tags: [], category: "personal"))
      case 1:
        items.append(
          communication(
            &rng, id: id, time: time, kind: "email", inbound: true,
            from: rng.pick(["Orders", "Billing", "Neighborhood Association", "Calendar", "Accounts"]),
            subject: rng.pick(emailSubjects), content: rng.pick(emailBodies), tags: ["updates"],
            category: "notification"))
      case 2:
        items.append(
          note(&rng, id: id, title: rng.pick(noteTitles), content: rng.pick(noteBodies), created: time))
      default:
        if index % 10 == 4 {
          items.append(
            photo(
              &rng, id: id, file: "IMG_\(4000 + index * 37).jpeg", description: rng.pick(photoDescriptions),
              taken: time, place: nil))
        } else {
          items.append(
            task(&rng, id: id, title: rng.pick(taskTitles), due: iso(year, month, day, 0, 0), done: index % 2 == 0))
        }
      }
    }

    return items
  }
}
