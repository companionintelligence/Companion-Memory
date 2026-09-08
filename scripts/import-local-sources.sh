#!/usr/bin/env bash
#
# Import this Mac's personal-data sources into a running CI-Server.
#
# WHY THIS EXISTS
# ---------------
# Acceptance testing the importers needs a corpus, and the best corpus is the
# machine you are sitting at. Assembling it by hand is a half-hour of `cp` and
# `ci` invocations that nobody remembers exactly the same way twice, and
# two of the steps are genuinely dangerous to improvise:
#
#   - THE INBOX CONSUMES WHAT IT IMPORTS, by rename. Point it at
#     ~/Library/Messages and your iMessage history moves into a scratch dir.
#     Every source here is therefore COPIED (APFS-cloned) into the inbox first,
#     and the original is never named as an import target.
#   - Apple Photos is a 30GB bundle whose `originals/` is the only part the
#     importer reads (it ignores Photos.sqlite — the schema drifts between
#     macOS releases). `cp -c` clones it in ~2s and costs no extra disk on APFS,
#     where a plain copy would move 12GB.
#
# USAGE
#   scripts/import-local-sources.sh --list            # what is available, with sizes
#   scripts/import-local-sources.sh --dry-run         # what would be imported
#   scripts/import-local-sources.sh                   # import everything available
#   scripts/import-local-sources.sh imessage photos   # import named sources only
#
# REQUIREMENTS
#   - A running stack (`make dev`) and CI_API_KEY + CI_SERVER_URL exported.
#   - Full Disk Access for your terminal, for the macOS-native sources. Without
#     it they are simply reported unavailable — the script does not fail.
#
set -euo pipefail

CI_SERVER_URL="${CI_SERVER_URL:-http://localhost:3030}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The inbox the server watches. Read from .env so this cannot drift from the
# running server's own configuration.
INBOX="${CI_IMPORT_INBOX_DIR:-$(grep -E '^CI_IMPORT_INBOX_DIR=' "$REPO_ROOT/.env" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)}"

# ---------------------------------------------------------------------------
# The manifest: name | kind | source path | importer it exercises
#
# `kind` decides how the source is staged:
#   file    — a single file copied into a per-source directory
#   dir     — a directory tree, APFS-cloned (falls back to a real copy)
#   photos  — the originals/ subtree of a .photoslibrary, cloned into a package
#   browser — just History + Bookmarks out of a browser profile. The profile
#             directory is ~8GB of cache and Service Worker state; the importer
#             reads two files.
# ---------------------------------------------------------------------------
CORPUS="$HOME/Library/CloudStorage/GoogleDrive-liam@lifescope.io/My Drive/Liam-CI-Import-Tools-Test-Inbox"

MANIFEST=(
  "imessage|file|$HOME/Library/Messages/chat.db|imessage"
  "photos|photos|$HOME/Pictures/Photos Library.photoslibrary|apple_photos"
  "contacts|file|$HOME/Library/Application Support/AddressBook/AddressBook-v22.abcddb|applecontacts"
  "safari|file|$HOME/Library/Safari/History.db|generic"
  "chrome|browser|$HOME/Library/Application Support/Google/Chrome/Default|google_chrome"
  "twitter|dir|$CORPUS/twitter|twitter"
  "amazon|dir|$CORPUS/amazon|amazon"
  "spotify|dir|$CORPUS/spotify|spotify"
  "apple|dir|$CORPUS/apple|apple_health"
  "facebook|dir|$CORPUS/facebook|facebook"
  "instagram|dir|$CORPUS/instagram|instagram"
  "browser|dir|$CORPUS/browser|chromium"
  "linkedin|dir|$CORPUS/linkedin|linkedin"
  "reddit|dir|$CORPUS/reddit|reddit"
  "uber|dir|$CORPUS/uber|uber"
  "claude|dir|$CORPUS/claude|claude"
  "whatsapp|dir|$CORPUS/whatsapp|whatsapp"
)

human_size() {
  local path="$1" kind="${2:-}"
  [ -e "$path" ] || { echo "-"; return; }

  # For a browser profile, report the two files this actually reads rather than
  # the profile's whole cache — otherwise the table claims 8GB for a 5MB import.
  if [ "$kind" = browser ]; then
    du -shc "$path/History" "$path/Bookmarks" 2>/dev/null | tail -1 | cut -f1 | tr -d ' ' || echo "?"
    return
  fi

  du -sh "$path" 2>/dev/null | cut -f1 | tr -d ' ' || echo "?"
}

available() {
  local path="$1"
  [ -e "$path" ] || return 1
  # Readable in practice, not just present: macOS TCC denies reads on
  # Messages/Photos/Contacts without Full Disk Access, and a `test -r` passes
  # anyway. Actually reading a byte is the only honest check.
  head -c 1 "$path" >/dev/null 2>&1 || [ -d "$path" ] && return 0
  return 1
}

