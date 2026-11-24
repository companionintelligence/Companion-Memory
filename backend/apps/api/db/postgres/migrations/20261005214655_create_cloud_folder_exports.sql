-- migrate:up

-- A data export that sits in a cloud drive as a FOLDER of loose files rather
-- than one archive. Meta's "transfer a copy of your information" writes
-- Facebook exports to Dropbox this way:
--
--   /Apps/Meta/meta-<date>/facebook-<user>-<date>-<id>/your_facebook_activity/...
--
-- A folder cannot be handled file by file the way cloud_file_ingests handles a
-- zip: it arrives over many sync pages (and, while the service is still
-- writing it, over many sync ticks), and it only means something whole. One
-- row here is one such folder, from the moment an importer recognises its
-- listing until it has been downloaded and handed to the import pipeline.
CREATE TABLE IF NOT EXISTS ci_etl.cloud_folder_exports (
    id                uuid PRIMARY KEY DEFAULT ci.gen_uuid_v7(),

    -- Not FKs; see cloud_file_ingests for the schema's stance.
    user_id           uuid NOT NULL,
    connection_id     uuid NOT NULL,
    provider          text NOT NULL,

    -- The folder, as the provider's own normalized path (Dropbox: path_lower).
    -- Every file whose path starts with this belongs to the export.
    root_path         text NOT NULL,

    -- The importers whose recognisers claimed the folder's listing. They
    -- become the import run's declared sources.
    importers         text[] NOT NULL,

    -- 'collecting'  files are still being seen; wait until it stops changing.
    -- 'downloading' a download is in progress (updated_at is its heartbeat).
    -- 'imported'    downloaded whole and an import run was started.
    -- A failed download goes back to 'collecting' with last_error set, so the
    -- next sync tick tries again.
    status            text NOT NULL DEFAULT 'collecting'
                        CHECK (status IN ('collecting', 'downloading', 'imported')),

    -- When a sync last saw a new or changed file under root_path. The folder
    -- is downloaded only once this is old enough to call it settled.
    last_change_at    timestamptz NOT NULL DEFAULT now(),

    file_count        integer,
    byte_size         bigint,
    drop_id           uuid,
    import_run_id     uuid,
    attempt_count     integer NOT NULL DEFAULT 0,
    last_error        text,
    imported_at       timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),

    UNIQUE (connection_id, root_path)
);

CREATE INDEX IF NOT EXISTS cloud_folder_exports_user_provider_idx
    ON ci_etl.cloud_folder_exports (user_id, provider);

-- migrate:down
DROP TABLE IF EXISTS ci_etl.cloud_folder_exports;
