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

What other people can read through the account is closed in the same transaction
(`UserService.endAccount`, shared by both deletes): its saved searches are unshared
(`share_token` cleared, so every share link resolves to nothing), its peer links are
revoked (so an inbound peer ask or a poll for an earlier answer is refused), and the
grants it gave are revoked. None of these resolves the owner through the hidden user
row: a share link runs the search as its owner from the token alone, and a peer ask is
answered as the owner of whichever live peer link matches. Before this they kept
serving the account's memory until the purge reached their tables.

`purge_after` is stamped at request time rather than computed by the job. That is
deliberate: it is a commitment to a specific person on a specific date, and if the
job derived it from config, editing `accountDeletion.graceDays` would retroactively
move a deadline already promised to someone who has left.

The grace period is also the only undo. Within it an operator can clear `deleted_at`
and `purge_after` and the account's data is whole again; after it, nothing brings the
data back. The undo does not reopen what ending the account closed: its owner shares
the searches and links the peers again (sharing again rotates the token, so an old
link stays dead). It does not apply to the immediate delete at all (below).

## The last administrator

`requestDeletion` refuses to delete the appliance's last live administrator while other
live accounts remain, unless the request names one of them (`successorEmail`). That
account becomes administrator in the same transaction. The settings page asks for the
address when the server answers 409 `SUCCESSOR_REQUIRED`.

Before this rule, deleting the owner left the members on a box with no live admin.
`ApplianceAdminGuard` admitted every one of them in that state, and the next account
created was promoted, so a member could mint an invitation and sign up their own admin.
Now the guard refuses when live accounts exist without a live admin, and only the
appliance's first account ever is promoted. A box that is already in that state (it
was upgraded with the owner pending purge) has no admin until an operator restores the
owner inside the grace period, or sets `role = 'admin'` on the account that should hold
it. The same goes for a box whose only account was deleted and which gained a new
account before the purge: that account is not the first row, so it is never promoted.

The deleted account's unused invitations are deleted with it.

## The immediate delete: `POST /users/me/delete`

The privacy route (CASA ASVS V8) deletes at once instead of after the grace period, and
revokes every OAuth grant first. It uses the same two halves, with the deadline set to now:

1. **Revoke the grants**, best-effort, 10 s per connection, holding no lock. The
   last-administrator rule is asked first without the lock
   (`UserService.assertMayEndAccount`), so a refused request revokes nothing.
2. **End the account** in one short transaction under the lock every sign-up takes
   (`UserService.endAccountNow`): the rule asked again for real, the successor
   promoted, `deleted_at` and `purge_after = now()` stamped, the unused invitations,
   sessions and API keys deleted, the share links, peer links and grants closed, the
   connections' provider tokens cleared, and a
   `started` row written to `ci.data_deletion_audit`. All of it or none of it; a
   failure writes a `failed` row after the rollback and changes nothing else.
