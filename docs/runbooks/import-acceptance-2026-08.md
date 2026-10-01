# Import acceptance — CI-Server, August 2026

> **Purpose:** does CI-Server's own import domain do what CI-Import-Tools did,
> well enough to retire that repo? This is the record of one acceptance pass
> against a live stack, with the real archives and the real output.
>
> Companion docs: the CLI in [`docs/cli/ci.md`](../cli/ci.md), the
> enrichment half in [`pipeline-operations.md`](pipeline-operations.md), and the
> ETL as a whole in [`docs/import/etl-agent-guide.md`](../import/etl-agent-guide.md).
>
> **The commands below say `ci-import` because that is what was typed.** The
> binary has since been renamed `ci` and moved to its own workspace
> (`backend/apps/cli`); `ci-import` still runs, as a deprecated alias. This is a
> record of a pass that happened, so it is left as it was run rather than
> rewritten to match today's spelling.

> **Answered (2026-08-19): yes.** The repo was retired — renamed
> **`ZARCHIVED-CI-Import-Tools`** on GitHub (the prefix is the retirement signal;
> `isArchived` is still `false`). One live caller survives and is a known
> follow-up, not an oversight: `video/stage.real-corpus.sh` still shells out to a
> standalone checkout at `$CI_IMPORT_TOOLS` for its GraphQL-lane bulk push, and
> says so at lines 55-62. Nothing else in the tree depends on it — the remaining
> occurrences are the historical provenance constant
> `source_type = 'ci-import-tools'` (one third of the dedup triple; changing it
> would duplicate every previously imported record) and the `ci-import-tools`
> entry in the Portal audience allowlist.

Everything below was run on `main` at `d7cc6e102`, against a per-worktree dev
stack (`make dev`), fresh database, all migrations applied. Numbers are what
came back, not what should have come back. **This is a dated record, not a
current-state document** — where a figure has since moved it carries a dated
correction note rather than being silently overwritten.

---

## What was exercised

