-- migrate:up

-- Where a run's bytes were fetched from, when a connection fetched them: a
-- file, a page of photos or an export folder that the Dropbox or Google Drive
-- sync downloaded and handed to the import pipeline ('dropbox',
-- 'google_drive'). NULL for everything a person uploaded or dropped in the
-- inbox themselves.
--
-- The importer that reads a loose file is the catch-all one, so without this
-- a photo that lives in Dropbox is ledgered as having arrived from "generic" —
-- and Dropbox never appears among a record's sources, however much was
-- imported from it. The push stamps this platform on what the catch-all
-- importer produces; a record a specific importer claims (a Facebook export
-- that happened to be stored in Dropbox) keeps its own.
ALTER TABLE ci_import.import_runs ADD COLUMN IF NOT EXISTS origin_platform text;

-- migrate:down
ALTER TABLE ci_import.import_runs DROP COLUMN IF EXISTS origin_platform;
