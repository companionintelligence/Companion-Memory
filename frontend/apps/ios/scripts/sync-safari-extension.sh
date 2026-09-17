#!/usr/bin/env bash
# Fill SafariWebExtension/Resources from CI-Browser-Extension (sibling checkout
# or a pinned GitHub safari-mobile release).
#
# FAIL CLOSED ONLY ON A BUILD THAT COULD SHIP, so an archive never ships an
# empty .appex while a Debug/simulator build — which cannot be submitted to
# TestFlight or the App Store, and where the extension has no bearing on
# whether the App target compiles — still succeeds. is_shipping_build() below
# has the exact signals; in short:
#   - SAFARI_EXTENSION_OPTIONAL=1 forces the warn path. Set it when the caller
#     KNOWS the output is throwaway (CI simulator builds), so the outcome does
#     not depend on this script guessing right from Xcode's environment.
#   - ACTION=install (what `xcodebuild archive` / Product ▸ Archive sets) or any
#     CONFIGURATION other than Debug fails closed, exactly as before.
#   - No CONFIGURATION at all — i.e. `yarn sync:safari-extension` from a
#     terminal — also fails closed: that path exists to produce shippable
#     resources, and a silent no-op there is how an empty .appex reaches an
#     archive in the first place.
#
# BOTH CI SOURCING PATHS ARE STILL BROKEN, AND NOT FIXABLE FROM THIS REPO ALONE
# (investigated 2026-08-29, see docs/qa/baseline-2026-08-26.md §6.2(a)):
#   - No sibling CI_BROWSER_EXTENSION_DIR checkout exists in GitHub Actions,
#     so every CI run falls to the pinned-release path.
#   - companionintelligence/CI-Browser-Extension is a PRIVATE repo, and
#     CI-Server's Actions secrets carry no cross-repo credential for it (only
#     app-signing/store secrets) — so `mobile-build.yml` cannot even `git
#     clone` it directly as a workaround without someone provisioning a new
#     PAT/deploy-key secret in this repo's settings first.
#   - Its releases (currently only v1.4.0; PINNED_VERSION defaults to the
#     unreleased 1.5.0) have never shipped a `*safari-mobile.zip` asset, and
#     its in-tree source has no committed build output either — `.output/`
#     is gitignored, so even a successful clone would still need to run
#     `yarn install && yarn build:safari-mobile` (a second JS toolchain) in
#     that checkout before this script's sync_from_dir() would find anything.
#   Unblocking the SOURCING needs an action in the OTHER repo: publish a v1.5.0
#   (or whatever PINNED_VERSION says) release there with a safari-mobile.zip
#   asset, built via its own already-existing `npm run zip:safari-mobile`.
#   Until that lands, the CI simulator lane (.github/workflows/mobile-build.yml
#   → "iOS (Simulator .app)", Debug / -sdk iphonesimulator) is EXPECTED to take
#   the warn path: no resources, a SAFARI_EXTENSION_MISSING.txt marker left in
#   Resources/ (and copied into the built .appex so the gap is visible in the
#   artifact), and exit 0 so the App target compiles at all — which is what any
#   future XCTest target or simulator smoke test depends on. Those artifacts
#   must never be shipped; a Release/archive build still fails closed here.
#   The CI_BROWSER_EXTENSION_DIR local-dev override below is unaffected and
#   still works for anyone who sets it.
set -euo pipefail

# Xcode GUI Run scripts do not load a login shell, so asdf/nvm/Homebrew yarn
# are missing from PATH. Reopening Xcode does not fix that.
export PATH="${HOME}/.asdf/shims:${HOME}/.asdf/bin:/opt/homebrew/bin:/usr/local/bin:${PATH}"
if [[ -z "${ASDF_DIR:-}" && -f "${HOME}/.asdf/asdf.sh" ]]; then
  # shellcheck disable=SC1091
  source "${HOME}/.asdf/asdf.sh"
fi
if [[ -f "${HOME}/.nvm/nvm.sh" ]]; then
  # nvm refuses to load (returns 1) when npm_config_prefix is set, which aborts
  # this script under `set -e`. npm/npx export that variable into every child
  # process, so an xcodebuild driven from an MCP server launched via `npx`
  # (XcodeBuildMCP, ios-simulator-mcp) always hits it. We only source nvm to put
  # node on PATH, so drop the variable first.
  unset npm_config_prefix
  # shellcheck disable=SC1091
  source "${HOME}/.nvm/nvm.sh"
fi

IOS_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$IOS_ROOT/../../.." && pwd)"
DEST="$IOS_ROOT/ios/App/SafariWebExtension/Resources"
# Dropped into Resources/ (and so into the .appex) when a non-shipping build has
# to proceed without the extension. Named once because the success path below
# has to delete it again from BOTH places, and a drifted literal there would
# silently stop the cleanup working.
MARKER_NAME="SAFARI_EXTENSION_MISSING.txt"
PINNED_VERSION="${CI_BROWSER_EXTENSION_VERSION:-1.5.0}"
GH_REPO="${CI_BROWSER_EXTENSION_REPO:-companionintelligence/CI-Browser-Extension}"

