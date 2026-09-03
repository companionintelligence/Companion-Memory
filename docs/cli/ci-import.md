# `ci-import` — the import domain at the command line

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

CI-Import-Tools shipped a `ci-import` binary. When the importer was consolidated
into CI-Server the MCP half came across — six tools in
`src/domains/tools/tools/Import*Tool.ts`, served through the shared tool registry
at `@Controller('mcp')` — and the command line did not. This is that command
line, rebuilt against the domain as it now exists.

The upstream repo is retired: it was renamed **`ZARCHIVED-CI-Import-Tools`**
(the `ZARCHIVED-` prefix is the retirement signal — GitHub still reports
`isArchived: false` for it). Everything below is CI-Server's own
`backend/apps/api/src/domains/import/`.

It is **not** a revival of `scripts/cli/ci-server.sh` (PR #1420, reverted in
`7ae057916`). That was a hub-setup / portal-registration / app-lifecycle wizard
and had nothing to do with importing.

---

## Quick start

```bash
export CI_SERVER_URL=http://localhost:3030
export CI_API_KEY=…            # web UI → Settings → API keys
yarn workspace @ci/be-api ci-import datasources
```

Installed, the binary is on the path as `ci-import` (declared in
`backend/apps/api/package.json` → `bin`, pointing at
`dist/src/domains/import/cli/main.js`). From a checkout, `yarn workspace
@ci/be-api ci-import …` runs the TypeScript directly.

| Setting | Flag | Environment | Default |
|---|---|---|---|
| Appliance URL | `--server` | `CI_SERVER_URL` | `http://localhost:3030` |
| Credential | `--api-key` | `CI_API_KEY`, `CI_SERVER_API_KEY` | none |

Exit codes: **0** success, **2** a failure you can fix (bad path, missing key,
unreachable server, unknown stage), **1** a failure the appliance owns (5xx, an
unexpected exception — which also prints a stack). `doctor` overloads **1** with
one more meaning: its gate tripped — see its section below.

---

## It is an HTTP client, not an embedded server

Every command is a call to a running CI-Server. This is the single decision the
rest of the design follows from, and the alternative — booting a Nest standalone
context and driving `ImportRunService` in-process — is worse in three specific
ways:

1. **It would run a second set of workers.** An import is durable stages on the
   four per-kind pg-boss queues — `import-unpack`, `import-parse`,
   `import-media`, `import-push` (`IMPORT_STAGE_QUEUE_BY_KIND` in
   `domains/import/constants.ts`) — consumed by `ImportStageListener`.
   Registering `ImportModule` in a CLI process starts those listeners *there
   too*, racing the server's workers for the same stage claims. Going through the
   API means a run started here is the same `ImportRunService.startRun` call the
   web wizard makes, in the same process, against the same queues — not an
   equivalent one.
2. **It would need the appliance's credentials.** Postgres, MinIO, Ollama. On a
   machine with several worktree stacks up, "which database am I on?" is
   answered by a port lookup that can silently fall back to a `.env` pointing
   somewhere else. An HTTP URL is unambiguous.
3. **It would resolve paths against the wrong filesystem.** The API may be in a
   container; the CLI is on the host. Asking the server about a path keeps the
   answer honest — see the trust story below.

## The trust story, decided rather than inherited

Upstream, this question did not exist: the importer ran on your own laptop under
your own account, and "import this path" meant a path you already had. Here it
is an appliance, and `CI_IMPORT_ROOTS` exists precisely so an API caller cannot
turn "import" into a filesystem read primitive.

**The CLI gets no exemption.** It authenticates with an ordinary api key and has
exactly the authority any other API client has. Concretely:

