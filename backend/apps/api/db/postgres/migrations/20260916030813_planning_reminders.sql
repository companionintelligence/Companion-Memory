-- migrate:up

-- ═══════════════════════════════════════════════════════════════════════════
-- M5 (reminders): where a due-time notification lives before it fires.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Companion Planning's `reminders` table (server/src/db/migrations/0044) is a
-- SQLite row drained once a minute by a claim-by-UPDATE dispatcher. The shape
-- ports; the dialect does not — see the deltas below. Full research trail:
-- docs/architecture/planning-roadmap.md (M5) and the recon at
-- scratchpad/recon/planning-reminders.md in the porting session that wrote
-- this migration.
--
-- ── The claim column is the load-bearing part ──────────────────────────────
--
-- `status` + `fired_at` exist so `RemindersCron`/`ReminderDispatchService` can
-- claim a due row with ONE `UPDATE ... WHERE status = 'pending' AND fire_at <=
-- now() ... RETURNING`. Postgres locks every row an UPDATE touches for the
-- life of the statement, so two overlapping claims (a redelivered pg-boss job
-- — pg-boss is at-least-once — or two ticks that overlap under load) can never
-- both flip the same row: the loser's WHERE re-evaluates against the winner's
-- committed 'fired' status and matches nothing. This is a property of the
-- STATEMENT, not of any lock taken in application code, and it must never be
-- reimplemented as SELECT-then-UPDATE.
--
-- ── Exactly one target ──────────────────────────────────────────────────────
--
-- `(task_id IS NULL) <> (block_id IS NULL)` — a reminder that names neither or
-- both is a data-integrity bug, not a valid state to render around. CI-Planning
-- enforces the identical CHECK on its `reminders` table.
--
-- ── Deltas from the CI-Planning source, and why ─────────────────────────────
--
-- * `user_id` (not `owner_id`), `REFERENCES ci.users(id) ON DELETE CASCADE`.
--   CI-Planning's `owner_id` FK carries no cascade at all; CASCADE here is a
--   deliberate improvement (a deleted user's reminders are meaningless), not
--   an oversight.
-- * `fire_at` / `fired_at` / `created_at` are real `timestamptz`, not TEXT.
--   CI-Planning's own in-repo Postgres experiment
--   (server/db/postgres/migrations/20260802000400_create_planning_baseline.sql)
--   kept every timestamp as bare TEXT with no `ci.users` FK at all — that is
--   not prior art for this table, it is the trap the recon flags explicitly.
-- * `block_id` references `ci.events(event_id)`, not a dedicated
--   `time_blocks` table — CI-Server has no such table. A "planned block" is a
--   `ci.events` row with `event_type = 'planned_block'`
--   (`PlannedBlockService`); this FK does not itself restrict `event_type`,
--   the same way CI-Planning's schema does not restrict `block_kind` for the
--   plain (non-Focus) reminder case either.
-- * `status`/`source` are CHECK-constrained. CI-Planning leaves both as
--   unconstrained TEXT; being explicit where SQLite was loose is the house
--   convention here (see `tasks_status_check`, `events_status_check`).
-- * `'snoozed'` is NOT in the status vocabulary. CI-Planning's own schema
--   comment declares it but `snoozeReminderChecked` never actually writes it
--   (it re-arms the row as `'pending'` with an advanced `fire_at`) — dead
--   vocabulary, not ported.
-- * `source` allows `'auto'` alongside `'manual'` so the column matches
--   CI-Planning's model, but nothing in this milestone WRITES `'auto'` yet:
--   the auto-derivation engine (`syncTaskReminders`, deriving reminders from a
--   task's due date and the owner's lead-time preferences) is a follow-up.
--   This milestone ships manual reminder creation plus the fire/deliver path.
--   Focus Ritual's three fixed-offset cue sources (`focus_start`/`focus_warn`/
--   `focus_end`) are out of scope entirely — deliberately not in the CHECK.
-- * No `lead_time` / `message` column. CI-Planning's `reminders` table has
--   neither: lead-time (minutes before an anchor) is an EPHEMERAL input the
--   (not-yet-ported) auto-derivation engine consumes to compute `fire_at` —
--   it is never stored per-row — and notification copy is composed at fire
--   time from the linked task/block title, never stored as a message.
CREATE TABLE IF NOT EXISTS ci.reminders (
    id         uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
    user_id    uuid        NOT NULL REFERENCES ci.users (id) ON DELETE CASCADE,

    -- Exactly one of the two — enforced below by reminders_exactly_one_target.
    task_id    uuid        REFERENCES ci.tasks (id) ON DELETE CASCADE,
    block_id   uuid        REFERENCES ci.events (event_id) ON DELETE CASCADE,

    fire_at    timestamptz NOT NULL,

    -- The claim state. 'fired' is terminal in practice: nothing re-arms a row
    -- back to 'pending' in this milestone (no snooze yet). 'cancelled' is a
    -- soft delete, same as CI-Planning's — the row survives so `fired_at`
    -- history and the CHECK-backed target are never destroyed by a UI click.
    status     text        NOT NULL DEFAULT 'pending',
    fired_at   timestamptz,

    -- 'auto' is reserved for the not-yet-built derivation engine; see above.
    source     text        NOT NULL DEFAULT 'manual',

    created_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT reminders_exactly_one_target CHECK ((task_id IS NULL) <> (block_id IS NULL)),
    CONSTRAINT reminders_status_check CHECK (status IN ('pending', 'fired', 'cancelled')),
    CONSTRAINT reminders_source_check CHECK (source IN ('manual', 'auto'))
);