if [[ -n "${CI_BROWSER_EXTENSION_DIR:-}" ]]; then
  EXT_DIR="$CI_BROWSER_EXTENSION_DIR"
else
  EXT_DIR="$(cd "$REPO_ROOT/.." && pwd)/CI-Browser-Extension"
fi

mkdir -p "$DEST"

# Does this invocation produce something that could reach a device or a store?
# Only those must fail closed when the extension cannot be sourced. Blocking a
# Debug/simulator build instead strands every other kind of iOS verification —
# the App target never compiles in CI, so a test target added tomorrow would
# have nowhere to run — while an empty .appex in a simulator .app harms nothing.
is_shipping_build() {
  # Explicit opt-out beats inference: a caller that knows the build is
  # throwaway says so, rather than depending on us reading Xcode's environment
  # correctly. Any value other than exactly 1 is ignored, so a stray empty
  # export cannot silently disarm the archive guard.
  if [[ "${SAFARI_EXTENSION_OPTIONAL:-}" == "1" ]]; then
    return 1
  fi
  # `xcodebuild archive` and Product ▸ Archive run every phase with
  # ACTION=install; a plain build sets ACTION=build (and nothing sets it
  # outside Xcode). Check this before CONFIGURATION so a Debug-configured
  # archive — legal, and still installable — is treated as shipping.
  case "${ACTION:-}" in
    install | installhdrs | installsrc) return 0 ;;
  esac
  # No CONFIGURATION means no Xcode: `yarn sync:safari-extension` from a
  # terminal, whose whole job is to produce shippable resources. Fail closed.
  if [[ -z "${CONFIGURATION:-}" ]]; then
    return 0
  fi
  # Debug is the only configuration in this project that never ships. Treat any
  # other name (Release today, a future Staging/Beta) as shipping, so adding a
  # configuration cannot quietly opt it out of the guard.
  [[ "$CONFIGURATION" != "Debug" ]]
}

sync_from_dir() {
  local src="$1"
  if [[ ! -f "$src/manifest.json" ]]; then
    echo "error: no manifest.json in $src" >&2
    return 1
  fi
  rsync -a --delete --exclude '.gitkeep' --exclude 'README.md' "$src"/ "$DEST"/
}

# Rewrite Vite's root-absolute asset URLs. iOS Safari loads popup.html from an
# origin where `/chunks/…` does not resolve, which produced a blank popup.
rewrite_safari_asset_urls() {
  local dir="$1"
  local f
  while IFS= read -r -d '' f; do
    case "$f" in
      *.css)
        # CSS already lives in assets/; /assets/foo → ./foo
        perl -0pi -e 's#url\(/assets/#url(./#g' "$f"
        ;;
      *)
        perl -0pi -e 's/(src|href)="\//$1=".\//g; s/"\/(chunks|assets|icon|content-scripts)\//".\/$1\//g' "$f"
        ;;
    esac
  done < <(find "$dir" \( -name '*.html' -o -name '*.js' -o -name '*.css' \) -print0)
}

