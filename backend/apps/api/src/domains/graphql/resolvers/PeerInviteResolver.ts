import { Optional, UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { FeatureService } from '@ci/common/feature';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { PeerInviteService } from '@ci/domains/peers';

import { GraphqlPrivacy } from '../decorators/GraphqlPrivacy';
import { GlobalUID } from '../types/GlobalUID';
import {
  AcceptPeerInviteInput,
  AcceptPeerInvitePayload,
  CreatePeerInviteInput,
  CreatePeerInvitePayload,
  PeerInvitePayload,
  PeerInviteType,
} from '../types/PeerInviteType';
import { PeerLinkType } from '../types/PeerLinkType';

/**
 * Invites: how an owner links their Companion with someone else's, with one
 * shared code. See `PeerInviteService` for the exchange itself. Gated on the
 * `ask` feature like every other peer surface.
 */
@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => PeerInviteType)
export class PeerInviteResolver {
  constructor(
    private readonly inviteService: PeerInviteService,
    @Optional() private readonly featureService?: FeatureService,
  ) {}

  private async enabled(): Promise<boolean> {
    return this.featureService ? this.featureService.isFeatureEnabled('ask') : true;
  }

  @Query(() => [PeerInviteType])
  async myPeerInvites(@Context() context: RequestContext): Promise<PeerInviteType[]> {
    if (!(await this.enabled())) {
      return [];
    }

    return (await this.inviteService.list(toServiceContext(context))).map(PeerInviteType.toType);
  }

  @Mutation(() => CreatePeerInvitePayload)
  // Mints a capability another person can use to link to the owner.
  @GraphqlPrivacy({ destructive: false })
  async createPeerInvite(
    @Context() context: RequestContext,
    @Args('input', { nullable: true }) input?: CreatePeerInviteInput,
  ): Promise<CreatePeerInvitePayload> {
    if (!(await this.enabled())) {
      return { success: false };
    }

    const { invite, code } = await this.inviteService.create(toServiceContext(context), {
      name: input?.name,
      label: input?.label,
    });

    return { success: true, code, invite: PeerInviteType.toType(invite) };
  }

  @Mutation(() => PeerInvitePayload)
  @GraphqlPrivacy({ destructive: false })
  async revokePeerInvite(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<PeerInvitePayload> {
    if (!(await this.enabled())) {
      return { success: false };
    }

    const invite = await this.inviteService.revoke(
      toServiceContext(context),
      GlobalUID.parse('peer-invite', gid),
    );

    return { success: true, invite: PeerInviteType.toType(invite) };
  }

  @Mutation(() => AcceptPeerInvitePayload)
  // Calls the inviter's Companion and links both sides.
  @GraphqlPrivacy({ external: true })
  async acceptPeerInvite(
    @Context() context: RequestContext,
    @Args('input') input: AcceptPeerInviteInput,
  ): Promise<AcceptPeerInvitePayload> {
    if (!(await this.enabled())) {
      return { success: false };
    }

    const link = await this.inviteService.accept(toServiceContext(context), input.code, {
      displayName: input.displayName,
      myName: input.myName,
    });

    return { success: true, peerLink: PeerLinkType.toType(link) };
  }
}
