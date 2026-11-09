-- migrate:up

-- Ending an account no longer clears its connections' tokens in the same
-- transaction. The transaction that ends the account (under the lock every
-- sign-up takes) marks each connection as waiting for its provider grant to be
-- revoked; the revocation runs after the commit, with no lock held. A connection
-- whose revocation succeeded (or had nothing to revoke) has its tokens and this
-- mark cleared. One whose revocation failed keeps both, so the account purge can
-- try again before it deletes the row: clearing the tokens first left a grant
-- that nothing could revoke any more.
ALTER TABLE ci.connections ADD COLUMN IF NOT EXISTS revocation_pending_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_connections_revocation_pending
  ON ci.connections (user_id)
  WHERE revocation_pending_at IS NOT NULL;

-- Per-connection revocation outcomes of an account delete, on its account-level
-- audit rows: on 'started' every connection is pending; 'completed' carries the
-- final outcome of each (revoked, nothing to revoke, failed) and the counts. A
-- single boolean (`token_revoked`) recorded a mixed result as revoked.
ALTER TABLE ci.data_deletion_audit ADD COLUMN IF NOT EXISTS revocations JSONB;

-- migrate:down
ALTER TABLE ci.data_deletion_audit DROP COLUMN IF EXISTS revocations;
DROP INDEX IF EXISTS ci.idx_connections_revocation_pending;
ALTER TABLE ci.connections DROP COLUMN IF EXISTS revocation_pending_at;
