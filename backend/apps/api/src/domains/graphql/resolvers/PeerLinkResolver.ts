import { NotFoundException, UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { PersonService } from '@ci/domains/memory';
import { PeerLinkService } from '@ci/domains/peers';

import { GlobalUID } from '../types/GlobalUID';
import {
  CreatePeerLinkInput,
  PeerLinkPayload,
  PeerLinkType,
  PeerTrustTierEnum,
  UpdatePeerLinkInput,
} from '../types/PeerLinkType';

/**
 * Peer links — who this box will exchange asks with, and how far it trusts them.
 *
 * ── Why this resolver exists ───────────────────────────────────────────────
 *
 * `PeerLinkService` has been complete and correct for some time, and had ZERO
 * production callers: no mutation, no route, no CLI. A link could only be
 * created by hand-writing a thirteen-column INSERT, which is what the federation
 * test harness does. That made both federated journeys — and every peer grant,
 * since `createAskGrant(granteePeerLinkId:)` needs a link id the owner can never
 * see — unreachable by anyone who is not a DBA.
 *
 * ── Why the trust tier is the whole point ──────────────────────────────────
 *
 * A link is not an address book entry. `trustTier` is the CEILING on everything
 * that peer can ever be told: `policy.ts` maps each tier to a maximum disclosure
 * rung, so demoting someone narrows every future answer without touching a
 * grant. That is why `CreatePeerLinkInput` defaults to `stranger` rather than
 * inheriting the service's `peer` — adding a person is not the same gesture as
 * trusting them, and the safe default for a consent surface is the narrow one.
 *
 * ── What is deliberately NOT here ──────────────────────────────────────────
 *
 * Directory lookup by handle. `PeerDirectoryService.resolve` needs a CI-Portal
 * access token and nothing puts one in the request context, so wiring it needs
 * plumbing this resolver cannot honestly stand in for. An owner supplies the
 * endpoint directly for now — and, since this change, the peer's `(iss, sub)`
 * directly too. Better a manual step than a lookup that pretends to verify an
 * identity it never checked.
 *
 * ── Why `peerIssuer` / `peerSubject` are owner-scoped for free ─────────────
 *
 * They are the most dangerous fields on this surface: they decide WHICH remote
 * identity may act as this peer, and therefore which `trustTier` ceiling a
 * stranger's token inherits. They needed no new scoping, and it is worth saying
 * exactly why rather than assuming it:
 *
 *   - `createPeerLink` hands `upsert` the CALLER's service context, and `upsert`
 *     keys its read and its write on `context.userId` — a create can only ever
 *     touch a row this owner owns.
 *   - `updatePeerLink` resolves the id through `findById`, which is owner-scoped
 *     (`where: { ownerUserId, id }`), and throws `NotFoundException` BEFORE any
 *     write when it misses. The two new fields sit inside that same guarded
 *     block, so "re-point someone else's link at an identity I control" fails
 *     at the read, not at the write. `PeerLinkResolver.test.ts` pins this.
 *
 * What owner scoping alone does NOT give is uniqueness: two of one owner's OWN
 * links could otherwise claim the same `(iss, sub)`, and `findActiveByIssuerSubject`
 * is a `findOne` — so which trust tier applied would be decided by heap order.
 * That is closed by a partial unique index; see `PeerLinkService.upsert`.
 */
@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => PeerLinkType)
export class PeerLinkResolver {
  constructor(
    private readonly peerLinkService: PeerLinkService,
    private readonly personService: PersonService,
  ) {}

  /**
   * Every peer this box knows, revoked ones included.
   *
   * Revoked links are RETURNED, not filtered. "Who did I used to share with"
   * is a question the owner is entitled to ask, and a revocation the UI cannot
   * show is a revocation the owner cannot verify happened. `status` and
   * `revokedAt` carry the state; the client decides how to present it.
   */
  @Query(() => [PeerLinkType])
  async myPeerLinks(@Context() context: RequestContext): Promise<PeerLinkType[]> {
    const links = await this.peerLinkService.findAll(toServiceContext(context));

    return links.map(PeerLinkType.toType);
  }

