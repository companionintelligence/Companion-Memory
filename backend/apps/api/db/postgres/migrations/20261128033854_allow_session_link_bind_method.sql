-- migrate:up
-- A third way an OIDC identity comes to be bound to an account: `session_link`, made by
-- the person signed in to that account, who proved it with their password and then
-- signed in to the Portal from Settings ("Connect Companion account"). `sub` is a
-- binding made by the Portal sign-in that created the account, and `email_link` one
-- made by matching a proven address; neither describes this, and
-- 20260930164106_unstamp_oidc_provisioned_password_set_at reads `sub` as "created by
-- a Portal sign-in". Needed once the first account's typed address stopped counting
-- as proven: an owner who set up with a password links their Portal sign-in this way.
ALTER TABLE ci.federated_identities
    DROP CONSTRAINT federated_identities_bind_method_check;

ALTER TABLE ci.federated_identities
    ADD CONSTRAINT federated_identities_bind_method_check
    CHECK (bind_method IN ('sub', 'email_link', 'session_link'));

-- migrate:down
-- A `session_link` row has no older meaning; drop those bindings rather than relabel
-- them as something they were not. Their people sign in with their password again.
DELETE FROM ci.federated_identities WHERE bind_method = 'session_link';

ALTER TABLE ci.federated_identities
    DROP CONSTRAINT federated_identities_bind_method_check;

ALTER TABLE ci.federated_identities
    ADD CONSTRAINT federated_identities_bind_method_check
    CHECK (bind_method IN ('sub', 'email_link'));
