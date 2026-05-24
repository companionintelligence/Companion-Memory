-- migrate:up

CREATE TABLE ci_search.tags (
  id UUID NOT NULL,
  label text NOT NULL,
  description text,
  user_id UUID NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,

  CONSTRAINT tags_pkey PRIMARY KEY (id),
  CONSTRAINT tags_label_user_key UNIQUE (label, user_id)
);

CREATE TABLE ci_search.entity_tag (
  id BIGINT NOT NULL GENERATED ALWAYS AS IDENTITY,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  tag_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT entity_tag_pkey PRIMARY KEY (id),
  CONSTRAINT entity_tag_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES ci_search.tags(id),
  CONSTRAINT entity_tag_unique_entry UNIQUE (entity_type, entity_id, tag_id)
);

-- migrate:down

DROP TABLE IF EXISTS ci_search.entity_tag;
DROP TABLE IF EXISTS ci_search.tags;
