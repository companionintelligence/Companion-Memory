# HBPE bootstrap steps

## Intent

`bootstrap.py` owns cold-start serialization-day selection, token-stream
publication, HMT training, calibration, and model export.

## Which days get serialized

`token_source_days` spends a budget of `SERIALIZE_WINDOW_DAYS + 1` calendar
days that hold an event or an hourly summary, with nothing dated after today,
plus the emptied days that still need purging (`content_source_days` returns the
first half alone — see [Two callers, two day sets](#two-callers-two-day-sets)). It is a **list of days**, not a
contiguous `(MIN, MAX)` range, and the difference is load-bearing in both
directions:

- Hourly summaries are written continuously, so on any running appliance the
  union's `MAX` is today. A contiguous trailing window therefore contains zero
  events on an imported corpus whose events stop in 2024 — the whole historical
  event corpus stops being labeled and stops reaching `hbpe.token_stream`,
  replaced by summary tokens at the lower `SUMMARY_SOFT_PROB` (0.7).
- Ending the range at the last *event* instead strands a summary created today
  outside `hbpe.token_stream`.

A day list holds both ends inside one 90-day budget, and costs the same number
of `serialize_day` calls as a contiguous 90-day range — whereas widening the
range to span the gap would be ~800 days on that corpus.

### What the budget actually guarantees

The budget is 91 **content** days, allocated in tiers. A flat
`ORDER BY source_date DESC LIMIT 91` over the union of the sources is not
enough, because it has no notion of *source*: the newest 91 days-with-data win
outright, whatever wrote them. On an appliance carrying **both** an archival
import and continuous live capture the hourly summaries add one day-with-data
per calendar day, so roughly 91 days after the import every 2024 event day is
evicted and the historical corpus stops reaching `hbpe.token_stream` — the same
failure the contiguous window had, deferred by about three months rather than
eliminated. And the evicted days are the valuable ones: events carry hard L0/L1
labels, while summary-derived tokens are the gap-filler at `SUMMARY_SOFT_PROB`
(0.7), so a flat budget hands the whole corpus to the weaker source.

The tiers, in order:

| Tier | What it takes | Bound |
|---|---|---|
| A — reserved | newest days that hold **events**, from the event branch alone | `min(EVENT_DAY_FLOOR, budget ÷ 2)` — 45 at the default window |
| B — fill | newest remaining days from events ∪ summaries, minus tier A | `budget − count(A)` |
| C — purge | days with `hbpe.token_stream` rows and **no live source**, newest first | `min(PURGE_DAY_CAP, budget)` — 91 at the default window, *on top of* the budget |

Every tier's `ORDER BY` is `DESC`, and that is policy rather than formatting.
ASC parses, runs, and returns a full budget: on a bimodal corpus an ASC tier B
returns 91 days spanning 2023 with **zero** days inside the last 90, which is
strictly worse than the summary-eviction the tiers were added to prevent. One
test per tier pins the direction (`test_label_drain.py`).

What that guarantees:

- **Up to 45 event days always survive**, however many summary-only days are
  newer. Tier A is drawn from the event branch alone, so no volume of summaries
  can outrank it.
- **At least 46 slots always go to the newest days-with-data of either kind.**
  The floor is half the budget precisely because half is the largest
  reservation that cannot starve recent context.
- **No slot is wasted.** Tier A is a ceiling, not a quota: a corpus with fewer
  event days than the floor reserves fewer slots, and tier B's limit is the
  expression `GREATEST(budget − (SELECT count(*) FROM reserved), 0)`, so the
  unclaimed slots come back to it. `EVENT_DAY_FLOOR` is additionally clamped to
  half of whatever budget the caller passed, since `window_days` is a parameter
  (`HBPE_LABEL_RECENCY_DAYS` reaches it through `label_recency_start`) and a
  floor larger than the budget would return a reservation-only list.
- **Nothing else changes.** On every corpus whose recent end holds events the
  two content tiers draw from overlapping sets, so the answer is still exactly
  the newest 91 days-with-data: dense live appliance, events-only,
  summaries-only (tier A is empty, tier B takes all 91), short event corpus. The
  bimodal corpus is the only shape that moves, from 91 summary days and zero
  events to 45 event days plus 46 summary days.

#### The event branch has to agree with the reads it predicts

A reserved slot is worth something only if the day it reserves actually
produces tokens, so `event_days` carries the predicates of the two reads it is
predicting. Both `data_client.get_token_events_for_day` (what the serializer
publishes) and `data_client._unlabeled_events_where` (what the drain labels)
filter `event_type IS DISTINCT FROM 'planned_block'` — planning's own suggested
blocks, written by `PlannedBlockService`, are the appliance's output rather than
observed behaviour. Without the same predicate here, an appliance that uses
planning writes one planned-block day per calendar day, those are the *newest*
event days there are, and tier A spends all 45 reserved slots on days that
serialize to zero event tokens: the fix no-ops on exactly the shape it targets.
Such a day is also wrongly kept out of tier C, so its stale rows can never be
purged. `_TOKEN_DATE_BOUNDS_SQL` carries the predicate for the same reason.

The three predicates the reads carry and `event_days` deliberately does **not**:
the serializer's `JOIN hbpe.l1_event_cluster` (requiring the label here would be
circular — the drain aims at this list, so no day could ever become labeled),
and the drain's `NOT (mapped_kind_sql())` and `ec.event_id IS NULL` (statically
labeled kinds are still published, and "already labeled" says nothing about
whether a day produces tokens).

