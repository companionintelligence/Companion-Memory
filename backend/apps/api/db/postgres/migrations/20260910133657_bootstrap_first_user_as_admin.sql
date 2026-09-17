-- migrate:up
-- Heals the appliances that 20260825233952 could not reach.
--
-- That migration promotes the earliest existing user to 'admin', and only when no admin exists.
-- On an UPGRADE it finds the owner. On a FRESH install it runs against an empty `ci.users`,
-- matches nothing, and the first signup then lands on the column default 'user' — so every
-- appliance installed fresh since that release has NO admin and, until this release, no in-app
-- way to mint one. `AdminOnlyGuard`'s routes (MCP server configuration, including the outbound
-- per-tool approval UI, and `GET /api/tools/invocations/system`) are 403 for everybody on those
-- boxes, and `ApplianceAdminGuard`'s routes (`/jobs` appliance-wide controls, `/signup-codes`)
-- are open to everybody.
--
-- Application code now claims the appliance for the first account at creation time
-- (`UserService.create` → `claimApplianceIfUnowned`), which fixes every appliance installed from
-- this release on. This migration is the other half: the boxes that already exist, whose first
-- account was created before that code did.
--
-- Same shape and same guarantees as 20260825233952 — earliest non-deleted user, only when no live
-- admin exists, idempotent — deliberately re-stated rather than shared, because a migration that
-- already ran cannot be re-run to pick up a fix.
--
-- One difference, and it is the reason this is not a verbatim copy: the `NOT EXISTS` probe here
-- is scoped to `deleted_at IS NULL`. 20260825233952's was not, so an appliance whose only admin
-- had since deleted their account looked "already promoted" to it and was skipped. That is the
-- same question `ApplianceAdminGuard.applianceHasAdmin()` asks, and the two must agree: an
-- appliance the guard treats as unclaimed must be one this promotion is willing to claim.
UPDATE ci.users
SET role = 'admin'
WHERE id = (
    SELECT id
    FROM ci.users
    WHERE deleted_at IS NULL
    ORDER BY created_at ASC, id ASC
    LIMIT 1
)
AND NOT EXISTS (
    SELECT 1 FROM ci.users WHERE role = 'admin' AND deleted_at IS NULL
);

-- migrate:down
-- Deliberately no-op, for the same reason as 20260825233952: this only backfills data onto a
-- column it does not own, and revoking an admin promotion on down-migrate could lock the operator
-- who ran `down` out of the admin-only features this exists to unlock.
