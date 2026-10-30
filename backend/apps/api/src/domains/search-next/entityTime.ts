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
 */
export function entityTimeSql(alias?: string): string {
  const type = alias ? `${alias}.entity_type` : 'entity_type';
  const id = alias ? `${alias}.entity_id` : 'entity_id';

  return `(CASE ${type}
    WHEN 'communication' THEN (SELECT c.time FROM ci.communications c WHERE c.id = ${id})
    WHEN 'event' THEN (SELECT e.start_time FROM ci.events e WHERE e.event_id = ${id})
    WHEN 'note' THEN (SELECT n.created_at FROM ci.notes n WHERE n.id = ${id})
    WHEN 'content' THEN (SELECT ct.created_at FROM ci.content ct WHERE ct.id = ${id})
    WHEN 'file' THEN (SELECT COALESCE(f.external_created_at, f.created_at) FROM ci.files f WHERE f.id = ${id})
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