#### What the tiers cost

On a bimodal corpus tier B reaches back only 46 days from the newest
day-with-data, so days ~47–90 back stop being rewritten nightly — and they are
not purged either, because they still hold an hourly summary and so never match
tier C. Their `hbpe.token_stream` rows **freeze** at whatever the last run that
selected them wrote, and a late-arriving edit to one of those days (a backfilled
event, a re-labeled summary) can never be serialized. Bimodal is the only shape
where this bites; anywhere the recent end holds events the two content tiers
overlap and tier B still covers the whole trailing window.

### Purging a day that emptied out

`serialize_day`'s `DELETE` is the only thing in the repo that removes rows from
`hbpe.token_stream`, and it only runs on days this query returns. A day *can*
empty out — its sole event soft-deleted by `CalendarEventService`, or its
`start_time` edited onto another day — and it then disappears from both source
branches, leaving a deleted event to nudge the forecast forever. So tier C
selects the dates that still hold `hbpe.token_stream` rows for the user, under
the same clamp to today. The emptied day is revisited once, purged, and drops
out by itself on the next run. The old contiguous `serialize_range(start, end)`
got this for free by walking every calendar day in the window whether or not it
held data.

Tier C is **added on top of** the content budget, not funded from it. Purge
work is delete-only and correctness-critical, and taking it out of the budget
lets a handful of deletions evict real days — worse now that tier A exists,
since a run of emptied days newer than the reserved event days would eat tier B
outright. `PURGE_DAY_CAP` is what keeps "on top" bounded: one bulk delete (a
year of events removed at once) cannot make a single night unbounded — and the
cap is clamped to the caller's own budget, exactly as `EVENT_DAY_FLOOR` is,
because `window_days` is a parameter and a flat 91 would hand an 11-day request
a 102-day night.

The leftovers are taken on subsequent nights, and the set shrinks by one per day
visited **as long as `serialize_day` writes that day nothing**. That is
conditional, not structural. A day whose only remaining source were a completed
labeled task would match neither content branch, so tier C would select it,
while `serializer._fetch_tokens_for_day` would write its task tokens straight
back — a permanent purge slot that never converges. Unreachable while nothing
writes `ci.tasks.l0_class`; see the next section, which a future writer of that
column has to act on.

The predicate is **source-less**, not "outside the content budget". Those are
the same set only while the tier competes for the budget's own `LIMIT`, which
is what kept the old query from ever reaching past the 91st newest day.
`hbpe.token_stream` deliberately holds far more history than the serialize
budget — `recurrence.HISTORY_DAYS` reads 180 days of it and
`seasonal.MAX_HISTORY_DAYS` 800 — and every one of those days still has its
event or summary behind it. Purging "every token_stream day the budget did not
select" would delete the profiler's own history every night. The flip side is a
gap the old policy left: a day that emptied out below the 91st newest was never
revisited at all, and its rows have been feeding recurrence ever since. Those
days are now reachable, newest first.

### Why `ci.tasks` is not a source branch

The predicate it would need (`l0_class IS NOT NULL AND l0_class <> 'UNKNOWN'`)
has no writer anywhere in the repo;
`data_client._completed_tasks_l0_class_populated()` probes exactly that once per
process so the always-empty scan stops running.

Note the asymmetry: the serializer still **consumes** completed labeled tasks
once a day has been selected (`serializer._fetch_tokens_for_day` →
`data_client.get_completed_tasks_for_day`). A task therefore contributes tokens
only on a day some other source already put in the list. A future writer of
`ci.tasks.l0_class` has to add the selection branch back — to the **content
tiers and to tier C's exclusions both**, or a task-only day becomes the
non-converging purge slot described above.

## Summary relationship

Summary labeling is orchestrated immediately before serialization and targets
`content_source_days` — tiers A and B, the same days serialize publishes — so
every expensive label can become an HBPE token and the cold start does not waste
work outside the model corpus. Not the full `token_source_days`: a tier-C day
holds no summary by construction, and `get_unlabeled_summaries_on_days` pairs
its `= ANY(...)` match with a MIN/MAX bracket for the planner, so one
source-less 2020 day would widen that bracket across the whole corpus.

## Legacy helpers

`event_date_bounds` and `serialize_window` remain exported. They no longer
drive serialization; the contiguous window is still the right shape for
`label_recency_start`'s fallback cutoff, and the bounds are the cheapest way to
tell an empty corpus apart from an entirely future-dated one.

## Two callers, two day sets

The query returns its rows **tagged** (`content` / `purge`), and one read serves
both callers:

- `token_source_days` — content + purge, oldest first. What `serialize` walks;
  visiting a purge day is the entire point of tier C.
- `content_source_days` — tiers A and B only. What `label_recency_start`, and
  through it `nightly_runner._recency_cutoff`, aims at.

Keeping them apart is load-bearing. Tier C is capped in **count**, not in
**reach** — reaching back is precisely what lets it clean up a day that emptied
out below the 91st newest — so the oldest day of the merged list can be
arbitrarily old. `label_recency_start` returns that oldest day and it becomes
the label drain's phase boundary, so on a corpus that is dense for 200 days plus
300 source-less 2020 `token_stream` days the boundary moves from 2026-06-01 to
2020 and the recency phase (80% of the nightly label budget) dissolves across
years. A purge day has no event and no summary on it, so it carries no label for
that cutoff to protect. Clamping tier C's reach instead would have been the
wrong repair: it would silently stop purging exactly the old emptied days the
tier exists to reach.
