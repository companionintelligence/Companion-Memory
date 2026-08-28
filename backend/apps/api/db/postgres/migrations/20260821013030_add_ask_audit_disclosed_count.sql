-- migrate:up
-- Record HOW MUCH crossed to the asker, not just WHICH references did.
--
-- `disclosed_entities` is itemized references, and by construction it is EMPTY
-- for every answer form but `retrieval` (see 20260820224500) — those forms
-- disclose a yes/no or a magnitude and name nothing. The audit therefore read
-- as "nothing was disclosed" for a `count` answer that handed the asker a real
-- number, which is precisely the disclosure the owner's history exists to show.
-- ci.ask_answers already stores the magnitude, but that row is the answer
-- PAYLOAD and dies with the ask (ON DELETE CASCADE); the audit is the durable
-- record and has to carry its own copy.
--
-- DEFAULT 0 is correct for the rows already here as well as for the terminal
-- outcomes that disclose nothing at all (`declined`, `expired`): zero items
-- crossed, which is the truth in both cases.
ALTER TABLE ci.ask_audit
    ADD COLUMN disclosed_count INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN ci.ask_audit.disclosed_count IS
    'How many items the ASKER actually received, post-ceiling. Non-zero for non-itemizing forms too, where disclosed_entities is empty by construction.';

-- migrate:down
ALTER TABLE ci.ask_audit DROP COLUMN IF EXISTS disclosed_count;
