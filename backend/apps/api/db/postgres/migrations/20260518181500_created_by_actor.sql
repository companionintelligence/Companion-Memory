-- migrate:up

-- Plan 10 §3.2 — every write carries created_by_actor so authorship is
-- visible to audit ("Claude Code wrote this" vs "I wrote this"). The
-- column is additive and nullable for back-compat; writer services
-- populate it from RequestContext.actorId. Read-time access filtering
-- (actorCanReadUser) is a separate, larger change.

ALTER TABLE ci.entities ADD COLUMN created_by_actor UUID REFERENCES ci.actors(id) ON DELETE SET NULL;
ALTER TABLE ci.relationships ADD COLUMN created_by_actor UUID REFERENCES ci.actors(id) ON DELETE SET NULL;
ALTER TABLE ci.messages ADD COLUMN created_by_actor UUID REFERENCES ci.actors(id) ON DELETE SET NULL;

CREATE INDEX idx_entities_created_by_actor ON ci.entities(created_by_actor) WHERE created_by_actor IS NOT NULL;
CREATE INDEX idx_relationships_created_by_actor ON ci.relationships(created_by_actor) WHERE created_by_actor IS NOT NULL;
CREATE INDEX idx_messages_created_by_actor ON ci.messages(created_by_actor) WHERE created_by_actor IS NOT NULL;

-- migrate:down

DROP INDEX IF EXISTS ci.idx_messages_created_by_actor;
DROP INDEX IF EXISTS ci.idx_relationships_created_by_actor;
DROP INDEX IF EXISTS ci.idx_entities_created_by_actor;

ALTER TABLE ci.messages DROP COLUMN IF EXISTS created_by_actor;
ALTER TABLE ci.relationships DROP COLUMN IF EXISTS created_by_actor;
ALTER TABLE ci.entities DROP COLUMN IF EXISTS created_by_actor;
