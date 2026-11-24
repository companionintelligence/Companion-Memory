-- migrate:up

-- Take the FABRICATED PHONE NUMBERS that office-line extensions were truncated
-- into out of everything that matches on them.
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
--   * `properties.phone` / `.phones`, which `enrich.person_self_claim` turns
--     into the claims the duplicate detector groups on;
--   * the display name, when the card had no usable one -- and a numeric name
--     the detector reads as another phone number;
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
-- extension, 2 whose handle was a truncation (the other 17 had a smaller
-- handle, so the truncation never became their key). Neither fabricated
-- number appears anywhere else in the corpus, so on that corpus the exposure is
-- latent -- no communication or event can have matched either one. The
-- statements that withdraw links are written for the appliance where one did.
--
-- ## What this does NOT do: move natural keys
--
-- A truncation was also a contact's natural key (`contact:5550147229`, hashed
-- into `linked_id`). This file leaves every `linked_id` where it is. Since
-- 20260930021527 a contact's key also depends on which of its handles the
-- export SHARES with other cards (a fax, a switchboard), and that is decided
-- per export and survives nowhere a migration can read -- so the key the fixed
-- parser will choose cannot be computed here. The push computes it instead:
-- `legacyEntityIdentityKey` reproduces the truncating rule, so the next import
-- of the same card finds its row under the old key and moves it onto the new
-- one before ingest (`push/legacyKeys.ts`), for every contact source. A
-- `linked_id` is only ever read by that ingest, so leaving it until then
-- matches nobody's calls.
--
-- ## Agreed with 20260930022046
--
-- That migration (index every contact method a card states) removes the same
-- fakes from the same rows, and the two may run in either order. They use one
-- definition, so whichever runs second finds nothing left to do:
--
--   * a FAKE is the old key of a value in the card's own typed `Phones` that
--     carries an extension (`PHONE_EXTENSION_PATTERN`, restated verbatim
--     below; `normalizeIdentifier.spec.ts` pins it), with at least seven
--     digits, that no plain line of the same card also produces;
--   * only live, unmerged Persons, and never a merge SURVIVOR: `PersonMergeService`
--     unions `phones` and `Phones` across a merge, so on a survivor the same
--     ten digits may also be a merged-in record's real number;
--   * a fake identifier row goes whatever its `source` or `verified_at` --
--     `EntityIdentifierService.replaceForEntity` has stamped every indexed row
--     the person form round-tripped as user-verified, fakes included, so
--     neither says a person chose it -- but only where its `raw_value` is
--     NULL. A row with a raw value was typed by a person; one that carries an
--     extension is population B below, and a plain one stays.
--
-- ## Populations, and what is recomputable
--
--   A. Persons that keep their typed numbers in `properties.Phones` (the vCard
--      parser always has). The fake is provable from the row itself.
--   B. `ci.entity_identifiers` rows whose OWN `raw_value` carries an extension
--      and whose key is that value's last ten digits -- a number typed into
--      the person form. The typed string is copied into `properties.phones`,
--      where the Details card shows it and every matcher now refuses it, and
--      the row goes.
--
--   NOT recomputable: rows from Apple Contacts and CSV contact lists imported
--   before those parsers kept `Phones`. Nothing on the row separates their
--   truncation from a real ten-digit number, so they are left alone here.
--   The push-time move above re-keys them at their next import; their fake
--   identifier row outlives that and needs the import-side repair.

-- ---------------------------------------------------------------------------
-- The rule, once. Session-local functions, dropped at the bottom, so every
-- statement below reads the same definition.
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

-- A jsonb value's strings, as text rows: an array's string elements, a lone
-- string, or nothing. Object elements (the Google Contacts `{value, type}`
-- shape) are not handles and are skipped, as every reader of these keys skips
-- them.
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
-- Population A: the fakes a card's own typed numbers prove.
-- ---------------------------------------------------------------------------

