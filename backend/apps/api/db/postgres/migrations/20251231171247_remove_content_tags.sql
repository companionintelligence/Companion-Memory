-- migrate:up
DROP TABLE ci.content_tag;

-- migrate:down
CREATE TABLE content_tag (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  content_id UUID REFERENCES content(id) NOT NULL,
  tag_id UUID REFERENCES tags(id) NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
