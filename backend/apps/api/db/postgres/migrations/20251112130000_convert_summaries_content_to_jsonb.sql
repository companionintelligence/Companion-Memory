-- migrate:up
-- Convert summaries.content (TEXT) to JSONB while preserving legacy rows

ALTER TABLE summaries
    ADD COLUMN content_json JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE OR REPLACE FUNCTION ci_temp_try_parse_jsonb(input_text TEXT)
RETURNS JSONB AS $$
DECLARE
    parsed JSONB;
BEGIN
    parsed := input_text::jsonb;
    RETURN parsed;
EXCEPTION WHEN others THEN
    RETURN NULL;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

UPDATE summaries
SET content_json = COALESCE(
    ci_temp_try_parse_jsonb(content),
    jsonb_build_object('summary', jsonb_build_object('narrative', content))
);

DROP FUNCTION ci_temp_try_parse_jsonb(TEXT);

ALTER TABLE summaries DROP COLUMN content;
ALTER TABLE summaries RENAME COLUMN content_json TO content;
ALTER TABLE summaries ALTER COLUMN content SET DEFAULT '{}'::jsonb;

-- migrate:down
ALTER TABLE summaries
    ADD COLUMN content_text TEXT NOT NULL DEFAULT '';

UPDATE summaries
SET content_text = content::text;

ALTER TABLE summaries DROP COLUMN content;
ALTER TABLE summaries RENAME COLUMN content_text TO content;
ALTER TABLE summaries ALTER COLUMN content DROP DEFAULT;
