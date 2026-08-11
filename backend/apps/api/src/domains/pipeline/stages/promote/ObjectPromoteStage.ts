import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
// The graph domain's PUBLIC barrel — `no-cross-domain-internals` allows
// `index.ts` and nothing else. PURE FUNCTIONS only, so nothing is injected and
// this stage's module wiring stays empty. `normalizeObjectIdentifier` is the one
// place that knows GTIN-14 zero-padding, ISBN-10 -> ISBN-13 conversion, IMEI
// Luhn, and that an all-digit "ASIN" is an ISBN-10 — Amazon reuses the field for
// books. Re-implementing any of that here would mean the book you bought and the
// book you scan are two different things forever.
import { normalizeObjectIdentifier, type ObjectIdentifierNamespace } from '@ci/domains/graph';

import { PIPELINE_QUEUES } from '../../constants';
import type { Stage, StageResult, StageSource } from '../../types';
import { STAGE_VERSIONS, type StageVersion } from '../../versions';

/**
 * This stage's id.
 *
 * Declared here ahead of its `STAGE_IDS` entry, exactly as
 * `ENRICH_GEOCODE_STAGE_ID` and `PROMOTE_PLACE_STAGE_ID` were: the central
 * wiring (`constants.ts`, `versions.ts`, `StageRegistry`, `stageProviders`) is
 * one reviewable change and this file is another. It becomes
 * `STAGE_IDS.PROMOTE_OBJECT` — and this const its alias — in the change that
 * lands the four entries. `__tests__/stageWiring.spec.ts` fails, by name, for as
 * long as the two are apart.
 *
 * IDS ARE PERMANENT — the id is the third component of `ci.pipeline_state`'s
 * primary key.
 */
export const PROMOTE_OBJECT_STAGE_ID = 'promote.object';

/** The ledger `entity_type` this stage records under. */
const ENTITY_TYPE = 'event';

// ---------------------------------------------------------------------------
// The version
// ---------------------------------------------------------------------------

/**
 * Generation of this stage's promotion rule.
 *
 * Covers everything in {@link extractPurchase}: which `event_type` values are
 * line items, the metadata keys read, the condition vocabulary in
 * {@link CONDITION_ALIASES}, the identifier namespaces in
 * {@link IDENTIFIER_SOURCES}, and the two identity-confidence tiers. Bump it in
 * the same commit that edits any of them — that, and nothing else, is what
 * re-promotes a corpus that was read by a worse extractor.
 *
 * A literal rather than a derivation, unlike `promote.place`: this stage reads
 * NOTHING that another stage produces. Its whole input is the importer's own
 * commerce metadata, which no pipeline stage rewrites, so there is no second
 * generation for it to track. `MediaDimensionsStage` carries a literal for the
 * same reason and `EstimateLocationStage` carries a sum for the opposite one.
 */
export const OBJECT_PROMOTION_RULE_GENERATION = 1;

/** The stage version. Must stay an integer >= 1; see `versions.ts`. */
export const PROMOTE_OBJECT_VERSION = OBJECT_PROMOTION_RULE_GENERATION;

/**
 * The version this stage reports, cross-checked against `STAGE_VERSIONS`.
 *
 * Same contract as `promotePlaceStageVersion`: the constant here is the
 * authority, the `STAGE_VERSIONS` entry is its reviewable mirror, and a
 * disagreement throws at module load rather than as a confusing
 * "version is hardcoded" error from `StageRegistry.assertConsistent` at the
 * first sweep. A missing entry is not an error — this file is imported by its
 * own spec before the `constants.ts` / `versions.ts` declarations land.
 */
export function promoteObjectStageVersion(versions: Record<string, StageVersion> = STAGE_VERSIONS): number {
  const declared = versions[PROMOTE_OBJECT_STAGE_ID];

  if (typeof declared === 'number' && declared !== PROMOTE_OBJECT_VERSION) {
    throw new Error(
      `STAGE_VERSIONS["${PROMOTE_OBJECT_STAGE_ID}"] declares ${declared} but the stage derives ` +
        `${PROMOTE_OBJECT_VERSION} from OBJECT_PROMOTION_RULE_GENERATION ` +
        `(${OBJECT_PROMOTION_RULE_GENERATION}). Bumping the generation is only half the change: ` +
        `update versions.ts in the same commit, or the two disagree about what has already been ` +
        `promoted.`,
    );
  }

  return PROMOTE_OBJECT_VERSION;
}

promoteObjectStageVersion();

// ---------------------------------------------------------------------------
// Candidate selection
// ---------------------------------------------------------------------------

/** Event types that carry a commerce record. See {@link PROMOTE_OBJECT_SOURCE}. */
const PURCHASE_EVENT_TYPE = 'purchase';
const ORDER_EVENT_TYPE = 'order';

