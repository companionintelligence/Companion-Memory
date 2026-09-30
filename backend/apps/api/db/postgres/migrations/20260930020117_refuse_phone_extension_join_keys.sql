-- migrate:up

-- Take the FABRICATED PHONE NUMBERS that office-line extensions were truncated
-- into out of the shared join key, and bring every row that key reached into
-- line with what the fixed rule now writes.
--
-- ## The bug this cleans up after
--
-- The shared phone join key (`normalizePhone` in
-- `domains/graph/utils/normalizeIdentifier.ts`, and `normalizeHandle` in
-- `domains/import/staging/identity.ts`, which chose an imported contact's
-- natural key) stripped every non-digit and kept the LAST TEN digits. An
-- extension is digits too, so the vCard line
--
--   TEL;type=pref:(212) 555-0147\;229      (office line + extension 229)
--
-- keyed as `5550147229`: the area code and exchange dropped, the extension
-- appended. (The number is invented; on the card that found this, what was left
-- began with a real area code.) The result is a well-formed number that belongs
-- to somebody else, and it reached everything the key reaches:
--
--   * `ci.entity_identifiers` (kind 'phone', raw_value NULL, because the stored
--     string WAS the key) -- `PersonLinkStage` matches `phone_last10` at 0.85
--     confidence, so a stranger's calls and texts could attach to this contact;
--   * `ci.entities.linked_id` = uuidv5('contact:5550147229'), the importer's
--     idempotency coordinate, and `properties.phone`/`.phones`;
--   * `enrich.person_self_claim`'s self claims, which the duplicate detector
--     groups on;
--   * the Details card, whose `tel:` link dialled the fabricated number.
--
-- The duplicate detector's own parser (`memory/utils/phoneIdentity.ts`
-- `parsePhone`) already refused extensions, and `toE164` refused a trailing
-- `x`/`ext`. The join key now refuses them too, and `toE164` every form:
-- `hasPhoneExtension` names them (`x229`, `ext. 229`, `;229`, `,229`, `#229`,
-- `p`/`w` between digits) and the rule returns nothing for such a value rather
-- than truncating it -- or stripping it, which would key the office MAIN line
-- and collapse everyone who works there into one contact.
--
-- Measured on the full drive-master corpus (2026-09-27, 6.9 GB), run through
-- the real vCard parser: 5,270 contact entities, 19 carrying a phone with an
-- extension, 2 whose natural key was a truncation (the other 17 had a smaller
-- handle, so the truncation never became their key). Neither fabricated
-- number appears anywhere else in the corpus, so on that corpus the exposure is
-- latent -- no communication or event can have matched either one. The
-- statements that withdraw links are written for the appliance where one did.
--
-- ## What is recomputable, and what is not
--
-- `raw_value` is NULL on exactly the rows that matter most, so the evidence has
-- to come from elsewhere. Two populations carry it; the rest do not:
--
--   A. vCard Persons (`linked_table = 'import:vcard'`). The parser keeps every
--      TEL line as typed in `properties.Phones`, so a truncated key is PROVABLE:
--      its `linked_id` equals uuidv5('contact:' || <last ten digits of a typed
--      value carrying an extension>), and the key the fixed parser computes
--      from the same card's `Phones` + `Emails` differs from it. That second
--      condition is what keeps a card that also lists the same ten digits as a
--      plain number: the fixed rule keys it too, the old key stays the minimum,
--      and the row is not a candidate.
--   B. `ci.entity_identifiers` rows whose OWN `raw_value` carries an extension
--      and whose key is that value's last ten digits -- a phone somebody typed
--      into the person form, or a raw `properties.phones` entry an ingest
--      indexed.
--
--   NOT recomputable: Apple Contacts (`applecontacts`) and CSV contact lists
--   (`contact_list`) stage the typed number only on the run, and `ci_import`
--   staging is retention-swept; the durable row keeps nothing but the
--   truncation, indistinguishable from a real ten-digit number. Those rows are
--   left alone, truncated identifier included -- for them the fix is
--   forward-only. The fixed parser keys the same card elsewhere on its next
--   import, so the old row is orphaned beside a correct new one rather than
--   refreshed. (Neither source is in the measured corpus.)
--
-- ## Scope guards
--
--   * A vCard row that is a merge SURVIVOR is re-keyed (its coordinate is
--     provably its own) but its identifiers and properties are left alone:
--     `PersonMergeService` unions `phones` across the merge, so the same ten
--     digits may also have come from a merged-in record that really holds that
--     number, and nothing on the survivor can tell the two apart.
--   * A merge TOMBSTONE is re-keyed and its own properties corrected, for the
--     reason 20260819145023 gives: `upsertEntities` resolves a coordinate
--     THROUGH `merged_into_entity_id`, so re-keying preserves a human's merge
--     decision against future imports. Its identifiers were re-pointed to the
--     survivor at merge time; see the survivor note.
--   * Re-keying never collides: a destination coordinate already occupied (an
--     appliance that re-imported on the fixed parser) is skipped, and two
--     candidates heading for the same coordinate keep the older row only.
--   * A link claim a human `confirmed` is never withdrawn or re-resolved.
--
-- The namespace literal is `IMPORT_NAMESPACE` from `GraphIngestService.ts`
-- ("Do not change -- it is the idempotency anchor"), and the key shape is
-- `stagedNaturalKey` ('contact:<handle>', else 'contact:<lower(trimmed name)>').
-- The extension pattern is `PHONE_EXTENSION_PATTERN`, restated verbatim below;
-- `normalizeIdentifier.spec.ts` fails if the two ever differ.

