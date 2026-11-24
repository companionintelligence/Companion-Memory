-- migrate:up

-- Files a Google Drive (or Dropbox) sync downloaded BEFORE import runs
-- recorded where their bytes came from (origin_platform, 20261005230949;
-- origin_connection_id, 20261005231545) are in the library as if a person had
-- dropped them in a folder: the catch-all importer read them, so the
-- provenance ledger says they arrived from "generic", and nothing links them
-- to the connection that fetched them. Two things follow on every install
-- that synced a drive before then:
--
--   * Google Drive never appears under How, however much was imported from
--     it — the picker lists the platforms the ledger names;
--   * disconnecting the drive leaves all of it behind, because the purge
--     finds a connection's records by their connection_id.
--
-- The sync will not repair this on its own: ci_etl.cloud_file_ingests holds
-- each file's revision, and an unchanged file is never fetched again.
--
-- That same table is what makes the repair exact. Every row names the import
-- run a download was handed to, and a run the drive sync started holds
-- nothing but what that connection fetched. So this writes, for those older
-- runs, what the push writes today (import/push/canonical.ts `withOrigin`):
-- the drive as the platform of what the catch-all importer produced, and the
-- connection on the run, its ledger rows and the records it created.
--
-- Scoped to runs with no origin yet, so nothing a current import wrote is
-- touched and applying it twice changes nothing. Downloads whose connection
-- has since been removed are left alone: their records stayed behind as
-- plain files by that disconnect, and there is no connection to link.
CREATE TEMP TABLE drive_fetched_files ON COMMIT DROP AS
SELECT i.user_id, i.connection_id, i.provider, i.import_run_id, i.content_sha256, r.created_at AS run_created_at
  FROM ci_etl.cloud_file_ingests i
  JOIN ci.connections c ON c.id = i.connection_id
  JOIN ci_import.import_runs r ON r.id = i.import_run_id
 WHERE i.status = 'downloaded'
   AND r.origin_platform IS NULL
   AND r.origin_connection_id IS NULL;

-- One row per run: a page of photos is many downloads handed to one run.
CREATE TEMP TABLE drive_fetched_runs ON COMMIT DROP AS
SELECT DISTINCT import_run_id, user_id, connection_id, provider, run_created_at
  FROM drive_fetched_files;

-- ---------------------------------------------------------------------------
-- 1. The ledger rows those runs wrote.
--
-- A "generic" arrival whose identity the drive is ALREADY ledgered under (the
-- same bytes fetched again since) is the older spelling of that same arrival.
-- It goes rather than being renamed onto its twin, which the identity index
-- would refuse — and left in place it would read as a second, non-drive
-- source and keep the record through a disconnect.
-- ---------------------------------------------------------------------------
DELETE FROM ci.record_sources stale
 USING drive_fetched_runs d
 WHERE stale.user_id = d.user_id
   AND stale.import_run_id = d.import_run_id
   AND stale.record_table IN ('content', 'events')
   AND stale.platform = 'generic'
   AND EXISTS (SELECT 1 FROM ci.record_sources twin
                WHERE twin.user_id = stale.user_id
                  AND twin.record_table = stale.record_table
                  AND twin.source_type = stale.source_type
                  AND twin.source_system = stale.source_system
                  AND twin.source_id = stale.source_id
                  AND twin.platform = d.provider);

-- The platform changes only where the catch-all importer named itself: a
-- record a specific importer claimed (a Takeout archive that was stored in
-- Drive) already names its platform, and that one is the truth. The
-- connection applies to every content and event row of the run.
UPDATE ci.record_sources rs
   SET platform = CASE WHEN rs.platform = 'generic' THEN d.provider ELSE rs.platform END,
       connection_id = COALESCE(rs.connection_id, d.connection_id)
  FROM drive_fetched_runs d
 WHERE rs.user_id = d.user_id
   AND rs.import_run_id = d.import_run_id
   AND rs.record_table IN ('content', 'events')
   AND (rs.platform = 'generic' OR rs.connection_id IS NULL);