populate_resources() {
  # Xcode incremental builds may reuse a snapshot from `yarn sync`. CLI sync
  # always rebuilds from the sibling checkout so the app ships current extension
  # code. FORCE_SAFARI_EXTENSION_SYNC=1 rebuilds even inside Xcode.
  if [[ -f "$DEST/manifest.json" && -n "${BUILT_PRODUCTS_DIR:-}" && "${FORCE_SAFARI_EXTENSION_SYNC:-}" != "1" ]]; then
    echo "Reusing existing Safari Web Extension resources at $DEST"
  elif [[ -d "$EXT_DIR" && -f "$EXT_DIR/package.json" ]] && { command -v yarn >/dev/null 2>&1 || command -v npm >/dev/null 2>&1; }; then
    echo "Building safari-mobile from $EXT_DIR"
    (
      cd "$EXT_DIR"
      if [[ -f yarn.lock ]] && command -v yarn >/dev/null 2>&1; then
        yarn install --immutable
        yarn build:safari-mobile
      else
        npm ci
        npm run build:safari-mobile
      fi
    )
    sync_from_dir "$EXT_DIR/.output/safari-mv3"
    rewrite_safari_asset_urls "$DEST"
  else
    echo "No sibling extension at $EXT_DIR — downloading $GH_REPO@$PINNED_VERSION"
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    zip_name="ci-browser-extension-${PINNED_VERSION}-safari-mobile.zip"
    if command -v gh >/dev/null 2>&1; then
      gh release download "v${PINNED_VERSION}" --repo "$GH_REPO" --pattern '*safari-mobile.zip' --dir "$tmp"
    else
      url="https://github.com/${GH_REPO}/releases/download/v${PINNED_VERSION}/${zip_name}"
      curl -fsSL -o "$tmp/$zip_name" "$url"
    fi
    unzip -q "$tmp"/*safari-mobile.zip -d "$tmp/unpacked"
    src="$(find "$tmp/unpacked" -name manifest.json -print -quit | xargs dirname)"
    sync_from_dir "$src"
    rewrite_safari_asset_urls "$DEST"
  fi
}

# Sourcing failure has to come back as a VALUE, not an abort: the download
# branch dies on `gh release download` / `curl -f` long before the emptiness
# check below, which is why CI never even reached the "Refusing to archive"
# message — the script was simply killed by `set -e` mid-branch.
#
# The shape here is deliberate and NOT interchangeable with the obvious
# `( set -e; populate_resources ) || sync_status=$?`: errexit is suppressed for
# the whole of a command used as a condition (the left side of `||` included),
# and an inner `set -e` does not win that back — verified in bash 5.3, where
# that form runs the rest of the failing branch and reports success. Disabling
# errexit in the parent instead keeps the subshell a plain command, so its own
# `set -e` really does stop it at the first failure.
set +e
( set -e; populate_resources )
sync_status=$?
set -e

# Warn loudly and leave a marker instead of failing, but only where nothing can
# ship. Xcode renders a leading "warning:" from a script phase as a real build
# warning, so this is visible in the log and in Xcode's issue navigator rather
# than buried in build output.
warn_extension_absent() {
  local reason="$1"
  cat >"$DEST/$MARKER_NAME" <<EOF
The Companion Memory Safari Web Extension was NOT bundled into this build.

Reason: $reason
Build:  ACTION=${ACTION:-<none>} CONFIGURATION=${CONFIGURATION:-<none>} SAFARI_EXTENSION_OPTIONAL=${SAFARI_EXTENSION_OPTIONAL:-<unset>}
Built:  $(date -u '+%Y-%m-%dT%H:%M:%SZ')

This marker is written by frontend/apps/ios/scripts/sync-safari-extension.sh
only for builds that cannot ship (Debug/simulator, or an explicit
SAFARI_EXTENSION_OPTIONAL=1). Its presence means the .appex is empty: the
extension will not appear in Safari's settings and must not be tested for.
DO NOT DISTRIBUTE THIS BUILD. A Release build or an archive fails the build
outright in this situation instead of writing this file.
EOF
  echo "warning: Safari Web Extension resources are ABSENT ($reason)." >&2
  echo "warning: The bundled Safari extension will be missing from this app — DO NOT SHIP this build." >&2
  echo "warning: Marker written to $DEST/$MARKER_NAME; see sync-safari-extension.sh's header." >&2
}

# A failed sourcing attempt is fatal on a shipping build even if a manifest
# happens to be present: a half-finished rsync would otherwise pass the
# emptiness check below and ship a broken extension.
if (( sync_status != 0 )) && is_shipping_build; then
  echo "error: could not source the Safari Web Extension (exit $sync_status). Refusing to archive." >&2
  exit "$sync_status"
fi

if [[ ! -f "$DEST/manifest.json" ]]; then
  if is_shipping_build; then
    echo "error: Safari Web Extension Resources are empty ($DEST). Refusing to archive." >&2
    exit 1
  fi
  if (( sync_status != 0 )); then
    warn_extension_absent "sourcing failed (exit $sync_status) — see the log above"
  else
    warn_extension_absent "no extension source produced a manifest.json in $DEST"
  fi
  # Fall through: the marker still gets copied into the .appex below so the gap
  # travels with the artifact, then exit 0 so the App target keeps building.
fi

if [[ -f "$DEST/manifest.json" ]]; then
  # An earlier warn-path build in the same derived-data tree left the marker
  # behind. sync_from_dir's `rsync --delete` already clears it from $DEST, but
  # the copy into the .appex further down is additive (no --delete), so without
  # this the stale "DO NOT DISTRIBUTE THIS BUILD" note outlives the gap it
  # describes — and the marker is the ONLY artifact-level signal separating a
  # real extension-less build from a good one, so a false positive destroys it.
  rm -f "$DEST/$MARKER_NAME"
  if (( sync_status != 0 )); then
    # Non-shipping build (a shipping one already exited above) whose sourcing
    # failed but left a manifest behind — a previous sync's snapshot, or a
    # partial rsync. Say so rather than printing the unqualified "ready".
    echo "warning: Safari Web Extension sourcing failed (exit $sync_status); the resources at $DEST may be stale or incomplete — DO NOT SHIP this build." >&2
  else
    echo "Safari Web Extension resources ready at $DEST"
  fi
fi

# When Xcode runs this phase, also copy into the built .appex (manifest at bundle
# root). On the warn path the only thing in $DEST is the marker file — copy it
# anyway, so an extension-less .appex is self-identifying if the artifact is
# unzipped later.
if [[ -n "${BUILT_PRODUCTS_DIR:-}" && -n "${WRAPPER_NAME:-}" ]]; then
  appex="${BUILT_PRODUCTS_DIR}/${WRAPPER_NAME}"
  mkdir -p "$appex"
  rsync -a --exclude '.gitkeep' --exclude 'README.md' "$DEST"/ "$appex"/
  # This rsync has no --delete (the .appex holds other build products), so a
  # marker copied in by a previous warn-path build would survive a later
  # successful sync. Clear it explicitly once real resources are present.
  if [[ -f "$DEST/manifest.json" ]]; then
    rm -f "$appex/$MARKER_NAME"
  fi
  echo "Copied extension resources into $appex"
fi