-- `uuid-ossp` supplies the only RFC-4122 v5 generator available to SQL (PG18
-- ships uuidv4/uuidv7 builtins and no v5). It may be absent, or installed into
-- `ci` rather than `public`, hence resolving its schema -- the same block as
-- 20260820000332. It is a TRUSTED extension, so the owner may create it.
DO $$
DECLARE
  v5_schema text;
BEGIN
  SELECT n.nspname INTO v5_schema
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.proname = 'uuid_generate_v5'
   ORDER BY (n.nspname = 'ci') DESC, n.nspname
   LIMIT 1;

  IF v5_schema IS NULL THEN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp"';

    SELECT n.nspname INTO v5_schema
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.proname = 'uuid_generate_v5'
     ORDER BY (n.nspname = 'ci') DESC, n.nspname
     LIMIT 1;
  END IF;

  IF v5_schema IS NULL THEN
    RAISE EXCEPTION 'uuid_generate_v5 is unavailable: install the uuid-ossp extension and re-run';
  END IF;

  -- Lasts to the end of the migration's transaction; RESET at the bottom.
  EXECUTE format('SET LOCAL search_path = %I, ci, public', v5_schema);
END
$$;

-- ---------------------------------------------------------------------------
-- The rule, once. Session-local functions, dropped at the bottom, so every
-- statement below reads the same definition instead of five copies of it.
-- ---------------------------------------------------------------------------

-- `hasPhoneExtension`. `~*` is case-insensitive exactly as the JS `i` flag is,
-- and the pattern uses only syntax the two engines read alike.
CREATE FUNCTION pg_temp.phone_has_extension(v text) RETURNS boolean
  LANGUAGE sql IMMUTABLE
  AS $f$ SELECT v ~* '[;,#]|(?:^|[^a-z])(?:ext(?:ension|n)?|x)\.?\s*:?\s*\d|\d\s*[pw]\s*\d' $f$;

-- The OLD key: the last ten digits of every digit in the value. Used only to
-- recognise a stored key as a truncation, never to write one.
CREATE FUNCTION pg_temp.phone_old_key(v text) RETURNS text
  LANGUAGE sql IMMUTABLE
  AS $f$ SELECT right(regexp_replace(v, '\D', '', 'g'), 10) $f$;

-- `normalizePhone`, fixed: nothing for an extension or a value with no digits.
CREATE FUNCTION pg_temp.phone_key(v text) RETURNS text
  LANGUAGE sql IMMUTABLE
  AS $f$
    SELECT CASE
             WHEN v IS NULL OR pg_temp.phone_has_extension(v) THEN NULL
             WHEN regexp_replace(v, '\D', '', 'g') = '' THEN NULL
             ELSE pg_temp.phone_old_key(v)
           END
  $f$;

-- `normalizeHandle`, fixed: an email lower-cased; a phone of seven or more
-- digits keyed by `phone_key`; anything else nothing. The parser trims every
-- value before it stages it, so `btrim` here is a no-op kept for safety.
CREATE FUNCTION pg_temp.handle_key(v text) RETURNS text
  LANGUAGE sql IMMUTABLE
  AS $f$
    SELECT CASE
             WHEN v IS NULL OR btrim(v) = '' THEN NULL
             WHEN strpos(v, '@') > 0 THEN lower(btrim(v))
             WHEN length(regexp_replace(v, '\D', '', 'g')) < 7 THEN NULL
             ELSE pg_temp.phone_key(v)
           END
  $f$;

