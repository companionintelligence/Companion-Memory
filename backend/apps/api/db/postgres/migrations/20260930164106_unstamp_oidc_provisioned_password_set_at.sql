-- migrate:up
-- Clears the `password_set_at` stamp that OIDC sign-ins put on the accounts they
-- created between 20260925190644 (#2743) and the fix that ships with this file.
--
-- ## The bug (fixed forward in the same change as this migration)
--
-- `OidcController.createOidcUser` creates the account for every native-app
-- first sign-in (the appliance's first account, or an invited one) and for a
-- web sign-in the Hub invited. It gave the account a random password, as every
-- OIDC path does, but did not pass `passwordChosenByUser: false` — so
-- `UserService.create` stamped `password_set_at` as though the user had chosen
-- it. `AccountController.requireReauth` asks for the current password wherever
-- that stamp exists, so these accounts are asked for a password nobody has
-- ever seen and can change neither their email nor their password.
-- `GET /account` reports `hasOwnPassword: true` for them as well.
--
-- ## Which rows
--
-- The two clauses below must BOTH hold; each exists to keep out a password
-- that somebody really did choose.
--
-- 1. A `sub` binding made as the account was created. Only a sign-in that
--    creates an account binds it with `sub`: the OIDC callback, confirm-account
--    and the Portal bearer path's first-account provisioning. An account that
--    already existed is bound with `email_link`, which is how an account that
--    signed up with a password of its own comes to have a federated identity
--    at all — including the ones older than #2743, which that migration
--    stamped with exactly `password_set_at = created_at`, and which therefore
--    look, by timestamps alone, just like the rows this repairs.
--
--    The bind follows the account's INSERT within a fraction of a second, so
--    it is looked for within a minute of `created_at` rather than at any time.
--
-- 2. A stamp taken as the row was inserted, not by a later password change.
--    `UserService.create` reads the clock just before the INSERT whose
--    transaction start becomes `created_at`, so its stamp lands AT or just
--    BEFORE `created_at` — a minute back allows for a slow wait on the
--    connection pool. (The one second allowed forward covers the API's clock
--    disagreeing with the database's: never on an appliance, where they are one
--    clock, but a dev stack's database runs in a VM.) A password the user set
--    afterwards (`changePassword`) needs a signed-in session on an account that
--    already exists, so it lands after `created_at`, by far more than that
--    second. The forward bound is what protects a federated account that DID
--    set its own password: the confirm-account and Portal paths create with no
--    stamp, and the recent-sign-in check lets such an account set one straight
--    away.
--
-- An account the callback created but could not bind (a userinfo with no
-- `sub`, which OIDC does not allow) is left stamped: with no federated
-- identity it is indistinguishable here from an account that signed up with a
-- password of its own, whose stamp must stay.
--
-- Idempotent: a cleared stamp is NULL and no longer matches.
UPDATE ci.users u
   SET password_set_at = NULL
 WHERE u.password_set_at IS NOT NULL
   AND u.password_set_at BETWEEN u.created_at - interval '1 minute'
                             AND u.created_at + interval '1 second'
   AND EXISTS (
         SELECT 1
           FROM ci.federated_identities f
          WHERE f.user_id = u.id
            AND f.bind_method = 'sub'
            AND f.created_at <= u.created_at + interval '1 minute'
       );

-- migrate:down
-- Deliberately no-op: the stamps cleared above recorded a choice the user never
-- made, and restoring them would lock those accounts out of changing their
-- email or password again.
