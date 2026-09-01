-- migrate:up
-- Remove the ci.entities Person row named "Me" that the Google Voice importer
-- minted for the ACCOUNT OWNER, and un-attribute the 133,859 communications
-- pointing at it.
--
-- ## The bug (fixed forward in the same change as this migration)
--
-- A Google Voice export writes the owner's own side of every conversation as
-- the literal token `Me`, in the same `<cite class="sender vcard">` slot a real
-- correspondent occupies:
--
--   <cite class="sender vcard"><a class="tel" href="tel:+1…">
--     <abbr class="fn" title="">Me</abbr></a></cite>
--
-- It is the export's spelling of "is_from_me", not a name. `googlevoice.ts`
-- read it as a name in two places, and both minted the SAME node:
--
--   1. `participants[sender.phone] = sender` ran for every sender, including
--      the one the very next line identified as the owner (`isOutbound`). The
--      per-file participant loop then pushed it as a `contact`, which
--      `push/entities.ts` maps to `Person`, keyed by `naturalKeyFor` at
--      linked_table='import:google_voice'.
--   2. `metadata.Sender` carried the token into `participants_metadata.from`
--      (push/inputs.ts `toCommunicationInput`), from which `PersonLinkStage`
--      indexed a `name`-kind ci.entity_identifiers row for "me" and set
--      ci.communications.from_entity_id.
--
-- The forward fix suppresses the owner in both places and in the call-log lane
-- (where `Contact` is read AHEAD of `Sender`), so `Direction: 'outgoing'` plus
-- the counterpart `participant` edge carry the authorship on their own — the
-- same contract `imessage.ts` already documents ("On outbound, handle_id is
-- NULL — self has no handle row"). It repairs nothing that already landed,
-- which is what this migration is for.
--
-- ## Why deletion, and not a rename or a retype
--
-- There is nothing to keep. The row is not a mis-typed person and not a
-- salvageable identity: "Me" names no one, and the phone it carries is the
-- owner's own Google Voice number, which belongs on the owner's `is_self`
-- Person (set at onboarding) and nowhere else. Retyping it to `Concept` would
-- leave a node in the graph asserting that a correspondent called "Me" exists.
--
-- It is also an identity ATTRACTOR, which is why leaving it is worse than the
-- messages it holds. ci.entity_identifiers is UNIQUE on
-- (owner_user_id, kind, value_normalized), so ONE `name` row for "me" belongs
-- to exactly one node, and every later participant called "Me" — from any
-- source, about any human — resolves to it.
--
-- Deliberately NOT done here: pointing from_entity_id at the owner's `is_self`
-- Person. This appliance has none (`SELECT count(*) FROM ci.entities WHERE
-- is_self IS TRUE` → 0), and inventing one from an import is a false identity
-- claim. NULL is exactly the state the fixed parser produces —
-- `PushStage.resolveCorrespondents` returns `selfEntityId ?? undefined` for an
-- outbound message — so the repaired rows and freshly-imported ones agree.
-- FOLLOW-UP: once onboarding declares an `is_self` Person, a relink sweep over
-- outbound google_voice rows can fill from_entity_id with it. Nothing in this
-- migration blocks that; it is the reason the rows are left NULL rather than
-- pointed anywhere.
--
-- ## Why it does not come back on the next import
--
-- Two producers, so two halves:
--
--   * The parser no longer stages the owner, so a re-import mints nothing.
--   * `participants_metadata.from` is stripped below wherever it holds the
--     token. Without that, nulling from_entity_id alone would make each row
--     match PersonLinkStage's own applicability predicate again
--     (`from_entity_id IS NULL`), and the next sweep would re-mint the node
--     from the string still sitting in the row. 459 of the 133,840 rows carry
--     `from` as their ONLY participants key, so they collapse to '{}' and drop
--     out of the stage's `participants_metadata <> '{}'` predicate entirely;
--     the rest keep their `to` and stay eligible for a legitimate relink.
--
-- ## Scope
--
-- entity_type='Person' AND linked_table='import:google_voice' AND the name
-- folds to 'me'. `linked_table` is what makes the producer and the repair the
-- same population (same reasoning as 20260818220731). It matters here more
-- than usual: `domains/graph/utils/placeholderPersonName.ts` deliberately keeps
-- `me` OUT of its generic-placeholder list, and says why — in an ADDRESS BOOK
-- "Me" is a label a human really does file a contact under, and refusing it
-- there would delete a name a .vcf honestly contained. This migration must not
-- become that rule by the back door, so it never touches a `Me` row minted by
-- any other lane. On the live appliance the two populations are the same size
-- anyway (1 Person named "Me", GV-linked), but the predicate is the promise.
--
-- The metadata rewrite is scoped to source_system='google_voice' for the same
-- reason: 0 rows on any other source carry `from` = "Me", and if one ever does
-- it is that source's parser's problem, not this one's.
--
-- ## Reference audit (live, before writing this migration; ci.communications
-- has no FK on from_entity_id/to_entity_ids, so every *entity_id column in the
-- ci/ci_search schemas was counted by hand)
--
--   communications.from_entity_id     133859  <- nulled below
--   communications.to_entity_ids           7  <- array subtraction below
--   relationships (from/to)           132238  <- deleted below (SENT 132231,
--                                                RECEIVED 7; all derived from
--                                                the two columns above)
--   graph_deltas (entity/from/to)     132239  <- deleted below; ALL of them
--                                                unsummarized (summary_id
--                                                NULL), so the graph-summary
--                                                lane has not read them yet and
--                                                would otherwise narrate 132k
--                                                edges from a person who never
--                                                existed
--   entity_identifiers                     1  <- deleted below (kind='name',
--                                                value_normalized='me')
--   pipeline_state                         2  <- deleted below (entity_type
--                                                'person')
--   ci_search.embeddings                   1  <- deleted below
--   ci_search.vectors                      1  <- deleted below; a retype/delete
--                                                that leaves these behind keeps
--                                                answering searches forever
--   identifier_claims, relationships-as-to, events (organizer/participants),
--   entity_merges, entity_merge_blocks, merge_candidates,
--   entities.merged_into_entity_id, users.entity_id, peer_links,
--   entity_type_proposals, pipeline_dead_letters, ci_search.entity_tag,
--   ci_search.index_skips                  0
--
-- Idempotent: every statement recomputes the same CTE (1 row), so a second run
-- matches no entity and each statement affects zero rows. The
-- participants_metadata rewrite is idempotent on its own terms — after it, no
-- google_voice row has `from` = 'Me' for it to match.

