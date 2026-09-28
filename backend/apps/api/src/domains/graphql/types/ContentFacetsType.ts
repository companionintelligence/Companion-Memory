import { Field, ObjectType } from '@nestjs/graphql';

/**
 * What the content library's filter pickers can offer, each list built from
 * the distinct values the user's rows actually carry (see
 * ContentService.getFacets) — the same construction as the explorer's How
 * list, so every option matches something.
 */
@ObjectType('ContentFacets')
export class ContentFacetsType {
  @Field(() => [String], {
    description:
      'Content type options: raw `type` values (post, note, like, …) plus, for `media` rows, the kind their mimetype says — image, video, audio, or `media` for watch/listen records and documents.',
  })
  types!: string[];

  @Field(() => [String], { description: 'Distinct `mimetype` values.' })
  mimetypes!: string[];

  @Field(() => [String], {
    description:
      "Distinct delivering platforms — the How filter, over content alone. The ledger platform (`google_photos`, `whatsapp`) where one was recorded, else the row's `source_system`.",
  })
  sourceSystems!: string[];
}
