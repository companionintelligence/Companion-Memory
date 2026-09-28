import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import { BrowserActivityService } from '@ci/domains/browser-activity';
import { UNFURL_SWEEP_QUEUE, UnfurlSweepRequestEvent } from '@ci/domains/embed/events';
import { EventService } from '@ci/domains/events';
// Events leaf only (see the maintenance import below for why a barrel would cycle).
import { type GraphEntityInputDto, GraphIngestService, ObjectIdentifierService } from '@ci/domains/graph';
// The events leaf, NOT the maintenance barrel: the barrel would close the
// module cycle maintenance → llm → tools → import.
import {
  GRAPH_EDGE_BACKFILL_QUEUE,
  GraphEdgeBackfillRequestEvent,
  PERSON_STUB_BACKFILL_QUEUE,
  PersonStubBackfillRequestEvent,
  SEARCH_INDEX_BACKFILL_QUEUE,
  SearchIndexBackfillRequestEvent,
} from '@ci/domains/maintenance/events';
import {
  CalendarEventService,
  CommunicationService,
  ContentService,
  type CreateContentDto,
  ItemService,
  ObjectObservationService,
  ProductModelService,
  ReceiptService,
} from '@ci/domains/memory';
import { PositionService } from '@ci/domains/position';

import type { StagedEntity } from '../entities/StagedEntityEntity';
import type { StagedItem } from '../entities/StagedItemEntity';
import {
  backfillEntityTypesFor,
  destinationsFor,
  edgeProjectionSourcesFor,
  toCanonical,
  type CanonicalRecord,
  type Destination,
} from '../push/canonical';
import {
  isGraphExcluded,
  placeKeyFor,
  toGraphEntity,
  PLACE_ENTITY_TYPE,
  PLACE_RELATIONS,
} from '../push/entities';
import {
  discordAttachmentContentInputs,
  isFacebookMessengerRecord,
  isWhatsAppRecord,
  toBrowserActivityInput,
  toCommunicationInput,
  toContentInput,
  toEventInput,
  toFacebookMessengerCommunicationInput,
  toThingInput,
  toObservationInput,
  toPositionInput,
  toProductModelInput,
  toReceiptInput,
  toReceiptLineItemInputs,
  toWhatsAppCommunicationInput,
  productModelIdentifiers,
  type ReceiptEntityLinks,
} from '../push/inputs';
import {
  type IsSelf,
  makeIsSelf,
  matchOwner,
  NOBODY_IS_SELF,
  readSelfIdentity,
  shouldMapContactToSelf,
  type SelfIdentity,
} from '../push/self';
import {
  DATABASE_FREE_FLOOR_BYTES,
  DatabaseVolumeFullError,
  isOutOfDiskError,
  readDatabaseSpace,
  type DatabaseSpace,
} from '../storage/databaseSpace';
import { type DropReason, dropReasonFor } from '../telemetry/dropReasons';
import { buildStageSummary, SUMMARY_KEY, type StageSummary } from '../telemetry/stageSummary';
import type { ImportStageRunner, StageOutcome, StageRunContext } from '../types';

/** Mirrors personalization TrustMode without importing that domain (cycle risk). */
type TrustMode = 'cautious' | 'balanced' | 'hands_off';

/** Staged rows read (and pushed) per batch. */
const PUSH_BATCH = 500;

/**
 * `staged_entities.push_error` for an entity `skipped` because it had neither
 * a handle nor a name to resolve by — see {@link toGraphEntity}.
 *
 * Recorded rather than left `NULL` so a RESUMED push can still tell this apart
 * from a bookkeeping-type exclusion (`isGraphExcluded`) when it re-derives
 * `entities.unresolved` from what a dead attempt already settled — see
 * {@link PushStage.settledCounts} — and so the reason can be reported from the
 * run itself rather than only from this constant. See
 * {@link PushStage.unresolvedEntityReport}.
 */
const UNRESOLVED_ENTITY_REASON = 'no stable name or handle to resolve by';

/**
 * `staged_items.push_error` for a row {@link destinationsFor} routed NOWHERE.
 *
 * Not an error, and not a duplicate either — the third thing hiding inside
 * `deduped`. `destinationsFor` legitimately returns `[]` for records this
 * appliance has decided have no home: an Amazon subscription fee line, whose
 * `metadata.Subscription` marks it as a service rather than a thing, is the
 * shipping example. Such a row reaches no destination, so `plan.wrote` stays
 * false, so `recordOutcomes` files it under `skipped`, so it was counted as
 * `deduped` and reported as "the record is in ci.*, it just arrived earlier".
 *
 * It is not in ci.*. It was never offered to anything. That is a routing
 * decision worth being able to count — and worth telling apart from a genuine
 * re-import, which is what makes a run that wrote 0 rows legible.
 *
 * Written as `push_error` on a `skipped` row, exactly as
 * {@link UNRESOLVED_ENTITY_REASON} is for entities, so a RESUMED push can
 * still separate the two from rows a dead attempt settled.
 */
const NO_DESTINATION_REASON = 'no destination for this record';

/**
 * The slug this skip reason is reported under.
 *
 * {@link UNRESOLVED_ENTITY_REASON} is the sentence a person reads; this is what
 * a caller matches on. Typed as {@link DropReason} so it can only ever be a
 * member of the closed drop vocabulary, and used by BOTH readers of this skip —
 * {@link PushStage.unresolvedEntityReport} and the `entityDrops` tally in
 * {@link PushStage.summarize} — so the count on `detail.entities` and the count
 * under `detail.summary` cannot drift into disagreeing about one event.
 *
 * `dropSeverityFor` classifies it as a `gap`, which is the honest reading: the
 * record did not arrive. It is deliberately NOT what makes the run `partial`;
 * see the `partial` computation in {@link PushStage.run}.
 */
const UNRESOLVED_ENTITY_SLUG: DropReason = 'entity_unresolved';

/** How many unresolved entities the report names individually. */
const UNRESOLVED_EXAMPLE_LIMIT = 5;

/**
 * The order a batch's destinations are written in.
 *
 * The per-row loop this replaced wrote each row's destinations in
 * `destinationsFor` order, and **events come before content there** — for
 * `social.*`, for `media.play/watch/listen/read`, and for a file-bearing
 * `calendar.event` / `capture.*`, it returns `['events', 'content']`. No branch
 * returns content before events; reddit's `['communications', 'content']` names
 * no event at all.
 *
 * That order is load-bearing, not cosmetic. `ContentService.createManyDetailed`
 * auto-links a content row to its event by the provenance triple
 * (`resolveEventIdsByTriple`), so writing content first asks for an event row
 * that does not exist yet and leaves `ci.content.event_id` NULL. Everything
 * hanging off that link then reads empty: `findMediaFilesByEventIds` — the
 * query behind every gallery, list and drawer thumbnail — filters on
 * `content.event_id`, and the L0 `Content -DOCUMENTS-> Event` edge rule has no
 * candidates at all.
 *
 * Measured on a 1,393,402-record corpus imported with content ahead of events:
 * **0 of 41,851** content rows carried an `event_id`, while 2,916 shared a
 * provenance triple with an event and should have (linkedin 1,975, twitter 697,
 * whatsapp 169, facebook 69, instagram 3, reddit 2, grok 1). Sampled pairs show
 * the content row inserted 44-65ms before its event.
 *
 * So: events first. An earlier revision of this comment claimed the fixed order
 * preserved the per-row behaviour and that "an Audible listen still reaches
 * `content` before `events`" — an Audible listen is `media.listen`, which
 * returns `['events', 'content']`, so the claim was exactly backwards.
 *
 * The commerce plane has an order requirement of its own, for the same class of
 * reason. `product_models` runs FIRST because it is the IDENTITY the rest of a
 * commerce batch points at: `ReceiptService.upsertFromExtraction` resolves each
 * line's product by looking up its identifier claim and only falls back to
 * find-or-create when nothing resolves — so with receipts first, an ISBN this
 * very batch is about to catalogue mints a SECOND, brand+model-guessed product
 * row, and the claim index is first-writer-wins, so the guessed row keeps the
 * barcode forever. `observations` runs last: a sighting is only worth recording
 * once the thing it sighted has an identity.
 */
export const DESTINATION_ORDER: readonly Destination[] = [
  'product_models',
  'communications',
  'events',
  'content',
  'receipts',
  'things',
  'observations',
  'browser_activity',
  'position',
];

/**
 * The `ci.object_identifiers.source` stamped on claims the importer asserts for
 * a catalogue row.
 *
 * Distinct from `ReceiptService`'s `'receipt'`: this claim comes from a
 * structured export that STATED the identifier (a Goodreads ISBN column, an
 * Amazon `ASIN/ISBN` cell), not from reading it off a purchase document, and
 * the provenance is the only thing that tells the two apart afterwards.
 */
const PRODUCT_IDENTIFIER_SOURCE = 'import';

/** One staged row's journey through a batch: what it is, where it goes, what happened. */
interface RowPlan {
  row: StagedItem;
  record: CanonicalRecord;
  destinations: Destination[];
  participants: Map<string, string[]>;
  /** True once ANY destination reported a write for this row. */
  wrote: boolean;
  /** Set only by the per-row retry, and only for a genuine failure. */
  failure: string | null;
  /**
   * The event this record resolved to (created or pre-existing), recorded by
   * the events destination so the content destination — which runs after it —
   * can link to it EXPLICITLY. The provenance-triple auto-link cannot: a
   * work-keyed content row (spotify:track:…, audible:asin:…) carries the
   * work's URI as its source_id while the event carries the per-play id, so
   * they never match and 33k Spotify tracks sat unlinked to 118k listens.
   */
  eventId?: string;
  /** The content row this record resolved to, and whether this push inserted it. */
  contentId?: string;
  contentInserted?: boolean;
}

/**
 * What {@link PushStage.unresolvedEntityReport} puts on the stage's detail.
 *
 * Two names for the skip on purpose: `reason` is the stable slug a caller
 * matches, `message` the sentence a person reads. Reporting only the second
 * would make every consumer parse prose; reporting only the first would throw
 * away the better explanation the ledger already holds.
 */
interface UnresolvedEntityReport {
  reason: string;
  message: string;
  count: number;
  /** data_source → how many of its records had no key. */
  sources: Record<string, number>;
  /** A bounded sample, each identifying one record well enough to find it. */
  examples: string[];
}

/**
 * One unresolved record, in as few words as identify it.
 *
 * These rows have no name — that is what makes them unresolved — so the file
 * the record came from is the identifying fact, and the staged id is the last
 * resort that at least makes the row itself reachable.
 */
function describeUnresolved(row: {
  id: string;
  dataSource: string | null;
  metadata: Record<string, unknown> | null;
}): string {
  const metadata = row.metadata ?? {};
  const files = metadata.Files;
  const origin =
    (typeof metadata.File === 'string' ? metadata.File : null) ??
    (Array.isArray(files) && typeof files[0] === 'string' ? files[0] : null);
  const source = row.dataSource ?? 'unknown';

  return origin ? `${source}: ${origin}` : `${source}: staged row ${row.id}`;
}

/**
 * How often the push re-measures the database volume mid-run.
 *
 * `pg_database_size` stats every file the database owns, so this cannot be
 * per-batch: a 460k-row import is ~920 batches. Fifteen seconds is far shorter
 * than the time it takes to write {@link DATABASE_FREE_FLOOR_BYTES} of rows,
 * which is what the reading has to stay ahead of.
 */
const SPACE_CHECK_INTERVAL_MS = 15_000;

/** What one batch's fan-out produced, per destination. */
type DestinationCounts = Partial<Record<Destination, number>>;