/**
 * Where the sweep looks, and which rows this stage APPLIES to.
 *
 * ── READ THIS BEFORE NARROWING IT TO "not yet promoted" ────────────────────
 *
 * The natural predicate to reach for is an anti-join against `ci.inventory` —
 * "events that have not produced an object yet". It is the same ratchet as
 * `LEFT JOIN ci_search.embeddings … WHERE e.entity_id IS NULL`, and the pipeline
 * README names that shape specifically: **never anti-join the stage's own output
 * table.** A purchase leaves the candidate set the moment an object exists for
 * it, so a better extractor — one that learns a second retailer's metadata
 * shape, or stops mis-reading a quantity — could never revisit a single row it
 * had already read badly.
 *
 * What the predicate DOES say is what a row IS: a live commerce event. Both
 * types are included deliberately, even though only one of them mints an object.
 * On the appliance this was written against there are 2,147 `purchase` rows
 * (one per receipt LINE, each with its own ASIN, quantity and unit price) and
 * 630 `order` rows (one per Order ID, an order-level rollup with no line
 * identity). Including the rollups is what turns "630 records we cannot promote
 * yet" into a countable
 * `skipped: order_rollup_no_line_item` in `GET /api/pipeline/state`, instead of
 * a silence that nobody can distinguish from work that was never scheduled. They
 * become receipts on the day `ci.receipts` has a reader — see the class
 * docblock.
 */
export const PROMOTE_OBJECT_SOURCE: StageSource = {
  schema: 'ci',
  table: 'events',
  idColumn: 'event_id',
  userColumn: 'user_id',
  predicate:
    `s.event_type IN ('${PURCHASE_EVENT_TYPE}', '${ORDER_EVENT_TYPE}') ` +
    `AND COALESCE(s.is_deleted, false) = false`,
};

// ---------------------------------------------------------------------------
// The extraction rule
// ---------------------------------------------------------------------------

/** The `metadata.promote.stage` marker; see {@link PROMOTE_OBJECT_SOURCE}. */
const PROMOTE_PROVENANCE_KEY = 'promote';

/**
 * `ci.inventory.source_type` for every row this stage writes.
 *
 * The row's source triple is `(promote.object, <the event's source_system>,
 * <the event id>)`, which does three jobs at once:
 *
 *  1. **Idempotency.** `inventory_source_triple_uniq` is UNIQUE on
 *     `(owner_user_id, source_type, source_system, source_id)`, so re-promoting
 *     an event updates its object instead of minting a second one. The stage
 *     needs no anti-join and no "have I done this?" query — see
 *     {@link PROMOTE_OBJECT_SOURCE}.
 *  2. **Provenance.** `source_id` IS the `ci.events.event_id`, so every object
 *     points at the exact record that produced it.
 *  3. **Isolation.** An importer writing `ci.inventory` directly uses its own
 *     `source_type` (`ci-import-tools`), so a promoted row can never collide
 *     with — or be mistaken for — an imported one. Withdrawal is then a single
 *     safe predicate rather than a diff.
 */
const PROMOTED_SOURCE_TYPE = PROMOTE_OBJECT_STAGE_ID;

/**
 * `ci.inventory.lifecycle_state` for a promoted purchase.
 *
 * Always `active`, for a physical purchase and a digital one alike. A receipt
 * records an ACQUISITION and says nothing about what became of the thing:
 * promoting a 2022 grocery line as `consumed` and a 2010 ebook as `archived`
 * would be two guesses wearing the costume of facts, and `identity_confidence`
 * would not carry the doubt because the doubt is not about identity. Moving a
 * row off `active` is a user action or a later `clean.*` stage with evidence.
 */
const PROMOTED_LIFECYCLE_STATE = 'active';

/** `ci.inventory.identity_method`; constrained by `inventory_identity_method_check`. */
const PROMOTED_IDENTITY_METHOD = 'receipt';

/**
 * The two identity tiers, in `(0, 1]`.
 *
 * DECLARED by this stage's rule, and versioned with it — not measured, and
 * deliberately not passed back as `StageResult.confidence`. The distinction
 * matters: `StageResult.confidence` is what an ENRICHER measured about its own
 * answer (`GeocodeStage` reports the provider's precision class there, which is
 * real), and `types.ts` is explicit that fabricating one teaches a promoter to
 * prefer a worse answer over a better one. `ci.inventory.identity_confidence` is
 * a different question — "how sure are we this row is the thing it says it is?" —
 * and the rebuild plan (§8.2) requires a number for it, because `>= 0.5` is the
 * gate on minting a `ci.product_models` entry from it.
 *
 *  - `IDENTIFIED` — the line carried a value that normalizes into a globally
 *    unique product identifier (ASIN, or an ISBN it resolved to). Two purchases
 *    of the same book, one scanned and one from Amazon, are the same product.
 *  - `NAMED` — the line carried only a product NAME. Enough to keep, above the
 *    minting gate by a hair, and honestly below the identified tier: "Organic
 *    Russet Potato" identifies a purchase, not a product.
 */
export const IDENTITY_CONFIDENCE_IDENTIFIED = 0.9;
export const IDENTITY_CONFIDENCE_NAMED = 0.55;

