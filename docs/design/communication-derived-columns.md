# `ci.communications` derived columns — wire or retire

**Status:** decided, unimplemented. Execution rides on
[#2512](https://github.com/companionintelligence/CI-Server/issues/2512).
**Date:** 2026-09-01.

Six columns on `ci.communications` were designated to carry derived signal about a
message and are empty. This records the per-column decision and the evidence
behind it, so the next person to open the table does not have to re-derive it.

## Decision

| Column | Type | Decision |
|---|---|---|
| `summary` | `text` | **WIRE** — the only one whose consumer is already built |
| `sentiment_score` | `double precision` | **WIRE** — nullable, omitted (never zeroed) |
| `urgency_score` | `double precision` | **WIRE** |
| `importance_score` | `double precision` | **WIRE**, with a calibration gate |
| `category` | `text` | **WIRE** + constrain the vocabulary |
| `tags` | `text[]` | **RETIRE** |

Five wire, one retires. `tags` is the only one that is not merely unproduced —
it is *shadowed*, and wiring it would create a second, disagreeing answer to a
question the schema already answers elsewhere.

## Measured baseline

`ci.communications`, local appliance corpus, 2026-09-01:

```
 total  | summary | tags | category | sentiment | importance | urgency
--------+---------+------+----------+-----------+------------+---------
 350590 |       0 |    0 |        0 |         0 |          0 |       0
```

All six are at zero across 350,590 rows — including `category`, which *does*
have automated writers. This corpus arrived through the import-push plane, and
that path never sets `category`; the two ETL transforms that hardcode it
(below) have not run here. So the hardcoded-constant problem and the
no-producer problem both present identically in practice: an empty column.

For contrast, on the same database `ci.events.category` is 198,733 / 198,794
populated (99.97%) — `toEventInput` sets it from the record kind, while its
sibling `toCommunicationInput` in the same file sets no category at all. That
asymmetry is correct rather than a bug (`categoryForKind('communication.email')`
returns the constant `'communication'`, which would be worthless), but it is
why the two tables look so different.

## What actually writes these today

Verified by reading every write path, not by grep alone.

- **`category`** has two automated writers, and neither classifies anything.
  [`TransformGmail.ts:160`](../../backend/apps/api/src/domains/etl/services/Google/transform/TransformGmail.ts)
  and
  [`TransformOutlookMail.ts:388`](../../backend/apps/api/src/domains/etl/services/Microsoft/transform/TransformOutlookMail.ts)
  each write the literal `category: 'personal'` on every message, both carrying
  a `// TODO: Classify emails` comment.
- **`summary`, `sentiment_score`, `importance_score`, `urgency_score`** are
  mapped generically in `CommunicationService` — `create()` (~L126-130),
  `createMany()` (~L242-246) and `update()` (~L445-462) — from caller-supplied
  DTO fields. Nothing in the ETL transforms, the import push stage, the
  pipeline's enrich stages, or the Summary/HBPE sidecars reads a message body
  and produces any of them.
- **`tags` is written by nothing at all.** It is absent from
  `CreateCommunicationDto`, `UpdateCommunicationDto`, `createCommunicationSchema`,
  `updateCommunicationSchema`, and `bulkCommunicationRecordSchema`, and it is
  not mapped in `create()`, `createMany()` or `update()`. The only code that
  touches it is `CommunicationEntity.toEgressType`, which reads it back out.

### One correction to the original survey

The survey held that the four score/summary columns are reachable from two
callers: the `updateCommunication` GraphQL mutation and the REST bulk-ingest
plane. **The GraphQL mutation is not one of them.**
[`UpdateCommunicationInput`](../../backend/apps/api/src/domains/graphql/types/UpdateCommunicationInput.ts)
declares exactly three fields (`id`, `subject`, `content`), and
`CommunicationResolver.updateCommunication` forwards only `subject` and
`content`. No GraphQL client can set any of the six.

The single reachable writer is therefore the REST bulk-ingest plane
(`bulkCommunicationRecordSchema`) — an external client submitting a precomputed
value — and it does not accept `tags` either. This narrows rather than widens
the problem: there is no human-editing path to point at as a partial excuse for
leaving the columns unproduced.

## Why each column decided the way it did

### `summary` — WIRE. The consumer is already built.

This is the strongest case of the six, and it is the one the survey undersold.
`summary` is not write-only-and-unread: `CommunicationService.baseRowFor()`
projects it into `ci.entities.description` on the CTI base row, in the same
transaction as the detail row, on both `create()` and `createMany()`, and
`graphDeltaWriter` records it as a changed field. Every consumer of the base
row's description — explorer, graph, entity display — is wired through and
reading `NULL` today.

So the plumbing is finished and only the producer is missing, which makes this
the cheapest wire and the one with the widest blast radius when it lands.

It is also the fix for the sibling gap in
[#2513](https://github.com/companionintelligence/CI-Server/issues/2513). The
Summary sidecar's hourly rollup config (`data_aggregator.py`, the
`communications` entry) excludes `content` and `participants_metadata` by
design, so the richest per-message thing the rollup can see *is* `summary` —
and HBPE reads `ci.summaries`, not `ci.communications`. Confirmed: HBPE does
open a `ci_communications` LISTEN channel (`pipeline/ingester.py`), but only to
invalidate its inference cache; it reads no column from the table. The
behavioural model is exactly as informed as what survives into the rollup, and
today that is a row of NULLs.

### `sentiment_score` — WIRE. A shipped user-facing metric depends on it.

`avg_sentiment` is a first-class metric in the daily-metrics domain, wired end
to end and permanently dead:

- declared in `daily-metrics/types.ts` `METRIC_KEYS`, with
  `METRIC_SOURCES: { avg_sentiment: ['ci.communications'] }`;
- computed in `dailyAggregateSql.ts` (`sum`/`count` of `c.sentiment_score`) and
  `assembleDailyMetrics.ts`;
- forecast-aware — it is the sole member of `SIGNED_METRICS` in
  `MetricForecastService`, the one metric allowed to go negative;
- fed to `SuggestionEngine` correlations and to `questionCatalog.ts`, which
  renders the user-facing sentence *"Your conversations {timeframe} had an
  average sentiment of {value} (-1 to +1)."*

That sentence can never be produced. Retiring the column would mean deleting a
shipped metric, its forecast handling and its narration; wiring it turns them
all on at once. The DB `CHECK (sentiment_score >= -1 AND sentiment_score <= 1)`
already exists.

**Nullable and omitted, never zeroed** — and the existing code proves why rather
than merely preferring it. `dailyAggregateSql` computes
`sum(sentiment_score)` *and* `count(sentiment_score)` separately, and
`assembleDailyMetrics` derives the mean from the pair and the coverage as
`fraction(comms_sentiment_count, comms_rows)`. Both aggregates skip NULLs. A
classifier that writes `0.0` for "tone is not a meaningful read" would drag the
mean toward zero *and* report full coverage — destroying the one signal already
built to distinguish "neutral" from "not applicable". Omission is not a style
preference here; it is the contract the consumer was written against.

### `urgency_score` and `importance_score` — WIRE, with a gate on the pair

Both are named explicitly in #2512, both already carry `CHECK (x >= 0 AND x <= 1)`,
and neither has a consumer yet — so their value is entirely forward-looking,
unlike `summary` and `sentiment_score`.

One risk worth writing down before the work starts: **a small local model asked
for two 0–1 scores this semantically adjacent will return collinear output.**
"Important" and "urgent" are distinct concepts to a person and frequently the
same number to a 7B model. If they correlate above ~0.9 on a sample, the second
column is measuring nothing and should be dropped rather than shipped as decor —
which is the same failure this whole exercise exists to prevent, arrived at from
the other direction. Sample and check before declaring both done.

### `category` — WIRE, and constrain the vocabulary

Replacing a hardcoded constant with a classifier is the same work as wiring an
empty column, so this decides with the other four.

**Constrain it with a `CHECK`, not a Postgres enum.** `direction` on the same
table is backed by the real enum `ci.communication_direction`, and it is the
right shape *there*: five values, structural, closed. A message-category
vocabulary is none of those — it will gain entries. Two reasons a CHECK fits
better:

1. `ALTER TYPE ... ADD VALUE` cannot use the new value in the same transaction,
   and dbmate wraps each migration in one — so every vocabulary addition costs
   two migrations. A CHECK is dropped and recreated in one.
2. It is this repo's dominant idiom. `TEXT ... CHECK (x IN (...))` appears
   throughout the migrations (`users.role`, `questions.question_type`,
   `answers.answer_source`, `answers.sharing_level`, `events.status`,
   `events.external_sync_status`), and there is **not one**
   `ALTER TYPE ... ADD VALUE` migration in the tree. `communication_direction`
   is the exception, not the pattern to copy.

Either way, the constraint is what stops a small local model drifting between
`"Request"` / `"request"` / `"req"` silently.

**`'personal'` must be in the vocabulary.** The two live transforms write that
exact literal today and are not part of this change; a vocabulary that omits it
turns both of them into constraint violations the moment the migration lands.

### `tags` — RETIRE

The one retire, and it does not turn on "nothing will ever fill it". It turns on
the column being **shadowed by a working subsystem**:

- The real tag store is `ci_search.tags` + `ci_search.entity_tag`, written by
  `TagService.tagEntities` — which `TransformGmail` already calls with the
  message's Gmail labels immediately after creating each communication, and
  which the `tagEntities` GraphQL mutation exposes to clients.
- The API already serves tags from there:
  `CommunicationType.tags` is `[EntityTagType]`, populated by the resolver from
  the join table, with the literal comment `tags: []  // Hydrated by resolver`.
  No GraphQL field reads `ci.communications.tags`.
- No SQL anywhere — TypeScript, Python or migration — reads the column.

So it is not an unfilled column; it is a *duplicate* one. Wiring it would give
`ci.communications` two independent tag sets that nothing reconciles, and the
API would keep serving the other one. The designated-column-with-no-generator
argument applies with full force: it reads as available data, it is not, and
unlike the other five there is no version of "fill it" that is correct.

`ci.events.tags` is the same dead `text[]` (0 / 198,794 populated) with the same
shadowing. Retiring both together is the coherent change; this document only
decides the communications half, since that is what was surveyed.

## If wiring: the shape to follow

One `enrich.*` pipeline stage writing all five, modelled on
[`PersonLinkStage.ts`](../../backend/apps/api/src/domains/pipeline/stages/enrich/PersonLinkStage.ts):
the `Stage` interface (`id`, `version`, `queue`, `entityTypes`, `source`,
idempotent `run(ctx, ids)`), `PIPELINE_QUEUES.ENRICH`, a `StageSource` over
`ci.communications`, and a version *derived* from the rule generations and
cross-checked against `STAGE_VERSIONS` so `StageRegistry.assertConsistent`
cannot be satisfied by a hardcoded integer.

Two constraints from that machinery that are easy to get wrong:

- **Stage ids are permanent** — the id is the third component of
  `ci.pipeline_state`'s primary key. Renaming one abandons every ledger row
  written under the old name.
- **The `StageSource.predicate` must not reference the columns the stage
  writes.** `s.summary IS NULL` there would rebuild the exact one-way ratchet
  the ledger exists to remove: the row leaves the candidate set the moment the
  stage succeeds, and a version bump could never bring it back to be
  re-classified by a better model. Completion is the ledger's job; the
  predicate expresses *applicability* only.

Wiring is four files (`constants.ts` id, `versions.ts` version, `STAGE_REGISTRY`
token, `stageProviders` binding) plus the stage itself — `stageWiring.spec.ts`
fails on a stage class that is not wired all the way through.

## Issue status — do not file a new one

[#2512](https://github.com/companionintelligence/CI-Server/issues/2512) —
*"[COMPLEX] Communication intake: drop the 150-char preview, write
urgency/sentiment/CTA"* — was opened 2026-09-01 and covers this. It already
asks for a job that writes urgency/importance/sentiment, a 1–2 sentence summary
of the full message, and a **call-to-action field** — a seventh column that does
not exist yet and was not part of this survey.

Two things this document adds that the issue does not have:

- It does not mention `category` or `tags`. The `category` decision (classify +
  constrain, keeping `'personal'`) and the `tags` retire are new.
- Its acceptance criterion *"not null forever"* would be satisfied by writing
  `0.0` everywhere. See the `sentiment_score` section for why that is worse
  than NULL for the one consumer that already exists.

Siblings: [#2513](https://github.com/companionintelligence/CI-Server/issues/2513)
(summaries/HBPE completeness), [#2499](https://github.com/companionintelligence/CI-Server/issues/2499)
(forecast pass).
