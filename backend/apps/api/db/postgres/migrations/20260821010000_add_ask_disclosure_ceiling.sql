-- migrate:up
-- ---------------------------------------------------------------------------
-- ci.asks: the disclosure ceiling, CAPTURED AT CONSENT TIME.
--
-- Closing consent used to make the answer BIGGER.
--
-- `AskResolver.resolveGrantCeiling` re-derived the deciding grant's
-- `scope.maxDisclosure` at ANSWER time by re-running the grant evaluation.
-- Every SQL read path filters `revoked_at IS NULL`, so once the owner revoked
-- the grant (or it lapsed) the re-evaluation found nothing, returned no
-- ceiling, and only the tier ceiling applied. On an ask the owner had already
-- approved — status `answering`, which #2211 deliberately exempts from
-- retroactive withdrawal so a human's yes to one specific ask is not undone by
-- withdrawing an unrelated standing grant — the disclosure therefore GREW when
-- consent was withdrawn: reproduced as `items: []` / "3 matching items." with
-- the grant in force, and three readable entity references with it revoked.
--
-- It also made Revoke strictly more dangerous than Block: a live `block` grant
-- maps to ceiling `none`, while a REVOKED grant mapped to no ceiling at all.
--
-- The fix is to stop asking a live table what the owner consented to. The
-- ceiling is stamped on the ask at the moment consent is given — the auto path
-- stamps it at submit, the review path at `approve()` — and the answer path
-- takes the NARROWER of the stamped value and whatever the grants say now. A
-- later revocation can then only ever tighten (a live block still floors the
-- ceiling at `none`); it can never remove the cap the owner consented under.
--
-- NULL is a real value here and means "no grant ceiling applied when consent
-- was given" — an owner-approved ask that no grant capped. It is NOT "unknown":
-- the answer path treats NULL as "this source imposes no cap" and falls back to
-- the live evaluation, which is the pre-existing behaviour and correct for asks
-- that never had a grant ceiling.
--
-- CI-Server #1711 → #1712.
-- ---------------------------------------------------------------------------

ALTER TABLE ci.asks
    ADD COLUMN IF NOT EXISTS disclosure_ceiling TEXT;

-- The rung vocabulary, pinned in the schema for the same reason `status` is:
-- an unreadable rung is treated as the STRICTEST one in code (grantMatch's
-- `ceilingOf`), and a column that can hold a typo is a column that will.
ALTER TABLE ci.asks
    ADD CONSTRAINT asks_disclosure_ceiling_chk
    CHECK (disclosure_ceiling IS NULL OR disclosure_ceiling IN
        ('none', 'boolean', 'count', 'summary', 'redacted', 'full'));

-- Best-effort backfill for asks that are still in flight and still name the
-- grant that pre-authorized them. Only ever TIGHTENS: it writes a ceiling where
-- there was none, and only from the grant the ask itself already cites as its
-- consent basis.
--
-- Two populations are deliberately NOT backfilled, because there is no honest
-- value for them: terminal asks (already answered — history is not rewritten),
-- and asks the owner approved off the review path, which carry no consent
-- basis and therefore name no grant to read a ceiling from. Those keep NULL and
-- fall back to the live evaluation exactly as they do today.
UPDATE ci.asks a
SET disclosure_ceiling = g.scope ->> 'maxDisclosure'
FROM ci.ask_grants g
WHERE g.id::text = a.consent_basis
  AND a.disclosure_ceiling IS NULL
  AND a.status IN ('delivered', 'under_review', 'answering')
  AND g.scope ->> 'maxDisclosure' IN ('none', 'boolean', 'count', 'summary', 'redacted', 'full');

-- migrate:down
ALTER TABLE ci.asks DROP CONSTRAINT IF EXISTS asks_disclosure_ceiling_chk;
ALTER TABLE ci.asks DROP COLUMN IF EXISTS disclosure_ceiling;
