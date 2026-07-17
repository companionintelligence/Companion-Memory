import { defineEvent } from '@ci/domains/events';

/**
 * Spatial-memory CV ingestion events.
 *
 * A capture source (ci-time-machine cv-client backed by cv-server —
 * Grounding DINO / SAM 2 / Florence-2 — or a device pipeline such as OMI /
 * MaixCAM) produces computer-vision detections over an uploaded image/scan.
 * Those detections must become first-class memory entities (Person / Thing /
 * Concept) linked to the source {@link FileEntity}, so the spatial-memory chain
 * (capture → memory → visualization) is no longer broken at the "detections
 * never become entities" joint (spatial-memory plan §3 gap 3).
 *
 * Device outputs differ (OMI `{faces, objects}`, MaixCAM `{objects, people,
 * places}`); callers MUST normalize into the canonical detection shape below —
 * a subset of the ci-time-machine `Pin` schema (`packages/pins/src/schema.ts`)
 * — before emitting, so no per-device JSON leaks into CI-Server (plan §3 gap 6).
 */
export const CvDetectionsCapturedEvent = 'cv.detections.captured';

/**
 * Which memory entity a detection maps to.
 * - `Person` — a detected face / person.
 * - `Thing` — a detected object.
 * - `Concept` — a detected scene / activity / place classification.
 */
export type CvDetectionKind = 'Person' | 'Thing' | 'Concept';

/**
 * Normalized bounding box in [0, 1], mirroring ci-time-machine `BBoxNorm`.
 */
export interface CvBBoxNormalized {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One normalized CV detection. A projection of the ci-time-machine `Pin` type
 * carrying only the fields CI-Server needs to materialize an entity; capture
 * sources retain the full `Pin`/`Scan` for the 3-D scene.
 */
export interface CvDetection {
  /**
   * Stable id of the detection within its source frame/scan (e.g. a track id or
   * a cv-server pin id). Combined with the file id it forms the idempotency key
   * so re-syncing the same detection does not duplicate the entity.
   */
  detectionId: string;
  /** Which entity type this detection becomes. */
  kind: CvDetectionKind;
  /** Human-readable label, e.g. "person", "coffee mug", "kitchen". */
  label: string;
  /** Optional finer-grained semantic label from the model. */
  semanticLabel?: string;
  /** Model confidence in [0, 1]. */
  score?: number;
  /** 2-D detection box, normalized to the source image. */
  bboxNormalized?: CvBBoxNormalized;
  /** Originating pipeline, e.g. "cv-server", "omi", "maixcam". */
  source?: string;
}

/**
 * Payload of {@link CvDetectionsCapturedEvent}.
 */
export type CvDetectionsCapturedPayload = {
  /** Owner the detections (and resulting entities) belong to. */
  userId: string;
  /** The {@link FileEntity} the detections were produced from (photo/scan). */
  fileId: string;
  /** Normalized detections; may be empty (nothing recognized in the frame). */
  detections: CvDetection[];
};

defineEvent<CvDetectionsCapturedPayload>(CvDetectionsCapturedEvent);

declare module '@ci/domains/events/registry' {
  interface EventRegistry {
    [CvDetectionsCapturedEvent]: CvDetectionsCapturedPayload;
  }
}
