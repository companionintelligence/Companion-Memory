import { randomUUID } from 'node:crypto';

import type { DataSource } from 'typeorm';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CORPUS the enrichment loop is driven over.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `enrichmentLoop.integration.spec.ts` used to run over the operator's own
 * imported archive — 324,044 real `ci.events` rows, whichever user had the most
 * of them. That is a real loss, and it is worth naming rather than glossing:
 * real data is shaped in ways nobody thinks to fixture, and the numbers the
 * spec printed were numbers about the appliance.
 *
 * It is also the reason the spec wrote to the appliance. The two properties are
 * the same property: a test that reads the operator's tables is a test running
 * against a database it must not write to, and this one writes — `ci.inventory`
 * and `ci.events` are the OUTPUT of the two stages it drives. There is no
 * arrangement of transactions that makes "drive real enrichers over the user's
 * archive" safe by construction; there is only rollback discipline, which is a
 * promise, and which was broken.
 *
 * So the corpus is seeded, into a database made for the run. What is preserved
 * is the SHAPE that makes the loop's properties observable:
 *
 *  - **More rows than one tick can dispatch.** A tick is
 *    `MAX_SLICES_PER_SWEEP × DEFAULT_SLICE_SIZE` = 1,000 ids. A corpus that
 *    fits in one tick cannot demonstrate a keyset chain, a cursor that advances,
 *    or a pause with a resume that is distinguishable from a restart.
 *  - **Both commerce classes.** The appliance had 2,147 `purchase` rows (one per
 *    receipt LINE) and 630 `order` rollups. `ObjectPromoteStage` promotes the
 *    first and records the second as `skipped: order_rollup_no_line_item`, so
 *    seeding only purchases would turn coverage into a single-valued thing and
 *    quietly stop testing the skip vocabulary.
 *  - **Rows the applicability predicate must exclude**, interleaved rather than
 *    parked at the end, and **a second user's rows**, so every sweep in the
 *    suite implicitly re-asserts that the predicate and the user scope hold.
 *  - **Ordered ids.** Lowercase hex uuids compare byte-wise in Postgres and
 *    lexically in JavaScript in the SAME order, so a test can say which ids a
 *    keyset hop should return and mean it.
 *
 * What is NOT preserved is the absolute scale, and §6 of the spec says so where
 * it reports its numbers. Seeding 324,044 rows to measure a tick against them
 * would be measuring this seeder.
 */

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * The mix, as a repeating cycle of ten ids.
 *
 * Roughly the appliance's own ratio of purchase to order rollup (2,147 : 630),
 * plus one row in ten that is not a commerce event at all. Expressed as a
 * modulus rather than as three blocks so the classes INTERLEAVE: a decoy that
 * only ever appears after the last applicable id cannot distinguish "the
 * predicate excluded it" from "the sweep stopped".
 */
const PURCHASE_SLOTS = 7;
const ORDER_SLOTS = 2;

/** Rows seeded for the second user. Never swept; present to be excluded. */
const OTHER_USER_ROWS = 40;

/** Where the second user's ids start, so the two ranges cannot overlap. */
const OTHER_USER_ID_BASE = 900_000_000;

/**
 * What a corpus is FOR, which is the only thing that changes its mix.
 *
 * `commerce` — the candidate set `ObjectPromoteStage` sweeps: purchases, order
 * rollups and interleaved non-commerce decoys.
 *
 * `timeline` — every row applicable to `TemporalRepairStage`, whose predicate
 * is only "not deleted". Used for the scale section, where the point is the
 * cost of a hop over a large candidate set rather than the extraction rule.
 */
export type CorpusShape = 'commerce' | 'timeline';

export interface SeedCorpusOptions {
  /**
   * 1-9. Becomes the first hex digit of every event id this corpus seeds, which
   * is what lets several corpora coexist in one `ci.events` — the table's
   * primary key is global, so two users cannot share an id.
   */
  corpus: number;
  /** Total `ci.events` rows for the corpus user. */
  events: number;
  shape: CorpusShape;
  /** Appears in the seeded user's name. Purely so a leaked row is legible. */
  label: string;
}

