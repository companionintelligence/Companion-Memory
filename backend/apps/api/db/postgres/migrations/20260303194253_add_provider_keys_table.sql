-- migrate:up
CREATE TABLE ci.provider_keys (
  id UUID PRIMARY KEY DEFAULT ci.gen_uuid_v7(),
  provider_id UUID NOT NULL,
  client_id TEXT NOT NULL,
  client_secret TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES ci.users(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- migrate:down
DROP TABLE ci.provider_keys;
