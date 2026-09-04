import { Field, ObjectType } from '@nestjs/graphql';

/**
 * What the content library's filter pickers can offer, each list built from
 * the distinct values the user's rows actually carry (see
 * ContentService.getFacets) — the same construction as the explorer's How
 * list, so every option matches something.
 */
@ObjectType('ContentFacets')
export class ContentFacetsType {
  @Field(() => [String], { description: 'Distinct `type` values (image, post, note, …).' })
  types!: string[];

  @Field(() => [String], { description: 'Distinct `mimetype` values.' })
  mimetypes!: string[];

  @Field(() => [String], { description: 'Distinct `source_system` values — the How filter, over content alone.' })
  sourceSystems!: string[];
}