/**
 * Send staged rows into `ci.*`.
 *
 * The stage that makes an import real: everything before it wrote to a scratchpad
 * that is deleted with the run. It fans each staged row out through
 * `destinationsFor` — one row can legitimately reach several destinations, a
 * geotagged photo being both a timeline capture and a GPS donor — and calls the
 * in-process services rather than an HTTP client, which is the whole reason
 * upstream's 8.6k-line transport layer does not come along.
 *
 * ## Resumability
 *
 * Push state is per-row, not a cursor. Each staged item carries its own
 * `push_status`, so a poisoned record sits at `failed` while the rest of the run
 * completes, and a resumed push costs O(remaining) rather than re-sending
 * everything before the failure. That is also why this reads by
 * `push_status = 'pending'` rather than by offset: the query IS the resume
 * point, and it shrinks as the run drains.
 *
 * The counters do NOT shrink with it: a resume seeds them from the rows the
 * ledger already holds settled, so `processed`/`total` carry on from where the
 * dead attempt stopped rather than restarting against the remainder.
 *
 * ## Idempotency belongs to the destination
 *
 * Nothing here checks whether a record already exists. Every input carries the
 * `(source_type, source_system, source_id)` triple, and each destination table
 * has a `*_source_identity_uniq` index over it, so a re-push is a no-op decided by
 * the database. Re-implementing that check here would be a second answer to a
 * question `ci.*` already answers — and the two would drift.
 *
 * ## Running out of disk is a STAGE failure, not a row failure
 *
 * The per-row quarantine above is right for a poisoned record and catastrophic
 * for a full volume: nothing about the next row is different, so a disk-full
 * push marched through the remaining rows marking every one of them `failed`,
 * hammering a full database on the way, and finished "partial" over an import
 * that had simply run out of room. The real incident surfaced as an OCI error
 * from the container runtime with nothing in the import saying what happened.
 *
 * So the stage watches the database's own volume — see `storage/databaseSpace`
 * — and stops on the first sign of the end: a free-space reading under the
 * floor, or SQLSTATE 53100 from any row. Stopping leaves the untouched rows
 * `pending`, which is exactly the state the push resumes from once somebody
 * frees space.
 */
@Injectable()
export class PushStage implements ImportStageRunner {
  readonly kind = 'push' as const;

