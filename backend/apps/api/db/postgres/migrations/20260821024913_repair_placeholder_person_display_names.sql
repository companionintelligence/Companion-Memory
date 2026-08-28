-- migrate:up

-- Give the nameless contact cards back the display name the fixed push would
-- have written them: their own handle.
--
-- ## The bug this cleans up after
--
-- `datasources/vcard.ts` computes `const name = fn || structuredName`, which is
-- the EMPTY STRING for a card carrying neither `FN` nor `N` — 139 of them in one
-- Google Takeout `.vcf`, each one holding a perfectly good email address.
-- `push/entities.ts toGraphEntity` then wrote
--
--   name: (nameIsGarbage ? (handle ?? staged.name) : staged.name) ?? handle ?? null
--
-- and `??` does not catch `''`. So the fallback that exists for exactly this
-- case never fired, and `ci.entities.name` took the empty string while
-- `properties.email` sat beside it unused. The People view showed a blank row.
--
-- The forward fix (2026-08-21) is `usableName ?? handle ?? null` in
-- `toGraphEntity`, backed by a new `isPlaceholderPersonName` predicate in
-- `domains/graph/utils/placeholderPersonName.ts`. It repairs nothing that
-- already landed, which is this migration. Writing only the repair would be the
-- mistake 20260818220731 made and 20260819002002 had to undo: deleting the
-- output of a generator that is still running is theatre.
--
-- ## Scope, and why it is narrow
--
-- The predicate mirrors the TypeScript one exactly, and it is two shapes only:
--
--   1. a name with no letter and no digit anywhere in it (`!~ '[[:alnum:]]'`,
--      which for these rows means the empty string, but also covers "?", "-"
--      and an emoji-only display name);
--   2. a name equal to one of the closed generic-placeholder list.
--
-- On the QA corpus that is 139 rows and 0 rows respectively. The second arm
-- finds nothing today and is here so the repair and the predicate cannot drift:
-- a `Person` named "Unknown" is an identity ATTRACTOR, because
-- `ci.entity_identifiers` is UNIQUE on (owner_user_id, kind, value_normalized)
-- and one `name` row for "Unknown" therefore belongs to exactly one human while
-- every later participant called "Unknown" resolves to them.
--
-- `me`, `self`, `support`, `team`, `mom` and friends are deliberately NOT in the
-- list, here or in the TypeScript. Every one of them is a label somebody really
-- does file a human under, and this migration must not delete a name the export
-- honestly contained. The two live rows named "Me" and "support" are left alone
-- on purpose.
--
-- `is_self` rows are excluded (the owner is not a placeholder), as are rows not
-- minted by the import lane — `linked_table LIKE 'import:%'` is what makes the
-- producer and the repair the same population.
--
-- ## What is NOT touched
--
-- * `linked_id` / the natural key. `naturalKeyFor` reads `staged.name` and
--   prefers the HANDLE, and every row here has one — so its key was already
--   `contact:<email>` and this rename moves nothing. A re-import of the same
--   card is find-and-return, not a second row. (Contrast 20260819092314, where
--   the type moved and the key had to move with it.)
-- * `ci.entity_identifiers`. `toGraphEntity` never put a placeholder into
--   `properties.names`, because `stagedName` was falsy, so no `name`-kind row
--   was ever indexed from one — 0 on the corpus, and the `NOT EXISTS` arm of the
--   `properties` rewrite below keeps it that way for any row that has one.
-- * `ci_search.vectors` / `ci_search.embeddings`. No re-index is scheduled and
--   none is needed: `loadPersonRows` already selects `properties->>'email'` into
--   the person document, so the address these rows are being renamed TO is
--   already in their embedding. The lexical side needs nothing scheduled either
--   — `entities_search_vector_trigger` fires BEFORE UPDATE OF name and
--   recomputes `search_vector` as a side effect of the UPDATE below.

UPDATE ci.entities e
   SET name = COALESCE(e.properties->>'email', e.properties->>'phone'),
       -- The placeholder must not survive in `properties.names` either: that is
       -- the array `GraphIngestService` re-indexes into ci.entity_identifiers,
       -- so leaving it would put the identifier back on the next ingest that
       -- touches the row. Rewritten to the new display name where the key
       -- exists, removed where the row would otherwise be left claiming
       -- nothing. `- 'names'` on a bag without the key is a no-op.
       properties =
         CASE
           WHEN e.properties ? 'names'
             THEN jsonb_set(e.properties, '{names}',
                            jsonb_build_array(COALESCE(e.properties->>'email', e.properties->>'phone')))
           ELSE e.properties
         END,
       updated_at = now()
 WHERE e.entity_type = 'Person'
   AND e.linked_table LIKE 'import:%'
   AND COALESCE(e.is_self, false) = false
   AND e.name IS NOT NULL
   -- A handle to fall back to is the whole repair. Without one the honest
   -- answer is a NULL name, which is what the fixed `toGraphEntity` writes —
   -- but no such row exists on either corpus, and nulling a name is not worth
   -- doing blind, so those rows (if an appliance has any) are left for the
   -- merge flow rather than blanked here.
   AND COALESCE(e.properties->>'email', e.properties->>'phone') IS NOT NULL
   AND (
     -- (1) no letter and no digit anywhere: '', '   ', '?', '-', emoji-only.
     e.name !~ '[[:alnum:]]'
     -- (2) the closed generic-placeholder list, matched on the same normalized
     -- form the TypeScript uses: lower-cased, internal whitespace collapsed,
     -- and wrapping brackets/quotes plus trailing sentence punctuation stripped
     -- from the ENDS only (so "n/a" keeps its slash and "Jean-Luc" its hyphen).
     OR btrim(regexp_replace(lower(btrim(e.name)), '[[:space:]]+', ' ', 'g'), '()[]<>"''.!?-') IN (
          'unknown', 'unknown contact', 'unknown caller', 'unknown number', 'unknown sender',
          'no name', 'noname', 'unnamed', 'untitled', 'n/a', 'none', 'not available',
          'no caller id', 'private number', 'restricted', 'anonymous',
          'new contact', 'deleted contact')
   );

-- migrate:down

-- Irreversible by design, for the same reason 20260819092314 is: afterwards
-- every row this touched is byte-for-byte what the FIXED push would have
-- written, and a down migration keyed on that shape would blank the name of
-- every correctly-named contact card on an appliance that has imported since.
-- The pre-fix state is an empty display name; it is not worth restoring.
SELECT 1;
