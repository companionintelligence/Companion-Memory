import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { Between, DataSource, In, IsNull, LessThanOrEqual, MoreThanOrEqual, Not, Repository } from 'typeorm';

import { SYSTEM_USER, type ServiceContext, type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { appendRecordSources, computeChunkSize } from '@ci/common/persistence';

import {
  type ObjectObservation,
  ObjectObservationEntity,
  type ObservationBoundingBox,
} from '../entities/ObjectObservationEntity';
import type {
  CreateObjectObservationDto,
  FindObjectObservationsFilter,
  ResolveObjectObservationDto,
} from '../types';

/**
 * Decimal places a bbox is rounded to before it enters a detection key.
 *
 * Coordinates are normalized to 0..1, so three places is ~1 px on a 1000 px
 * edge. That is deliberately coarser than detector jitter (the same model over
 * the same JPEG re-decodes to boxes that differ in the fourth place) and far
 * finer than the gap between two distinct objects — which is the whole job of
 * this constant: absorb noise, never merge things.
 */
const DETECTION_KEY_BBOX_PRECISION = 3;

/**
 * Version tag on every derived detection key.
 *
 * Baked into the digest, so changing the derivation below produces keys that
 * cannot collide with keys already in the table. Bumping it re-keys every
 * detector-generated row: the next detector pass INSERTs rather than UPDATEs,
 * and the old rows are orphaned rather than silently mismatched. That is a
 * migration, not a routine change — bump it only with a plan for the old rows.
 */
const DETECTION_KEY_VERSION = 1;

/** Columns whose values a re-detection is allowed to refresh. */
const REFRESHABLE_COLUMNS = [
  'observed_at',
  'source_kind',
  'content_id',
  'file_id',
  'event_id',
  'place_entity_id',
  'location_coordinates',
  'label',
  'label_source',
  'detector',
  'detector_version',
  'detection_confidence',
  'bbox',
  'crop_content_id',
] as const;

/** What one {@link ObjectObservationService.createMany} call actually did. */
export interface ObjectObservationWriteResult {
  /** Rows that landed — inserted, or updated in place by their arbiter. */
  written: ObjectObservation[];
  /**
   * Rows that matched an existing sighting a HUMAN has confirmed, and were
   * therefore left exactly as they are. Not an error and not a failure: it is
   * the guard working. See {@link ObjectObservationService.createMany}.
   */
  protectedByConfirmation: number;
  /**
   * Rows that collapsed into an earlier row of the SAME batch because they
   * derived the same arbiter. Counted rather than silently dropped, because a
   * non-zero number here usually means a detector emitted the same box twice.
   */
  duplicatesInBatch: number;
  /**
   * Rows refused because they carried neither a provenance triple nor enough
   * material to derive a detection key. Never written — an unarbitered row
   * duplicates on every re-run, which is the failure this table's two partial
   * unique indexes exist to prevent.
   */
  rejectedUnarbitered: number;
}

/** A row, flattened for the `unnest` write. */
interface WritableRow {
  id: string | null;
  observedAt: Date;
  sourceKind: string;
  contentId: string | null;
  fileId: string | null;
  eventId: string | null;
  placeEntityId: string | null;
  lat: number | null;
  lon: number | null;
  label: string;
  labelSource: string | null;
  detector: string | null;
  detectorVersion: string | null;
  detectionConfidence: number | null;
  bbox: string | null;
  cropContentId: string | null;
  attributes: string;
  detectionKey: string | null;
  metadata: string;
  sourceType: string | null;
  sourceSystem: string | null;
  sourceId: string | null;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** A confidence is a number in [0, 1] or nothing. Anything else is nothing. */
function clampConfidence(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) {
    return null;
  }

  return Math.min(1, Math.max(0, value));
}

/** A bbox is four finite numbers or it is not a bbox. */
function validBbox(bbox: ObservationBoundingBox | null | undefined): ObservationBoundingBox | null {
  if (bbox == null) {
    return null;
  }

  const { x, y, w, h } = bbox;

  if (![x, y, w, h].every((value) => typeof value === 'number' && Number.isFinite(value))) {
    return null;
  }

  return { x, y, w, h };
}

/**
 * The idempotency arbiter for rows with no provenance triple, and the reason
 * this service — not its callers — owns it.
 *
 * ── Why two schemes ────────────────────────────────────────────────────────
 *
 * The migration describes the key as a digest of `(content_id, detector,
 * rounded bbox)`. That is exactly right for a detector that emits boxes, and it
 * is a data-loss bug for one that does not: `ThingVisionListener`'s Ollama vision
 * pass returns a LIST OF ITEMS WITH NO BOXES, so every object in the photo
 * would digest to the identical key and the whole image would collapse to one
 * observation — the same shape as the `hashItem` defect
 * `identity/naturalKey.ts` was written to fix, where a constant filename and no
 * record id collapsed a day of Netflix history into a single row.
 *
 * So the scheme is chosen by what the detector actually supplied, and NAMED in
 * the key so the two can never be confused:
 *
 *  - `box`   — an anchor, the detector, and the rounded box. Spatial identity.
 *    The label is deliberately NOT in it, so re-running a better model that
 *    relabels "cup" → "coffee mug" UPDATES the sighting instead of forking it.
 *  - `label` — an anchor, the detector, and the normalized label. Used only
 *    when there is no box, where the label is the sole discriminator available.
 *    The cost is the mirror image: a relabel here does fork the row, because
 *    nothing else distinguishes two sightings in the same image.
 *
 * `detector_version` is in NEITHER, on purpose. Re-running a newer build of the
 * same detector over the same pixels must update the row rather than duplicate
 * it — "must update in place, not duplicate" is the migration's requirement,
 * and putting the version in the key would violate it once per model upgrade.
 *
 * Returns `null` when there is not enough to be stable with, which the caller
 * turns into a refusal rather than an unarbitered insert.
 */
export function detectionKeyFor(dto: CreateObjectObservationDto): string | null {
  // content_id first (the migration's choice), file_id as the fallback anchor:
  // a CV pass over an upload knows the file long before a ci.content row for it
  // exists, and keying that pass on nothing would be worse than keying it on
  // the file.
  const anchor = dto.contentId ?? dto.fileId;

  if (anchor == null) {
    return null;
  }

  const detector = (dto.detector ?? '').trim() || 'unknown';
  const bbox = validBbox(dto.bbox);

  if (bbox != null) {
    const rounded = [bbox.x, bbox.y, bbox.w, bbox.h].map((value) =>
      value.toFixed(DETECTION_KEY_BBOX_PRECISION),
    );

    return `obs:v${DETECTION_KEY_VERSION}:box:${sha256Hex([anchor, detector, ...rounded].join('\0'))}`;
  }

  const label = dto.label.trim().toLowerCase();

  if (label === '') {
    return null;
  }

  return `obs:v${DETECTION_KEY_VERSION}:label:${sha256Hex([anchor, detector, label].join('\0'))}`;
}

/**
 * The only writer of `ci.object_observations` — the SIGHTING half of object
 * identity.
 *
 * The table shipped in migration `20260803223022` with a full column set, two
 * idempotency arbiters and a downstream edge projection
 * (`promote.edge_observation`) already built against it, and no writer at all.
 * Every consumer of the sighting layer — the CV listener's `Thing` branch, the
 * `capture.scan` promoter, and any future review UI — writes through here.
 *
 * ── The one rule ───────────────────────────────────────────────────────────
 *
 * DETECTION AND RESOLUTION ARE DIFFERENT CLAIMS, AND THIS CLASS NEVER LETS ONE
 * WRITE THE OTHER.
 *
 * `create`/`createMany` accept a {@link CreateObjectObservationDto}, which has
 * no way to express `resolvedObjectId`, `resolutionMethod` or
 * `confirmedByUser`; the write statement excludes those columns from its
 * `DO UPDATE SET` list, so a re-detection cannot touch them either. Resolution
 * arrives only through {@link resolve}, and `confirmed_by_user` only through
 * {@link confirm}. That is the type-level and SQL-level form of the
 * distinction the migration header states in prose: "a coffee mug is visible in
 * this photo" is not "I own this specific coffee mug".
 *
 * Nothing here writes `ci.objects`. Minting an owned unit from a sighting is
 * `ObjectResolutionService`'s job and it does not exist yet; until it does, a
 * sighting resolves to an object only when something else already created that
 * object and hands its id to {@link resolve}.
 *
 * ── Why raw SQL ────────────────────────────────────────────────────────────
 *
 * Three reasons, all structural: the table has TWO partial unique indexes and a
 * statement can name only one conflict target (so a mixed batch is two
 * statements); `location_coordinates` is `geography` and needs
 * `ST_MakePoint`; and `embedding` is `vector(768)`, unmapped by the entity by
 * design. Reads go back through the repository, which is what keeps 768 floats
 * per row out of every ordinary query.
 */
@Injectable()
export class ObjectObservationService {
  constructor(
    @InjectRepository(ObjectObservationEntity)
    private readonly observationRepository: Repository<ObjectObservationEntity>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ObjectObservationService.name);
  }

  /**
   * Record one sighting.
   *
   * Returns `null` when the sighting matched an existing row a human has
   * already confirmed (left untouched), or when it carried no usable arbiter
   * (refused). Both are visible in the {@link createMany} result if the caller
   * needs to tell them apart.
   */
  async create(
    context: UserServiceContext,
    dto: CreateObjectObservationDto,
  ): Promise<ObjectObservation | null> {
    const result = await this.createMany(context, [dto]);

    return result.written[0] ?? null;
  }

  /**
   * Record a batch of sightings idempotently.
   *
   * ── The three things this does that a plain INSERT does not ───────────────
   *
   *  1. PICKS AN ARBITER PER ROW. A row with a `sourceId` is keyed on the
   *     provenance triple; a row without one gets a derived
   *     {@link detectionKeyFor} key. The two are written as separate statements
   *     because they hit different partial unique indexes and a statement can
   *     name only one `ON CONFLICT` target. A row that can supply neither is
   *     REFUSED, not inserted: an unarbitered row is a row that duplicates on
   *     every retry, and this table has two unique indexes precisely so that
   *     never happens.
   *
   *  2. COLLAPSES WITHIN-BATCH REPEATS FIRST. Two rows in one statement that
   *     share a conflict target make Postgres raise "ON CONFLICT DO UPDATE
   *     command cannot affect row a second time" and abort the WHOLE chunk —
   *     so a detector that emitted the same box twice would lose the entire
   *     slice, not the duplicate. They are folded in JS, last write winning,
   *     and counted.
   *
   *  3. REFUSES TO OVERWRITE A HUMAN. `DO UPDATE … WHERE NOT o.confirmed_by_user`
   *     is the same protection `ObjectPromoteStage` gives a promoted object
   *     row, and stronger: that one compares timestamps and can be fooled by a
   *     writer that forgets `updated_at`, this one reads the flag whose entire
   *     purpose is to mean "a human said so". Once a sighting is confirmed, no
   *     detector re-run rewrites its label, its box or its attributes.
   *
   * The resolution columns are absent from the update list entirely, so even an
   * UNconfirmed row keeps whatever it has been resolved to across re-detection.
   */
  async createMany(
    context: UserServiceContext,
    dtos: CreateObjectObservationDto[],
  ): Promise<ObjectObservationWriteResult> {
    const empty: ObjectObservationWriteResult = {
      written: [],
      protectedByConfirmation: 0,
      duplicatesInBatch: 0,
      rejectedUnarbitered: 0,
    };

    if (dtos.length === 0) {
      return empty;
    }

    // Partition by arbiter, folding within-batch repeats as we go. Two maps
    // rather than one because the arbiters live in different index spaces: a
    // triple and a detection key can never collide, so keying them together
    // would be a coincidence away from a wrong merge.
    const byTriple = new Map<string, WritableRow>();
    const byDetectionKey = new Map<string, WritableRow>();
    let duplicatesInBatch = 0;
    let rejectedUnarbitered = 0;

    for (const dto of dtos) {
      const label = dto.label?.trim() ?? '';

      if (label === '') {
        // The migration's words: "an observation with no label carries no
        // information". NOT NULL would catch an absent label; it would not
        // catch "   ".
        rejectedUnarbitered += 1;
        continue;
      }

      const sourceId = dto.sourceId?.trim() || null;
      const detectionKey = sourceId == null ? detectionKeyFor(dto) : null;

      if (sourceId == null && detectionKey == null) {
        rejectedUnarbitered += 1;
        continue;
      }

      const bbox = validBbox(dto.bbox);
      const coordinates = dto.coordinates ?? null;
      const lat = coordinates != null && Number.isFinite(coordinates.lat) ? coordinates.lat : null;
      const lon = coordinates != null && Number.isFinite(coordinates.lon) ? coordinates.lon : null;

      const row: WritableRow = {
        id: dto.id ?? null,
        observedAt: dto.observedAt,
        sourceKind: dto.sourceKind ?? 'photo',
        contentId: dto.contentId ?? null,
        fileId: dto.fileId ?? null,
        eventId: dto.eventId ?? null,
        placeEntityId: dto.placeEntityId ?? null,
        // Both or neither: a half-coordinate is not a location, and
        // ST_MakePoint with one NULL yields NULL anyway — deciding it here
        // keeps that from looking like a database quirk.
        lat: lat != null && lon != null ? lat : null,
        lon: lat != null && lon != null ? lon : null,
        label,
        labelSource: dto.labelSource ?? null,
        detector: dto.detector ?? null,
        detectorVersion: dto.detectorVersion ?? null,
        detectionConfidence: clampConfidence(dto.detectionConfidence),
        bbox: bbox != null ? JSON.stringify(bbox) : null,
        cropContentId: dto.cropContentId ?? null,
        attributes: JSON.stringify(dto.attributes ?? {}),
        detectionKey,
        metadata: JSON.stringify(dto.metadata ?? {}),
        sourceType: dto.sourceType ?? null,
        sourceSystem: dto.sourceSystem ?? null,
        sourceId,
      };

      const target = sourceId != null ? byTriple : byDetectionKey;
      // Identity is the (source_system, source_id) pair — source_type is
      // provenance and stays out of the key, matching
      // object_observations_source_identity_uniq.
      const key = sourceId != null ? `${row.sourceSystem ?? ''}\0${sourceId}` : (detectionKey as string);

      if (target.has(key)) {
        duplicatesInBatch += 1;
      }

      target.set(key, row);
    }

    const writtenIds: string[] = [];
    let attempted = 0;

    const partitions: Array<[WritableRow[], string]> = [
      [[...byTriple.values()], '(owner_user_id, source_system, source_id) WHERE source_id IS NOT NULL'],
      [[...byDetectionKey.values()], '(owner_user_id, detection_key) WHERE detection_key IS NOT NULL'],
    ];

    for (const [rows, conflictTarget] of partitions) {
      if (rows.length === 0) {
        continue;
      }

      attempted += rows.length;
      writtenIds.push(...(await this.writeRows(context, rows, conflictTarget)));
    }

    const written = await this.hydrate(context, writtenIds);

    return {
      written,
      // Every row we attempted that did not come back from RETURNING was
      // excluded by the confirmed_by_user guard — it is the only clause that
      // can exclude one.
      protectedByConfirmation: attempted - writtenIds.length,
      duplicatesInBatch,
      rejectedUnarbitered,
    };
  }

  /**
   * Attach a sighting to an owned unit and/or a catalog product.
   *
   * Deliberately cannot set `confirmed_by_user`, and rejects
   * `resolutionMethod: 'user'` — a decision a machine reached is not a decision
   * a human made, and the flag that distinguishes them is the one thing
   * downstream consumers are entitled to trust. Use {@link confirm} for that.
   *
   * Passing `null` for both ids with method `'none'` is how a wrong resolution
   * is retracted; the sighting itself survives, which is the point of keeping
   * the two layers apart.
   */
  async resolve(
    context: ServiceContext,
    id: string,
    dto: ResolveObjectObservationDto,
  ): Promise<ObjectObservation | null> {
    if ((dto.resolutionMethod as string) === 'user') {
      throw new Error(
        "resolutionMethod 'user' is reserved for ObjectObservationService.confirm(), which is the " +
          'only writer of confirmed_by_user. A machine-reached resolution must name the method it ' +
          'actually used (identifier | embedding | place_prior | label).',
      );
    }

    const existing = await this.findById(context, id);

    if (existing == null) {
      return null;
    }

    if (existing.confirmedByUser) {
      // Same rule as the write path: a human's answer is not a machine's to
      // revise. Returned unchanged rather than thrown, because a resolver
      // sweeping a batch should skip these, not abort.
      this.logger.log('Observation is user-confirmed, leaving resolution untouched', {
        observationId: id,
      });

      return existing;
    }

    await this.observationRepository.update(
      { id, ...(context.userId !== SYSTEM_USER && { userId: context.userId }) },
      {
        resolvedObjectId: dto.resolvedObjectId ?? null,
        resolvedProductId: dto.resolvedProductId ?? null,
        resolutionMethod: dto.resolutionMethod,
        resolutionConfidence: clampConfidence(dto.resolutionConfidence),
      },
    );

    return this.findById(context, id);
  }

  /**
   * Record that a HUMAN confirmed (or retracted) this sighting's resolution.
   *
   * The only writer of `confirmed_by_user` in the codebase. Confirming sets
   * `resolution_method = 'user'`, because after a person has looked at it the
   * method that matters is that a person looked at it.
   *
   * Retracting (`confirmed: false`) clears the flag but LEAVES the resolution
   * in place under method `'user'`: "I am no longer certain" is not "this was
   * never linked", and throwing the link away would lose the only record of
   * what the human thought.
   */
  async confirm(
    context: ServiceContext,
    id: string,
    confirmed = true,
    resolution?: Pick<ResolveObjectObservationDto, 'resolvedObjectId' | 'resolvedProductId'>,
  ): Promise<ObjectObservation | null> {
    const existing = await this.findById(context, id);

    if (existing == null) {
      return null;
    }

    await this.observationRepository.update(
      { id, ...(context.userId !== SYSTEM_USER && { userId: context.userId }) },
      {
        confirmedByUser: confirmed,
        resolutionMethod: 'user',
        // A human's answer has no meaningful sub-1 confidence: they either said
        // it or they did not.
        resolutionConfidence: confirmed ? 1 : null,
        ...(resolution?.resolvedObjectId !== undefined && {
          resolvedObjectId: resolution.resolvedObjectId,
        }),
        ...(resolution?.resolvedProductId !== undefined && {
          resolvedProductId: resolution.resolvedProductId,
        }),
      },
    );

    return this.findById(context, id);
  }

  async findById(context: ServiceContext, id: string): Promise<ObjectObservation | null> {
    return this.observationRepository.findOne({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && { userId: context.userId }),
      },
    });
  }

  /** Scoped read. Every filter is optional; the default is "this user's sightings, newest first". */
  async find(
    context: ServiceContext,
    filter: FindObjectObservationsFilter = {},
  ): Promise<ObjectObservation[]> {
    const { limit = 100, offset = 0 } = filter;

    return this.observationRepository.find({
      where: {
        ...(context.userId !== SYSTEM_USER && { userId: context.userId }),
        ...(filter.placeEntityId != null && { placeEntityId: filter.placeEntityId }),
        ...(filter.contentId != null && { contentId: filter.contentId }),
        ...(filter.fileId != null && { fileId: filter.fileId }),
        ...(filter.eventId != null && { eventId: filter.eventId }),
        ...(filter.label != null && { label: filter.label }),
        ...(filter.resolved != null && {
          resolvedObjectId: filter.resolved ? Not(IsNull()) : IsNull(),
        }),
        ...(filter.confirmedByUser != null && { confirmedByUser: filter.confirmedByUser }),
        ...(filter.reviewedByUser != null && {
          resolutionMethod: filter.reviewedByUser ? 'user' : Not('user' as const),
        }),
        ...(filter.observedFrom != null &&
          filter.observedTo != null && {
            observedAt: Between(filter.observedFrom, filter.observedTo),
          }),
        ...(filter.observedFrom != null &&
          filter.observedTo == null && { observedAt: MoreThanOrEqual(filter.observedFrom) }),
        ...(filter.observedFrom == null &&
          filter.observedTo != null && { observedAt: LessThanOrEqual(filter.observedTo) }),
      },
      order: { observedAt: 'DESC' },
      take: limit,
      skip: offset,
    });
  }

  /**
   * The review queue: sightings nobody has confirmed and nothing has resolved,
   * newest first.
   *
   * Matches `object_observations_review_idx` exactly — the partial index the
   * migration added for this one query. It also leaves out sightings a person
   * already answered "not a thing" (`rejectObservation`: unconfirmed, unlinked,
   * method `user`). They match the index predicate too, so they stayed at the
   * top of the queue however often they were rejected, and the resolution sweep
   * that reads this queue could link them again.
   */
  async findForReview(context: ServiceContext, limit = 100, offset = 0): Promise<ObjectObservation[]> {
    return this.find(context, {
      confirmedByUser: false,
      resolved: false,
      reviewedByUser: false,
      limit,
      offset,
    });
  }

  /**
   * One chunked, idempotent multi-row upsert.
   *
   * `unnest` over parallel arrays, so the bind-parameter count is CONSTANT in
   * the row count (23 arrays, not 23 × rows) and the 65535 wire-protocol
   * ceiling is not the binding constraint here. The chunking is still real, and
   * it is about statement size and how long one statement holds its locks on a
   * multi-thousand-detection scan — the same reason `chunkedConflictInsert`
   * exists.
   */
  private async writeRows(
    context: UserServiceContext,
    rows: WritableRow[],
    conflictTarget: string,
  ): Promise<string[]> {
    const userId = context.userId;
    const chunkSize = computeChunkSize(this.observationRepository.metadata.columns.length);
    const ids: string[] = [];

    const updates = REFRESHABLE_COLUMNS.map((column) => `${column} = excluded.${column}`).join(
      ',\n            ',
    );

    for (let offset = 0; offset < rows.length; offset += chunkSize) {
      const chunk = rows.slice(offset, offset + chunkSize);

      const returned = await this.dataSource.query<
        Array<{
          observation_id: string;
          source_type: string | null;
          source_system: string | null;
          source_id: string | null;
        }>
      >(
        `INSERT INTO ci.object_observations AS o (
           observation_id, user_id, owner_user_id, observed_at, source_kind,
           content_id, file_id, event_id, place_entity_id, location_coordinates,
           label, label_source, detector, detector_version, detection_confidence,
           bbox, crop_content_id, attributes, detection_key, metadata,
           source_type, source_system, source_id
         )
         SELECT COALESCE(u.id, ci.gen_uuid_v7()),
                $1::uuid,
                -- owner_user_id is NOT decorative: both unique indexes are
                -- keyed on it, so leaving it NULL would make the whole
                -- idempotency argument false (the same trap ObjectPromoteStage
                -- documents for ci.objects).
                $1::uuid,
                u.observed_at, u.source_kind,
                u.content_id, u.file_id, u.event_id, u.place_entity_id,
                CASE WHEN u.lat IS NOT NULL AND u.lon IS NOT NULL
                     THEN ST_SetSRID(ST_MakePoint(u.lon, u.lat), 4326)::geography
                END,
                u.label, u.label_source, u.detector, u.detector_version, u.detection_confidence,
                u.bbox, u.crop_content_id, COALESCE(u.attributes, '{}'::jsonb),
                u.detection_key, COALESCE(u.metadata, '{}'::jsonb),
                u.source_type, u.source_system, u.source_id
           FROM unnest(
                  $2::uuid[], $3::timestamptz[], $4::text[], $5::uuid[], $6::uuid[],
                  $7::uuid[], $8::uuid[], $9::float8[], $10::float8[], $11::text[],
                  $12::text[], $13::text[], $14::text[], $15::real[], $16::jsonb[],
                  $17::uuid[], $18::jsonb[], $19::text[], $20::jsonb[], $21::text[],
                  $22::text[], $23::text[]
                ) AS u(id, observed_at, source_kind, content_id, file_id,
                       event_id, place_entity_id, lat, lon, label,
                       label_source, detector, detector_version, detection_confidence, bbox,
                       crop_content_id, attributes, detection_key, metadata, source_type,
                       source_system, source_id)
         ON CONFLICT ${conflictTarget}
         DO UPDATE SET
            ${updates},
            -- MERGED, not replaced: a reviewer's note or another writer's key
            -- in either bag survives a re-detection.
            attributes = COALESCE(o.attributes, '{}'::jsonb) || excluded.attributes,
            metadata   = COALESCE(o.metadata, '{}'::jsonb) || excluded.metadata,
            updated_at = now()
          -- THE HUMAN GUARD. resolved_object_id, resolved_product_id,
          -- resolution_method, resolution_confidence and confirmed_by_user are
          -- absent from the SET list above, so a re-detection never revises a
          -- resolution. This clause goes further and freezes the DETECTION
          -- columns too once a person has confirmed the sighting: after someone
          -- has looked at it and said yes, the label they agreed to is not the
          -- next model's to overwrite.
          WHERE NOT o.confirmed_by_user
         RETURNING o.observation_id, o.source_type, o.source_system, o.source_id`,
        [
          userId,
          chunk.map((row) => row.id),
          chunk.map((row) => row.observedAt),
          chunk.map((row) => row.sourceKind),
          chunk.map((row) => row.contentId),
          chunk.map((row) => row.fileId),
          chunk.map((row) => row.eventId),
          chunk.map((row) => row.placeEntityId),
          chunk.map((row) => row.lat),
          chunk.map((row) => row.lon),
          chunk.map((row) => row.label),
          chunk.map((row) => row.labelSource),
          chunk.map((row) => row.detector),
          chunk.map((row) => row.detectorVersion),
          chunk.map((row) => row.detectionConfidence),
          chunk.map((row) => row.bbox),
          chunk.map((row) => row.cropContentId),
          chunk.map((row) => row.attributes),
          chunk.map((row) => row.detectionKey),
          chunk.map((row) => row.metadata),
          chunk.map((row) => row.sourceType),
          chunk.map((row) => row.sourceSystem),
          chunk.map((row) => row.sourceId),
        ],
      );

      ids.push(...returned.map((row) => row.observation_id));

      // Ledger the arrivals that carried a full triple (detection-key rows

      // have none) — inserts AND refresh-hits alike evidence the record.

      await appendRecordSources(
        this.dataSource.manager,
        { table: 'object_observations', userId },
        returned
          .filter((row) => row.source_type != null && row.source_system != null && row.source_id != null)
          .map((row) => ({
            recordId: row.observation_id,
            sourceType: row.source_type!,
            sourceSystem: row.source_system!,
            sourceId: row.source_id!,
            importRunId: context.importRunId ?? null,
          })),
      );
    }

    return ids;
  }

  /** Re-read written rows through the repository, so `embedding` stays out of the result. */
  private async hydrate(context: ServiceContext, ids: string[]): Promise<ObjectObservation[]> {
    if (ids.length === 0) {
      return [];
    }

    const chunkSize = computeChunkSize(1);
    const found: ObjectObservationEntity[] = [];

    for (let offset = 0; offset < ids.length; offset += chunkSize) {
      found.push(
        ...(await this.observationRepository.find({
          where: {
            id: In(ids.slice(offset, offset + chunkSize)),
            ...(context.userId !== SYSTEM_USER && { userId: context.userId }),
          },
        })),
      );
    }

    return found;
  }
}
