-- migrate:up
-- ---------------------------------------------------------------------------
-- HOW an ask arrived, recorded beside WHAT it asked.
--
-- `ci.asks` records the question, the consent basis and the ceiling — the whole
-- of WHAT was authorized — and nothing at all about the CHANNEL it came in on.
-- After 20260826155700 that is a real omission rather than a cosmetic one:
-- an inbound peer ask may now be cryptographically signed, and whether it was
-- is the difference between
--
--   "someone holding a token that names this peer asked me this"
--   and
--   "this peer's own key signed this exact question, at this time, once".
--
-- The owner is the person who has to tell those apart, and the verification
-- outcome was going only to a log line. So it is persisted, and the ask
-- surfaces render it (the lock and the signature modal).
--
-- This is also the "when and how was this collected" record for the ask itself.
-- Provenance for the ANSWER's underlying items is a different question, already
-- served by ci.ask_audit.backing_entities and the entity's own source fields.
--
-- ═══ NULL MEANS UNSIGNED, AND THAT IS A REAL ANSWER ═══
--
-- Every ask that exists today has no signature, and `peers.requireHttpSignature`
-- ships off, so most asks will keep having none. NULL therefore means "this
-- arrived over an unsigned channel" — a fact worth showing, not an absence to
-- hide. The UI says so plainly rather than leaving the row blank, because an
-- owner who cannot tell "unsigned" from "we did not record it" cannot use the
-- distinction at all.
--
-- CI-Server #1711 -> epic #1712.
-- ---------------------------------------------------------------------------

-- RFC 7638 thumbprint of the key that signed the request, when one did.
-- Denormalized from the peer link AS OF ARRIVAL: re-reading the link later
-- would report the key the peer uses NOW, and an audit that silently updates
-- itself when a key is rotated cannot answer "what signed this at the time".
ALTER TABLE ci.asks
    ADD COLUMN IF NOT EXISTS channel_key_thumbprint TEXT;

ALTER TABLE ci.asks
    ADD CONSTRAINT asks_channel_thumbprint_shape_chk
    CHECK (channel_key_thumbprint IS NULL OR channel_key_thumbprint ~ '^[A-Za-z0-9_-]{43}$');

-- When this box verified that signature. Distinct from `created_at`, which is
-- when the row was written: they are within milliseconds in practice, and
-- conflating "we accepted this" with "we recorded this" is exactly the kind of
-- shortcut that stops being true the first time verification moves.
ALTER TABLE ci.asks
    ADD COLUMN IF NOT EXISTS channel_verified_at TIMESTAMPTZ;

-- The signature base's covered components, as actually presented.
--
-- Stored rather than re-derived from the profile, even though `httpSignature.ts`
-- accepts only three: the profile is what we ACCEPT today, and the audit has to
-- say what a given request COVERED. Widening the profile later must not silently
-- rewrite the meaning of rows already here.
ALTER TABLE ci.asks
    ADD COLUMN IF NOT EXISTS channel_covered TEXT[];

-- Both-or-neither, three ways. A thumbprint with no timestamp claims a
-- verification that never happened; a timestamp with no thumbprint claims one
-- by nobody.
ALTER TABLE ci.asks
    ADD CONSTRAINT asks_channel_paired_chk
    CHECK (
        (channel_key_thumbprint IS NULL AND channel_verified_at IS NULL AND channel_covered IS NULL)
        OR (channel_key_thumbprint IS NOT NULL AND channel_verified_at IS NOT NULL AND channel_covered IS NOT NULL)
    );

-- A signed ask is by definition federated: a local ask never crosses a network
-- boundary, so a signature on one would mean the column was written by
-- something that does not exist.
ALTER TABLE ci.asks
    ADD CONSTRAINT asks_channel_federated_chk
    CHECK (channel_key_thumbprint IS NULL OR direction <> 'local');

COMMENT ON COLUMN ci.asks.channel_key_thumbprint IS
    'Key that signed this request, as of arrival. NULL = arrived over an unsigned channel, which is a fact, not an absence.';

-- migrate:down
ALTER TABLE ci.asks DROP CONSTRAINT IF EXISTS asks_channel_federated_chk;
ALTER TABLE ci.asks DROP CONSTRAINT IF EXISTS asks_channel_paired_chk;
ALTER TABLE ci.asks DROP COLUMN IF EXISTS channel_covered;
ALTER TABLE ci.asks DROP COLUMN IF EXISTS channel_verified_at;
ALTER TABLE ci.asks DROP CONSTRAINT IF EXISTS asks_channel_thumbprint_shape_chk;
ALTER TABLE ci.asks DROP COLUMN IF EXISTS channel_key_thumbprint;
