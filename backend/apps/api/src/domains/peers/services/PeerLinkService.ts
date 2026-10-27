import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { GrantService } from '@ci/domains/asks';

import {
  isPeerTrustTier,
  type PeerLink,
  PeerLinkEntity,
  type PeerLinkStatus,
  type PeerTrustTier,
} from '../entities/PeerLinkEntity';
import { isSovereignKeyId } from '../sovereignKeyId';

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
 * The live signing-key index (`20260826155700_add_peer_link_signing_keys.sql`).
 * Nothing in `upsert` writes a key, so the only way a write here trips it is by
 * re-activating a revoked row that still carries one.
 */
const KEY_CONSTRAINT = 'peer_links_owner_key_live_uniq';

/**
 * The constraint a `23505` names, or `null` when the error is not a unique
 * violation at all. A violation whose name a pooler dropped comes back as
 * `{ constraint: undefined }`, which callers must tell apart from `null`.
 */
function uniqueViolation(err: unknown): { constraint: unknown } | null {
  const candidate = err as {
    code?: unknown;
    constraint?: unknown;
    driverError?: { code?: unknown; constraint?: unknown };
  } | null;

  if ((candidate?.driverError?.code ?? candidate?.code) !== '23505') {
    return null;
  }

  return { constraint: candidate?.driverError?.constraint ?? candidate?.constraint };
}

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
  const violation = uniqueViolation(err);

  return violation != null && (violation.constraint == null || violation.constraint === IDENTITY_CONSTRAINT);
}

/** Was this write refused by the live signing-key index, by name? */
function isKeyConflict(err: unknown): boolean {
  return uniqueViolation(err)?.constraint === KEY_CONSTRAINT;
}

/**
 * Does this row fall inside the identity index's predicate (setting
 * `revoked_at` aside)? Both columns non-null and non-empty, exactly as
 * `peer_links_owner_identity_live_uniq` spells it.
 */
function carriesIdentity(row: Pick<PeerLinkEntity, 'peerIssuer' | 'peerSubject'>): boolean {
  return !!row.peerIssuer && !!row.peerSubject;
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
    // Re-activating a revoked link revokes the grants still addressed to it;
    // see `upsert`.
    private readonly grantService: GrantService,
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
    // Re-activating a revoked link puts its stored row back into the partial
    // `revoked_at IS NULL` indexes, so it can clash there without naming an
    // identity or a key at all. Only a row that carries an identity can clash on
    // the identity index, so an unbound one never has a pooler's nameless
    // `23505` read as an identity clash.
    const reactivates = existing?.revokedAt != null && record.revokedAt == null;
    const reactivatesIdentity = reactivates && carriesIdentity(record);

    if (touchesIdentity && (record.peerIssuer == null) !== (record.peerSubject == null)) {
      throw new BadRequestException(
        'peerIssuer and peerSubject must be set together — one alone can never match an inbound ask',
      );
    }

    let saved: PeerLinkEntity;

    try {
      saved = await this.repository.save(record);
    } catch (err) {
      // ═══ ONE LIVE LINK PER (OWNER, IDENTITY) — WHY THE DB DECIDES ═══
      //
      // A read-then-write check here would race: two concurrent binds both read
      // "nothing claims it" and both insert. `peer_links_owner_identity_live_uniq`
      // is the only place that cannot be lost to a race, so the check lives
      // there and this catch exists to give it an honest status code instead of
      // the bare 500 an unhandled `23505` becomes.
      if (touchesIdentity && isIdentityConflict(err)) {
        throw new ConflictException(
          'Another active peer link already claims that (peerIssuer, peerSubject) — ' +
            'revoke it first, or re-bind that link instead',
        );
      }

      // The caller named no identity, and the stored one is write-only, so the
      // message cannot point at a pair they typed. It says what they can do.
      if (reactivatesIdentity && isIdentityConflict(err)) {
        throw new ConflictException(
          `Another active peer link now claims the identity ${data.peerHandle} was bound to. ` +
            'Revoke that link first, or re-add this one with a different peerIssuer and peerSubject.',
        );
      }

      if (reactivates && isKeyConflict(err)) {
        throw new ConflictException(
          `Another active peer link now holds the signing key ${data.peerHandle} was bound to. ` +
            'Revoke that link first.',
        );
      }

      throw err;
    }

    if (reactivates) {
      // ═══ A RE-ADDED LINK STARTS OVER, GRANTS INCLUDED ═══
      //
      // The row keeps its id, and grants address a peer by that id, so the
      // grants the owner gave this peer before ending the link would apply to
      // its next ask, an `auto` one with no review. A re-added link starts at
      // Stranger like a new one (`createPeerLink`), and a new one has no
      // grants. `revoke()` leaves them alone, so this is where they go.
      const revokedGrants = await this.grantService.revokeForPeerLink(context, saved.id);

      // The counterpart of the line `revoke()` logs: a link coming back is as
      // much a change to who can ask as one going away.
      this.logger.log(`peer link re-activated: ${data.peerHandle}; ${revokedGrants} old grant(s) revoked`);
    }

    return PeerLinkEntity.toEgressType(saved);
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

    const whereConditions: Array<Record<string, unknown>> = [
      { peerKeyThumbprint: thumbprint, status: 'active', revokedAt: IsNull() },
    ];

    // A sovereign keyid IS the peer's AID, so the link that names it is found by
    // its identity, whether or not it records the key (see `sovereignKeyId.ts`).
    if (isSovereignKeyId(thumbprint)) {
      whereConditions.push({
        peerIssuer: 'did:keri',
        peerSubject: thumbprint,
        status: 'active',
        revokedAt: IsNull(),
      });
    }

    const rows = await this.repository.find({
      where: whereConditions,
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
