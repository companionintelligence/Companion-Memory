-- migrate:up

-- A fourth stage kind: `media`, between `parse` and `push`.
--
-- The push was never able to store an archive's bytes. It writes `ci.content`
-- and `ci.events` rows describing a photo, a voicemail or an MMS attachment,
-- and `contentFileRef` reads a `metadata.FileId` that nothing had ever written
-- — so every media row pointed at a file that did not exist, and the bytes went
-- out with the run's scratch tree. Uploading them is its own leg of the import:
-- it is bounded by the object store rather than by Postgres, it is by far the
-- longest part of a photo archive, and it is the leg most likely to fail
-- halfway. That makes it a stage rather than a step inside the push — a stage
-- gets its own progress row, its own ETA, and stage-granular retry, so an
-- object-store hiccup at photo 40,000 resumes instead of re-running the push.
--
-- Placed BEFORE `push` because the push reads the file id: `media` stamps
-- `metadata.FileId` onto the staged row and `toCanonical` carries it through.
--
-- Existing runs are untouched — their three rows stay valid, and a run's stage
-- set is whatever `requested_stages` recorded when it was created.
ALTER TABLE ci_import.import_stages
    DROP CONSTRAINT import_stages_kind_check;

ALTER TABLE ci_import.import_stages
    ADD CONSTRAINT import_stages_kind_check
        CHECK (kind IN ('unpack', 'parse', 'media', 'push'));

-- migrate:down

-- Reversible only while no `media` row exists; the rows would violate the
-- narrower constraint. Deleting them here would silently discard the record of
-- work that ran, so the down migration refuses instead and says what to do.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM ci_import.import_stages WHERE kind = 'media') THEN
        RAISE EXCEPTION
            'ci_import.import_stages still holds media stages; delete or re-kind them before rolling back';
    END IF;
END
$$;

ALTER TABLE ci_import.import_stages
    DROP CONSTRAINT import_stages_kind_check;

ALTER TABLE ci_import.import_stages
    ADD CONSTRAINT import_stages_kind_check
        CHECK (kind IN ('unpack', 'parse', 'push'));
