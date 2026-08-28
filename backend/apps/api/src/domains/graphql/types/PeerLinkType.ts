import { Field, GraphQLISODateTime, ID, InputType, ObjectType, registerEnumType } from '@nestjs/graphql';

import { PEER_TRUST_TIERS, type PeerLink, type PeerLinkStatus } from '@ci/domains/peers';

import { GlobalUID } from './GlobalUID';

/**
 * The trust tier of a peer link.
 *
 * This is not a label — it is the CEILING on everything that peer can ever be
 * told. `policy.ts` maps each tier to a maximum disclosure rung, so lowering a
 * peer from `trusted` to `stranger` narrows every future answer to them without
 * touching a single grant.
 *
 * `household` is deliberately ABSENT, and the omission is load-bearing rather
 * than an oversight. It is the most permissive tier, it is the one exempt from
 * the sensitive-class floor, and it means "shares this appliance" — which cannot
 * be true of somebody on the other side of a box boundary. The DB CHECK on
 * `ci.peer_links.trust_tier` allows exactly these four, so admitting a fifth
 * here would turn a validation error into a `23514` the driver raises after the
 * statement — surfaced to the caller as a bare 500.
 */
export enum PeerTrustTierEnum {
  family = 'family',
  trusted = 'trusted',
  peer = 'peer',
  stranger = 'stranger',
}

registerEnumType(PeerTrustTierEnum, { name: 'PeerTrustTier' });

export enum PeerLinkStatusEnum {
  pending = 'pending',
  active = 'active',
  revoked = 'revoked',
}

registerEnumType(PeerLinkStatusEnum, { name: 'PeerLinkStatus' });

/**
 * Compile-time proof that the GraphQL enum and the domain vocabulary agree.
 *
 * The entity already carries the same check against `TrustTier`; this is the
 * third side of the triangle, so a tier added to one list and not the others
 * fails the build rather than a runtime CHECK constraint.
 */
const _tiersAgree: { [K in (typeof PEER_TRUST_TIERS)[number]]: PeerTrustTierEnum } = {
  family: PeerTrustTierEnum.family,
  trusted: PeerTrustTierEnum.trusted,
  peer: PeerTrustTierEnum.peer,
  stranger: PeerTrustTierEnum.stranger,
};
void _tiersAgree;

@ObjectType()
export class PeerLinkType {
  @Field(() => ID)
  id!: string;

  /** The peer's handle in the Portal directory, e.g. `ada`. */
  @Field(() => String)
  peerHandle!: string;

  /** What the owner chose to call them. Never invented from the handle. */
  @Field(() => String, { nullable: true })
  displayName!: string | null;

  @Field(() => String)
  memoryEndpoint!: string;

  /**
   * The person in the owner's own memory this peer is, when they have said so.
   *
   * Nullable on purpose: the link is usable without it, and guessing would
   * attach a stranger's asks to a real person's record.
   */
  @Field(() => ID, { nullable: true })
  personEntityId!: string | null;

  @Field(() => PeerTrustTierEnum)
  trustTier!: PeerTrustTierEnum;

  @Field(() => PeerLinkStatusEnum)
  status!: PeerLinkStatus;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;

  @Field(() => GraphQLISODateTime, { nullable: true })
  revokedAt!: Date | null;

  /**
   * The avatar of the Person in the OWNER's own memory this peer is linked
   * to — not anything the peer supplies about themselves. Resolved by
   * `PeerLinkResolver.avatarUrl` from the (already-on-the-wire) `personEntityId`
   * above; null when that is unset (most links today) or the linked Person has
   * no avatar. Only the avatar crosses — the rest of the linked Person's
   * `properties` jsonb does not.
   */
  @Field(() => String, { nullable: true })
  avatarUrl?: string | null;

  /**
   * `peerIssuer` and `peerSubject` are NOT exposed.
   *
   * They are the `(iss, sub)` pair an inbound token is matched against — the
   * binding that stops one box impersonating another. They are infrastructure,
   * not something the owner acts on, and putting them on the wire only widens
   * what a compromised client can read back.
   */
  static toType(link: PeerLink): PeerLinkType {
    return {
      id: GlobalUID.encode('peer-link', link.id),
      peerHandle: link.peerHandle,
      displayName: link.displayName,
      memoryEndpoint: link.memoryEndpoint,
      personEntityId: link.personEntityId ? GlobalUID.encode('person', link.personEntityId) : null,
      trustTier: link.trustTier as PeerTrustTierEnum,
      status: link.status,
      createdAt: link.createdAt,
      updatedAt: link.updatedAt,
      revokedAt: link.revokedAt,
    };
  }
}

@InputType()
export class CreatePeerLinkInput {
  @Field(() => String)
  peerHandle!: string;

  @Field(() => String)
  memoryEndpoint!: string;

  @Field(() => String, { nullable: true })
  displayName?: string | null;

  @Field(() => ID, { nullable: true })
  personEntityId?: string | null;

  /**
   * Omitted means `stranger` — the NARROWEST tier, not the friendliest.
   *
   * Adding someone is not the same as trusting them, and a default that silently
   * granted more than the owner chose would be a disclosure bug wearing a
   * convenience costume. Raising the tier is a deliberate second gesture.
   */
  @Field(() => PeerTrustTierEnum, { nullable: true })
  trustTier?: PeerTrustTierEnum;
}

@InputType()
export class UpdatePeerLinkInput {
  @Field(() => ID)
  id!: string;

  @Field(() => String, { nullable: true })
  displayName?: string | null;

  @Field(() => ID, { nullable: true })
  personEntityId?: string | null;

  @Field(() => PeerTrustTierEnum, { nullable: true })
  trustTier?: PeerTrustTierEnum;
}

@ObjectType()
export class PeerLinkPayload {
  @Field(() => Boolean)
  success!: boolean;

  @Field(() => PeerLinkType, { nullable: true })
  peerLink?: PeerLinkType | null;
}

/**
 * A peer as the Portal directory describes them, BEFORE any link exists.
 *
 * Deliberately thin. This is a phone book: it answers "does this handle resolve,
 * and where does that box live", and nothing about what they hold. A richer
 * directory result would make handle lookup an enumeration oracle over everyone
 * on the Portal.
 */
@ObjectType()
export class PeerDirectoryEntryType {
  @Field(() => String)
  handle!: string;

  @Field(() => String, { nullable: true })
  displayName!: string | null;

  @Field(() => String)
  memoryEndpoint!: string;

  /** Whether this box already has a link to them, so the UI can say so. */
  @Field(() => Boolean)
  alreadyLinked!: boolean;
}
