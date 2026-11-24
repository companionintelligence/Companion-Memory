-- migrate:up
-- Raise the key a phone already holds to the level the app has asked for since
-- #2661 (v2026.9.14), so the mobile app keeps working once deletes need `full`.
--
-- The native app trades its sign-in for an api key and uses nothing else from
-- then on. Since #2661 it mints that key at `full` (web `useAuth.ts`,
-- NATIVE_KEY_CAPABILITY), because the app issues the destructive mutations:
-- deleting a note, an event, a person or a tag, merging people, renaming a tag.
-- A phone that signed in before that release still holds the key it got then,
-- at the column default `write` (20260730134728), and nothing on the phone ever
-- re-mints it. The same release that adds this file makes REST deletes and the
-- data-losing GraphQL fields require `full`, so without it those phones would
-- start answering every delete with a 403 until their owner signed out and in.
--
-- Matched on the exact name the app gives the key,
-- `Companion mobile · <YYYY-MM-DD>` (unchanged since the app first minted keys
-- in 96bc1010d), and only on rows the app could have written: no scopes (the
-- app never sends any), no connect provenance, and still at `write`. A key the
-- owner made in Settings would need that exact name to be caught, and a key
-- the owner deliberately set to `read` is never touched.
--
-- Provenance may be NULL or 'sign_in'. A release that records sign-in
-- provenance tags these same keys 'sign_in' in a migration with an earlier
-- version than this one, so where both ship it runs first; matching NULL alone
-- would then raise nothing. Where it has not shipped, no key holds 'sign_in'.
UPDATE ci.api_keys
   SET capability = 'full',
       updated_at = now()
 WHERE (managed_by IS NULL OR managed_by = 'sign_in')
   AND cardinality(scopes) = 0
   AND capability = 'write'
   AND name ~ '^Companion mobile · [0-9]{4}-[0-9]{2}-[0-9]{2}$';

-- migrate:down
-- Deliberately empty. A `full` mobile key here is indistinguishable from one the
-- app minted at `full` itself after #2661, and lowering those would break
-- deletes on phones that never had this migration's help.
SELECT 1;
