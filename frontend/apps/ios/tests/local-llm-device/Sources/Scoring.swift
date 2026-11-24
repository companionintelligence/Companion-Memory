import Foundation

/// Mechanical checks on an answer. They are a first filter, not a verdict: every answer is also
/// kept verbatim in the results so a person can read it, and the heuristics here were calibrated
/// against reading them.
struct Score: Codable {
  var nonEmpty: Bool
  /// How many of the prompt's fact groups the answer carries.
  var groundedGroups: Int
  var grounded: Bool
  /// The answer names something only a decoy hit contains.
  var wrongHit: Bool
  /// No control markers, no foreign-script letters, no runaway repetition.
  var clean: Bool
  var hasMarkers: Bool
  var foreignScriptRatio: Double
  var repetitive: Bool
  /// Grounded, not confused by a decoy, and clean: an answer someone could act on.
  var useful: Bool
}

enum Scoring {
  static func score(answer: String, thought: String, prompt: BenchPrompt?) -> Score {
    let text = answer.trimmingCharacters(in: .whitespacesAndNewlines)
    let lowered = text.lowercased()
    let groups = prompt?.facts.filter { group in
      group.contains { lowered.contains($0.lowercased()) }
    }.count ?? 0
    let wrong = prompt?.wrong.contains { lowered.contains($0.lowercased()) } ?? false
    let markers = hasMarkers(text)
    let foreign = foreignScriptRatio(text)
    let repeats = isRepetitive(text)
    let clean = !markers && foreign < 0.05 && !repeats
    let nonEmpty = !text.isEmpty

    return Score(
      nonEmpty: nonEmpty, groundedGroups: groups, grounded: groups >= 1, wrongHit: wrong,
      clean: clean, hasMarkers: markers, foreignScriptRatio: (foreign * 1000).rounded() / 1000,
      repetitive: repeats, useful: nonEmpty && groups >= 1 && !wrong && clean)
  }

  static func hasMarkers(_ text: String) -> Bool {
    if text.range(of: "<\\|[A-Za-z0-9_]{1,32}\\|>", options: .regularExpression) != nil { return true }

    return ["<think>", "</think>", "<tool_call>", "</tool_call>", "<tool_response>", "<start_of_turn>"]
      .contains { text.contains($0) }
  }

  /// Letters beyond Latin Extended-B — Cyrillic, Greek, CJK, Arabic… — as a share of all letters.
  /// The fixtures are English, so a Cyrillic word in an answer is the model coming apart, not content.
  static func foreignScriptRatio(_ text: String) -> Double {
    var letters = 0
    var foreign = 0

    for scalar in text.unicodeScalars where scalar.properties.isAlphabetic {
      letters += 1
      if scalar.value > 0x24F { foreign += 1 }
    }

    return letters == 0 ? 0 : Double(foreign) / Double(letters)
  }

  /// Some four-word run appears four or more times.
  static func isRepetitive(_ text: String) -> Bool {
    let words = text.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber })
    guard words.count >= 16 else { return false }

    var counts: [String: Int] = [:]

    for index in 0...(words.count - 4) {
      let gram = words[index..<(index + 4)].joined(separator: " ")
      counts[gram, default: 0] += 1
      if counts[gram, default: 0] >= 4 { return true }
    }

    return false
  }
}
