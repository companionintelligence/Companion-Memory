-- migrate:up
-- `delegated` — a task handed to an agent harness and still in flight.
--
-- #2558 added it to TASK_STATUSES, the GraphQL enum, the entity and the web
-- client, but to no migration, so `AgentDispatchService.dispatch` writes a
-- value `tasks_status_check` rejects and every Dispatch-with-a-task fails.
-- The order below mirrors TASK_STATUSES: proposed → open → in_progress →
-- delegated → done → skipped → archived.

ALTER TABLE ci.tasks
    DROP CONSTRAINT IF EXISTS tasks_status_check;

ALTER TABLE ci.tasks
    ADD CONSTRAINT tasks_status_check
        CHECK (status IN (
            'proposed', 'open', 'in_progress', 'delegated', 'done', 'skipped', 'archived'
        ));

-- migrate:down

ALTER TABLE ci.tasks
    DROP CONSTRAINT IF EXISTS tasks_status_check;

-- Retire rows that used the widened vocabulary BEFORE restoring the narrow
-- check, exactly as 20260818185920 does for 'proposed'. Without this the down
-- leg fails on any database where a task was ever dispatched, because ADD
-- CONSTRAINT validates the existing rows. `open` is the honest landing spot:
-- the delegation is no longer representable, so the work is back on the user.
UPDATE ci.tasks SET status = 'open' WHERE status = 'delegated';

ALTER TABLE ci.tasks
    ADD CONSTRAINT tasks_status_check
        CHECK (status IN ('proposed', 'open', 'in_progress', 'done', 'skipped', 'archived'));