-- One row per (Person, fake key). `written` is the typed value with a `tel:`
-- scheme dropped, as 20260930022046 reads it; a PLAIN line is one written like
-- a number (`^\+?[0-9 ().\-/]+$`), with seven or more digits, carrying no
-- extension, and not a line the card files as a fax.
CREATE TEMP TABLE _ext_card ON COMMIT DROP AS
WITH card AS (
  SELECT e.entity_id, e.owner_user_id, e.name, e.properties
    FROM ci.entities e
   WHERE e.entity_type = 'Person'
     AND COALESCE(e.is_active, true) = true
     AND e.merged_into_entity_id IS NULL
     AND e.properties ? 'Phones'
     AND NOT EXISTS (SELECT 1 FROM ci.entities s WHERE s.merged_into_entity_id = e.entity_id)
),
typed AS (
  SELECT c.entity_id, btrim(regexp_replace(btrim(t.v), '^tel:', '', 'i')) AS written
    FROM card c
    CROSS JOIN LATERAL pg_temp.jsonb_strings(c.properties -> 'Phones') AS t(v)
),
fax AS (
  SELECT c.entity_id, pg_temp.phone_old_key(f.v) AS old_key
    FROM card c
    CROSS JOIN LATERAL pg_temp.jsonb_strings(c.properties -> 'Faxes') AS f(v)
),
fake AS (
  SELECT DISTINCT t.entity_id, pg_temp.phone_old_key(t.written) AS old_key
    FROM typed t
   WHERE pg_temp.phone_has_extension(t.written)
     AND length(regexp_replace(t.written, '\D', '', 'g')) >= 7
)
SELECT c.entity_id, c.owner_user_id, f.old_key, c.name = f.old_key AS named_for_it
  FROM fake f
  JOIN card c ON c.entity_id = f.entity_id
 WHERE NOT EXISTS (
         SELECT 1
           FROM typed t
          WHERE t.entity_id = f.entity_id
            AND t.written ~ '^\+?[0-9[:space:]().\-/]+$'
            AND NOT pg_temp.phone_has_extension(t.written)
            AND length(regexp_replace(t.written, '\D', '', 'g')) >= 7
            AND pg_temp.phone_old_key(t.written) = f.old_key
            AND NOT EXISTS (SELECT 1 FROM fax x WHERE x.entity_id = t.entity_id AND x.old_key = f.old_key));

CREATE INDEX ON _ext_card (entity_id);

-- (A1) The record. Each fake leaves `phones`; `phone` falls back to the first
-- number left, or goes. A row named for its fake loses the name: `toGraphEntity`
-- only names a Person after its handle when the card's own name was unusable,
-- and the fixed import names it after its real handle, or nothing. Nothing is
-- added -- the lists stay exactly as the import and any merge left them, minus
-- the fakes. Only a row this actually changes is written, and those are
-- remembered: they are the rows whose search index and ledger are reset below.
CREATE TEMP TABLE _ext_changed (entity_id uuid PRIMARY KEY) ON COMMIT DROP;

