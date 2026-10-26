-- migrate:up

-- Take mail that somebody else sent the owner off the owner's own Person.
--
-- ## The bug this cleans up after
--
-- The import push mapped a staged contact onto the owner's self Person when its
-- DISPLAY NAME matched the owner's, even when it carried an address that was not
-- the owner's (fixed in #3136, `isOwnerContact` in push/self.ts). A mail from
-- `"<owner name>" <stranger@example.net>` was therefore pushed with
-- `from_entity_id` = the owner, and
--
--   * `promote.edge_communication` projected a `communication.sent` edge from
--     the owner to it (deterministicEdgeMatrix.ts), so the owner's page lists it
--     as "You sent this";
--   * a copy with no delivery headers was also stored as `outbound`
--     (email_direction.ts reads that absence as the owner's sent copy).
--
-- `enrich.person_link` could later move `from_entity_id` to the right person,
-- but the projection only ever inserts, so the owner's SENT edge stayed.
--
-- ## Which mails
--
-- A communication whose `from_entity_id` is its owner's self Person
-- (`ci.users.entity_id`) while its own record of the sender is an address or
-- number that is NOT one of the owner's:
--
--   * the `from` claim `enrich.person_link` wrote (`ci.identifier_claims`,
--     kind email or phone), when there is one and nobody confirmed or rejected
--     it by hand;
--   * otherwise the address in `participants_metadata ->> 'from'`, normalized
--     as `normalizeEmail` does (the part in angle brackets, trimmed, lower case).
--
-- The owner's addresses are `ci.users.email`, the self Person's
-- `properties.emails` / `.email`, and its `ci.entity_identifiers` email rows;
-- its numbers are its phone identifier rows. A mail with no address or number
-- for its sender is left alone: nothing on the row says it is not the owner's.
--
-- ## What it does
--
--   1. `from_entity_id` goes back to NULL, and an `outbound` mail whose owner
--      is among its recipients (in `to_entity_ids`, or by address in the To/Cc
--      of `participants_metadata`) becomes `inbound`, the rule PushStage's
--      `directionAfterSender` now applies at import.
--   2. The owner's `communication.sent` edge to it is deleted. Matched on the
--      rule that wrote it, so an edge a person or another rule wrote stays.
--   3. A `from` claim resolved to the owner resolves to nobody again.
--   4. The ledger rows of `enrich.person_link` and `promote.edge_communication`
--      for these mails are deleted, so both re-decide them. `link_communications`
--      and `extract_people` (smart rotation's `graph_link` leg) fill an empty
--      `from_entity_id` with the sender's person, creating it if needed, and the
--      edge leg then projects that person's SENT edge.

CREATE TEMP TABLE _owner_sent ON COMMIT DROP AS
WITH owner AS (
  SELECT u.id AS user_id, u.entity_id AS self_id
    FROM ci.users u
   WHERE u.entity_id IS NOT NULL
),
owner_email AS (
  SELECT o.user_id, lower(btrim(u.email)) AS value
    FROM owner o JOIN ci.users u ON u.id = o.user_id
   WHERE COALESCE(btrim(u.email), '') <> ''
  UNION
  SELECT o.user_id, lower(btrim(addr.value))
    FROM owner o
    JOIN ci.entities e ON e.entity_id = o.self_id
   CROSS JOIN LATERAL jsonb_array_elements_text(
           CASE
             WHEN jsonb_typeof(e.properties -> 'emails') = 'array' THEN e.properties -> 'emails'
             WHEN COALESCE(e.properties ->> 'email', '') <> '' THEN jsonb_build_array(e.properties ->> 'email')
             ELSE '[]'::jsonb
           END) AS addr(value)
  UNION
  SELECT o.user_id, i.value_normalized
    FROM owner o
    JOIN ci.entity_identifiers i ON i.owner_user_id = o.user_id AND i.entity_id = o.self_id
   WHERE i.kind = 'email'
),
owner_phone AS (
  SELECT o.user_id, i.value_normalized AS value
    FROM owner o
    JOIN ci.entity_identifiers i ON i.owner_user_id = o.user_id AND i.entity_id = o.self_id
   WHERE i.kind = 'phone'
),
sent_as_owner AS (
  SELECT c.id, c.user_id, o.self_id, c.participants_metadata, c.to_entity_ids, c.direction
    FROM ci.communications c
    JOIN owner o ON o.user_id = c.user_id
   WHERE c.from_entity_id = o.self_id
),
sender AS (
  -- The claim when there is one: it is what `enrich.person_link` keyed.
  SELECT s.id, cl.kind, cl.value_normalized AS value
    FROM sent_as_owner s
    JOIN ci.identifier_claims cl
      ON cl.owner_user_id = s.user_id
     AND cl.subject_type = 'communication'
     AND cl.subject_id = s.id
     AND cl.role = 'from'
     AND cl.kind IN ('email', 'phone')
     AND cl.disposition IS NULL
  UNION ALL
  -- Otherwise the address the push stored.
  SELECT s.id, 'email', lower(btrim(COALESCE(substring(s.participants_metadata ->> 'from' FROM '<([^>]+)>'),
                                             s.participants_metadata ->> 'from')))
    FROM sent_as_owner s
   WHERE jsonb_typeof(s.participants_metadata -> 'from') = 'string'
     AND (s.participants_metadata ->> 'from') LIKE '%@%'
     AND NOT EXISTS (SELECT 1
                       FROM ci.identifier_claims cl
                      WHERE cl.owner_user_id = s.user_id
                        AND cl.subject_type = 'communication'
                        AND cl.subject_id = s.id
                        AND cl.role = 'from'
                        AND cl.kind IN ('email', 'phone'))
)
SELECT s.id, s.user_id, s.self_id,
       -- Owner among the recipients: linked, or named by address in To/Cc.
       (s.self_id = ANY(COALESCE(s.to_entity_ids, '{}'::uuid[]))
        OR EXISTS (SELECT 1
                     FROM jsonb_array_elements_text(
                            CASE WHEN jsonb_typeof(s.participants_metadata -> 'to') = 'array'
                                 THEN s.participants_metadata -> 'to' ELSE '[]'::jsonb END
                            || CASE WHEN jsonb_typeof(s.participants_metadata -> 'cc') = 'array'
                                    THEN s.participants_metadata -> 'cc' ELSE '[]'::jsonb END) AS r(value)
                     JOIN owner_email oe
                       ON oe.user_id = s.user_id
                      AND oe.value = lower(btrim(COALESCE(substring(r.value FROM '<([^>]+)>'), r.value))))
       ) AS owner_is_recipient
  FROM sent_as_owner s
 WHERE EXISTS (SELECT 1 FROM sender sd WHERE sd.id = s.id)
   -- A person who confirmed or rejected the sender by hand has said who it is.
   AND NOT EXISTS (SELECT 1
                     FROM ci.identifier_claims cl
                    WHERE cl.owner_user_id = s.user_id
                      AND cl.subject_type = 'communication'
                      AND cl.subject_id = s.id
                      AND cl.role = 'from'
                      AND cl.disposition IS NOT NULL)
   AND NOT EXISTS (
         SELECT 1
           FROM sender sd
          WHERE sd.id = s.id
            AND (   (sd.kind = 'email' AND EXISTS (SELECT 1 FROM owner_email oe
                                                    WHERE oe.user_id = s.user_id AND oe.value = sd.value))
                 OR (sd.kind = 'phone' AND EXISTS (SELECT 1 FROM owner_phone op
                                                    WHERE op.user_id = s.user_id AND op.value = sd.value))));

UPDATE ci.communications c
   SET from_entity_id = NULL,
       direction = CASE
                     WHEN c.direction = 'outbound' AND m.owner_is_recipient THEN 'inbound'::ci.communication_direction
                     ELSE c.direction
                   END
  FROM _owner_sent m
 WHERE c.id = m.id
   AND c.user_id = m.user_id;

DELETE FROM ci.relationships r
 USING _owner_sent m
 WHERE r.owner_user_id = m.user_id
   AND r.from_entity_id = m.self_id
   AND r.to_entity_id = m.id
   AND r.properties ->> 'rule' = 'communication.sent';

UPDATE ci.identifier_claims cl
   SET entity_id = NULL,
       confidence = NULL,
       method = NULL
  FROM _owner_sent m
 WHERE cl.owner_user_id = m.user_id
   AND cl.subject_type = 'communication'
   AND cl.subject_id = m.id
   AND cl.role = 'from'
   AND cl.entity_id = m.self_id
   AND cl.disposition IS NULL;

DELETE FROM ci.pipeline_state ps
 USING _owner_sent m
 WHERE ps.entity_id = m.id
   AND ps.stage IN ('enrich.person_link', 'promote.edge_communication');

-- ## Idempotency
--
-- A second run finds nothing: every repaired mail's `from_entity_id` is no
-- longer the owner. A mail `link_communications` later links to the owner
-- again would be one whose sender IS an owner address, which this file skips.
--
-- ## Post-migration verification
--
-- Should be 0, mail the owner is filed as sending from an address that is not
-- theirs (the `participants_metadata` half of the rule):
--   SELECT count(*) FROM ci.communications c JOIN ci.users u ON u.id = c.user_id
--    WHERE c.from_entity_id = u.entity_id
--      AND (c.participants_metadata ->> 'from') LIKE '%@%'
--      AND lower(btrim(COALESCE(substring(c.participants_metadata ->> 'from' FROM '<([^>]+)>'),
--                               c.participants_metadata ->> 'from')))
--          NOT IN (SELECT lower(btrim(u.email))
--                  UNION SELECT value_normalized FROM ci.entity_identifiers
--                         WHERE entity_id = u.entity_id AND kind = 'email');

-- migrate:down
-- No-op: an irreversible data repair. Putting the owner back as these mails'
-- sender would restore the false authorship this removes.
