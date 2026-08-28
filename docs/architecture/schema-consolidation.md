# Schema consolidation (LifeScope audit)

**Status:** Waves A–E landed on `chore/schema-consolidation`; **Wave D was later reverted**
(see the table). Re-verified against `main` 2026-08-19.  
**Source audit:** [lifescope-vs-ci-server-schema.html](./lifescope-vs-ci-server-schema.html)

## Hypertable exceptions (already landed, do not reopen)

| Table | Decision |
|-------|----------|
| `ci.position` | Keep **time-only** hypertable (space partition removed) |
| `ci.user_snapshots` | Keep **time-only** hypertable |
| `ci.communications` | **Plain table** (de-hypertabled; dedup companion dropped) |

See [hypertable-audit.md](./hypertable-audit.md) and ADR-0002.

## Waves

| Wave | Status | Intent |
|------|--------|--------|
| A | **done** | Drop dead `agents` / `agent_messages`; user-scoped events arbiter; delete dead/dupe entities; rename graph `FileEntity` |
| B | **done**, partly **retired** | Restore `ci.content.event_id` FK + `Event.contents`; analytics side table `ci.event_analytics` — the side table was dropped again by `20260826202329_retire_event_analytics`: relocating seven dead columns off the hot row did not give them a writer or a reader, and none ever appeared |
| C | **done** | One entity-type vocab + tenancy ADR-0003; Person typed columns; location snap dedup |
| D | **reverted** | Fold `browser_activity` → events+content (backfill + dual-write); `/v1` prefers timeline. Landed as `20260808070615` (squashed into `20260808150100`), then undone by `20260812144811_revert_browser_activity_event_fold.sql`: page views are not timeline events — the fold flooded the schedule calendar and silently changed HBPE's training corpus, neither of which filters `ci.events` by kind. `/v1/browser-activity` writes `ci.browser_activity` only |
| E | **done** | `COMMENT` on write-only commerce tables; refresh Database.md |

Do not break smart-rotation tables (`questions`, `answers`, `feed_queue`, `summaries`, `actions`, `tasks`).

## Follow-ups

- **Removed after the Wave D revert:** the search-backfill widening that made a `browser-activity`-scoped import finish also index the dual-written `event` + `content` rows. With no dual-write left, it only meant a scoped request swept the whole events and content corpora, so `expandBackfillEntityTypes` was replaced by `normalizeBackfillEntityTypes` (dedupe + canonical order, no widening) in `SearchIndexBackfillService`
- **Done (post-merge), then superseded:** Removed dead analytics fields from event create/update DTOs (`prediction_model`, `productivity_impact`, `last_synced_at`, `related_event_ids`, `supersedes_event_id`). They had no home to be written to either: the side table that held them was retired by `20260826202329_retire_event_analytics`. Do not re-add the DTO fields.
- **Cancelled by the Wave D revert:** dropping `ci.browser_activity` once dual-read consumers moved to events/content. There are no dual-read consumers and no dual-write — the table is the permanent, sole home for page views, as its `COMMENT` (set by `20260812144811`) records. Do not re-open this without a decision that reverses the revert
- Rename remaining `owner_user_id` columns only if a dedicated blast-radius wave is scheduled (see ADR-0003)
