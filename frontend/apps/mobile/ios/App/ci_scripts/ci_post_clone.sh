#!/bin/sh
#
# Forwarder. Apple documents `ci_scripts/` as living beside the Xcode project or
# workspace — which is here — but repository-root placement is also widely used,
# and which one a given Xcode Cloud workflow honours depends on how its primary
# repository and scheme are configured. Rather than guess (guessing wrong means
# the script silently never runs, which looks exactly like the failure it is
# meant to fix), both locations exist and both reach the same code.
#
# The real script is `ci_scripts/ci_post_clone.sh` at the repository root,
# because the work it does — root Yarn install, web bundle build — is repo-wide
# rather than iOS-specific. Read it for what this actually does and why.
#
# Once you can see from a build log which location Xcode Cloud used for this
# workflow, delete the other one.

set -eu

# Six levels up: ci_scripts → App → ios → mobile → apps → frontend → repo root.
REPO_ROOT="${CI_PRIMARY_REPOSITORY_PATH:-$(cd "$(dirname "$0")/../../../../../.." && pwd)}"

TARGET="$REPO_ROOT/ci_scripts/ci_post_clone.sh"

if [ ! -x "$TARGET" ]; then
  echo "✗ forwarder could not find $TARGET (REPO_ROOT=$REPO_ROOT)" >&2
  exit 1
fi

exec "$TARGET"
