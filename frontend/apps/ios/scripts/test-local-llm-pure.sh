#!/usr/bin/env bash
# Runs the pure Swift logic behind the on-device LLM plugin — reply assembly (control-token
# stripping), failure wording and tool-result shaping — on this Mac, with no simulator, no model,
# no Capacitor and no LiteRT-LM framework.
#
# It compiles the app's OWN sources (not copies) together with tests/local-llm-pure/main.swift and the
# device bench's synthetic memory (tests/local-llm-device/Sources/Fixtures.swift, Foundation only, so the
# shaper is also checked against a result shaped like the appliance's):
# LocalLLMStreaming.swift, LocalLLMPolicy.swift and LocalLLMModels.swift import only Foundation, and
# the vendored LiteRTLMError.swift is the real error enum the engine throws. Anything that needs the
# engine, Capacitor or the xcframework is out of reach here and is checked on a device or simulator.
#
# Usage: bash scripts/test-local-llm-pure.sh      (from frontend/apps/ios, or anywhere)
set -euo pipefail

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sources="$app_dir/ios/App/App"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "swiftc not found. Install Xcode or the Command Line Tools (xcode-select --install)." >&2
  exit 1
fi

# `mktemp -d` with no template is the one form macOS (BSD) and GNU agree on.
build_dir="$(mktemp -d)"
trap 'rm -rf "$build_dir"' EXIT

swiftc -swift-version 5 -o "$build_dir/local-llm-pure-tests" \
  "$sources/LocalLLM/LocalLLMStreaming.swift" \
  "$sources/LocalLLM/LocalLLMPolicy.swift" \
  "$sources/LocalLLM/LocalLLMModels.swift" \
  "$sources/Vendor/LiteRTLM/LiteRTLMError.swift" \
  "$app_dir/tests/local-llm-device/Sources/Fixtures.swift" \
  "$app_dir/tests/local-llm-pure/main.swift"

"$build_dir/local-llm-pure-tests"
