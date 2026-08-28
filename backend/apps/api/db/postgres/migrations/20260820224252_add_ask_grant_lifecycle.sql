-- migrate:up
-- ---------------------------------------------------------------------------
-- ci.ask_grants: expiry, and an append-only audit trail for consent changes.
--
-- The table shipped with exactly one lifecycle column, `revoked_at`, and the
-- Grant Manager UX promises more than that:
--
--   * "Expires Dec 2026" — the mock and the shipped GrantRow both render an
--     expiry, and there was no column behind it. The in-memory matcher had a
--     branch that treated a FUTURE `revoked_at` as still-active, i.e. someone
--     had reached for `revoked_at` as a scheduled expiry — but every SQL read
--     path filters `WHERE revoked_at IS NULL`, so writing a future date there
--     revoked the grant immediately as far as the database was concerned. That
--     branch is deleted in grantMatch.ts; this column replaces it.
--   * "Change this to review" — the matrix's core interaction had no mutation
--     at all. It is added as a SUPERSEDE, not an UPDATE: consent history is
--     evidence, and an UPDATE destroys the record of what the owner previously
--     allowed and for how long. The old row is revoked with
--     `revocation_reason = 'superseded'`, and the replacement carries
--     `supersedes_grant_id` + an incremented `version`, so the whole chain
--     stays reconstructible from the table alone.
--
-- `expires_at` is deliberately DISTINCT from `revoked_at`: "I withdrew this"
-- and "this lapsed on its own" are different events, and a disclosure audit
-- that cannot tell them apart cannot answer "was consent standing at the time?"
--
-- `revocation_reason` is nullable and only meaningful when `revoked_at` is set;
-- the CHECK keeps a reason from appearing on a live grant.
-- CI-Server #1711 → #1712.
-- ---------------------------------------------------------------------------

-- Scheduled lapse. NULL = no expiry (the existing behaviour for every current
-- row). Must be in the future relative to when the grant was written; a grant
-- born expired is a data-entry error, not a posture.
ALTER TABLE ci.ask_grants
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

ALTER TABLE ci.ask_grants
    ADD CONSTRAINT ask_grants_expires_after_created_chk
    CHECK (expires_at IS NULL OR expires_at > created_at);

-- Audit trail for consent changes (there was none: no version, no updated_at,
-- no link between a grant and the grant it replaced).
ALTER TABLE ci.ask_grants
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE ci.ask_grants
    ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE ci.ask_grants
    ADD CONSTRAINT ask_grants_version_positive_chk CHECK (version >= 1);

-- The grant this one replaced. ON DELETE SET NULL rather than CASCADE: losing
-- the ancestor must not delete the successor that is currently authorizing
-- disclosures. Self-referencing, so the chain reads newest → oldest.
ALTER TABLE ci.ask_grants
    ADD COLUMN IF NOT EXISTS supersedes_grant_id UUID
        REFERENCES ci.ask_grants(id) ON DELETE SET NULL;

-- Why the grant stopped being in force. Distinguishes an owner tapping Revoke
-- from a change that rewrote the grant as a new row.
ALTER TABLE ci.ask_grants
    ADD COLUMN IF NOT EXISTS revocation_reason TEXT
        CHECK (revocation_reason IN ('revoked', 'superseded'));

ALTER TABLE ci.ask_grants
    ADD CONSTRAINT ask_grants_revocation_reason_chk
    CHECK (revoked_at IS NOT NULL OR revocation_reason IS NULL);

-- Walk a supersede chain forwards (given a grant, what replaced it?). Partial:
-- only superseding rows carry the column.
CREATE INDEX IF NOT EXISTS ask_grants_supersedes_idx
    ON ci.ask_grants (supersedes_grant_id)
    WHERE supersedes_grant_id IS NOT NULL;

-- The Grant Manager's History surface reads every grant an owner ever wrote,
-- revoked and expired ones included — the existing
-- `ask_grants_owner_grantee_idx` is partial on `revoked_at IS NULL` and cannot
-- serve it.
CREATE INDEX IF NOT EXISTS ask_grants_owner_history_idx
    ON ci.ask_grants (owner_user_id, created_at DESC);

-- migrate:down
DROP INDEX IF EXISTS ci.ask_grants_owner_history_idx;
DROP INDEX IF EXISTS ci.ask_grants_supersedes_idx;
ALTER TABLE ci.ask_grants DROP CONSTRAINT IF EXISTS ask_grants_revocation_reason_chk;
ALTER TABLE ci.ask_grants DROP COLUMN IF EXISTS revocation_reason;
ALTER TABLE ci.ask_grants DROP COLUMN IF EXISTS supersedes_grant_id;
ALTER TABLE ci.ask_grants DROP CONSTRAINT IF EXISTS ask_grants_version_positive_chk;
ALTER TABLE ci.ask_grants DROP COLUMN IF EXISTS version;
ALTER TABLE ci.ask_grants DROP COLUMN IF EXISTS updated_at;
ALTER TABLE ci.ask_grants DROP CONSTRAINT IF EXISTS ask_grants_expires_after_created_chk;
ALTER TABLE ci.ask_grants DROP COLUMN IF EXISTS expires_at;
