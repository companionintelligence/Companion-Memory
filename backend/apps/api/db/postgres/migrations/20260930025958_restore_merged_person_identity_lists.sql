-- migrate:up

-- Give each merge survivor back the identity values its merged-away duplicates
-- brought in, which the next import of the survivor's own card then erased.
--
-- ## The bug this cleans up after
--
-- `PersonMergeService.foldProperties` unions each merged-away source's `emails`,
-- `phones` and `names` into the survivor's `properties` — and, since #2767
-- (2026-09-28), its typed `Phones`. Until the fix in
-- `domains/graph/utils/ingestedProperties.ts`, `GraphIngestService.upsertEntities`
-- refreshed an existing entity with `DO UPDATE SET properties = EXCLUDED.properties`
-- whenever anything differed, and a merge target's bag ALWAYS differs from its
-- own card, because the fold put its duplicates' values there. So the next
-- import of that card replaced the bag wholesale and every value the merge had
-- brought in vanished from the survivor. The fix makes the refresh a merge that
-- unions `IDENTITY_LIST_KEYS` on every re-ingest. It repairs nothing that
-- already landed, which is this migration.
--
-- Ship it WITH or AFTER that fix, never before: applied without it, the next
-- import of each survivor's card erases the values again, and dbmate never
-- re-runs a migration. (The statement below is idempotent, so running the
-- `migrate:up` half again by hand is safe if the census at the bottom ever finds
-- stragglers.)
--
-- ## Where the values come from
--
-- `ci.entity_merges.details.sourceProperties`. Every Person merge records the
-- source's whole bag as it stood at merge time (PersonMergeService, step 8), and
-- that audit row is the one copy the re-import could not reach.
--
-- ## Which merges count: the merge must still stand
--
--  * Its target must still be a Person. The survivor is the target itself while
--    that is live (`merged_into_entity_id IS NULL`, active); otherwise the row
--    the target was itself merged into later — ONE hop. `PersonMergeService`
--    re-points every tombstone at the new survivor (path compression, #1840,
--    2026-08-05), so a source merged into T before T was merged into U already
--    names U. A hop that lands on another tombstone is a chain made before
--    #1840; every reader in the codebase follows exactly one hop, and so does
--    this.
--  * The source's tombstone must still exist, still be a Person, and still point
--    at that survivor. A source a later repair deleted (20260819002002 deleted
--    call-log headings that had been minted as people) or retyped away
--    contributes nothing.
--  * Every join, and the write itself, is on `owner_user_id`: a merge row never
--    reaches another owner's rows.
--
-- ## A value must still be on the source's tombstone today
--
-- The snapshot is frozen history; the tombstone is the row every later repair
-- could reach, and several did — deliberately. 20260820000332 stripped Twitter
-- account ids that had been filed as `phones` from every stub it proved wrong,
-- tombstones included "on purpose"; 20260819002002 and 20260821024913 rewrote
-- junk `names`. A stub like that, merged into a real person before its repair,
-- left the fabricated value in the merge's snapshot, and restoring from the
-- snapshot alone would put a Twitter account id back on a real person as a
-- phone number. So a value comes back only if the snapshot held it AND the
-- source's tombstone still does. That also makes this file order-independent of
-- any later repair that corrects tombstones.
--
-- ## Nothing restored here was removed on purpose
--
-- Census of every write a user can reach (`PersonResolver`):
-- `addPersonIdentifier` / `removePersonIdentifier` change `ci.entity_identifiers`
-- only; `updatePerson` hands `contacts` to `EntityIdentifierService.replaceForEntity`
-- (identifiers only), and its properties patch carries structured-name,
-- profile and address keys, never one of these lists; `mergePeople` unions.
-- No user action removes a member of these lists from `properties`, so one
-- missing from a survivor was lost, not declined — and it is restored without
-- asking. (Whether a user removed the matching IDENTIFIER is a separate
-- question, and the reason `ci.entity_identifiers` is left alone below.)
--
-- One code path does empty a survivor's bag on purpose: #2795's re-key of a
-- collapsed contact (colleagues keyed on one office line) resets the row's
-- properties and rebuilds it from its heir's card alone. It aims at the
-- colleagues' names and addresses, and it keeps the row's merges with the heir
-- ("its edges, identifiers, merges and search index come with it") — so the
-- values those merges brought in are treated the same way here, and restored.
-- A reset that runs AFTER this migration drops them again; that is for the
-- re-key to preserve, not something a one-shot repair can.
--
-- ## What is restored, and how
--
-- The keys are `IDENTITY_LIST_KEYS`: `emails`, `phones`, `names`, `Phones`,
-- `Faxes`. A source value is read the way `foldProperties` reads it: a string
-- that is not blank under JavaScript's `trim()`, taken from an array — or, for
-- `Phones` / `Faxes`, from a lone string too. Nothing a merge could not have
-- folded is offered.
--
-- It is appended after the survivor's own members, which keep their order;
-- nothing is removed or reordered, and a lone scalar becomes a one-element list
-- only when something is appended to it. A value the survivor already holds is
-- skipped: `emails` / `phones` / `names` compare by jsonb equality; `Phones` /
-- `Faxes` by digit string (by trimmed text when there are no digits), first
-- formatting seen kept — `foldProperties`' own rule. Appended order: merges into
-- the survivor itself before those reached through a hop, then the oldest
-- merge first, then the source's own list order.
--
-- Two older gaps close as a side effect, on purpose. Merges before #2767 kept
-- the target's `Phones` and dropped the source's (target wins), and `Faxes` is
-- still folded that way until the fold unions it too. Both end in the state
-- the current fold produces, and `ingestedProperties` unions both keys from now
-- on.
--
-- ## Not touched, and what is re-opened
--
-- * `ci.entity_identifiers` is not backfilled, deliberately. The merge
--   re-pointed each source's identifier rows to its target
--   (`repointReferences`), and nothing on the ingest path deletes an identifier
--   row, so the common case never lost its row. What else can be missing is a
--   value another Person claimed first (first writer wins; nothing to do), one
--   the normalizer refuses, or one a user deleted through
--   `removePersonIdentifier` / `updatePerson` — which leave no trace, so a
--   migration cannot tell "never indexed" from "removed on purpose". And the key
--   is TypeScript's (`normalizeIdentifier`): a SQL copy that disagreed would
--   squat the UNIQUE (owner, kind, value) slot for good. Indexing these lists is
--   `EntityIdentifierBackfillService`'s job — the real normalizer, first writer
--   wins, never deletes. It is not scheduled: it runs as the
--   `index_entity_identifiers` leg of `POST /api/maintenance/orchestrate` (and of
--   `POST /v1/ingest/finish` without a stage list), or alone through
--   `POST /api/maintenance/index-entity-identifiers`. The fixed import will not
--   do it for a survivor: it indexes the handles the incoming card sends, not
--   the stored bag.
-- * Search and enrichment ARE re-opened. `personWeightedTexts` puts the stripped
--   properties bag into the lexical `ci_search.vectors` row (the embedding's
--   `personSearchDocument` leaves these lists out), and `enrich.person_self_claim`
--   turns `emails` / `phones` into the claims `clean.duplicate_detect` groups on.
--   The ledger re-offers a row only when it has no ledger row, an older stage
--   version, or a due retry — an edit to the row counts for nothing — so each
--   repaired survivor's `ci.pipeline_state` rows are deleted in the same
--   statement. All four Person stages are local, and the two index stages
--   upsert in place, so the person stays searchable until they run.
-- * `ci.graph_deltas` records nothing: this puts back values the graph already
--   held, and that feed narrates change.
-- * Everything else in the bag. The fold also copied a source's scalars into
--   keys the target lacked, and the re-import erased those too; they are not
--   identity, and a snapshot cannot say whether the card's later silence about
--   them meant removal.

