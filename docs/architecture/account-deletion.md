# Account deletion and the data purge

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

What `DELETE /account` promises, what actually happens, and — the part that matters
for the App Store nutrition label and the Google Play Data Safety form — what is
still true afterwards.

## The two halves

| | Where | When |
|---|---|---|
| **Access revoked** | `UserService.requestDeletion` stamps `ci.users.deleted_at` | Immediately |
| **Data destroyed** | `AccountPurgeService`, driven by `AccountPurgeCron` | Once `ci.users.purge_after` passes (default: 30 days later) |

`deleted_at` is a TypeORM `@DeleteDateColumn`, so it revokes access without any auth
path knowing the feature exists: every repository read on `UserEntity` filters the
row out, which covers `findById` (JWT *and* API key), `validatePassword` and
`findByEmail` at once, and covers whatever the next auth path turns out to be.

`purge_after` is stamped at request time rather than computed by the job. That is
deliberate: it is a commitment to a specific person on a specific date, and if the
job derived it from config, editing `accountDeletion.graceDays` would retroactively
move a deadline already promised to someone who has left.

The grace period is also the only undo. Within it an operator can clear `deleted_at`
and `purge_after` and the account is whole again; after it, nothing brings the data
back.

## Why not `ON DELETE CASCADE`

The obvious implementation is a migration rewriting every foreign key to
`ON DELETE CASCADE`, after which `DELETE FROM ci.users` does everything. It was
considered and rejected. In descending order of importance:

1. **A cascade cannot be batched.** It is one statement in one transaction. Several
   user-scoped tables reach seven figures on a real appliance, so that means a long
   lock and a plausible `statement_timeout` — and a timeout rolls back the whole
   thing. The largest accounts, the ones most needing a purge, would make *zero*
   forward progress however often the job ran.
2. **`CASCADE` is the wrong semantics for nine columns.** They are `SET NULL` on
   purpose, because they attribute a row belonging to someone else — who created
   another account, who changed a shared graph node, who was auto-detected as an
   item's owner. Cascading them would delete other people's data.
3. **Foreign keys do not cover the data.** Fourteen user-scoped tables have no
   foreign key to `ci.users` at all — including `ci_search.embeddings`,
   `ci_search.vectors` and `ci.browser_activity`, i.e. the vector form of the user's
   memories and their browsing capture. A cascade would report success and leave
   every one of those rows in place, which is worse than failing because it looks
   like deletion.
4. **The migration is itself the risky part.** Rewriting the constraints means
   `DROP CONSTRAINT` + `ADD CONSTRAINT` per child, each taking a lock and
   revalidating the table — a long, lock-heavy migration on a live appliance, in
   order to enable an operation nobody would want to run in one shot.

So: explicit, ordered, batched deletes.

## Why the plan is discovered, not written down

A committed list of tables is wrong the day someone adds the next one, and it fails
*silently*: the purge still succeeds, the data still sits there. `AccountPurgeService`
therefore rebuilds its plan from the live catalog on every run
(`purge/purgeCatalog.ts`), so a new user-scoped table is covered the run after it
is created.

Two sources, because one is not enough:

- **Foreign keys** — every single-column constraint referencing `ci.users`.
- **Naming convention** — every `uuid` column called `user_id` or `owner_user_id`
  with no such constraint. This is the half that reaches `ci_search.embeddings`.

The convention half can produce a false positive: a `user_id` that does not mean
"this row belongs to this account". One exists, and it is instructive —
`ci.account_purges.user_id` names an account a purge *already destroyed*, and the
first integration run had the purge delete its own audit record on the way past. It
is excluded in `BUILT_IN_EXCLUSIONS`, with the reason. Deployment-specific
exceptions go in `accountDeletion.purge.excludedColumns`; each needs a comment
saying why the column is not account data, because silence there is a retention
hole with a config file in front of it.

## What the plan does

`buildPurgePlan` (`purge/purgePlan.ts`) is a pure function over catalog rows, so the
rules below are asserted in unit tests rather than discovered in production.

1. **Classify** each user reference. `NO ACTION`/`RESTRICT`/`CASCADE`/no-FK ⇒ the row
   belongs to the account, delete it. `SET NULL` ⇒ delete only if it is the *sole*
   user reference on that table (`ci.entities`, `ci.relationships`,
   `ci.graph_deltas.owner_user_id`); otherwise null it, because another column
   already owns the row.
2. **Never delete through `ci.users`.** A user reference on the users table itself is
   always nulled. `ci.users.created_by` points at the account that provisioned
   another account; following it would delete live users.
3. **Walk out to blocking tables.** Tables that are not user-scoped but hold a
   `NO ACTION` reference *into* the doomed rows are deleted too, scoped through their
   parent. Three exist today — `hbpe.l1_event_cluster`, `hbpe.l2_content_cluster`,
   `ci_search.entity_tag` — and without this step the purge fails part-way.
4. **Flatten self-references.** `ci.messages.parent_message_id`,
   `ci.threads.parent_thread_id` and `ci.objects.parent_object_id` are nulled
   first, so a batch cannot delete a parent row while a child still points at it.
5. **Order children before parents**, topologically, from the same catalog. Mandatory
   for `NO ACTION` edges; preferred for `CASCADE` ones, so the child stays inside the
   batch loop instead of firing one unbounded cascade.
6. **Delete `ci.users` last.** Its success is the proof: if any table holding this
   account's rows was missing from the plan, this statement raises a foreign-key
   violation naming the constraint, rather than passing silently.

