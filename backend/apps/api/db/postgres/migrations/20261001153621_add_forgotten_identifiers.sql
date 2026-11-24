-- migrate:up
-- =====================================================================
-- FORGOTTEN IDENTIFIERS — a forgotten person must stay forgotten
-- =====================================================================
-- `memory.forget` in `archive_and_delete` mode deletes a Person, and with the
-- person their `ci.entity_identifiers` rows: the addresses, phone numbers and
-- handles the identifier index resolved to them. Two things mint a stub Person
-- from a message participant, and both skip an identifier the index already
-- covers: `CommunicationParticipantLinkListener` (every new message) and
-- `PersonStubBackfillService` (after every bulk import of communications).
-- With the rows gone, the very next pass mints the person again, from the mail
-- that still names them, and the person-link stage then re-attaches the whole
-- history to the new row. Measured: a delete-only forget was undone by the first
-- backfill pass, whether or not the message pointers had been cleared.
--
-- This table is what stops that. A forget records each identifier it frees here,
-- in the same transaction, and the two minting paths skip any identifier listed.
--
-- DIGESTS, NOT ADDRESSES. The table is a list of the people the user asked the
-- appliance to forget, so it must not be a readable one. Each row holds a SHA-256
-- digest of (owner, kind, normalized value), computed by one function so the
-- writer and the readers cannot disagree about it. A phone number is a small
-- space and can be brute-forced from its digest; the point is that the table does
-- not hand the addresses over to anyone who reads it.
--
-- WHAT IS DELIBERATELY NOT HERE. Display names: a name is shared by many people,
-- so a forgotten person known only by a name can come back through a message
-- that names them. A contact card imported again, and a person the language
-- model extracts from text, are not identifier-driven and are not stopped either:
-- a source that arrives again can mint the person again.
--
-- The rows go with the account (ON DELETE CASCADE), and are also named in the
-- account deletion plan so the tally is accurate.

CREATE FUNCTION ci.forgotten_identifier_digest(
    p_owner_user_id UUID,
    p_kind TEXT,
    p_value_normalized TEXT
) RETURNS BYTEA
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
    SELECT sha256(convert_to(p_owner_user_id::text || ':' || p_kind || ':' || p_value_normalized, 'UTF8'))
$$;

COMMENT ON FUNCTION ci.forgotten_identifier_digest(UUID, TEXT, TEXT) IS
    'The digest ci.forgotten_identifiers is keyed on. Defined once so the purge that writes it and the people-minting paths that read it cannot disagree.';

CREATE TABLE ci.forgotten_identifiers (
    owner_user_id UUID NOT NULL REFERENCES ci.users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('email', 'phone', 'handle')),
    identifier_digest BYTEA NOT NULL,
    forgotten_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_user_id, kind, identifier_digest)
);

COMMENT ON TABLE ci.forgotten_identifiers IS
    'Identifiers of people the owner asked memory.forget to erase, as digests (ci.forgotten_identifier_digest). The paths that mint a stub Person from a message participant skip a listed identifier, so the forgotten person is not created again from mail that still names them.';

-- migrate:down
DROP TABLE ci.forgotten_identifiers;
DROP FUNCTION ci.forgotten_identifier_digest(UUID, TEXT, TEXT);
