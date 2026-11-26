-- migrate:up
ALTER TABLE ci.messages ADD COLUMN grounding jsonb;
COMMENT ON COLUMN ci.messages.grounding IS 'Retrieval status and admitted source references for this assistant turn; citation existence is not entailment verification';

-- migrate:down
ALTER TABLE ci.messages DROP COLUMN grounding;