/**
 * Metadata keys carrying an identifier, and the namespace to normalize each as.
 *
 * The namespace RETURNED by `normalizeObjectIdentifier` may differ from the one
 * requested — an all-digit ASIN is an ISBN-10 and comes back as `isbn` — and the
 * returned one is what gets stored. That re-routing is the whole reason this
 * goes through the shared normalizer instead of `String(asin).toUpperCase()`.
 *
 * `order_id` is stored on the object as a code, and is deliberately NOT written
 * to `ci.object_identifiers`: that table's claim index is
 * `UNIQUE (owner_user_id, namespace, value_normalized, qualifier)` with
 * first-writer-wins, and an order id belongs to the ORDER, not to any one of the
 * things in it. Claiming it for a single object would silently swallow every
 * other line on the same order. See the class docblock for why nothing at all is
 * written there yet.
 */
const IDENTIFIER_SOURCES: ReadonlyArray<{ key: string; namespace: ObjectIdentifierNamespace }> = [
  { key: 'ASIN', namespace: 'asin' },
  { key: 'ISBN', namespace: 'isbn' },
  { key: 'UPC', namespace: 'gtin' },
  { key: 'EAN', namespace: 'gtin' },
  { key: 'Serial Number', namespace: 'serial' },
  { key: 'Order ID', namespace: 'order_id' },
];

/**
 * Namespaces that identify a PRODUCT MODEL rather than an order or a unit, and
 * therefore decide the identity tier.
 *
 * A serial number identifies the unit and an order id identifies the
 * transaction; neither tells us what the thing IS, which is the question
 * `identity_confidence` answers.
 */
const PRODUCT_IDENTIFIER_NAMESPACES: ReadonlySet<string> = new Set(['asin', 'isbn', 'gtin', 'mpn']);

/**
 * Source condition strings -> the `inventory_condition_check` vocabulary.
 *
 * Matched case-insensitively against a normalized form, and anything unmatched
 * becomes NULL rather than `'n/a'`. `'n/a'` is an assertion ("this thing has no
 * meaningful condition"); NULL is the absence of one, which is what an
 * unrecognised string actually means.
 */
const CONDITION_ALIASES: ReadonlyArray<{ pattern: RegExp; condition: string }> = [
  { pattern: /^new$/i, condition: 'new' },
  { pattern: /like[\s-]?new/i, condition: 'like_new' },
  { pattern: /(very good|^good$|used\s*-\s*good)/i, condition: 'good' },
  { pattern: /(acceptable|^fair$)/i, condition: 'fair' },
  { pattern: /(^poor$|damaged)/i, condition: 'poor' },
  { pattern: /(^broken$|for parts|not working)/i, condition: 'broken' },
];

/** `numeric(10,2)`: eight integer digits plus two decimals. */
const MAX_PURCHASE_PRICE = 99_999_999.99;

/** A slice row. `metadata` is the importer's commerce record, verbatim. */
interface CandidateRow {
  id: string;
  event_type: string | null;
  title: string | null;
  start_time: Date | string | null;
  metadata: Record<string, unknown> | null;
  source_system: string | null;
  is_deleted: boolean | null;
}

/** One purchase line, extracted and validated, ready to become an object. */
export interface PromotedObject {
  eventId: string;
  name: string;
  brand: string | null;
  model: string | null;
  /** Normalized identifiers, keyed by the namespace the normalizer RETURNED. */
  identifierCodes: Record<string, string>;
  purchasePrice: number | null;
  currency: string | null;
  acquiredAt: Date | null;
  isDigital: boolean;
  condition: string | null;
  quantity: number;
  identityConfidence: number;
  sourceSystem: string | null;
  /** Free-form commerce detail kept beside the provenance envelope. */
  commerce: Record<string, unknown>;
}

