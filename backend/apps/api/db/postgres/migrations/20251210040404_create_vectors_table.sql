-- migrate:up
CREATE TABLE ci_search.vectors (
  id UUID PRIMARY KEY,

  entity_type TEXT,
  entity_id UUID,
  vector tsvector,

  user_id UUID,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (entity_type, entity_id)
);

-- migrate:down
DROP TABLE ci_search.vectors;
