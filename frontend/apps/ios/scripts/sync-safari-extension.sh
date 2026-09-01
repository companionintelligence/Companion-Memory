#!/usr/bin/env bash
# Fill SafariWebExtension/Resources from CI-Browser-Extension (sibling checkout
# or a pinned GitHub safari-mobile release). Fail closed so an archive never
# ships an empty .appex.
#
# BOTH CI PATHS ARE CURRENTLY BROKEN, AND NOT FIXABLE FROM THIS REPO ALONE
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
#   Unblocking CI needs an action in the OTHER repo: publish a v1.5.0 (or
#   whatever PINNED_VERSION says) release there with a safari-mobile.zip
#   asset, built via its own already-existing `npm run zip:safari-mobile`.
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
  # shellcheck disable=SC1091
  source "${HOME}/.nvm/nvm.sh"
fi

IOS_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$IOS_ROOT/../../.." && pwd)"
DEST="$IOS_ROOT/ios/App/SafariWebExtension/Resources"
PINNED_VERSION="${CI_BROWSER_EXTENSION_VERSION:-1.5.0}"
GH_REPO="${CI_BROWSER_EXTENSION_REPO:-companionintelligence/CI-Browser-Extension}"

if [[ -n "${CI_BROWSER_EXTENSION_DIR:-}" ]]; then
  EXT_DIR="$CI_BROWSER_EXTENSION_DIR"
else
  EXT_DIR="$(cd "$REPO_ROOT/.." && pwd)/CI-Browser-Extension"
fi

mkdir -p "$DEST"

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

if [[ ! -f "$DEST/manifest.json" ]]; then
  echo "error: Safari Web Extension Resources are empty ($DEST). Refusing to archive." >&2
  exit 1
fi

echo "Safari Web Extension resources ready at $DEST"

# When Xcode runs this phase, also copy into the built .appex (manifest at bundle root).
if [[ -n "${BUILT_PRODUCTS_DIR:-}" && -n "${WRAPPER_NAME:-}" ]]; then
  appex="${BUILT_PRODUCTS_DIR}/${WRAPPER_NAME}"
  mkdir -p "$appex"
  rsync -a --exclude '.gitkeep' --exclude 'README.md' "$DEST"/ "$appex"/
  echo "Copied extension resources into $appex"
fi