/**
 * Promotes purchases into inventory.
 *
 * ── What it writes, and where it is read ───────────────────────────────────
 *
 * `ci.inventory`, and nothing else. READ by `ItemService.findAll` / `findById` /
 * `findByIds` / `search`, every one of which maps through
 * `ItemEntity.toEgressType` — which returns all eleven identity columns — and is
 * called by `ItemResolver` (`items`, `item`), `FileItemsLoader`,
 * `BulkIngestController`, `EntityResolutionService` and
 * `MemoryCompactionService`. `ItemSearchIndexListener` indexes the rows, and
 * `MaintenanceController` / `IngestStatusService` count them.
 *
 * Of the eleven `ci.inventory` identity columns the Phase 8 audit found
 * unwritten, this fills four — `lifecycle_state`, `quantity`,
 * `identity_confidence`, `identity_method` — plus the ordinary object columns
 * (`name`, `identifier_codes`, `purchase_price`, `currency`, `acquired_at`,
 * `is_digital`, `condition`) and the source triple.
 *
 * ── What it deliberately does NOT write, and why ───────────────────────────
 *
 * **THE GATE: a table gets a read path in the same change as its writer.** Two
 * previous attempts at this class of table shipped write-only —
 * `ci.item_relationships` (one mutation, zero resolvers) and `ci.capture_events`
 * (zero SELECTs) — and the plan says a third is not acceptable. So:
 *
 *  - `ci.product_models` — no service, no resolver, no operator endpoint reads
 *    it. The entity class exists and is registered in `MemoryModule.forFeature`,
 *    and that is the whole of it. Writing it would fill a table nothing consults,
 *    so `ci.inventory.product_id` stays NULL. **Unblocking it is small and
 *    specific**: a `ProductService` in `domains/memory` with `findByIds`,
 *    exported from that barrel, plus a `product` `ResolveField` on `ItemType` —
 *    then the writer belongs in this stage's next version.
 *  - `ci.receipts` / `ci.receipt_line_items` — same, and the same fix shape.
 *    The 630 `order` events that would populate them are recorded
 *    `skipped: order_rollup_no_line_item` so the backlog is a number.
 *    `acquisition_receipt_id` and `acquisition_line_item_id` stay NULL.
 *  - `ci.object_identifiers` — `ObjectIdentifierService` exists with zero
 *    callers, so it fails the gate too, but it also fails a SEMANTIC test that
 *    matters more. `subject_type` is `product_model | object_instance`, and the
 *    only identifiers this corpus carries (ASIN / ISBN) identify a product
 *    MODEL. With no product models to attach them to, the only available subject
 *    would be the object instance — and the claim index is first-writer-wins on
 *    `(owner, namespace, value, qualifier)`, so the first unit bought would
 *    permanently own the ASIN and every later purchase of the same product would
 *    have its claim silently dropped. That is not a gap to fill later; it is a
 *    wrong row that could never be found again. The identifiers go into
 *    `ci.inventory.identifier_codes` instead, normalized by the same shared
 *    function, where `Item.identifierCodes` already reads them.
 *  - `ci.object_observations` — nothing in this corpus observes an object; that
 *    table is fed by vision, and by a stage that does not exist.
 *  - `object_entity_id`, `last_seen_at`, `last_seen_place_entity_id`,
 *    `merged_into_object_id` — a graph mirror, a sighting and a merge verdict
 *    respectively. None is derivable from a receipt, and a receipt's timestamp
 *    is not a sighting.
 *
 * ── Reversibility ─────────────────────────────────────────────────────────
 *
 * Every row carries `source_type = 'promote.object'`, `source_id = <event id>`
 * and a `metadata.promote` envelope with the version. Withdrawal is
 * `DELETE FROM ci.inventory WHERE user_id = $1 AND source_type = 'promote.object'`
 * followed by `DELETE FROM ci.pipeline_state WHERE stage = 'promote.object'`;
 * the exact statements are in migration `20260809181915_promote_support.sql`.
 * Nothing here mutates or deletes a source row, so a full re-promote after a bad
 * version bump is always safe.
 */
@Injectable()
export class ObjectPromoteStage implements Stage {
  readonly id = PROMOTE_OBJECT_STAGE_ID;

  /** Resolved ONCE at construction; see `promoteObjectStageVersion`. */
  readonly version = promoteObjectStageVersion();

  /**
   * `pipeline-index`: Postgres-bound, one INSERT per slice, no external call.
   * The rebuild plan reserves a `pipeline-promote` queue; queues exist one per
   * RESOURCE CLASS rather than one per phase, and this stage's resource class is
   * the one `pipeline-index` already carries.
   */
  readonly queue = PIPELINE_QUEUES.INDEX;

  readonly entityTypes = [ENTITY_TYPE] as const;

