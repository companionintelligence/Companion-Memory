import { Optional, UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { FeatureService } from '@ci/common/feature';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { PeerIdentityService, PeerInviteService, PeerNoticeService } from '@ci/domains/peers';

import { GraphqlPrivacy } from '../decorators/GraphqlPrivacy';
import { GlobalUID } from '../types/GlobalUID';
import {
  AcceptPeerInviteInput,
  AcceptPeerInvitePayload,
  CreatePeerInviteInput,
  CreatePeerInvitePayload,
  PeerInvitePayload,
  PeerInviteType,
  PeerKeyRotationPayload,
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
    @Optional() private readonly identityService?: PeerIdentityService,
    @Optional() private readonly noticeService?: PeerNoticeService,
  ) {}

  /**
   * Retire the caller's peer key and make a new one, telling everyone they are
   * linked to by key. For a key the owner thinks may have leaked. Invites still
   * waiting stop working, since each names the old key.
   */
  @Mutation(() => PeerKeyRotationPayload)
  // Tells every linked Companion.
  @GraphqlPrivacy({ external: true })
  async rotatePeerKey(@Context() context: RequestContext): Promise<PeerKeyRotationPayload> {
    if (!(await this.enabled()) || this.noticeService == null) {
      return { success: false, notified: [], unreachable: [] };
    }

    return { success: true, ...(await this.noticeService.rotateKey(toServiceContext(context))) };
  }

  /** Tell everyone about the last rotation again, for those who could not be reached the first time. */
  @Mutation(() => PeerKeyRotationPayload)
  @GraphqlPrivacy({ external: true })
  async resendPeerKeyRotation(@Context() context: RequestContext): Promise<PeerKeyRotationPayload> {
    if (!(await this.enabled()) || this.noticeService == null) {
      return { success: false, notified: [], unreachable: [] };
    }

    return { success: true, ...(await this.noticeService.resendRotation(toServiceContext(context))) };
  }

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

    // With its safety code: right after linking is when the two people are most
    // likely to compare it.
    const ownerDidKey =
      (await this.identityService?.existingDidKeyFor(toServiceContext(context).userId)) ?? null;

    return { success: true, peerLink: PeerLinkType.toType(link, ownerDidKey) };
  }
}