  /** When {@link assertDatabaseHasRoom} last measured. See SPACE_CHECK_INTERVAL_MS. */
  private lastSpaceCheck = 0;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly communications: CommunicationService,
    private readonly contents: ContentService,
    private readonly events: CalendarEventService,
    private readonly items: ItemService,
    private readonly receipts: ReceiptService,
    private readonly productModels: ProductModelService,
    private readonly observations: ObjectObservationService,
    private readonly objectIdentifiers: ObjectIdentifierService,
    private readonly positions: PositionService,
    private readonly browserActivity: BrowserActivityService,
    private readonly graph: GraphIngestService,
    private readonly signals: EventService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PushStage.name);
  }

  async run(context: StageRunContext): Promise<StageOutcome> {
    // The other half of the disk budget. `archive/unpack` preflights the
    // SCRATCH volume before extracting; this is the volume the rows land on,
    // and until now nothing measured it at all.
    const space = await this.assertDatabaseHasRoom(context);

    // What earlier attempts already settled — read BEFORE `pushEntities` moves
    // rows off 'pending', or this attempt's own work would be counted twice.
    const prior = await this.settledCounts(context.runId);

    // Who "me" is, resolved ONCE for the whole run. WhatsApp and Messenger
    // decide each message's direction by matching its sender against the owner
    // (see push/self), and a run is hundreds of thousands of records — this
    // cannot be a per-record, or even a per-batch, lookup. Also drives owner
    // contact → self Person redirect during entity push.
    const isSelf = await this.resolveIsSelf(context);
    const selfEntityId = await this.resolveSelfEntityId(context.userId);
    const trustMode = await this.resolveTrustMode(context.userId);

    // Entities first, always. A communication names its participants by server
    // entity id, so the people have to exist — and be recorded in
    // `entity_mappings` — before the record that points at them is built.
    const attempt = await this.pushEntities(context, trustMode, selfEntityId);

    const entities = {
      resolved: prior.entities.resolved + attempt.resolved,
      skipped: prior.entities.skipped + attempt.skipped,
      unresolved: prior.entities.unresolved + attempt.unresolved,
      failed: prior.entities.failed + attempt.failed,
    };

    // What was skipped for want of a key, named. Read from the ledger so it
    // covers a resume, and only when there is something to say.
    const unresolvedEntities =
      entities.unresolved > 0 ? await this.unresolvedEntityReport(context.runId) : null;

    if (unresolvedEntities) {
      // Logged as a warning because it no longer shows up as `partial` — see
      // the `partial` computation below. A count that stays inside a JSONB
      // column is not something anyone watching a run go past will notice.
      this.logger.warn('Entities could not be resolved', {
        runId: context.runId,
        reason: UNRESOLVED_ENTITY_REASON,
        count: unresolvedEntities.count,
        sources: unresolvedEntities.sources,
        examples: unresolvedEntities.examples,
      });
    }

    // Entities count toward this stage's total, because resolving them IS part
    // of its work — and because the parse stage already counts them, so leaving
    // them out made the two steps disagree about the same import. A real Amazon
    // archive read 10,890 and saved 10,808, and the missing 82 were exactly the
    // entities: not a loss, but nothing on the page said so.
    //
    // Taken from the outcome rather than a second COUNT: `pushEntities` has
    // already moved these rows off 'pending', so counting them now would return
    // zero. On a resumed push the outcome alone would ALSO be zero — those
    // entities were settled by the earlier attempt — which is what the prior
    // ledger counts folded in above restore.
    const entitiesProcessed = entities.resolved + entities.skipped + entities.failed;

    // Per-destination counts cover this attempt only: the ledger records THAT a
    // row settled, not where it landed, so a resume cannot reconstruct them.
    const counts: DestinationCounts = {};
    let pushed = prior.items.pushed;
    let deduped = prior.items.deduped;
    let failed = prior.items.failed;
    let contentHandled = 0;

    const total = (await this.pendingCount(context.runId)) + entitiesProcessed + pushed + deduped + failed;

    await context.progress({
      processed: entitiesProcessed + pushed + failed + deduped,
      total,
      phase: 'pushing',
    });

    let latestSpace = space;

    for (;;) {
      const batch = await this.nextBatch(context.runId);

      if (batch.length === 0) {
        break;
      }

      const outcome = await this.pushBatch(context, batch, counts, isSelf, selfEntityId);

      pushed += outcome.pushed;
      failed += outcome.failed;
      deduped += outcome.deduped;
      contentHandled += outcome.contentHandled;

      await context.progress({
        processed: entitiesProcessed + pushed + failed + deduped,
        total,
        phase: 'pushing',
      });

      // On a timer, not per batch. `pg_database_size` stats every file the
      // database owns, so at 500 rows a batch a 460k-row import would run it
      // ~920 times; a volume with gigabytes of headroom cannot cross the floor
      // inside fifteen seconds of pushing.
      latestSpace = await this.assertDatabaseHasRoom(context, latestSpace);
    }

    // Everything is in ci.* now; make it searchable. Bulk-pushed rows emit no
    // per-row *CreatedEvent, so without this kick they wait for the pipeline's
    // hourly index sweeps.
    const searchIndex = await this.kickSearchIndexBackfill(context, counts, entities.resolved);
    // …and make it REACHABLE. Searchable and reachable are two different
    // properties with two different writers, and for a long time only the first
    // one was kicked: a graph traversal reads `ci.relationships` and nothing
    // else, so until the edge legs project the linkage columns this push just
    // wrote, every row here is an island.
    const graphEdges = await this.kickGraphEdgeProjection(context, counts);
    // …and give what it links to a face. Content rows arrive with a URL or a
    // streaming title and nothing else; the `enrich.unfurl` stage turns those
    // into titles and posters, and its scheduled cadence is weekly. The Sync
    // step ends here, so this is where "import finished" meets "now enrich".
    const unfurl = await this.kickUnfurlSweep(context, counts, contentHandled);
    // …and give the messages their people. Bulk-pushed communications name
    // their participants only as raw strings in `participants_metadata`; the
    // people behind those strings are created by the stub pass, and until it
    // runs the person-link stage resolves every name to nobody.
    const personStubs = await this.kickPersonStubs(context, counts);

    return {
      // Every staged row is RESOLVED one way or another, and this stage's work
      // is examining all of them — so all three outcomes count toward progress.
      // Reporting only `pushed` made the bar climb to 100% during the push and
      // then jump BACKWARDS when the stage completed: a real import showed
      // 5.8k/10.8k and read as though half of it had failed, when most of the
      // remainder was content that already existed. Whether the work went well
      // is what `partial` and the breakdown below say; this number is progress.
      processed: entitiesProcessed + pushed + deduped + failed,
      total,
      // Rows that could not be sent are not a failed import — the ones that went
      // are in ci.* and useful. The run says `partial` and the ledger says which.
      //
      // `partial` means SOMETHING IS STILL OUTSTANDING: rows a retry can send,
      // an archive a person can re-export. `failed` is that; neither kind of
      // entity skip is.
      //
      // `entities.skipped` never counted here — it also counts bookkeeping-type
      // exclusions (`isGraphExcluded`), an `email_thread` per thread on every
      // ordinary gmail import, which is the stage working as designed.
      // `entities.unresolved` used to, and no longer does. A row with neither a
      // handle nor a name will not resolve on a retry either, and it will not
      // resolve on the next import of the same archive: the record the export
      // handed us is incomplete, and nothing anyone does to this run changes
      // that. Downgrading the whole import for it made `partial` the permanent
      // resting state of a corpus containing ONE such row — a real 4,040-entity
      // Apple archive finished `partial` on every clean-room import because of
      // a single contact card whose only content was a note — and a status that
      // is always on stops being read.
      //
      // The loss is not hidden by this; it is moved to where it can be acted on.
      // `entities.unresolved` is still counted, `detail.entities.unresolvedDetail`
      // now names the reason, the data sources and example records, and the
      // stage logs a warning. A parser regression that unresolves thousands of
      // rows shows up as that count and that warning rather than as a badge
      // shared with every re-import that had nothing to do.
      partial: failed > 0,
      // `deduped` is reported separately from `pushed`: it is a real outcome
      // (the record is in ci.*, it just arrived earlier) and reads as neither a
      // write nor a loss.
      detail: {
        pushed,
        deduped,
        failed,
        destinations: counts,
        // `unresolvedDetail` rides INSIDE `entities` so that the count and the
        // reason for it cannot be read apart, and is absent when there is
        // nothing unresolved — `entities` keeps its four existing keys and
        // their existing meanings for every other run.
        entities: { ...entities, ...(unresolvedEntities ? { unresolvedDetail: unresolvedEntities } : {}) },
        // Reported whether or not it was ever close to the floor. An import
        // that filled a volume is obvious afterwards; what nobody could see is
        // how much room the last one left, which is the number that says
        // whether the next one will fit.
        storage: {
          databaseBytes: latestSpace.databaseBytes,
          databaseFreeBytes: latestSpace.freeBytes,
          databaseDataDir: latestSpace.dataDir,
        },
        // What the post-push search-index kick did (absent when nothing was
        // written, so there was nothing to index).
        ...(searchIndex ? { searchIndex } : {}),
        // Same, for the graph-edge projection. Absent when the push wrote
        // nothing the deterministic-edge matrix has a rule for — a
        // browser-activity-only import is the ordinary case.
        ...(graphEdges ? { graphEdges } : {}),
        // Same, for link previews. Absent when no content rows were written.
        ...(unfurl ? { unfurl } : {}),
        ...(personStubs ? { personStubs } : {}),
        // Additive. `pushed`, `deduped`, `failed`, `destinations` and
        // `entities` above are read by RunPipeline and ImportRunService and
        // keep their exact meaning; this is the per-data-source, reconciled
        // account, and the only place `deduped`'s three constituent outcomes
        // are told apart.
        [SUMMARY_KEY]: await this.summarize(context.runId),
      },
    };
  }

  /**
   * The stage's account of itself, read back out of the ledger it wrote.
   *
   * Two grouped queries, not a set of in-process counters, for the same three
   * reasons MediaStage does it this way — and one more that is specific to the
   * push:
   *
   *  - it covers a RESUME. The counters describe this attempt; a push killed at
   *    50k of 305k and restarted would otherwise report the tail.
   *  - it is per DATA SOURCE, which is what the request asked for and what the
   *    in-process counters cannot give: `counts` is keyed by destination table,
   *    and one Takeout push writes thirteen sources into six tables. The row
   *    carries its own `data_source`, so the group is free.
   *  - it separates the three outcomes that `deduped` merged: already in the
   *    destination, routed nowhere at all (NO_DESTINATION_REASON), and
   *    quarantined. That merge is the reason a re-import and a total failure to
   *    produce anything read identically in the run detail.
   *  - it is O(sources), not O(rows). This stage's largest single run on the QA
   *    corpus is 703,956 staged items.
   *
   * Entities ride in as their own unit rather than being spread across the data
   * sources: `staged_entities.data_source` exists, but an entity is not a
   * record of that source in the sense the rest of this summary counts — and
   * folding people into a per-source "produced" would make the source numbers
   * disagree with the parse stage's, which counts them separately too.
   */
  private async summarize(runId: string): Promise<StageSummary> {
    const itemRows = await this.dataSource.query<
      Array<{ dataSource: string | null; status: string; unrouted: boolean; count: string }>
    >(
      `SELECT data_source AS "dataSource",
              push_status AS status,
              -- IS NOT DISTINCT FROM rather than plain equality: the ordinary
              -- skip leaves push_error NULL, and NULL = 'text' is NULL, not
              -- false. Plain equality therefore split every already-present row
              -- into its own NULL group and made the flag three-valued.
              (push_status = 'skipped' AND push_error IS NOT DISTINCT FROM $2::text) AS unrouted,
              count(*) AS count
         FROM ci_import.staged_items
        WHERE run_id = $1::uuid
        GROUP BY 1, 2, 3`,
      [runId, NO_DESTINATION_REASON],
    );

    const entityRows = await this.dataSource.query<
      Array<{ status: string; reason: string | null; count: string }>
    >(
      `SELECT push_status AS status, push_error AS reason, count(*) AS count
         FROM ci_import.staged_entities
        WHERE run_id = $1::uuid
        GROUP BY 1, 2`,
      [runId],
    );

    const perSource = new Map<string, { produced: number; drops: Record<string, number> }>();

    for (const row of itemRows) {
      const unit = row.dataSource ?? '(unknown)';
      const count = Number(row.count);
      const entry = perSource.get(unit) ?? { produced: 0, drops: {} };

      if (row.status === 'pushed') {
        entry.produced += count;
      } else if (row.status === 'failed') {
        entry.drops.row_push_failed = (entry.drops.row_push_failed ?? 0) + count;
      } else if (row.status === 'skipped') {
        const slug = row.unrouted ? 'no_destination' : 'already_in_destination';

        entry.drops[slug] = (entry.drops[slug] ?? 0) + count;
      } else {
        // Still 'pending': the stage stopped early (out of disk) or is being
        // summarized mid-flight. Counted so `consumed` is the whole run rather
        // than the part that got looked at, and named so the remainder is not
        // mistaken for a loss.
        entry.drops.not_yet_attempted = (entry.drops.not_yet_attempted ?? 0) + count;
      }

      perSource.set(unit, entry);
    }

    let entitiesResolved = 0;
    const entityDrops: Record<string, number> = {};

    for (const row of entityRows) {
      const count = Number(row.count);

      if (row.status === 'pushed') {
        entitiesResolved += count;
      } else if (row.status === 'failed') {
        entityDrops.row_push_failed = (entityDrops.row_push_failed ?? 0) + count;
      } else if (row.status === 'skipped') {
        // The one entity-skip reason that is a GAP rather than bookkeeping:
        // an entity with neither a handle nor a name will not resolve on a
        // retry either. Everything else skipped here is `isGraphExcluded`
        // doing its job — an `email_thread` row per gmail thread — and must
        // not be reported as a loss.
        const slug: DropReason =
          row.reason === UNRESOLVED_ENTITY_REASON ? UNRESOLVED_ENTITY_SLUG : 'entity_excluded';

        entityDrops[slug] = (entityDrops[slug] ?? 0) + count;
      } else {
        entityDrops.not_yet_attempted = (entityDrops.not_yet_attempted ?? 0) + count;
      }
    }

    // Up to five quarantined rows, one per data source, with what they are and
    // why they would not go. Never one per row — see the class comment on
    // scale. `push_error` is the exception's own message, which is the only
    // thing that says WHY, so it is kept verbatim and clipped.
    const samples = await this.dataSource.query<
      Array<{ dataSource: string | null; id: string; error: string | null }>
    >(
      `SELECT DISTINCT ON (data_source) data_source AS "dataSource", id::text AS id,
              left(push_error, 200) AS error
         FROM ci_import.staged_items
        WHERE run_id = $1::uuid AND push_status = 'failed'
        ORDER BY data_source, id
        LIMIT 5`,
      [runId],
    );

    return buildStageSummary({
      stage: 'push',
      unitKind: 'data_source',
      units: [
        ...[...perSource.entries()].map(([unit, entry]) => ({
          unit,
          produced: entry.produced,
          drops: entry.drops,
        })),
        ...(entitiesResolved > 0 || Object.keys(entityDrops).length > 0
          ? [{ unit: '(entities)', produced: entitiesResolved, drops: entityDrops }]
          : []),
      ],
      // A push unit exists because rows were staged for it, so it always had
      // input. A zero here means every one of those rows settled without a
      // write, and the drop ledger says under which reason.
      zeroInputReason: 'nothing_pending',
      samples: samples.map((row) => ({
        reason: dropReasonFor('row_push_failed'),
        slug: 'row_push_failed',
        detail: `${row.dataSource ?? '(unknown)'} ${row.id}: ${row.error ?? '(no message recorded)'}`,
      })),
    });
  }

  /**
   * Post-push search-index kick: request pipeline sweeps of the `index.embed_*`
   * and `index.vector*` stages for exactly the entity types this push wrote, so
   * imported rows become searchable (embeddings + keyword tsvectors) with every
   * row's outcome recorded in `ci.pipeline_state`. Requested over pg-boss
   * ({@link SearchIndexBackfillRequestEvent}, consumed by the pipeline domain's
   * `SearchIndexSweepRequestListener`) rather than by injecting a service: the
   * module dependency would close the cycle maintenance → llm → tools → import,
   * and the queued job survives a process killed between the push completing
   * and the sweeps starting.
   *
   * `person` rides along whenever the entity lane resolved anything: pushed
   * people are raw `GraphIngestService` upserts that emit no `PersonCreatedEvent`,
   * so without the sweep they are never searchable. `entities.resolved` is the
   * CUMULATIVE count (prior attempts included) because a resumed push may be
   * re-running precisely because the attempt that resolved them died before
   * this kick.
   *
   * Fail-soft by design: the rows are safely in `ci.*` and the sweep is
   * idempotent, so a failure to enqueue the request must not fail — or retry —
   * the push stage. It is reported in the stage detail instead, and the missing
   * rows remain exactly what the next sweep (or a manual orchestrate) picks up.
   *
   * Scope caveat, deliberate: destination counts exist for THIS attempt only
   * (the ledger records that a row settled, not where it landed), so a resumed
   * push whose earlier attempt wrote rows and died before kicking requests only
   * what the resume itself wrote. Widening that would mean sweeping every type
   * on every resume; the un-swept remainder is what `/v1/ingest/finish` and the
   * CLI `backfill` command exist for.
   */
  private async kickSearchIndexBackfill(
    context: StageRunContext,
    counts: DestinationCounts,
    entitiesResolved: number,
  ): Promise<Record<string, unknown> | null> {
    const wrote = (Object.entries(counts) as Array<[Destination, number]>)
      .filter(([, count]) => count > 0)
      .map(([destination]) => destination);

    const entityTypes: string[] = [...backfillEntityTypesFor(wrote)];
    if (entitiesResolved > 0) {
      entityTypes.push('person');
    }

    if (entityTypes.length === 0) {
      return null;
    }

    try {
      await this.signals.send(
        SearchIndexBackfillRequestEvent,
        // userId scopes the pipeline sweeps the listener starts — they are
        // per-user by design, like everything on the ledger.
        { userId: context.userId, entityTypes, requestedBy: `import-run:${context.runId}` },
        { queue: SEARCH_INDEX_BACKFILL_QUEUE },
      );
      this.logger.log('Post-push search-index backfill requested', {
        runId: context.runId,
        entityTypes,
      });

      return { requested: entityTypes };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn('Post-push search-index request failed; rows remain for the next sweep', {
        runId: context.runId,
        entityTypes,
        error: message,
      });

      return { requested: entityTypes, error: message };
    }
  }

  /**
   * Post-push GRAPH-EDGE kick: request pipeline sweeps of the `promote.edge_*`
   * legs for exactly the source tables this push wrote, so imported rows are
   * reachable in the graph rather than merely findable in search.
   *
   * ── Why it is a separate kick from the search one ──────────────────────────
   *
   * They answer different questions and they fail independently. Search asks
   * "can I find this row?" and is served by `ci_search.*`; the graph asks "what
   * is this row connected to?" and is served by `ci.relationships`, which the
   * traversal reads and nothing else writes but these legs. Until this existed,
   * a push kicked only the first, and the result was exactly what you would
   * predict: a corpus that was 100% searchable and 0.3% connected.
   *
   * The linkage columns the legs project from — `communications.from_entity_id`
   * / `to_entity_ids`, `content.event_id`, `events.location_entity_id` — are
   * written by THIS STAGE at ingest, not by a nightly linker. That is what makes
   * the kick worth having rather than redundant: the input is complete the
   * moment the push commits.
   *
   * ── Scope, and the empty case ──────────────────────────────────────────────
   *
   * {@link edgeProjectionSourcesFor} maps only the destinations the matrix has a
   * rule for, so a push that wrote nothing but browser activity requests
   * nothing — and requests nothing EXPLICITLY, by returning early, rather than
   * sending a scope-less payload that the listener would read as "every source".
   *
   * Same delivery and same failure policy as its sibling: over pg-boss (a direct
   * `PipelineDispatchService` injection would close the module cycle maintenance
   * → llm → tools → import, and the queued job survives a process killed between
   * the push committing and the sweep starting), and fail-soft — the rows are
   * safely in `ci.*` and the sweep is idempotent, so a failure to enqueue must
   * not fail or retry the push. It is reported in the stage detail instead, and
   * the hourly cadence on these legs picks up whatever the kick did not.
   */
  private async kickGraphEdgeProjection(
    context: StageRunContext,
    counts: DestinationCounts,
  ): Promise<Record<string, unknown> | null> {
    const wrote = (Object.entries(counts) as Array<[Destination, number]>)
      .filter(([, count]) => count > 0)
      .map(([destination]) => destination);

    const sources = edgeProjectionSourcesFor(wrote);

    if (sources.length === 0) {
      return null;
    }

    try {
      await this.signals.send(
        GraphEdgeBackfillRequestEvent,
        { userId: context.userId, sources, requestedBy: `import-run:${context.runId}` },
        { queue: GRAPH_EDGE_BACKFILL_QUEUE },
      );
      this.logger.log('Post-push graph-edge projection requested', {
        runId: context.runId,
        sources,
      });

      return { requested: sources };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn('Post-push graph-edge request failed; edges remain for the next sweep', {
        runId: context.runId,
        sources,
        error: message,
      });

      return { requested: sources, error: message };
    }
  }

  /**
   * Post-push people pass: ask maintenance to create a stub Person (and its
   * identifier) for every participant this push's communications name that
   * the index does not know yet. Fail-soft like the sibling kicks — the rows
   * are in `ci.*`, the pass is idempotent, and an operator can still run it
   * by hand — so a failure to enqueue is reported in the stage detail, never
   * thrown.
   *
   * Only when communications were written: events carry their own people and
   * the other destinations name nobody. `singletonKey` collapses a burst of
   * pushes for one owner into one pass; the pass walks the whole corpus, so a
   * second one queued behind the first would only re-read what the first
   * already covered.
   */
  private async kickPersonStubs(
    context: StageRunContext,
    counts: DestinationCounts,
  ): Promise<Record<string, unknown> | null> {
    if ((counts.communications ?? 0) === 0) {
      return null;
    }

    try {
      await this.signals.send(
        PersonStubBackfillRequestEvent,
        { userId: context.userId, requestedBy: `import-run:${context.runId}` },
        { queue: PERSON_STUB_BACKFILL_QUEUE, singletonKey: `person-stubs:${context.userId}` },
      );
      this.logger.log('Post-push people-stub pass requested', {
        runId: context.runId,
        communications: counts.communications,
      });

      return { requested: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      this.logger.warn('Post-push people-stub request failed; people wait for the operator pass', {
        runId: context.runId,
        error: message,
      });

      return { requested: true, error: message };
    }
  }

  /**
   * Ask the pipeline to unfurl what this push just wrote. Fail-soft like the
   * two kicks above: the rows are in `ci.*`, the sweep is idempotent, and the
   * weekly cadence covers whatever a failed enqueue left behind.
   */
  private async kickUnfurlSweep(
    context: StageRunContext,
    counts: DestinationCounts,
    contentHandled: number,
  ): Promise<Record<string, unknown> | null> {
    // Handled, not written: a re-import of an archive dedups every row and
    // writes nothing, and that is precisely when someone pressing Sync expects
    // enrichment to catch up. The sweep costs one query when nothing is stale.
    if (contentHandled === 0) {
      return null;
    }

    try {
      await this.signals.send(
        UnfurlSweepRequestEvent,
        { userId: context.userId, requestedBy: `import-run:${context.runId}` },
        // One pending sweep per user at a time: a multi-part Takeout pushes in
        // several runs and each would otherwise queue its own identical sweep.
        { queue: UNFURL_SWEEP_QUEUE, singletonKey: `unfurl-sweep:${context.userId}` },
      );
      this.logger.log('Post-push unfurl sweep requested', { runId: context.runId, content: contentHandled });

      return { requested: true, content: contentHandled };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn('Post-push unfurl request failed; previews wait for the scheduled sweep', {
        runId: context.runId,
        error: message,
      });

      return { requested: false, error: message };
    }
  }

  /**
   * Stop before the database volume runs out, rather than after.
   *
   * Returns the reading so the caller can report it. Throttled to
   * {@link SPACE_CHECK_INTERVAL_MS}: passing the previous reading in means a
   * mid-push call inside the window returns it unchanged instead of paying for
   * another `pg_database_size`. The first call of a stage always measures.
   *
   * A volume this process cannot see (`freeBytes: null` — the api and the
   * database in separate containers with no shared mount, and
   * `CI_IMPORT_DB_DATA_DIR` unset) is not treated as full: the push proceeds
   * and relies on {@link isOutOfDiskError} to turn the eventual write failure
   * into the same message. Guessing "full" from an unreadable probe would
   * refuse every import on the shipped topology.
   */
  private async assertDatabaseHasRoom(
    context: StageRunContext,
    previous?: DatabaseSpace,
  ): Promise<DatabaseSpace> {
    const now = Date.now();

    if (previous != null && now - this.lastSpaceCheck < SPACE_CHECK_INTERVAL_MS) {
      return previous;
    }

    this.lastSpaceCheck = now;

    const space = await readDatabaseSpace(this.dataSource);

    if (space.freeBytes != null && space.freeBytes < DATABASE_FREE_FLOOR_BYTES) {
      const error = new DatabaseVolumeFullError(
        space,
        `the push stops while at least ${DATABASE_FREE_FLOOR_BYTES / 1024 ** 3}GiB of headroom is ` +
          `required for the database to stay recoverable`,
      );

      this.logger.error(error, { runId: context.runId });

      throw error;
    }

    return space;
  }

  /**
   * Resolve every staged entity to a `ci.entities` row, and remember what it
   * became.
   *
   * Resolution goes through `GraphIngestService`, which upserts on
   * `(owner_user_id, entity_type, 'import:<sourceSystem>', uuidv5(key))` — so
   * this is cheap to repeat and safe to resume: the second run of a stage that
   * died halfway re-resolves the entities it already did and gets the same ids
   * back. It also indexes each entity's emails and phones into
   * `ci.entity_identifiers`, which is how a person imported from one export is
   * later matched to the same person in another.
   *
   * Only an entity with neither a handle nor a name is SKIPPED — there is
   * nothing to key it on, so every run would mint another row for it.
   *
   * Batched deliberately: `ingest` resolves a whole array in a bounded number of
   * statements, and entity counts here are small next to item counts (82 against
   * 10,808 in a real Amazon archive), so one call covers the run.
   */
  private async pushEntities(
    context: StageRunContext,
    trustMode: TrustMode,
    selfEntityId: string | null,
  ): Promise<{ resolved: number; skipped: number; unresolved: number; failed: number }> {
    await context.progress({ processed: 0, total: null, phase: 'resolving people' });

    const staged = await this.dataSource.query<StagedEntity[]>(
      `SELECT id, run_id AS "runId", user_id AS "userId", type, name, metadata,
              identity_key AS "identityKey", data_source AS "dataSource"
         FROM ci_import.staged_entities
        WHERE run_id = $1::uuid AND push_status = 'pending'
        ORDER BY id`,
      [context.runId],
    );

    const identity = await readSelfIdentity(this.dataSource, context.userId).catch(
      (): SelfIdentity => ({
        names: [],
        email: null,
        phones: [],
      }),
    );

    // Several staged rows can share a natural key — the same artist reached by
    // two parsers in one archive — so the key maps to a LIST. Ingest is given
    // each key once, and every staged row holding it gets the resulting id.
    const byKey = new Map<string, StagedEntity[]>();
    const inputs: GraphEntityInputDto[] = [];
    let skipped = 0;
    let unresolved = 0;
    let resolved = 0;

    for (const row of staged) {
      // Bookkeeping types never reach the graph — see isGraphExcluded. This is
      // a DELIBERATE exclusion, not a gap: gmail stages an `email_thread` entity
      // per thread, so a plain email import would report `skipped` on every
      // single run if this counted the same as `unresolved` below. Marked
      // `skipped` rather than left pending so the row reaches a terminal state
      // and a resumed push does not reconsider it.
      if (isGraphExcluded(row)) {
        skipped += 1;
        await this.markEntity(row.id, 'skipped', null);
        continue;
      }

      const input = toGraphEntity(row);

      if (input == null) {
        // No handle AND no name — nothing about this row will ever have a
        // stable key, so it can never resolve on a later attempt either. This
        // one IS a gap: something the run was handed never made it into the
        // graph, and `unresolved` is what rolls the run up to `partial` for it.
        skipped += 1;
        unresolved += 1;
        await this.markEntity(row.id, 'skipped', UNRESOLVED_ENTITY_REASON);
        continue;
      }

      // Owner-representing contacts map onto the self Person instead of minting
      // a duplicate "bennett" / email-as-name stub.
      if (
        selfEntityId != null &&
        input.entityType === 'Person' &&
        this.isOwnerContactInput(identity, input, trustMode)
      ) {
        await this.recordEntityMapping(row.id, context.userId, selfEntityId);
        await this.markEntity(row.id, 'pushed', null);
        resolved += 1;
        continue;
      }

      const sharing = byKey.get(input.key);

      if (sharing) {
        sharing.push(row);
        continue;
      }

      byKey.set(input.key, [row]);
      inputs.push(input);
    }

    if (inputs.length === 0) {
      this.logger.log('Resolved staged entities', {
        runId: context.runId,
        resolved,
        skipped,
        unresolved,
        failed: 0,
      });

      return { resolved, skipped, unresolved, failed: 0 };
    }

    const result = await this.graph.ingest(
      { userId: context.userId },
      { entities: inputs, relationships: [] },
    );

    for (const mapping of result.entities) {
      for (const row of byKey.get(mapping.key) ?? []) {
        await this.recordEntityMapping(row.id, context.userId, mapping.entityId);
        await this.markEntity(row.id, 'pushed', null);
        resolved += 1;
      }

      byKey.delete(mapping.key);
    }

    // Whatever ingest did not echo back failed. Ingest reports each failure as
    // `entity <key>: <message>`, so each row is given ITS OWN entry. It used to
    // get the whole list joined: a batch-level failure yields one entry per
    // input, so a 4,873-entity Takeout push wrote a ~500KB reason into every
    // failed row and every log line below — quadratic in the batch, 552MB of
    // log, and a worker that died mid-loop with the run stuck at 'running'.
    const reasonByKey = entityErrorsByKey(result.errors);
    const fallback = boundedReason(
      result.errors.length > 0 ? result.errors[0] : 'entity not resolved by graph ingest',
    );
    let failed = 0;

    for (const [key, rows] of byKey.entries()) {
      const reason = reasonByKey.get(key) ?? fallback;

      for (const row of rows) {
        await this.markEntity(row.id, 'failed', reason);
        failed += 1;

        // Logged, not just recorded: an entity that will not resolve costs every
        // record that names it its participants, so it is worth seeing in the
        // log rather than only in a column someone has to go looking for.
        this.logger.warn('Staged entity failed to resolve; continuing', {
          runId: context.runId,
          stagedEntityId: row.id,
          identityKey: row.identityKey,
          error: reason,
        });
      }
    }

    this.logger.log('Resolved staged entities', {
      runId: context.runId,
      resolved,
      skipped,
      unresolved,
      failed,
    });

    return { resolved, skipped, unresolved, failed };
  }

  private async recordEntityMapping(
    stagedEntityId: string,
    userId: string,
    serverEntityId: string,
  ): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO ci_import.entity_mappings (staged_entity_id, user_id, server_entity_id)
            VALUES ($1::uuid, $2::uuid, $3::uuid)
       ON CONFLICT (staged_entity_id) DO UPDATE
            SET server_entity_id = EXCLUDED.server_entity_id, synced_at = now()`,
      [stagedEntityId, userId, serverEntityId],
    );
  }

  private async markEntity(
    stagedEntityId: string,
    status: 'pushed' | 'failed' | 'skipped',
    error: string | null,
  ): Promise<void> {
    await this.dataSource.query(
      // `$2` is used twice. It deduces today because both uses are text, but
      // that is luck, not design — the identical shape in `recordProgress` threw
      // "inconsistent types deduced" because one use was numeric. Cast at both
      // sites so a future change to the status type cannot resurrect it.
      `UPDATE ci_import.staged_entities
          SET push_status = $2::text,
              push_error = $3::text,
              pushed_at = CASE WHEN $2::text = 'pushed' THEN now() END
        WHERE id = $1::uuid`,
      [stagedEntityId, status, error],
    );
  }

  /**
   * The server entity ids a staged item's edges point at, by relation.
   *
   * Joined through `entity_mappings`, so an edge whose entity was skipped or
   * failed simply contributes nothing — the record still pushes, with the
   * participants that did resolve.
   */
  private async participantsFor(stagedItemId: string): Promise<Map<string, string[]>> {
    return (await this.participantsForMany([stagedItemId])).get(stagedItemId) ?? new Map();
  }

  /**
   * WHERE each receipt in a batch happened, as a `ci.entities` Location id.
   *
   * `ci.receipts.place_entity_id` was populated by NO import path — the column
   * that makes a purchase mappable, and the `place_prior` rung
   * `ObjectResolutionService` leans on, were both dead for imported data. It is
   * resolved the two ways a record can state a place, in the order of how much
   * the parser committed to:
   *
   *   1. a STAGED EDGE naming a place entity (relations in
   *      {@link PLACE_RELATIONS}) — read through `ci_import.entity_mappings`,
   *      the same join `resolveCorrespondents` uses for a message's from/to, so
   *      a place the parser already staged needs nothing new;
   *   2. failing that, the record's own `locationName` (the allow-listed
   *      `Location`/`Place`/`Venue`/`Address` metadata keys — see
   *      `canonical.locationNameFor`), resolved-or-created through
   *      `GraphIngestService` under the SAME natural key a staged `place`
   *      entity would have taken ({@link placeKeyFor}), so the two can never
   *      become two nodes for one location.
   *
   * ONE `ingest` call for the whole batch, and none at all when nothing in it
   * names a place — which today is the common case: no commerce parser states
   * an address yet, so this fires for a receipt whose source does (and every
   * one that later does costs nothing more to wire).
   *
   * A failure to resolve is not a failure to import: the receipt is written
   * without a place, which is what it had before.
   */
  private async receiptPlacesFor(
    ctx: { userId: string; importRunId?: string },
    rows: ReadonlyArray<{ record: CanonicalRecord; participants: Map<string, string[]> }>,
  ): Promise<ReceiptEntityLinks[]> {
    const links: ReceiptEntityLinks[] = rows.map(() => ({}));
    // key -> the row indices waiting on it, so one name is ingested once.
    const pending = new Map<string, { name: string; sourceSystem: string; indices: number[] }>();

    rows.forEach(({ record, participants }, index) => {
      for (const relation of PLACE_RELATIONS) {
        const [staged] = participants.get(relation) ?? [];

        if (staged) {
          links[index] = { placeEntityId: staged };

          return;
        }
      }

      const name = record.locationName;

      if (!name) {
        return;
      }

      const key = placeKeyFor(name);

      if (!key) {
        return;
      }

      const waiting = pending.get(key);

      if (waiting) {
        waiting.indices.push(index);
      } else {
        pending.set(key, { name, sourceSystem: record.sourceSystem, indices: [index] });
      }
    });

    if (pending.size === 0) {
      return links;
    }

    const result = await this.graph.ingest(
      { userId: ctx.userId },
      {
        entities: [...pending].map(([key, { name, sourceSystem }]) => ({
          key,
          entityType: PLACE_ENTITY_TYPE,
          name,
          sourceSystem,
        })),
        relationships: [],
      },
    );

    for (const mapping of result.entities) {
      for (const index of pending.get(mapping.key)?.indices ?? []) {
        links[index] = { placeEntityId: mapping.entityId };
      }
    }

    return links;
  }

  /**
   * The same lookup for a whole batch, in ONE query.
   *
   * Asked per row, this was the first of the three round trips every staged row
   * cost — 704,226 of them on the import that prompted the change. Rows with no
   * edges are simply absent from the result map, which callers read as an empty
   * Map, so the query returns only what exists rather than one row per id.
   */
  private async participantsForMany(
    stagedItemIds: readonly string[],
  ): Promise<Map<string, Map<string, string[]>>> {
    const byItem = new Map<string, Map<string, string[]>>();

    if (stagedItemIds.length === 0) {
      return byItem;
    }

    const rows = await this.dataSource.query<
      Array<{ item_id: string; relation: string | null; server_entity_id: string }>
    >(
      `SELECT r.item_id, r.relation, m.server_entity_id
         FROM ci_import.staged_relationships r
         JOIN ci_import.entity_mappings m ON m.staged_entity_id = r.entity_id
        WHERE r.item_id = ANY($1::uuid[])`,
      [stagedItemIds],
    );

    for (const row of rows) {
      const relation = row.relation ?? 'participant';
      let byRelation = byItem.get(row.item_id);

      if (!byRelation) {
        byRelation = new Map<string, string[]>();
        byItem.set(row.item_id, byRelation);
      }

      const existing = byRelation.get(relation);

      if (existing) {
        existing.push(row.server_entity_id);
      } else {
        byRelation.set(relation, [row.server_entity_id]);
      }
    }

    return byItem;
  }

  private async pendingCount(runId: string): Promise<number> {
    const [{ count }] = await this.dataSource.query<Array<{ count: string }>>(
      `SELECT count(*) FROM ci_import.staged_items
        WHERE run_id = $1::uuid AND push_status = 'pending'`,
      [runId],
    );

    return Number(count);
  }

  /**
   * The unresolved entities, named — reason, data sources, and enough of each
   * record to go and look at it.
   *
   * The reason was always recorded; it was never reachable. `push_error` on a
   * `staged_entities` row is excellent prose — "no stable name or handle to
   * resolve by" says exactly what happened and implies what to do about it —
   * and the only way to read it was to write the join against `import_runs` by
   * hand. What the run surfaced instead was the word `partial` and a count of
   * skipped groups that lumped this together with the `email_thread` exclusions
   * a gmail import produces by design.
   *
   * Read from the ledger rather than from this attempt's counters for the same
   * reason {@link settledCounts} is: on a resumed push the rows in question were
   * settled by the attempt that died, and in-process counters would report none
   * of them.
   *
   * `examples` are drawn from the staged metadata — the FILE a record came from
   * is what makes it findable in the export, and these rows have no name by
   * definition. Bounded: a corpus that unresolves ten thousand rows is a bug to
   * be counted, not a list to be pasted into a JSONB column.
   */
  private async unresolvedEntityReport(runId: string): Promise<UnresolvedEntityReport> {
    const [sources, samples] = await Promise.all([
      this.dataSource.query<Array<{ dataSource: string | null; count: string }>>(
        `SELECT data_source AS "dataSource", count(*) AS count
           FROM ci_import.staged_entities
          WHERE run_id = $1::uuid AND push_status = 'skipped' AND push_error = $2
          GROUP BY data_source
          ORDER BY count(*) DESC`,
        [runId, UNRESOLVED_ENTITY_REASON],
      ),
      this.dataSource.query<
        Array<{ id: string; dataSource: string | null; metadata: Record<string, unknown> | null }>
      >(
        `SELECT id, data_source AS "dataSource", metadata
           FROM ci_import.staged_entities
          WHERE run_id = $1::uuid AND push_status = 'skipped' AND push_error = $2
          ORDER BY id
          LIMIT $3`,
        [runId, UNRESOLVED_ENTITY_REASON, UNRESOLVED_EXAMPLE_LIMIT],
      ),
    ]);

    const bySource: Record<string, number> = {};
    let count = 0;

    for (const row of sources) {
      const rows = Number(row.count);
      bySource[row.dataSource ?? 'unknown'] = rows;
      count += rows;
    }

    return {
      reason: UNRESOLVED_ENTITY_SLUG,
      message: UNRESOLVED_ENTITY_REASON,
      count,
      sources: bySource,
      examples: samples.map((row) => describeUnresolved(row)),
    };
  }

  /**
   * What earlier attempts of this stage settled, straight from the ledger.
   *
   * A resumed or retried push seeds its counters here rather than at zero, so
   * `processed` and `total` describe the RUN, not the attempt: a push killed at
   * 50k/305k resumes at 50k/305k instead of restarting the arithmetic against
   * the 255k remainder. On a first attempt every count is zero.
   */
  private async settledCounts(runId: string): Promise<{
    items: { pushed: number; deduped: number; failed: number };
    entities: { resolved: number; skipped: number; unresolved: number; failed: number };
  }> {
    const rows = await this.dataSource.query<
      Array<{ kind: string; status: string; reason: string | null; count: string }>
    >(
      `SELECT 'item' AS kind, push_status AS status, NULL::text AS reason, count(*) AS count
         FROM ci_import.staged_items
        WHERE run_id = $1::uuid AND push_status <> 'pending'
        GROUP BY push_status
       UNION ALL
       -- push_error joins the group so a resumed push can still tell a
       -- bookkeeping-type exclusion apart from a genuinely unresolved entity,
       -- among rows an EARLIER attempt already settled (see
       -- UNRESOLVED_ENTITY_REASON). skipped sums across every reason either way.
       SELECT 'entity' AS kind, push_status AS status, push_error AS reason, count(*) AS count
         FROM ci_import.staged_entities
        WHERE run_id = $1::uuid AND push_status <> 'pending'
        GROUP BY push_status, push_error`,
      [runId],
    );

    const items = { pushed: 0, deduped: 0, failed: 0 };
    const entities = { resolved: 0, skipped: 0, unresolved: 0, failed: 0 };

    for (const row of rows) {
      const count = Number(row.count);

      if (row.kind === 'item') {
        if (row.status === 'pushed') {
          items.pushed += count;
        } else if (row.status === 'skipped') {
          items.deduped += count;
        } else if (row.status === 'failed') {
          items.failed += count;
        }
      } else {
        if (row.status === 'pushed') {
          entities.resolved += count;
        } else if (row.status === 'skipped') {
          entities.skipped += count;

          if (row.reason === UNRESOLVED_ENTITY_REASON) {
            entities.unresolved += count;
          }
        } else if (row.status === 'failed') {
          entities.failed += count;
        }
      }
    }

    return { items, entities };
  }

  /**
   * The next slice of unpushed rows.
   *
   * Ordered by id, which is a v7 uuid — so this walks the run in the order the
   * parser staged it, and a record's participants and its edges stay near each
   * other rather than being scattered across batches.
   */
  private async nextBatch(runId: string): Promise<StagedItem[]> {
    return this.dataSource.query<StagedItem[]>(
      `SELECT id, run_id AS "runId", user_id AS "userId", data_source AS "dataSource",
              classification, content_hash AS "contentHash", occurred_at AS "occurredAt",
              timespan_end AS "timespanEnd", latitude, longitude, filename,
              media_type AS "mediaType", original_location AS "originalLocation",
              intermediate_location AS "intermediateLocation", metadata,
              created_at AS "createdAt"
         FROM ci_import.staged_items
        WHERE run_id = $1::uuid AND push_status = 'pending'
        ORDER BY id
        LIMIT $2`,
      [runId, PUSH_BATCH],
    );
  }

  /**
   * The owner's own display names, as a predicate — one query for the run.
   *
   * FAIL SAFE, deliberately: a lookup that finds nothing, or one that throws,
   * yields {@link NOBODY_IS_SELF}, so every WhatsApp/Messenger message keeps
   * the `inbound` default this repo shipped before the mappers were wired in.
   * The alternatives are both worse than a blank — failing the push over a
   * missing display name strands an import that is otherwise fine, and
   * guessing writes a false authorship claim into somebody's memory. Logged at
   * warn either way, because a corpus that silently classifies every message
   * inbound is the bug this change exists to fix.
   */
  private async resolveIsSelf(context: StageRunContext): Promise<IsSelf> {
    try {
      const identity = await readSelfIdentity(this.dataSource, context.userId);
      const isSelf = makeIsSelf(identity);

      if (isSelf === NOBODY_IS_SELF) {
        this.logger.warn('No owner name resolved; chat messages stay inbound', {
          runId: context.runId,
          userId: context.userId,
        });
      }

      return isSelf;
    } catch (err) {
      this.logger.warn('Owner lookup failed; chat messages stay inbound', {
        runId: context.runId,
        userId: context.userId,
        error: (err as Error).message,
      });

      return NOBODY_IS_SELF;
    }
  }

  private async resolveSelfEntityId(userId: string): Promise<string | null> {
    const rows: Array<{ entity_id: string | null }> = await this.dataSource.query(
      `SELECT entity_id FROM ci.users WHERE id = $1::uuid`,
      [userId],
    );

    return rows[0]?.entity_id ?? null;
  }

  /**
   * Read Autonomy trust from the self Person planner — same source as
   * PersonalizationService.getTrustMode, without importing that module (avoids
   * import ↔ personalization ↔ llm ↔ tools cycles).
   */
  private async resolveTrustMode(userId: string): Promise<TrustMode> {
    const rows: Array<{ trust_mode: string | null }> = await this.dataSource.query(
      `SELECT e.properties -> 'planner' ->> 'trust_mode' AS trust_mode
         FROM ci.users u
         JOIN ci.entities e ON e.entity_id = u.entity_id
        WHERE u.id = $1::uuid
        LIMIT 1`,
      [userId],
    );

    const raw = rows[0]?.trust_mode;

    return raw === 'cautious' || raw === 'balanced' || raw === 'hands_off' ? raw : 'balanced';
  }

  private isOwnerContactInput(
    identity: SelfIdentity,
    input: GraphEntityInputDto,
    trustMode: TrustMode,
  ): boolean {
    const props = input.properties ?? {};
    const candidates: string[] = [];
    if (typeof input.name === 'string') {
      candidates.push(input.name);
    }

    if (typeof props.email === 'string') {
      candidates.push(props.email);
    }

    for (const email of Array.isArray(props.emails) ? props.emails : []) {
      if (typeof email === 'string') {
        candidates.push(email);
      }
    }

    if (typeof props.phone === 'string') {
      candidates.push(props.phone);
    }

    for (const phone of Array.isArray(props.phones) ? props.phones : []) {
      if (typeof phone === 'string') {
        candidates.push(phone);
      }
    }

    const ownerPhones = identity.phones;

    for (const candidate of candidates) {
      const match = matchOwner(identity, candidate, { phones: ownerPhones });
      if (shouldMapContactToSelf(match, trustMode)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Push one batch, row by row.
   *
   * Per-row rather than per-destination-bulk deliberately: a single malformed
   * record must not fail the 499 staged beside it, and the only way to know
   * WHICH row a bulk rejection belonged to is not to bulk it. The destinations
   * are the expensive part of an import only in aggregate; a batch of 500 is
   * where the cost actually lives, and that is still batched.
   */
  private async pushBatch(
    context: StageRunContext,
    batch: StagedItem[],
    counts: DestinationCounts,
    isSelf: IsSelf,
    selfEntityId: string | null,
  ): Promise<{ pushed: number; failed: number; deduped: number; unrouted: number; contentHandled: number }> {
    // importRunId rides the context so every ledger row this push writes is
    // attributed to this run (ci.record_sources.import_run_id).
    const ctx = { userId: context.userId, importRunId: context.runId };

    // ONE query for the batch's edges, not one per row.
    const participantsByItem = await this.participantsForMany(batch.map((row) => row.id));

    const plans: RowPlan[] = batch.map((row) => {
      const record = toCanonical(row);

      return {
        row,
        record,
        destinations: destinationsFor(record),
        participants: participantsByItem.get(row.id) ?? new Map<string, string[]>(),
        wrote: false,
        failure: null,
      };
    });

    // One call per DESTINATION for the whole batch, rather than one call per
    // row per destination. Ordering across destinations is preserved from the
    // per-row loop: a row reaching several still reaches them in this order.
    for (const destination of DESTINATION_ORDER) {
      const group = plans.filter((plan) => plan.failure == null && plan.destinations.includes(destination));

      if (group.length === 0) {
        continue;
      }

      await this.sendGroup(ctx, destination, group, counts, isSelf, selfEntityId, context);
    }

    await this.linkSharedContent(ctx, plans, context);

    return {
      ...(await this.recordOutcomes(context, plans)),
      // Routed to content at all — written, deduped or failed — for the unfurl kick.
      contentHandled: plans.filter((plan) => plan.destinations.includes('content')).length,
    };
  }

  /**
   * `Content -DOCUMENTS-> Event` for every record whose content row ALREADY
   * EXISTED when this push reached it. A work-keyed content row has one
   * `event_id` and it belongs to the first play; the second and every later
   * play of the same track/book/title can only reach their content through
   * the edge. (An inserted row carries its event in the column, and the
   * `promote.edge_content` stage projects that into the same edge — so those
   * are left to it, and the edge upsert makes the two paths converge anyway.)
   * Fail-soft: the rows are in ci.*, and a missed edge is what the edge sweep
   * exists to catch.
   */
  private async linkSharedContent(
    ctx: { userId: string; importRunId?: string },
    plans: RowPlan[],
    context: StageRunContext,
  ): Promise<void> {
    const relationships = plans
      .filter(
        (plan) => plan.contentId && plan.eventId && plan.contentInserted === false && plan.failure == null,
      )
      .map((plan) => ({
        fromKey: `content:${plan.contentId}`,
        toKey: `event:${plan.eventId}`,
        fromEntityId: plan.contentId!,
        fromEntityType: 'Content',
        toEntityId: plan.eventId!,
        toEntityType: 'Event',
        type: 'DOCUMENTS',
        properties: { derived_from: 'import_push' },
      }));

    if (relationships.length === 0) {
      return;
    }

    try {
      await this.graph.ingest(ctx, { entities: [], relationships });
    } catch (err) {
      this.logger.warn('Linking shared content rows to their events failed; the edge sweep will retry', {
        runId: context.runId,
        edges: relationships.length,
        error: (err as Error).message,
      });
    }
  }

  /**
   * Send one destination's share of a batch, degrading to per-row on failure.
   *
   * The batch call is ONE transaction, so a single unacceptable row would roll
   * back every other row with it — and the per-row quarantine this stage is
   * built on (a bad record is marked `failed` and the import continues) would
   * become "one bad record fails 500 good ones". So a failed group is retried
   * row by row through the original {@link send}, which reaches exactly the
   * outcomes it always did: a duplicate key is `skipped`, anything else is that
   * ONE row `failed`.
   *
   * Out of disk is rethrown without the retry: nothing about the next row
   * avoids it, and 500 more attempts only delay the stage failing with a cause.
   */
  private async sendGroup(
    ctx: { userId: string; importRunId?: string },
    destination: Destination,
    group: RowPlan[],
    counts: DestinationCounts,
    isSelf: IsSelf,
    selfEntityId: string | null,
    context: StageRunContext,
  ): Promise<void> {
    try {
      const wrote = await this.sendMany(ctx, destination, group, counts, isSelf, selfEntityId);

      for (const [index, plan] of group.entries()) {
        if (wrote[index]) {
          counts[destination] = (counts[destination] ?? 0) + 1;
          plan.wrote = true;
        }
      }

      return;
    } catch (err) {
      if (isOutOfDiskError(err)) {
        throw new DatabaseVolumeFullError(
          await readDatabaseSpace(this.dataSource),
          `the database refused a write while saving ${group.length} ${destination} record(s)`,
        );
      }

      this.logger.warn('Batched push failed; retrying the group row by row', {
        runId: context.runId,
        destination,
        rows: group.length,
        error: (err as Error).message,
      });
    }

    for (const plan of group) {
      try {
        if (await this.send(ctx, destination, plan.record, plan.participants, counts, isSelf, selfEntityId)) {
          counts[destination] = (counts[destination] ?? 0) + 1;
          plan.wrote = true;
        }
      } catch (err) {
        if (isDuplicateKey(err)) {
          // The dedup working, not a failure: something already in ci.* carries
          // this identity. Leaving `wrote` false lands the row in `skipped`,
          // which is terminal, so a resumed push does not reconsider it.
          continue;
        }

        if (isOutOfDiskError(err)) {
          throw new DatabaseVolumeFullError(
            await readDatabaseSpace(this.dataSource),
            `the database refused a write while saving ${plan.record.sourceSystem} record ${plan.row.id}`,
          );
        }

        plan.failure = (err as Error).message;

        this.logger.warn('Staged row failed to push; continuing', {
          runId: context.runId,
          stagedItemId: plan.row.id,
          dataSource: plan.record.sourceSystem,
          kind: plan.record.kind,
          error: plan.failure,
        });
      }
    }
  }

  /**
   * Write the batch's outcomes to the ledger in three statements, not 500.
   *
   * Rows are grouped by the destination set they reached, because `pushed_ref`
   * carries it — typically one or two distinct sets in a batch, since a batch
   * of Google Voice messages all take the same lane.
   */
  private async recordOutcomes(
    context: StageRunContext,
    plans: RowPlan[],
  ): Promise<{ pushed: number; failed: number; deduped: number; unrouted: number }> {
    const pushedByDestinations = new Map<string, string[]>();
    const skipped: string[] = [];
    // Rows `destinationsFor` routed nowhere. Kept apart from `skipped` from
    // here down — see NO_DESTINATION_REASON.
    const unrouted: string[] = [];
    const failures: Array<{ id: string; error: string }> = [];

    for (const plan of plans) {
      if (plan.failure != null) {
        failures.push({ id: plan.row.id, error: plan.failure });
        continue;
      }

      // `wrote` is per DESTINATION, and a row can reach several. It counts as a
      // write if ANY destination wrote it: an Audible listen whose audiobook
      // already exists still produces a new event, so calling the whole row a
      // duplicate would lose the event it did create.
      if (plan.wrote) {
        const key = JSON.stringify(plan.destinations);
        const existing = pushedByDestinations.get(key);

        if (existing) {
          existing.push(plan.row.id);
        } else {
          pushedByDestinations.set(key, [plan.row.id]);
        }

        continue;
      }

      // A row with NO destinations was never offered to anything, so "already
      // there" is not what happened to it. Both are terminal and neither is a
      // failure, but only one of them means the record exists.
      if (plan.destinations.length === 0) {
        unrouted.push(plan.row.id);

        continue;
      }

      // Marked the same way as a row whose duplicate surfaced as a 23505,
      // because it is the same outcome reached by a quieter route: every
      // destination already held this record.
      skipped.push(plan.row.id);
    }

    let pushed = 0;

    for (const [key, ids] of pushedByDestinations) {
      await this.markPushedMany(ids, JSON.parse(key) as Destination[]);
      pushed += ids.length;
    }

    await this.markSkippedMany(skipped, null);
    await this.markSkippedMany(unrouted, NO_DESTINATION_REASON);

    for (const failure of failures) {
      await this.markFailed(failure.id, failure.error);
    }

    if (failures.length > 0) {
      this.logger.warn('Batch finished with failed rows', {
        runId: context.runId,
        failed: failures.length,
      });
    }

    // `deduped` keeps its old meaning for the caller's counters and for
    // `detail.deduped`, which RunPipeline renders: both outcomes are "the row
    // settled without a write". The summary is where they are told apart.
    return {
      pushed,
      failed: failures.length,
      deduped: skipped.length + unrouted.length,
      unrouted: unrouted.length,
    };
  }

  /**
   * Decide a communication's sender and recipients from its staged edges.
   *
   * Importers stage edges under three vocabularies, and this used to honour
   * only one. `from`/`to`/`cc` is the mail-shaped vocabulary the email
   * importers emit. A CHAT importer has no such split — a 1:1 conversation has
   * one other party — so imessage and whatsapp stage `participant` instead, and
   * record which way the message went in the edge's own metadata.
   *
   * Reading only from/to left every chat message with no sender at all. On a
   * real import that was 432,173 iMessages — every message the owner has ever
   * exchanged, staged WITH 290,043 resolved participant edges, and connected to
   * nobody. The Person entities existed; the messages simply never pointed at
   * them.
   *
   * The direction is what disambiguates a `participant`: on an inbound message
   * the other party is the SENDER, on an outbound one they are the RECIPIENT.
   * An explicit from/to edge always wins, so nothing about the mail path
   * changes.
   */
  private resolveCorrespondents(
    participants: Map<string, string[]>,
    direction: string | undefined,
    selfEntityId: string | null,
  ): { from?: string; to: string[] } {
    const stripSelf = (ids: string[]) =>
      selfEntityId == null ? ids : ids.filter((id) => id !== selfEntityId);

    const [explicitFrom] = participants.get('from') ?? [];
    const explicitTo = [...(participants.get('to') ?? []), ...(participants.get('cc') ?? [])];

    if (explicitFrom != null || explicitTo.length > 0) {
      return {
        from: explicitFrom === selfEntityId ? selfEntityId : explicitFrom,
        to: stripSelf(explicitTo),
      };
    }

    const others = participants.get('participant') ?? [];

    if (others.length === 0) {
      return {
        from: direction === 'outbound' ? (selfEntityId ?? undefined) : undefined,
        to: [],
      };
    }

    // Outbound: the owner sent it — from=self, recipients are everyone else.
    if (direction === 'outbound') {
      return { from: selfEntityId ?? undefined, to: stripSelf(others) };
    }

    const [first, ...rest] = others;
    if (first === selfEntityId) {
      return { from: undefined, to: stripSelf(rest) };
    }

    return { from: first, to: stripSelf(rest) };
  }

  /**
   * Catalogue the attachments a message LINKS to rather than carries.
   *
   * The other shape of the communication-attachment lane. Sources whose export
   * ships the bytes are handled upstream by MediaStage, which uploads each file
   * and stamps `metadata.AttachmentContentIds` before the push ever runs.
   * Discord ships no bytes at all: every upload survives in the package only as
   * a signed cdn.discordapp.com URL in the message's `Attachments` field,
   * space-separated when a message carries several. There is nothing to upload,
   * so there is nothing for MediaStage to do — and the rows still have to be
   * written by something.
   *
   * ## Why here, and not as a `content` destination
   *
   * Two reasons, and the first is fatal on its own.
   *
   * `attachmentsFor` builds `communications.attachments` out of the ids in
   * metadata, so the content rows have to EXIST before the message that points
   * at them is built. {@link DESTINATION_ORDER} writes `communications` first;
   * anything the `content` destination wrote would land after the row that was
   * supposed to reference it, and the column would stay empty. The `content`
   * destination is also strictly one input per record — `sendMany` maps
   * `group` through {@link toContentInput} and {@link aligned} rejects any
   * length mismatch — and a message with three attachment links needs three
   * rows, not one. So this is a pre-step of the communications lane rather than
   * a destination of its own, which is exactly what the mapping has always said
   * it was (see `discordAttachmentUrls`).
   *
   * ## What it writes
   *
   * One row per link, from {@link discordAttachmentContentInputs}: the
   * uploaded filename decoded out of the signed URL, a mimetype only when the
   * extension gives one honestly, and the message's provenance triple with an
   * `:attachment:<n>` suffix on the sourceId — the same identity convention
   * MediaStage uses for the bytes-bearing half, so the two halves of the lane
   * cannot mint colliding or differently-shaped rows. The triple makes the
   * write idempotent: a re-import, or the row-by-row retry of a failed batch,
   * resolves onto the same ids rather than duplicating them.
   *
   * `AttachmentFileIds` is deliberately NOT written. `attachmentsFor` documents
   * the two arrays as index-aligned pairs of `{ file, content }`, and there is
   * no file half here — a link is all the package gave us. It concatenates the
   * two lists independently, so a content-only list arrives as
   * `[{ type: 'content', id }, …]`, which is the honest description of a
   * message whose attachments live on someone else's CDN.
   *
   * Counted under `content` because that is the table it wrote, which is what
   * makes the post-push search-index and graph-edge kicks fire for these rows
   * — a Discord-only import writes to no other content lane, so without the
   * tally the rows would sit unindexed until the next hourly sweep. The unit is
   * a ROW here, not a staged record: one message can produce several.
   */
  private async catalogueLinkAttachments(
    ctx: { userId: string; importRunId?: string },
    records: CanonicalRecord[],
    counts: DestinationCounts,
  ): Promise<void> {
    // One call for the whole batch, so a 500-message batch is one round trip
    // rather than 500. `plans` keeps each record's slice of the flattened
    // input list, because the ids come back in input order and have to be
    // stamped back onto the record that produced them.
    const inputs: CreateContentDto[] = [];
    const plans: Array<{ record: CanonicalRecord; start: number; length: number }> = [];

    for (const record of records) {
      const built = discordAttachmentContentInputs(record);

      if (built.length === 0) {
        continue;
      }

      plans.push({ record, start: inputs.length, length: built.length });
      inputs.push(...built);
    }

    if (inputs.length === 0) {
      return;
    }

    // emitCreated:false, like every other destination on this path: bulk ingest
    // defers indexing to the post-load batch machinery kicked at the end of the
    // stage.
    const results = await this.contents.createManyDetailed(ctx, inputs, { emitCreated: false });

    // Same contract, and the same reason to check it, as `aligned`: a short
    // result array would silently re-pair every attachment after the gap onto
    // the wrong message. Throwing hands the group to the row-by-row retry,
    // which asks the same question one message at a time.
    if (results.length !== inputs.length) {
      throw new Error(
        `content returned ${results.length} result(s) for ${inputs.length} attachment input(s); ` +
          'the batched write cannot be attributed to messages',
      );
    }

    for (const plan of plans) {
      const slice = results.slice(plan.start, plan.start + plan.length);

      plan.record.metadata.AttachmentContentIds = slice.map((result) => result.entity.id);
    }

    const inserted = results.filter((result) => result.inserted).length;

    if (inserted > 0) {
      counts.content = (counts.content ?? 0) + inserted;
    }
  }

  /**
   * Hand a whole batch's share of ONE destination to the service that owns it,
   * and report per row whether that destination actually wrote.
   *
   * The services have always taken arrays — `createManyDetailed` returns one
   * {@link BulkInsertResult} per input, in input order, and chunks internally
   * against the bind-param limit. The per-row path called them with
   * single-element arrays, so a 704,226-row import made 704,226 round trips
   * where it could have made ~1,400. Nothing about the mapping changes here;
   * only how many rows travel per call.
   *
   * The returned array is aligned with `group`, index for index. A service that
   * returns fewer results than inputs would silently mark the tail as
   * not-written, so the length is checked rather than trusted.
   */
  private async sendMany(
    ctx: { userId: string; importRunId?: string },
    destination: Destination,
    group: RowPlan[],
    counts: DestinationCounts,
    isSelf: IsSelf,
    selfEntityId: string | null,
  ): Promise<boolean[]> {
    switch (destination) {
      case 'communications': {
        // Before the messages, not after: the ids these rows resolve to ride in
        // the message's own `attachments` column, and this lane is the only
        // chance to put them there. See `catalogueLinkAttachments`.
        await this.catalogueLinkAttachments(
          ctx,
          group.map((plan) => plan.record),
          counts,
        );

        const inputs = group.map((plan) => {
          // WhatsApp and Messenger get their own mappers — see `send`.
          const input = isWhatsAppRecord(plan.record)
            ? toWhatsAppCommunicationInput(plan.record, isSelf)
            : isFacebookMessengerRecord(plan.record)
              ? toFacebookMessengerCommunicationInput(plan.record, isSelf)
              : toCommunicationInput(plan.record);

          const { from, to } = this.resolveCorrespondents(plan.participants, input.direction, selfEntityId);

          if (from) {
            input.from_entity_id = from;
          }

          if (to.length) {
            input.to_entity_ids = to;
          }

          return input;
        });

        return aligned(await this.communications.createManyDetailed(ctx, inputs), group, destination);
      }

      case 'content': {
        const results = await this.contents.createManyDetailed(
          ctx,
          group.map((plan) => withEvent(toContentInput(plan.record), plan.eventId)),
        );
        group.forEach((plan, index) => {
          plan.contentId = results[index]?.entity?.id;
          plan.contentInserted = results[index]?.inserted ?? false;
        });

        return aligned(results, group, destination);
      }

      case 'events': {
        const results = await this.events.createDetailed(
          ctx,
          group.map((plan) => toEventInput(plan.record)),
        );
        group.forEach((plan, index) => {
          plan.eventId = results[index]?.entity?.id;
        });

        return aligned(results, group, destination);
      }

      case 'things':
        return aligned(
          await this.items.createManyDetailed(
            ctx,
            group.map((plan) => toThingInput(plan.record)),
          ),
          group,
          destination,
        );

      case 'product_models': {
        // Sparse by construction: `destinationsFor` routes a record here on its
        // identifiers, and the mapper still refuses one that names nothing.
        const planned = group.flatMap((plan, index) => {
          const input = toProductModelInput(plan.record);

          return input ? [{ index, input, record: plan.record }] : [];
        });

        const wrote = group.map(() => false);

        if (planned.length === 0) {
          return wrote;
        }

        // Idempotent on the IDENTITY triple (see toProductModelInput), so the
        // same ISBN arriving from Goodreads and from an Amazon order is one
        // catalogue row and the second push reports `inserted: false`.
        const results = await this.productModels.createManyDetailed(
          ctx,
          planned.map(({ input }) => input),
        );

        if (results.length !== planned.length) {
          throw new Error(
            `${destination} returned ${results.length} result(s) for ${planned.length} input(s); ` +
              `the batched write cannot be attributed to rows`,
          );
        }

        // Claim the barcodes for every catalogued row, not only the newly
        // inserted ones. The claim index is first-writer-wins, so re-asserting
        // an existing claim is a no-op — while skipping the call for a row that
        // was already present would leave anything minted by an earlier,
        // claim-less push permanently unreachable by barcode.
        const claims = planned.flatMap(({ record }, i) => {
          const identifiers = productModelIdentifiers(record);

          if (identifiers.length === 0) {
            return [];
          }

          return [
            {
              subjectType: 'product_model' as const,
              subjectId: results[i].entity.id,
              identifiers: identifiers.map((identifier) => ({
                namespace: identifier.namespace,
                value: identifier.value,
                ...(identifier.confidence != null ? { confidence: identifier.confidence } : {}),
              })),
              source: PRODUCT_IDENTIFIER_SOURCE,
            },
          ];
        });

        if (claims.length > 0) {
          await this.objectIdentifiers.upsertForSubjects(ctx.userId, claims);
        }

        planned.forEach(({ index }, i) => {
          wrote[index] = results[i].inserted;
        });

        return wrote;
      }

      case 'receipts': {
        // One transaction per receipt, deliberately. `upsertFromExtraction` is
        // header + lines + product resolution + identifier promotion as a unit,
        // and the unit is the point: a claim inserted outside the transaction
        // that created its product survives that product's rollback, and
        // first-writer-wins makes the orphan permanent. Receipts are a small
        // fraction of any import, so the round trips are affordable in a way
        // they would not be for events or content.
        const wrote: boolean[] = [];
        // Batched, so the whole group costs at most ONE graph round trip.
        const places = await this.receiptPlacesFor(ctx, group);

        for (const [index, plan] of group.entries()) {
          await this.receipts.upsertFromExtraction(
            ctx,
            toReceiptInput(plan.record, toReceiptLineItemInputs(plan.record), places[index]),
          );
          // `upsertFromExtraction` has no inserted/found signal — it patches a
          // matched header rather than reporting one — so this counts receipts
          // WRITTEN, not receipts new. Same honest limitation `position` carries.
          wrote.push(true);
        }

        return wrote;
      }

      case 'observations': {
        const built = group.map((plan) => toObservationInput(plan.record));
        const rows = built.filter((row): row is NonNullable<typeof row> => row != null);

        if (rows.length > 0) {
          // Keyed on the provenance triple (every row here carries one), so a
          // re-import updates rather than duplicating. The write result counts
          // rows, not inputs, so it cannot be aligned per row — see below.
          await this.observations.createMany(ctx, rows);
        }

        // A row that produced an input reached the service; one that produced
        // none never did. `createMany` reports batch totals rather than a
        // per-input verdict, so this is "offered", not "inserted" — the same
        // shape `position` uses.
        return built.map((row) => row != null);
      }

      case 'browser_activity':
        return aligned(
          await this.browserActivity.createManyDetailed(
            ctx,
            group.map((plan) => toBrowserActivityInput(plan.record)),
          ),
          group,
          destination,
        );

      case 'position': {
        // `destinationsFor` routes on `rec.coordinates`, and so does this
        // builder — but it returns null rather than throwing, so a disagreement
        // between the two skips the row instead of failing the import.
        const built = group.map((plan) => toPositionInput(plan.record));
        const positions = built.filter(
          (position): position is NonNullable<typeof position> => position != null,
        );

        if (positions.length > 0) {
          // PositionService has no upsert-reporting variant: positions carry no
          // provenance triple, so every call writes.
          //
          // emitCreated:false, like every other destination on this path: bulk
          // ingest defers indexing to the post-load batch machinery, and the
          // default would emit one position.created per GPS point.
          await this.positions.create(ctx, positions, { emitCreated: false });
        }

        return built.map((position) => position != null);
      }
    }
  }

  /**
   * Hand one record to the service that owns its destination, and report whether
   * that destination actually WROTE a row.
   *
   * Every destination upserts, so a collision is absorbed silently rather than
   * raised — which is correct for ingest and useless for reporting. Counting
   * sends instead of writes claimed 7,339 content records for an archive that
   * produced 2,354: content is keyed on the work, so 4,443 Audible listening
   * sessions collapse onto 88 audiobooks. The `*Detailed` variants exist to tell
   * the two apart.
   */
  private async send(
    ctx: { userId: string; importRunId?: string },
    destination: Destination,
    record: CanonicalRecord,
    participants: Map<string, string[]>,
    counts: DestinationCounts,
    isSelf: IsSelf,
    selfEntityId: string | null,
  ): Promise<boolean> {
    switch (destination) {
      case 'communications': {
        // Same pre-step as the batch path, for the same reason — and re-running
        // it after a failed batch is free: the content rows dedup on their
        // provenance triple, so the record resolves onto the ids it already had.
        await this.catalogueLinkAttachments(ctx, [record], counts);

        // WhatsApp and Messenger get their own mappers, because their exports
        // carry no "this one is me" signal for the generic path to read: a
        // `_chat.txt` line is a display name and a body, so `directionFor`
        // returns null and every message — the owner's own included — takes
        // toCommunicationInput's `inbound` default. Both mappers decide
        // direction by matching the sender against the owner instead, and the
        // WhatsApp one also reads thread_id off `Conversation`, which the
        // generic path never looks at (it reads ThreadId/Thread/MessageID), so
        // without this branch every WhatsApp message also loses its chat
        // grouping. Everything else is unchanged.
        const input = isWhatsAppRecord(record)
          ? toWhatsAppCommunicationInput(record, isSelf)
          : isFacebookMessengerRecord(record)
            ? toFacebookMessengerCommunicationInput(record, isSelf)
            : toCommunicationInput(record);

        // The whole point of staging edges: a message reaches ci.* with a sender
        // and recipients rather than as text from nobody. `from` is single by
        // definition; everything else addressed is a recipient.
        //
        // `selfEntityId` is threaded through rather than passed as null. This is
        // the row-by-row RETRY of a batch that failed, so it must decide
        // correspondents identically to `sendMany` — and with null it did not:
        // an outbound message got `from` undefined instead of the owner, and a
        // group chat kept the owner's own entity in `to_entity_ids` because
        // `stripSelf` had nothing to strip. A retried batch produced quietly
        // different rows from a batch that happened to succeed.
        const { from, to } = this.resolveCorrespondents(participants, input.direction, selfEntityId);

        if (from) {
          input.from_entity_id = from;
        }

        if (to.length) {
          input.to_entity_ids = to;
        }

        return wroteAnything(await this.communications.createManyDetailed(ctx, [input]));
      }

      case 'content':
        return wroteAnything(await this.contents.createManyDetailed(ctx, [toContentInput(record)]));
      // (The per-row retry carries no plan, so it cannot pass the event; the
      // batched path above is the one that links, and the edge sweep covers it.)
      case 'events':
        // An ARRAY, deliberately: `createDetailed` is the batched path, and only
        // the batched path is idempotent. A bare object takes `createOne`, which
        // inserts unconditionally.
        return wroteAnything(await this.events.createDetailed(ctx, [toEventInput(record)]));
      case 'things':
        return wroteAnything(await this.items.createManyDetailed(ctx, [toThingInput(record)]));
      case 'product_models': {
        const input = toProductModelInput(record);

        if (input == null) {
          return false;
        }

        const [result] = await this.productModels.createManyDetailed(ctx, [input]);
        const identifiers = productModelIdentifiers(record);

        if (result != null && identifiers.length > 0) {
          await this.objectIdentifiers.upsertForSubjects(ctx.userId, [
            {
              subjectType: 'product_model',
              subjectId: result.entity.id,
              identifiers: identifiers.map((identifier) => ({
                namespace: identifier.namespace,
                value: identifier.value,
                ...(identifier.confidence != null ? { confidence: identifier.confidence } : {}),
              })),
              source: PRODUCT_IDENTIFIER_SOURCE,
            },
          ]);
        }

        return result?.inserted ?? false;
      }

      case 'receipts': {
        const [place] = await this.receiptPlacesFor(ctx, [{ record, participants }]);

        await this.receipts.upsertFromExtraction(
          ctx,
          toReceiptInput(record, toReceiptLineItemInputs(record), place),
        );

        // Written, not necessarily new — `upsertFromExtraction` patches a
        // matched header rather than reporting one. See `sendMany`.
        return true;
      }

      case 'observations': {
        const input = toObservationInput(record);

        // `destinationsFor` routes on the record's identifiers and so does this
        // builder — but it returns null rather than throwing, so a disagreement
        // between the two skips the row instead of failing the import.
        if (input == null) {
          return false;
        }

        await this.observations.createMany(ctx, [input]);

        return true;
      }

      case 'browser_activity':
        return wroteAnything(
          await this.browserActivity.createManyDetailed(ctx, [toBrowserActivityInput(record)]),
        );
      case 'position': {
        const position = toPositionInput(record);

        // `destinationsFor` routes on `rec.coordinates`, and so does this
        // builder — but it returns null rather than throwing, so a disagreement
        // between the two skips the row instead of failing the import.
        if (position == null) {
          return false;
        }

        // PositionService has no upsert-reporting variant: positions carry no
        // provenance triple, so every call writes.
        //
        // emitCreated:false, like every other destination on this path: bulk
        // ingest defers indexing to the post-load batch machinery, and the
        // default would emit one position.created per GPS point — a Location
        // History import is hundreds of thousands of them, each a warning when
        // nothing listens on that queue.
        await this.positions.create(ctx, [position], { emitCreated: false });

        return true;
      }
    }
  }

  /**
   * Record where a row went.
   *
   * `pushed_ref` holds the destinations rather than the created ids: a row can
   * reach several, the services return differently-shaped rows, and what the
   * relationship wiring needs to know is which lane a record took.
   */
  private async markPushedMany(stagedItemIds: string[], destinations: Destination[]): Promise<void> {
    if (stagedItemIds.length === 0) {
      return;
    }

    await this.dataSource.query(
      `UPDATE ci_import.staged_items
          SET push_status = 'pushed', pushed_at = now(), push_error = NULL, pushed_ref = $2::jsonb
        WHERE id = ANY($1::uuid[])`,
      [stagedItemIds, JSON.stringify({ destinations })],
    );
  }

  /**
   * Considered and deliberately not written.
   *
   * `reason` is NULL for the ordinary case — the destination already held the
   * record — and {@link NO_DESTINATION_REASON} for a row nothing was willing to
   * take. Both are `skipped`, because both are terminal and neither is a
   * failure; the reason is what lets a resumed push, and the stage summary,
   * tell "already there" from "never offered to anything".
   */
  private async markSkippedMany(stagedItemIds: string[], reason: string | null): Promise<void> {
    if (stagedItemIds.length === 0) {
      return;
    }

    await this.dataSource.query(
      `UPDATE ci_import.staged_items
          SET push_status = 'skipped', pushed_at = now(), push_error = $2::text
        WHERE id = ANY($1::uuid[])`,
      [stagedItemIds, reason],
    );
  }

  private async markFailed(stagedItemId: string, error: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE ci_import.staged_items
          SET push_status = 'failed', push_error = $2
        WHERE id = $1::uuid`,
      [stagedItemId, error],
    );
  }
}