-- A jsonb value's strings, as text rows: an array's string elements, a lone
-- string, or nothing. Object elements (the Google Contacts
-- `{value, type}` shape) are not handles and are skipped, as every reader of
-- these keys skips them.
CREATE FUNCTION pg_temp.jsonb_strings(j jsonb) RETURNS SETOF text
  LANGUAGE sql IMMUTABLE
  AS $f$
    SELECT e #>> '{}'
      FROM jsonb_array_elements(CASE jsonb_typeof(j)
                                  WHEN 'array'  THEN j
                                  WHEN 'string' THEN jsonb_build_array(j)
                                  ELSE '[]'::jsonb
                                END) AS a(e)
     WHERE jsonb_typeof(e) = 'string'
  $f$;

-- ---------------------------------------------------------------------------
-- Population A: vCard Persons keyed on a truncation.
-- ---------------------------------------------------------------------------

-- `new_key` is `entityIdentityKey` under the fixed rule: the smallest handle
-- the card's own TEL + EMAIL values yield, in code-unit order (`COLLATE "C"`,
-- which is what JS `Array.prototype.sort` compares) -- over the entity's
-- `Phones` + `Emails`, which are exactly those values (NOTE-recovered ones
-- included). `new_natural` is `stagedNaturalKey('contact', new_key, name)`,
-- the name being the staged one the parser keeps in `Names[0]`.
CREATE TEMP TABLE _ext_vcard ON COMMIT DROP AS
WITH proven AS (
  SELECT DISTINCT
         e.entity_id,
         e.owner_user_id,
         e.linked_table,
         e.name,
         e.properties,
         e.created_at,
         e.merged_into_entity_id,
         COALESCE(e.is_active, true) AS is_active,
         pg_temp.phone_old_key(t.typed) AS old_key
    FROM ci.entities e
    CROSS JOIN LATERAL pg_temp.jsonb_strings(e.properties -> 'Phones') AS t(typed)
   WHERE e.entity_type = 'Person'
     AND e.linked_table = 'import:vcard'
     AND pg_temp.phone_has_extension(t.typed)
     AND length(regexp_replace(t.typed, '\D', '', 'g')) >= 7
     AND e.linked_id = uuid_generate_v5('6f4b3f9e-1c2a-5d8e-9a7b-0c1d2e3f4a5b'::uuid,
                                        'contact:' || pg_temp.phone_old_key(t.typed))
),
keyed AS (
  SELECT p.*,
         (SELECT min(pg_temp.handle_key(h.v) COLLATE "C")
            FROM (SELECT pg_temp.jsonb_strings(p.properties -> 'Phones')
                  UNION ALL
                  SELECT pg_temp.jsonb_strings(p.properties -> 'Emails')) AS h(v)) AS new_key,
         NULLIF(lower(btrim(p.properties -> 'Names' ->> 0)), '') AS staged_name,
         EXISTS (SELECT 1 FROM ci.entities s WHERE s.merged_into_entity_id = p.entity_id) AS is_survivor
    FROM proven p
)
SELECT k.entity_id,
       k.owner_user_id,
       k.linked_table,
       k.created_at,
       k.old_key,
       k.new_key,
       CASE WHEN k.new_key IS NULL THEN NULL WHEN strpos(k.new_key, '@') > 0 THEN 'email' ELSE 'phone' END
         AS new_key_kind,
       CASE
         WHEN k.new_key IS NOT NULL THEN
           uuid_generate_v5('6f4b3f9e-1c2a-5d8e-9a7b-0c1d2e3f4a5b'::uuid, 'contact:' || k.new_key)
         WHEN k.staged_name IS NOT NULL THEN
           uuid_generate_v5('6f4b3f9e-1c2a-5d8e-9a7b-0c1d2e3f4a5b'::uuid, 'contact:' || k.staged_name)
       END AS new_linked_id,
       -- `toGraphEntity` names a row after its handle only when the card's own
       -- name was unusable, so a row named for the truncation takes the new
       -- handle's name instead -- or none, which is what the fixed parser
       -- writes for a card with neither.
       CASE WHEN k.name = k.old_key THEN k.new_key ELSE k.name END AS new_name,
       k.merged_into_entity_id IS NOT NULL AS is_tombstone,
       k.is_survivor,
       -- Every artifact a live, unmerged, un-merged-into row holds is its own.
       (k.merged_into_entity_id IS NULL AND k.is_active AND NOT k.is_survivor) AS is_live
  FROM keyed k
 -- The proof's second half: under the fixed rule the card keys elsewhere. A
 -- card that also lists the same digits as a plain number keys the same way
 -- and is not a candidate.
 WHERE k.new_key IS DISTINCT FROM k.old_key;

