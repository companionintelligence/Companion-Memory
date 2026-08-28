import { Field, Float, ID, ObjectType, registerEnumType } from '@nestjs/graphql';
import GraphQLJSONObject from 'graphql-type-json';

import type {
  ObjectObservation,
  ObservationLabelSource,
  ObservationResolutionMethod,
  ObservationSourceKind,
} from '@ci/domains/memory';

import { BoundingBoxType } from './BoundingBoxType';
import { GlobalUID } from './GlobalUID';
import { Node } from './Node';

export const ObservationSourceKindEnum = {
  PHOTO: 'photo',
  VIDEO_FRAME: 'video_frame',
  LIVE_CAMERA: 'live_camera',
  SCREENSHOT: 'screenshot',
  MANUAL: 'manual',
} as const satisfies Record<Uppercase<ObservationSourceKind>, ObservationSourceKind>;

export type ObservationSourceKindEnum =
  (typeof ObservationSourceKindEnum)[keyof typeof ObservationSourceKindEnum];

registerEnumType(ObservationSourceKindEnum, {
  name: 'ObservationSourceKind',
  description: 'What kind of frame the sighting came from.',
});

export const ObservationLabelSourceEnum = {
  YOLO: 'yolo',
  OLLAMA_VISION: 'ollama_vision',
  CLIP: 'clip',
  USER: 'user',
  IMPORT: 'import',
} as const satisfies Record<Uppercase<ObservationLabelSource>, ObservationLabelSource>;

export type ObservationLabelSourceEnum =
  (typeof ObservationLabelSourceEnum)[keyof typeof ObservationLabelSourceEnum];

registerEnumType(ObservationLabelSourceEnum, {
  name: 'ObservationLabelSource',
  description: 'What produced the label.',
});

/**
 * Which rung of the resolution ladder linked this sighting to an owned unit.
 *
 * Ordered by kind of evidence, strongest first: a barcode IDENTIFIES, an
 * embedding says two images look alike, a place says the thing is where the
 * thing usually is, a label says the words match. `user` outranks all of them
 * and is written only by `confirmObservation`.
 */
export const ObservationResolutionMethodEnum = {
  IDENTIFIER: 'identifier',
  EMBEDDING: 'embedding',
  PLACE_PRIOR: 'place_prior',
  LABEL: 'label',
  USER: 'user',
  NONE: 'none',
} as const satisfies Record<Uppercase<ObservationResolutionMethod>, ObservationResolutionMethod>;

export type ObservationResolutionMethodEnum =
  (typeof ObservationResolutionMethodEnum)[keyof typeof ObservationResolutionMethodEnum];

registerEnumType(ObservationResolutionMethodEnum, {
  name: 'ObservationResolutionMethod',
  description: 'Which rung of the resolution ladder linked the sighting to an owned unit.',
});

/**
 * A SIGHTING of a physical thing in an image.
 *
 * This is the weak claim — "a coffee mug is visible in this photo" — and it is
 * deliberately NOT the same statement as "I own this coffee mug". Nothing here
 * creates an owned unit; resolution to one (`resolvedObjectId`) is a separate,
 * revisable decision carrying its own method and confidence, and minting has
 * exactly one legitimate trigger, which is a purchase.
 *
 * `confirmedByUser` means a human said so and has exactly one writer
 * (`confirmObservation`). Downstream consumers are entitled to read it as
 * ground truth rather than "something was fairly sure".
 */
@ObjectType({ implements: () => [Node] })
export class ObjectObservationType implements Node {
  __typename = ObjectObservationType.name;

  __source!: ObjectObservation;

  @Field(() => ID)
  id!: string;

  @Field(() => Date)
  observedAt!: Date;

  @Field(() => ObservationSourceKindEnum)
  sourceKind!: ObservationSourceKind;

  /** The ci.content row the sighting was made in, as a global id. */
  @Field(() => ID, { nullable: true })
  contentId!: string | null;

  @Field(() => ID, { nullable: true })
  fileId!: string | null;

  @Field(() => ID, { nullable: true })
  eventId!: string | null;

  /** Where the sighting happened, as a global place id. A resolution prior. */
  @Field(() => ID, { nullable: true })
  placeEntityId!: string | null;

  @Field(() => String)
  label!: string;

  @Field(() => ObservationLabelSourceEnum, { nullable: true })
  labelSource!: ObservationLabelSource | null;

  @Field(() => String, { nullable: true })
  detector!: string | null;

  @Field(() => String, { nullable: true })
  detectorVersion!: string | null;

  @Field(() => Float, { nullable: true, description: 'How sure the detector was it saw something.' })
  detectionConfidence!: number | null;

  @Field(() => BoundingBoxType, { nullable: true })
  bbox!: BoundingBoxType | null;

  /** ci.content row holding the cropped thumbnail of the sighting. */
  @Field(() => ID, { nullable: true })
  cropContentId!: string | null;

  /** The owned unit this sighting was linked to, as a global item id. */
  @Field(() => ID, { nullable: true })
  resolvedObjectId!: string | null;

  /** The catalog model this sighting was linked to, as a global product id. */
  @Field(() => ID, { nullable: true })
  resolvedProductId!: string | null;

  @Field(() => ObservationResolutionMethodEnum)
  resolutionMethod!: ObservationResolutionMethod;

  @Field(() => Float, { nullable: true, description: 'How sure the ladder was about the link.' })
  resolutionConfidence!: number | null;

  @Field(() => Boolean, { description: 'A human confirmed this link. Written only by confirmObservation.' })
  confirmedByUser!: boolean;

  @Field(() => GraphQLJSONObject)
  attributes!: Record<string, unknown>;

  @Field(() => GraphQLJSONObject)
  metadata!: Record<string, unknown>;

  @Field(() => Date)
  createdAt!: Date;

  @Field(() => Date)
  updatedAt!: Date;

  static toType(observation: ObjectObservation): ObjectObservationType {
    return {
      __typename: ObjectObservationType.name,
      __source: observation,
      id: GlobalUID.encode('observation', observation.id),
      observedAt: observation.observedAt,
      sourceKind: observation.sourceKind,
      contentId: observation.contentId == null ? null : GlobalUID.encode('content', observation.contentId),
      fileId: observation.fileId == null ? null : GlobalUID.encode('file', observation.fileId),
      eventId: observation.eventId == null ? null : GlobalUID.encode('event', observation.eventId),
      placeEntityId:
        observation.placeEntityId == null ? null : GlobalUID.encode('place', observation.placeEntityId),
      label: observation.label,
      labelSource: observation.labelSource,
      detector: observation.detector,
      detectorVersion: observation.detectorVersion,
      detectionConfidence: observation.detectionConfidence,
      bbox: observation.bbox == null ? null : BoundingBoxType.toType(observation.bbox),
      cropContentId:
        observation.cropContentId == null ? null : GlobalUID.encode('content', observation.cropContentId),
      resolvedObjectId:
        observation.resolvedObjectId == null ? null : GlobalUID.encode('item', observation.resolvedObjectId),
      resolvedProductId:
        observation.resolvedProductId == null
          ? null
          : GlobalUID.encode('product', observation.resolvedProductId),
      resolutionMethod: observation.resolutionMethod,
      resolutionConfidence: observation.resolutionConfidence,
      confirmedByUser: observation.confirmedByUser,
      attributes: observation.attributes ?? {},
      metadata: observation.metadata ?? {},
      createdAt: observation.createdAt,
      updatedAt: observation.updatedAt,
    };
  }
}
