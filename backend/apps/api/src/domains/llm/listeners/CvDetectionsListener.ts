import { Injectable } from '@nestjs/common';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';
import { FileService } from '@ci/domains/files';
import {
  type CreateObjectObservationDto,
  type ObjectObservationWriteResult,
  ObjectObservationService,
  PersonService,
} from '@ci/domains/memory';

import { CvDetectionsCapturedEvent, type CvDetection, type CvDetectionsCapturedPayload } from '../events';

/**
 * Table name recorded on entities materialized from a CV detection. Mirrors the
 * `linkedTable` convention other capture sources use, and doubles as the first
 * component of the idempotency key (see {@link PersonService.create}).
 */
export const CV_DETECTION_LINKED_TABLE = 'files';

/**
 * `source_type` on every `ci.object_observations` row this listener writes.
 *
 * Together with the detection's originating pipeline and `<fileId>:<detectionId>`
 * it forms the provenance triple `object_observations_source_triple_uniq` is
 * keyed on, so a re-run of the same CV pass updates its sightings in place. It
 * is the SAME identity `materializePerson` uses for its `linkedId`, which is
 * what keeps a detection's person and its sighting talking about one detection.
 */
export const CV_OBSERVATION_SOURCE_TYPE = 'cv_detection';

/** Fallback pipeline name when a detection does not say where it came from. */
const CV_DEFAULT_DETECTOR = 'cv';

/**
 * Materializes computer-vision detections into memory entities linked to their
 * source {@link FileEntity}, closing the "CV detections never become entities"
 * gap in the spatial-memory chain (plan §3 gap 3).
 *
 * Mirrors the {@link ThingVisionListener} pattern: subscribe to an ingestion
 * event carrying an image reference, then upsert entities via the memory
 * services. Where ThingVisionListener runs its own Ollama vision pass, this
 * listener trusts detections already normalized by the capture source (the
 * ci-time-machine cv-client, or a device pipeline) into the canonical
 * {@link CvDetection} shape.
 *
 * Person detections become `PersonEntity` rows. Thing detections become
 * SIGHTINGS — `ci.object_observations` rows written through
 * {@link ObjectObservationService} — and deliberately NOT `ci.objects` rows:
 * "a coffee mug is visible in this photo" is not "I own this specific coffee
 * mug", and the observation table exists to keep those two claims apart.
 * Promoting a sighting to an owned unit is a later, revisable decision made
 * against the resolution columns, never here.
 *
 * Concept materialization (→ ConceptEntity) is still deferred.
 */
/**
 * `ci.files.external_created_at` is TEXT, not a timestamp — importers write
 * whatever the source said. Parse defensively; an unparseable string is not a
 * date and pretending otherwise puts `Invalid Date` in a NOT NULL column.
 */
