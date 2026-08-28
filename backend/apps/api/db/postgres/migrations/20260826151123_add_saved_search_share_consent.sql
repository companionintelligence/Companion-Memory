-- migrate:up
-- ---------------------------------------------------------------------------
-- Put shared saved searches behind the SAME consent layer as asks.
--
-- `ci.saved_searches.share_token` (20260702012521) is a bare bearer capability.
-- Next to the ask path — which carries standing grants, a disclosure ceiling,
-- an expiry, a supersede chain and a durable audit row per disclosure — the
-- share path carries none of it:
--
--   * NO PER-RECIPIENT IDENTITY. Everyone who holds the link is the same
--     anonymous principal, so the owner cannot see who read their memory and
--     cannot revoke one reader.
--   * NO CEILING. A shared search always disclosed full result nodes; the
--     owner had no way to share "how many" without also sharing "which".
--   * NO EXPIRY. A link stands until the owner remembers to turn it off.
--   * NO AUDIT. `ci.ask_audit` is the owner's Disclosure History, and reads
--     through a share link were invisible in it — the one disclosure surface
--     with no record at all.
--   * ALL-OR-NOTHING REVOCATION, WITH NO HISTORY. `setSharing(false)` clears
--     the token, cutting off every reader at once and leaving nothing behind
--     that says a share ever existed.
--
-- Rather than grow a second consent vocabulary beside `ci.ask_grants`, a share
-- now MINTS a grant. The token keeps its job — it is the invitation, the thing
-- that travels in a URL — and the grant is what the invitation is exchanged
-- for on first use, which is the standing, owner-visible, individually
-- revocable handle the token could never be.
--
-- CI-Server #1711 -> epic #1712. See docs/asks-system-guide.md §2.
-- ---------------------------------------------------------------------------

-- ── ci.ask_grants: a grant may now name ONE resource ───────────────────────
--
-- Grants were addressed by (queryType, dataClass) — a CLASS of question. A
-- shared saved search is not a class of question, it is one specific object,
-- and collapsing it into `data_class` would have put a uuid through
-- `canonicalDataClass` (a lowercase/trim normalizer for words like 'photos')
-- and matched it against tier ceiling tables keyed on the same vocabulary.
-- The resource is therefore its own pair of columns.
ALTER TABLE ci.ask_grants
    ADD COLUMN IF NOT EXISTS resource_type TEXT,
    ADD COLUMN IF NOT EXISTS resource_id UUID;

-- Pinned in the schema for the same reason `mode` and `status` are: an
-- unreadable resource type is a resource type that will be written.
ALTER TABLE ci.ask_grants
    ADD CONSTRAINT ask_grants_resource_type_chk
    CHECK (resource_type IS NULL OR resource_type IN ('saved_search'));

-- Both or neither. A resource id with no type names nothing; a type with no id
-- covers everything of that type, which is a wildcard nobody asked for.
ALTER TABLE ci.ask_grants
    ADD CONSTRAINT ask_grants_resource_paired_chk
    CHECK ((resource_type IS NULL) = (resource_id IS NULL));

-- One LIVE grant per (owner, grantee, resource).
--
-- Load-bearing, not an optimization: two concurrent first-reads of the same
-- share link race to mint the grant, and this is what makes exactly one of them
-- win at the database rather than both. It is the same argument
-- `peer_ask_correlations_link_corr_uniq` makes for a repeated peer ask.
--
-- Partial on `revoked_at IS NULL` so the supersede/revoke history stays
-- writable: a revoked grant and its replacement coexist by design.
CREATE UNIQUE INDEX IF NOT EXISTS ask_grants_live_resource_grantee_uniq
    ON ci.ask_grants (owner_user_id, grantee_user_id, resource_type, resource_id)
    WHERE revoked_at IS NULL AND resource_id IS NOT NULL AND grantee_user_id IS NOT NULL;

-- "Who can read this share, and who could?" — the owner's per-resource view,
-- revoked rows included. The existing owner indexes are keyed on grantee or
-- partial on `revoked_at IS NULL` and cannot serve it.
CREATE INDEX IF NOT EXISTS ask_grants_resource_idx
    ON ci.ask_grants (resource_type, resource_id, created_at DESC)
    WHERE resource_id IS NOT NULL;

COMMENT ON COLUMN ci.ask_grants.resource_id IS
    'The single object this grant covers, when it covers one object rather than a class of question. Paired with resource_type.';

-- ── ci.saved_searches: the posture the token never carried ─────────────────

-- The most a reader of this share may ever receive. Rungs are
-- `DISCLOSURE_RUNGS` in domains/asks/policy.ts, pinned here for the same reason
-- `ci.asks.disclosure_ceiling` pins them.
--
-- NULL IS A REAL VALUE and means "this share declares no ceiling of its own" —
-- exactly what `narrowestRung` means by a source that says nothing. It is NOT
-- "unknown", and it is NOT `none`: every share that exists today has no ceiling
-- and discloses full result nodes, so NULL has to keep doing that or this
-- migration silently blanks live links. A PRESENT-but-unreadable value is the
-- opposite case and fails closed in code (`ceilingForShare`), matching
-- `grantMatch.ceilingOf`.
ALTER TABLE ci.saved_searches
    ADD COLUMN IF NOT EXISTS share_max_disclosure TEXT;

ALTER TABLE ci.saved_searches
    ADD CONSTRAINT saved_searches_share_ceiling_chk
    CHECK (share_max_disclosure IS NULL OR share_max_disclosure IN
        ('none', 'boolean', 'count', 'summary', 'redacted', 'full'));

-- Scheduled lapse for the link. NULL = stands until the owner unshares, which
-- is today's behaviour for every existing row.
--
-- Deliberately NOT the ask path's `defaultAskExpiry` treatment, where a nullish
-- value takes a default and a caller cannot opt out. An ask is an OPEN
-- AUTHORIZATION for as long as it is unanswered and nobody benefits from one
-- outliving the owner's attention; a share link is a thing the owner published
-- on purpose and may reasonably intend to stand. Forcing a TTL here would
-- expire every link already in the wild 72 hours after this migration ran.
ALTER TABLE ci.saved_searches
    ADD COLUMN IF NOT EXISTS share_expires_at TIMESTAMPTZ;

COMMENT ON COLUMN ci.saved_searches.share_max_disclosure IS
    'Ceiling stamped onto each reader''s grant when they first open the link. NULL = no ceiling from this source.';

-- migrate:down
ALTER TABLE ci.saved_searches DROP CONSTRAINT IF EXISTS saved_searches_share_ceiling_chk;
ALTER TABLE ci.saved_searches DROP COLUMN IF EXISTS share_expires_at;
ALTER TABLE ci.saved_searches DROP COLUMN IF EXISTS share_max_disclosure;

DROP INDEX IF EXISTS ci.ask_grants_resource_idx;
DROP INDEX IF EXISTS ci.ask_grants_live_resource_grantee_uniq;
ALTER TABLE ci.ask_grants DROP CONSTRAINT IF EXISTS ask_grants_resource_paired_chk;
ALTER TABLE ci.ask_grants DROP CONSTRAINT IF EXISTS ask_grants_resource_type_chk;
ALTER TABLE ci.ask_grants DROP COLUMN IF EXISTS resource_id;
ALTER TABLE ci.ask_grants DROP COLUMN IF EXISTS resource_type;
