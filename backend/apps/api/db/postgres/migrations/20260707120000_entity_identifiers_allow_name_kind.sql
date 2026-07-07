-- migrate:up
-- Display-name identifiers (kind = 'name') were added to the people-linking
-- code path in #1645 — chat networks (Messenger, Instagram) export neither
-- email nor phone, so a normalized display name is the only linkable
-- identifier — but the CHECK from 20260624140000_create_entity_identifiers
-- still only allowed ('email', 'phone'). Every 'name' write has therefore
-- failed the constraint since then; the graph-ingest identifier hook swallows
-- write errors by design (identifier indexing is non-fatal), so the failure
-- was silent and the table holds zero 'name' rows. Worse, an entity carrying
-- names alongside emails/phones lost ALL its identifiers, because they ride
-- in one multi-row INSERT that the CHECK violation aborts wholesale.
--
-- Widen the CHECK to match the code (EntityIdentifierEntity /
-- normalizeIdentifier already accept 'name'). The unique index
-- (owner_user_id, kind, value_normalized) needs no change — it is
-- kind-agnostic.
ALTER TABLE ci.entity_identifiers
    DROP CONSTRAINT IF EXISTS entity_identifiers_kind_check;
ALTER TABLE ci.entity_identifiers
    ADD CONSTRAINT entity_identifiers_kind_check CHECK (kind IN ('email', 'phone', 'name'));

-- migrate:down
-- Restoring the narrower CHECK requires removing the rows it would reject.
DELETE FROM ci.entity_identifiers WHERE kind = 'name';
ALTER TABLE ci.entity_identifiers
    DROP CONSTRAINT IF EXISTS entity_identifiers_kind_check;
ALTER TABLE ci.entity_identifiers
    ADD CONSTRAINT entity_identifiers_kind_check CHECK (kind IN ('email', 'phone'));