CREATE INDEX ON _ext_vcard (entity_id);

-- (A1) The coordinate. One row per destination: the oldest candidate wins a
-- shared one, and an occupied destination is skipped outright. Both leave the
-- row on its old key -- orphaned from future imports, which is what the fixed
-- parser makes of it anyway -- rather than failing the migration on
-- `entities_linked_uniq`.
UPDATE ci.entities e
   SET linked_id = r.new_linked_id,
       updated_at = now()
  FROM (
    SELECT v.*,
           row_number() OVER (PARTITION BY v.owner_user_id, v.linked_table, v.new_linked_id
                              ORDER BY v.created_at, v.entity_id) AS rank
      FROM _ext_vcard v
     WHERE v.new_linked_id IS NOT NULL
  ) r
 WHERE e.entity_id = r.entity_id
   AND r.rank = 1
   AND NOT EXISTS (
         SELECT 1
           FROM ci.entities t
          WHERE t.owner_user_id IS NOT DISTINCT FROM r.owner_user_id
            AND t.entity_type = 'Person'
            AND t.linked_table = r.linked_table
            AND t.linked_id = r.new_linked_id
            AND t.entity_id <> r.entity_id);

-- (A2) The properties and name the fixed parser writes: `phone`/`phones` held
-- the truncation and go; the new handle's keys come in, exactly as
-- `toGraphEntity` sets them. Everything else -- the typed `Phones`, user edits,
-- enrichment -- is left as it is. Only a row this actually changes is written,
-- and those are remembered: they are the rows whose search index and ledger
-- are reset at the bottom.
CREATE TEMP TABLE _ext_changed (entity_id uuid PRIMARY KEY) ON COMMIT DROP;

WITH target AS (
  SELECT v.entity_id,
         v.new_name,
         CASE v.new_key_kind
           WHEN 'email' THEN (e.properties - 'phone' - 'phones')
                             || jsonb_build_object('email', v.new_key, 'emails', jsonb_build_array(v.new_key))
           WHEN 'phone' THEN (e.properties - 'phone' - 'phones')
                             || jsonb_build_object('phone', v.new_key, 'phones', jsonb_build_array(v.new_key))
           ELSE e.properties - 'phone' - 'phones'
         END AS new_properties
    FROM _ext_vcard v
    JOIN ci.entities e ON e.entity_id = v.entity_id
   WHERE NOT v.is_survivor
),
changed AS (
  UPDATE ci.entities e
     SET properties = t.new_properties,
         name = t.new_name,
         updated_at = now()
    FROM target t
   WHERE e.entity_id = t.entity_id
     AND (e.properties IS DISTINCT FROM t.new_properties OR e.name IS DISTINCT FROM t.new_name)
  RETURNING e.entity_id
)
INSERT INTO _ext_changed SELECT entity_id FROM changed;

-- (A3) The identifier with teeth goes, whatever wrote or verified it: the proof
-- is on the entity's own card, and a user who "verified" it verified the
-- truncation the card displayed. The new handle is indexed the way ingest would
-- index it -- first writer wins, so an address another entity already holds
-- stays with that entity.
DELETE FROM ci.entity_identifiers ei
 USING _ext_vcard v
 WHERE v.is_live
   AND ei.entity_id = v.entity_id
   AND ei.owner_user_id IS NOT DISTINCT FROM v.owner_user_id
   AND ei.kind = 'phone'
   AND ei.value_normalized = v.old_key;

INSERT INTO ci.entity_identifiers (entity_id, owner_user_id, kind, value_normalized, source)
SELECT v.entity_id, v.owner_user_id, v.new_key_kind, v.new_key, 'migration:20260930020117'
  FROM _ext_vcard v
 WHERE v.is_live
   AND v.new_key IS NOT NULL
   AND v.owner_user_id IS NOT NULL
ON CONFLICT (owner_user_id, kind, value_normalized) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Population B: identifier rows whose own raw value carries an extension.
-- ---------------------------------------------------------------------------