WITH fakes AS (
  SELECT entity_id, array_agg(old_key) AS keys, bool_or(named_for_it) AS named_for_it
    FROM _ext_card
   GROUP BY entity_id
),
target AS (
  SELECT e.entity_id,
         p.phones,
         CASE WHEN f.named_for_it THEN NULL ELSE e.name END AS new_name,
         CASE
           WHEN NOT e.properties ? 'phone' OR NOT (e.properties ->> 'phone' = ANY (f.keys)) THEN e.properties -> 'phone'
           ELSE p.phones -> 0
         END AS phone
    FROM fakes f
    JOIN ci.entities e ON e.entity_id = f.entity_id
    CROSS JOIN LATERAL (
      SELECT COALESCE(jsonb_agg(a.el ORDER BY a.ord), '[]'::jsonb) AS phones
        FROM jsonb_array_elements(CASE jsonb_typeof(e.properties -> 'phones')
                                    WHEN 'array'  THEN e.properties -> 'phones'
                                    WHEN 'string' THEN jsonb_build_array(e.properties -> 'phones')
                                    ELSE '[]'::jsonb
                                  END) WITH ORDINALITY AS a(el, ord)
       WHERE NOT (jsonb_typeof(a.el) = 'string' AND a.el #>> '{}' = ANY (f.keys))
    ) p
),
rebuilt AS (
  SELECT t.entity_id,
         t.new_name,
         (e.properties - 'phones' - 'phone')
         || CASE WHEN e.properties ? 'phones' AND jsonb_array_length(t.phones) > 0
                 THEN jsonb_build_object('phones', t.phones) ELSE '{}'::jsonb END
         || CASE WHEN t.phone IS NOT NULL AND jsonb_typeof(t.phone) <> 'null'
                 THEN jsonb_build_object('phone', t.phone) ELSE '{}'::jsonb END AS new_properties
    FROM target t
    JOIN ci.entities e ON e.entity_id = t.entity_id
),
changed AS (
  UPDATE ci.entities e
     SET properties = r.new_properties,
         name = r.new_name,
         updated_at = now()
    FROM rebuilt r
   WHERE e.entity_id = r.entity_id
     AND (e.properties IS DISTINCT FROM r.new_properties OR e.name IS DISTINCT FROM r.new_name)
  RETURNING e.entity_id
)
INSERT INTO _ext_changed SELECT entity_id FROM changed;

-- (A2) The identifier with teeth -- see the agreement above for why `source`
-- and `verified_at` are not a reason to keep it, and why `raw_value` is.
DELETE FROM ci.entity_identifiers ei
 USING _ext_card c
 WHERE ei.entity_id = c.entity_id
   AND ei.owner_user_id IS NOT DISTINCT FROM c.owner_user_id
   AND ei.kind = 'phone'
   AND ei.value_normalized = c.old_key
   AND ei.raw_value IS NULL;

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
   AND ei.value_normalized = t.old_key
   AND ei.raw_value = t.typed;

-- ---------------------------------------------------------------------------
-- Self claims. `enrich.person_self_claim` upserts; the v2 re-run re-derives
-- what the records now state, but only a retracting producer would remove a
-- claim the record stopped stating, so these go here.
-- ---------------------------------------------------------------------------

DELETE FROM ci.identifier_claims c
 USING _ext_card f
 WHERE c.owner_user_id = f.owner_user_id
   AND c.subject_type = 'person'
   AND c.role = 'self'
   AND c.subject_id = f.entity_id
   AND c.kind = 'phone'
   AND c.value_normalized = f.old_key
   AND c.raw_value IS NULL;

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
-- merging append), so a column a fake filled keeps its wrong person once the
-- key resolves to nobody. Withdrawn here, from the claims that recorded why
-- each link exists.
-- ---------------------------------------------------------------------------

-- Every (Person, key) this file proved fake that the Person no longer holds as
-- an identifier. Computed from the proof, not from what was deleted, so the
-- links still come out when 20260930022046 ran first and took the identifier;
-- and a key the Person still holds because a person typed it stays linked.
CREATE TEMP TABLE _ext_withdrawn ON COMMIT DROP AS
SELECT DISTINCT c.owner_user_id, c.entity_id, c.old_key
  FROM _ext_card c
 WHERE c.owner_user_id IS NOT NULL
   AND NOT EXISTS (SELECT 1
                     FROM ci.entity_identifiers ei
                    WHERE ei.owner_user_id = c.owner_user_id
                      AND ei.entity_id = c.entity_id
                      AND ei.kind = 'phone'
                      AND ei.value_normalized = c.old_key)
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
-- Order is kept -- positional readers of the recipient list rely on it.
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
-- `properties.phones` states them) could never index them while the fake sat
-- there. Indexed now, in `EntityIdentifierBackfillService`'s order (oldest
-- first), so the re-run resolves their calls to them -- the index the appliance
-- would hold had the fake never been written.
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
       AND NOT EXISTS (SELECT 1 FROM _ext_card c WHERE c.entity_id = e.entity_id)
  ) h
  JOIN (SELECT DISTINCT owner_user_id, old_key FROM _ext_withdrawn) w
    ON w.owner_user_id = h.owner_user_id
   AND w.old_key = h.phone_key
 ORDER BY h.owner_user_id, h.phone_key, h.created_at, h.entity_id
