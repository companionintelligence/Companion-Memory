-- migrate:up
CREATE TABLE ci.notes (
  id UUID NOT NULL,

  title TEXT,
  content TEXT,

  user_id UUID NOT NULL REFERENCES ci.users(id),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT notes_pkey PRIMARY KEY (id)
);

-- migrate:down
DROP TABLE ci.notes;