-- The key equality proves the row's key IS the old rule's truncation of its
-- own raw value; a row keyed some other way is not touched.
CREATE TEMP TABLE _ext_typed ON COMMIT DROP AS
SELECT ei.entity_id, ei.owner_user_id, ei.value_normalized AS old_key, ei.raw_value AS typed
  FROM ci.entity_identifiers ei
 WHERE ei.kind = 'phone'
   AND ei.raw_value IS NOT NULL
   AND pg_temp.phone_has_extension(ei.raw_value)
   AND ei.value_normalized = pg_temp.phone_old_key(ei.raw_value);

-- (B1) Keep the number the person typed. Deleting the row would otherwise
-- delete the only copy of a number entered through the person form, which
-- writes identifiers and nothing else. `properties.phones` is where the Details
-- card reads property-held numbers from, and every matcher that reads it now
-- refuses an extension, so the typed form is visible and inert there.
UPDATE ci.entities e
   SET properties = jsonb_set(COALESCE(e.properties, '{}'::jsonb), '{phones}',
                              CASE jsonb_typeof(e.properties -> 'phones')
                                WHEN 'array'  THEN e.properties -> 'phones'
                                WHEN 'string' THEN jsonb_build_array(e.properties -> 'phones')
                                ELSE '[]'::jsonb
                              END || m.missing),
       updated_at = now()
  FROM (
    SELECT t.entity_id, jsonb_agg(DISTINCT to_jsonb(t.typed)) AS missing
      FROM _ext_typed t
      JOIN ci.entities e2 ON e2.entity_id = t.entity_id
     WHERE NOT EXISTS (
             SELECT 1
               FROM jsonb_array_elements(CASE jsonb_typeof(e2.properties -> 'phones')
                                           WHEN 'array'  THEN e2.properties -> 'phones'
                                           WHEN 'string' THEN jsonb_build_array(e2.properties -> 'phones')
                                           ELSE '[]'::jsonb
                                         END) AS p(el)
              WHERE p.el #>> '{}' = t.typed
                 OR p.el ->> 'value' = t.typed)
     GROUP BY t.entity_id
  ) m
 WHERE e.entity_id = m.entity_id;

DELETE FROM ci.entity_identifiers ei
 USING _ext_typed t
 WHERE ei.entity_id = t.entity_id
   AND ei.owner_user_id IS NOT DISTINCT FROM t.owner_user_id
   AND ei.kind = 'phone'
   AND ei.value_normalized = t.old_key;

-- ---------------------------------------------------------------------------
-- Self claims. `enrich.person_self_claim` upserts and never retracts, so its
-- v2 re-run alone would leave these in place for the duplicate detector.
-- ---------------------------------------------------------------------------

DELETE FROM ci.identifier_claims c
 USING _ext_vcard v
 WHERE v.is_live
   AND c.owner_user_id = v.owner_user_id
   AND c.subject_type = 'person'
   AND c.role = 'self'
   AND c.subject_id = v.entity_id
   AND c.kind = 'phone'
   AND c.value_normalized = v.old_key;

-- A self claim on a typed value that carries an extension (a raw
-- `properties.phones` entry, e.g. from the person form) is the same truncation,
-- recorded with its evidence.
DELETE FROM ci.identifier_claims c
 WHERE c.subject_type = 'person'
   AND c.role = 'self'
   AND c.kind = 'phone'
   AND c.raw_value IS NOT NULL
   AND pg_temp.phone_has_extension(c.raw_value)
   AND c.value_normalized = pg_temp.phone_old_key(c.raw_value);

-- ---------------------------------------------------------------------------
-- Links a withdrawn key had resolved. `enrich.person_link` v3 re-adjudicates
-- every claim, but its projection only ever ADDS (`COALESCE(new, old)`, a
-- merging append), so a column a truncated key filled keeps its wrong person
-- once the key resolves to nobody. Withdrawn here, from the claims that
-- recorded why each link exists.
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE _ext_withdrawn ON COMMIT DROP AS
SELECT owner_user_id, entity_id, old_key FROM _ext_vcard WHERE is_live AND owner_user_id IS NOT NULL
UNION
SELECT owner_user_id, entity_id, old_key FROM _ext_typed WHERE owner_user_id IS NOT NULL;

