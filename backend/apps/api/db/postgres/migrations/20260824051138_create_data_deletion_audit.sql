-- migrate:up
-- Append-only audit trail for privacy / user-data-deletion actions (CASA ASVS
-- V8: "the app can delete user data upon request"). One row per disconnect or
-- account-deletion request, recording WHO triggered it, WHEN, WHAT scope, and
-- the per-table row counts purged. Deliberately NOT foreign-keyed to ci.users:
-- the audit record must outlive the user row it describes (an account deletion
-- removes ci.users, but the evidence that it happened must remain).
CREATE TABLE ci.data_deletion_audit (
    id UUID PRIMARY KEY,

    -- The account whose data was deleted (kept as a bare uuid, no FK, so the row
    -- survives deletion of that user).
    subject_user_id UUID NOT NULL,

    -- The principal that requested the deletion (the authenticated caller). For a
    -- self-service request this equals subject_user_id.
    requested_by_user_id UUID NOT NULL,

    -- 'connection' = a single connection was disconnected + its derived data
    -- purged; 'account' = the full account and all derived data were deleted.
    scope TEXT NOT NULL CHECK (scope IN ('connection', 'account')),

    -- For scope='connection', the connection that was disconnected (else NULL).
    connection_id UUID,

    -- For scope='connection', the provider id of that connection (else NULL).
    provider_id UUID,

    -- Whether the provider's OAuth token revocation endpoint accepted the token.
    -- NULL when no revocation was applicable (no token / no revocation endpoint).
    token_revoked BOOLEAN,

    -- Per-table purge tally, e.g. {"ci.communications": 1420, "ci.events": 88}.
    deleted_counts JSONB NOT NULL DEFAULT '{}',

    -- Total rows deleted across every table (sum of deleted_counts values).
    total_deleted INTEGER NOT NULL DEFAULT 0,

    -- 'completed' once the purge finished; 'failed' if it errored partway (the
    -- error is recorded in `error`). Idempotent re-runs append a new row.
    status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'failed')),
    error TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_data_deletion_audit_subject ON ci.data_deletion_audit (subject_user_id, created_at DESC);
CREATE INDEX idx_data_deletion_audit_connection ON ci.data_deletion_audit (connection_id) WHERE connection_id IS NOT NULL;

-- migrate:down
DROP TABLE IF EXISTS ci.data_deletion_audit;
