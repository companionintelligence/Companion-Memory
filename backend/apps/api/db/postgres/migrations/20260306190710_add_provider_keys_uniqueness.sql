-- migrate:up
ALTER TABLE ci.provider_keys ADD CONSTRAINT provider_keys_provider_id_user_id_unique UNIQUE (provider_id, user_id);
ALTER TABLE ci.provider_keys ADD CONSTRAINT provider_keys_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES ci.providers(id);

-- migrate:down
ALTER TABLE ci.provider_keys DROP CONSTRAINT provider_keys_provider_id_fkey;
ALTER TABLE ci.provider_keys DROP CONSTRAINT provider_keys_provider_id_user_id_unique;
