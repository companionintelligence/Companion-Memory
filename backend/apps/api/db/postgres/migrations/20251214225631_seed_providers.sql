-- migrate:up
INSERT INTO ci.providers (id, name)
VALUES
  ('0198779b-182c-716e-9275-b81d99a47fdb', 'Google'),
  ('0198779b-3c33-73da-84e5-82e0df145260', 'Microsoft'),
  ('dbb8002f-12da-4cd9-b02b-37db7791a900', 'Facebook')
ON CONFLICT (id) DO NOTHING;

-- migrate:down
DELETE FROM ci.providers WHERE id IN (
  '0198779b-182c-716e-9275-b81d99a47fdb',
  '0198779b-3c33-73da-84e5-82e0df145260',
  'dbb8002f-12da-4cd9-b02b-37db7791a900'
);
