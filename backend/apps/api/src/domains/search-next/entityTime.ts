/**
 * Each indexed row's OWN time, as SQL over the index row (`entity_type`, `entity_id`): when a
 * message was sent, an event starts, a note was written. The index carries only when it was
 * indexed, which for an import is the import's date, so "most recent" cannot be answered from
 * the index alone. A scalar subquery per type is a primary-key lookup, and it runs only for the
 * rows the lexical predicate already matched, so a page over thousands of matches stays cheap.
 * Types with no meaningful time of their own (a position's key is its time; an item has no
 * table) give NULL, which sorts last and is excluded by any window.
 *
 * A place's time is its most recent visit: the start of the latest event held there. The
 * place row's own `created_at` is when the pipeline promoted it, and places are promoted in
 * bursts, so under that rule every promotion run pushed a wall of addresses to the top of
 * "most recent" (seen on the phone, 2026-10-26). A place nobody has been to yet has no time.
 * `events_location_entity_idx` makes the lookup an index probe; the shared index statement
 * also advances the stored time whenever an event at the place is indexed, so it keeps up
 * with new visits without re-indexing the place.
 *
 * A photo's or a video's time is when it was taken: the start of the media event its content row
 * links (`ci.content.event_id`), which the import (from EXIF or the container) and a phone
 * capture both set. The content row's `created_at` is when it was imported, and an import lands
 * a whole library in minutes, so under that rule "most recent" was import order (seen
 * 2026-11-11: 1,900 photos from a Drive import, all one evening, 2019 shots sorted beside
 * 2026 ones). A file follows its content row to the same event (the rows ContentService
 * `findIdsByFileIds` treats as its wrapper: kind 'file', or none on older rows). Never
 * `ci.files.event_id`: that is the event a file was captured alongside (a screenshot's
 * desktop-activity tick), not when a photo was taken. A photo or video with no media event has no time (NULL: last under "most
 * recent", outside any window), not its import time, which would put every undated photo above
 * every dated one; only a taken-at source dates a photo. Content and files that are not media (a
 * Drive document, a YouTube like, a PDF) keep their own time.
 *
 * `alias` is required, and must name the index row's table. Inside each subquery a bare
 * `entity_id` binds to the subquery's own table first, and `ci.entities` has one: unqualified,
 * the person / concept lookup read `en.entity_id = en.entity_id`, matched every entity, and
 * Postgres failed the whole search with "more than one row returned by a subquery used as an
 * expression" (seen 2026-11-13: every `sort: 'recent'` keyword search whose matches included
 * a person).
 */
export function entityTimeSql(alias: string): string {
  const type = `${alias}.entity_type`;
  const id = `${alias}.entity_id`;

  return `(CASE ${type}
    WHEN 'communication' THEN (SELECT c.time FROM ci.communications c WHERE c.id = ${id})
    WHEN 'event' THEN (SELECT e.start_time FROM ci.events e WHERE e.event_id = ${id})
    WHEN 'note' THEN (SELECT n.created_at FROM ci.notes n WHERE n.id = ${id})
    WHEN 'content' THEN (
      SELECT CASE WHEN ct.type = 'media'
                  THEN (SELECT me.start_time FROM ci.events me WHERE me.event_id = ct.event_id)
                  ELSE ct.created_at END
        FROM ci.content ct WHERE ct.id = ${id})
    WHEN 'file' THEN (
      SELECT COALESCE(
               (SELECT min(fe.start_time)
                  FROM ci.content fc JOIN ci.events fe ON fe.event_id = fc.event_id
                 WHERE fc.user_id = f.user_id AND fc.external_id = f.id::text
                   AND (fc.external_id_kind = 'file' OR fc.external_id_kind IS NULL)),
               CASE WHEN f.content_type ~* '^(image|video)/' THEN NULL
                    ELSE COALESCE(f.external_created_at, f.created_at) END)
        FROM ci.files f WHERE f.id = ${id})
    WHEN 'file-chunk' THEN (SELECT fc.created_at FROM ci.file_chunks fc WHERE fc.id = ${id})
    WHEN 'message' THEN (SELECT m.created_at FROM ci.messages m WHERE m.message_id = ${id})
    WHEN 'thread' THEN (SELECT COALESCE(t.last_message_at, t.created_at) FROM ci.threads t WHERE t.thread_id = ${id})
    WHEN 'answer' THEN (SELECT a.answered_at FROM ci.answers a WHERE a.answer_id = ${id})
    WHEN 'browser-activity' THEN (SELECT b.time FROM ci.browser_activity b WHERE b.id = ${id})
    WHEN 'receipt' THEN (SELECT COALESCE(r.purchased_at, r.created_at) FROM ci.receipts r WHERE r.receipt_id = ${id})
    WHEN 'task' THEN (SELECT tk.created_at FROM ci.tasks tk WHERE tk.id = ${id})
    WHEN 'product' THEN (SELECT pm.created_at FROM ci.product_models pm WHERE pm.product_id = ${id})
    WHEN 'person' THEN (SELECT en.created_at FROM ci.entities en WHERE en.entity_id = ${id})
    WHEN 'place' THEN (SELECT max(e.start_time) FROM ci.events e WHERE e.location_entity_id = ${id})
    WHEN 'concept' THEN (SELECT en.created_at FROM ci.entities en WHERE en.entity_id = ${id})
    ELSE NULL
  END)`;
}
