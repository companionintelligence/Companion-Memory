-- migrate:up
CREATE TABLE IF NOT EXISTS ci.feed_queue (
  feed_queue_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES ci.users(id) ON DELETE CASCADE,
  question_id UUID NOT NULL REFERENCES ci.questions(question_id) ON DELETE CASCADE,
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT feed_queue_user_question_unique UNIQUE (user_id, question_id)
);

CREATE INDEX IF NOT EXISTS feed_queue_user_order_idx
  ON ci.feed_queue(user_id, enqueued_at, feed_queue_id);

-- migrate:down
DROP TABLE IF EXISTS ci.feed_queue;
