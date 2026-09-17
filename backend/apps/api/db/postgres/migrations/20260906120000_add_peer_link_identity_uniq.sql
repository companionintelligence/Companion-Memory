-- migrate:up
-- ---------------------------------------------------------------------------
-- ONE LIVE LINK PER (owner, peer identity).
--
-- `peer_links.peer_issuer` / `peer_subject` become WRITABLE through
-- `CreatePeerLinkInput` / `UpdatePeerLinkInput` and `ci-memory peers add`
-- with this change. Until now the only writer outside tests was hand-written
-- SQL (docs/peer-federation.md), so the question "what if two links claim the
-- same remote identity?" was academic. It stops being academic the moment an
-- owner can type the pair in.
--
-- ═══ WHY THIS IS A CORRECTNESS FIX, NOT AN OPTIMIZATION ═══
--
-- Two live links under ONE owner carrying the same (peer_issuer, peer_subject)
-- are read by two different finders, and they disagree:
--
--   * `findActiveByPeerIdentity` returns BOTH rows, and
--     `PeerAskService.resolveLink` refuses on `links.length > 1` with
--     "Ambiguous peer link". Fail-closed, but the owner's federation is now
--     silently dead and the 403 says nothing about why.
--   * `findActiveByIssuerSubject` is a `findOne` with NO ordering. It returns
--     an ARBITRARY one of the two — so which `trust_tier` ceiling that remote
--     identity inherits is decided by heap order. Link a peer at `stranger`,
--     add a second link under a different handle naming the same identity at
--     `family`, and the ceiling that applies is whichever row Postgres hands
--     back first. That is the same defect `grantMatch.strictestOf` was written
--     to end for grants, and the same one `peer_links_owner_key_live_uniq`
--     already ends for signing keys.
--
-- ═══ WHY PER-OWNER AND NOT GLOBAL ═══
--
-- Scoped to the owner, exactly like `peer_links_owner_key_live_uniq` above it,
-- and for a reason that is specifically about SAFETY here rather than
-- convenience. `findActiveByPeerIdentity` is deliberately box-wide (an inbound
-- ask is addressed to the box, not to a member), so a GLOBAL unique index would
-- have two effects, both bad:
--
--   * it would let whichever household member binds an identity FIRST
--     permanently deny every other member the ability to link that same peer;
--   * and because a lone row is never ambiguous, that squatter's link would
--     SILENTLY become the box's responder for the peer, answering out of the
--     squatter's memory under the squatter's trust tier — instead of tripping
--     `resolveLink`'s "Ambiguous peer link" refusal.
--
-- Per-owner keeps the cross-owner collision REACHABLE, and therefore keeps it
-- failing closed at read time, which is the behaviour
-- `PeerLinkRevocation.integration.spec.ts` already pins. What it removes is the
-- one case an owner can create alone and can never diagnose.
--
-- ═══ WHY PARTIAL, THREE WAYS ═══
--
--   * `revoked_at IS NULL` — a revoked link and the link that replaces it must
--     coexist, or revocation would block re-linking the same peer.
--   * `IS NOT NULL` on both columns — an unbound link is the normal case and
--     any number of them may exist. (Postgres treats NULLs as distinct in a
--     unique index anyway; this is explicit so the index only spans rows the
--     inbound path can actually reach.)
--   * `<> ''` — `PortalTokenService.verifyClaims` returns null unless both
--     claims are non-empty, so a blank column can never be matched by a
--     verified token. `PeerLinkService.upsert` now refuses to write one, but
--     appliances may hold blank rows from earlier hand-written SQL, and this
--     index must not fail to build on them.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS peer_links_owner_identity_live_uniq
    ON ci.peer_links (owner_user_id, peer_issuer, peer_subject)
    WHERE peer_issuer IS NOT NULL AND peer_issuer <> ''
      AND peer_subject IS NOT NULL AND peer_subject <> ''
      AND revoked_at IS NULL;

COMMENT ON INDEX ci.peer_links_owner_identity_live_uniq IS
    'One live link per (owner, peer OIDC identity). findActiveByIssuerSubject is a findOne, so duplicates would let heap order pick the trust tier.';

-- migrate:down
DROP INDEX IF EXISTS ci.peer_links_owner_identity_live_uniq;
