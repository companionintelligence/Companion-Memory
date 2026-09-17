#!/usr/bin/env bash
#
# Take a point-in-time backup of a running CI-Server appliance.
#
# WHY THIS EXISTS
# ---------------
# Two of this appliance's failure modes are unrecoverable rather than merely
# painful, and until this script there was nothing in the repo that addressed
# either one:
#
#   - THE SECRETS VOLUME IS THE ENCRYPTION ROOT. `.env.secrets` carries
#     AUTH_FIELD_ENCRYPTION_KEY and the session pepper (see
#     infrastructure/setup-secrets/entrypoint.sh, which says so in the file's
#     own header). Lose the volume and every encrypted column is ciphertext
#     nobody can read again — restoring a database dump on its own does not
#     help. setup-secrets is idempotent, so a rebuilt appliance quietly
#     generates a NEW key and looks healthy while the old data stays dark.
#   - THE DATABASE IS THE MEMORY. Everything the appliance has ever ingested
#     lives in one Postgres instance on one host with no replica.
#
# WHAT THIS COVERS
#   - Postgres: a custom-format dump of the application database, plus the
#     cluster's globals (roles and their passwords), which a restore needs
#     before it can own anything.
#   - The secrets file from the secrets volume.
#
# This is a TimescaleDB database (also postgis and pgvector), so a plain
# `pg_restore` of the dump below is NOT sufficient — it has to be wrapped in
# timescaledb_pre_restore()/timescaledb_post_restore(). The full procedure is
# written into every snapshot's COVERAGE.md; do not improvise it.
#
# WHAT THIS DOES *NOT* COVER — read this before trusting a snapshot
#   - OBJECT-STORE BLOBS (the `object-data` volume). Every uploaded file,
#     photo and attachment. The database keeps the rows that reference them;
#     restoring without the blobs gives you a memory full of dangling links.
#   - HBPE MODEL AND CORPUS VOLUMES (`hbpe-models`, `hbpe-corpus`). Models are
#     re-downloadable, the derived corpus is recomputable, and both are large
#     enough that bundling them here would make the routine backup something
#     nobody runs. Losing them costs time, not data.
#   - The import working area (`CI_IMPORT_WORK_DIR`) and anything else on a
#     host bind mount.
#
# Those exclusions are a deliberate scope, not an oversight: this script is the
# thing that makes an appliance RECOVERABLE, and it is small and fast so that a
# person actually runs it before an upgrade. Blob-level backup is a separate
# job — see docs/runbooks/one-off-prod-data-testing.md, which documents the
# whole-`APP_DATA_DIR` tar for the times you need everything.
#
# USAGE
#   scripts/backup/appliance-backup.sh /path/to/backups
#   scripts/backup/appliance-backup.sh --project ci-server-prod ~/backups
#
# The destination must be an ABSOLUTE path outside this checkout. A snapshot
# directory named for the current UTC timestamp is created underneath it.
#
# REQUIREMENTS
#   - A running stack. The `database` container is located by its compose
#     labels, exactly as the Makefile's db_host_port does, so this always
#     targets the stack belonging to $COMPOSE_PROJECT_NAME and never a sibling
#     worktree's.
#   - Docker socket access. No Postgres client is needed on the host: pg_dump
#     runs inside the container over the local socket.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

DATABASE_SERVICE="${DATABASE_SERVICE:-database}"
DATABASE_NAME="${DATABASE_NAME:-companion}"
SECRETS_FILE_IN_CONTAINER="${SECRETS_FILE:-/run/secrets/.env.secrets}"

usage() {
  cat <<EOF
Usage: $(basename "$0") [--project NAME] [--database NAME] <destination-dir>

  Backs up the running appliance's Postgres database and secrets file into a
  timestamped snapshot directory under <destination-dir>.

  --project NAME    Compose project to back up (default: \$COMPOSE_PROJECT_NAME,
                    else derived from this checkout the way the Makefile does)
  --database NAME   Application database to dump (default: ${DATABASE_NAME})

  Does NOT back up object-store blobs or the HBPE model/corpus volumes; see the
  header of this script and the summary it prints.
EOF
}

