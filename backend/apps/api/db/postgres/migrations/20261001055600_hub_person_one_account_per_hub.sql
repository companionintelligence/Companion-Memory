-- migrate:up
-- One Memory account belongs to at most one person of a given Hub.
--
-- The Hub forward-auth bridge now links a Hub person to the Memory account they
-- use, as a `ci.federated_identities` row keyed on (issuer =
-- 'urn:ci-hub:<directory>', subject = the person's Hub public id), so that a
-- rename on either side no longer moves them into a fresh, empty account
-- (CI-Engineering architecture/identity/hub-memory-account-link.md). Until now
-- the bridge found the account by email alone.
--
-- A Hub person who arrives unlinked adopts the account their Hub username
-- names — unless another person of the same Hub already holds it. That is the
-- takeover a reused username would otherwise be: A renames away from x@, the
-- Hub later gives x@ to B, and B must not inherit A's memories.
-- `HubForwardAuthBridgeService` refuses it; this index is the same rule where
-- no race and no operator script can get past it.
--
-- Per issuer, not per account: the issuer is a Hub user directory that lives
-- and dies with the Hub's database. A Memory restored onto a fresh Hub keeps
-- its links into a directory that no longer signs anything, and the new Hub's
-- people must still be able to adopt their accounts, each gaining a second,
-- live link.
--
-- No existing row can violate it: nothing wrote a 'urn:ci-hub:' issuer before
-- this change. OIDC issuers are https URLs and never match the predicate.
CREATE UNIQUE INDEX federated_identities_hub_person_per_account_uniq
    ON ci.federated_identities (user_id, issuer)
    WHERE issuer LIKE 'urn:ci-hub:%';

-- migrate:down
DROP INDEX IF EXISTS ci.federated_identities_hub_person_per_account_uniq;
