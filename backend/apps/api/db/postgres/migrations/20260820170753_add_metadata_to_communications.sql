-- migrate:up
-- ci.events carries a metadata jsonb catch-all for whatever a parser sets
-- that has no dedicated column; ci.communications never got the same, so a
-- field like a tweet's permalink/likes/retweets/language/reply-parent had
-- nowhere to land and was silently dropped at push. Plain jsonb, no index,
-- mirroring ci.events.metadata exactly.
ALTER TABLE ci.communications
    ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';

-- migrate:down
ALTER TABLE ci.communications
    DROP COLUMN IF EXISTS metadata;
