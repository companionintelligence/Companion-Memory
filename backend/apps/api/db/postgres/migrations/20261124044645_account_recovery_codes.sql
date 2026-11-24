-- migrate:up
CREATE TABLE ci.account_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
  user_id uuid NOT NULL REFERENCES ci.users(id) ON DELETE CASCADE,
  code_digest text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz
);
CREATE INDEX account_recovery_codes_user_idx ON ci.account_recovery_codes(user_id);
ALTER TABLE ci.users ADD COLUMN credentials_reset_at timestamptz;
COMMENT ON TABLE ci.account_recovery_codes IS
  'High entropy, SHA256-digested, single-use owner recovery codes. Plaintext is returned once at generation.';

-- migrate:down
DROP TABLE ci.account_recovery_codes;
ALTER TABLE ci.users DROP COLUMN credentials_reset_at;