-- The dispatcher's claim query is `WHERE user_id = ? AND status = 'pending' AND
-- fire_at <= now()` (fanned out per user, matching PlanningJobsCron's other
-- five jobs) — this is that predicate, in index order.
CREATE INDEX IF NOT EXISTS idx_reminders_user_due ON ci.reminders (user_id, status, fire_at);

COMMENT ON TABLE ci.reminders IS
  'A due-time notification for a task or planned block. Claimed fire-once via UPDATE ... WHERE status = ''pending'' AND fire_at <= now() RETURNING; never SELECT-then-UPDATE. See docs/architecture/planning-roadmap.md M5.';

COMMENT ON COLUMN ci.reminders.status IS
  'pending | fired | cancelled. ''snoozed'' from the CI-Planning source is dead vocabulary (never written there) and is not ported.';

COMMENT ON COLUMN ci.reminders.source IS
  'manual | auto. ''auto'' is reserved for a not-yet-built due-date derivation engine; this milestone only writes ''manual''. Focus Ritual cue sources are out of scope.';

-- ═══════════════════════════════════════════════════════════════════════════
-- Browser Web Push subscriptions — NOT the same thing as ci.devices.push_token.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `ci.devices.push_token` (see DeviceEntity/DeviceService) stores a native
-- APNs/FCM token and optionally relays it to a Portal-side push service —
-- the appliance is deliberately never trusted with the third-party signing
-- secret that would let it call APNs/FCM itself
-- (`configuration.ts`'s `auth.portal.pushRelayUrl` comment). A browser
-- `PushSubscription` (`endpoint` + `keys.p256dh` + `keys.auth`) is a
-- structurally different credential: it is signed with a VAPID keypair this
-- appliance generates and owns itself, so — unlike native push — there is no
-- third-party secret this table would need to hold. See `configuration.ts`'s
-- `push.vapid` block for where that keypair lives and why.
--
-- One row per browser endpoint (roughly per-device-per-browser-per-origin),
-- not per user — matching CI-Planning's `push_subscriptions`. `endpoint` is
-- globally unique because the Push API mints it that way; re-subscribing an
-- already-registered endpoint under a different user is handled by the
-- service layer's upsert (ON CONFLICT (endpoint) DO UPDATE user_id), the same
-- "newest subscriber owns this browser slot" policy CI-Planning ships.
CREATE TABLE IF NOT EXISTS ci.push_subscriptions (
    id         uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
    user_id    uuid        NOT NULL REFERENCES ci.users (id) ON DELETE CASCADE,
    endpoint   text        NOT NULL UNIQUE,
    p256dh     text        NOT NULL,
    auth       text        NOT NULL,
    user_agent text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON ci.push_subscriptions (user_id);

COMMENT ON TABLE ci.push_subscriptions IS
  'Browser Web Push endpoints (VAPID), one row per subscribed browser. Pruned automatically on a 404/410 send result -- see WebPushService. Distinct from ci.devices.push_token (native APNs/FCM).';

-- migrate:down

DROP TABLE IF EXISTS ci.push_subscriptions;
DROP TABLE IF EXISTS ci.reminders;
