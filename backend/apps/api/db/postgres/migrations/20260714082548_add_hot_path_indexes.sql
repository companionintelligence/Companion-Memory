-- migrate:up
-- ---------------------------------------------------------------------------
-- Hot-path indexes for the two largest tables + the entities node-listing path.
--
-- Found by the 2026-07 code+DB review against a live 826k-item corpus. Each of
-- these access paths was doing a full parallel sequential scan because no index
-- covered it:
--
--   * ci.browser_activity (330k rows / ~284MB) — the user/time timeline + the
--     search-reindex sweep (BrowserActivityService) filter by user_id and order
--     by time; there was no (user_id, time) index, only the source-triple UNIQUE.
--   * ci.content (194k rows / ~144MB) — the per-user/created_at sweep
--     (ContentService) and the event->media join backing the media @ResolveFields
--     (event_id + type) both seq-scanned.
--   * ci.entities — GraphUtilityService.queryNodes lists nodes by
--     (owner_user_id, is_active) ordered by created_at; no index supported it.
--
-- All three mirror indexes that already exist on sibling tables (e.g.
-- communications_user_id_time_idx, events_user_time_idx). Plain btrees, cheap to
-- maintain incrementally, so intentionally NOT added to DEFERRABLE_INDEXES.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS browser_activity_user_time_idx
  ON ci.browser_activity (user_id, time DESC, id DESC);

CREATE INDEX IF NOT EXISTS content_user_created_idx
  ON ci.content (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS content_event_type_idx
  ON ci.content (event_id, type)
  WHERE event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS entities_owner_active_created_idx
  ON ci.entities (owner_user_id, is_active, created_at DESC);

-- migrate:down
DROP INDEX IF EXISTS ci.browser_activity_user_time_idx;
DROP INDEX IF EXISTS ci.content_user_created_idx;
DROP INDEX IF EXISTS ci.content_event_type_idx;
DROP INDEX IF EXISTS ci.entities_owner_active_created_idx;
