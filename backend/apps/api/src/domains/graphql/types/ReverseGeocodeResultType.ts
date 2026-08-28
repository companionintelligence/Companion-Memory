import { Field, ObjectType } from '@nestjs/graphql';

/** Coords → readable place name, for the add-place “use my location” path. */
@ObjectType()
export class ReverseGeocodeResultType {
  @Field(() => String)
  status!: string;

  @Field(() => String, { nullable: true })
  placeName!: string | null;
}
