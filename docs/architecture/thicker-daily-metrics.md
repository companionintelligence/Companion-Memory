# Thicker daily metrics (#53 leftovers)

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**
>
> Status: **implemented and merged to `main`** — `feat/3-and-4` landed on
> 2026-08-17 as [#2032](https://github.com/companionintelligence/CI-Server/pull/2032),
> with [post-ingest-enrichment.md](post-ingest-enrichment.md). Re-verified
> 2026-08-19: `METRIC_KEYS` is 13 keys, ending in `meeting_minutes`,
> `sleep_minutes`, `time_at_home`; migration
> `20260817220000_thicker_daily_metrics_and_home_question.sql` is in the tree.
> Tracker: leftovers from [CI-Engineering #53](https://github.com/companionintelligence/CI-Engineering/issues/53)
> · epic [#49](https://github.com/companionintelligence/CI-Engineering/issues/49)
>
> Shared schema: one ALTER on `ci_derived.daily_metrics` plus a seeded home
> question. Enrichment (#51) adds no DDL.

#53 shipped ten scalars. Named and never added: `sleep_*`, `deep_work_minutes`,
`meeting_minutes`, `time_at_home`, `mood_index` / `stress_proxy`, `top_topic`.
This work adds a **honed subset** that already has source rows. Engines iterate
`METRIC_KEYS`; inventing a sparse proxy is worse than leaving the key out.

## Locked subset

| Key | Source | NULL when |
|---|---|---|
| `meeting_minutes` | sum `ci.events.duration_minutes` where `event_type` in `calendar_event` / `meeting` / `appointment` / `event` (ICS), not all-day, status not cancelled | no qualifying calendar rows that local day |
| `sleep_minutes` | sum `metadata->>'Minutes Asleep'` (fallback `duration_minutes`) where `event_type = 'sleep'` | no sleep events that local day |
| `time_at_home` | stay-point minutes (≥15 min / ~150 m) whose centroid is within cluster radius of the active `LIVES_IN` Location | no active home edge, or no located stays |

**Skip:** `deep_work_minutes` (`productivity_score` is optional and usually
empty), `mood_index` / `stress_proxy` (`avg_sentiment` already exists;
`summaries.mood_indicators` is LLM text), `top_topic` (no daily extractor).

Body/Mind **suggestion arms stay off** until #63 reviews copy. Catalog gains
descriptive Home / Time / Body specs only. Correlational cells appear
automatically when engines iterate the expanded `METRIC_KEYS`.

## Home is asked, not guessed

There is no `is_home` on `place_clusters` and onboarding does not store a home
place. Home identity is the existing graph assertion:

`KnownPlacesService.updateKnownPlace({ kind: 'home' })` → active `LIVES_IN`
from the user's self entity → a `Location`.

Overnight / night-count clustering ranks **candidates** for the question. It
does not fill the metric. Until the user confirms, `time_at_home` is NULL
(coverage 0). Places-page confirm already counts.

Three ask surfaces, one writer:

1. **Selector job** — `home_work_other` / `yes_no` when unlabeled and
   `knownPlaceCandidates` is non-empty. Options are Location entity ids.
   Persist via `write_known_place`.
2. **Q&A** — seeded `ci.questions` row "Which of these places is home?"
   Answering it calls the same writer. (The *product surface* was renamed to
   **Reflections** on 2026-08-18, and moved again into the Self hub on
   2026-08-23 — it now lives at `/self/reflections`, with `/memory/reflections`
   and `/prompts` kept as redirects; the
   table, the service and the REST routes are still `questions`. That release's
   catalogue migration retires abstract questions by setting `is_active = false`
   on `created_by_llm AND NOT is_seed_question` rows only, so this seeded row
   survives — its category is folded from `Home` to `Home & Daily Life`.)
3. **Action** — at most one undismissed `ci.actions` row
   (`metadata.key = 'confirm_home'`). Completing still goes through
   `updateKnownPlace`. Dismiss without confirm leaves the metric NULL.

## Schema

One file: `20260817220000_thicker_daily_metrics_and_home_question.sql`.

- `ALTER TABLE ci_derived.daily_metrics ADD COLUMN` nullable
  `time_at_home`, `meeting_minutes`, `sleep_minutes` (`DOUBLE PRECISION`).
- `INSERT` the home question with a stable UUID.

`ci_derived.metric_*` findings tables store metric names as text — no DDL.
No `ci.ingest_enrichment_debt`. No `is_home` column.

## Coverage

- Meetings / sleep: 1 when rows exist that day, else 0 (and the metric is NULL).
- Home: NULL if unlabeled; otherwise fraction of located-stay minutes that
  matched the home point.

## Out of scope

Deep work, mood index, top topic, overnight-as-metric, Body/Mind suggestion
copy (#63), rewriting the wide table into long form.