-- 1. Take the owner token out of the raw participant strings FIRST, so that
--    even if a relink sweep races the rest of this migration it has nothing to
--    re-resolve. `- 'from'` on a bag without the key is a no-op.
UPDATE ci.communications
   SET participants_metadata = participants_metadata - 'from'
 WHERE source_system = 'google_voice'
   AND lower(btrim(participants_metadata ->> 'from')) = 'me';

-- 2. Un-attribute the sender. See above for why NULL and not the self Person.
WITH bad_entities AS (
  SELECT entity_id
    FROM ci.entities
   WHERE entity_type = 'Person'
     AND linked_table = 'import:google_voice'
     AND lower(btrim(name)) = 'me'
)
UPDATE ci.communications c
   SET from_entity_id = NULL
  FROM bad_entities bad
 WHERE c.from_entity_id = bad.entity_id;

-- 3. Same for the 7 rows that list the owner as a RECIPIENT. Array subtraction
--    via unnest + re-aggregate rather than array_remove, for the reason
--    20260818220731 spells out: a join to bad_entities revisits the row once
--    per matching id and array_remove would only strip the last-joined one.
--    array_agg collapses to NULL when everything is filtered out, which is the
--    "no recipients resolved" state PersonLinkStage already uses.
WITH bad_entities AS (
  SELECT entity_id
    FROM ci.entities
   WHERE entity_type = 'Person'
     AND linked_table = 'import:google_voice'
     AND lower(btrim(name)) = 'me'
)
UPDATE ci.communications c
   SET to_entity_ids = (
         SELECT array_agg(id)
           FROM unnest(c.to_entity_ids) AS id
          WHERE id NOT IN (SELECT entity_id FROM bad_entities)
       )
 WHERE c.to_entity_ids && (SELECT array_agg(entity_id) FROM bad_entities);

-- 4. The SENT/RECEIVED edges projected from the two columns above. They have no
--    FK, so they would survive the entity as dangling endpoints and keep the
--    owner visible in the graph view.
WITH bad_entities AS (
  SELECT entity_id
    FROM ci.entities
   WHERE entity_type = 'Person'
     AND linked_table = 'import:google_voice'
     AND lower(btrim(name)) = 'me'
)
DELETE FROM ci.relationships r
 USING bad_entities bad
 WHERE r.from_entity_id = bad.entity_id
    OR r.to_entity_id = bad.entity_id;

