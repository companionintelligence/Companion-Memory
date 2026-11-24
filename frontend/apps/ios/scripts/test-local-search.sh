#!/usr/bin/env bash
# Runs the phone's `knowledge_search` store (LocalSearchStore.swift) against a real SQLCipher database on
# this Mac: an encrypted file with the PowerSync replica's table and FTS index, opened read-only with a
# passphrase, queried the way the on-device model queries it. No simulator, no Capacitor, no model.
#
# It compiles the app's OWN LocalSearchStore.swift with tests/local-search/main.swift. `import SQLCipher`
# is satisfied by building the SQLCipher pod's amalgamation (ios/App/Pods/SQLCipher, present after
# `yarn cap sync ios`) for macOS with the flags the pod itself uses, and a module map over its header.
# The keychain check writes and removes one test item in this Mac's login keychain.
#
# Usage: bash scripts/test-local-search.sh      (from frontend/apps/ios, or anywhere)
set -euo pipefail

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sqlcipher="$app_dir/ios/App/Pods/SQLCipher"
sources="$app_dir/ios/App/App/LocalLLM"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "swiftc not found. Install Xcode or the Command Line Tools (xcode-select --install)." >&2
  exit 1
fi

if [ ! -f "$sqlcipher/sqlite3.c" ]; then
  echo "$sqlcipher/sqlite3.c not found. Run 'yarn cap sync ios' in frontend/apps/ios first (it runs pod install)." >&2
  exit 1
fi

build_dir="$(mktemp -d)"
trap 'rm -rf "$build_dir"' EXIT

# Same defines as Pods/Target Support Files/SQLCipher/SQLCipher.release.xcconfig (CommonCrypto provider).
defines=(-DSQLITE_HAS_CODEC -DSQLITE_TEMP_STORE=2 -DSQLITE_THREADSAFE=1 -DSQLITE_ENABLE_FTS5 -DSQLITE_ENABLE_FTS3_PARENTHESIS
  -DSQLITE_ENABLE_JSON1 -DSQLITE_ENABLE_COLUMN_METADATA -DSQLCIPHER_CRYPTO_CC -DHAVE_USLEEP=1
  -DSQLITE_EXTRA_INIT=sqlcipher_extra_init -DSQLITE_EXTRA_SHUTDOWN=sqlcipher_extra_shutdown)

mkdir -p "$build_dir/include"
cp "$sqlcipher/sqlite3.h" "$build_dir/include/sqlite3.h"
printf 'module SQLCipher {\n  header "sqlite3.h"\n  export *\n}\n' > "$build_dir/include/module.modulemap"

clang -c -O1 -w "${defines[@]}" "$sqlcipher/sqlite3.c" -o "$build_dir/sqlite3.o"

swiftc -swift-version 5 -I "$build_dir/include" -Xcc -DSQLITE_HAS_CODEC -o "$build_dir/local-search-tests" \
  "$build_dir/sqlite3.o" -framework Security \
  "$sources/LocalSearchStore.swift" \
  "$app_dir/tests/local-search/main.swift"

"$build_dir/local-search-tests"
