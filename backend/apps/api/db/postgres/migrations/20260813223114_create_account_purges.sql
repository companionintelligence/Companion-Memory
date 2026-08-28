-- migrate:up
-- The record that an account's data was actually destroyed.
--
-- `ci.users.purge_after` (see 20260716130506_add_user_soft_delete.sql) is the
-- promise; this table is the enforcement's memory of having kept it. It is
-- deliberately a separate table rather than more columns on ci.users, because
-- the row it describes does not exist by the time the purge finishes — the last
-- statement of a successful purge is `DELETE FROM ci.users`.
--
-- Which is also why there is NO foreign key to ci.users here. A reference would
-- either block the delete or null itself out, and both destroy the only evidence
-- that the deletion request was honoured. What survives is a bare uuid, the
-- timestamps, and per-table row counts: enough to answer "was this account's
-- data deleted, and when", and not enough to reconstruct anything about the
-- person. That answer is what the App Store nutrition label and the Google Play
-- Data Safety form are asserting, so it has to be auditable after the fact.
CREATE TABLE IF NOT EXISTS ci.account_purges (
    user_id             UUID PRIMARY KEY,

    -- Copied off ci.users when the purge starts, so the promise outlives the row.
    requested_at        TIMESTAMPTZ NOT NULL,
    purge_after         TIMESTAMPTZ NOT NULL,

    started_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,

    -- A purge is resumable by construction: each batch commits, and every
    -- statement is scoped by "belongs to this account", so a re-run continues
    -- from wherever the last one stopped rather than repeating it. These columns
    -- exist to stop a permanently failing account from being retried in a hot
    -- loop, and to make the failure visible.
    attempts            INTEGER NOT NULL DEFAULT 0,
    next_attempt_after  TIMESTAMPTZ,
    last_error          TEXT,

    -- Rows removed per schema-qualified table, and objects removed from the
    -- object store. Counts only — no column values, no payloads.
    deleted_rows        JSONB NOT NULL DEFAULT '{}'::JSONB,
    deleted_objects     INTEGER NOT NULL DEFAULT 0,

    -- Rows whose reference to this account was nulled rather than deleted, per
    -- table. Kept separate from deleted_rows because they are not the same
    -- claim: a nulled row still exists. These are the attributions on rows
    -- belonging to someone else — who created another account, who changed a
    -- shared graph node — and counting them as deletions would overstate,
    -- inside the record that exists to be exact, what the purge actually did.
    detached_rows       JSONB NOT NULL DEFAULT '{}'::JSONB,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE ci.account_purges IS
  'Audit record of account-data purges. Intentionally has no FK to ci.users: the user row is deleted by the purge this table records.';

COMMENT ON COLUMN ci.account_purges.deleted_rows IS
  'Rows deleted per schema-qualified table. Counts only, never values.';

-- The purge cron's claim query: unfinished purges that are due for another
-- attempt. Partial, because completed purges are never looked at again.
CREATE INDEX IF NOT EXISTS idx_account_purges_pending
  ON ci.account_purges (next_attempt_after)
  WHERE completed_at IS NULL;

-- migrate:down
DROP INDEX IF EXISTS ci.idx_account_purges_pending;
DROP TABLE IF EXISTS ci.account_purges;