function parseExternalDate(value: Date | string | null | undefined): Date | null {
  if (value == null) {
    return null;
  }

  // Typed `Date | null` on FileEntity and genuinely a Date at runtime — the
  // column is `timestamptz` (`20260212130000_rebuild_files_table`) and the pg
  // driver parses it off the wire OID, whatever the entity's stale
  // `type: 'text'` decorator says. The string branch is kept because that
  // decorator means a raw query or a future writer could hand back text, and
  // the failure mode is `Invalid Date` in a NOT NULL column.
  const parsed = value instanceof Date ? value : new Date(value);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

@Injectable()
export class CvDetectionsListener {
  constructor(
    private readonly fileService: FileService,
    private readonly personService: PersonService,
    private readonly observationService: ObjectObservationService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(CvDetectionsListener.name);
  }

  @OnEvent(CvDetectionsCapturedEvent, { queue: 'cv-detections' })
  async handleDetections(payload: CvDetectionsCapturedPayload): Promise<void> {
    const { userId, fileId, detections } = payload;

    if (detections.length === 0) {
      this.logger.log('CV detections event with no detections, nothing to materialize', {
        fileId,
      });

      return;
    }

    const serviceContext = toServiceContext({ userId });

    // Confirm the source file exists and belongs to the user before linking
    // entities to it — otherwise we'd create dangling references.
    const file = await this.fileService.findById(serviceContext, fileId);

    if (file == null) {
      this.logger.warn('Source file not found for CV detections, skipping', {
        fileId,
      });

      return;
    }

    this.logger.log('Materializing CV detections', {
      fileId,
      count: detections.length,
    });

    // The capture time of the PIXELS, not of this job. `externalCreatedAt`
    // carries the original timestamp for an imported photo; `createdAt` is when
    // the upload landed, which for a live capture is the same thing and for an
    // import is years late. An observation timeline built on job time would be
    // a timeline of when the CV pass ran.
    const observedAt = parseExternalDate(file.externalCreatedAt) ?? file.createdAt;

    let personCount = 0;
    let deferredCount = 0;
    const things: CvDetection[] = [];

    for (const detection of detections) {
      switch (detection.kind) {
        case 'Person': {
          await this.materializePerson(serviceContext, fileId, detection);
          personCount += 1;
          break;
        }

        // Collected rather than written one at a time: `createMany` folds
        // within-batch repeats and issues one statement, and a frame with forty
        // boxes is the normal case, not the exceptional one.
        case 'Thing': {
          things.push(detection);
          break;
        }

        // Concept → ConceptEntity follows the same resolve-or-create shape as
        // Person; still deferred.
        case 'Concept': {
          this.logger.log('CV detection kind not yet materialized, deferring', {
            fileId,
            kind: detection.kind,
            label: detection.label,
            detectionId: detection.detectionId,
          });
          deferredCount += 1;
          break;
        }

        default: {
          this.logger.warn('Unknown CV detection kind, skipping', {
            fileId,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            kind: (detection as any).kind,
          });
          break;
        }
      }
    }

    const observations = await this.materializeThings(serviceContext, fileId, observedAt, things);

    this.logger.log('CV detections processing completed', {
      fileId,
      peopleCreated: personCount,
      observationsRecorded: observations.written.length,
      observationsProtected: observations.protectedByConfirmation,
      observationsRejected: observations.rejectedUnarbitered,
      deferred: deferredCount,
    });
  }

  /**
   * Record detected objects as SIGHTINGS.
   *
   * Every row is keyed on the provenance triple
   * `('cv_detection', <pipeline>, '<fileId>:<detectionId>')` rather than on a
   * derived detection key. That is the arbiter the migration reserves for
   * sources that carry their own stable id, and a CV detection does: the
   * `detectionId` is a track/pin id stable within its frame, which is the same
   * identity `materializePerson` builds its `linkedId` from. Deriving a key
   * from the bbox instead would fork the row the moment a re-run nudged the box
   * by a pixel.
   *
   * `labelSource` stays NULL on purpose. The column's CHECK constraint admits
   * `yolo | ollama_vision | clip | user | import`, and cv-server runs none of
   * those (Grounding DINO / SAM 2 / Florence-2), so the honest record of which
   * model spoke is `detector`. Picking the nearest-looking enum value would put
   * a wrong fact in a constrained column to avoid a NULL in a nullable one.
   */
  private async materializeThings(
    serviceContext: ReturnType<typeof toServiceContext>,
    fileId: string,
    observedAt: Date,
    detections: CvDetection[],
  ): Promise<ObjectObservationWriteResult> {
    if (detections.length === 0) {
      return { written: [], protectedByConfirmation: 0, duplicatesInBatch: 0, rejectedUnarbitered: 0 };
    }

    const dtos: CreateObjectObservationDto[] = detections.map((detection) => {
      const detector = detection.source?.trim() || CV_DEFAULT_DETECTOR;

      return {
        observedAt,
        sourceKind: 'photo',
        fileId,
        // The detector's own word for it, preferring the finer-grained one.
        label: detection.semanticLabel?.trim() || detection.label?.trim() || '',
        labelSource: null,
        detector,
        detectionConfidence: detection.score ?? null,
        // `CvBBoxNormalized` says {width, height}; the observation column says
        // {w, h}. Both are normalized 0..1 top-left, so this is a rename and
        // nothing else — but it is the kind of rename that silently writes
        // undefined if it is done by spreading.
        bbox:
          detection.bboxNormalized != null
            ? {
                x: detection.bboxNormalized.x,
                y: detection.bboxNormalized.y,
                w: detection.bboxNormalized.width,
                h: detection.bboxNormalized.height,
              }
            : null,
        sourceType: CV_OBSERVATION_SOURCE_TYPE,
        sourceSystem: detector,
        sourceId: `${fileId}:${detection.detectionId}`,
        metadata: {
          detection_id: detection.detectionId,
          detection_label: detection.label,
          ...(detection.semanticLabel != null && { detection_semantic_label: detection.semanticLabel }),
        },
      };
    });

    const result = await this.observationService.createMany(serviceContext, dtos);

    if (result.rejectedUnarbitered > 0) {
      // Reached only by a label-less detection: the triple is always present
      // here, so nothing else can refuse a row.
      this.logger.warn('CV detections refused as observations, no usable label', {
        fileId,
        count: result.rejectedUnarbitered,
      });
    }

    return result;
  }

  /**
   * Upsert a PersonEntity for a detected face and link it to the source file.
   *
   * The link/idempotency key is `(linkedTable='files', linkedId='<fileId>:<detectionId>')`,
   * so re-syncing the same detection (a retry, a re-run of the CV pass) resolves
   * the existing person rather than duplicating it, while two distinct faces in
   * the same photo still get distinct entities.
   */
  private async materializePerson(
    serviceContext: ReturnType<typeof toServiceContext>,
    fileId: string,
    detection: CvDetection,
  ): Promise<void> {
    const name = detection.semanticLabel?.trim() || detection.label?.trim() || 'Unknown Person';

    const person = await this.personService.create(serviceContext, {
      name,
      searchContent: name,
      linkedTable: CV_DETECTION_LINKED_TABLE,
      linkedId: `${fileId}:${detection.detectionId}`,
      properties: {
        source: detection.source ?? 'cv',
        source_file_id: fileId,
        detection_id: detection.detectionId,
        detection_label: detection.label,
        detection_score: detection.score ?? null,
        detection_bbox: detection.bboxNormalized ?? null,
      },
    });

    this.logger.log('Person entity materialized from CV detection', {
      personId: person.id,
      fileId,
      detectionId: detection.detectionId,
    });
  }
}
