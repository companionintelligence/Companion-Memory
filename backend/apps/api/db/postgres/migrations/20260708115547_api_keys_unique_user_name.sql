-- migrate:up
-- Idempotency for connect-minted keys ONLY. The app-connect flow mints keys
-- named `app:<urn>` and rotates them in place, so it needs at most one such key
-- per (user, name). A PARTIAL unique index scoped to `app:%` gives that
-- guarantee without touching operator-created keys: names remain free-form and
-- non-unique for keys made via the Settings UI (a global unique index would
-- both delete existing duplicate-named keys — silently revoking working
-- credentials — and turn a duplicate name in Settings into a 500).
--
-- De-dup only pre-existing `app:%` rows (there are none before this feature
-- ships, so this is a no-op on upgrade; it guards re-runs / partial states),
-- keeping the most recently created row per (user, name). The `id` tiebreak
-- guarantees exactly one survivor even when two rows share a `created_at` — a
-- plain `<` would leave both, then abort the unique-index creation below.
DELETE FROM ci.api_keys a
USING ci.api_keys b
WHERE a.user_id = b.user_id
  AND a.name = b.name
  AND a.name LIKE 'app:%'
  AND (a.created_at < b.created_at
       OR (a.created_at = b.created_at AND a.id < b.id));

CREATE UNIQUE INDEX idx_api_keys_user_id_app_name
  ON ci.api_keys(user_id, name)
  WHERE name LIKE 'app:%';

-- migrate:down
DROP INDEX IF EXISTS ci.idx_api_keys_user_id_app_name;