| Surface | How | Result |
|---|---|---|
| `ci-import datasources` | CLI → live API | **71** importers listed (see the note under the table) |
| `ci-import recognize <path>` | CLI → `POST /import/recognize` | works; needs `CI_IMPORT_ROOTS` |
| `ci-import import <file> --wait` | 425KB zip, then 2.7GB Takeout | upload → unpack → parse → media → push |
| `ci-import inbox` / `--start` | two units (601MB + 425KB) | scanned, started, consumed by rename |
| Import wizard (web) | `/sources/import` | Pick/Export/Sync + Inbox/History, live per-stage progress |
| Post-ingest enrichment | automatic, after push | embeddings, vectors, person links, places |
| Domain test suites | jest, incl. integration vs live DB | 2,641 unit + 97 import integration pass |
| WhatsApp mappers (#2037) | 601MB export through the inbox | 681 outbound correctly identified, 100% thread-grouped |

> **Correction, 2026-08-19.** That row originally read "80 importers listed",
> which is not a number the command can print. `ci-import datasources` reports
> `allDataSources().length` — one row per `registerDataSource` call reached
> through `datasources/index.ts` — which was **71** at `d7cc6e102` and is still
> 71 at `ead9fb425`. The other list, `--catalog` (authored *services*, including
> ones whose importer is not written yet), was **104** at both commits. Checked
> against the tree, not by re-running the pass.

## The 2.7GB archive

`takeout-20260619T044111Z-13-001.zip` — Google Voice (73,123 files), Fit
(5,982), Contacts (1,292), Google Chat, Maps, My Activity, Keep, Chrome,
Calendar, Timeline.

```
unpack  completed        1 / 1          36.5s
parse   completed  704,226 / 704,226   793.1s
media   completed        0 / 0           0.2s
push    completed  704,226 / 704,226   357.4s   (after the batching fix below)
```

Parse recognized twelve sources and staged from ten:

```
 data_source        | staged
--------------------+--------
 google_my_activity | 322897
 google_voice       | 309689
 google_fit         |  66579
 withings           |   1661   ← wrong; see finding 1
 google_purchases   |     42
 generic            |     30
 google_maps_places |      5
 calendar           |      3
 google_keep        |      2
 vcard              |      1
```

Kind-based routing holds: Google Voice lands in `ci.communications`
(35,260 rows at the snapshot), not flattened into `ci.events`. Positions land in
`ci.position` (7,248). This was the flattening bug the consolidation was
supposed to fix, and it is fixed.

## Post-ingest enrichment now runs by itself

The gap that blocked retiring CI-Import-Tools — bulk loads that wrote rows and
never enriched them — is closed. No operator step, no backfill invocation:

```
 stage                         | status  | count
-------------------------------+---------+-------
 index.embed_browser_activity  | done    | 50010
 index.embed_communication     | done    | 50726
 index.embed_person            | done    |  2801
 index.vector_browser_activity | done    | 18693
 index.vector_communication    | done    | 16776
 enrich.person_link            | done    |  2279
 promote.edge_communication    | done    |  2279
```

103,824 rows in `ci_search.embeddings` while the push was still running.

The media leg works too: the 425KB smoke archive produced 31 `ci.files` rows
with `user_id` populated — the two specific things that were missing after the
consolidation.

## Findings

### 1. Withings claimed Google Fit's data — FIXED

`Takeout/Fit/Daily activity metrics/Daily activity metrics.csv` has the header

```
Date,Move Minutes count,Calories (kcal),…,Average weight (kg),Max weight (kg),Min weight (kg),…
```

The Withings recognizer asked only whether the header started with `Date,` and
contained `(kg)` **anywhere**. Both true. Withings won the file at 0.85 and
staged 1,661 rows of Google Fit daily metrics as `data_source='withings'`,
carrying `metadata.Source = "Withings"` — and `withings` then appeared in the
run's `data_sources`, telling the user a service they have never used had given
the appliance data.

Fixed by reading columns instead of substrings: an aggregate
(`Average…`/`Max…`/`Min…`) is a statistic about a measurement, not a
measurement. A real Withings export names its columns outright
(`Weight (kg)`, `Fat mass (kg)`) and still matches.

### 2. Discord claimed Google Chat — FIXED

`Google Chat/Groups/<Space|DM …>/messages.json` is the exact layout Discord's
directory recognizer looked for, and it checked the **filename only** while the
file-level branch checked content. Discord matched the folder at 0.85. It staged
nothing (the parser correctly read nothing it understood), but the service was
still reported as recognized.

Fixed by giving the directory branch the same content check the file branch
already had, behind a cheap 4KB prefix sniff so a large export is not parsed in
full to be rejected.

### 3. `import --wait` exited 0 on an unfinished run — FIXED

The most consequential of the three, because a script reads the exit code.

`waitForRuns` caught **every** `getRun` failure and dropped the run from the
wait set — the comment said "gone, or momentarily unreachable", and treated the
two identically. When the appliance restarted mid-import (a deploy, a worker
recycling, `nodemon` reloading in development), the poll failed once, the only
pending run was dropped, the loop found nothing pending and returned
successfully. Observed for real: `ci-import import … --wait` printed
`87% running push/pushing 99847/704226` and exited **0** with the push at 14%.

Fixed: a 404 still means gone; everything else is retried up to five consecutive
failures and then raised as `WaitUnreachableError` (exit 2), naming the run and
how to follow it.

### 4. Fitbit claims a Google-Fit-only export — by design, worth revisiting

`FitbitFileImporter.recognize` deliberately claims a Takeout `Fit/` folder below
Google Fit's own confidence, "so the import resolves a root instead of importing
nothing". It contributes no rows, and the run's `data_sources` correctly
excludes it — but `recognize` and the parse-stage banner both list it, which
reads as a false positive to anyone looking. Left alone: the intent is
documented and the run record is honest.

### 5. Geocoding failures are the external provider, not the pipeline

`enrich.geocode` (2) and `enrich.position_reverse` (322) recorded
`provider_unavailable` — `OVER_QUERY_LIMIT` or transport failure from the
metered provider behind CI-Portal. The stages mark these **failed and
retryable** on purpose rather than writing the rows off as empty, so they come
back on the provider's schedule. Expected on a dev box; worth watching on an
appliance.

### 6. Push throughput — the push was per-row — FIXED

First read of this was wrong and is corrected here. The observation was right:
1,000 rows/minute with Postgres **idle** (`ClientRead` on every connection)
while the host sat at 79% user CPU. The conclusion — "starved of CPU, re-measure
on an idle box" — was not. Postgres was idle because the client was giving it
one tiny statement at a time.

`PushStage.pushBatch` read 500 staged rows and then walked them one at a time,
spending at least three sequential round trips on each: `participantsFor(row.id)`
for its edges, one `createManyDetailed(ctx, [record])` per destination — a batch
API called with a single-element array — and one `UPDATE` to record the outcome.
704,226 rows meant roughly two million sequential round trips.

Batched (one edge query per batch, one service call per destination per batch,
one `UPDATE` per outcome group), measured on the same run, same box, same data:

```
before   1,000 – 3,500 rows/min
after           73,000 rows/min
```

Position writes went from `"count": 1` per call to 36–47, with no fallbacks.
The whole 704,226-row push then finished in **357 seconds**. Load average was
*higher* during the fast measurement (301) than the slow one (57), which is the
clearest evidence that CPU was never the ceiling.

## Gotchas for the next person

- **Environment changes need a full stack restart.** overmind exports `.env` to
  its children and dotenv will not override an already-set variable, so editing
  `.env` and letting nodemon reload silently keeps the old value. `CI_IMPORT_ROOTS`
  looked broken for ten minutes because of this.
- **The dev-stack reallocates ports on every `up`.** `IMPORT_TEST_DATABASE_URL`
  pinned to yesterday's port fails as "nothing accepting connections", which
  reads like an absent database. Always take it from `make dburl`.
  *(Since 2026-09-30 an explicit URL that refuses connections fails the suite,
  naming the variable, instead of skipping it.)*
- **`*_TEST_PROBE_TIMEOUT_MS` matters on a loaded box.** The synchronous probe
  spawns a node process; 2,000 ms is not always enough to spawn it.
  *(Fixed 2026-09-30: a probe killed before it could answer read as "no
  database" and skipped the suite. Start-up now has its own 10 s allowance and
  up to three attempts, and a probe that still cannot answer fails the suite —
  it can no longer skip it. The variable is only the socket timeout now.)*
- **The inbox consumes what it imports** (unpack acquires by rename). Copy into
  it; never point it at the only copy of a corpus. The upload path (`ci-import
  import <file>`) leaves the original alone.
- **`backpressureRelief.integration.spec.ts` refuses to run while a queue has
  work** — by design. Run the pipeline suite on an idle appliance.
- **Known flake:** `gmail_relationships.test.ts` asserts wall-clock < 2,000 ms;
  it took 156 ms alone and 2,223 ms under this load. Re-run before believing it.
