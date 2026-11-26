# Back up, restore and update a Memory appliance

An account export moves one person's information between appliances. A complete
appliance snapshot also preserves uploaded files, the database, model/corpus
volumes and the encryption key needed to read encrypted fields. Keep snapshots
on a separate encrypted disk with access limited to the appliance owner.

## Take a complete snapshot

Requires Python 3.10+, Docker CLI access and enough space for all persistent
stores. Run from the deployment checkout. Select the exact Compose project;
`docker compose ls` lists projects. The tool never guesses which appliance to
stop. It stops every running container in that project, copies its persistent
stores, checks the archives, then restarts only containers that were running.
Plan a maintenance window: larger stores take longer and Memory is unavailable
while the copy runs. A failed backup resumes the original containers and never
publishes a partial snapshot as successful.

```bash
./scripts/backup/appliance-backup.sh --project my-memory /Volumes/MemoryBackup/snapshots
```

For a deployment with its master key in a host environment file, pass that
complete file before the destination:

```bash
./scripts/backup/appliance-backup.sh --project my-memory \
  --secrets-file /absolute/path/deployment.env /Volumes/MemoryBackup/snapshots
```

Production Compose and Hub deployments normally keep `.env.secrets` in the
`generate-secrets` or `setup-secrets` container's `/run/secrets` mount. The
snapshot includes that master and its service projections. A missing master
`AUTH_FIELD_ENCRYPTION_KEY` is a failure; per-service projections alone cannot
recover encrypted memory. Do not regenerate the key during recovery.

Each successful snapshot is a private directory containing `manifest.json`,
checksummed volume archives and, when supplied, `deployment.env`. The manifest
records storage image IDs: retain access to those images. Copies of read-only
source archives mounted at `/repo`, source code and environment files outside
the selected persistent stores are excluded. Keep the deployment's Compose
configuration and original imports separately. Docker volumes are captured. A
bind mount is captured only at a known data path: the database, object store,
model and corpus folders, the secrets mounts and the import working area
(`CI_IMPORT_WORK_DIR`, mounted at `/var/lib/ci-import`). Other bind mounts are
excluded, and the manifest records the actual stores captured. The tool supports
one complete database/object-store deployment, not a remote or replicated
database with independent writers. External PostgreSQL tablespaces require a
separate managed backup.

The earlier logical database-only tool is retained as
[`database-backup.sh`](../../scripts/backup/database-backup.sh). Its restore
procedure and scope differ; do not treat it as a complete appliance snapshot.

## Schedule snapshots and display their status

Run this under the host's existing service manager, using absolute paths and a
service account with Docker access. `--status-directory` names the dedicated
directory that receives the sanitized status copy described below:

```bash
python3 /absolute/path/Companion-Memory/scripts/backup/appliance-recovery.py serve \
  --project my-memory --interval-hours 24 --keep 7 \
  --status-directory /absolute/path/memory-backup-status \
  /Volumes/MemoryBackup/snapshots
```

`serve` attempts a snapshot immediately and then every 24 hours. It retains the
newest seven snapshot directories for this project after a successful copy;
other projects, unrelated directories and previous successful snapshots after a
failure are left alone. Preserve another copy offline. Stop the service before
an update or restore so a scheduled snapshot cannot overlap maintenance.

Every run, scheduled or not, writes `my-memory.status.json` beside the
snapshots. That file is private to the backup directory: it names the latest
snapshot and keeps the raw error of a failed run. With `--status-directory`
(accepted by `backup`, `serve` and `update`) each run also publishes a sanitized
copy of it to that directory: the project, state, last success and failure
times, size and scope, and nothing else. Use a directory of its own, outside the
backup directory; the tool refuses one that holds anything but sanitized status
files. Mount that directory read-only into the API and set
`CI_BACKUP_STATUS_FILE` to the file inside it, for example
`/backup-status/my-memory.status.json`. Mount the directory, not the file: each
run replaces the status file, and a mount of the single file would keep showing
the old copy.

Settings → System status shows administrators the state (a last success older
than 48 hours reads as overdue), the time of the last success, the size and the
scope; other users cannot see backup status. The API never exposes snapshot
paths or raw backup errors. Read the private status file and the scheduler log
to investigate failures. A status of “complete” means archive
capture/verification succeeded; only a restore drill proves recovery.

## Restore to a separate prepared deployment

1. Copy a snapshot and its original Compose configuration to the recovery host.
   Verify its bytes before changing the target:

   ```bash
   python3 scripts/backup/appliance-recovery.py verify /absolute/path/snapshot
   ```

2. Prepare a **separate** Compose project with the same services, mount
   destinations and persistent stores, and the exact database/object-store
   image IDs from `manifest.json`. Create its containers and volumes without
   migrating or seeding them (`docker compose ... create`). Avoid using a live
   appliance as the recovery target. Target data will be replaced.

3. If the snapshot includes `deployment.env`, copy it to the deployment's
   environment path before creating the target and add `--environment-restored`
   below. Keep it private. Otherwise the secrets mount is restored directly.

4. Restore, naming the target twice to acknowledge replacement:

   ```bash
   ./scripts/backup/appliance-restore.sh --project recovery-memory \
     --confirm-project recovery-memory /absolute/path/snapshot
   ```

   Every archive is checked before the target stops or changes. A different
   storage image, unmatched persistent store, missing key, corrupt archive or
   mount shared with another project is refused. Restore failure leaves the
   target stopped: correct the problem and repeat the entire restore. The
   original snapshot remains intact. Originally stopped containers stay
   stopped after a successful restore; start the recovered stack explicitly.

5. Start the recovered stack using its matching images. Verify login, the
   expected memory record, an uploaded file's actual bytes, search and an
   encrypted connection. Record the date, image IDs and result. Upgrade only
   after these checks succeed. Do not point the source and recovery stacks at
   the same volumes.

## Take a snapshot before updating

This wrapper refuses to pull or start updated images until a complete snapshot
has succeeded. Supply the same files/profiles/environment as the deployment:

```bash
python3 scripts/backup/appliance-recovery.py update --project my-memory \
  /Volumes/MemoryBackup/snapshots -- \
  -f docker-compose.yml -f docker-compose.production.yml --profile production
```

It runs Compose `pull` then `up -d --wait` with a three-minute health timeout.
For a host environment deployment, supply `--secrets-file` before the backup
destination and `--env-file` after `--`. Failure retains the completed snapshot
and reports the recovery path. It never automatically starts an old image on a
newer schema: restore into a matching prepared deployment using the procedure
above. Direct Compose and Hub updates can bypass this wrapper; integrate it
with the host's update procedure. This repository cannot enforce a Hub updater
hook in another repository.

## Verify the recovery system

```bash
make test-recovery                         # unit checks; no Docker required
make test-recovery-docker                  # real isolated restore, then cleanup
```

The real drill creates labelled, disposable source and target projects and
checks a PostgreSQL record, binary uploaded file and master key after restore.
It removes its containers and volumes on completion. Set
`CI_RECOVERY_DATABASE_IMAGE` to a pinned compatible appliance database image
when `ci/database:latest` is unavailable. Each appliance still needs a restore
drill against its own deployment configuration and external stores.
