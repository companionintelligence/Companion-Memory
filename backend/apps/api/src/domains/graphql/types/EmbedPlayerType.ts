import { Field, Float, ObjectType } from '@nestjs/graphql';

import type { StructuralPlayer } from '@ci/domains/embed';

/**
 * A provider-hosted player derived purely from a content row's URL — no
 * network, no storage (tier 0 of the embeds design). The client reserves the
 * aspect box, shows the poster (if any) or a provider badge, and mounts the
 * player iframe only on an explicit click.
 */
@ObjectType()
export class EmbedPlayerType {
  /** Extractor name, e.g. `youtube`, `spotify`. */
  @Field(() => String)
  provider!: string;

  /** Stable provider handle, e.g. `youtube:video:dQw4w9WgXcQ`. */
  @Field(() => String)
  providerRef!: string;

  /** Iframe `src` of the provider's own player. */
  @Field(() => String)
  playerUrl!: string;

  /** Remote poster image at a predictable provider address, when one exists. */
  @Field(() => String, { nullable: true })
  posterUrl?: string | null;

  /** width / height the player expects. */
  @Field(() => Float)
  aspectRatio!: number;

  /** `video` | `audio` | `playlist`. */
  @Field(() => String)
  mediaKind!: string;

  static toType(player: StructuralPlayer): EmbedPlayerType {
    return {
      provider: player.provider,
      providerRef: player.providerRef,
      playerUrl: player.playerUrl,
      posterUrl: player.posterUrl ?? null,
      aspectRatio: player.aspectRatio,
      mediaKind: player.mediaKind,
    };
  }
}