-- One row per (subject, role, person) a withdrawn key linked, kept only when no
-- OTHER claim still links that person in that role -- a different identifier,
-- or a human's confirmation of this one.
CREATE TEMP TABLE _ext_links ON COMMIT DROP AS
SELECT DISTINCT c.owner_user_id, c.subject_type, c.subject_id, c.role, c.entity_id
  FROM ci.identifier_claims c
  JOIN _ext_withdrawn w
    ON w.owner_user_id = c.owner_user_id
   AND w.entity_id = c.entity_id
   AND w.old_key = c.value_normalized
 WHERE c.kind = 'phone'
   AND c.subject_type IN ('communication', 'event')
   AND c.disposition IS NULL
   AND NOT EXISTS (
         SELECT 1
           FROM ci.identifier_claims o
          WHERE o.owner_user_id = c.owner_user_id
            AND o.subject_type = c.subject_type
            AND o.subject_id = c.subject_id
            AND o.role = c.role
            AND o.entity_id = c.entity_id
            AND o.disposition IS DISTINCT FROM 'rejected'
            AND (o.disposition = 'confirmed'
                 OR NOT (o.kind = 'phone'
                         AND EXISTS (SELECT 1
                                       FROM _ext_withdrawn w2
                                      WHERE w2.owner_user_id = o.owner_user_id
                                        AND w2.entity_id = o.entity_id
                                        AND w2.old_key = o.value_normalized))));

UPDATE ci.communications c
   SET from_entity_id = NULL
  FROM _ext_links l
 WHERE l.subject_type = 'communication'
   AND l.role = 'from'
   AND c.id = l.subject_id
   AND c.user_id = l.owner_user_id
   AND c.from_entity_id = l.entity_id;

-- Per subject, not per link: an UPDATE ... FROM applies one joined row per
-- target, so two withdrawn recipients on one message must arrive together.
-- Order is kept -- RecipientIds-style positional readers rely on it.
UPDATE ci.communications c
   SET to_entity_ids = ARRAY(SELECT u.id
                               FROM unnest(c.to_entity_ids) WITH ORDINALITY AS u(id, ord)
                              WHERE u.id <> ALL (g.ids)
                              ORDER BY u.ord)
  FROM (
    SELECT owner_user_id, subject_id, array_agg(entity_id) AS ids
      FROM _ext_links
     WHERE subject_type = 'communication' AND role = 'to'
     GROUP BY owner_user_id, subject_id
  ) g
 WHERE c.id = g.subject_id
   AND c.user_id = g.owner_user_id
   AND c.to_entity_ids && g.ids;

UPDATE ci.events e
   SET organizer_entity_id = NULL,
       updated_at = now()
  FROM _ext_links l
 WHERE l.subject_type = 'event'
   AND l.role = 'organizer'
   AND e.event_id = l.subject_id
   AND e.user_id = l.owner_user_id
   AND e.organizer_entity_id = l.entity_id;

UPDATE ci.events e
   SET participant_entity_ids = ARRAY(SELECT u.id
                                        FROM unnest(e.participant_entity_ids) WITH ORDINALITY AS u(id, ord)
                                       WHERE u.id <> ALL (g.ids)
                                       ORDER BY u.ord),
       updated_at = now()
  FROM (
    SELECT owner_user_id, subject_id, array_agg(entity_id) AS ids
      FROM _ext_links
     WHERE subject_type = 'event' AND role = 'participant'
     GROUP BY owner_user_id, subject_id
  ) g
 WHERE e.event_id = g.subject_id
   AND e.user_id = g.owner_user_id
   AND e.participant_entity_ids && g.ids;

-- The edges `promote.edge_communication` / `promote.edge_event` projected from
-- those columns. That projection only ever inserts, so its v8 re-run would
-- leave them. Matched on the rule that wrote each one, so an edge some other
-- rule or a human wrote between the same two nodes survives.
DELETE FROM ci.relationships r
 USING _ext_links l
 WHERE r.owner_user_id = l.owner_user_id
   AND r.from_entity_id = l.entity_id
   AND r.to_entity_id = l.subject_id
   AND r.properties ->> 'rule' = CASE
                                   WHEN l.subject_type = 'communication' AND l.role = 'from' THEN 'communication.sent'
                                   WHEN l.subject_type = 'communication' AND l.role = 'to' THEN 'communication.received'
                                   WHEN l.subject_type = 'event' AND l.role = 'organizer' THEN 'event.organized'
                                   WHEN l.subject_type = 'event' AND l.role = 'participant' THEN 'event.participated'
                                 END;

