import { Injectable } from '@nestjs/common';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';
import { FileService } from '@ci/domains/files';
import { PersonService } from '@ci/domains/memory';

import { CvDetectionsCapturedEvent, type CvDetection, type CvDetectionsCapturedPayload } from '../events';

/**
 * Table name recorded on entities materialized from a CV detection. Mirrors the
 * `linkedTable` convention other capture sources use, and doubles as the first
 * component of the idempotency key (see {@link PersonService.create}).
 */
export const CV_DETECTION_LINKED_TABLE = 'files';

/**
 * Materializes computer-vision detections into memory entities linked to their
 * source {@link FileEntity}, closing the "CV detections never become entities"
 * gap in the spatial-memory chain (plan §3 gap 3).
 *
 * Mirrors the {@link InventoryListener} pattern: subscribe to an ingestion
 * event carrying an image reference, then upsert entities via the memory
 * services. Where InventoryListener runs its own Ollama vision pass, this
 * listener trusts detections already normalized by the capture source (the
 * ci-time-machine cv-client, or a device pipeline) into the canonical
 * {@link CvDetection} shape.
 *
 * This slice implements Person CRUD end-to-end (detected face → PersonEntity,
 * idempotently linked to the file). Thing and Concept materialization is logged
 * and deferred — see the follow-ups in the PR body.
 */
@Injectable()
export class CvDetectionsListener {
  constructor(
    private readonly fileService: FileService,
    private readonly personService: PersonService,
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

    let personCount = 0;
    let deferredCount = 0;

    for (const detection of detections) {
      switch (detection.kind) {
        case 'Person': {
          await this.materializePerson(serviceContext, fileId, detection);
          personCount += 1;
          break;
        }

        // Thing ('Object' rows, currently written only via
        // GraphUtilityService.createOrUpdateNode) and Concept → ConceptEntity
        // follow the same resolve-or-create shape; deferred to a follow-up PR to
        // keep this slice focused and reviewable (see PR body).
        case 'Thing':
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

    this.logger.log('CV detections processing completed', {
      fileId,
      peopleCreated: personCount,
      deferred: deferredCount,
    });
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
