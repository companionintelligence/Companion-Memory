-- migrate:up
-- Turn the direction of every stored agent-turn message the right way round.
--
-- `POST /memory/turn` (MemoryController.turn) stores what an agent harness
-- (OpenClaw `afterTurn`, Hermes `sync_turn`) saw in one chat turn. Until this
-- change it wrote the owner's own message as `inbound` and the agent's reply as
-- `outbound`, the reverse of what direction means everywhere else: recall then
-- printed the owner's words as "[someone else wrote to me]" and the agent's as
-- "[I wrote]". The route now writes `outbound` for the owner and `inbound` for
-- the agent; this repairs the rows it already wrote.
--
-- Exact, not a guess: every such row carries the speaker in
-- participants_metadata.role ('user' or 'assistant') and the category
-- 'agent-turn', and nothing else writes that category. Setting direction from
-- role means applying this twice changes nothing, and rows the fixed route
-- writes already match it.
UPDATE ci.communications
   SET direction = CASE participants_metadata ->> 'role'
                     WHEN 'user' THEN 'outbound'::ci.communication_direction
                     ELSE 'inbound'::ci.communication_direction
                   END
 WHERE category = 'agent-turn'
   AND participants_metadata ->> 'role' IN ('user', 'assistant')
   AND direction <> CASE participants_metadata ->> 'role'
                      WHEN 'user' THEN 'outbound'::ci.communication_direction
                      ELSE 'inbound'::ci.communication_direction
                    END;

-- migrate:down
-- Deliberately a no-op. Putting the old directions back would only restore
-- the bug: the owner's words labelled as someone else's.
SELECT 1;