  readonly source = PROMOTE_OBJECT_SOURCE;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ObjectPromoteStage.name);
  }

  /**
   * Promote one slice of commerce events.
   *
   * Idempotent by the source triple rather than by a guard: the INSERT is
   * `ON CONFLICT (owner_user_id, source_type, source_system, source_id)
   * DO UPDATE`, so two dispatchers racing the same id produce one object and one
   * redundant UPDATE.
   *
   * Three phases: load, extract locally (no database), write in one statement.
   */
  async run(ctx: UserServiceContext, ids: string[]): Promise<Map<string, StageResult>> {
    const results = new Map<string, StageResult>();

    if (ids.length === 0) {
      return results;
    }

    const rows = await this.loadRows(ctx.userId, ids);
    const byId = new Map(rows.map((row) => [row.id, row]));

    // Answer for the ids that came back with no row FIRST, so the map is
    // complete even if the work below throws in a way this does not model.
    for (const id of ids) {
      if (!byId.has(id)) {
        results.set(id, { outcome: 'skipped', reason: 'source_row_missing' });
      }
    }

    const promotable: PromotedObject[] = [];

    for (const row of rows) {
      const extracted = extractPurchase(row);

      if ('reason' in extracted) {
        // Every one of these is a SKIP WITH A REASON, and each names which part
        // of the record was missing. That vocabulary is the difference between
        // "2,777 commerce events, 2,147 promoted" and a silence.
        results.set(row.id, { outcome: 'skipped', reason: extracted.reason });

        continue;
      }

      promotable.push(extracted.object);
    }

    if (promotable.length === 0) {
      return results;
    }

    let written: Map<string, string>;

    try {
      written = await this.writeObjects(ctx.userId, promotable);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      // One statement means one outcome: it committed or it did not, so every
      // row in it shares the verdict. FAILED, so the retry gate and the attempt
      // budget apply — a transient deadlock against a concurrent importer must
      // come back rather than be written off.
      for (const object of promotable) {
        results.set(object.eventId, {
          outcome: 'failed',
          reason: 'inventory_write_failed',
          detail: { message },
        });
      }

      this.logger.error(
        `Inventory promote failed for ${promotable.length} events`,
        err instanceof Error ? err : new Error(message),
      );

      return results;
    }

    const unwritten: PromotedObject[] = [];

    for (const object of promotable) {
      const objectId = written.get(object.eventId);

      if (objectId == null) {
        unwritten.push(object);

        continue;
      }

      results.set(object.eventId, {
        outcome: 'done',
        detail: {
          objectId,
          identityConfidence: object.identityConfidence,
          identifiers: Object.keys(object.identifierCodes),
        },
      });
    }

    if (unwritten.length > 0) {
      await this.explainUnwritten(ctx.userId, unwritten, results);
    }

    return results;
  }

  /**
   * The slice's events, in one statement.
   *
   * Raw SQL rather than `EventService`, for the reason `EmbedStage` gives about
   * `ContentService`: the columns wanted are a strict subset of a ~40-column row.
   * `metadata` is the exception and it comes back whole, because it IS the
   * commerce record.
   *
   * User-scoped even though the sweep already was: a slice can arrive from a dead
   * letter replayed weeks later, and re-scoping is the difference between "this
   * id is not yours" and putting someone else's purchases in this user's
   * inventory.
   */
  private loadRows(userId: string, ids: string[]): Promise<CandidateRow[]> {
    return this.dataSource.query<CandidateRow[]>(
      // The title lives on the event's CTI base row in ci.entities, which
      // shares the event's uuid. Inner join: the FK makes a detail row without
      // a base row impossible, so this cannot drop a candidate.
      `SELECT e.event_id AS id,
              e.event_type,
              b.name AS title,
              e.start_time,
              e.metadata,
              e.source_system,
              e.is_deleted
         FROM ci.events e
         JOIN ci.entities b ON b.entity_id = e.event_id
        WHERE e.event_id = ANY($1::uuid[])
          AND e.user_id = $2::uuid`,
      [ids, userId],
    );
  }

  /**
   * Write every promotable object in ONE statement, and report which ones landed.
   *
   * `unnest()` over parallel arrays into a single INSERT, upserted on
   * `inventory_source_triple_uniq`. Both `user_id` and `owner_user_id` are set:
   * the unique index is keyed on `owner_user_id`, so leaving it NULL would make
   * the whole idempotency argument false.
   *
   * ── The two clauses that protect a human ──────────────────────────────────
   *
   * The `DO UPDATE … WHERE` is the ownership rule, and it has two halves:
   *
   *  1. `metadata->'promote'->>'stage' = <this stage>` — never touch a row this
   *     stage did not write. An importer's inventory row uses its own
   *     `source_type` and cannot collide with these anyway, but a stale row from
   *     some future writer sharing the triple would, and re-pointing it is not
   *     this stage's business.
   *  2. `updated_at <= (metadata->'promote'->>'at') + 1s` — never overwrite a row
   *     a HUMAN has edited since it was promoted. `ci.inventory.updated_at` is
   *     maintained by `ItemEntity`'s `@UpdateDateColumn`, so any edit through
   *     `ItemService.update` moves it past the promotion stamp and the row is
   *     left alone. Both timestamps come from `now()`, which is the transaction
   *     clock, so a freshly-promoted row compares equal; the one-second slack
   *     absorbs a row inserted with the column default in the same statement.
   *
   * The second is an approximation of what §8.3 of the rebuild plan describes as
   * a per-column property fold against `ci.derived_facts` — and it is honestly
   * weaker: it is per-ROW, and it only works for writers that maintain
   * `updated_at`. A raw `UPDATE ci.inventory` elsewhere that forgets the column
   * would be invisible to it. That is the argument for `ci.derived_facts`, not
   * for dropping the guard: without it, the first version bump after a user
   * renamed a promoted item silently reverts the rename.
   *
   * Rows excluded by either clause simply do not appear in `RETURNING`, which is
   * how {@link explainUnwritten} knows to go and ask why.
   */
  private async writeObjects(userId: string, objects: PromotedObject[]): Promise<Map<string, string>> {
    // An item is a CTI aggregate: the `ci.inventory` detail row below plus an
    // `Item`-discriminated base row in `ci.entities` sharing its uuid, which is
    // the sole owner of the name. Both halves are written in ONE transaction,
    // detail first, which is legal only because
    // `inventory_object_id_entities_fk` is DEFERRABLE INITIALLY DEFERRED: the
    // object ids come back from RETURNING, so the base rows cannot be written
    // until the detail rows exist. Splitting these across two transactions
    // would commit detail rows with no base row and fail the constraint.
    return this.dataSource.transaction(async (manager) => {
      const rows = await manager.query<Array<{ object_id: string; source_id: string }>>(
        `INSERT INTO ci.inventory AS inv (
         user_id, owner_user_id, brand, model, identifier_codes,
         purchase_price, currency, acquired_at, is_digital, condition,
         quantity, lifecycle_state, identity_confidence, identity_method,
         source_type, source_system, source_id, metadata
       )
       SELECT $1::uuid, $1::uuid, u.brand, u.model, u.identifier_codes,
              u.purchase_price, u.currency, u.acquired_at, u.is_digital, u.condition,
              u.quantity, $2::text, u.identity_confidence, $3::text,
              $4::text, u.source_system, u.event_id::text,
              u.commerce || jsonb_build_object(
                '${PROMOTE_PROVENANCE_KEY}',
                jsonb_build_object(
                  'stage',    $4::text,
                  'version',  $5::int,
                  'event_id', u.event_id,
                  'at',       to_jsonb(now())
                )
              )
         FROM unnest(
                $6::uuid[], $7::text[], $8::text[], $9::text[], $10::jsonb[],
                $11::numeric[], $12::text[], $13::timestamptz[], $14::boolean[],
                $15::text[], $16::int[], $17::real[], $18::text[], $19::jsonb[]
              ) AS u(event_id, name, brand, model, identifier_codes,
                     purchase_price, currency, acquired_at, is_digital,
                     condition, quantity, identity_confidence, source_system,
                     commerce)
       ON CONFLICT (owner_user_id, source_type, source_system, source_id)
         WHERE source_id IS NOT NULL
       DO UPDATE SET
            brand               = excluded.brand,
            model               = excluded.model,
            identifier_codes    = excluded.identifier_codes,
            purchase_price      = excluded.purchase_price,
            currency            = excluded.currency,
            acquired_at         = excluded.acquired_at,
            is_digital          = excluded.is_digital,
            condition           = excluded.condition,
            quantity            = excluded.quantity,
            lifecycle_state     = inv.lifecycle_state,
            identity_confidence = excluded.identity_confidence,
            identity_method     = excluded.identity_method,
            metadata            = COALESCE(inv.metadata, '{}'::jsonb) || excluded.metadata,
            updated_at          = now()
          WHERE inv.metadata->'${PROMOTE_PROVENANCE_KEY}'->>'stage' = $4::text
            AND inv.updated_at <=
                COALESCE(
                  (inv.metadata->'${PROMOTE_PROVENANCE_KEY}'->>'at')::timestamptz,
                  inv.updated_at
                ) + interval '1 second'
       RETURNING inv.object_id, inv.source_id`,
        [
          userId,
          PROMOTED_LIFECYCLE_STATE,
          PROMOTED_IDENTITY_METHOD,
          PROMOTED_SOURCE_TYPE,
          this.version,
          objects.map((object) => object.eventId),
          objects.map((object) => object.name),
          objects.map((object) => object.brand),
          objects.map((object) => object.model),
          objects.map((object) => JSON.stringify(object.identifierCodes)),
          objects.map((object) => object.purchasePrice),
          objects.map((object) => object.currency),
          objects.map((object) => object.acquiredAt),
          objects.map((object) => object.isDigital),
          objects.map((object) => object.condition),
          objects.map((object) => object.quantity),
          objects.map((object) => object.identityConfidence),
          objects.map((object) => object.sourceSystem),
          objects.map((object) => JSON.stringify(object.commerce)),
        ],
      );

      if (rows.length > 0) {
        // `source_id` is the event uuid as text, which is how a returned row
        // finds the name it was promoted with. A row that came back from the
        // DO UPDATE branch already has its base row, so the name is refreshed
        // rather than duplicated.
        const nameBySourceId = new Map(objects.map((object) => [object.eventId, object.name]));

        await manager.query(
          `WITH upserted AS (
             INSERT INTO ci.entities
               (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
             SELECT u.object_id, 'Item', u.name, '{}'::jsonb, $1::uuid, 'inventory', u.object_id
               FROM unnest($2::uuid[], $3::text[]) AS u(object_id, name)
             ON CONFLICT (entity_id) DO UPDATE SET name = excluded.name, updated_at = now()
             RETURNING entity_id, entity_type, name, description, properties, owner_user_id,
                       (xmax = 0) AS inserted
           )
           INSERT INTO ci.graph_deltas (
             entity_id, node_type, entity_type, change_type, changed_fields,
             change_source, owner_user_id
           )
           SELECT
             u.entity_id,
             'entity',
             u.entity_type,
             CASE WHEN u.inserted THEN 'created' ELSE 'updated' END,
             jsonb_build_object(
               'name', jsonb_build_object('new', u.name),
               'description', jsonb_build_object('new', u.description),
               'entity_type', jsonb_build_object('new', u.entity_type),
               'properties', jsonb_build_object('new', u.properties)
             ),
             'ObjectPromoteStage',
             u.owner_user_id
           FROM upserted u`,
          [
            userId,
            rows.map((row) => row.object_id),
            rows.map((row) => nameBySourceId.get(row.source_id) ?? null),
          ],
        );
      }

      return new Map(rows.map((row) => [row.source_id, row.object_id]));
    });
  }

  /**
   * Say WHY an upsert touched nothing, rather than recording an anonymous
   * failure.
   *
   * Only reached when `RETURNING` came back short, which in steady state is
   * never. The two causes are the two halves of the `DO UPDATE … WHERE`, and
   * they are opposite in kind: one is a row that belongs to another writer
   * (permanent, a skip), the other is a row a person has edited since it was
   * promoted (also permanent — until the extraction rule improves enough to be
   * worth a conversation, which is a version bump).
   *
   * A failure to classify is not fatal: the ids fall through to
   * `inventory_row_not_written`, which is still a reason and still countable.
   */
  private async explainUnwritten(
    userId: string,
    unwritten: PromotedObject[],
    results: Map<string, StageResult>,
  ): Promise<void> {
    const eventIds = unwritten.map((object) => object.eventId);

    for (const eventId of eventIds) {
      results.set(eventId, { outcome: 'skipped', reason: 'inventory_row_not_written' });
    }

    try {
      const rows = await this.dataSource.query<
        Array<{ source_id: string; owned: boolean; modified: boolean }>
      >(
        `SELECT inv.source_id,
                (inv.metadata->'${PROMOTE_PROVENANCE_KEY}'->>'stage' = $3::text) AS owned,
                (inv.updated_at >
                   COALESCE((inv.metadata->'${PROMOTE_PROVENANCE_KEY}'->>'at')::timestamptz,
                            inv.updated_at) + interval '1 second') AS modified
           FROM ci.inventory inv
          WHERE inv.owner_user_id = $1::uuid
            AND inv.source_type = $3::text
            AND inv.source_id = ANY($2::text[])`,
        [userId, eventIds, PROMOTED_SOURCE_TYPE],
      );

      for (const row of rows) {
        results.set(row.source_id, {
          outcome: 'skipped',
          reason:
            row.owned === false
              ? 'inventory_row_not_owned'
              : row.modified === true
                ? 'inventory_row_user_modified'
                : 'inventory_row_not_written',
        });
      }
    } catch (err: unknown) {
      this.logger.warn('Could not classify unwritten inventory rows', {
        message: err instanceof Error ? err.message : String(err),
        count: unwritten.length,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Extraction — pure, and exported so the spec can drive it directly
// ---------------------------------------------------------------------------

/** A refusal to promote, with the ledger reason it becomes. */
interface ExtractionRefusal {
  reason: string;
}

/**
 * Turn one commerce event into an object, or say why it cannot be one.
 *
 * PURE: no database, no clock, no configuration. Every decision this stage makes
 * about WHAT a purchase is lives here, which is what makes
 * {@link OBJECT_PROMOTION_RULE_GENERATION} a meaningful thing to bump and what
 * lets the spec cover the whole rule without a Postgres.
 *
 * The metadata keys are the importer's commerce shape (`kind:
 * "commerce.purchase"`), and they are read by NAME because there is no schema to
 * read them by. A second retailer with different key names is a branch here plus
 * a generation bump — and, crucially, the events it could not read in the
 * meantime were recorded `skipped: unrecognized_commerce_shape` rather than
 * silently dropped, so the bump has something to re-open.
 */
export function extractPurchase(row: CandidateRow): { object: PromotedObject } | ExtractionRefusal {
  if (row.is_deleted === true) {
    return { reason: 'event_deleted' };
  }

  const metadata = row.metadata;

  if (metadata == null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    // Applicability said this is a commerce event; the record says otherwise.
    return { reason: 'unrecognized_commerce_shape' };
  }

  if (row.event_type === ORDER_EVENT_TYPE) {
    // An order-level rollup: one row per Order ID, carrying a total and an item
    // COUNT but no line identity. It is a receipt, not an object, and
    // `ci.receipts` has no reader — see the class docblock. Recorded rather than
    // filtered out of the sweep so the backlog is a number.
    return { reason: 'order_rollup_no_line_item' };
  }

  const name = firstText(metadata, ['Product', 'Item', 'Title']) ?? textOrNull(row.title);

  if (name == null) {
    // `ci.inventory.name` is NOT NULL, and an object with no name is not an
    // object anybody could find again.
    return { reason: 'no_product_name' };
  }

  const identifierCodes: Record<string, string> = {};
  let hasProductIdentifier = false;

  for (const { key, namespace } of IDENTIFIER_SOURCES) {
    const raw = firstText(metadata, [key]);

    if (raw == null) {
      continue;
    }

    // The shared normalizer, never a local `.toUpperCase()`. It returns null for
    // a value that cannot become a matchable identifier (a failed check digit, a
    // 9-character "ASIN"), and a rejected value is NOT an error — a receipt line
    // with a garbled code is still a valid line.
    const normalized = normalizeObjectIdentifier(namespace, raw);

    if (normalized == null) {
      continue;
    }

    // Keyed by the namespace the normalizer RETURNED: an all-digit ASIN lands
    // under `isbn`, which is the same key the book's printed barcode produces.
    identifierCodes[normalized.namespace] = normalized.valueNormalized;

    if (PRODUCT_IDENTIFIER_NAMESPACES.has(normalized.namespace)) {
      hasProductIdentifier = true;
    }
  }

  const commerce: Record<string, unknown> = {};

  for (const [key, value] of Object.entries({
    order_id: firstText(metadata, ['Order ID']),
    merchant: firstText(metadata, ['Source', 'Merchant', 'Seller']),
    kind: firstText(metadata, ['kind']),
    media_type: firstText(metadata, ['mediaType']),
  })) {
    if (value != null) {
      commerce[key] = value;
    }
  }

  return {
    object: {
      eventId: row.id,
      name,
      brand: firstText(metadata, ['Brand', 'Manufacturer']),
      model: firstText(metadata, ['Model', 'Model Number', 'Part Number']),
      identifierCodes,
      purchasePrice: parsePrice(firstText(metadata, ['Unit Price', 'Price', 'Total'])),
      currency: parseCurrency(firstText(metadata, ['Currency'])),
      // The event's own start_time, not the metadata's "Order Date" string: the
      // importer already parsed one into the other and the typed column is the
      // one that survived a timezone.
      acquiredAt: parseTimestamp(row.start_time),
      isDigital: metadata.Digital === true || metadata.digital === true,
      condition: parseCondition(firstText(metadata, ['Condition'])),
      quantity: parseQuantity(metadata.Quantity ?? metadata.quantity),
      identityConfidence: hasProductIdentifier ? IDENTITY_CONFIDENCE_IDENTIFIED : IDENTITY_CONFIDENCE_NAMED,
      sourceSystem: textOrNull(row.source_system),
      commerce,
    },
  };
}

/** First non-empty string among `keys`, trimmed. */
function firstText(metadata: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = textOrNull(metadata[key]);

    if (value != null) {
      return value;
    }
  }

  return null;
}

/** A trimmed non-empty string, or null. Numbers stringify; nothing else does. */
function textOrNull(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();

    return trimmed.length > 0 ? trimmed : null;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  return null;
}

/**
 * A price as `numeric(10,2)`, or null.
 *
 * Rejects non-finite, negative and out-of-range values rather than letting the
 * database raise `numeric field overflow` and take a 200-row slice down with it.
 * `"0"` is a real Amazon value (a free ebook, a promotional line) and is kept:
 * zero is a price, and turning it into NULL would lose the fact that the line
 * had one.
 */
export function parsePrice(raw: string | null): number | null {
  if (raw == null) {
    return null;
  }

  // Thousands separators and currency symbols are stripped; what must NOT be
  // stripped into silence is a string with no number in it at all. `Number('')`
  // is 0, so a bare `replace().Number()` would quietly price "not a price" — and
  // every future unparseable format — at zero, which is indistinguishable from a
  // real free Kindle title.
  const cleaned = raw.replace(/[^0-9.-]/g, '');

  if (!/[0-9]/.test(cleaned)) {
    return null;
  }

  const value = Number(cleaned);

  if (!Number.isFinite(value) || value < 0 || value > MAX_PURCHASE_PRICE) {
    return null;
  }

  return Math.round(value * 100) / 100;
}

/** An ISO-4217 code, or null. Everything else falls back to the column default. */
export function parseCurrency(raw: string | null): string | null {
  if (raw == null) {
    return null;
  }

  const upper = raw.trim().toUpperCase();

  return /^[A-Z]{3}$/.test(upper) ? upper : null;
}

/**
 * Units on the line, floored at 1.
 *
 * `inventory_quantity_check` is `quantity > 0`, so a source that says 0 (or
 * something unparseable) becomes 1 rather than failing the slice: the receipt
 * line exists, so at least one thing was bought.
 */
export function parseQuantity(raw: unknown): number {
  const value = typeof raw === 'number' ? raw : Number(textOrNull(raw) ?? Number.NaN);

  if (!Number.isFinite(value)) {
    return 1;
  }

  return Math.max(1, Math.floor(value));
}

/** The `inventory_condition_check` vocabulary, or null for anything unrecognised. */
export function parseCondition(raw: string | null): string | null {
  if (raw == null) {
    return null;
  }

  for (const { pattern, condition } of CONDITION_ALIASES) {
    if (pattern.test(raw)) {
      return condition;
    }
  }

  return null;
}

/** `ci.events.start_time` as a Date, tolerating the string form node-postgres may hand back. */
function parseTimestamp(raw: Date | string | null): Date | null {
  if (raw == null) {
    return null;
  }

  const value = raw instanceof Date ? raw : new Date(raw);

  return Number.isNaN(value.getTime()) ? null : value;
}
