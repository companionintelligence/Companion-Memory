-- migrate:up

ALTER TABLE ci.documents DROP CONSTRAINT IF EXISTS documents_file_fk;
ALTER TABLE ci.message_files DROP CONSTRAINT IF EXISTS message_files_file_id_fkey;
ALTER TABLE ci.voice_recordings DROP CONSTRAINT IF EXISTS voice_recordings_file_fk;
ALTER TABLE ci.files DROP CONSTRAINT IF EXISTS files_parent_id_fkey;
ALTER TABLE ci.files DROP CONSTRAINT IF EXISTS files_user_id_fkey;

DROP TABLE ci.files;

CREATE TABLE ci.files (
  id uuid PRIMARY KEY DEFAULT ci.gen_uuid_v7(),

  filename text,
  content_type text NOT NULL,
  size bigint,
  width integer,
  height integer,

  variant varchar(50) DEFAULT 'ORIGINAL' NOT NULL,
  title text,
  description text,

  bucket text,
  key uuid,
  hash text,

  external_id text,
  parent_id uuid,
  user_id uuid,

  external_created_at timestamptz,
  external_updated_at timestamptz,

  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  deleted_at timestamptz
);

ALTER TABLE ci.files
  ADD CONSTRAINT files_user_id_fkey FOREIGN KEY (user_id) REFERENCES ci.users(id) ON DELETE CASCADE;

ALTER TABLE ci.files
  ADD CONSTRAINT files_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES ci.files(id) ON DELETE CASCADE;

ALTER TABLE ci.message_files
  ADD CONSTRAINT message_files_file_id_fkey FOREIGN KEY (file_id) REFERENCES ci.files(id) ON DELETE CASCADE;

CREATE INDEX files_user_id_idx ON ci.files (user_id);
CREATE INDEX files_hash_idx ON ci.files (hash) WHERE hash IS NOT NULL;
CREATE INDEX files_external_id_idx ON ci.files (external_id) WHERE external_id IS NOT NULL;
CREATE INDEX files_parent_id_idx ON ci.files (parent_id) WHERE parent_id IS NOT NULL;

-- migrate:down
