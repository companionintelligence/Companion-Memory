-- migrate:up
-- Split "what the asker received" from "what the answer was computed over".
--
-- `disclosed_entities` was being written from the PRE-ceiling match set, while
-- ci.ask_answers stored the post-clamp result — so a boolean answer that
-- itemized nothing still audited every candidate id as disclosed, and the two
-- records disagreed about the same disclosure. `disclosed_entities` now means
-- exactly the references that crossed to the asker (empty for every
-- non-retrieval form, by construction).
--
-- The candidate set is kept, because auditing what the owner's box actually
-- read is the accountability the audit exists for — but it is kept HERE, under
-- a name that does not claim it was disclosed. Owner-visible only: the audit is
-- read responder-scoped (`AskAuditService.listForResponder`).
ALTER TABLE ci.ask_audit
    ADD COLUMN backing_entities JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN ci.ask_audit.backing_entities IS
    'Entity ids the answer was computed over, post-redaction and PRE-ceiling. Never disclosed to the asker; see disclosed_entities for what was.';

-- migrate:down
ALTER TABLE ci.ask_audit DROP COLUMN IF EXISTS backing_entities;