# Same identity the Makefile computes: repo stem from the origin remote, plus
# the worktree basename for a linked worktree. Duplicated rather than shelled
# out to `make`, so this script stays usable on an appliance that has the
# checkout but not the toolchain.
default_project_name() {
  local repo
  repo="$(basename -s .git "$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null)" 2>/dev/null || true)"
  [ -n "$repo" ] || repo="$(basename "$REPO_ROOT")"
  repo="$(printf '%s' "$repo" | tr '[:upper:]' '[:lower:]')"
  if [ "$(git -C "$REPO_ROOT" rev-parse --git-dir 2>/dev/null || true)" != \
       "$(git -C "$REPO_ROOT" rev-parse --git-common-dir 2>/dev/null || true)" ]; then
    repo="$repo-$(basename "$REPO_ROOT" | tr '[:upper:]' '[:lower:]')"
  fi
  printf '%s' "$repo"
}

PROJECT_NAME="${COMPOSE_PROJECT_NAME:-}"
DESTINATION=""

while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT_NAME="${2:-}"; shift 2 ;;
    --database) DATABASE_NAME="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    *)
      if [ -n "$DESTINATION" ]; then
        echo "Error: more than one destination given ('$DESTINATION' and '$1')." >&2
        exit 2
      fi
      DESTINATION="$1"; shift ;;
  esac
done

[ -n "$PROJECT_NAME" ] || PROJECT_NAME="$(default_project_name)"

# ── Refuse an obviously wrong destination ────────
#
# A backup that lands somewhere surprising is worse than no backup: it is a
# multi-gigabyte file full of secrets sitting where nobody looks for it, and
# these dumps contain role password hashes and the field-encryption key. Every
# check below has a failure it is preventing, named in its message.

if [ -z "$DESTINATION" ]; then
  echo "Error: no destination directory given." >&2
  usage >&2
  exit 2
fi

