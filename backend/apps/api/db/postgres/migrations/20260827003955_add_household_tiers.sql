-- migrate:up
-- ---------------------------------------------------------------------------
-- A housemate can now be demoted. Until this table, they could not be.
--
-- `AskResolver.resolveTier` is a `return` statement: every LOCAL asker resolves
-- to `household`, and `TIER_CEILINGS.household` is `{'*': 'full'}` — the widest
-- ceiling on the ladder AND the only tier exempt from the sensitive-class floor
-- in `disclosureCeiling`. So a member of the owner's own box could receive
-- health, financial, location and credential disclosures at `full`, with no
-- human in the loop, and there was no column, no mutation and no UI that could
-- store anything else.
--
-- That is G6 in docs/asks-system-guide.md §9 and threat T1 in
-- docs/asks-threat-model.md: "the person who shares the appliance is by
-- construction the most privileged asker, with no ceiling, no cooling period,
-- and no way to demote them". It is the shape of the ask that matters most in
-- exactly the households this feature is least safe in.
--
-- ═══ WHAT THIS MIGRATION DOES AND DELIBERATELY DOES NOT DO ═══
--
-- It adds the MECHANISM. It does not change the DEFAULT.
--
-- An owner with no row here keeps `household` for every local asker, so nothing
-- about any existing box changes when this runs. Whether the default SHOULD be
-- `household` is decision #1 in the threat model's §12 — "none of these are
-- engineering calls" — and it is written up in docs/asks-household-default.md
-- so somebody can make it. Changing a default is one line; changing it without
-- the mechanism to opt out of would have been the only thing worse than leaving
-- it alone.
--
-- ═══ WHY `household` IS A LEGAL VALUE HERE AND NOT ON A PEER LINK ═══
--
-- `ci.peer_links.trust_tier` deliberately excludes `household` (see
-- `PEER_TRUST_TIERS`): a household member across a box boundary is a
-- contradiction. Here it is the OPPOSITE — `household` is the default this
-- table exists to let an owner move away from, and an owner who has demoted
-- someone must be able to restore them without deleting the row and losing the
-- record that they once decided otherwise.
--
-- CI-Server #1711 -> epic #1712.
-- ---------------------------------------------------------------------------

CREATE TABLE ci.household_tiers (
    id UUID PRIMARY KEY DEFAULT gen_uuid_v7(),
    -- Whose memory is being disclosed FROM. Every row is one owner's decision
    -- about one other local account; two people on the same box may rate each
    -- other differently, and neither gets to set the other's view.
    owner_user_id UUID NOT NULL REFERENCES ci.users(id) ON DELETE CASCADE,
    member_user_id UUID NOT NULL REFERENCES ci.users(id) ON DELETE CASCADE,
    trust_tier TEXT NOT NULL
        CHECK (trust_tier IN ('household', 'family', 'trusted', 'peer', 'stranger')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- An owner cannot rate themselves. Their own asks never reach the consent gate
-- (an ask must be directed at another user — see `UNROUTABLE_RESPONDER`), so a
-- self row could only ever be a value nothing reads.
ALTER TABLE ci.household_tiers
    ADD CONSTRAINT household_tiers_not_self_chk CHECK (owner_user_id <> member_user_id);

-- ONE VERDICT PER PAIR. Load-bearing, not an optimization: two rows for the
-- same pair with different tiers would make the disclosure ceiling depend on
-- which one Postgres returned first — the heap-order defect `strictestOf` was
-- written to end for grants, reappearing one table over.
--
-- Deliberately a plain unique index and not a partial one: unlike a grant, this
-- is a CURRENT SETTING rather than an append-only consent record. An owner
-- moving someone from `trusted` back to `household` is changing their mind, not
-- writing a second grant, and there is nothing here a later audit needs to
-- reconstruct — what was actually disclosed is in `ci.ask_audit`, which records
-- the outcome rather than the posture.
CREATE UNIQUE INDEX household_tiers_owner_member_uniq
    ON ci.household_tiers (owner_user_id, member_user_id);

COMMENT ON TABLE ci.household_tiers IS
    'Per-owner trust tier for another LOCAL account. Absent = household (the default). See docs/asks-household-default.md.';

-- migrate:down
DROP TABLE IF EXISTS ci.household_tiers;