-- 5. The change-log entries describing the entity and those edges. All
--    unsummarized, so nothing has read them yet.
WITH bad_entities AS (
  SELECT entity_id
    FROM ci.entities
   WHERE entity_type = 'Person'
     AND linked_table = 'import:google_voice'
     AND lower(btrim(name)) = 'me'
)
DELETE FROM ci.graph_deltas d
 USING bad_entities bad
 WHERE d.entity_id = bad.entity_id
    OR d.from_entity_id = bad.entity_id
    OR d.to_entity_id = bad.entity_id;

-- 6. The identity attractor itself.
WITH bad_entities AS (
  SELECT entity_id
    FROM ci.entities
   WHERE entity_type = 'Person'
     AND linked_table = 'import:google_voice'
     AND lower(btrim(name)) = 'me'
)
DELETE FROM ci.entity_identifiers ei
 USING bad_entities bad
 WHERE ei.entity_id = bad.entity_id;

WITH bad_entities AS (
  SELECT entity_id
    FROM ci.entities
   WHERE entity_type = 'Person'
     AND linked_table = 'import:google_voice'
     AND lower(btrim(name)) = 'me'
)
DELETE FROM ci.identifier_claims ic
 USING bad_entities bad
 WHERE ic.entity_id = bad.entity_id;

-- 7. Indexing bookkeeping and the search rows themselves. Deleting a Person
--    without these leaves ci_search answering for it forever.
WITH bad_entities AS (
  SELECT entity_id
    FROM ci.entities
   WHERE entity_type = 'Person'
     AND linked_table = 'import:google_voice'
     AND lower(btrim(name)) = 'me'
)
DELETE FROM ci.pipeline_state ps
 USING bad_entities bad
 WHERE ps.entity_type = 'person'
   AND ps.entity_id = bad.entity_id;

WITH bad_entities AS (
  SELECT entity_id
    FROM ci.entities
   WHERE entity_type = 'Person'
     AND linked_table = 'import:google_voice'
     AND lower(btrim(name)) = 'me'
)
DELETE FROM ci_search.embeddings emb
 USING bad_entities bad
 WHERE emb.entity_type = 'person'
   AND emb.entity_id = bad.entity_id;

WITH bad_entities AS (
  SELECT entity_id
    FROM ci.entities
   WHERE entity_type = 'Person'
     AND linked_table = 'import:google_voice'
     AND lower(btrim(name)) = 'me'
)
DELETE FROM ci_search.vectors v
 USING bad_entities bad
 WHERE v.entity_type = 'person'
   AND v.entity_id = bad.entity_id;

DELETE FROM ci.entities
 WHERE entity_type = 'Person'
   AND linked_table = 'import:google_voice'
   AND lower(btrim(name)) = 'me';

-- ## Post-migration verification
--
-- Should be 0:
--   SELECT count(*) FROM ci.entities
--    WHERE entity_type = 'Person' AND linked_table = 'import:google_voice'
--      AND lower(btrim(name)) = 'me';
--   SELECT count(*) FROM ci.communications
--    WHERE source_system = 'google_voice'
--      AND lower(btrim(participants_metadata ->> 'from')) = 'me';
--
-- Should be 0 (no dangling sender/recipient survives):
--   SELECT count(*) FROM ci.communications c
--    WHERE c.from_entity_id IS NOT NULL
--      AND NOT EXISTS (SELECT 1 FROM ci.entities e
--                       WHERE e.entity_id = c.from_entity_id);
--   SELECT count(*) FROM ci.communications c, unnest(c.to_entity_ids) t(id)
--    WHERE NOT EXISTS (SELECT 1 FROM ci.entities e WHERE e.entity_id = t.id);
--
-- UNCHANGED: the ci.communications row count, every message body, timestamp,
-- thread_id and direction. Only the attribution columns move.

-- migrate:down
-- No-op: irreversible data cleanup, same reasoning as 20260818220731 and the
-- other repair migrations here. The removed Person carried no name (its name
-- was the export's owner token), the attribution it held was never a genuine
-- resolution, and nothing records which rows were already NULL beforehand, so
-- there is no source of truth to roll back to.
