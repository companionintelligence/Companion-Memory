-- migrate:up

-- Reliable reminder delivery: a lease, bounded retries and a delivery receipt.
--
-- Until now a claim flipped `pending` straight to `fired` before anything was
-- sent, so a crash, a timeout or a push provider rejecting every endpoint
-- left a row that said `fired` for a reminder nobody received. The claim
-- (`claimDueReminders`) is still one atomic `UPDATE ... RETURNING` (see
-- 20260916030813_planning_reminders.sql for why that matters), but it now
-- writes a lease:
--
--   pending -> delivering (claimed_at, attempts + 1; a 10 minute lease)
--           -> delivered  (a push provider accepted it; fired_at is the receipt)
--           -> failed     (last_error; retried at next_attempt_at, backoff
--                          1, 2, 4, 8 minutes, at most 5 attempts in all)
--   delivering whose lease expired is reclaimable, so a dead worker delays a
--   reminder instead of losing it.
--
-- `fired` stays in the vocabulary for rows claimed before this migration:
-- their outcome is unknown and they are never re-sent. `scheduled` is a
-- `delivery_mode = 'device'` reminder that the phone has handed to its own OS
-- as a local notification; the server never pushes those.
ALTER TABLE ci.reminders DROP CONSTRAINT reminders_status_check;
ALTER TABLE ci.reminders ADD CONSTRAINT reminders_status_check
  CHECK (status IN ('pending', 'scheduled', 'delivering', 'delivered', 'failed', 'fired', 'cancelled'));
ALTER TABLE ci.reminders
  ADD COLUMN delivery_mode text NOT NULL DEFAULT 'push' CHECK (delivery_mode IN ('push', 'device')),
  ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  ADD COLUMN claimed_at timestamptz,
  ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN last_error text;

-- `PlanningJobsCron.enqueueFireReminders` asks once a minute which users have
-- a reminder ready for a push attempt (`listUsersWithDueReminders`): due and
-- pending, failed with attempts left, or delivering with an expired lease.
-- `reminders_due_idx` (20261105183657) covered `status = 'pending'` only, so
-- a query that also asked for retries and expired leases could not use it.
-- This index covers all three arms; failed rows that used every attempt stay
-- out of it, so exhausted failures do not pile up in the scan. The predicate
-- must stay implied by `dispatchableReminderSql` in ReminderDispatchService.ts
-- (one status per arm, the same literal attempt limit) or the planner cannot
-- use it. Nothing else reads `reminders_due_idx`, so it is dropped.
CREATE INDEX IF NOT EXISTS reminders_dispatch_due_idx
  ON ci.reminders (fire_at)
  WHERE delivery_mode = 'push'
    AND (status IN ('pending', 'delivering') OR (status = 'failed' AND attempts < 5));
DROP INDEX IF EXISTS ci.reminders_due_idx;

COMMENT ON TABLE ci.reminders IS
  'A due-time notification for a task or planned block. Claimed as a lease via one UPDATE ... RETURNING (pending/failed/expired delivering -> delivering); never SELECT-then-UPDATE. See docs/architecture/planning-roadmap.md M5.';

COMMENT ON COLUMN ci.reminders.status IS
  'pending | scheduled (device mode, handed to the phone OS) | delivering (10 minute lease) | delivered (push provider accepted) | failed (retryable up to 5 attempts) | fired (legacy, outcome unknown) | cancelled';

-- migrate:down

CREATE INDEX IF NOT EXISTS reminders_due_idx
  ON ci.reminders (fire_at)
  WHERE status = 'pending';
DROP INDEX IF EXISTS ci.reminders_dispatch_due_idx;
UPDATE ci.reminders SET status = CASE WHEN status = 'delivered' THEN 'fired' ELSE 'pending' END
  WHERE status IN ('scheduled', 'delivering', 'delivered', 'failed');
ALTER TABLE ci.reminders DROP CONSTRAINT reminders_status_check;
ALTER TABLE ci.reminders ADD CONSTRAINT reminders_status_check CHECK (status IN ('pending', 'fired', 'cancelled'));
ALTER TABLE ci.reminders DROP COLUMN delivery_mode, DROP COLUMN attempts, DROP COLUMN claimed_at,
  DROP COLUMN next_attempt_at, DROP COLUMN last_error;
COMMENT ON TABLE ci.reminders IS
  'A due-time notification for a task or planned block. Claimed fire-once via UPDATE ... WHERE status = ''pending'' AND fire_at <= now() RETURNING; never SELECT-then-UPDATE. See docs/architecture/planning-roadmap.md M5.';
COMMENT ON COLUMN ci.reminders.status IS
  'pending | fired | cancelled. ''snoozed'' from the CI-Planning source is dead vocabulary (never written there) and is not ported.';