case "$DESTINATION" in
  /) echo "Error: refusing to write a snapshot into '/'." >&2; exit 2 ;;
  /*) ;;
  *)
    echo "Error: destination must be an absolute path, got '$DESTINATION'." >&2
    echo "       A relative path resolves against whatever directory you happen" >&2
    echo "       to be in, which is how a snapshot ends up inside a git checkout." >&2
    exit 2 ;;
esac

# Normalise without requiring the leaf to exist yet. The parent is resolved on
# its own line: `A=$(x)/$(y)` reports y's exit status, so folding this into one
# assignment would silently accept a destination whose parent is missing.
dest_parent="$(cd "$(dirname "$DESTINATION")" 2>/dev/null && pwd)" || true
if [ -z "$dest_parent" ]; then
  echo "Error: parent directory of '$DESTINATION' does not exist." >&2
  exit 2
fi
DESTINATION="${dest_parent%/}/$(basename "$DESTINATION")"

if [ "$DESTINATION" = "${HOME:-/nonexistent}" ]; then
  echo "Error: refusing to write a snapshot directly into '$DESTINATION'." >&2
  echo "       Give it a directory of its own, e.g. \$HOME/ci-backups." >&2
  exit 2
fi

case "$DESTINATION/" in
  "$REPO_ROOT"/*)
    echo "Error: '$DESTINATION' is inside the CI-Server checkout at $REPO_ROOT." >&2
    echo "       These files contain the field-encryption key and role password" >&2
    echo "       hashes; they must never be one 'git add -A' away from a commit." >&2
    exit 2 ;;
esac

# ── Locate the running database container ────────

if ! command -v docker >/dev/null 2>&1; then
  echo "Error: docker is not on PATH. This script drives the running stack." >&2
  exit 1
fi

# `|| true` because pipefail is on: a docker daemon that is down would
# otherwise abort here with a bare exit code instead of the message below.
container="$(docker ps \
  --filter "label=com.docker.compose.project=${PROJECT_NAME}" \
  --filter "label=com.docker.compose.service=${DATABASE_SERVICE}" \
  --format '{{.Names}}' 2>/dev/null | head -n1 || true)"

if [ -z "$container" ]; then
  echo "Error: no running '${DATABASE_SERVICE}' container for compose project '${PROJECT_NAME}'." >&2
  echo "       Start the stack first, or pass --project with the right name." >&2
  echo "       Running projects:" >&2
  docker ps --format '  {{.Label "com.docker.compose.project"}}/{{.Label "com.docker.compose.service"}}' \
    2>/dev/null | sort -u >&2 || true
  exit 1
fi

# Fail before writing anything if the database is not actually there — an empty
# 0-byte "backup" that only reveals itself at restore time is the worst outcome
# this script can produce.
if ! docker exec -u postgres "$container" psql -d "$DATABASE_NAME" -c 'SELECT 1' >/dev/null 2>&1; then
  echo "Error: cannot reach database '${DATABASE_NAME}' inside ${container}." >&2
  echo "       Pass --database with the right name (see DATABASE_NAME in the" >&2
  echo "       deployment's .env.secrets)." >&2
  exit 1
fi

# ── Create the snapshot directory ────────────────

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
snapshot="${DESTINATION}/${PROJECT_NAME}-${stamp}"

if [ -e "$snapshot" ]; then
  echo "Error: '$snapshot' already exists; refusing to overwrite a backup." >&2
  exit 1
fi

mkdir -p "$snapshot"
# 0700 from the moment it exists: the dump below carries role password hashes.
chmod 700 "$snapshot"

printf '➤ Backing up compose project %s from container %s\n' "$PROJECT_NAME" "$container"
printf '  into %s\n\n' "$snapshot"

# ── Postgres ─────────────────────────────────────
#
# Two files, because one is not enough to restore. `--globals-only` carries the
# roles (companion, powersync) that every object in the dump is owned by, and
# a plain pg_dump restored into a cluster without them fails on the first
# GRANT. Custom format (-Fc) for the data so a restore can be selective and
# parallel.
#
# pg_dump runs INSIDE the container as the postgres unix user: the official
# image's pg_hba grants trust on the local socket, so no password has to be
# read out of the secrets file, and the client version always matches the
# server's.

printf '  [1/3] pg_dumpall --globals-only … '
docker exec -u postgres "$container" pg_dumpall --globals-only > "${snapshot}/globals.sql"
# pg_dumpall exiting 0 having written nothing would leave a zero-byte globals.sql
# that only fails at restore time, on the first GRANT.
if [ ! -s "${snapshot}/globals.sql" ]; then
  echo >&2
  echo "Error: ${snapshot}/globals.sql is empty; the globals dump produced nothing." >&2
  echo "       The snapshot has been left in place for inspection; do NOT rely on it." >&2
  exit 1
fi
printf 'done\n'

printf '  [2/3] pg_dump -Fc %s … ' "$DATABASE_NAME"
docker exec -u postgres "$container" pg_dump -Fc --no-password "$DATABASE_NAME" > "${snapshot}/${DATABASE_NAME}.dump"
printf 'done\n'

# Read the dump's table of contents back, by streaming it into pg_restore in
# the same container (custom-format archives keep their TOC at the head, so
# `-l` works on a pipe). This is the archive's inventory, kept as evidence of
# what the snapshot contains — it proves the header and TOC are well-formed,
# and nothing more.
if ! docker exec -i -u postgres "$container" pg_restore -l \
      < "${snapshot}/${DATABASE_NAME}.dump" > "${snapshot}/${DATABASE_NAME}.toc" 2>/dev/null; then
  echo "Error: the dump at ${snapshot}/${DATABASE_NAME}.dump is not a readable archive." >&2
  echo "       The snapshot has been left in place for inspection; do NOT rely on it." >&2
  exit 1
fi

# Now the check that actually catches a short file. pg_dump -Fc writes the
# header and TOC before any data, so the listing above still succeeds on a dump
# truncated partway through the data — and streaming pg_dump's output through a
# pipe to the host is exactly where a truncation would happen. `-f /dev/null`
# is text-output mode: it opens no database and restores nothing, it decodes
# every data member in sequence and throws the SQL away, which is what makes a
# short read fail here instead of at restore time. It costs a second full
# decompressing pass over the dump; that is the price of the guarantee.
printf '        verifying every data block reads back … '
if ! docker exec -i -u postgres "$container" pg_restore -f /dev/null \
      < "${snapshot}/${DATABASE_NAME}.dump" 2>/dev/null; then
  echo >&2
  echo "Error: the dump at ${snapshot}/${DATABASE_NAME}.dump is truncated or corrupt." >&2
  echo "       Its table of contents reads, but at least one data block does not." >&2
  echo "       The snapshot has been left in place for inspection; do NOT rely on it." >&2
  exit 1
fi
printf 'ok\n'

# ── Secrets ──────────────────────────────────────

printf '  [3/3] secrets file … '
secrets_status="copied"
if docker cp "${container}:${SECRETS_FILE_IN_CONTAINER}" "${snapshot}/.env.secrets" 2>/dev/null; then
  chmod 600 "${snapshot}/.env.secrets"
  # A copy that succeeded is not the same as a copy worth having. The one line
  # that makes this file the encryption root is AUTH_FIELD_ENCRYPTION_KEY (see
  # infrastructure/setup-secrets/entrypoint.sh, which writes it); without it the
  # dump's encrypted columns stay unreadable however the snapshot is restored,
  # and reporting "copied" would be the same false confidence as a 0-byte dump.
  if grep -q '^AUTH_FIELD_ENCRYPTION_KEY=.' "${snapshot}/.env.secrets"; then
    printf 'done\n'
  else
    secrets_status="NO ENCRYPTION KEY"
    printf 'copied, but it carries no AUTH_FIELD_ENCRYPTION_KEY\n'
  fi
else
  secrets_status="MISSING"
  printf 'not present in this container\n'
fi

# ── Coverage note, written next to the data ──────
#
# On disk rather than only on stdout: whoever finds this directory in a year is
# not the person who ran the command, and the exclusions are exactly what they
# will otherwise assume are included.

# Two facts the restore needs that a -Fc dump does not carry. The archive holds
# no CREATE DATABASE (that needs --create), so whoever runs `createdb` picks the
# owner — restore into a postgres-owned database and the application role can
# never create anything new in it. And the archive's CREATE EXTENSION lines only
# succeed if the target cluster has those extensions installed at a version at
# least the source's, which is worth knowing before the restore, not during it.
# Neither query interpolates a value into SQL: `psql -d` selects the database
# and the owner is looked up through current_database().
database_owner="$(docker exec -u postgres "$container" psql -tAd "$DATABASE_NAME" \
  -c 'SELECT pg_catalog.pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()' \
  2>/dev/null | head -n1 || true)"
# If the lookup fails, say so in the instructions rather than guessing: a
# plausible-looking wrong owner is worse than a line that refuses to run
# (createdb rejects an unknown role), because it restores and looks fine.
[ -n "$database_owner" ] || database_owner="UNKNOWN_OWNER_see_globals.sql"

extension_list="$(docker exec -u postgres "$container" psql -tA -F' ' -d "$DATABASE_NAME" \
  -c 'SELECT extname, extversion FROM pg_extension ORDER BY extname' 2>/dev/null \
  | sed '/^$/d; s/^/- /' || true)"
[ -n "$extension_list" ] || extension_list="- (could not be read from the source cluster)"

cat > "${snapshot}/COVERAGE.md" <<EOF
# Appliance backup — ${PROJECT_NAME} — ${stamp}

Taken by scripts/backup/appliance-backup.sh from container \`${container}\`.

## Included

| File | Contents |
|------|----------|
| \`${DATABASE_NAME}.dump\` | Custom-format pg_dump of the application database |
| \`${DATABASE_NAME}.toc\` | Its table of contents — the inventory of the dump |
| \`globals.sql\` | Cluster roles and their passwords (restore this FIRST) |
| \`.env.secrets\` | Deployment secrets, incl. the field-encryption key (${secrets_status}) |

## NOT included

- **Object-store blobs** (\`object-data\` volume) — uploads, photos, attachments.
  The database rows that reference them ARE here, so a restore from this
  snapshot alone yields a memory whose files are missing.
- **HBPE models and corpus** (\`hbpe-models\`, \`hbpe-corpus\`) — re-downloadable
  and recomputable respectively.
- **Import working area** (\`CI_IMPORT_WORK_DIR\`) and any other host bind mount.

## Verified when this snapshot was taken

- \`globals.sql\` is non-empty.
- Every data block of \`${DATABASE_NAME}.dump\` decodes (\`pg_restore\` read the
  whole archive, not just its header), so the file is not truncated.

Nothing here proves the dump *restores*; only a trial restore does that.

## Restoring

This is a **TimescaleDB** database — hypertables on \`measurements\`,
\`communications\`, \`activities\`, \`voice_recordings\`, \`position\`,
\`habit_completions\`, \`ci.user_snapshots\` and \`hbpe.prediction_log\`, several
of them compressed. A plain \`pg_restore\` is **not** sufficient: it has to be
wrapped, and the target cluster must run TimescaleDB with
\`shared_preload_libraries=timescaledb\` at a version at least the source's.

\`\`\`sh
psql -U postgres -f globals.sql
createdb -U postgres -O ${database_owner} ${DATABASE_NAME}
psql -U postgres -d ${DATABASE_NAME} -c "CREATE EXTENSION IF NOT EXISTS timescaledb;"
psql -U postgres -d ${DATABASE_NAME} -c "SELECT timescaledb_pre_restore();"
pg_restore -U postgres -d ${DATABASE_NAME} ${DATABASE_NAME}.dump
psql -U postgres -d ${DATABASE_NAME} -c "SELECT timescaledb_post_restore();"
\`\`\`

- \`CREATE EXTENSION\` comes first because \`timescaledb_pre_restore()\` is a
  function the extension provides — it does not exist in a freshly \`createdb\`'d
  database.
- \`createdb -O ${database_owner}\` because the archive carries no
  \`CREATE DATABASE\` (that needs \`pg_dump --create\`): restore into a
  postgres-owned database and the application role cannot create anything new
  in it. \`globals.sql\` must therefore be loaded first, so that role exists.
- \`pg_restore\` will report an error for the archive's own
  \`CREATE EXTENSION timescaledb\`, which already exists. That one is expected.
- \`timescaledb_post_restore()\` is **mandatory even if pg_restore reported
  errors**. Skipping it leaves the database in \`timescaledb.restoring\` mode
  with its background workers — the compression and retention policies — off.
- Then sanity-check before trusting it:
  \`SELECT hypertable_schema, hypertable_name FROM timescaledb_information.hypertables;\`
  and \`SELECT * FROM timescaledb_information.jobs;\`.

The extensions this database had when the dump was taken must all be installed
on the target cluster (their \`CREATE EXTENSION\` statements in the archive need
superuser), at these versions or newer:

${extension_list}

Then restore \`.env.secrets\` to the secrets volume **before** first boot.
setup-secrets is idempotent and will silently generate a fresh
AUTH_FIELD_ENCRYPTION_KEY if the file is absent, after which the encrypted
columns in the dump above can never be read again.
EOF

# ── Summary ──────────────────────────────────────

printf '\n✓ Backup complete: %s\n\n' "$snapshot"
du -ah "${snapshot}" 2>/dev/null | sed 's/^/    /'
printf '\n  NOT backed up: object-store blobs (object-data), HBPE models and\n'
printf '  corpus (hbpe-models, hbpe-corpus), and the import working area.\n'
printf '  This is a TimescaleDB database: a plain pg_restore of the dump will NOT\n'
printf '  reproduce it. Follow the procedure in %s/COVERAGE.md.\n' "$snapshot"

if [ "$secrets_status" = "MISSING" ]; then
  printf '\n  WARNING: no %s in %s.\n' "$SECRETS_FILE_IN_CONTAINER" "$container"
  printf '  This deployment keeps its credentials somewhere else (staging and local\n'
  printf '  read them from the repo .env). Back that file up separately — without\n'
  printf '  AUTH_FIELD_ENCRYPTION_KEY the dump above is only partly restorable.\n'
elif [ "$secrets_status" != "copied" ]; then
  printf '\n  WARNING: %s was copied but carries no AUTH_FIELD_ENCRYPTION_KEY.\n' "$SECRETS_FILE_IN_CONTAINER"
  printf '  Find the file that does hold the key for this deployment and back it up\n'
  printf '  separately — without it the encrypted columns in the dump above cannot\n'
  printf '  be read after a restore.\n'
fi
