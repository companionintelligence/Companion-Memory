-- migrate:up
-- Indexes for predicates that run constantly and had nothing to walk. Each one
-- names the query it serves; none changes a result, only the plan.
--
-- ## Default /memory browse (SearchResolver -> ContentService / FileService)
--
-- `ContentService.getEntitiesForContents` / `countEntitiesForContents` seek and
-- order on `(content.updated_at, content.id)`, but the only time index on
-- `ci.content` was `content_user_created_idx (user_id, created_at DESC)` — so
-- every page was a top-N sort over all of the user's content rows and every
-- count a full scan of them.
CREATE INDEX IF NOT EXISTS content_user_updated_idx
  ON ci.content (user_id, updated_at DESC, id DESC);

-- `FileService.getEntitiesForFiles` / `countEntitiesForFiles` filter on
-- `(user_id, variant)` and seek on `(updated_at, id)`; `FileService.findPage`
-- orders by `(created_at, id)`. `ci.files` had `files_user_id_idx (user_id)`
-- only. Both are partial on `deleted_at IS NULL` because `FileEntity` has a
-- `@DeleteDateColumn`, so TypeORM adds that predicate to every query it builds.
CREATE INDEX IF NOT EXISTS files_user_variant_updated_idx
  ON ci.files (user_id, variant, updated_at DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS files_user_variant_created_idx
  ON ci.files (user_id, variant, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

-- `excludeEventLinkedFiles` (FileService) anti-joins
--   NOT EXISTS (SELECT 1 FROM ci.content linked
--                WHERE linked.user_id = file.user_id
--                  AND linked.external_id = file.id::text
--                  AND (linked.external_id_kind = 'file' OR linked.external_id_kind IS NULL)
--                  AND linked.event_id IS NOT NULL)
-- on every files page and count of the default browse. `ci.content.external_id`
-- had no index, so the planner hashed the user's whole event-linked content set
-- per query. The partial predicate matches the subquery's own.
CREATE INDEX IF NOT EXISTS content_user_external_id_idx
  ON ci.content (user_id, external_id)
  WHERE external_id IS NOT NULL AND event_id IS NOT NULL;

-- ## Pipeline sweeps (PipelineStateService.selectStale)
--
-- Every stage sweep is `WHERE s.user_id = $3 ... AND s.id > $cursor ORDER BY
-- s.id LIMIT n`. `ci.events` has `(user_id, event_id)` and `ci.position` got
-- `position_id_idx` for exactly this; `ci.communications` and `ci.content`
-- had only `(user_id, time ...)` / `(user_id, created_at)` indexes, so on a
-- multi-user appliance their sweeps walked the primary key and filtered.
CREATE INDEX IF NOT EXISTS communications_user_id_id_idx
  ON ci.communications (user_id, id);

CREATE INDEX IF NOT EXISTS content_user_id_id_idx
  ON ci.content (user_id, id);

-- ## Cron predicates
--
-- `AskExpiryService.sweep` runs every five minutes:
--   WHERE expires_at < now() AND status IN ('delivered','under_review','answering')
-- `ci.asks` had no index on `expires_at`. Same shape as
-- `pending_actions_expiry_idx`, which the identical pending-action sweep has.
CREATE INDEX IF NOT EXISTS asks_expiry_idx
  ON ci.asks (expires_at)
  WHERE status IN ('delivered', 'under_review', 'answering');

-- `AgentDispatchService.failStale` runs every minute:
--   WHERE (status = 'queued' AND created_at < $1) OR (status = 'running' AND updated_at < $2)
-- The existing indexes lead with `thread_id` and `user_id`, so neither applied
-- and the sweep was two sequential scans a minute that almost always matched
-- nothing. Open jobs are a tiny slice of the table, hence partial.
CREATE INDEX IF NOT EXISTS agent_jobs_open_idx
  ON ci.agent_jobs (status, created_at, updated_at)
  WHERE status IN ('queued', 'running');

-- `PlanningJobsCron.enqueueFireReminders` now asks, once a minute, which users
-- have ANY pending reminder due — `WHERE status = 'pending' AND fire_at <= now()`
-- with no `user_id` — before fanning out one job per such user. The existing
-- `idx_reminders_user_due (user_id, status, fire_at)` leads with `user_id`, so
-- that appliance-wide question could not use it.
CREATE INDEX IF NOT EXISTS reminders_due_idx
  ON ci.reminders (fire_at)
  WHERE status = 'pending';

-- `ThreadService.findAll` (GET /api/threads, every chat-page open):
--   WHERE user_id = $1 AND is_archived = false ORDER BY updated_at DESC
-- `ci.threads` had no index beyond its primary key.
CREATE INDEX IF NOT EXISTS threads_user_updated_idx
  ON ci.threads (user_id, updated_at DESC)
  WHERE is_archived = false;

-- migrate:down
DROP INDEX IF EXISTS ci.threads_user_updated_idx;
DROP INDEX IF EXISTS ci.reminders_due_idx;
DROP INDEX IF EXISTS ci.agent_jobs_open_idx;
DROP INDEX IF EXISTS ci.asks_expiry_idx;
DROP INDEX IF EXISTS ci.content_user_id_id_idx;
DROP INDEX IF EXISTS ci.communications_user_id_id_idx;
DROP INDEX IF EXISTS ci.content_user_external_id_idx;
DROP INDEX IF EXISTS ci.files_user_variant_created_idx;
DROP INDEX IF EXISTS ci.files_user_variant_updated_idx;
DROP INDEX IF EXISTS ci.content_user_updated_idx;
