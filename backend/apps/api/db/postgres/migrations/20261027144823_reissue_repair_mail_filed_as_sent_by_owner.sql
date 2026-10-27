-- migrate:up

-- Take mail that somebody else sent the owner off the owner's own Person, and
-- send phones the corrected copy.
--
-- This replaces 20261026105606_repair_mail_filed_as_sent_by_owner, which no
-- release shipped. That version could move the owner's own messages:
--
--   * it read every kind of communication, and for a call or text
--     `participants_metadata ->> 'from'` can hold the OTHER party
--     (push/inputs.ts takes `Contact` first, and SMS Backup & Restore writes
--     the number called there). An outgoing call to a bare number, filed with
--     the owner as its sender, was taken off the owner;
--   * it moved mail the owner sent to a third party from an address Memory
--     does not know (an alias, or the account of a Takeout that is not the
--     sign-in address). PushStage's `directionAfterSender` keeps that mail
--     outbound for the same reason: the owner is not a recipient, so it is
--     the owner's sent copy;
--   * it knew fewer of the owner's addresses than the import does
--     (`readSelfIdentity` in push/self.ts reads every self Person).
--
-- It also changed `direction` and `from_entity_id` without touching the
-- phones' copy of each message (`ci_search.mobile_search_documents.detail`,
-- entityDeviceRecord.ts), so a phone kept showing the mail as sent by the
-- owner. #3170 closed the same gap for agent turns.
--
-- ## The bug this cleans up after
--
-- The import push mapped a staged contact onto the owner's self Person when its
-- DISPLAY NAME matched the owner's, even when it carried an address that was not
-- the owner's (fixed in #3136, `isOwnerContact` in push/self.ts). A mail from
-- `"<owner name>" <stranger@example.net>` was therefore pushed with
-- `from_entity_id` = the owner, `promote.edge_communication` projected a
-- `communication.sent` edge from the owner to it, and a copy with no delivery
-- headers was also stored as `outbound`.
--
-- ## Which mails
--
-- An email whose `from_entity_id` is its owner's self Person
-- (`ci.users.entity_id`) while its own record of the sender is an address or
-- number that is NOT one of the owner's, and that reached the owner from
-- somebody else: it is `inbound`, or the owner is among its recipients (in
-- `to_entity_ids`, or by address in the To/Cc of `participants_metadata`).
-- Mail Gmail filed as Sent (`metadata.DirectionBasis = 'sent_label'`, imports
-- since #3136) is the owner's and is never taken.
--
-- The sender is the `from` claim `enrich.person_link` wrote
-- (`ci.identifier_claims`, kind email or phone) when there is one and nobody
-- confirmed or rejected it by hand, otherwise the address in
-- `participants_metadata ->> 'from'`, normalized as `normalizeEmail` does.
--
-- The owner's addresses are `ci.users.email`, the account label of each of the
-- owner's connections that is an address, and on every live self Person the
-- `properties.emails` / `.email` and the `ci.entity_identifiers` email rows. The
-- owner's numbers are those self Persons' `properties.phones` / `.phone`
-- (normalized as `normalizePhone` does: digits, the last ten) and their phone
-- identifier rows. A mail with no address or number for its sender is left
-- alone: nothing on the row says it is not the owner's.
--
-- ## What it does
--
--   1. `from_entity_id` goes back to NULL, and an `outbound` mail whose owner
--      is among its recipients becomes `inbound`.
--   2. The owner's `communication.sent` edge to it is deleted. Matched on the
--      rule that wrote it, so an edge a person or another rule wrote stays.
--   3. A `from` claim resolved to the owner resolves to nobody again.
--   4. The ledger rows of `enrich.person_link` and `promote.edge_communication`
--      for these mails are deleted, so both re-decide them.
--   5. Every message whose phone copy still names a different sender or
--      direction than its row goes back to `MobileSearchDocumentDetailCron`
--      (`detail_version = 0`), which re-derives it and bumps `updated_at`, so
--      PowerSync sends it to the phone. That covers this file's mails and the
--      ones 20261026105606 moved on a database that ran it.

CREATE TEMP TABLE _owner_sent ON COMMIT DROP AS
WITH owner AS (
  SELECT u.id AS user_id, u.entity_id AS self_id
    FROM ci.users u
   WHERE u.entity_id IS NOT NULL
),
self_person AS (
  -- Every live self Person, as readSelfIdentity reads them.
  SELECT o.user_id, e.entity_id, e.properties
    FROM owner o
    JOIN ci.entities e
      ON e.owner_user_id = o.user_id
     AND e.entity_type = 'Person'
     AND e.merged_into_entity_id IS NULL
     AND (e.entity_id = o.self_id OR e.is_self IS TRUE OR e.properties ->> 'is_self' = 'true')
),
owner_email AS (
  SELECT o.user_id, lower(btrim(u.email)) AS value
    FROM owner o JOIN ci.users u ON u.id = o.user_id
   WHERE COALESCE(btrim(u.email), '') <> ''
  UNION
  SELECT o.user_id, lower(btrim(cn.account_label))
    FROM owner o JOIN ci.connections cn ON cn.user_id = o.user_id
   WHERE cn.account_label LIKE '%@%'
  UNION
  SELECT sp.user_id, lower(btrim(addr.value))
    FROM self_person sp
   CROSS JOIN LATERAL jsonb_array_elements_text(
           CASE
             WHEN jsonb_typeof(sp.properties -> 'emails') = 'array' THEN sp.properties -> 'emails'
             WHEN COALESCE(sp.properties ->> 'email', '') <> '' THEN jsonb_build_array(sp.properties ->> 'email')
             ELSE '[]'::jsonb
           END) AS addr(value)
  UNION
  SELECT sp.user_id, i.value_normalized
    FROM self_person sp
    JOIN ci.entity_identifiers i ON i.owner_user_id = sp.user_id AND i.entity_id = sp.entity_id
   WHERE i.kind = 'email'
),
owner_phone AS (
  SELECT sp.user_id, right(regexp_replace(num.value, '\D', '', 'g'), 10) AS value
    FROM self_person sp
   CROSS JOIN LATERAL jsonb_array_elements_text(
           CASE
             WHEN jsonb_typeof(sp.properties -> 'phones') = 'array' THEN sp.properties -> 'phones'
             WHEN COALESCE(sp.properties ->> 'phone', '') <> '' THEN jsonb_build_array(sp.properties ->> 'phone')
             ELSE '[]'::jsonb
           END) AS num(value)
   WHERE regexp_replace(num.value, '\D', '', 'g') <> ''
  UNION
  SELECT sp.user_id, i.value_normalized
    FROM self_person sp
    JOIN ci.entity_identifiers i ON i.owner_user_id = sp.user_id AND i.entity_id = sp.entity_id
   WHERE i.kind = 'phone'
),
sent_as_owner AS (
  SELECT c.id, c.user_id, o.self_id, c.participants_metadata, c.to_entity_ids, c.direction
    FROM ci.communications c
    JOIN owner o ON o.user_id = c.user_id
   WHERE c.from_entity_id = o.self_id
     -- Mail only: a call's or a text's `from` can be the other party, and a
     -- post's or a DM's an `@handle`.
     AND c.communication_type = 'email'
     -- Gmail filed it as Sent: the owner's own mail, whatever its From says.
     AND c.metadata ->> 'DirectionBasis' IS DISTINCT FROM 'sent_label'
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
),
candidate AS (
  SELECT s.*,
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
)
SELECT s.id, s.user_id, s.self_id, s.owner_is_recipient
  FROM candidate s
 WHERE EXISTS (SELECT 1 FROM sender sd WHERE sd.id = s.id)
   -- Mail that reached the owner from somebody else. Outbound mail to others
   -- is the owner's sent copy, whatever address it went out from.
   AND (s.direction = 'inbound' OR s.owner_is_recipient)
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
 WHERE ps.entity_type = 'communication'
   AND ps.entity_id = m.id
   AND ps.stage IN ('enrich.person_link', 'promote.edge_communication');

-- The phones' copy. A record that already matches its row is left alone, so a
-- second run resets nothing.
UPDATE ci_search.mobile_search_documents d
   SET detail_version = 0
  FROM ci.communications c
 WHERE d.entity_type = 'communication'
   AND d.entity_id = c.id
   AND d.detail_version <> 0
   AND (   d.detail ->> 'direction' IS DISTINCT FROM c.direction::text
        OR d.detail ->> 'from_id' IS DISTINCT FROM c.from_entity_id::text);

-- ## Idempotency
--
-- A second run finds nothing: every repaired mail's `from_entity_id` is no
-- longer the owner, and every reset phone record is either rebuilt to match
-- its row or still waiting at version 0.

-- migrate:down
-- No-op: an irreversible data repair. Putting the owner back as these mails'
-- sender would restore the false authorship this removes, and the cron
-- rebuilds each reset phone record from its row as it is now.
SELECT 1;
