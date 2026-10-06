-- migrate:up
-- Two things the account-linking rules need from ci.users.
--
-- 1. `email_proven_at`: when this account's address was last shown to belong to
--    the person holding the account. Portal sign-in (browser and bearer) and the
--    Hub forward-auth bridge link an identity to an existing account BY ADDRESS
--    only when this is set. Signup and `PATCH /account/email` store whatever
--    address they are given, so without it anyone with an account could put a
--    future member's address on it and receive that person's first Portal or Hub
--    sign-in. Set when an account is created from a Portal or Hub identity, and
--    on the appliance's first account; cleared whenever the address changes.
--
-- 2. Addresses stored lower-cased and unique whatever their case. `email` was
--    only unique byte for byte, so `Owner@example.com` and `owner@example.com`
--    could both exist, and the Hub bridge (which folds case) then refused to pick
--    either.

ALTER TABLE ci.users ADD COLUMN email_proven_at timestamptz;

-- Every account that exists today keeps the links it would have had before this
-- change. Nothing on disk says which addresses were proven, and refusing the
-- link to existing accounts would lock out owners and Hub members whose next
-- Portal or Hub sign-in is the first since the upgrade. From here on, signup and
-- email changes produce unproven addresses.
UPDATE ci.users SET email_proven_at = created_at;

-- Rows whose address collides with another row's once case and surrounding
-- whitespace are ignored. They existed before this migration and are left
-- exactly as they are: rewriting one would sign its holder out of an address
-- they type today, and an index over them could not be built. Each still signs
-- in with its exact stored address. They are excluded from the case-insensitive
-- index below, and lookups that fold case treat them as ambiguous. An operator
-- can resolve a pair by changing or deleting one row and then clearing the flag
-- on the other.
ALTER TABLE ci.users ADD COLUMN email_case_conflict boolean NOT NULL DEFAULT false;

UPDATE ci.users u
SET email_case_conflict = true
WHERE EXISTS (
  SELECT 1
  FROM ci.users o
  WHERE o.id <> u.id
    AND lower(btrim(o.email)) = lower(btrim(u.email))
);

UPDATE ci.users
SET email = lower(btrim(email))
WHERE NOT email_case_conflict
  AND email IS DISTINCT FROM lower(btrim(email));

CREATE UNIQUE INDEX users_email_lower_uniq
    ON ci.users (lower(email))
    WHERE NOT email_case_conflict;

DO $$
DECLARE
  conflicting integer;
BEGIN
  SELECT count(*) INTO conflicting FROM ci.users WHERE email_case_conflict;

  IF conflicting > 0 THEN
    RAISE WARNING
      'ci.users: % account(s) share an email address that differs only in case. They were left unchanged and keep signing in with their exact address. SELECT id, email FROM ci.users WHERE email_case_conflict lists them.',
      conflicting;
  END IF;
END
$$;

-- migrate:down
DROP INDEX IF EXISTS ci.users_email_lower_uniq;
ALTER TABLE ci.users DROP COLUMN IF EXISTS email_case_conflict;
ALTER TABLE ci.users DROP COLUMN IF EXISTS email_proven_at;