-- And the claims themselves resolve to nobody until the re-run says otherwise.
-- (It would overwrite them anyway; doing it here keeps the table honest in the
-- window before it does, and keeps `readProjection` from re-adding the link.)
UPDATE ci.identifier_claims c
   SET entity_id = NULL,
       confidence = NULL,
       method = NULL
  FROM _ext_withdrawn w
 WHERE c.owner_user_id = w.owner_user_id
   AND c.entity_id = w.entity_id
   AND c.value_normalized = w.old_key
   AND c.kind = 'phone'
   AND c.subject_type IN ('communication', 'event')
   AND c.disposition IS NULL;

-- ---------------------------------------------------------------------------
-- The number a withdrawn key freed. `ci.entity_identifiers` is first-writer-
-- wins, so a Person that really holds those ten digits (a caller whose
-- `properties.phones` states them) could never index them while the truncation
-- sat there. Indexed now, in `EntityIdentifierBackfillService`'s order (oldest
-- first), so the re-run resolves their calls to them -- the index the appliance
-- would hold had the truncation never been written.
--
-- That counterfactual includes the population this file cannot prove: an Apple
-- Contacts or CSV twin of the same office-line card keyed the same truncation,
-- and had it been imported first it would hold the identifier today. It is
-- indistinguishable from a real holder here, it is exactly as fabricated as it
-- would have been in that order, and it is outside what this file can prove.
-- ---------------------------------------------------------------------------

INSERT INTO ci.entity_identifiers (entity_id, owner_user_id, kind, value_normalized, raw_value, source)
SELECT DISTINCT ON (h.owner_user_id, h.phone_key)
       h.entity_id, h.owner_user_id, 'phone', h.phone_key, NULLIF(h.typed, h.phone_key),
       'migration:20260930020117'
  FROM (
    SELECT e.entity_id, e.owner_user_id, e.created_at, t.typed, pg_temp.phone_key(t.typed) AS phone_key
      FROM ci.entities e
      CROSS JOIN LATERAL pg_temp.jsonb_strings(COALESCE(e.properties -> 'phones', e.properties -> 'phone'))
                         AS t(typed)
     WHERE e.entity_type = 'Person'
       AND COALESCE(e.is_active, true) = true
       AND e.merged_into_entity_id IS NULL
       AND e.owner_user_id IS NOT NULL
       -- Not a row this migration just proved holds a truncation -- a merge
       -- survivor keeps its `phones` untouched, see Scope guards.
       AND NOT EXISTS (SELECT 1 FROM _ext_vcard v WHERE v.entity_id = e.entity_id)
  ) h
  JOIN (SELECT DISTINCT owner_user_id, old_key FROM _ext_withdrawn) w
    ON w.owner_user_id = h.owner_user_id
   AND w.old_key = h.phone_key
 ORDER BY h.owner_user_id, h.phone_key, h.created_at, h.entity_id
ON CONFLICT (owner_user_id, kind, value_normalized) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Staged vCard rows. A run pushed after this migration -- one interrupted
-- mid-import across the upgrade -- would push its staged `identity_key` and
-- mint the truncated coordinate straight back. Same proof, same new key,
-- computed from the staged metadata (which is where `properties` came from).
-- ---------------------------------------------------------------------------

UPDATE ci_import.staged_entities s
   SET identity_key = r.new_key
  FROM (
    SELECT k.*,
           row_number() OVER (PARTITION BY k.run_id, k.new_key ORDER BY k.created_at, k.id) AS rank
      FROM (
        SELECT s2.id, s2.run_id, s2.created_at, s2.identity_key AS old_key,
               (SELECT min(pg_temp.handle_key(h.v) COLLATE "C")
                  FROM (SELECT pg_temp.jsonb_strings(s2.metadata -> 'Phones')
                        UNION ALL
                        SELECT pg_temp.jsonb_strings(s2.metadata -> 'Emails')) AS h(v)) AS new_key
          FROM ci_import.staged_entities s2
         WHERE s2.data_source = 'vcard'
           AND s2.identity_key IS NOT NULL
           AND EXISTS (SELECT 1
                         FROM pg_temp.jsonb_strings(s2.metadata -> 'Phones') AS t(typed)
                        WHERE pg_temp.phone_has_extension(t.typed)
                          AND pg_temp.phone_old_key(t.typed) = s2.identity_key)
      ) k
     WHERE k.new_key IS DISTINCT FROM k.old_key
  ) r
 WHERE s.id = r.id
   AND (r.new_key IS NULL
        OR (r.rank = 1
            AND NOT EXISTS (SELECT 1
                              FROM ci_import.staged_entities t
                             WHERE t.run_id = r.run_id
                               AND t.identity_key = r.new_key)));