export interface SeededCorpus {
  /** The user every sweep in the block is scoped to. */
  userId: string;
  /** A second user with rows of the same shape. Seeded, never swept. */
  otherUserId: string;
  /** `ci.events` rows for {@link userId}. */
  events: number;
  /** Rows `ObjectPromoteStage`'s predicate selects: purchases + order rollups. */
  commerce: number;
  /** Rows that mint a `ci.inventory` object. */
  purchases: number;
  /** Order rollups — `skipped: order_rollup_no_line_item`. */
  orders: number;
  /** Rows no commerce predicate selects. */
  decoys: number;
  seedMs: number;
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/**
 * Seed one user and their events.
 *
 * Set-based: three `INSERT … SELECT … FROM generate_series` statements, one per
 * event class, rather than a round trip per row. 30,000 rows land in about a
 * second, which is what makes the scale section affordable at all.
 */
export async function seedLoopCorpus(
  dataSource: DataSource,
  options: SeedCorpusOptions,
): Promise<SeededCorpus> {
  if (!Number.isInteger(options.corpus) || options.corpus < 1 || options.corpus > 9) {
    throw new Error(`corpus must be an integer 1-9 (got ${options.corpus}); it is one hex digit of the id.`);
  }

  const startedAt = Date.now();

  const userId = randomUUID();
  const otherUserId = randomUUID();

  await seedUser(dataSource, userId, `${options.label} corpus`);
  await seedUser(dataSource, otherUserId, `${options.label} corpus (other user)`);

  await seedEvents(dataSource, {
    corpus: options.corpus,
    userId,
    shape: options.shape,
    from: 1,
    to: options.events,
  });

  await seedEvents(dataSource, {
    corpus: options.corpus,
    userId: otherUserId,
    shape: options.shape,
    from: OTHER_USER_ID_BASE + 1,
    to: OTHER_USER_ID_BASE + OTHER_USER_ROWS,
  });

  const counts = classCounts(options.shape, options.events);

  return {
    userId,
    otherUserId,
    events: options.events,
    commerce: counts.purchases + counts.orders,
    purchases: counts.purchases,
    orders: counts.orders,
    decoys: counts.decoys,
    seedMs: Date.now() - startedAt,
  };
}

/** How many of each class a corpus of `events` rows in `shape` contains. */
function classCounts(
  shape: CorpusShape,
  events: number,
): { purchases: number; orders: number; decoys: number } {
  if (shape === 'timeline') {
    return { purchases: 0, orders: 0, decoys: events };
  }

  let purchases = 0;
  let orders = 0;

  for (let n = 1; n <= events; n += 1) {
    const slot = n % 10;

    if (slot < PURCHASE_SLOTS) {
      purchases += 1;
    } else if (slot < PURCHASE_SLOTS + ORDER_SLOTS) {
      orders += 1;
    }
  }

  return { purchases, orders, decoys: events - purchases - orders };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * One `ci.users` row.
 *
 * Needed for two independent reasons: `ci.events.user_id` is a foreign key to
 * it, and `TemporalRepairStage` reads `ci.users.timezone` to resolve floating
 * wall-clock times. UTC is stated rather than left to the column default so the
 * classifier's zone-dependent branches are deterministic here.
 */
async function seedUser(dataSource: DataSource, userId: string, name: string): Promise<void> {
  await dataSource.query(
    `INSERT INTO ci.users (id, name, email, username, timezone, role)
          VALUES ($1::uuid, $2, $3, $4, 'UTC', 'user')`,
    [userId, name, `${userId}@corpus.invalid`, `corpus_${userId.replace(/-/g, '')}`],
  );
}

/**
 * The rows themselves, one statement per class.
 *
 * ── The columns that are not arbitrary ─────────────────────────────────────
 *
 * `source_system` is non-null on commerce rows because `ci.inventory`'s
 * idempotency key is `(owner_user_id, source_type, source_system, source_id)`
 * and a NULL in a unique index never conflicts with anything — a corpus with a
 * null `source_system` would let `ObjectPromoteStage` mint a SECOND object for
 * the same event on the version-bump re-run, and the stage's idempotency (which
 * §4 depends on) would look broken when the fixture was.
 *
 * On the non-commerce rows it alternates between NULL and a name
 * `TemporalRepairStage` does not know, which are the two classes that stage
 * resolves without moving a timestamp: `done: user_asserted` and
 * `skipped: unspecified_source`. That is a deliberate pair — a mix of terminal
 * outcomes for the scale section to converge over, with no clock arithmetic in
 * the middle of a measurement.
 */
async function seedEvents(
  dataSource: DataSource,
  args: { corpus: number; userId: string; shape: CorpusShape; from: number; to: number },
): Promise<void> {
  const { corpus, userId, shape, from, to } = args;

  if (to < from) {
    return;
  }

  // `0000000<corpus>-0000-4000-8000-<n>`, built in SQL so the whole corpus is
  // one statement rather than one round trip per row.
  const id = `('0000000${corpus}-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid`;
  // Distinct instants, ascending, so the timeline is a timeline. Deliberately
  // not `now()`: a fixture that moves with the clock is a fixture that fails on
  // a leap second at 3am.
  const startTime = `TIMESTAMPTZ '2024-01-01 00:00:00+00' + make_interval(mins => n)`;

  // Events are CTI aggregates now: the `ci.events` detail row plus an
  // `Event`-discriminated base row in `ci.entities` sharing its uuid, which is
  // the sole owner of the title. Each seed is ONE statement so both inserts
  // share a transaction, which is what the DEFERRABLE INITIALLY DEFERRED
  // `events_event_id_entities_fk` needs when the detail row goes in first.
  // `candidates` exists so the generated id and title are written once and read
  // by both inserts.
  const baseRows = `INSERT INTO ci.entities
                      (entity_id, entity_type, name, properties,
                       owner_user_id, linked_table, linked_id)
                    SELECT c.event_id, 'Event', c.title, '{}'::jsonb,
                           $1::uuid, 'events', c.event_id
                      FROM inserted JOIN candidates c USING (event_id)`;

  const purchase =
    shape === 'commerce'
      ? `WITH candidates AS (
           SELECT ${id} AS event_id, 'Synthetic purchase ' || n AS title,
                  ${startTime} AS start_time, n
             FROM generate_series($2::int, $3::int) AS n
            WHERE n % 10 < ${PURCHASE_SLOTS}
         ),
         inserted AS (
           INSERT INTO ci.events (event_id, user_id, start_time, event_type,
                                  source_type, source_system, source_id, metadata)
           SELECT c.event_id, $1::uuid, c.start_time, 'purchase',
                  'commerce', 'synthetic_commerce', c.n::text,
                  jsonb_build_object(
                    'kind',       'commerce.purchase',
                    'Product',    'Synthetic Widget ' || c.n,
                    'ASIN',       'B0' || upper(substr(md5(c.n::text), 1, 8)),
                    'Unit Price', to_char(((c.n % 500) + 0.99)::numeric, 'FM999990.00'),
                    'Currency',   'USD',
                    'Quantity',   (c.n % 3) + 1,
                    'Order ID',   'SYN-' || lpad(c.n::text, 10, '0'),
                    'Source',     'Synthetic Retailer'
                  )
             FROM candidates c
           RETURNING event_id
         )
         ${baseRows}`
      : null;

  const order =
    shape === 'commerce'
      ? `WITH candidates AS (
           SELECT ${id} AS event_id, 'Synthetic order ' || n AS title,
                  ${startTime} AS start_time, n
             FROM generate_series($2::int, $3::int) AS n
            WHERE n % 10 >= ${PURCHASE_SLOTS} AND n % 10 < ${PURCHASE_SLOTS + ORDER_SLOTS}
         ),
         inserted AS (
           INSERT INTO ci.events (event_id, user_id, start_time, event_type,
                                  source_type, source_system, source_id, metadata)
           SELECT c.event_id, $1::uuid, c.start_time, 'order',
                  'commerce', 'synthetic_commerce', c.n::text,
                  jsonb_build_object(
                    'kind',     'commerce.order',
                    'Order ID', 'SYN-' || lpad(c.n::text, 10, '0'),
                    'Total',    to_char(((c.n % 900) + 4.99)::numeric, 'FM999990.00'),
                    'Currency', 'USD',
                    'Source',   'Synthetic Retailer'
                  )
             FROM candidates c
           RETURNING event_id
         )
         ${baseRows}`
      : null;

  const decoyFilter = shape === 'commerce' ? `WHERE n % 10 >= ${PURCHASE_SLOTS + ORDER_SLOTS}` : '';

  const decoy = `WITH candidates AS (
                   SELECT ${id} AS event_id, 'Synthetic entry ' || n AS title,
                          ${startTime} AS start_time, n
                     FROM generate_series($2::int, $3::int) AS n
                     ${decoyFilter}
                 ),
                 inserted AS (
                   INSERT INTO ci.events (event_id, user_id, start_time, event_type,
                                          source_type, source_system, metadata)
                   SELECT c.event_id, $1::uuid, c.start_time, 'calendar',
                          'calendar',
                          CASE WHEN c.n % 2 = 0 THEN NULL ELSE 'synthetic_corpus' END,
                          jsonb_build_object('synthetic', true)
                     FROM candidates c
                   RETURNING event_id
                 )
                 ${baseRows}`;

  for (const statement of [purchase, order, decoy]) {
    if (statement != null) {
      await dataSource.query(statement, [userId, from, to]);
    }
  }
}
