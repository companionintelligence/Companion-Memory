-- migrate:up
-- ---------------------------------------------------------------------------
-- AN ENDED LINK IS ENDED BY `revoked_at`, EVERYWHERE.
--
-- Before #3062 an `updatePeerLink` edit wrote `revoked_at = NULL` on an ended
-- link and left `status = 'revoked'`. `peer_links_owner_handle_uniq` (live
-- means `revoked_at IS NULL`) and `PeerLinkService` both read such a row as
-- live, so adding that peer back revived it with its signing key, the identity
-- bound to it and its grants, instead of making a new link. Stamping those rows
-- with the last time they changed makes them ended for the index and the code
-- alike.
--
-- A separate migration rather than an edit to `20261029131708`, which may
-- already have run.
-- ---------------------------------------------------------------------------
UPDATE ci.peer_links
   SET revoked_at = updated_at
 WHERE status = 'revoked'
   AND revoked_at IS NULL;

-- migrate:down
-- No-op: these links were ended by their owner, and code from before this
-- migration reads a stamped `revoked_at` as ended too.
