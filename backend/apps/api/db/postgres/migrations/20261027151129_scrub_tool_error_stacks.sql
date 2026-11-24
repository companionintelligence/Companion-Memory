-- migrate:up

-- Remove the server's stack traces from stored tool results.
--
-- Before #3113, a failing tool's `ToolError` carried `details.stack`: the
-- server's file paths and the packages it runs. A confirmed action stores its
-- whole `ToolResult` in `ci.pending_actions.result` (`markExecuted`), and
-- `GET /pending-actions` returns resolved rows, which are kept for 365 days
-- (PENDING_ACTION_RETENTION_DAYS). So every action that failed before the
-- upgrade kept serving its stack for a year. New results no longer carry one;
-- this takes it out of the old ones. The rest of each result (the code, the
-- message, the error's name) stays.
UPDATE ci.pending_actions
   SET result = result #- '{error,details,stack}'
 WHERE result #> '{error,details,stack}' IS NOT NULL;

-- migrate:down
-- No-op: the stacks were never meant to be stored, and the log of each failed
-- run still has them.
