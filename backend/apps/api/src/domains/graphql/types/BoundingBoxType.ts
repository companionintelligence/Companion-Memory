import { Field, Float, ObjectType } from '@nestjs/graphql';

import type { ObservationBoundingBox } from '@ci/domains/memory';

/**
 * Where in the frame something was seen — normalized to 0..1 of the source
 * image, origin top-left.
 *
 * Normalized rather than in pixels so a crop stays correct after the image is
 * resized, which every thumbnail pipeline does.
 */
@ObjectType()
export class BoundingBoxType {
  @Field(() => Float)
  x!: number;

  @Field(() => Float)
  y!: number;

  @Field(() => Float)
  w!: number;

  @Field(() => Float)
  h!: number;

  static toType(bbox: ObservationBoundingBox): BoundingBoxType {
    return { x: bbox.x, y: bbox.y, w: bbox.w, h: bbox.h };
  }
}