-- ---------------------------------------------------------------------------
-- The search index and the ledger, for every repaired row whose name or
-- `properties.phone` changed. `personSearchDocument` indexes both, so the
-- stored vector answers to the fabricated number until it is rewritten, and
-- `SearchIndexBackfillService` never revisits a row that has an embedding.
-- Deleting the ledger rows as well re-opens every entity-keyed stage for these
-- rows -- the index legs, the self claim, the duplicate detector -- which is
-- the whole of "this row changed underneath you".
-- ---------------------------------------------------------------------------

DELETE FROM ci_search.embeddings em USING _ext_changed c WHERE em.entity_id = c.entity_id;

DELETE FROM ci_search.vectors vv USING _ext_changed c WHERE vv.entity_id = c.entity_id;

DELETE FROM ci_search.index_skips sk USING _ext_changed c WHERE sk.entity_id = c.entity_id;

DELETE FROM ci.pipeline_state ps USING _ext_changed c WHERE ps.entity_id = c.entity_id;

DROP FUNCTION pg_temp.jsonb_strings(jsonb);
DROP FUNCTION pg_temp.handle_key(text);
DROP FUNCTION pg_temp.phone_key(text);
DROP FUNCTION pg_temp.phone_old_key(text);
DROP FUNCTION pg_temp.phone_has_extension(text);

-- ## Idempotency
--
-- Every working set is computed once into temp tables dropped on commit. A
-- re-keyed row no longer has a truncation's `linked_id`. One that could not be
-- re-keyed (no natural key, or an occupied destination) is still selected, but
-- every statement on it is a no-op the second time: its properties and name
-- already match (so it is not written, and its index and ledger are not reset
-- again), and its identifier and self claim are gone. A withdrawn link has no
-- claim resolving it any more, and a staged row's key moved. A second run
-- changes nothing -- verified against a seeded copy of the schema, by
-- checksumming every table this file writes before and after it.
--
-- ## Post-migration verification
--
-- Should be 0 -- no identifier or self claim keyed on a typed extension:
--   SELECT count(*) FROM ci.entity_identifiers
--    WHERE kind = 'phone' AND raw_value ~* '<the pattern above>'
--      AND value_normalized = right(regexp_replace(raw_value, '\D', '', 'g'), 10);
--   SELECT count(*) FROM ci.identifier_claims
--    WHERE subject_type = 'person' AND role = 'self' AND kind = 'phone'
--      AND raw_value ~* '<the pattern above>';
--
-- Should be 0 outside merge survivors -- no live vCard Person still keyed on,
-- or holding, a truncation of its own typed extension:
--   SELECT count(*) FROM ci.entities e
--    WHERE e.entity_type = 'Person' AND e.linked_table = 'import:vcard'
--      AND e.merged_into_entity_id IS NULL
--      AND NOT EXISTS (SELECT 1 FROM ci.entities s WHERE s.merged_into_entity_id = e.entity_id)
--      AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(
--                    CASE WHEN jsonb_typeof(e.properties->'Phones')='array'
--                         THEN e.properties->'Phones' ELSE '[]'::jsonb END) p(v)
--                   WHERE p.v ~* '<the pattern above>'
--                     AND right(regexp_replace(p.v, '\D', '', 'g'), 10) = e.properties->>'phone');
--
-- The survivors this deliberately left alone, to review by hand:
--   the same query with the survivor condition inverted.
--
-- Should be UNCHANGED -- this migration deletes no entity, communication or
-- event, and retypes nothing:
--   SELECT entity_type, count(*) FROM ci.entities GROUP BY 1;

-- The SET LOCAL above outlives this file's statements, and dbmate records the
-- applied version in the SAME transaction against an unqualified
-- `schema_migrations`; with uuid-ossp's schema first in the path that insert
-- can resolve to the wrong schema. Restore the session default first.
RESET search_path;

-- migrate:down
-- No-op: irreversible data repair, same reasoning as 20260820000332. The keys
-- this removes were truncations belonging to nobody, the links it withdraws were
-- made by them, and nothing records which rows were touched versus already
-- correct, so there is no source of truth to roll back to.
