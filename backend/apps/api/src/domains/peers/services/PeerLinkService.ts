import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
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
 * The partial unique index this service can violate, by name.
 *
 * See `20260906120000_add_peer_link_identity_uniq.sql`. Checked by name rather than
 * treating any `23505` on the table as an identity clash, because
 * `peer_links_owner_handle_uniq` and `peer_links_owner_key_live_uniq` are also
 * live here and reporting either of those as "another link already claims that
 * identity" would be a lie that survives every test.
 */
const IDENTITY_CONSTRAINT = 'peer_links_owner_identity_live_uniq';

/**
 * Was this write refused because another LIVE link of this owner's already
 * claims the same `(peer_issuer, peer_subject)`?
 *
 * The constraint name is accepted as ABSENT, matching `PipelineRunService`'s
 * reading of the same question: node-postgres populates it from the server's
 * error fields and a pooler in between is not required to. An absent name on a
 * write that supplied an identity is read as the identity clash; a `23505`
 * naming some other constraint is rethrown untouched, so a handle collision
 * keeps surfacing as itself.
 */
function isIdentityConflict(err: unknown): boolean {
  const candidate = err as {
    code?: unknown;
    constraint?: unknown;
    driverError?: { code?: unknown; constraint?: unknown };
  } | null;

  if ((candidate?.driverError?.code ?? candidate?.code) !== '23505') {
    return false;
  }

  const constraint = candidate?.driverError?.constraint ?? candidate?.constraint;

  return constraint == null || constraint === IDENTITY_CONSTRAINT;
}

/**
 * Normalize one half of the peer identity, or reject it.
 *
 * `undefined` means "the caller said nothing" and is preserved as such — only
 * that is allowed to mean "leave whatever is stored alone". Everything else is
 * trimmed, and a value that trims to nothing is refused rather than stored:
 * `PortalTokenService.verifyClaims` returns null unless BOTH claims are
 * non-empty, so a blank column can never be matched by a verified token. Storing
 * one would leave the owner looking at a link that says it is bound and behaves
 * as if it is not.
 */
function normalizeIdentityPart(value: string | null | undefined, field: string): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  const trimmed = value.trim();

  if (trimmed === '') {
    throw new BadRequestException(`${field} must not be blank`);
  }

  return trimmed;
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

  /**
   * Link a peer (idempotent on (owner, handle) — re-linking refreshes it).
   *
   * ═══ `peerIssuer` / `peerSubject`: WHAT THEY ARE, AND WHAT GUARDS THEM ═══
   *
   * The pair `PeerAskService.resolveLink` matches an inbound ask on. Setting it
   * is the gesture that decides WHICH REMOTE IDENTITY MAY ACT AS THIS PEER, and
   * therefore which `trustTier` ceiling a stranger's token inherits — so it is
   * the most consequential thing this method writes. Three guards, in the order
   * they run:
   *
   *   1. **Owner scoping**, inherited rather than added: the read below and the
   *      row it creates are both keyed on `context.userId`, so a caller can
   *      only ever bind THEIR OWN link. `PeerLinkResolver.updatePeerLink` adds
   *      the matching refusal for an id it cannot read.
   *   2. **Both or neither, never blank** — a half-set pair is inert while
   *      looking bound.
   *   3. **One LIVE link per (owner, identity)**, enforced by a partial unique
   *      index because a read-then-write check races.
   *
   * `undefined` means "the caller said nothing", and is the only value that
   * leaves a stored binding alone — matching how this method already treats
   * `displayName` and `trustTier`. Clearing a binding is therefore not
   * expressible here (`null` reads as absent, as it does for every other
   * optional field); re-binding to the right identity, or revoking the link, is
   * the gesture that corrects a wrong one.
   */
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

    // Trimmed, and blank refused, BEFORE the pairing check below reads them —
    // otherwise `peerIssuer: '   '` would count as "supplied" and satisfy it.
    const peerIssuer = normalizeIdentityPart(data.peerIssuer, 'peerIssuer');
    const peerSubject = normalizeIdentityPart(data.peerSubject, 'peerSubject');

    const existing = await this.repository.findOne({
      where: { ownerUserId: context.userId, peerHandle: data.peerHandle },
    });

    const record = this.repository.create({
      ...(existing ?? { id: uuidv7(), ownerUserId: context.userId, peerHandle: data.peerHandle }),
      memoryEndpoint: data.memoryEndpoint,
      displayName: data.displayName ?? existing?.displayName ?? null,
      peerIssuer: peerIssuer ?? existing?.peerIssuer ?? null,
      peerSubject: peerSubject ?? existing?.peerSubject ?? null,
      personEntityId: data.personEntityId ?? existing?.personEntityId ?? null,
      trustTier: data.trustTier ?? existing?.trustTier ?? 'peer',
      status: data.status ?? existing?.status ?? 'active',
      // Closes G5(b): editing a link via `updatePeerLink` (where `data.status` is
      // omitted) must preserve an existing `revokedAt` timestamp rather than
      // unconditionally wiping it to null. Explicit re-activation (`status: 'active'`)
      // clears `revokedAt`.
      revokedAt: data.status === 'active' ? null : (existing?.revokedAt ?? null),
    });

    // ═══ BOTH OR NEITHER — CHECKED ON THE MERGED ROW, NOT THE INPUT ═══
    //
    // `findActiveByPeerIdentity` filters on BOTH columns, so a link carrying
    // only one of them can never match anything: it is inert while looking
    // bound. The check is on the row that is about to be WRITTEN rather than on
    // `data`, because the merge above is what decides the outcome — supplying
    // only `peerSubject` on a link that already has an issuer is a legitimate
    // half-write, and supplying only `peerSubject` on a link that has neither
    // is the mistake.
    //
    // Scoped to writes that TOUCH the identity. A link whose columns were left
    // half-set by hand-written SQL (the only way to set them before this
    // change, per `docs/peer-federation.md`) can still have its display name or
    // tier edited; only a write that means to change the binding has to leave
    // it coherent. Refusing every unrelated edit to such a row would turn a
    // legacy inconsistency into an outage.
    const touchesIdentity = peerIssuer !== undefined || peerSubject !== undefined;
    // Re-activating a revoked link puts its stored binding back into the live
    // identity index, so it can clash there without naming an identity at all.
    const reactivates = existing?.revokedAt != null && record.revokedAt == null;

    if (touchesIdentity && (record.peerIssuer == null) !== (record.peerSubject == null)) {
      throw new BadRequestException(
        'peerIssuer and peerSubject must be set together — one alone can never match an inbound ask',
      );
    }

    try {
      return PeerLinkEntity.toEgressType(await this.repository.save(record));
    } catch (err) {
      // ═══ ONE LIVE LINK PER (OWNER, IDENTITY) — WHY THE DB DECIDES ═══
      //
      // A read-then-write check here would race: two concurrent binds both read
      // "nothing claims it" and both insert. `peer_links_owner_identity_live_uniq`
      // is the only place that cannot be lost to a race, so the check lives
      // there and this catch exists to give it an honest status code instead of
      // the bare 500 an unhandled `23505` becomes.
      if ((touchesIdentity || reactivates) && isIdentityConflict(err)) {
        throw new ConflictException(
          'Another active peer link already claims that (peerIssuer, peerSubject) — ' +
            'revoke it first, or re-bind that link instead',
        );
      }

      throw err;
    }
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
