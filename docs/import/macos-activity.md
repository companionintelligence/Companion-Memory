# macOS Activity → summaries → HBPE

The **macOS Activity** import source acquires local activity databases on a Mac
and imports portable snapshots through CI-Server's existing ETL. The API may run
on a Linux appliance or in Docker; it never needs access to the Mac's home folder.

## Supported evidence

| Store | Extracted fields | Destination |
| --- | --- | --- |
| Knowledge `knowledgeC.db` | App/web usage, web domain when present, lock/backlight state, original timestamps and spans | `ci.events` |
| Safari `History.db` | HTTP(S) visits, page titles and original visit times | `ci.browser_activity` |
| CallHistory `CallHistory.storedata` | Incoming/outgoing calls, address when present, answered state, provider and seconds | `ci.communications` |

All three use `source_system = 'macos_activity'`. Snapshot identity includes a
stable device/account label, source database, source record ID and original
timestamp. Re-exporting under another filename does not create new identities.
Use a distinct label for each Mac/account. Native records synchronized between
different Macs are not deduplicated across device labels or other import sources.

Knowledge is limited to `/app/usage`, `/app/webUsage`, `/device/isLocked`, and
`/display/isBacklit`. Other streams are counted as unsupported in the import drop
ledger. Missing optional columns are tolerated; missing required columns fail
visibly. No import time is substituted for an invalid occurrence timestamp.
Safari visit times do not establish dwell duration. Lock/display state and app
use do not by themselves establish attention, intent, or productivity.

## Acquire and import

1. Deploy the API, summary and HBPE changes and run `make migrate` (or the API's
   normal migration command). No seed or re-index step is required.
2. On the Mac that owns the data, from this checkout:

   ```bash
   python3 scripts/macos/export_activity.py \
     --device-id my-mac-account \
     --output /tmp/macos-activity-2026-09-15
   ```

   Requires Python 3.11+; no extra Python packages. `--sources knowledge safari`
   selects a subset. `--home` supports a mounted/copied account home. The exporter
   uses SQLite's online backup API with `mode=ro`, including committed WAL data,
   and publishes the completed folder atomically. It never renames Apple's files.
   Reuse the device label, but choose a new output directory on each run.
3. Review `macos-activity.json`. Exit 0 means acquisition succeeded; exit 2 means
   a source was unavailable and is recorded in the manifest. Full Disk Access
   may be needed for the terminal under System Settings → Privacy & Security.
   The exporter does not grant permissions or fall back to privileged access.
4. In **Import → Apple → macOS Activity**, upload the snapshot directory. A zip
   containing that directory also works. For a remote appliance, the existing
   authenticated CLI can upload an archive:

   ```bash
   cd /tmp
   zip -r macos-activity-2026-09-15.zip macos-activity-2026-09-15
   # Back in the repository, with CI_SERVER_URL and CI_API_KEY configured:
   yarn workspace @ci/be-api ci-import import /tmp/macos-activity-2026-09-15.zip --wait
   ```

   The CLI uses the API key's owner for tenancy. Only snapshot copies belong in
   the inbox: **the inbox consumes files by moving them**. An incomplete snapshot
   keeps successful records but marks the parse partial with source-specific
   errors. Inspect the import report and `ci-import doctor` after ingestion.
5. Delete unneeded snapshot/archive copies after verification. They contain raw
   private databases, even though only narrow projections become model inputs.

This is an on-demand file connection. Repeating acquisition/import adds newly
retained records with normal deduplication; it does not install a background Mac
agent, propagate source deletions, or promise data beyond Apple's retention.

## Refresh summaries and predictions

Knowledge observations have their own `macos_activity` hourly summary source:
it selects **occurrence time**, includes spans overlapping the hour, clips their
durations to that hour, and groups repeated app/stream/device observations.
Durations are per stream/device; do not add app use, web use and display state
into a single screen-time measure because they can overlap.

The ordinary event-change query excludes this source to prevent an old archive
from looking like current activity. Existing communication/browser queries
already use occurrence time. All queries are user-scoped; deleted, inferred and
predicted macOS events are excluded. Explicit sensitive/incognito flags on
browser records continue to exclude them from summaries.

After a historical import, regenerate the relevant hourly windows through the
existing summary service's operator endpoint (at most 24 hours per request):

```json
{
  "user_id": "<owner UUID>",
  "period_type": "hourly_backfill",
  "start_time": "2026-09-01T00:00:00Z",
  "end_time": "2026-09-02T00:00:00Z",
  "timezone": "UTC",
  "force": true
}
```

Submit to `POST /summary/manual-trigger` on the summary service, and follow its
returned progress URL. See [summary backfill operations](../../backend/apps/summary/README.md#hourly-backfill).
`force` replaces thin summaries written before the import. The migration
invalidates cached HBPE labels when the classified text changes, and HBPE checks
the current text before saving an in-flight label to avoid a stale-write race.

HBPE's existing bootstrap/nightly pipeline labels these hourly summaries and
serializes their lower-confidence gap-filling tokens alongside event tokens.
Run the normal pipeline, or its operator `POST /trigger?user_id=<owner UUID>`
endpoint, after backfill completes. Existing model outputs change only after
serialization/training; old data outside configured HBPE history/day budgets
will not automatically expand those budgets. Measure forecast quality on held-out
days before claiming an accuracy gain. This change provides additional evidence,
not a measured improvement in model accuracy.

## Scope and references

The [source gist](https://gist.github.com/pmanot/30825ccc7e2c0efa048c605c2d1241ef)
is a version-dependent inventory, not a complete schema or retention guarantee.
Messages and Photos already have dedicated importers. Siri, Notes, Mail's
generated summaries, Reminders, Voice Memos, HomeKit, CloudDocs, TCC, CoreDuet,
Find My and Biome are not decoded by this source. TCC is permission state rather
than individual activity; unknown/encrypted stores need separate adapters.

Schema facts were cross-checked against Sarah Edwards's APOLLO
[app usage](https://github.com/mac4n6/APOLLO/blob/master/modules/knowledge_app_usage.txt)
and [web usage](https://github.com/mac4n6/APOLLO/blob/master/modules/knowledge_app_webusage.txt)
research and the mac_apt
[call-history parser](https://github.com/ydkhatri/mac_apt/blob/master/plugins/callhistory.py).
The implementation uses independent narrow projections of those schema fields.
SQLite documents why a [consistent backup](https://www.sqlite.org/backup.html)
is preferable to copying a live database and its WAL at different times.

## Validation

Tests use generated SQLite fixtures, including a committed but uncheckpointed
WAL. Backend tests cover recognition, drops, identity and destination DTOs.
Summary tests cover prompts and run real occurrence-window SQL plus the label
invalidation migration when `MACOS_TEST_DATABASE_URL` names an empty disposable
PostgreSQL database. No personal databases or real model training are required.
