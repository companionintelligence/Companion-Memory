# SmartRotationListener.ts

## Purpose

Executes one per-user unit selected by the smart-rotation scheduler. It routes
each work type to its owning domain while keeping expensive work on pg-boss.

## Components

### `SmartRotationListener.handleWork`

- **Does**: Receives `smart.rotation.work` jobs and dispatches the selected work.
- **Interacts with**: Question inference, schedule sync, Python sidecars, graph maintenance, and personalization services.
- **Rationale**: The listener is the single execution boundary behind the staggered rotation crons.

### Summary work

- **Does**: Dispatches `hourly_summary` unconditionally, then `dossier_refresh` only when a summary has been stored since the dossier was last built.
- **Contract**: Hourly summary generation must never depend on a pre-existing summary or dossier. The dossier is gated on its own INPUT, never on a cadence and never by taking the digest's turn.
- **Rationale**: A dossier consumes summaries; selecting dossier *instead of* an hourly summary creates an unrecoverable empty-user loop. But the case ticks hourly and `hourly_summary` returns `skipped:no_activity` without writing a row, so an ungated dossier ran a full LLM pass over unchanged inputs 24 times a day on the GPU the digest contends for.

### `hasSummaryNewerThanDossier`

- **Does**: Answers whether any `hourly`/`daily` row in `ci.summaries` was created after `ci.entities.dossier ->> 'lastUpdatedAt'` for the user's self entity.
- **Interacts with**: `ci.users.entity_id` → `ci.entities` (same resolution order as the sidecar's `get_entity_id_activity`), and `ci.summaries`.
- **Rationale**: `lastUpdatedAt` is stamped by the dossier generator itself, so it survives the unrelated entity writes that bump `entities.updated_at`. Only the two period types `fetch_summaries_for_dossier_activity` reads count — an `insight` row shares the table but is not dossier input. Every unknown (no user, no entity, `'{}'` dossier, unparseable stamp) reads as stale, so a first dossier is never withheld.

### Insight work

- **Does**: Attaches trust-mode personalization and dispatches `insights_generation`.
- **Contract**: Novelty is checked only by the summary sidecar against the last successfully stored insight.
- **Rationale**: Scheduler completion is not evidence that insight generation succeeded.

### `findNextUnansweredQuestionId`

- **Does**: Selects the least-recently-attempted eligible question outside the retry cooldown.
- **Interacts with**: Live and archived pg-boss attempt rows.

## Contracts

| Dependent | Expects | Breaking changes |
| --- | --- | --- |
| `SmartRotationService` | Every declared work type is handled | Removing a switch branch |
| `PythonFunctionService` | Sidecar function names and singleton keys are valid | Renaming functions or key shapes |
| Summary sidecar | The hourly digest is dispatched on every tick, whatever the dossier does | Restoring an either/or dispatch, or gating `hourly_summary` on anything |
| Summary sidecar | Once a dossier has been built, `dossier_refresh` arrives only when a summary has been stored since — but every unknown state (including a user who has never produced one) still dispatches every tick | Making the dossier unconditional (an hourly LLM rebuild), or gating it on a clock, a run history, or `entities.updated_at` |
| Insight sidecar | It is the authoritative novelty gate | Adding a scheduler-side novelty gate |

## Notes

- Summary and dossier jobs may overlap. A first dossier run can legitimately skip before the first hourly row lands; a later tick repairs it, because the stored row makes the dossier stale.
- The gate bounds the rebuild, not the dispatch. It only ever closes for a user who HAS a stored dossier: for a user who has never produced a summary the dossier stays at its `'{}'` default forever, so the gate reads stale on every tick and `dossier_refresh` is enqueued hourly regardless — each run paying the entity lookup and the 30-day summary fetch before returning `skipped:no_summaries`. That is the intended cost of failing open: the alternative withholds the first dossier from exactly the users who have not built one yet. What the gate removes is the expensive case — the full LLM pass over unchanged inputs, 24 times a day, for a user whose dossier is already current.
- The same gate lives in `PythonFunctionCrons.listUsersWithStaleDossier`, because this listener only runs when `smart.rotation` is enabled and that flag is `false` in `config/default.json` with no production override. Changing the predicate here without changing it there leaves the shipped configuration on the old behaviour.
- The dossier gate is scheduler-side on purpose: unlike `insights_generation`, `dossier_refresh` has no cheap self-check — reaching its own `skipped:no_summaries` exit already costs the entity lookup and the 30-day summary fetch, and past that it regenerates unconditionally. A sidecar-side "is my input newer than my output" check would be the better home for it; until the sidecar has one, this keeps the LLM pass off the GPU.
- Generated insights never feed HBPE directly.
