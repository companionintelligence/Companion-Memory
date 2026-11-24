-- migrate:up
-- A second `managed_by` value: 'sign_in', for the key the phone and desktop
-- apps mint each time someone signs in. Those keys are a signed-in device, not
-- a credential the person handed to a tool, so a password change and "Sign out
-- everywhere" revoke them, and the app revokes its own when it signs out.
--
-- Keys minted before this change carry no provenance. The apps name every one
-- of them `Companion mobile · <date>` (web `useAuth.ts`), so that name is taken
-- as the tag here, once. Getting it wrong costs little: a hand-made key with
-- exactly that name is revoked at the next password change and has to be made
-- again. It never gains anything, because 'sign_in' grants nothing a NULL
-- provenance does not.
UPDATE ci.api_keys
SET managed_by = 'sign_in'
WHERE managed_by IS NULL
  AND name ~ '^Companion mobile · [0-9]{4}-[0-9]{2}-[0-9]{2}$';

COMMENT ON COLUMN ci.api_keys.managed_by IS
  'Who owns this key''s lifecycle. NULL: the user made it in Settings. ''connect'': minted by the app-connect consent flow, rotated and revoked by CI-Hub. ''sign_in'': minted by the phone or desktop app at sign-in, revoked by a password change, by "Sign out everywhere" and by the app''s own sign-out.';

-- migrate:down
UPDATE ci.api_keys SET managed_by = NULL WHERE managed_by = 'sign_in';

COMMENT ON COLUMN ci.api_keys.managed_by IS
  'Who owns this key''s lifecycle: NULL = user-created; ''connect'' = minted by the Companion Memory consent flow.';
