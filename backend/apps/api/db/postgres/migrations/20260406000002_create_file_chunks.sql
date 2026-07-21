-- migrate:up
CREATE TABLE IF NOT EXISTS ci.file_chunks (
  id uuid PRIMARY KEY,
  file_id uuid NOT NULL REFERENCES ci.files(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  chunk_index integer NOT NULL,
  content text NOT NULL,
  section_title text,
  source_locator jsonb,
  parser_name text NOT NULL,
  parser_version text NOT NULL,
  chunker_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (file_id, parser_version, chunker_version, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_file_chunks_file_id ON ci.file_chunks(file_id);
CREATE INDEX IF NOT EXISTS idx_file_chunks_user_id ON ci.file_chunks(user_id);

-- migrate:down
DROP TABLE IF EXISTS ci.file_chunks;