ON CONFLICT (owner_user_id, kind, value_normalized) DO NOTHING;

-- ---------------------------------------------------------------------------
-- The search index and the ledger, for every row whose name or
-- `properties.phone` changed here -- and every row whose stored vector still
-- answers to its fake, which is how a row 20260930022046 already cleaned (it
-- touches no index) gets its index rewritten too. `personSearchDocument`
-- indexes both fields, so the stored vector answers to the fabricated number
-- until it is rewritten, and `SearchIndexBackfillService` never revisits a row
-- that has an embedding. Deleting the ledger rows as well re-opens every
-- entity-keyed stage for these rows -- the index legs, the self claim, the
-- duplicate detector -- which is the whole of "this row changed underneath
-- you". Neither half selects a row twice: the fake is gone from both the
-- record and the vector once they are rebuilt.
-- ---------------------------------------------------------------------------

INSERT INTO _ext_changed
SELECT DISTINCT c.entity_id
  FROM _ext_card c
  JOIN ci_search.vectors vv ON vv.entity_id = c.entity_id
 WHERE vv.vector @@ to_tsquery('simple', c.old_key)
ON CONFLICT (entity_id) DO NOTHING;

DELETE FROM ci_search.embeddings em USING _ext_changed c WHERE em.entity_id = c.entity_id;

DELETE FROM ci_search.vectors vv USING _ext_changed c WHERE vv.entity_id = c.entity_id;

DELETE FROM ci_search.index_skips sk USING _ext_changed c WHERE sk.entity_id = c.entity_id;

DELETE FROM ci.pipeline_state ps USING _ext_changed c WHERE ps.entity_id = c.entity_id;

DROP FUNCTION pg_temp.jsonb_strings(jsonb);
DROP FUNCTION pg_temp.phone_key(text);
DROP FUNCTION pg_temp.phone_old_key(text);
DROP FUNCTION pg_temp.phone_has_extension(text);

-- ## Idempotency
--
-- Every working set is computed once into temp tables dropped on commit. A
-- second run still proves the same fakes (the typed `Phones` are untouched),
-- but every statement on them is a no-op: the lists and name already match
-- (so nothing is written, and the index and ledger are not reset again), the
-- identifier rows and claims are gone, and a withdrawn link has no claim
-- resolving it any more. Verified against a seeded copy of the schema by
-- checksumming every table this file writes before and after a second run.
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
-- Merge survivors are left alone by design; the ones still holding a fake,
-- to review by hand:
--   SELECT e.entity_id, e.name FROM ci.entities e
--    WHERE e.entity_type = 'Person' AND e.merged_into_entity_id IS NULL
--      AND EXISTS (SELECT 1 FROM ci.entities s WHERE s.merged_into_entity_id = e.entity_id)
--      AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(
--                    CASE WHEN jsonb_typeof(e.properties->'Phones')='array'
--                         THEN e.properties->'Phones' ELSE '[]'::jsonb END) p(v)
--                   WHERE p.v ~* '<the pattern above>'
--                     AND e.properties->'phones' ? right(regexp_replace(p.v, '\D', '', 'g'), 10));
--
-- Should be UNCHANGED -- this migration deletes no entity, communication or
-- event, retypes nothing, and moves no `linked_id`:
--   SELECT entity_type, count(*) FROM ci.entities GROUP BY 1;

-- migrate:down
-- No-op: irreversible data repair, same reasoning as 20260820000332. The keys
-- this removes were truncations belonging to nobody, the links it withdraws were
-- made by them, and nothing records which rows were touched versus already
-- correct, so there is no source of truth to roll back to.
