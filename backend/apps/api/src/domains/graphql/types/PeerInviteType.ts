import { Field, GraphQLISODateTime, ID, InputType, ObjectType, registerEnumType } from '@nestjs/graphql';

import type { PeerInviteView } from '@ci/domains/peers';

import { GlobalUID } from './GlobalUID';
import { PeerLinkType } from './PeerLinkType';

export enum PeerInviteStatusEnum {
  pending = 'pending',
  used = 'used',
  expired = 'expired',
  revoked = 'revoked',
}

registerEnumType(PeerInviteStatusEnum, { name: 'PeerInviteStatus' });

/**
 * An invite the owner made. The code is NOT here: it is handed out once, by
 * `createPeerInvite`, and this box keeps only a hash of its secret.
 */
@ObjectType('PeerInvite')
export class PeerInviteType {
  @Field(() => ID)
  id!: string;

  /** The owner's own note on who it is for. Never shown to anyone else. */
  @Field(() => String, { nullable: true })
  label!: string | null;

  /** The name the other person sees for the owner. */
  @Field(() => String)
  inviterName!: string;

  @Field(() => PeerInviteStatusEnum)
  status!: PeerInviteStatusEnum;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  expiresAt!: Date;

  @Field(() => GraphQLISODateTime, { nullable: true })
  usedAt!: Date | null;

  static toType(invite: PeerInviteView): PeerInviteType {
    return {
      id: GlobalUID.encode('peer-invite', invite.id),
      label: invite.label,
      inviterName: invite.inviterName,
      status: invite.status as PeerInviteStatusEnum,
      createdAt: invite.createdAt,
      expiresAt: invite.expiresAt,
      usedAt: invite.usedAt,
    };
  }
}

@InputType()
export class CreatePeerInviteInput {
  /** The name to be shown to the other person. Defaults to the owner's own name. */
  @Field(() => String, { nullable: true })
  name?: string | null;

  /** A note for the owner on who it is for. */
  @Field(() => String, { nullable: true })
  label?: string | null;
}

@ObjectType()
export class CreatePeerInvitePayload {
  @Field(() => Boolean)
  success!: boolean;

  /**
   * The code to hand to the other person. Shown once: it is not stored, and
   * cannot be read back. Anyone holding it can link to the owner once, at the
   * narrowest trust tier, until it expires.
   */
  @Field(() => String, { nullable: true })
  code?: string | null;

  @Field(() => PeerInviteType, { nullable: true })
  invite?: PeerInviteType | null;
}

@InputType()
export class AcceptPeerInviteInput {
  @Field(() => String)
  code!: string;

  /** What to call them here. Defaults to the name their Companion gives. */
  @Field(() => String, { nullable: true })
  displayName?: string | null;

  /** The name to be shown to them. Defaults to the owner's own name. */
  @Field(() => String, { nullable: true })
  myName?: string | null;
}

@ObjectType()
export class PeerInvitePayload {
  @Field(() => Boolean)
  success!: boolean;

  @Field(() => PeerInviteType, { nullable: true })
  invite?: PeerInviteType | null;
}

@ObjectType()
export class AcceptPeerInvitePayload {
  @Field(() => Boolean)
  success!: boolean;

  @Field(() => PeerLinkType, { nullable: true })
  peerLink?: PeerLinkType | null;
}

/** What a key rotation reached: the owner's names for the people told, and for those not reachable. */
@ObjectType()
export class PeerKeyRotationPayload {
  @Field(() => Boolean)
  success!: boolean;

  @Field(() => [String])
  notified!: string[];

  @Field(() => [String])
  unreachable!: string[];
}
