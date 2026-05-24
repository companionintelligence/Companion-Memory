-- migrate:up

-- Remove legacy vector indexes tied to columns being dropped.
DROP INDEX IF EXISTS ci.entities_embedding_idx;
DROP INDEX IF EXISTS ci.messages_embedding_idx;

-- Enforce removal of all secondary embeddings in app schemas.
DO $$
DECLARE
  row_record RECORD;
BEGIN
  FOR row_record IN
    SELECT table_schema, table_name
    FROM information_schema.columns
    WHERE column_name = 'secondary_embedding'
      AND table_schema IN ('ci', 'ci_search', 'public')
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I DROP COLUMN IF EXISTS secondary_embedding',
      row_record.table_schema,
      row_record.table_name
    );
  END LOOP;
END;
$$;

-- Remove embedding columns from ci tables (excluding ci.users, ci.summaries, and ci.files).
ALTER TABLE IF EXISTS ci.activities DROP COLUMN IF EXISTS activity_embedding;
ALTER TABLE IF EXISTS ci.agent_messages DROP COLUMN IF EXISTS task_embedding;
ALTER TABLE IF EXISTS ci.agents DROP COLUMN IF EXISTS agent_embedding;
ALTER TABLE IF EXISTS ci.answers DROP COLUMN IF EXISTS answer_embedding;
ALTER TABLE IF EXISTS ci.browser_activity DROP COLUMN IF EXISTS page_embedding;
ALTER TABLE IF EXISTS ci.communications DROP COLUMN IF EXISTS content_embedding;
ALTER TABLE IF EXISTS ci.content DROP COLUMN IF EXISTS embedding;
ALTER TABLE IF EXISTS ci.document_chunks DROP COLUMN IF EXISTS chunk_embedding;
ALTER TABLE IF EXISTS ci.documents DROP COLUMN IF EXISTS title_embedding;
ALTER TABLE IF EXISTS ci.documents DROP COLUMN IF EXISTS content_embedding;
ALTER TABLE IF EXISTS ci.documents DROP COLUMN IF EXISTS summary_embedding;
ALTER TABLE IF EXISTS ci.entities DROP COLUMN IF EXISTS embedding;
ALTER TABLE IF EXISTS ci.events DROP COLUMN IF EXISTS event_embedding;
ALTER TABLE IF EXISTS ci.facts DROP COLUMN IF EXISTS fact_embedding;
ALTER TABLE IF EXISTS ci.goals DROP COLUMN IF EXISTS goal_embedding;
ALTER TABLE IF EXISTS ci.habits DROP COLUMN IF EXISTS habit_embedding;
ALTER TABLE IF EXISTS ci.inventory DROP COLUMN IF EXISTS object_embedding;
ALTER TABLE IF EXISTS ci.messages DROP COLUMN IF EXISTS message_embedding;
ALTER TABLE IF EXISTS ci.position DROP COLUMN IF EXISTS location_embedding;
ALTER TABLE IF EXISTS ci.questions DROP COLUMN IF EXISTS question_embedding;
ALTER TABLE IF EXISTS ci.screen_captures DROP COLUMN IF EXISTS text_embedding;
ALTER TABLE IF EXISTS ci.screen_captures DROP COLUMN IF EXISTS visual_embedding;
ALTER TABLE IF EXISTS ci.threads DROP COLUMN IF EXISTS context_embedding;
ALTER TABLE IF EXISTS ci.voice_recordings DROP COLUMN IF EXISTS transcript_embedding;
ALTER TABLE IF EXISTS ci.voice_recordings DROP COLUMN IF EXISTS voice_embedding;

-- Prune unused columns from questions/answers.
ALTER TABLE IF EXISTS ci.questions DROP COLUMN IF EXISTS parent_question_id;
ALTER TABLE IF EXISTS ci.questions DROP COLUMN IF EXISTS related_questions;
ALTER TABLE IF EXISTS ci.questions DROP COLUMN IF EXISTS question_thread;
ALTER TABLE IF EXISTS ci.questions DROP COLUMN IF EXISTS is_about;
ALTER TABLE IF EXISTS ci.questions DROP COLUMN IF EXISTS difficulty_level;
ALTER TABLE IF EXISTS ci.questions DROP COLUMN IF EXISTS generation_context;
ALTER TABLE IF EXISTS ci.questions DROP COLUMN IF EXISTS generation_model;
ALTER TABLE IF EXISTS ci.questions DROP COLUMN IF EXISTS avg_answer_quality_score;
ALTER TABLE IF EXISTS ci.questions DROP COLUMN IF EXISTS last_asked_at;

ALTER TABLE IF EXISTS ci.answers DROP COLUMN IF EXISTS answer_completeness;
ALTER TABLE IF EXISTS ci.answers DROP COLUMN IF EXISTS needs_followup;
ALTER TABLE IF EXISTS ci.answers DROP COLUMN IF EXISTS followup_questions;
ALTER TABLE IF EXISTS ci.answers DROP COLUMN IF EXISTS question_relevance_score;
ALTER TABLE IF EXISTS ci.answers DROP COLUMN IF EXISTS question_clarity_score;
ALTER TABLE IF EXISTS ci.answers DROP COLUMN IF EXISTS is_update_to_previous;
ALTER TABLE IF EXISTS ci.answers DROP COLUMN IF EXISTS previous_answer_id;

-- migrate:down
-- Irreversible migration by design.
