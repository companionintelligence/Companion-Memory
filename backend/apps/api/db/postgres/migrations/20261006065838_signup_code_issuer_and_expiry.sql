-- migrate:up
-- An invitation now records who issued it and stops working after a week.
--
-- `issued_by` lets an invitation die with the account that issued it: when that
-- account is deleted, its unused codes are deleted in the same transaction
-- (`UserService.requestDeletion`). NULL for codes minted by an operator with
-- `make signup`, and for every code that exists today, since nothing recorded
-- the issuer. ON DELETE CASCADE so the account purge removes the rows with the
-- account rather than tripping on them.
--
-- `expires_at` bounds how long an invitation nobody used keeps working. Codes
-- that exist today get a week from the upgrade, so an invitation already sent
-- still arrives intact.
ALTER TABLE ci.signup_code
    ADD COLUMN issued_by uuid REFERENCES ci.users (id) ON DELETE CASCADE,
    ADD COLUMN expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days');

CREATE INDEX signup_code_issued_by_idx ON ci.signup_code (issued_by) WHERE issued_by IS NOT NULL;

-- migrate:down
DROP INDEX IF EXISTS ci.signup_code_issued_by_idx;
ALTER TABLE ci.signup_code
    DROP COLUMN IF EXISTS expires_at,
    DROP COLUMN IF EXISTS issued_by;
