# PythonFunctionCrons.ts

## Purpose

Owns ordinary pg-boss schedules for Python sidecar functions and fans each run
out to onboarded users.

## Smart-rotation contract

When `smart.rotation` is enabled, the ordinary hourly-summary, dossier, and
insight crons stand down to prevent duplicate schedules. The smart-rotation
summary tick dispatches both `hourly_summary` and `dossier_refresh`; its insight
tick dispatches `insights_generation`, whose sidecar owns novelty detection.

Daily/weekly/monthly rollups, actions, and HBPE jobs remain owned here because
smart rotation has no equivalent cadence for them.

`smart.rotation` is `false` in `config/default.json` and only
`config/development.json` turns it on, so on the shipped configuration these
crons are the schedule — not a fallback. Anything the rotation path gates must
be gated here too, or it is not gated on any appliance a user has.

## Dossier audience

`dossierRefresh` fans out hourly, and `dossier_refresh` regenerates
unconditionally once past its own `skipped:no_summaries` exit — a full LLM pass
over 30 days of daily plus 24 hours of hourly summaries. Its audience query
therefore asks two things, and both must hold:

1. **Input exists** — at least one `hourly`/`daily` summary in the lookback.
   Without it the job can only report "no summaries" (19 dead letters on the QA
   box before the Python side downgraded that to a skip).
2. **Input is newer than the output** — a summary stored after the dossier's own
   `lastUpdatedAt` stamp. Without this, a corpus that has stopped moving costs
   24 identical rebuilds a day per user.

Condition 2 is the same predicate as `SmartRotationListener`'s
`hasSummaryNewerThanDossier`, asked set-wise. It reads the payload stamp rather
than `entities.updated_at` (bumped by imports, merges and enrichment), counts
only the two period types the dossier reads (`insight` rows share the table and
are written hourly), and treats every unknown — no self entity, `'{}'` dossier,
unparseable stamp — as stale, so a first dossier is never withheld.

The two copies are independent code. Changing one without the other splits the
behaviour by which scheduler is driving; the shipped default is this one.

`PythonFunctionCrons.dossierGate.integration.spec.ts` executes the audience
query against a real Postgres, because a mocked `DataSource` cannot tell a
correct comparison from an inverted one.
