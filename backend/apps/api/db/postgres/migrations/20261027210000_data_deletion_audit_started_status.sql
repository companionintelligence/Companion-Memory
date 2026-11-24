-- migrate:up

-- `POST /users/me/delete` no longer deletes the whole account in one transaction.
-- It ends the account in a short one (sign-in, sessions, API keys and provider
-- tokens gone, the successor promoted) and hands the rows to the batched,
-- resumable account purge. The audit says so in two rows: 'started' when the
-- account is ended, 'completed' (with the counts) when the purge has removed the
-- last row, whichever run that is. A 'started' row with no later 'completed' is
-- a purge still to finish; `ci.account_purges` has its attempts and last error.
ALTER TABLE ci.data_deletion_audit DROP CONSTRAINT data_deletion_audit_status_check;
ALTER TABLE ci.data_deletion_audit
  ADD CONSTRAINT data_deletion_audit_status_check CHECK (status IN ('started', 'completed', 'failed'));

-- migrate:down
DELETE FROM ci.data_deletion_audit WHERE status = 'started';
ALTER TABLE ci.data_deletion_audit DROP CONSTRAINT data_deletion_audit_status_check;
ALTER TABLE ci.data_deletion_audit
  ADD CONSTRAINT data_deletion_audit_status_check CHECK (status IN ('completed', 'failed'));
