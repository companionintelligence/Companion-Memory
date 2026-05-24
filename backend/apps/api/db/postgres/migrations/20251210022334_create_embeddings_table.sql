-- migrate:up
CREATE TABLE ci_search.embeddings (
  id UUID PRIMARY KEY,

  entity_type TEXT,
  entity_id UUID,
  embedding VECTOR (768),

  user_id UUID,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (entity_type, entity_id)
);

-- migrate:down
DROP TABLE ci_search.embeddings;