list_sources() {
  printf '%-12s %-16s %8s  %s\n' NAME IMPORTER SIZE STATUS
  for row in "${MANIFEST[@]}"; do
    IFS='|' read -r name kind path importer <<<"$row"
    if available "$path"; then
      printf '%-12s %-16s %8s  %s\n' "$name" "$importer" "$(human_size "$path" "$kind")" "available"
    else
      printf '%-12s %-16s %8s  %s\n' "$name" "$importer" "-" "unavailable (missing or not permitted)"
    fi
  done
}

# Stage a source into the inbox and echo the unit path it created.
#
# The path matters: `ci inbox --start` with no `--units` starts EVERY
# ready unit under one label, so a unit left behind by an interrupted run gets
# swept into the next source's label. That is how 118,391 Spotify items were
# once recorded as a Twitter import.
stage() {
  local name="$1" kind="$2" path="$3"
  local dest="$INBOX/$name"

  rm -rf "$dest" "$dest.photoslibrary"

  case "$kind" in
    file)
      mkdir -p "$dest"
      cp -c "$path" "$dest/" 2>/dev/null || cp "$path" "$dest/"
      # SQLite write-ahead files carry the most recent rows; without them a
      # copy can be missing whatever has not been checkpointed yet.
      for sidecar in wal shm; do
        [ -f "$path-$sidecar" ] && cp "$path-$sidecar" "$dest/" 2>/dev/null || true
      done
      ;;
    dir)
      cp -Rc "$path" "$dest" 2>/dev/null || cp -R "$path" "$dest"
      ;;
    browser)
      mkdir -p "$dest"
      for f in History Bookmarks; do
        [ -f "$path/$f" ] && { cp -c "$path/$f" "$dest/" 2>/dev/null || cp "$path/$f" "$dest/"; }
      done
      ;;
    photos)
      # Only originals/ — the importer ignores Photos.sqlite by design, and the
      # rest of the bundle is derivatives worth ~18GB of pointless copying.
      mkdir -p "$dest.photoslibrary"
      cp -Rc "$path/originals" "$dest.photoslibrary/originals" 2>/dev/null \
        || cp -R "$path/originals" "$dest.photoslibrary/originals"
      dest="$dest.photoslibrary"
      ;;
  esac

  # The BASENAME, not the absolute path: `ci inbox --units` matches
  # against the unit paths the scan reports, and the scan reports them relative
  # to the inbox root. Passing an absolute path fails with "Not in the inbox
  # scan" and imports nothing.
  printf '%s' "$(basename "$dest")"
}

import_one() {
  local name="$1" kind="$2" path="$3" importer="$4"

  if ! available "$path"; then
    printf '  %-12s SKIP  unavailable\n' "$name"
    return 0
  fi

  local started elapsed
  started=$(date +%s)

  printf '  %-12s staging (%s)...\n' "$name" "$(human_size "$path" "$kind")"
  local unit
  unit="$(stage "$name" "$kind" "$path")"

  # `--units` pins this run to the unit just staged. Without it the run would
  # also claim anything else sitting in the inbox and label it as this source.
  printf '  %-12s importing...\n' "$name"
  (cd "$REPO_ROOT" && yarn workspace @ci/cli dev inbox --start \
      --units "$unit" --label "local-$name" --wait --timeout 7200) 2>&1 | tail -3

  elapsed=$(( $(date +%s) - started ))
  printf '  %-12s done in %dm%02ds\n\n' "$name" $((elapsed / 60)) $((elapsed % 60))
}

case "${1:-}" in
  --list) list_sources; exit 0 ;;
  --dry-run)
    echo "Would import, in order:"
    list_sources | grep -v unavailable
    exit 0
    ;;
esac

[ -n "$INBOX" ] || { echo "CI_IMPORT_INBOX_DIR not set and not found in .env" >&2; exit 1; }
[ -n "${CI_API_KEY:-}" ] || { echo "CI_API_KEY not set — mint one in Settings → API keys" >&2; exit 1; }
curl -sf -o /dev/null "$CI_SERVER_URL/health" || { echo "No CI-Server at $CI_SERVER_URL — run 'make dev'" >&2; exit 1; }

mkdir -p "$INBOX"
export CI_SERVER_URL

wanted=("$@")
total_started=$(date +%s)

for row in "${MANIFEST[@]}"; do
  IFS='|' read -r name kind path importer <<<"$row"

  if [ ${#wanted[@]} -gt 0 ]; then
    match=0
    for w in "${wanted[@]}"; do [ "$w" = "$name" ] && match=1; done
    [ $match -eq 1 ] || continue
  fi

  import_one "$name" "$kind" "$path" "$importer"
done

printf 'All requested sources finished in %dm.\n' $(( ($(date +%s) - total_started) / 60 ))
