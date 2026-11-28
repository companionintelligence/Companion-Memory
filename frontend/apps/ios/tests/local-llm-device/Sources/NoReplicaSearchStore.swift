// The bench has no replica to search, and the app's `LocalSearchStore` links the SQLCipher pod, which this target
// is built without (see project.yml). This stands in so `LocalSearch.swift` and `CompanionIntentTools.swift`
// compile unchanged: `shared` stays nil, so the phone-side search is never offered.

struct LocalSearchArgs {
  var query: String = ""
  var entityTypes: [String] = []
  var since: String?
  var until: String?
  var sort: String?
  var countOnly = false
}

final class LocalSearchStore {
  static var shared: LocalSearchStore?

  var isAvailable: Bool { false }

  func run(_ args: LocalSearchArgs) throws -> String { "" }
}
