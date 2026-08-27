import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';

import {
  isPeerTrustTier,
  type PeerLink,
  PeerLinkEntity,
  type PeerLinkStatus,
  type PeerTrustTier,
} from '../entities/PeerLinkEntity';

export interface CreatePeerLinkDto {
  peerHandle: string;
  memoryEndpoint: string;
  displayName?: string | null;
  peerIssuer?: string | null;
  peerSubject?: string | null;
  personEntityId?: string | null;
  trustTier?: PeerTrustTier;
  status?: PeerLinkStatus;
}

/**
 * Owns the local half of the trust graph: which peers this box knows, how much
 * it trusts them, and which person in the owner's memory each one is.
 */
@Injectable()
export class PeerLinkService {
  constructor(
    @InjectRepository(PeerLinkEntity)
    private readonly repository: Repository<PeerLinkEntity>,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PeerLinkService.name);
  }

  /** Link a peer (idempotent on (owner, handle) — re-linking refreshes it). */
  async upsert(context: UserServiceContext, data: CreatePeerLinkDto): Promise<PeerLink> {
    // The DB CHECK on `trust_tier` is the real boundary, and it fails as a
    // `23514` the driver raises after the statement — surfaced to a caller as a
    // bare 500. `PeerTrustTier` already excludes `household` at COMPILE time,
    // but this method's input arrives from a Portal directory descriptor and
    // from GraphQL, where a type is only a promise. Rejected here, by name, in
    // front of the write. See {@link PEER_TRUST_TIERS}.
    if (data.trustTier !== undefined && !isPeerTrustTier(data.trustTier)) {
      throw new BadRequestException(`Unknown peer trust tier: ${String(data.trustTier)}`);
    }

    const existing = await this.repository.findOne({
      where: { ownerUserId: context.userId, peerHandle: data.peerHandle },
    });

    const record = this.repository.create({
      ...(existing ?? { id: uuidv7(), ownerUserId: context.userId, peerHandle: data.peerHandle }),
      memoryEndpoint: data.memoryEndpoint,
      displayName: data.displayName ?? existing?.displayName ?? null,
      peerIssuer: data.peerIssuer ?? existing?.peerIssuer ?? null,
      peerSubject: data.peerSubject ?? existing?.peerSubject ?? null,
      personEntityId: data.personEntityId ?? existing?.personEntityId ?? null,
      trustTier: data.trustTier ?? existing?.trustTier ?? 'peer',
      status: data.status ?? existing?.status ?? 'active',
      revokedAt: null,
    });

    return PeerLinkEntity.toEgressType(await this.repository.save(record));
  }

  async findAll(context: UserServiceContext): Promise<PeerLink[]> {
    const rows = await this.repository.find({ where: { ownerUserId: context.userId } });

    return rows.map(PeerLinkEntity.toEgressType);
  }

  /** Owner-scoped lookup by id, used to resolve an inbound ask's trust tier. */
  async findById(context: UserServiceContext, id: string): Promise<PeerLink | null> {
    const row = await this.repository.findOne({
      where: { ownerUserId: context.userId, id },
    });

    return row ? PeerLinkEntity.toEgressType(row) : null;
  }

  async findByHandle(context: UserServiceContext, handle: string): Promise<PeerLink | null> {
    const row = await this.repository.findOne({
      where: { ownerUserId: context.userId, peerHandle: handle },
    });

    return row ? PeerLinkEntity.toEgressType(row) : null;
  }

  /**
   * Attribute an INBOUND ask to a known peer by the OIDC identity that signed
   * it. Only active links match — a revoked peer is indistinguishable from an
   * unknown one, which is what makes revocation immediate and total.
   */
  async findActiveByIssuerSubject(
    ownerUserId: string,
    issuer: string,
    subject: string,
  ): Promise<PeerLink | null> {
    const row = await this.repository.findOne({
      where: {
        ownerUserId,
        peerIssuer: issuer,
        peerSubject: subject,
        status: 'active',
        revokedAt: IsNull(),
      },
    });

    return row ? PeerLinkEntity.toEgressType(row) : null;
  }

  /**
   * All ACTIVE links across this box matching a peer's OIDC identity. An
   * inbound ask is addressed to the box, so this is how it is routed to the
   * right responder. Returning a list (rather than one row) keeps the
   * multi-user household case explicit: the caller must disambiguate rather
   * than silently answering as an arbitrary member.
   */
  async findActiveByPeerIdentity(issuer: string, subject: string): Promise<PeerLink[]> {
    const rows = await this.repository.find({
      where: { peerIssuer: issuer, peerSubject: subject, status: 'active', revokedAt: IsNull() },
    });

    return rows.map(PeerLinkEntity.toEgressType);
  }

  /**
   * All ACTIVE links across this box holding a given signing key.
   *
   * The KEY-FIRST half of inbound routing, and it returns a list for the same
   * reason {@link findActiveByPeerIdentity} does: two members of a household may
   * each have linked the same peer, and the caller must disambiguate rather than
   * answering as an arbitrary one.
   *
   * Note what this deliberately does NOT consult: the OIDC issuer or subject.
   * A signature proves possession of the key; whether the peer also presented a
   * Portal token that says who operates it is a separate, additive fact. Mixing
   * the two here would put the issuer back in the identity path, which is the
   * coupling the key is meant to remove.
   */
  async findActiveByKeyThumbprint(thumbprint: string): Promise<PeerLink[]> {
    if (!thumbprint) {
      return [];
    }

    const rows = await this.repository.find({
      where: { peerKeyThumbprint: thumbprint, status: 'active', revokedAt: IsNull() },
    });

    return rows.map(PeerLinkEntity.toEgressType);
  }

  /** Revoke a peer link — takes effect on the next inbound ask. */
  async revoke(context: UserServiceContext, handle: string): Promise<PeerLink> {
    const row = await this.repository.findOne({
      where: { ownerUserId: context.userId, peerHandle: handle },
    });

    if (row == null) {
      throw new NotFoundException(`Peer ${handle} not found`);
    }

    row.status = 'revoked';
    row.revokedAt = new Date();
    this.logger.log(`peer link revoked: ${handle}`);

    return PeerLinkEntity.toEgressType(await this.repository.save(row));
  }
}
