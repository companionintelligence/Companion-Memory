-- migrate:up
ALTER TABLE ci.feed_queue
  ADD COLUMN IF NOT EXISTS item_type TEXT NOT NULL DEFAULT 'question',
  ADD COLUMN IF NOT EXISTS action_id UUID REFERENCES ci.actions(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS summary_id UUID REFERENCES ci.summaries(summary_id) ON DELETE CASCADE;

ALTER TABLE ci.feed_queue
  ALTER COLUMN question_id DROP NOT NULL;

ALTER TABLE ci.feed_queue
  ADD CONSTRAINT feed_queue_item_reference_check
    CHECK (num_nonnulls(action_id, summary_id, question_id) = 1);

ALTER TABLE ci.feed_queue
  ADD CONSTRAINT feed_queue_item_type_check
    CHECK (
      (item_type = 'action' AND action_id IS NOT NULL AND summary_id IS NULL AND question_id IS NULL)
      OR (item_type = 'summary' AND summary_id IS NOT NULL AND action_id IS NULL AND question_id IS NULL)
      OR (item_type = 'question' AND question_id IS NOT NULL AND action_id IS NULL AND summary_id IS NULL)
    );

CREATE UNIQUE INDEX IF NOT EXISTS feed_queue_user_action_unique_idx
  ON ci.feed_queue(user_id, action_id)
  WHERE action_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS feed_queue_user_summary_unique_idx
  ON ci.feed_queue(user_id, summary_id)
  WHERE summary_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS feed_queue_user_item_type_order_idx
  ON ci.feed_queue(user_id, item_type, enqueued_at, feed_queue_id);

-- migrate:down
DELETE FROM ci.feed_queue
WHERE action_id IS NOT NULL
   OR summary_id IS NOT NULL;

DROP INDEX IF EXISTS ci.feed_queue_user_item_type_order_idx;
DROP INDEX IF EXISTS ci.feed_queue_user_summary_unique_idx;
DROP INDEX IF EXISTS ci.feed_queue_user_action_unique_idx;

ALTER TABLE ci.feed_queue
  DROP CONSTRAINT IF EXISTS feed_queue_item_type_check;

ALTER TABLE ci.feed_queue
  DROP CONSTRAINT IF EXISTS feed_queue_item_reference_check;

ALTER TABLE ci.feed_queue
  DROP COLUMN IF EXISTS summary_id,
  DROP COLUMN IF EXISTS action_id,
  DROP COLUMN IF EXISTS item_type;

ALTER TABLE ci.feed_queue
  ALTER COLUMN question_id SET NOT NULL;
