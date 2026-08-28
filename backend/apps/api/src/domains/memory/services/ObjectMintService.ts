import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';
import { v7 as uuid7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { computeChunkSize } from '@ci/common/persistence';

import { minorUnitsToDecimal } from '../entities/minorUnits';

import { GraphDeltaWriter } from './GraphDeltaWriter';

/**
 * `ci.objects.source_type` for every unit this service mints.
 *
 * The triple is `('receipt-line', <the receipt's source_system>,
 * <line_item_id>)`, which does three jobs at once:
 *
 *  1. **Idempotency.** `objects_source_triple_uniq` is UNIQUE on
 *     `(owner_user_id, source_type, source_system, source_id)`, so re-extracting
 *     a receipt re-mints onto the SAME row instead of adding a second copy of a
 *     possession. No anti-join, no "have I minted this?" query.
 *  2. **Provenance.** `source_id` IS the `ci.receipt_line_items.line_item_id`,
 *     so every minted unit points at the exact claim that produced it — the
 *     mirror of `ci.objects.acquisition_line_item_id`.
 *  3. **Isolation.** The importer writes `ci.objects` under its own
 *     `source_type`, and `ObjectPromoteStage` under `promote.object`, so a
 *     minted unit can never collide with — or be mistaken for — either.
 */
export const MINT_SOURCE_TYPE = 'receipt-line';

/**
 * `ci.objects.lifecycle_state` for a freshly minted unit.
 *
 * NOT `'owned'`: `objects_lifecycle_state_check` accepts exactly
 * `active | stored | lent_out | lost | disposed | consumed | returned |
 * archived`, and `'owned'` is not in it — a mint that wrote it would fail the
 * CHECK on every row. `'active'` is this schema's spelling of "owned and in
 * play". A receipt records an ACQUISITION and says nothing about what became of
 * the thing, so guessing `consumed` for a 2022 grocery line would be a guess
 * wearing the costume of a fact.
 */
export const MINT_LIFECYCLE_STATE = 'active';

/** `ci.objects.identity_method` for a receipt-derived unit; see objects_identity_method_check. */
export const MINT_IDENTITY_METHOD = 'receipt';

/**
 * `ci.objects.identity_confidence` for a receipt-derived unit.
 *
 * The tier the migration's column comment names for receipts. Below the 1.0
 * default deliberately: 1.0 means user-entered or barcode-scanned and reads as
 * ground truth to HBPE and RAG, and a line on a receipt is a claim about a
 * purchase, not a look at the object.
 */
export const MINT_IDENTITY_CONFIDENCE = 0.7;

/**
 * `ci.objects.acquisition_method` for a receipt-derived unit.
 *
 * `'purchased'`, NOT `'purchase'` — `objects_acquisition_method_check`
 * accepts `purchased | gift | inherited | found | made | borrowed | traded |
 * sample | unknown`, and the past participle is the one in the list.
 */
export const MINT_ACQUISITION_METHOD = 'purchased';

/** The `metadata` key carrying this service's provenance bag on a minted row. */
const MINT_PROVENANCE_KEY = 'mint';

/** The receipt-level facts every line on it inherits. */
export interface MintReceiptContext {
  receiptId: string;
  /** Becomes the minted row's `source_system`; part of the idempotency triple. */
  sourceSystem: string | null;
  purchasedAt: Date | null;
  /**
   * Graph Location the purchase happened at.
   *
   * `ci.objects` has NO acquisition-place column (only `last_seen_*`, which
   * is denormalized from CONFIRMED SIGHTINGS and would be a lie here — buying a
   * thing in a shop is not seeing it there afterwards). It is recorded in the
   * mint provenance bag instead, where `ObjectResolutionService`'s place_prior
   * step can still reach it without any read pretending it was observed.
   */
  placeEntityId: string | null;
  merchantName: string | null;
  merchantEntityId: string | null;
  currency: string | null;
}

/** One line's worth of mintable claim. */
export interface MintLineInput {
  lineItemId: string;
  description: string;
  /** Count of identical units the line stands for. Carried on ONE row — see {@link ObjectMintService}. */
  quantity: number;
  unitPriceMinor: number | null;
  totalPriceMinor: number | null;
  currency: string | null;
  productId: string | null;
  brand: string | null;
  modelNumber: string | null;
  category: string | null;
  isPhysical: boolean;
  /**
   * Distinct serial numbers the line supplied. THE ONLY reason a line becomes
   * more than one object row — see the class docblock.
   */
  serials?: string[];
  /** Copied verbatim into `ci.objects.identifier_codes`. */
  identifierCodes?: Record<string, unknown>;
}

/** What minting one line actually did. */
export interface MintResult {
  lineItemId: string;
  /** The owned-unit ids this line resolves to, in stable order. */
  objectIds: string[];
  /** How many of them THIS call inserted (0 on a re-mint). */
  inserted: number;
}

/** A row, flattened for the `unnest` write. */
interface MintRow {
  objectId: string;
  lineItemId: string;
  sourceId: string;
  name: string;
  brand: string | null;
  model: string | null;
  category: string | null;
  identifierCodes: string;
  purchasePrice: number | null;
  currency: string | null;
  acquiredAt: Date | null;
  quantity: number;
  productId: string | null;
  acquiredFrom: string | null;
  acquiredFromEntityId: string | null;
  metadata: string;
}

/**
 * Turns a receipt LINE ITEM into the owned `ci.objects` unit(s) it implies.
 *
 * The chain is receipt (evidence) -> line item (claim) -> objects (owned
 * unit), and this service is the last arrow. Before it, the importer flattened
 * a whole purchase into ONE object row named after the order, so a four-item
 * Amazon order became one "thing".
 *
 * ── How many rows a line becomes ───────────────────────────────────────────
 *
 * ONE row per physical line, carrying `quantity`. N rows ONLY when the line
 * supplies N distinct serial numbers.
 *
 * This is the rule that decides whether the things list is usable. "6 × AA
 * battery" is one possession with a count, not six possessions; exploding it
 * puts five rows of noise in front of the user forever, and there is nothing to
 * tell them apart with — no serial, no photo, no separate history. A line that
 * DOES carry serials is the opposite case: the source has already distinguished
 * the units, each one has an identifier that will match a warranty claim or a
 * scan, and collapsing them would throw that away.
 *
 * ── Idempotency ────────────────────────────────────────────────────────────
 *
 * Every minted row carries the provenance triple `(receipt-line, <receipt
 * source_system>, <line_item_id>)` — or `<line_item_id>#<serial>` when serials
 * split the line — so a re-extraction of the same document re-mints onto the
 * same rows. The link is made two-way: `ci.receipt_line_items.minted_object_id`
 * is set to the unit, so a re-mint is a cheap no-op and the graph can walk the
 * chain from either end.
 *
 * ── What it never does ─────────────────────────────────────────────────────
 *
 * Never mints for a `is_physical = false` line (a Kindle book is not a thing on
 * a shelf), and never touches a unit a user has since edited — the conflict
 * clause refreshes only rows this service owns, matched on the same provenance
 * bag `ObjectPromoteStage` uses, and the `ci.entities` base-row write that
 * follows is restricted to the ids that clause actually returned (see
 * {@link ObjectMintService.writeBaseRows}), because the base row is where the
 * user's rename lives.
 */
@Injectable()
export class ObjectMintService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly graphDeltaWriter: GraphDeltaWriter,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ObjectMintService.name);
  }

  /** Single-line convenience over {@link mintFromLines}. */
  async mintFromLine(
    context: UserServiceContext,
    receipt: MintReceiptContext,
    line: MintLineInput,
    manager?: EntityManager,
  ): Promise<MintResult> {
    const [result] = await this.mintFromLines(context, receipt, [line], manager);

    return result ?? { lineItemId: line.lineItemId, objectIds: [], inserted: 0 };
  }

  /**
   * Mint every physical line of one receipt.
   *
   * Runs inside the caller's transaction when a `manager` is supplied (which is
   * how {@link ReceiptService.upsertFromExtraction} keeps the receipt, its
   * lines and their units atomic), and opens its own otherwise.
   */
  async mintFromLines(
    context: UserServiceContext,
    receipt: MintReceiptContext,
    lines: MintLineInput[],
    manager?: EntityManager,
  ): Promise<MintResult[]> {
    const mintable = lines.filter((line) => line.isPhysical);

    if (mintable.length === 0) {
      return lines.map((line) => ({ lineItemId: line.lineItemId, objectIds: [], inserted: 0 }));
    }

    const rowsByLine = new Map<string, MintRow[]>();

    for (const line of mintable) {
      rowsByLine.set(line.lineItemId, this.rowsFor(receipt, line));
    }

    const rows = [...rowsByLine.values()].flat();

    const run = async (em: EntityManager): Promise<Set<string>> => {
      const { inserted, written } = await this.writeUnits(em, context.userId, receipt, rows);

      // ONLY the rows the guarded upsert actually touched get a base-row write.
      // See writeBaseRows for what happens to a user-owned row otherwise.
      await this.writeBaseRows(
        em,
        context.userId,
        rows.filter((row) => written.has(row.objectId)),
        inserted,
      );
      await this.linkLineItems(em, context.userId, rowsByLine);

      return inserted;
    };

    const insertedIds = manager
      ? await run(manager)
      : await this.dataSource.transaction(async (em) => run(em));

    return lines.map((line) => {
      const minted = rowsByLine.get(line.lineItemId) ?? [];

      return {
        lineItemId: line.lineItemId,
        objectIds: minted.map((row) => row.objectId),
        inserted: minted.filter((row) => insertedIds.has(row.objectId)).length,
      };
    });
  }

  /**
   * Expand one line into the rows it mints.
   *
   * Deterministic in the line's own data: the object ids are freshly generated
   * (they only survive on a genuine insert — a re-mint keeps the existing row's
   * id), but the SOURCE IDs are derived, and those are what the arbiter reads.
   */
  private rowsFor(receipt: MintReceiptContext, line: MintLineInput): MintRow[] {
    const currency = line.currency ?? receipt.currency ?? null;
    const serials = [...new Set((line.serials ?? []).map((serial) => serial.trim()).filter(Boolean))];
    const name = line.description.trim() || 'Unnamed item';

    const base = {
      lineItemId: line.lineItemId,
      name,
      brand: line.brand,
      model: line.modelNumber,
      category: line.category,
      identifierCodes: JSON.stringify(line.identifierCodes ?? {}),
      currency,
      acquiredAt: receipt.purchasedAt,
      productId: line.productId,
      acquiredFrom: receipt.merchantName,
      acquiredFromEntityId: receipt.merchantEntityId,
    };

    const provenance = (serial: string | null) => ({
      [MINT_PROVENANCE_KEY]: {
        service: 'ObjectMintService',
        receipt_id: receipt.receiptId,
        line_item_id: line.lineItemId,
        // No acquisition-place column exists on ci.objects; see
        // MintReceiptContext.placeEntityId for why it is recorded here instead.
        place_entity_id: receipt.placeEntityId,
        ...(serial != null && { serial }),
      },
    });

    if (serials.length > 1) {
      // The source distinguished the units, so we do too: one row per serial,
      // each with quantity 1, each with its own arbiter.
      return serials.map((serial) => ({
        ...base,
        objectId: uuid7(),
        sourceId: `${line.lineItemId}#${serial}`,
        // Per-unit price, not the line total — each row IS one unit now.
        purchasePrice: minorUnitsToDecimal(line.unitPriceMinor, currency),
        quantity: 1,
        metadata: JSON.stringify(provenance(serial)),
      }));
    }

    return [
      {
        ...base,
        objectId: uuid7(),
        sourceId: line.lineItemId,
        // The line's own total when it has one (it already accounts for the
        // count), else the unit price — never unitPrice × quantity computed
        // here, which would silently disagree with the receipt over rounding.
        purchasePrice: minorUnitsToDecimal(line.totalPriceMinor ?? line.unitPriceMinor, currency),
        quantity: this.wholeQuantity(line.quantity),
        metadata: JSON.stringify(provenance(serials[0] ?? null)),
      },
    ];
  }

  /**
   * `ci.objects.quantity` is `INTEGER CHECK (quantity > 0)`, but a line's
   * quantity is `NUMERIC(12,3)` — 1.5 kg of coffee is a real receipt line.
   *
   * A fractional quantity is rounded UP to 1 whole unit rather than rejected or
   * floored: you own the bag of coffee, and flooring 0.5 to 0 would violate the
   * CHECK and abort a receipt over a legitimate line.
   */
  private wholeQuantity(quantity: number): number {
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return 1;
    }

    return Math.max(1, Math.ceil(quantity));
  }

  /**
   * The upsert into `ci.objects`.
   *
   * Reports TWO sets, because they answer two different questions and only one
   * of them is a count:
   *
   *  - `inserted` — the ids this statement genuinely INSERTED (`xmax = 0`), so
   *    the caller can report honest counts and the graph delta can say
   *    `created` rather than claiming every re-mint is a new possession.
   *  - `written`  — every id the statement RETURNED, insert branch and refresh
   *    branch alike. The `DO UPDATE … WHERE` clause is a GUARD: a row a user
   *    has edited, or one another writer owns, matches the arbiter but fails
   *    the guard, so the statement returns nothing for it. Those ids are absent
   *    from this set, and {@link writeBaseRows} must not touch them — the base
   *    row is the sole owner of `name`, and `name` is user-editable.
   *
   * `unnest` over parallel arrays keeps the bind-parameter count constant in the
   * row count; the chunking is about statement size and lock-hold time, the same
   * reason `chunkedConflictInsert` chunks.
   */
  private async writeUnits(
    em: EntityManager,
    userId: string,
    receipt: MintReceiptContext,
    rows: MintRow[],
  ): Promise<{ inserted: Set<string>; written: Set<string> }> {
    const inserted = new Set<string>();
    const written = new Set<string>();

    if (rows.length === 0) {
      return { inserted, written };
    }

    // 16 unnest arrays + 6 scalars; the widest ci.objects row is ~60 columns,
    // which is what the chunk budget is derived from.
    const chunkSize = computeChunkSize(60);

    for (let offset = 0; offset < rows.length; offset += chunkSize) {
      const chunk = rows.slice(offset, offset + chunkSize);

      const returned = await em.query<Array<{ object_id: string; inserted: boolean }>>(
        `INSERT INTO ci.objects AS inv (
           object_id, user_id, owner_user_id, category, brand, model,
           identifier_codes, purchase_price, currency, acquired_at,
           product_id, acquisition_receipt_id, acquisition_line_item_id,
           quantity, lifecycle_state, identity_confidence, identity_method,
           acquired_from, acquired_from_entity_id, acquisition_method,
           metadata, source_type, source_system, source_id
         )
         SELECT u.object_id, $1::uuid, $1::uuid, u.category, u.brand, u.model,
                COALESCE(u.identifier_codes, '{}'::jsonb), u.purchase_price, u.currency, u.acquired_at,
                u.product_id, $2::uuid, u.line_item_id,
                u.quantity, $3::text, $4::real, $5::text,
                u.acquired_from, u.acquired_from_entity_id, $23::text,
                COALESCE(u.metadata, '{}'::jsonb), $6::text, $7::text, u.source_id
           FROM unnest(
                  $8::uuid[], $9::uuid[], $10::text[], $11::text[], $12::text[],
                  $13::text[], $14::jsonb[], $15::numeric[], $16::text[], $17::timestamptz[],
                  $18::uuid[], $19::int[], $20::text[], $21::uuid[], $22::jsonb[]
                ) AS u(object_id, line_item_id, source_id, brand, model,
                       category, identifier_codes, purchase_price, currency, acquired_at,
                       product_id, quantity, acquired_from, acquired_from_entity_id, metadata)
         ON CONFLICT (owner_user_id, source_type, source_system, source_id)
           WHERE source_id IS NOT NULL
         DO UPDATE SET
              brand                    = excluded.brand,
              model                    = excluded.model,
              category                 = excluded.category,
              identifier_codes         = excluded.identifier_codes,
              purchase_price           = excluded.purchase_price,
              currency                 = excluded.currency,
              acquired_at              = excluded.acquired_at,
              product_id               = excluded.product_id,
              acquisition_receipt_id   = excluded.acquisition_receipt_id,
              acquisition_line_item_id = excluded.acquisition_line_item_id,
              quantity                 = excluded.quantity,
              acquired_from            = excluded.acquired_from,
              acquired_from_entity_id  = excluded.acquired_from_entity_id,
              -- lifecycle_state is EXCLUDED from the refresh on purpose: a
              -- re-extraction of the receipt learns nothing new about whether
              -- the thing still exists, and resetting a 'disposed' unit to
              -- 'active' would silently un-throw-away a possession.
              metadata                 = COALESCE(inv.metadata, '{}'::jsonb) || excluded.metadata,
              updated_at               = now()
            -- Only rows THIS service minted are refreshable. A unit the user
            -- has since edited, or one another writer owns, is left alone.
            WHERE inv.metadata->'${MINT_PROVENANCE_KEY}'->>'service' = 'ObjectMintService'
         RETURNING inv.object_id, (xmax = 0) AS inserted`,
        [
          userId,
          receipt.receiptId,
          MINT_LIFECYCLE_STATE,
          MINT_IDENTITY_CONFIDENCE,
          MINT_IDENTITY_METHOD,
          MINT_SOURCE_TYPE,
          receipt.sourceSystem,
          chunk.map((row) => row.objectId),
          chunk.map((row) => row.lineItemId),
          chunk.map((row) => row.sourceId),
          chunk.map((row) => row.brand),
          chunk.map((row) => row.model),
          chunk.map((row) => row.category),
          chunk.map((row) => row.identifierCodes),
          chunk.map((row) => row.purchasePrice),
          chunk.map((row) => row.currency),
          chunk.map((row) => row.acquiredAt),
          chunk.map((row) => row.productId),
          chunk.map((row) => row.quantity),
          chunk.map((row) => row.acquiredFrom),
          chunk.map((row) => row.acquiredFromEntityId),
          chunk.map((row) => row.metadata),
          MINT_ACQUISITION_METHOD,
        ],
      );

      for (const row of returned) {
        written.add(row.object_id);

        if (row.inserted) {
          inserted.add(row.object_id);
        }
      }

      // A row that came back from the DO UPDATE branch keeps the id it already
      // had, which is NOT the uuid we generated for it. Re-point the in-memory
      // row so the base-row write and the line-item link both aim at the real
      // unit. Matched on source_id, the arbiter itself.
      const bySourceId = new Map(
        (
          await em.query<Array<{ object_id: string; source_id: string }>>(
            `SELECT object_id, source_id
               FROM ci.objects
              WHERE owner_user_id = $1::uuid
                AND source_type = $2
                AND source_system IS NOT DISTINCT FROM $3
                AND source_id = ANY($4::text[])`,
            [userId, MINT_SOURCE_TYPE, receipt.sourceSystem, chunk.map((row) => row.sourceId)],
          )
        ).map((row) => [row.source_id, row.object_id]),
      );

      for (const row of chunk) {
        const actual = bySourceId.get(row.sourceId);
        if (actual != null && actual !== row.objectId) {
          if (inserted.delete(row.objectId)) {
            inserted.add(actual);
          }

          row.objectId = actual;
        }
      }
    }

    return { inserted, written };
  }

  /**
   * The `ci.entities` half of the CTI aggregate.
   *
   * `ci.objects` is a CTI DETAIL table: the base row in `ci.entities`
   * (discriminated `'Item'`) is the sole owner of name/description, and
   * `objects_object_id_entities_fk` is a composite FK on `(object_id,
   * entity_type)`. It is DEFERRABLE INITIALLY DEFERRED, which is why the detail
   * rows may land first — but it is still checked at COMMIT, so skipping this
   * write does not produce a nameless item, it aborts the transaction.
   *
   * ── Only rows the unit upsert RETURNED ─────────────────────────────────────
   *
   * `rows` is pre-filtered by the caller to the ids {@link writeUnits} actually
   * wrote, and that filter is the whole point of this method's contract.
   * `writeUnits`' `DO UPDATE … WHERE inv.metadata->'mint'->>'service' =
   * 'ObjectMintService'` deliberately declines to refresh a unit the user has
   * since edited — but the base row is the SOLE owner of `name`, and `name` is
   * the field the user edits. Handing every row to the unconditional
   * `ON CONFLICT (entity_id) DO UPDATE SET name = excluded.name` below would
   * undo, on the very next re-extraction, the rename the unit upsert had just
   * gone out of its way to protect: the guard would hold on `ci.objects` and
   * the edit would be overwritten in `ci.entities` one statement later.
   *
   * This is the precedent the class docblock already cites —
   * `ObjectPromoteStage` writes base rows only `if (rows.length > 0)` for the
   * ids ITS guarded upsert returned, and classifies the rest in
   * `explainUnwritten` rather than writing them anyway.
   *
   * A skipped row still has a base row (it could not exist otherwise — the FK
   * is checked at COMMIT), so nothing is left nameless.
   *
   * @param rows     the mint rows whose unit write succeeded, ids already
   *                 re-pointed to the real `ci.objects` row.
   * @param inserted which of those ids were genuinely INSERTED, so the graph
   *                 delta reports `created` vs `updated` truthfully.
   */
  private async writeBaseRows(
    em: EntityManager,
    userId: string,
    rows: MintRow[],
    inserted: ReadonlySet<string>,
  ): Promise<void> {
    if (rows.length === 0) {
      return;
    }

    const chunkSize = computeChunkSize(7);

    for (let offset = 0; offset < rows.length; offset += chunkSize) {
      const chunk = rows.slice(offset, offset + chunkSize);

      await em.query(
        `INSERT INTO ci.entities
           (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
         SELECT u.object_id, 'Item', u.name, '{}'::jsonb, $1::uuid, 'objects', u.object_id
           FROM unnest($2::uuid[], $3::text[]) AS u(object_id, name)
         ON CONFLICT (entity_id) DO UPDATE SET name = excluded.name, updated_at = now()`,
        [userId, chunk.map((row) => row.objectId), chunk.map((row) => row.name)],
      );
    }

    // `created` only for the rows that really are new. A re-extraction of the
    // same receipt re-mints onto the SAME units, and reporting those as
    // `created` tells every graph-delta consumer the user acquired the same
    // possession again — the same distinction `ObjectPromoteStage` draws with
    // `CASE WHEN u.inserted THEN 'created' ELSE 'updated' END`.
    await this.graphDeltaWriter.recordMany(
      rows.map((row) => ({
        nodeType: 'entity' as const,
        changeType: inserted.has(row.objectId) ? ('created' as const) : ('updated' as const),
        entityId: row.objectId,
        entityType: 'Item',
        ownerUserId: userId,
        changeSource: 'ObjectMintService.mintFromLines',
        changedByUserId: userId,
        changedFields: {
          name: { new: row.name },
          entity_type: { new: 'Item' },
        },
      })),
      em,
    );
  }

  /**
   * Close the loop: `ci.receipt_line_items.minted_object_id` points back at the
   * unit, so the chain walks from either end and a re-mint can be skipped
   * cheaply by anything that only wants unminted lines (see
   * `receipt_line_items_unminted_idx`).
   *
   * A serial-split line mints several units and the column holds one, so it
   * gets the FIRST — the full set is on each unit's own
   * `acquisition_line_item_id`, which is the side that can represent
   * one-to-many.
   */
  private async linkLineItems(
    em: EntityManager,
    userId: string,
    rowsByLine: Map<string, MintRow[]>,
  ): Promise<void> {
    const pairs = [...rowsByLine.entries()]
      .map(([lineItemId, rows]) => ({ lineItemId, objectId: rows[0]?.objectId }))
      .filter((pair): pair is { lineItemId: string; objectId: string } => pair.objectId != null);

    if (pairs.length === 0) {
      return;
    }

    await em.query(
      `UPDATE ci.receipt_line_items AS li
          SET minted_object_id = u.object_id, updated_at = now()
         FROM unnest($2::uuid[], $3::uuid[]) AS u(line_item_id, object_id)
        WHERE li.line_item_id = u.line_item_id
          AND li.user_id = $1::uuid
          AND li.minted_object_id IS DISTINCT FROM u.object_id`,
      [userId, pairs.map((pair) => pair.lineItemId), pairs.map((pair) => pair.objectId)],
    );
  }
}
