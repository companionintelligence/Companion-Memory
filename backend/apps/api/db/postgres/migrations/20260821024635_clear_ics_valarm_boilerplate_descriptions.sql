-- migrate:up
-- Repair: clear the alarm boilerplate "This is an event reminder" that the .ics
-- parser wrote into every VALARM-bearing calendar event's description.
--
-- ## The bug
--
-- `parseIcsEvents` (import/datasources/calendar.ts) split an .ics on
-- BEGIN:VEVENT and folded EVERY line of the block into ONE flat, last-wins
-- property map. RFC 5545 §3.6.6 nests VALARM INSIDE the VEVENT, and Apple and
-- Google both emit the alarm AFTER the event's own properties, so the alarm won
-- every property name it shares with its parent — and it always won, because it
-- came last:
--
--   DESCRIPTION  `This is an event reminder` replaced the event's real body.
--   UID          the alarm's UID became the event's `items.id`, hence
--                `ci.events.source_id`. The event was stored under its
--                REMINDER's identity.
--   SUMMARY /    legal on an ACTION:EMAIL alarm and equally clashing; absent
--   ATTENDEE /   from this corpus, but the same latent bug.
--   ATTACH
--
-- Fixed for future imports in the same commit: the property map is now built
-- from OUTER-level lines only (a generic BEGIN/END depth counter, not a VALARM
-- special case), and — because the corrected UID no longer distinguishes the
-- modified instances of a recurring series from their master — a block carrying
-- RECURRENCE-ID is keyed `<UID>#<RECURRENCE-ID>` per RFC 5545 §3.8.4.4.
--
-- ## Measured on the reference Apple Calendar export
--
-- /…/inbox/apple/calendar/<user>.ics — 1,143 VEVENTs, 1,136 of them carrying a
-- VALARM. Replaying the OLD parser's exact last-wins semantics over it:
--
--   1,136  events whose DESCRIPTION became `This is an event reminder`
--     996  of those had a REAL description that was destroyed, e.g. the
--          VEVENT `Meet w/ Liam (…)` whose body was
--          `<b>Booked by</b>\n…\nJoin with Google Meet: https://…`
--     140  had no description of their own, so only boilerplate was invented
--   1,137  events whose UID came from a VALARM instead of the VEVENT
--
-- Re-running the FIXED parser over the same file: 1,143 events, 1,143 distinct
-- ids, 0 boilerplate descriptions, 1,002 real descriptions, and the 10
-- RECURRENCE-ID overrides keyed apart from their 2 masters (keying on the
-- corrected UID alone would have collapsed those 12 blocks to 2 and let
-- `events_source_triple_uniq` drop the other 10).
--
-- ## Why this migration cannot restore the real text
--
-- Unlike a repair that recovers a value from a sibling row, THERE IS NO SOURCE
-- OF TRUTH LEFT IN THE DATABASE. The event's real DESCRIPTION was never
-- written — the alarm's value overwrote it before the push — and neither was
-- the event's real UID. Nothing in ci.events, ci.entities or ci.content holds
-- either. Only a RE-IMPORT of the .ics under the fixed parser can bring them
-- back. What this migration can do is stop the appliance from ASSERTING the
-- boilerplate: it is displayed as the event's description, it is indexed as the
-- event's body (weight B — `eventWeightedTexts` in search-ingress/searchTexts.ts
-- reads ci.entities.description), and it is embedded. A false body is strictly
-- worse than an absent one: an absent one shows the event as description-less,
-- which is what it is until the .ics is re-read.
--
-- Two independent reasons a re-import does NOT repair these rows in place, so
-- the clearing has to happen here:
--   1. `INGEST_REFRESH_COLUMNS.event` is `[]` — an idempotent re-push of the
--      same triple refreshes NOTHING on an event.
--   2. The fixed parser emits a DIFFERENT source_id (the event's UID, not the
--      alarm's), so the re-import does not land on these rows at all. It
--      INSERTS the corrected events alongside them. Operators re-importing a
--      calendar imported before this fix should expect the pre-fix rows to
--      remain as description-less duplicates and prune them; they are NOT
--      deleted here, because an appliance that never re-imports would otherwise
--      lose 1,140 real events (their summary, time and location were always
--      correct — only the body and the id were the alarm's).
--
-- ## Scope guards
--
-- Provenance first (`source_system = 'calendar'` AND `metadata->>'Source' =
-- 'ICS'`, the two stamps calendar.ts writes), then EXACT equality on the whole
-- string. A user-typed description that merely CONTAINS the sentence survives:
-- only a body that is nothing but the alarm boilerplate is the parser's.
--
-- Verified against the live appliance database before writing this migration:
--
--   SELECT ev.source_type, ev.source_system, ev.metadata->>'Source', count(*)
--     FROM ci.events ev
--    WHERE ev.metadata->>'Description' = 'This is an event reminder'
--    GROUP BY 1,2,3;
--   -- ci-import-tools | calendar | ICS | 1140   (one provenance, no other)
--
--   -- the two surfaces never disagree, so one predicate describes both:
--   SELECT count(*) FROM ci.events ev JOIN ci.entities e ON e.entity_id = ev.event_id
--    WHERE ev.metadata->>'Description' = 'This is an event reminder'
--      AND coalesce(e.description,'') <> 'This is an event reminder';
--   -- 0
--
--   -- nothing else in the corpus carries the string:
--   ci.entities.name 0 | ci.content.text 0 | ci.communications.content 0
--
-- Dry-run row counts (statements below, in order):
--   1. ci.entities.description  -> NULL        1140
--   2. ci.pipeline_state        DELETE         2280  (1140 x 2 stages)
--   3. ci.events.metadata       - Description  1140
--   689 calendar events carry a different (or no) description and are untouched.
--
-- ## Why the search index is re-armed by deleting LEDGER rows, not ci_search rows
--
-- The stale tsvector really does answer for these events — `'event':6B
-- 'remind':7B` is in every one of them, so a search for "reminder" returns all
-- 1,140. But DELETING ci_search.vectors is the wrong repair: `ci_search.vectors`
-- is the search CANDIDATE source, so a deleted row is an event that answers
-- NOTHING, including a search for its own (correct) title. Deleting the two
-- `index.*_event` ledger rows instead makes the sweep re-claim each event and
-- UPSERT (`ON CONFLICT (entity_type, entity_id) DO UPDATE`, vectorStages.ts /
-- DenseEmbedStageBase.ts) a vector and embedding built from the now-cleared
-- description. The old rows stay searchable in the meantime.
--
-- Exactly two stages, named explicitly. The live ledger also holds
-- clean.temporal_repair, enrich.estimate_location, enrich.geocode and
-- clean.identifier_normalize rows for these ids; an unfiltered delete would
-- re-arm four unrelated pipelines — including 600 `enrich.geocode` failures
-- that would be retried for no reason.
--
-- STATEMENT ORDER MATTERS. All three select on
-- `ev.metadata->>'Description'`, and statement 3 is what REMOVES that key, so it
-- has to run last or the first two match nothing.
--
-- Idempotent: statement 3 having run, no event carries the key, so a second run
-- selects zero rows in every statement. Statement 1 is independently idempotent
-- (it also requires `e.description` to still BE the boilerplate).

-- 1. The description the appliance displays. NULL, not '': a null description
--    is what every other description-less event carries, and `eventWeightedTexts`
--    tests it for truthiness either way.
UPDATE ci.entities e
   SET description = NULL,
       updated_at = now()
  FROM ci.events ev
 WHERE ev.event_id = e.entity_id
   AND ev.source_system = 'calendar'
   AND ev.metadata->>'Source' = 'ICS'
   AND ev.metadata->>'Description' = 'This is an event reminder'
   AND e.description = 'This is an event reminder';

-- 2. The ledger rows for the two search stages, so the sweep rewrites the
--    tsvector and the embedding from the cleared description. Deliberately
--    BEFORE the metadata strip below, which is what these two rows are
--    selected by.
DELETE FROM ci.pipeline_state ps
 USING ci.events ev
 WHERE ev.event_id = ps.entity_id
   AND ps.entity_type = 'event'
   AND ps.stage IN ('index.vector_event', 'index.embed_event')
   AND ev.source_system = 'calendar'
   AND ev.metadata->>'Source' = 'ICS'
   AND ev.metadata->>'Description' = 'This is an event reminder';

-- 3. The metadata key itself. Dropped rather than set to null: `metadata` is
--    the importer's own bag, and calendar.ts already omits `Description` for an
--    event that has none (`ev.description || undefined`), so an absent key is
--    the shape a description-less event has always had here. Kept last — the
--    two statements above select on it.
UPDATE ci.events ev
   SET metadata = ev.metadata - 'Description',
       updated_at = now()
 WHERE ev.source_system = 'calendar'
   AND ev.metadata->>'Source' = 'ICS'
   AND ev.metadata->>'Description' = 'This is an event reminder';

-- ## Post-migration verification
--
-- Should now be 0:
--   SELECT count(*) FROM ci.events WHERE metadata->>'Description' = 'This is an event reminder';
--   SELECT count(*) FROM ci.entities WHERE description = 'This is an event reminder';
--
-- Should be 1140, then fall to 0 as the index sweep re-processes them:
--   SELECT count(*) FROM ci.events ev
--    WHERE ev.source_system = 'calendar'
--      AND NOT EXISTS (SELECT 1 FROM ci.pipeline_state ps
--                       WHERE ps.entity_id = ev.event_id
--                         AND ps.stage = 'index.vector_event');
--
-- And the events themselves must all still be here:
--   SELECT count(*) FROM ci.events WHERE source_system = 'calendar';   -- 1829

-- migrate:down
-- No-op: irreversible data repair, same reasoning as
-- 20260819055246_repair_position_title_place_names. Writing the boilerplate back
-- would restore a sentence that describes a reminder the appliance does not
-- model, not the event — and the values it displaced were never recorded, so
-- there is nothing to roll back TO.
