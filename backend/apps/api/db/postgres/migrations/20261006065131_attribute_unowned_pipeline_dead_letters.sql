-- Give every dead letter that names its user in its payload that user.
--
-- Until this release two writers left `user_id` NULL on letters that belong to
-- somebody. `PipelineStateService.recordDeadLetter` never wrote the column, so
-- every `pipeline.slice` failure was NULL although the slice payload always
-- carries `userId`. And the reaper read only `data->>'userId'`, so the graph and
-- chat events, which name their user `ownerId`, were NULL too.
--
-- NULL used to mean "show to everyone": the Jobs page listed, and both replay
-- routes claimed, every NULL letter for every signed-in account. The list and
-- replay now show a NULL letter to the appliance admin only, so without this
-- backfill a household member would lose sight of their own old failures, and
-- the admin would keep seeing payloads that belong to other people.
--
-- The rule matches the reaper's INSERT: `userId` first, then `ownerId`, each
-- cast only when it is a uuid on its own, so one malformed payload cannot abort
-- the statement. Rows that name no user stay NULL. Rows that already have a
-- `user_id` are not touched.
--
-- One UPDATE over the NULL rows. The table holds failures only, and on a healthy
-- appliance it is small, so this runs inside dbmate's transaction like the other
-- dead-letter migrations rather than out of band.

-- migrate:up
UPDATE ci.pipeline_dead_letters
   SET user_id = COALESCE(
         CASE
           WHEN payload->>'userId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           THEN (payload->>'userId')::uuid
         END,
         CASE
           WHEN payload->>'ownerId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           THEN (payload->>'ownerId')::uuid
         END
       )
 WHERE user_id IS NULL
   AND (payload->>'userId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR payload->>'ownerId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

COMMENT ON COLUMN ci.pipeline_dead_letters.user_id IS
  'Owning user, read from the failed job payload (userId, else ownerId). NULL only when the payload names no user; NULL letters are listed and replayable by the appliance admin alone. Present so domains/portability discovers this table for export and erasure.';

-- migrate:down
-- The data half is a no-op: a backfilled row cannot be told apart from one the
-- writers attributed themselves, and putting NULL back would hand those payloads
-- to every account again. Only the column comment is restored.
COMMENT ON COLUMN ci.pipeline_dead_letters.user_id IS
  'Owning user, read from the failed job payload. Nullable: system jobs have no user. Present so domains/portability discovers this table for export and erasure.';