/**
 * Postgres 23505 — unique violation — however the driver wrapped it.
 *
 * Checked on both the error and its `driverError`, because TypeORM surfaces the
 * code in different places depending on which query path raised it.
 */
/** Whether a batch ingest call wrote at least one row, rather than finding them all. */
/**
 * Read a batched service's results back onto the rows that produced them.
 *
 * The contract is one result per input in input order; a shorter array would
 * quietly report the tail as "already there" and mark real writes as skipped,
 * so a mismatch fails the group instead — the caller's row-by-row retry then
 * gets the honest per-row answer.
 */
/** The content input with its record's event attached, unless the record named one itself. */
function withEvent<T extends { event?: { id: string } }>(input: T, eventId: string | undefined): T {
  if (input.event || !eventId) {
    return input;
  }

  return { ...input, event: { id: eventId } };
}

function aligned<Entity>(
  results: Array<{ inserted: boolean; entity: Entity }>,
  group: RowPlan[],
  destination: Destination,
): boolean[] {
  if (results.length !== group.length) {
    throw new Error(
      `${destination} returned ${results.length} result(s) for ${group.length} input(s); ` +
        `the batched write cannot be attributed to rows`,
    );
  }

  return results.map((result) => result.inserted);
}

function wroteAnything(results: ReadonlyArray<{ inserted: boolean }>): boolean {
  return results.some((result) => result.inserted);
}

