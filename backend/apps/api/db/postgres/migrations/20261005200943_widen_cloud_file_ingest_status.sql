-- migrate:up

-- A third ledger state for archives. A cloud zip is only downloaded in full
-- when a specific importer recognises its file listing as an export it reads
-- (CloudFileIngestService.ingestDriveArchive). 'not_export' records that the
-- listing WAS checked at this revision and nothing claimed it, so the next
-- sync tick does not fetch and check the same listing again. Like 'failed',
-- it never means "bytes were staged".
ALTER TABLE ci_etl.cloud_file_ingests
    DROP CONSTRAINT cloud_file_ingests_status_check,
    ADD CONSTRAINT cloud_file_ingests_status_check
        CHECK (status IN ('downloaded', 'failed', 'not_export'));

-- migrate:down

-- The rows are a cache of a check that is cheap to repeat; dropping them only
-- means each archive's listing is looked at once more.
DELETE FROM ci_etl.cloud_file_ingests WHERE status = 'not_export';

ALTER TABLE ci_etl.cloud_file_ingests
    DROP CONSTRAINT cloud_file_ingests_status_check,
    ADD CONSTRAINT cloud_file_ingests_status_check
        CHECK (status IN ('downloaded', 'failed'));