3. **Purge the rows** through `AccountPurgeService.purgeAccount`, inline: batched,
   each batch its own commit, no lock but the purge's own advisory one. The route
   waits up to 30 s and answers `status: "deleted"` with the counts, or
   `status: "deleting"` while the purge carries on. A failed pass is retried once at
   once (a row written for the account by a job that was already running when it
   ended refuses the user row's delete the first time). Whichever run removes the
   last row, inline or the hourly cron after an interruption, appends the
   `completed` audit row. Its counts are that run's: rows an interrupted run
   removed before it stopped are not in them (the same holds for
   `ci.account_purges.deleted_rows`). The search-index sweep runs when the inline
   purge finishes; for a purge the hourly cron finishes, `OrphanCleanupCron` does it.

Until #3241 this was one transaction for everything, held under the sign-up lock. On
a graph-heavy account that ran for more than 49 minutes with every sign-up waiting,
and any interruption rolled all of it back. Once step 2 commits nobody can sign in to
the account or read through it, so a purge that stops part way leaves an ended account
with rows still to delete, never a live account with some of its data gone. Nothing in
the code stops an operator clearing `deleted_at` on it, though, and the grace-period
undo above must not be used here: it would revive an account the purge may already
have partly removed. That is also why the bytes go before the rows here, as in the
30-day purge, and not after them.

`accountDeletion.purge.enabled = false` stops every purge, this inline one included:
the route still ends the account (step 2) and answers `deleting`, and the rows wait
until the switch is turned back on.

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

If a store is wired in and fails (down, misconfigured, past the 60 s per call), the
purge stops before any row: the rows hold the keys. `last_error` says
`Object store unavailable; …`, the account is retried after the backoff, and once it is
a day overdue it is in the stalled-purge report (below) on every hourly run.

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
- **Ask disclosure records another account is a party to are kept, without this
  account in them.** `ci.ask_audit` has no foreign key on purpose: it is the other
  party's record of what was asked of them and what they disclosed. Both the 30-day
  purge and the immediate `POST /users/me/delete` take the account out of it
  (`purge/askAudit.ts`): its id goes; where it asked, its prompt text, filters and
  declared actor go (the question's category stays); where it answered, its disclosed
  and read entity ids and its grant id go. Rows no other account is a party to (asks
  to or from a peer, or to itself) are deleted.
- **`ci.account_purges` retains the account's uuid** indefinitely, as proof of
  deletion. A pseudonymous identifier and counts — no name, address or content.
- **Backups are out of scope.** Nothing here reaches a snapshot taken before the
  purge. Any disclosure claiming otherwise would be false; state the backup
  retention window separately.
- **Multi-account edge case.** If a row owned by a *different* account holds a
  blocking reference to a row being purged, the purge stops with the constraint
  name rather than deleting that other account's row. Deliberately loud: it needs a
  human, and it cannot happen on a single-user appliance. The one such reference the
  plan knows how to break is `ci.users.entity_id`: another account whose self-Person
  pointer names one of this account's entities has the pointer nulled (what
  `ON DELETE SET NULL` would do), counted in `detached_rows['ci.users']`. Until
  that, the purge failed on `users_entity_id_fkey` on every retry.

## Operating it

| Setting | Default | |
|---|---|---|
| `accountDeletion.graceDays` | 30 | Stamped at request time; changing it never moves a deadline already made. The in-app copy in `AccountSection.tsx` states this number — change both together. |
| `accountDeletion.purge.enabled` | `true` | Off leaves `purge_after` unenforced. Any deployment telling users their data is deleted must leave this on. |
| `accountDeletion.purge.batchSize` | 500 | |
| `accountDeletion.purge.maxAccountsPerRun` | 5 | A backlog drains across ticks. |
| `accountDeletion.purge.retryBackoffMinutes` | 60 | |
| `accountDeletion.purge.excludedColumns` | `[]` | Needs a justification per entry. |

**Stuck purges.** An ended account whose purge is still unfinished 24 hours after its
`purge_after` is logged at error level on every hourly run (`Ended accounts are still
not purged long after their deadline`, with the oldest ten, their attempts and
`last_error`), also while the purge is switched off. `AccountPurgeService.findStalledPurges()`
answers the same question. Until it is purged, the account's address stays taken.

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
- `privacy/services/__tests__/DataDeletionService.integration.spec.ts` — the
  immediate delete on the real schema: all-or-nothing account end (successor
  included), an interrupted purge finished by the hourly run, a sign-up during a
  purge, a row written for the account mid-purge, and the failure path on a pool of
  two.
- `privacy/__tests__/dataDeletionPlan.integration.spec.ts` — every column that can
  name an account (by foreign key under any name, or by name in uuid, uuid[] or
  text) must be one the purge deletes by, one it nulls, or listed with the reason it
  stays. It adds such columns to the schema to prove it notices them. Every table,
  too, must be purged, cascade from a purged one, or be listed with a reason: that is
  what catches a child with no account column and no foreign key, the class
  `hbpe.summary_l1_label` was in.

## Still outstanding

- **A public web URL for account deletion.** Google requires one *in addition* to the
  in-app path — reachable without installing the app, and it must explain what is
  deleted and what is retained. This document is the source for that page's copy.
  Tracked as an `[acct]` item in §1a of both `frontend/apps/ios/DELIVERY.md` and
  `frontend/apps/android/DELIVERY.md`.
- **The hosted privacy policy** at `ci.computer/privacy-policy` lives in
  CI-Public-Website. It has to match the "what is true afterwards" section above
  before submission.
