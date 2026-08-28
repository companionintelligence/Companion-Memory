-- migrate:up
-- CloudFileIngestService starts one ci_import.import_runs row per downloaded
-- Drive document via ImportRunService.startRun({ source: 'connections' }) —
-- the same staging contract ImportPathTool/ImportInboxTool use with 'mcp',
-- and ImportInboxController/ImportRunsController use with 'api'. A run
-- started by a background ETL sync tick is neither: nobody typed a path,
-- called the MCP tool, or hit the REST endpoint, and mislabeling it 'api'
-- would make every future "who/what started this run" query lie about syncs
-- run unattended by SyncOrchestrator's cron. Widening the CHECK is required
-- before that startRun call can succeed against this table — see
-- ImportRunEntity.ts's ImportRunSource type, updated alongside this.
ALTER TABLE ci_import.import_runs
    DROP CONSTRAINT import_runs_source_check,
    ADD CONSTRAINT import_runs_source_check
        CHECK (source IN ('wizard', 'api', 'mcp', 'connections'));

-- migrate:down
ALTER TABLE ci_import.import_runs
    DROP CONSTRAINT import_runs_source_check,
    ADD CONSTRAINT import_runs_source_check
        CHECK (source IN ('wizard', 'api', 'mcp'));
