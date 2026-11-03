-- migrate:up
-- ---------------------------------------------------------------------------
-- ONE LIVE LINK PER (owner, handle), NOT ONE LINK.
--
-- Adding back a peer whose link the owner ended used to revive the ended row:
-- `PeerLinkService.upsert` keyed on (owner, handle), and this index allowed
-- only one row per pair. The revived row kept its signing key, the identity
-- bound to it and the asks exchanged over it, so the link the owner ended came
-- back with everything it had collected. A re-add now inserts a NEW row and the
-- ended one stays as it was, ended and readable. Two rows can then share a
-- handle, and only one of them can be live, which is what this index says.
--
-- Same shape as `peer_links_owner_identity_live_uniq` and
-- `peer_links_owner_key_live_uniq`: live means `revoked_at IS NULL`.
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS ci.peer_links_owner_handle_uniq;

CREATE UNIQUE INDEX peer_links_owner_handle_uniq
    ON ci.peer_links (owner_user_id, peer_handle)
    WHERE revoked_at IS NULL;

-- migrate:down
-- The full index refuses two rows under one handle. Every row but one keeps
-- its asks under a handle that names it as an older link, so nothing is
-- deleted. The one that keeps the real handle is the live link, or, when none
-- is live, the link ended last: the row `PeerLinkService` reads by handle.
WITH ranked AS (
    SELECT id,
           row_number() OVER (
               PARTITION BY owner_user_id, peer_handle
               ORDER BY (revoked_at IS NULL) DESC, revoked_at DESC NULLS LAST, created_at DESC, id DESC
           ) AS rank
      FROM ci.peer_links
)
UPDATE ci.peer_links older
   SET peer_handle = older.peer_handle || '~ended~' || older.id
  FROM ranked
 WHERE ranked.id = older.id
   AND ranked.rank > 1;

DROP INDEX IF EXISTS ci.peer_links_owner_handle_uniq;

CREATE UNIQUE INDEX peer_links_owner_handle_uniq ON ci.peer_links (owner_user_id, peer_handle);
