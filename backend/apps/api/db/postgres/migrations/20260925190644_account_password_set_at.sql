-- migrate:up

-- When the account's password was last chosen BY THE USER, or NULL for a
-- password the user has never seen: accounts provisioned by CI-Portal sign-in,
-- the OIDC callback and the Hub forward-auth bridge get a random one so they
-- can exist at all. `AccountController.requireReauth` reads this to decide
-- whether "prove it with your current password" is a question the user can
-- answer; before it, any account with a federated identity was exempt for
-- good, even after it had set a password of its own (2026-09-24 audit).
ALTER TABLE ci.users ADD COLUMN password_set_at timestamptz;

-- Every account without a federated identity chose its own password at
-- signup (or a reset), so it keeps the check it always had.
UPDATE ci.users u
SET password_set_at = u.created_at
WHERE NOT EXISTS (SELECT 1 FROM ci.federated_identities f WHERE f.user_id = u.id);

-- migrate:down

ALTER TABLE ci.users DROP COLUMN password_set_at;
