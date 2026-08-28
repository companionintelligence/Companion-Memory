-- migrate:up
-- `ci.users.role` already exists (20250925144200_enhance_users.sql: `TEXT NOT NULL DEFAULT 'user'`,
-- CHECK IN ('admin','user','readonly','api_only')) but is confirmed unused by any application
-- code today — no field on UserEntity, no @Roles/@RequireRole guard anywhere. This migration adds
-- NO schema change; it only activates the dormant column for the new AdminOnlyGuard (MCP server
-- config management) by ensuring a single-owner appliance already has an admin.
--
-- Without this, an existing appliance upgraded onto this release would find every user sitting at
-- the column's default 'user' — including whoever set the appliance up — and be locked out of the
-- new admin-only MCP settings with no in-app way to become admin.
--
-- Backfills the single EARLIEST-created, non-deleted user to role='admin', and ONLY if no admin
-- exists yet. Idempotent: re-running this on an appliance that already has an admin (self-promoted,
-- or from a previous run of this same migration) is a no-op.
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
    SELECT 1 FROM ci.users WHERE role = 'admin'
);

-- migrate:down
-- Deliberately no-op: this migration only backfills data onto a pre-existing column it does not
-- own, and reverting an admin promotion on down-migrate could lock the operator who ran `down` out
-- of the very admin-only features this exists to unlock.