If the plan cannot be ordered safely the job refuses to start rather than stopping
half way, because a partial purge leaves an account both unusable and undeleted.

## The four properties

- **Batched** — every statement is `ctid IN (… LIMIT n)`
  (`accountDeletion.purge.batchSize`, default 500).
- **Resumable** — each batch is its own transaction and commits. A crash or a
  statement timeout costs one batch, not the run.
- **Idempotent** — every statement is scoped by "belongs to this account", so a
  re-run finds nothing. There is no cursor to corrupt; resumability and idempotency
  are the same property here.
- **Hypertable-aware** — TimescaleDB targets (`ci.position`, `hbpe.prediction_log`)
  expand to their chunks and are batched per chunk. `ctid` is
  only unique inside one physical table, so batching against a hypertable's parent
  would match tuple addresses collected from one chunk against the rows of another.

Concurrency is guarded twice: an in-process flag for the common case of a slow tick,
and a Postgres advisory lock keyed on the account for two API instances against one
database.

## Objects, not just rows

`ci.files` rows carry `(bucket, key)`; the bytes live in Minio/S3. Before this
feature nothing in the repository had ever deleted an object, so purging the rows
alone would have left every photo, recording and document in the bucket —
unreferenced, and now unreachable. The purge deletes the objects first (if it dies
between the two, the rows are still there to find the keys again) and skips any
object another account's file row also points at, since files are deduplicated on
content.

If no object store is wired in, the purge logs a warning naming the count it could
not delete. It does not fail — but it does not stay quiet either.

## The record it leaves

`ci.account_purges` has no foreign key to `ci.users`, because the row it describes is
deleted by the purge it records. What survives is a bare uuid, the timestamps, and
per-table counts:

- `deleted_rows` — rows removed, per schema-qualified table.
- `detached_rows` — rows whose *reference* was nulled. Kept separate on purpose:
  those rows still exist, and this record is the evidence behind a claim about
  deletion.
- `deleted_objects` — objects removed from the object store.

A purge that cannot write this record reports failure, even if the data is gone: an
account destroyed with no evidence the request was honoured is the one outcome worse
than not finishing.

## What is true afterwards

Statements the label and the Data Safety form can now make:

- The account row, and every row in the 68 tables the plan covers, is deleted.
- Uploaded file objects are deleted from the object store.
- Deletion completes no later than `purge_after` (default 30 days after the request),
  and is recorded.

And the residue, which they must not paper over:

- **Attributions on other accounts' rows are nulled, not deleted.** If the deleted
  user created another account, or changed a shared graph node, that row survives
  with a `NULL` where the reference was. It no longer identifies anyone; the row is
  not theirs to delete. Counted in `detached_rows`.
- **`ci.account_purges` retains the account's uuid** indefinitely, as proof of
  deletion. A pseudonymous identifier and counts — no name, address or content.
- **Backups are out of scope.** Nothing here reaches a snapshot taken before the
  purge. Any disclosure claiming otherwise would be false; state the backup
  retention window separately.
- **Multi-account edge case.** If a row owned by a *different* account holds a
  blocking reference to a row being purged, the purge stops with the constraint
  name rather than deleting that other account's row. Deliberately loud: it needs a
  human, and it cannot happen on a single-user appliance.

## Operating it

| Setting | Default | |
|---|---|---|
| `accountDeletion.graceDays` | 30 | Stamped at request time; changing it never moves a deadline already made. The in-app copy in `AccountSection.tsx` states this number — change both together. |
| `accountDeletion.purge.enabled` | `true` | Off leaves `purge_after` unenforced. Any deployment telling users their data is deleted must leave this on. |
| `accountDeletion.purge.batchSize` | 500 | |
| `accountDeletion.purge.maxAccountsPerRun` | 5 | A backlog drains across ticks. |
| `accountDeletion.purge.retryBackoffMinutes` | 60 | |
| `accountDeletion.purge.excludedColumns` | `[]` | Needs a justification per entry. |

The cron runs hourly (`AccountPurgeCron`). An appliance is often switched off, and
`purge_after` is a deadline rather than a schedule, so hourly means a box that is up
for one hour a day still honours the promise on the day it was made.

`AccountPurgeService.describePlan()` returns what the next run *would* do, without
running it — worth reading before an irreversible job answers the same question in
production.

## Tests

- `purge/__tests__/purgePlan.spec.ts` — the rules above, over fixture catalogs.
- `purge/__tests__/purgeSql.spec.ts` — the exact statements, including the
  `IS NOT NULL` guard that stops the `ci.users.entity_id` batch loop spinning
  forever.
- `services/__tests__/AccountPurgeService.integration.spec.ts` — every migration
  applied to a throwaway database, two accounts seeded, one purged. It is the only
  test that can say "the data is gone", and it is what caught the audit-record bug.
  Skips (loudly) without an administrative database connection; set
  `DATABASE_ADMIN_PASSWORD`.

## Still outstanding

- **A public web URL for account deletion.** Google requires one *in addition* to the
  in-app path — reachable without installing the app, and it must explain what is
  deleted and what is retained. This document is the source for that page's copy.
  Tracked as an `[acct]` item in §1a of both `frontend/apps/ios/DELIVERY.md` and
  `frontend/apps/android/DELIVERY.md`.
- **The hosted privacy policy** at `ci.computer/privacy-policy` lives in
  CI-Public-Website. It has to match the "what is true afterwards" section above
  before submission.
