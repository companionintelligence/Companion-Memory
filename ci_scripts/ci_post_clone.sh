#!/bin/sh
#
# Xcode Cloud post-clone bootstrap for the Capacitor iOS app.
#
# ─ Why this file has to exist ──────────────────────────────────────────────────
#
# Xcode Cloud clones the repository and goes straight to `xcodebuild` against
# `frontend/apps/mobile/ios/App/App.xcworkspace`. That workspace references
# `Pods/Pods.xcodeproj`, and `App.xcodeproj` names
# `Pods/Target Support Files/Pods-App/Pods-App.debug.xcconfig` as its base
# configuration — but `ios/.gitignore` excludes `App/Pods`, correctly, because
# CocoaPods output is generated. Nothing in the cloned tree creates it.
#
# Without this script the build therefore fails before compiling a line:
#
#   Unable to open base configuration reference file
#   '.../ios/App/Pods/Target Support Files/Pods-App/Pods-App.debug.xcconfig'
#
# `App/App/public` (the web bundle) and `App/App/capacitor.config.json` are
# generated and gitignored for the same reason, so a build that only ran
# `pod install` would link but ship an app with no web content.
#
# The fix is the sequence `.github/workflows/mobile-build.yml` already runs for
# its iOS job, reproduced here because Xcode Cloud has no equivalent of a
# workflow step. That lane stays the credential-free simulator build and
# `mobile-release.yml` stays the signed TestFlight lane; this only makes the
# Xcode Cloud workflow able to get as far as compiling.
#
# ─ Required: NODE_AUTH_TOKEN ───────────────────────────────────────────────────
#
# `frontend/apps/web` (and `packages/shadcn`) depend on
# `@companionintelligence/tokens`, which resolves to a `npm.pkg.github.com`
# archive URL. That URL answers 401 unauthenticated — verified, not assumed — and
# this repo is not zero-install (`.yarn/cache` is not committed), so a cold runner
# genuinely has to fetch it.
#
# Add NODE_AUTH_TOKEN as a SECRET environment variable on the Xcode Cloud
# workflow (App Store Connect → your app → Xcode Cloud → Manage Workflows →
# Environment → Environment Variables → "Secret"). It needs a GitHub token with
# `read:packages`. The check below fails fast and says so, rather than letting
# `yarn install` die several minutes later on an opaque 401.
#
# ─ Location ────────────────────────────────────────────────────────────────────
#
# Apple documents `ci_scripts/` as living beside the Xcode project or workspace,
# but repository-root placement is also widely used and Xcode Cloud's own
# checkout layout differs between workflow configurations. The real script is
# here at the repository root; `frontend/apps/mobile/ios/App/ci_scripts/` holds a
# forwarder to it. Whichever location this workflow honours, exactly one of them
# runs and both reach this code. If you later confirm which one Xcode Cloud picks
# up for this workflow, delete the other.

set -eu

echo "▸ ci_post_clone: bootstrapping the Capacitor iOS build"

# CocoaPods needs a UTF-8 locale and a non-interactive CI shell often has none.
# Without this, `pod install` dies inside `cap sync` with
#
#   Unicode Normalization not appropriate for ASCII-8BIT
#   (Encoding::CompatibilityError) ... in 'Pod::Config#installation_root'
#
# which names neither the locale nor the Podfile. Observed on a bare shell while
# verifying this script, not anticipated — CocoaPods does warn ("requires your
# terminal to be using UTF-8 encoding") but the warning is far above the
# backtrace and easy to miss.
export LANG="${LANG:-en_US.UTF-8}"
export LC_ALL="${LC_ALL:-en_US.UTF-8}"

# Xcode Cloud sets CI_PRIMARY_REPOSITORY_PATH to the clone root. Fall back to
# git so the script is runnable by hand for debugging.
REPO_ROOT="${CI_PRIMARY_REPOSITORY_PATH:-$(cd "$(dirname "$0")/.." && git rev-parse --show-toplevel)}"
MOBILE_DIR="$REPO_ROOT/frontend/apps/mobile"

if [ ! -d "$MOBILE_DIR" ]; then
  echo "✗ expected the mobile app at $MOBILE_DIR — is CI_PRIMARY_REPOSITORY_PATH right?" >&2
  exit 1
fi

if [ -z "${NODE_AUTH_TOKEN:-}" ]; then
  cat >&2 <<'MSG'
✗ NODE_AUTH_TOKEN is not set.

  The web bundle depends on @companionintelligence/tokens from GitHub Packages,
  which requires authentication. Add NODE_AUTH_TOKEN as a SECRET environment
  variable on this Xcode Cloud workflow (App Store Connect → Xcode Cloud →
  Manage Workflows → Environment), using a GitHub token with `read:packages`.

  Failing now rather than several minutes into `yarn install`, where this shows
  up only as an opaque 401.
MSG
  exit 1
fi

# ── Toolchain ────────────────────────────────────────────────────────────────
# Xcode Cloud images ship neither Node nor CocoaPods.

NODE_MAJOR_REQUIRED=22

node_major() {
  command -v node >/dev/null 2>&1 || return 1
  node --version | sed 's/^v\([0-9]*\).*/\1/'
}

if [ "$(node_major || echo 0)" != "$NODE_MAJOR_REQUIRED" ]; then
  echo "▸ installing Node ${NODE_MAJOR_REQUIRED} (found: $(command -v node >/dev/null 2>&1 && node --version || echo none))"
  brew install "node@${NODE_MAJOR_REQUIRED}"
  # node@NN is keg-only, so Homebrew does not put it on PATH.
  PATH="$(brew --prefix "node@${NODE_MAJOR_REQUIRED}")/bin:$PATH"
  export PATH
fi

echo "▸ node $(node --version)"

# Yarn 4 is delivered through Corepack, which ships with Node.
corepack enable

if ! command -v pod >/dev/null 2>&1; then
  echo "▸ installing CocoaPods"
  brew install cocoapods
fi

echo "▸ pod $(pod --version)"

# ── Install and build ────────────────────────────────────────────────────────
# The mobile app is deliberately NOT a Yarn workspace (see its package.json): it
# sets `nodeLinker: node-modules` because the Capacitor CLI and CocoaPods walk a
# real node_modules tree, while the root install stays PnP. So it carries its own
# lockfile and needs its own install.

echo "▸ root install (Yarn PnP)"
cd "$REPO_ROOT"
yarn install --immutable

echo "▸ mobile install (node-modules linker)"
cd "$MOBILE_DIR"
yarn install --immutable

# `build:web` builds @ci/fe-web with VITE_DISABLE_PWA=true. That flag matters:
# capacitor.config.ts notes that Workbox's service worker fights Capacitor's
# local asset serving, so this uses the app's own script rather than calling the
# fe-web build directly.
echo "▸ building the web bundle"
yarn build:web

# Generates App/App/public, App/App/capacitor.config.json, and runs `pod install`
# — which is what finally creates the Pods/ directory the workspace needs.
echo "▸ cap sync ios"
yarn cap sync ios

XCCONFIG="$MOBILE_DIR/ios/App/Pods/Target Support Files/Pods-App/Pods-App.debug.xcconfig"

if [ ! -f "$XCCONFIG" ]; then
  echo "✗ cap sync finished but $XCCONFIG is still missing — the build will fail on it." >&2
  exit 1
fi

echo "▸ ci_post_clone: done — Pods and web assets are in place"