function isDuplicateKey(err: unknown): boolean {
  const wrapped = err as { code?: string; driverError?: { code?: string } };

  return wrapped?.code === '23505' || wrapped?.driverError?.code === '23505';
}

/** Longest reason recorded against one staged entity or logged for it. */
const MAX_ENTITY_REASON_CHARS = 1_000;

function boundedReason(reason: string): string {
  return reason.length > MAX_ENTITY_REASON_CHARS ? `${reason.slice(0, MAX_ENTITY_REASON_CHARS)}…` : reason;
}

/**
 * GraphIngestService reports a failed entity as `entity <key>: <message>`; map
 * each key to its own (bounded) message so a row is never charged with every
 * other entity's failure. Keys can contain `: ` (a contact named "a: b"), so the
 * split is on the LAST `: ` whose left side is a key ingest was actually given —
 * callers look keys up in their own map, and an unmatched key simply misses.
 */
export function entityErrorsByKey(errors: readonly string[]): Map<string, string> {
  const byKey = new Map<string, string>();

  for (const error of errors) {
    if (!error.startsWith('entity ')) {
      continue;
    }

    const body = error.slice('entity '.length);
    let at = body.indexOf(': ');

    while (at !== -1) {
      const key = body.slice(0, at);

      if (!byKey.has(key)) {
        byKey.set(key, boundedReason(error));
      }

      at = body.indexOf(': ', at + 2);
    }
  }

  return byKey;
}