- `recognize <path>` asks about the **appliance's** disk and stays inside
  `CI_IMPORT_ROOTS` (plus the caller's own inbox subtree). A path outside them is
  refused with the remedy, not with a stack trace.
- `import <file>` **uploads the bytes** — the same multipart route the browser
  uses — so it needs no configured root at all and works for any file this
  machine can read. That is the answer for most people, and it is strictly safer
  than widening the gate.
- `inbox` consumes only from the caller's own subtree of the inbox, which the
  importer owns. The subtree is what stops one account importing — and thereby
  consuming — an archive another account dropped on the shared mount.

The one cost is that a 40GB archive already visible to the server still travels
over HTTP rather than being read in place. Over localhost that is disk speed;
for anything larger the inbox is the route, and it moves nothing at all.

## `--wait`, and why the output looks like that

`--wait` prints a line when something **changes** — a stage starts, the
percentage moves, the run closes — rather than redrawing on a timer. A redrawn
progress bar becomes thousands of lines of escape codes in a CI log, and this
reads the same piped as it does in a terminal.

---

## Commands

### `datasources [--catalog] [--json]`

The registered importers — **71** of them (`datasources/index.ts` is the barrel;
one `registerDataSource` call per file). Three registered ids differ from their
filename and the id is what matters, because it is what `staged_items.data_source`
records and what `--only` / `--skip` match on: `applecontacts.ts` registers
`apple_contacts`, `contactlist.ts` registers `contact_list`, and `googlevoice.ts`
registers `google_voice`. `--catalog` switches to the authored **services** list
instead — several services share the `generic` parser, and one whose importer is
not written yet still appears (`ready` blank) rather than being invisible.

### `recognize <path> [--json]`

Asks every parser what it makes of a path, importing nothing. This is the one
capability the REST surface did not have: everywhere else an archive is opaque
bytes until a run unpacks it, so `runs/:runId/recognized` reports what the parse
stage found — *after* the import.

Adding it meant one new endpoint, `POST /import/recognize`. It shares its
implementation verbatim with the `import.recognize_path` MCP tool
(`domains/import/datasources/recognizePath.ts`), so the two can never come to
different conclusions about the same folder. POST rather than GET because the
argument is a filesystem path, and a query string ends up in access logs.

### `import <path...> [--label] [--stages] [--wait] [--timeout] [--json]`

Uploads archives from this machine and runs them through
`unpack → parse → media → push`.

Per-path isolation, like the inbox batch: one unreadable archive records its
error and its siblings still start. The exit code is non-zero if any named path
failed, because you named each one.

A directory is refused with a pointer to the inbox — an upload is one set of
bytes and a directory has none. This mirrors what `import.import_path` already
does.

`--stages` warns when it omits `media`. That stage uploads archive bytes to the
object store and stamps `metadata.FileId`; a run that parses photos without it
leaves the scratch tree as the only copy, and the scratch tree is reclaimed with
the run. It is a warning and not a refusal because "stage now, push later" is a
legitimate request.

### `inbox [--start] [--only] [--skip] [--units] [--label] [--wait] [--timeout] [--json]`

Scans **this account's** inbox subtree; with `--start`, imports it, smallest unit
first.

**The scan prints floors as floors.** A walk that hit `MAX_UNIT_SIZING_ENTRIES`
renders its size as `~3.0GB` and its file count as `49788+`, and a footer names
the units that were cut. Recognition runs under one scan-wide deadline, so the
biggest unit can come back with an **empty** parser list — which then matches no
`--only <source>`, and the run reports success over a smaller corpus than you
asked for. That case gets its own line naming the units. Both lines are silent
when nothing was truncated.

The inbox is namespaced per user: `CI_IMPORT_INBOX_DIR` is a root, and each
account owns one subtree under it, named by lowercasing the account's email and
replacing every character outside `[A-Za-z0-9._-]` with `_`. So
`test@example.com` reads and writes `<root>/test_example.com/` and nothing else.
The folder the command **prints** is that subtree as the host sees it when the
appliance runs in a container with `CI_IMPORT_INBOX_HOST_DIR` set (the scan's
`displayDir`); without it, the API's own path (`inboxDir`).
Inside it, the scan creates a drop
folder per service (`amazon/`, `google-takeout/`, …); a unit dropped in one
declares that service as the run's `declared_sources`. A path in the old flat
layout is refused as *"outside the configured import roots"*, which names the
wrong variable — `CI_IMPORT_ROOTS` is a different setting for path-based
imports, and adding to it will not help.

**Deliberate divergence from upstream:** there, a bare `ci-import inbox`
imported everything it found. Here `unpack` acquires by **rename**, so starting
a run takes the file out of the inbox and a mistake is not a re-run away.
Scanning is the safe default; importing is a verb you type.

`--only` / `--skip` filter on the recognized data source (upstream's
vocabulary); `--units` takes exact paths from a scan. A unit another run already
holds is never offered.

### `runs [runId] [--limit] [--wait] [--timeout] [--json]`

Runs and their stage bars. This is upstream's `jobs`, renamed to what the server
calls it. The rename is not cosmetic: there are two progress surfaces here for
two audiences — `ci_import.import_runs` in a vocabulary the person who uploaded
the archive recognizes, and pg-boss under `/jobs` for whoever is asked why the
queue is deep. This command is the first. The second is deliberately not wrapped.

### `push [--run <id>] [--dry-run] [--wait] [--timeout] [--json]`

The wizard's Sync step: append a `push` stage to every run whose rows are staged
and uncommitted. Same name as upstream's command, entirely different thing —
see the drop table below. Exists for the case `--stages` creates. "Nothing to
push" is a state, not an error.

### `stats [--json]`

`ci.*` row counts, search-index coverage and queue depth, and a rollup of this
account's runs. Skipped rows are counted in their own column: a skip is a decided
row, not a shortfall.

### `doctor [--list] [--check <id>] [--timeout <ms>] [--failures-only] [--json]`

**Twenty-three** data-quality checks over what the importers actually **wrote**,
via `GET /import/doctor` (and `GET /import/doctor/checks` for `--list`). Every
other command answers "did the import run"; this is the only one that answers
"did it write the right rows" — the distinction that matters, because every
defect the 2026-08 QA pass found sat behind a push stage reporting 100%.

Each check is a regression detector for a defect that really shipped. Where a
check copies a live predicate, its `mirrors` field names the twin — nowadays a
**guard** (`push/inputs.ts isNotAPlaceName`, `push/canonical.ts destinationsFor`,
`push/canonical.ts isSocialAffiliation`, …) rather than a one-off backfill
migration, since the guard is what stays. Only **nine** of the twenty-three name
a twin at all — six a guard, one the migration that defined the `time_source`
vocabulary, and the two cross-pipeline identity checks (`identity-*`) the
registry marker and the conformance suite they watch — and `mirrors` is `null`
for the other fourteen. Do not read a null
as "pipeline check": the four `pipeline-*` checks are null because they watch a
control plane rather than a data shape, but so are ten data-shape checks whose
predicate copies no single reusable guard — `events-dated-before-1990` has no
guard to point at, and `contact-cards-typed-as-concept` deliberately matches the
*shape* so it catches the next parser to make the mistake rather than the
sources already fixed. The registry is
`src/domains/import/doctor/checks.ts`; `--list` is the authoritative count.

- `--list` prints the vocabulary and runs nothing; `--list --json` includes each
  check's full `remedy`.
- `--check <id>` is repeatable and restricts the run. An unknown id is a 400 that
  names it and lists the valid ones, because the caller most likely to send one
  is an agent working from a half-remembered id.
- `--timeout <ms>` is the **per-statement** cap, default 15,000, clamped to
  `[100, 600000]`. Zero would mean "no timeout" to Postgres, which is the
  opposite of what anyone types it for, hence the floor. Checks run sequentially
  on one pinned connection (`statement_timeout` is a session setting), so a slow
  check costs one check, not the suite.
- `--failures-only` hides the clean rows. They are shown by default because
  "what ran" is half of what this command is for: a suite that printed only its
  failures would be indistinguishable from a suite that only ran the failing
  checks.
- `--json` emits `DoctorReport`; stdout stays a single parseable document even
  when the gate trips, since the gate message goes to stderr.

**Exit codes.** 0 when every `high` check answered zero. **1** when any `high`
check found rows, and also when any `high` check *could not answer* — a timeout
or a database error. That second half is deliberate and is the part most likely
to be argued with: a gate reading "I could not look" as "there is nothing there"
passes exactly when the corpus got big enough for the checks to matter. Raise
`--timeout` rather than ignoring it. 2 stays "you asked for something
impossible": unknown check id, no api key, no appliance.

`medium` findings never gate. The split is about whether a machine can act on a
finding without a human deciding first, not about how much it annoys you —
future-dated events are the canonical `medium`, because a calendar is a list of
things that have not happened yet. The second reason to make a check `medium` is
that its floor is not zero on *correct* data: `comms-missing-thread-id` was
downgraded from `high` for exactly that, because Apple's own `chat.db` holds
genuinely unthreadable messages (37,181 of 432,173 on the reference corpus), and
a `high` check that can never read zero would fail the gate forever.

Counts are **global**, not user-scoped, matching `/api/maintenance/ingest-status`
and `/search/coverage`: the question is "is this appliance's data sound", and
several of the tables carry rows with no owner that a user-scoped query would
drop without saying so.

### `backfill [stages...] [--list] [--abort-on-error] [--json]`

The post-import enrichment chain, via `POST /api/maintenance/orchestrate`.
Fail-soft by default — a geocoder that cannot reach its provider should not cost
you the embeddings.

Two implementation notes worth knowing:

- The leg list is declared as a `Record<OrchestrateStage, string>`, so the
  compiler rejects a leg the orchestrator gained and this forgot, *and* a name
  misspelled here. The type is imported type-only, so the CLI never pulls the
  maintenance module graph at runtime.
- It streams NDJSON rather than using the same endpoint's synchronous JSON. A
  `search_index` backfill runs for hours, and a plain fetch waiting on the first
  byte would die on undici's 300-second headers timeout. The stream writes
  headers immediately and heartbeats every ten seconds.

---

## What was kept, what was dropped

| Upstream command | Here | Why |
|---|---|---|
| `recognize` | **kept** | Still the read-before-you-commit question. Needed one new endpoint; shares code with the MCP tool. |
| `import` | **kept, reshaped** | Uploads and starts a run instead of importing synchronously. An import is now durable stages across a queue; a 40GB Takeout does not finish inside a call. `--as <dataSource>` is dropped — `ParseStage` recognizes per file inside the unpacked tree, and there is no "force this parser" path to expose. Upstream's `--dry-run` (parse, do not persist) splits in two: `recognize` writes nothing at all, and `--stages unpack,parse` stages rows without committing them. |
| `inbox` | **kept, safer default** | Scans by default; `--start` imports. The inbox consumes what it imports. |
| `stats` | **kept, re-aimed** | Upstream counted rows in its own SQLite mirror. There is no mirror; the same question is asked of the destination (`ci.*` counts, index coverage) plus a run rollup. |
| `datasources` | **kept** | Reads the in-memory registry through `/import/sources`. `--catalog` is new, and is the list the wizard picks over. |
| `jobs` | **kept as `runs`** | Renamed to the server's own vocabulary. pg-boss stays behind `/jobs` for operators. |
| `backfill-contacts` | **dropped → `backfill`** | Promoted null-type SQLite entities carrying a phone/email to `contact`. That table does not exist; the equivalent is the orchestrator's `extract_people` leg over `ci.communications`. |
| `backfill-identity` | **dropped → `backfill`** | Populated `entities.identity_key` in the mirror. Identity resolution now happens at push time in `domains/entity-resolution`; the repair leg is `link_communications`. |
| `backfill-calendar` | **dropped** | Re-parsed `.ics` files to fix metadata written by a specific pre-`74ad479` importer bug in the mirror. The bug, the importer and the table are all gone. Re-importing the archive is the fix. |
| `dedupe-media` | **dropped** | Collapsed byte-identical media across sources in the mirror. `ci.content` deduplicates on `content_sha256` at write time; there is no accumulated duplicate set to sweep. |
| `query` | **dropped** | Paged the mirror's `items` table. Querying the corpus is what search, GraphQL and the REST read surfaces are for; a CLI re-implementation would be a worse duplicate of all three. |
| `export` | **dropped** | NDJSON dump of the mirror. It existed to *get data to CI-Server*. Both ends are the same process. `docs/api` covers the portability surfaces. |
| `push` | **dropped as transport, reused as a stage** | Upstream's `push` was the HTTP transport shipping SQLite to a remote CI-Server — the largest thing consolidation deleted. The name is reused for the `push` **stage**, which is a different operation with the same word attached. |
| — | **`--wait` (new)** | Upstream's import was synchronous, so there was nothing to wait for. |
| — | **`doctor` (new)** | Upstream had no equivalent: it wrote to a local SQLite mirror it also owned, so "did the write land correctly" was not a question anyone could ask across a boundary. Here the destination is a shared `ci.*` corpus with guards and backfills of its own, and the checks are how those stay honest. |

The through-line: everything that existed to manage the **local mirror** or the
**transport to CI-Server** is gone, because the database is local now. What
survives is the part that was always about a person's archive — what is in it,
getting it in, and watching that happen.

---

## Testing

`src/domains/import/cli/__tests__/` — every command, the client's request
building and error mapping, the NDJSON reassembly, the table renderer, and the
wait loop, all against a stubbed `fetch` and a recording terminal.

```bash
yarn workspace @ci/be-api test src/domains/import/cli
```
