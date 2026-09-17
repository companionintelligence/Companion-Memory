-- migrate:up
-- A forced historical backfill updates a summary in place. Its old HBPE label
-- classified the old text and must be regenerated on the next serialization.
CREATE FUNCTION ci.invalidate_hourly_summary_label() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF to_regclass('hbpe.summary_l1_label') IS NOT NULL THEN
        EXECUTE 'DELETE FROM hbpe.summary_l1_label WHERE summary_id = $1'
          USING OLD.summary_id;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER invalidate_hourly_summary_label
AFTER UPDATE OF content, period_type, period_start, period_end, user_id ON ci.summaries
FOR EACH ROW
WHEN (
    OLD.period_type = 'hourly' AND (
        LEFT(COALESCE(OLD.content->>'summary_text', ''), 400)
            IS DISTINCT FROM LEFT(COALESCE(NEW.content->>'summary_text', ''), 400)
        OR OLD.period_type IS DISTINCT FROM NEW.period_type
        OR OLD.period_start IS DISTINCT FROM NEW.period_start
        OR OLD.period_end IS DISTINCT FROM NEW.period_end
        OR OLD.user_id IS DISTINCT FROM NEW.user_id
    )
)
EXECUTE FUNCTION ci.invalidate_hourly_summary_label();

-- migrate:down
DROP TRIGGER IF EXISTS invalidate_hourly_summary_label ON ci.summaries;
DROP FUNCTION IF EXISTS ci.invalidate_hourly_summary_label();