-- JavaScript's String.prototype.trim, which is what `foldProperties` calls: the
-- WhiteSpace and LineTerminator code points, listed rather than read from
-- `[[:space:]]`, whose members depend on the database's locale.
CREATE FUNCTION pg_temp.js_trim(value text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT regexp_replace(value,
    '^[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+'
    '|[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$',
    '', 'g')
$$;

-- A stored list key as a list, read the way `ingestedProperties` reads a set
-- key: an array as it is, a lone value as a list of one, absent or JSON null
-- as empty.
CREATE FUNCTION pg_temp.as_list(value jsonb) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT CASE
           WHEN value IS NULL OR jsonb_typeof(value) = 'null' THEN '[]'::jsonb
           WHEN jsonb_typeof(value) = 'array' THEN value
           ELSE jsonb_build_array(value)
         END
$$;

-- What two members of `key` must share to be the same value: the member
-- itself, for the normalized lists; for the typed `Phones` / `Faxes`, its digit
-- string, or its trimmed text when it has no digits. A typed member that is not
-- a string matches nothing, as `foldProperties` ignores it. `[^0-9]`, not
-- `\D`: JavaScript's `\D` is ASCII, Postgres' follows the locale.
CREATE FUNCTION pg_temp.member_key(key text, member jsonb) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT CASE
           WHEN key NOT IN ('Phones', 'Faxes') THEN member
           WHEN jsonb_typeof(member) = 'string'
             THEN to_jsonb(COALESCE(NULLIF(regexp_replace(member #>> '{}', '[^0-9]', '', 'g'), ''),
                                    pg_temp.js_trim(member #>> '{}')))
         END
$$;

WITH standing AS (
  -- Every Person merge that still stands, with the survivor it now belongs to.
  SELECT m.merge_id,
         m.created_at,
         m.owner_user_id,
         survivor.entity_id                       AS survivor_id,
         survivor.entity_id <> m.target_entity_id AS rerouted,
         m.details -> 'sourceProperties'          AS snapshot,
         source.properties                        AS tombstone
    FROM ci.entity_merges m
    JOIN ci.entities target
      ON target.entity_id = m.target_entity_id
     AND target.owner_user_id = m.owner_user_id
    JOIN ci.entities survivor
      ON survivor.entity_id = COALESCE(target.merged_into_entity_id, target.entity_id)
     AND survivor.owner_user_id = m.owner_user_id
    JOIN ci.entities source
      ON source.entity_id = m.source_entity_id
     AND source.owner_user_id = m.owner_user_id
   WHERE m.entity_type = 'Person'
     AND jsonb_typeof(m.details -> 'sourceProperties') = 'object'
     AND target.entity_type = 'Person'
     AND survivor.entity_type = 'Person'
     AND survivor.merged_into_entity_id IS NULL
     AND COALESCE(survivor.is_active, TRUE)
     AND source.entity_type = 'Person'
     AND source.merged_into_entity_id = survivor.entity_id
),
offered AS (
  -- Each identity value a source held at merge time, read as `foldProperties`
  -- reads it, that its tombstone still holds today.
  SELECT s.survivor_id,
         s.owner_user_id,
         k.key,
         v.value,
         pg_temp.member_key(k.key, v.value) AS match,
         s.rerouted,
         s.created_at,
         s.merge_id,
         v.position
    FROM standing s
   CROSS JOIN (VALUES ('emails'), ('phones'), ('names'), ('Phones'), ('Faxes')) AS k(key)
   CROSS JOIN LATERAL jsonb_array_elements(
           CASE
             WHEN jsonb_typeof(s.snapshot -> k.key) = 'array' THEN s.snapshot -> k.key
             WHEN k.key IN ('Phones', 'Faxes') AND jsonb_typeof(s.snapshot -> k.key) = 'string'
               THEN jsonb_build_array(s.snapshot -> k.key)
             ELSE '[]'::jsonb
           END) WITH ORDINALITY AS v(value, position)
   WHERE jsonb_typeof(v.value) = 'string'
     AND pg_temp.js_trim(v.value #>> '{}') <> ''
     AND EXISTS (
           SELECT 1
             FROM jsonb_array_elements(pg_temp.as_list(s.tombstone -> k.key)) AS kept(value)
            WHERE pg_temp.member_key(k.key, kept.value) = pg_temp.member_key(k.key, v.value))
),
candidates AS (
  -- One per survivor, key and value (by that key's rule): the first offered.
  SELECT DISTINCT ON (survivor_id, key, match) *
    FROM offered
   ORDER BY survivor_id, key, match, rerouted, created_at, merge_id, position
),
restored AS (
  -- The bag is read at the row lock, not from the CTEs' snapshot: an import or
  -- merge that commits while this runs is merged into, not overwritten.
  UPDATE ci.entities e
     SET properties = COALESCE(e.properties, '{}'::jsonb) || COALESCE((
           SELECT jsonb_object_agg(added.key, pg_temp.as_list(e.properties -> added.key) || added.members)
             FROM (SELECT c.key,
                          jsonb_agg(c.value ORDER BY c.rerouted, c.created_at, c.merge_id, c.position) AS members
                     FROM candidates c
                    WHERE c.survivor_id = e.entity_id
                      AND NOT EXISTS (
                            SELECT 1
                              FROM jsonb_array_elements(pg_temp.as_list(e.properties -> c.key)) AS held(value)
                             WHERE pg_temp.member_key(c.key, held.value) = c.match)
                    GROUP BY c.key) AS added
         ), '{}'::jsonb),
         updated_at = now()
   WHERE (e.entity_id, e.owner_user_id) IN (SELECT survivor_id, owner_user_id FROM candidates)
     AND e.entity_type = 'Person'
     AND e.merged_into_entity_id IS NULL
     AND COALESCE(e.is_active, TRUE)
     -- SQL NULL is an empty bag; any other non-object is left for a human,
     -- since `||` on it would not merge.
     AND jsonb_typeof(COALESCE(e.properties, '{}'::jsonb)) = 'object'
     AND EXISTS (
           SELECT 1
             FROM candidates c
            WHERE c.survivor_id = e.entity_id
              AND NOT EXISTS (
                    SELECT 1
                      FROM jsonb_array_elements(pg_temp.as_list(e.properties -> c.key)) AS held(value)
                     WHERE pg_temp.member_key(c.key, held.value) = c.match))
  RETURNING e.entity_id
)
-- Re-offer each repaired survivor to every pipeline stage (see the header). By
-- `entity_id` alone: the four Person stages write three `entity_type` spellings
-- into the ledger — 'person' (both index stages), 'Person' (the self claim),
-- 'entity' (the duplicate detector).
DELETE FROM ci.pipeline_state ps
 USING restored r
 WHERE ps.entity_id = r.entity_id;

DROP FUNCTION pg_temp.member_key(text, jsonb);
DROP FUNCTION pg_temp.as_list(jsonb);
DROP FUNCTION pg_temp.js_trim(text);

-- ## Idempotent
--
-- A second run finds every value already held, updates no row, and so re-opens
-- no ledger row either.
--
-- ## Post-migration verification
--
-- What is still missing, per key — the rows this file restores when run before
-- it, and none afterwards (bar a survivor erased again by an import on the old
-- API between this migration and the new one taking over):
--
--   WITH standing AS (
--     SELECT m.merge_id, m.created_at, survivor.entity_id AS survivor_id,
--            survivor.properties AS held, m.details -> 'sourceProperties' AS snapshot,
--            source.properties AS tombstone
--       FROM ci.entity_merges m
--       JOIN ci.entities target ON target.entity_id = m.target_entity_id
--                              AND target.owner_user_id = m.owner_user_id
--       JOIN ci.entities survivor
--         ON survivor.entity_id = COALESCE(target.merged_into_entity_id, target.entity_id)
--        AND survivor.owner_user_id = m.owner_user_id
--       JOIN ci.entities source ON source.entity_id = m.source_entity_id
--                              AND source.owner_user_id = m.owner_user_id
--      WHERE m.entity_type = 'Person' AND jsonb_typeof(m.details -> 'sourceProperties') = 'object'
--        AND target.entity_type = 'Person'
--        AND survivor.entity_type = 'Person' AND survivor.merged_into_entity_id IS NULL
--        AND COALESCE(survivor.is_active, TRUE)
--        AND jsonb_typeof(COALESCE(survivor.properties, '{}'::jsonb)) = 'object'
--        AND source.entity_type = 'Person' AND source.merged_into_entity_id = survivor.entity_id
--   ), member AS (
--     SELECT s.merge_id, s.survivor_id, k.key, side.side, x.value,
--            CASE WHEN k.key NOT IN ('Phones', 'Faxes') THEN x.value
--                 WHEN jsonb_typeof(x.value) = 'string'
--                   THEN to_jsonb(COALESCE(NULLIF(regexp_replace(x.value #>> '{}', '[^0-9]', '', 'g'), ''),
--                                          t.trimmed)) END AS match,
--            t.trimmed
--       FROM standing s
--      CROSS JOIN (VALUES ('emails'), ('phones'), ('names'), ('Phones'), ('Faxes')) AS k(key)
--      CROSS JOIN LATERAL (VALUES
--              ('offered', CASE WHEN jsonb_typeof(s.snapshot -> k.key) = 'array' THEN s.snapshot -> k.key
--                               WHEN k.key IN ('Phones', 'Faxes') AND jsonb_typeof(s.snapshot -> k.key) = 'string'
--                                 THEN jsonb_build_array(s.snapshot -> k.key) ELSE '[]' END),
--              ('kept', s.tombstone -> k.key), ('held', s.held -> k.key)) AS side(side, list)
--      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(side.list) = 'array' THEN side.list
--                                                   WHEN side.list IS NULL OR jsonb_typeof(side.list) = 'null' THEN '[]'
--                                                   ELSE jsonb_build_array(side.list) END) AS x(value)
--      CROSS JOIN LATERAL (SELECT regexp_replace(x.value #>> '{}',
--              '^[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$',
--              '', 'g') AS trimmed) AS t
--   )
--   SELECT o.key, count(DISTINCT o.survivor_id) AS survivors, count(DISTINCT (o.survivor_id, o.match)) AS "values"
--     FROM member o
--    WHERE o.side = 'offered' AND jsonb_typeof(o.value) = 'string' AND o.trimmed <> ''
--      AND EXISTS (SELECT 1 FROM member k WHERE k.side = 'kept' AND k.merge_id = o.merge_id
--                     AND k.key = o.key AND k.match = o.match)
--      AND NOT EXISTS (SELECT 1 FROM member h WHERE h.side = 'held' AND h.survivor_id = o.survivor_id
--                         AND h.key = o.key AND h.match = o.match)
--    GROUP BY o.key ORDER BY o.key;
--
-- Should be UNCHANGED: this migration adds members to lists and deletes only
-- ledger rows; no entity, identifier or merge row is created or deleted.
--   SELECT entity_type, count(*) FROM ci.entities GROUP BY 1;
--   SELECT kind, count(*) FROM ci.entity_identifiers GROUP BY 1;

-- migrate:down
-- No-op: an irreversible data repair, like the other repairs here. What it adds
-- is what the survivors held before an import erased it, and nothing records
-- which members were appended, so there is no earlier state to return to that
-- would not re-create the bug.