-- ---------------------------------------------------------------------------
-- 2. Downloads that were already in the library.
--
-- A file the drive delivered that an upload had delivered first was a
-- duplicate to the push: same identity, same "generic" platform, so no ledger
-- row was written for the run at all and step 1 has nothing to rename. The
-- drive is still a second place the file arrived from, and today's push
-- ledgers it as one. A file's content row is keyed by the hash of its bytes
-- (docs/design/cross-pipeline-identity.md §3.2), which the download recorded.
-- ---------------------------------------------------------------------------
INSERT INTO ci.record_sources
  (user_id, record_table, record_id, source_type, source_system, source_id, connection_id, import_run_id, platform)
SELECT c.user_id, 'content', c.id, 'ci-import-tools', c.source_system, c.source_id,
       f.connection_id, f.import_run_id, f.provider
  FROM drive_fetched_files f
  JOIN ci.content c
    ON c.user_id = f.user_id
   AND c.source_system = 'file'
   AND c.source_id = 'sha256:' || f.content_sha256
 WHERE f.content_sha256 IS NOT NULL
ON CONFLICT (user_id, record_table, source_type, source_system, source_id, platform) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. The records themselves.
--
-- Only the ones a run CREATED, which is what the push links: a record that
-- was already there when the drive delivered it again (step 2) belongs to
-- whatever brought it first, and must not leave with the drive. Created
-- after the run began is that test — a row that predates its run was found,
-- not written. Communications are left out: they carry no creation time to
-- test, the catch-all importer writes none, and unlinked they simply stay
-- through a disconnect, as they do now.
-- ---------------------------------------------------------------------------
UPDATE ci.content c
   SET connection_id = d.connection_id
  FROM drive_fetched_runs d
  JOIN ci.record_sources rs
    ON rs.user_id = d.user_id AND rs.import_run_id = d.import_run_id AND rs.record_table = 'content'
 WHERE c.id = rs.record_id
   AND c.user_id = d.user_id
   AND c.connection_id IS NULL
   AND c.created_at >= d.run_created_at;

UPDATE ci.events e
   SET connection_id = d.connection_id
  FROM drive_fetched_runs d
  JOIN ci.record_sources rs
    ON rs.user_id = d.user_id AND rs.import_run_id = d.import_run_id AND rs.record_table = 'events'
 WHERE e.event_id = rs.record_id
   AND e.user_id = d.user_id
   AND e.connection_id IS NULL
   AND e.created_at >= d.run_created_at;

-- ---------------------------------------------------------------------------
-- 4. The runs, last: their missing origin is what scoped everything above.
-- ---------------------------------------------------------------------------
UPDATE ci_import.import_runs r
   SET origin_platform = d.provider,
       origin_connection_id = d.connection_id
  FROM drive_fetched_runs d
 WHERE r.id = d.import_run_id;

-- ## Verify after applying
--
-- Should be 0 — no run a live connection's download was handed to is left
-- without its origin:
--   SELECT count(DISTINCT r.id)
--     FROM ci_etl.cloud_file_ingests i
--     JOIN ci.connections c ON c.id = i.connection_id
--     JOIN ci_import.import_runs r ON r.id = i.import_run_id
--    WHERE i.status = 'downloaded' AND r.origin_platform IS NULL;
--
-- Should be 0 — none of those runs still has a "generic" arrival:
--   SELECT count(*)
--     FROM ci.record_sources rs
--    WHERE rs.platform = 'generic'
--      AND rs.record_table IN ('content', 'events')
--      AND rs.import_run_id IN (SELECT i.import_run_id
--                                 FROM ci_etl.cloud_file_ingests i
--                                 JOIN ci.connections c ON c.id = i.connection_id
--                                WHERE i.status = 'downloaded');
--
-- What each drive now accounts for (the How picker offers these platforms):
--   SELECT platform, record_table, count(*) FROM ci.record_sources
--    WHERE platform IN ('google_drive', 'dropbox') GROUP BY 1, 2 ORDER BY 1, 2;

-- migrate:down
-- Not reversible, and deliberately a no-op.
--
-- Nothing records which rows this relabelled versus which a current import
-- wrote that way to begin with, so an undo could only guess — and what it
-- would restore is the wrong answer: drive files ledgered as "generic" and
-- cut off from the connection that fetched them. Rolling back the columns
-- themselves is the business of 20261005230949 and 20261005231545.
SELECT 1;
