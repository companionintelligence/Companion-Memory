-- migrate:up
-- The download ledger for GoogleDriveTransformService's document branch (and,
-- shaped to be reused by, a future Dropbox/OneDrive equivalent — hence
-- `provider` rather than a Drive-only table name).
--
-- Before this migration, TransformGoogleDrive.ts never fetched a Drive
-- document's actual bytes: it stored the file's `webViewLink` as
-- `ci.files.external_id`, which forces `FileService.create` to leave
-- `bucket`/`key` NULL (see FileService.create: `bucket = file.externalId ?
-- null : config.staticfiles.bucket`), and it wrote the literal string
-- `Google Drive document: ${fileName}` into `ci.content.text` — a label, not
-- the document. This ledger is what lets the real download path added
-- alongside it (CloudFileIngestService) skip re-downloading a file whose
-- content has not changed since the last successful sync, the same way
-- `ci_etl.connection_sync_jobs.next_cursor` lets a Drive LIST sync skip
-- unchanged pages — but pages have no per-item pointer, so this is a new
-- table rather than a column added to that one.
--
-- One row per (connection, provider file id): a sync tick upserts it, keyed
-- on `revision` — Drive's own `modifiedTime` string for the file, requested
-- by SyncDrive.ts's existing `fields` list, so no sync-side change is needed
-- to read it. `revision` is intentionally NOT parsed as a timestamp: for a
-- second provider it may be an opaque etag, and string equality is all a
-- skip check needs.
CREATE TABLE IF NOT EXISTS ci_etl.cloud_file_ingests (
    id                uuid PRIMARY KEY DEFAULT ci.gen_uuid_v7(),

    -- Not FKs: connection_sync_jobs (this schema's existing table) takes the
    -- same stance on user_id/connection_id — "keep NOT NULL for
    -- security/filtering" — and this table follows it for consistency rather
    -- than introducing the first cross-schema FK in ci_etl.
    user_id           uuid NOT NULL,
    connection_id     uuid NOT NULL,

    -- 'google_drive' today; a Dropbox/OneDrive equivalent would add its own
    -- value rather than its own table, since every column below already
    -- generalizes (provider file id, an opaque revision string, a hash of
    -- what was actually staged).
    provider          text NOT NULL,

    -- The file id AT THE PROVIDER (Google Drive's `id`), never the ci.files
    -- row this ingest may eventually produce — see the identical caution in
    -- TransformGoogleDrive.ts about external_id vs. ci.files' generated uuid.
    external_file_id  text NOT NULL,

    -- The provider's change signal at the time of the last successful
    -- download. A re-sync compares the file's CURRENT revision against this
    -- before downloading anything; equal means "already have it".
    revision          text NOT NULL,

    -- sha256 of the bytes actually written to the staged upload, filled in
    -- once the download succeeds. Not part of the skip check (revision alone
    -- decides that, before any bytes are fetched) — this is for a future
    -- integrity audit ("did the staged copy match what we recorded"), not for
    -- dedup, which ci.files.hash already owns downstream.
    content_sha256    text,
    byte_size         bigint,

    -- 'downloaded': the bytes reached the uploads dir and a run was started
    -- for them. 'failed': every attempt in the download-with-retry loop
    -- failed; the row still updates (revision, attempt_count, last_error) so
    -- the failure is visible and the NEXT sync tick retries automatically —
    -- a 'failed' row never satisfies the skip check above.
    status            text NOT NULL DEFAULT 'downloaded'
                        CHECK (status IN ('downloaded', 'failed')),

    -- The staged upload and import run this download became, when
    -- successful. Deliberately not a real FK to ci_import.import_runs: a run
    -- can be deleted by ImportRetentionService (see ci_import's own
    -- migration) long after this ledger row's job — remembering "we already
    -- have this revision" — is done, and CASCADE would force this row to
    -- disappear along with the run it has nothing left to say about, while
    -- SET NULL would erase the very audit trail this column exists for.
    drop_id           uuid,
    import_run_id     uuid,

    -- In-request retry count from the download-with-retry loop (see
    -- CloudFileIngestService) for the MOST RECENT attempt, not a lifetime
    -- total — a file that fails, succeeds next sync, then fails again should
    -- read as "this failure took N tries", not accumulate across syncs.
    attempt_count     integer NOT NULL DEFAULT 1,
    last_error        text,

    downloaded_at     timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),

    -- One ledger row per file per connection; the service upserts on this.
    UNIQUE (connection_id, external_file_id)
);

-- The only read shape today: "what do we already have for this connection's
-- file X", by the unique pair above (which already has a supporting index via
-- the UNIQUE constraint). A user-scoped listing index is added here too since
-- an operator's first question about a stuck sync is almost always "what has
-- this USER downloaded", not "what has this connection downloaded".
CREATE INDEX IF NOT EXISTS cloud_file_ingests_user_provider_idx
    ON ci_etl.cloud_file_ingests (user_id, provider);

-- migrate:down
DROP TABLE IF EXISTS ci_etl.cloud_file_ingests;
