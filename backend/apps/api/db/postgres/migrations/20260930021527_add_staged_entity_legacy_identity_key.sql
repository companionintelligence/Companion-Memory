-- migrate:up

-- The identity key a staged entity WOULD have had before contact parsers began
-- marking shared handles, recorded beside the one it has now.
--
-- A contact used to key on its lexicographically smallest handle, whatever that
-- was. Digits sort before letters, so an office's main line beat each
-- colleague's own email, every card from the firm keyed on the switchboard, and
-- staging collapsed them into one entity — pushed as ONE Person whose `Names`
-- listed three different people. A fax that sorted below someone's direct line
-- keyed them on office equipment. The parsers now mark such handles `shared`
-- and `entityIdentityKey` passes over them (import/staging/identity.ts).
--
-- That MOVES the natural key of every contact whose smallest handle was shared,
-- and `GraphIngestService` resolves an existing row by that key alone: without
-- help, the next import of the same export mints a new Person beside every one
-- of them. No migration can move those rows instead. Whether a handle was a fax
-- is a TEL type, and whether it was shared is a fact about the OTHER cards in
-- the export; neither survives staging, and `ci.entities` holds only each
-- entity's merged union of handles, so the new key cannot be recomputed in SQL.
--
-- The parser, though, has both keys in hand. This column carries the old one
-- to the push, which moves the row minted under it onto the new key in place
-- (`import/push/legacyKeys.ts`) — keeping its id, its edges and its history —
-- and the ingest that follows overwrites its properties with what the card now
-- says, which is what separates a collapsed Person back into one person.
--
-- NULL when the old key is the new one (nearly always), and for rows staged
-- before this migration. No index: the push reads it with the rest of the row.
ALTER TABLE ci_import.staged_entities
    ADD COLUMN legacy_identity_key TEXT;

COMMENT ON COLUMN ci_import.staged_entities.legacy_identity_key IS
    'The identity_key the pre-2026-09-30 rule (smallest handle, shared or not) gives this entity, when it differs from identity_key. The push re-keys the ci.entities row minted under it.';

-- migrate:down

ALTER TABLE ci_import.staged_entities
    DROP COLUMN IF EXISTS legacy_identity_key;
