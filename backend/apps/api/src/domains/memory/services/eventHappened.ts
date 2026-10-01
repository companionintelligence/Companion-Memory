import { LIVE_EVENT_SQL } from './CalendarEventService';

/**
 * The `metadata` key a Google Takeout reservation (`google_purchases`) carries
 * as `true` when it was cancelled.
 *
 * Importing a cancelled reservation now also writes `status = 'cancelled'`
 * (#2871), and a migration repaired the stored rows, so {@link LIVE_EVENT_SQL}
 * sees those. This key stays a second marker for a row that reached the table
 * another way, such as an account-archive import, which restores rows verbatim.
 * Its value decides, not its presence: `Canceled: false` happened.
 *
 * It is a copy of the key `import/datasources/google_purchases.ts` writes, as
 * the estimator's and Known places' copies were. If they drift, cancelled
 * reservations count again, so the unit spec pins it.
 */
export const RESERVATION_CANCELED_KEY = 'Canceled';

/**
 * "This `ci.events` row happened", for raw SQL that aliases the table `event`.
 * Place readers that count or date visits apply it. A row that did not happen
 * says nothing about where the user was, whoever linked it to a place.
 *
 * An event did not happen when it is:
 *
 *  - deleted (`is_deleted`). The user removed it, and the column's contract is
 *    that a tombstoned row is left out of every read. Undo clears the flag and
 *    the event counts again;
 *  - a prediction (`is_predicted`). A guess about where the user will be, not a
 *    record of where they were;
 *  - called off, by its status. This is the calendar's own
 *    {@link LIVE_EVENT_SQL}, so `cancelled`, `no_show` and `skipped` go and
 *    `tentative`, `planned`, `in_progress`, `rescheduled` and `completed`
 *    stay, as they do on the calendar;
 *  - a Takeout reservation marked cancelled in its metadata
 *    ({@link RESERVATION_CANCELED_KEY}).
 *
 * The alias is `event` because {@link LIVE_EVENT_SQL} is written for it. A
 * query that names `ci.events` something else renames its alias. It does not
 * copy the status test under another one, which is the drift
 * {@link LIVE_EVENT_SQL} exists to prevent.
 *
 * Every clause is NULL-safe on its own. `is_predicted` is nullable, and NULL
 * counts as not predicted, as its default and every other reader of it have
 * it. `is_deleted` and `status` are NOT NULL today, but their down migrations
 * drop that, and {@link LIVE_EVENT_SQL} COALESCEs `status`. The reservation key
 * is COALESCEd too. `metadata` defaults to `'{}'`, so `metadata->>'Canceled'`
 * is NULL on nearly every row, and a bare `<> 'true'` would drop all of them.
 *
 * The fragment is parenthesised so it can sit after an OR as safely as an AND.
 * It has no bind parameters, so a query can take it without renumbering its
 * own.
 *
 * Known places, a place's visit stats and the Places date browse apply this
 * fragment. Known places had the rule inline first, and it moved here. The
 * `eventHappenedSql` in `pipeline/stages/enrich/EstimateLocationStage.ts` and its
 * copy in `maintenance/services/LocationEstimateService.ts` state the same rule
 * for other aliases, as text of their own. Both domains import memory, so they
 * could take it from here. That would change two other domains and the specs
 * that pin their copies, so it is left for its own change. Each spec pins its
 * copy, and `eventLifecycleFixtures.ts` holds every reader to one list of
 * cases.
 *
 * Some rows that did not happen carry no marker, so they still count. An
 * `.ics` import before #2871 ignored STATUS, and nothing repairs those rows. A
 * declined invitation exists only as a `responseStatus` inside
 * `metadata.participants`. Each belongs in its importer, where fixing it
 * corrects the calendar as well.
 */
export const EVENT_HAPPENED_SQL = `(${[
  'event.is_deleted IS NOT TRUE',
  'event.is_predicted IS NOT TRUE',
  LIVE_EVENT_SQL,
  `COALESCE(event.metadata->>'${RESERVATION_CANCELED_KEY}', '') <> 'true'`,
].join(' AND ')})`;
