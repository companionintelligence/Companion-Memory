#!/usr/bin/env bash
# Asks iOS's ToolResultShaper (LocalLLMPolicy.swift) what it answers for every case in ToolResultCases.kt and
# records the answers in src/test/resources/tool-result-swift-parity.json, which SwiftParityTest compares the Kotlin
# ToolResultShaper with.
#
# Run it after changing the Swift shaper on purpose (and the Kotlin one to match): a SwiftParityTest that still fails
# after that is a case on which the two differ. It needs, on a Mac: swiftc, python3, a JDK 21 and an Android SDK
# (JAVA_HOME and ANDROID_HOME, exactly as `make test-android` wants them; GRADLE_ARGS is passed on to Gradle).
#
# 1. The inputs come from the Kotlin side: SwiftParityTest.write_the_cases_out_for_the_swift_shaper_when_asked writes
#    every case to $SWIFT_PARITY_DUMP_DIR.
# 2. The Swift shaper is compiled from the app's OWN LocalLLMPolicy.swift (it imports only Foundation) and run over
#    them.
# 3. The answers are written out as JSON, with the checksum of the Swift file they came from and, as
#    `_shaper_sha256`, a checksum of the shaper's own code in it: SwiftParityTest compares that with the Swift file
#    in the repo, so it fails when ToolResultShaper changes until the change is ported and this script is run again.
#    That checksum covers the `// MARK: - Tool results` section to the end of the file, without its comment lines and
#    blank lines (so that a comment can be reworded), and SwiftParityTest computes it the same way.
#
# Usage: bash scripts/regenerate-swift-parity.sh      (from anywhere)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
module="$(cd "$here/.." && pwd)"
repo="$(cd "$here/../../../../.." && pwd)"

policy="$repo/frontend/apps/ios/ios/App/App/LocalLLM/LocalLLMPolicy.swift"
models="$repo/frontend/apps/ios/ios/App/App/LocalLLM/LocalLLMModels.swift"
output="$module/src/test/resources/tool-result-swift-parity.json"

for tool in swiftc python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool not found." >&2; exit 1; }
done

# `mktemp -d` with no template is the one form macOS (BSD) and GNU agree on.
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "1/3 writing the cases out from the Kotlin side"
# The test task is told about no environment variable, so Gradle would call it up to date and skip it.
(
  cd "$repo/frontend/apps/android/android"
  # shellcheck disable=SC2086  # GRADLE_ARGS is a list of arguments, like the one `make test-android` takes
  SWIFT_PARITY_DUMP_DIR="$work/cases" ./gradlew ${GRADLE_ARGS:-} \
    :ci-capacitor-local-llm:cleanTestDebugUnitTest \
    :ci-capacitor-local-llm:testDebugUnitTest \
    --tests '*SwiftParityTest.write_the_cases_out_for_the_swift_shaper_when_asked' >"$work/gradle.log" 2>&1
) || { cat "$work/gradle.log" >&2; exit 1; }

[ -d "$work/cases" ] || { echo "the Kotlin side wrote no cases (see $work/gradle.log)" >&2; exit 1; }

echo "2/3 shaping them with the Swift shaper"
cat >"$work/main.swift" <<'SWIFT'
import Foundation

// For every NNNNN.in (+ NNNNN.budget) in the directory: NNNNN.swift.out is what ToolResultShaper answers.
let directory = CommandLine.arguments[1]
let names = try FileManager.default.contentsOfDirectory(atPath: directory).filter { $0.hasSuffix(".in") }.sorted()

for name in names {
  let base = String(name.dropLast(3))
  let input = String(decoding: try Data(contentsOf: URL(fileURLWithPath: "\(directory)/\(name)")), as: UTF8.self)
  let budgetText = try String(contentsOfFile: "\(directory)/\(base).budget", encoding: .utf8)
  let budget = Int(budgetText.trimmingCharacters(in: .whitespacesAndNewlines))!
  let output = ToolResultShaper.shape(input, budgetBytes: budget)

  try Data(output.utf8).write(to: URL(fileURLWithPath: "\(directory)/\(base).swift.out"))
}
SWIFT

swiftc -swift-version 5 -O -o "$work/oracle" "$policy" "$models" "$work/main.swift"
"$work/oracle" "$work/cases"

echo "3/3 recording the answers"
checksum="$(shasum -a 256 "$policy" | cut -d' ' -f1)"

python3 - "$work/cases" "$output" "$checksum" "$policy" <<'PYTHON'
import hashlib, json, os, sys

directory, output, checksum, policy = sys.argv[1:5]

# The shaper's code: from its MARK to the end of the file, minus comment-only and blank lines.
swift = open(policy, encoding="utf-8").read()
start = swift.index("\n// MARK: - Tool results\n") + 1
code = "\n".join(line for line in swift[start:].split("\n") if line.strip() and not line.lstrip().startswith("//"))
shaper_checksum = hashlib.sha256(code.encode("utf-8")).hexdigest()

answers = {
    "_source": f"frontend/apps/ios/ios/App/App/LocalLLM/LocalLLMPolicy.swift, sha256 {checksum}. Written by scripts/regenerate-swift-parity.sh: do not edit by hand.",
    "_shaper_sha256": shaper_checksum,
}

for name in sorted(f for f in os.listdir(directory) if f.endswith(".name")):
    base = name[:-5]
    case = open(os.path.join(directory, name), encoding="utf-8").read()
    answers[case] = open(os.path.join(directory, base + ".swift.out"), "rb").read().decode("utf-8")

with open(output, "w", encoding="utf-8") as handle:
    json.dump(answers, handle, ensure_ascii=False, indent=1)
    handle.write("\n")

print(f"recorded {len([k for k in answers if not k.startswith('_')])} answers in {output}")
PYTHON