  @Query(() => PeerLinkType, { nullable: true })
  async peerLink(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<PeerLinkType | null> {
    const link = await this.peerLinkService.findById(
      toServiceContext(context),
      GlobalUID.parse('peer-link', gid),
    );

    return link ? PeerLinkType.toType(link) : null;
  }

  @Mutation(() => PeerLinkPayload)
  async createPeerLink(
    @Context() context: RequestContext,
    @Args('input') input: CreatePeerLinkInput,
  ): Promise<PeerLinkPayload> {
    const link = await this.peerLinkService.upsert(toServiceContext(context), {
      peerHandle: input.peerHandle,
      memoryEndpoint: input.memoryEndpoint,
      displayName: input.displayName ?? null,
      personEntityId: input.personEntityId ? GlobalUID.parse('person', input.personEntityId) : null,
      // Narrowest tier when unspecified. `upsert` would otherwise fall back to
      // `peer`, which is two rungs more permissive than adding a stranger should
      // imply — see the class docstring.
      trustTier: input.trustTier ?? PeerTrustTierEnum.stranger,
      // The identity inbound asks are matched on. `undefined` is passed through
      // as `undefined`, NOT coerced to null: `upsert` distinguishes the two, and
      // only `undefined` means "leave whatever is there alone" — which is what
      // keeps re-adding an already-federated peer from silently unbinding it.
      peerIssuer: input.peerIssuer,
      peerSubject: input.peerSubject,
    });

    return { success: true, peerLink: PeerLinkType.toType(link) };
  }

  /**
   * Change what an existing link says — most importantly its tier.
   *
   * Reads the link through the owner-scoped finder FIRST. `upsert` keys on
   * `(ownerUserId, peerHandle)`, so calling it with another owner's handle would
   * silently CREATE a link rather than touch theirs — safe, but it would answer
   * "not found" with a new row, which is a confusing lie. The explicit read makes
   * the refusal honest and keeps the handle out of the write path entirely.
   */
  @Mutation(() => PeerLinkPayload)
  async updatePeerLink(
    @Context() context: RequestContext,
    @Args('input') input: UpdatePeerLinkInput,
  ): Promise<PeerLinkPayload> {
    const serviceContext = toServiceContext(context);
    const id = GlobalUID.parse('peer-link', input.id);
    const existing = await this.peerLinkService.findById(serviceContext, id);

    if (existing == null) {
      throw new NotFoundException(`Peer link ${input.id} not found`);
    }

    const link = await this.peerLinkService.upsert(serviceContext, {
      peerHandle: existing.peerHandle,
      memoryEndpoint: existing.memoryEndpoint,
      displayName: input.displayName ?? existing.displayName,
      personEntityId: input.personEntityId
        ? GlobalUID.parse('person', input.personEntityId)
        : existing.personEntityId,
      trustTier: input.trustTier ?? (existing.trustTier as PeerTrustTierEnum),
      // Same rule as every other optional field on this input: absent means
      // unchanged. `existing` is the SERVICE type, which carries the pair even
      // though `PeerLinkType` never projects it — so reading it back here to
      // preserve it does not put it on the wire.
      peerIssuer: input.peerIssuer ?? existing.peerIssuer,
      peerSubject: input.peerSubject ?? existing.peerSubject,
    });

    return { success: true, peerLink: PeerLinkType.toType(link) };
  }

  /**
   * Stop exchanging asks with a peer.
   *
   * `docs/peer-federation.md` lists "revocation is immediate" as a security
   * property, and it is: `findActiveByPeerIdentity` filters on `revokedAt IS
   * NULL`, so the next inbound token from that peer fails to resolve a link and
   * the ask is refused before any policy runs. Nothing is deleted — the link
   * stays readable so the owner can see the relationship existed.
   */
  @Mutation(() => PeerLinkPayload)
  async revokePeerLink(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<PeerLinkPayload> {
    const serviceContext = toServiceContext(context);
    const existing = await this.peerLinkService.findById(serviceContext, GlobalUID.parse('peer-link', gid));

    if (existing == null) {
      throw new NotFoundException(`Peer link ${gid} not found`);
    }

    const link = await this.peerLinkService.revoke(serviceContext, existing.peerHandle);

    return { success: true, peerLink: PeerLinkType.toType(link) };
  }

  /**
   * The avatar of the Person in the OWNER's own memory this peer is linked
   * to (the owner's local judgement of who the peer is — never the peer's
   * own claim). `personEntityId` is already a global id on the wire, so it is
   * decoded and re-scoped through `PersonService.findById` here rather than
   * carried in some side channel; that finder is owner-scoped exactly like
   * `PeerLinkService.findById` above, which is what keeps a peer link that
   * somehow named another owner's Person from leaking that Person's avatar —
   * the lookup fails closed to null instead.
   *
   * Only `avatarUrl` crosses. The rest of the linked Person's `properties`
   * jsonb is never touched here.
   */
  @ResolveField(() => String, { nullable: true })
  async avatarUrl(
    @Context() context: RequestContext,
    @Parent() parent: PeerLinkType,
  ): Promise<string | null> {
    if (parent.personEntityId == null) {
      return null;
    }

    const serviceContext = toServiceContext(context);
    const person = await this.personService.findById(
      serviceContext,
      GlobalUID.parse('person', parent.personEntityId),
    );

    return (person?.properties?.avatar_url as string) ?? null;
  }
}
