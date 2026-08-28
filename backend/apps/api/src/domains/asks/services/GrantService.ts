import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';

import { type Ask, AskEntity } from '../entities/AskEntity';
import { type AskGrant, AskGrantEntity } from '../entities/AskGrantEntity';
import { evaluateGrant, isGrantActive } from '../grantMatch';
import { DISCLOSURE_RUNGS } from '../policy';
import type { AskGrantScope, CreateAskGrantDto, GrantEvaluation, UpdateAskGrantDto } from '../types';

/**
 * Owns standing consent grants and evaluates an incoming ask against them. The
 * decision logic itself is the pure {@link evaluateGrant}; this service only
 * loads the owner-and-grantee-scoped grants and delegates, keeping the
 * security-critical rule unit-testable without a database.
 *
 * Grant rows are append-only: {@link revoke} and {@link supersede} close a grant
 * out, {@link supersede} writes its replacement, and nothing rewrites a grant in
 * place. That, plus `version` / `supersedesGrantId` / `revocationReason`, is the
 * consent audit trail — a change is reconstructible from the table alone.
 */
@Injectable()
export class GrantService {
  constructor(
    @InjectRepository(AskGrantEntity)
    private readonly grantRepository: Repository<AskGrantEntity>,
    // The asks table, for RETROACTIVE revocation only (see `withdrawPreAuthorization`).
    // Deliberately the repository and not `AskService`: AskService already depends
    // on this service, and closing that loop would need a forwardRef.
    @InjectRepository(AskEntity)
    private readonly askRepository: Repository<AskEntity>,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(GrantService.name);
  }

  /** Create a standing grant owned by the caller. */
  async create(context: UserServiceContext, data: CreateAskGrantDto): Promise<AskGrant> {
    // Exactly one grantee kind, mirroring the DB CHECK. Allowing both would let
    // a grant intended for a household member also authorize a peer.
    const hasUser = data.granteeUserId != null;
    const hasPeer = data.granteePeerLinkId != null;
    if (hasUser === hasPeer) {
      throw new BadRequestException('A grant must name exactly one of granteeUserId / granteePeerLinkId');
    }

    assertFutureExpiry(data.expiresAt);
    assertReadableCeiling(data.scope);

    const record = this.grantRepository.create({
      id: data.id ?? uuidv7(),
      ownerUserId: context.userId,
      granteeUserId: data.granteeUserId ?? null,
      granteePeerLinkId: data.granteePeerLinkId ?? null,
      resourceType: data.resourceType ?? null,
      resourceId: data.resourceId ?? null,
      queryType: data.queryType,
      dataClass: data.dataClass ?? null,
      scope: data.scope ?? null,
      mode: data.mode ?? 'review',
      purpose: data.purpose ?? null,
      revokedAt: null,
      expiresAt: data.expiresAt ?? null,
      revocationReason: null,
      version: 1,
      supersedesGrantId: null,
    });
    const entity = await this.grantRepository.save(record);

    return AskGrantEntity.toEgressType(entity);
  }

  /** Revoke a grant (owner-scoped). Idempotent: re-revoking keeps the first time. */
  async revoke(context: UserServiceContext, id: string): Promise<AskGrant> {
    const entity = await this.ownedById(context, id);

    if (entity.revokedAt == null) {
      entity.revokedAt = new Date();
      entity.revocationReason = 'revoked';
      await this.grantRepository.save(entity);
      // Revocation is RETROACTIVE. Without this, an ask that was pre-authorized
      // under this grant keeps its consent stamp and stays answerable after the
      // owner taps Revoke — see `withdrawPreAuthorization`.
      await this.withdrawPreAuthorization(entity);
    }

    return AskGrantEntity.toEgressType(entity);
  }

  /**
   * CHANGE a standing grant — the Grant Manager's `onChangeMode(grantId, mode)`,
   * and the only expressible edit before this existed was "write a second row",
   * which left both rows live and both matching.
   *
   * Implemented as a SUPERSEDE, not an UPDATE, and that is a deliberate trade:
   * an UPDATE is one statement and loses the record of what the owner previously
   * allowed and until when. Consent is the kind of thing you get asked to
   * evidence after the fact ("what was I sharing in March?"), so the old row is
   * closed out with `revocationReason = 'superseded'` and the replacement points
   * back at it. The cost is a row per change; the table is per-owner and
   * per-grantee, so that is small.
   *
   * The supersede cascades exactly like a revoke: asks riding the OLD grant lose
   * their pre-authorization and land in the owner's inbox. They are NOT silently
   * re-evaluated against the new grant — a narrowing change must not be able to
   * auto-answer something the previous posture had already stamped, and a
   * widening one should still get a human's eyes the first time.
   */
  async supersede(context: UserServiceContext, id: string, changes: UpdateAskGrantDto): Promise<AskGrant> {
    const previous = await this.ownedById(context, id);

    // Only a grant that is actually in force can be changed. Editing a revoked
    // or lapsed grant would resurrect consent the owner already ended, and the
    // result would be indistinguishable in the history from one that never
    // stopped.
    if (!isGrantActive(previous)) {
      throw new BadRequestException(
        `Grant ${id} is no longer active and cannot be changed; create a new grant`,
      );
    }

    const expiresAt = changes.expiresAt === undefined ? previous.expiresAt : changes.expiresAt;
    assertFutureExpiry(expiresAt);
    assertReadableCeiling(changes.scope);

    const replacement = this.grantRepository.create({
      id: uuidv7(),
      ownerUserId: previous.ownerUserId,
      granteeUserId: previous.granteeUserId,
      granteePeerLinkId: previous.granteePeerLinkId,
      // The grantee and the query type identify WHICH grant this is; changing
      // either would make it a different grant, so they are not editable here.
      queryType: previous.queryType,
      dataClass: changes.dataClass === undefined ? previous.dataClass : changes.dataClass,
      scope: mergeScope(previous.scope, changes.scope),
      mode: changes.mode ?? previous.mode,
      purpose: changes.purpose === undefined ? previous.purpose : changes.purpose,
      revokedAt: null,
      expiresAt,
      revocationReason: null,
      version: previous.version + 1,
      supersedesGrantId: previous.id,
    });

    // One transaction: a replacement without its predecessor closed leaves TWO
    // live grants matching the same asks (the bug this method exists to fix),
    // and a closed predecessor without its replacement silently revokes consent
    // the owner meant to keep.
    const saved = await this.grantRepository.manager.transaction(async (manager) => {
      const created = await manager.save(AskGrantEntity, replacement);

      previous.revokedAt = new Date();
      previous.revocationReason = 'superseded';
      await manager.save(AskGrantEntity, previous);

      return created;
    });

    await this.withdrawPreAuthorization(previous);

    return AskGrantEntity.toEgressType(saved);
  }

  /** All grants owned by the caller that are in force right now. */
  async listForOwner(context: UserServiceContext): Promise<AskGrant[]> {
    const rows = await this.grantRepository.find({
      where: { ownerUserId: context.userId, revokedAt: IsNull() },
      order: { createdAt: 'DESC' },
    });

    // `revoked_at IS NULL` is not the whole liveness rule any more — a lapsed
    // grant is equally not in force. The predicate lives in one place
    // (`isGrantActive`) so the SQL filter and the matcher cannot drift apart.
    return rows.filter((row) => isGrantActive(row)).map(AskGrantEntity.toEgressType);
  }

  /**
   * EVERY grant the caller ever wrote, newest first — revoked, lapsed and
   * superseded included.
   *
   * `listForOwner` was the only grant read path, and it filtered
   * `revoked_at IS NULL`, which made two things impossible: the owner could not
   * see what they had revoked, and a disclosure-history row citing a
   * since-revoked grant as its consent basis could not resolve that basis to
   * anything at all. Kept as a SEPARATE method so the default read stays
   * active-only — history is for showing, never for authorizing.
   */
  async listHistoryForOwner(context: UserServiceContext): Promise<AskGrant[]> {
    const rows = await this.grantRepository.find({
      where: { ownerUserId: context.userId },
      order: { createdAt: 'DESC' },
    });

    return rows.map(AskGrantEntity.toEgressType);
  }

  /**
   * One grant by id, owner-scoped, in ANY lifecycle state.
   *
   * This is the lookup that lets a disclosure resolve its `consentBasis` after
   * the grant behind it is gone. It returns revoked and lapsed grants ON
   * PURPOSE, so callers must not use it to decide whether an ask may be
   * answered — use {@link isConsentStanding} for that.
   */
  async findByIdForOwner(context: UserServiceContext, id: string): Promise<AskGrant | null> {
    const entity = await this.grantRepository.findOne({
      where: { id, ownerUserId: context.userId },
    });

    return entity ? AskGrantEntity.toEgressType(entity) : null;
  }

  /**
   * Decide how a delivered ask should be handled — `auto`, `review`, or `deny` —
   * by evaluating the responder's standing grants for this asker. Review is the
   * default when nothing matches.
   */
  async evaluate(ask: Ask, now: Date = new Date()): Promise<GrantEvaluation> {
    // An inbound peer ask is authorized against grants addressed to its PEER
    // LINK; a local ask against grants addressed to the asking user. Selecting
    // on exactly one of the two keys is what stops a peer from picking up a
    // household member's grants (and vice versa).
    const grantee =
      ask.direction === 'inbound'
        ? { granteePeerLinkId: ask.peerLinkId ?? undefined }
        : { granteeUserId: ask.askerUserId ?? undefined };

    if (Object.values(grantee)[0] == null || ask.responderUserId == null) {
      // No identifiable asker, or no local responder whose grants could apply
      // (an outbound ask is gated by the PEER's policy, not ours) → no grant can
      // match; fall through to review.
      return evaluateGrant(ask.query, [], now);
    }

    const grants = await this.grantRepository.find({
      where: {
        ownerUserId: ask.responderUserId,
        ...grantee,
        revokedAt: IsNull(),
      },
    });

    return evaluateGrant(ask.query, grants, now);
  }

  /**
   * Is the standing grant that pre-authorized this ask STILL in force?
   *
   * `AskService.submit` stamps `consentBasis = <grant id>` when a standing grant
   * says `auto`, and the answer path then trusts that stamp. The stamp is a
   * record of a decision made at submit time; it is not evidence that consent
   * still stands now. Without this re-check, an ask pre-authorized on Monday
   * stays answerable on Tuesday after the owner revoked the grant on Monday
   * night — while the UI promises "revocable in one tap", which every user reads
   * as "stops future disclosure".
   *
   * The distinction that matters: this asks about a STANDING-GRANT
   * pre-authorization only. An ask the owner personally approved (status
   * `answering`) is authorized by that human decision, not by a grant, and
   * revoking the standing grant must not retroactively break it — the owner
   * already looked at that specific ask and said yes.
   *
   * Returns true for an ask with no consent basis: there is no standing grant to
   * check, and whether such an ask may be answered is the lifecycle's question
   * (`isAnswerable`), not this one.
   */
  async isConsentStanding(ask: Ask, now: Date = new Date()): Promise<boolean> {
    if (ask.consentBasis == null || ask.responderUserId == null) {
      return true;
    }

    const grant = await this.grantRepository.findOne({
      where: { id: ask.consentBasis, ownerUserId: ask.responderUserId },
    });

    // A consent basis naming a grant that no longer exists — or that belongs to
    // someone else — is not consent. Fail closed.
    return grant != null && isGrantActive(grant, now);
  }

  /**
   * Strip the standing-grant pre-authorization from every ask still riding this
   * grant, and put those asks in front of the owner instead.
   *
   * Only asks still in `delivered` are touched, and that is the whole point of
   * the filter: `delivered` + a consent basis is the shape of "auto-answerable
   * because a standing grant says so". An ask in `answering` was approved by the
   * owner for that specific ask, so revoking the standing grant leaves it alone;
   * terminal asks (`answered` / `declined` / `expired`) are history and are
   * never rewritten.
   *
   * Clearing `consentBasis` is what makes the existing gate
   * (`isAnswerable(status, consentBasis)`) reject the ask, so revocation takes
   * effect through the check that is already on the answer path rather than
   * needing a new one.
   */
  private async withdrawPreAuthorization(grant: AskGrantEntity): Promise<void> {
    const stranded = await this.askRepository.find({
      where: {
        responderUserId: grant.ownerUserId,
        consentBasis: grant.id,
        status: 'delivered',
      },
    });

    if (stranded.length === 0) {
      return;
    }

    for (const ask of stranded) {
      ask.consentBasis = null;
      ask.status = 'under_review';
    }

    await this.askRepository.save(stranded);
    this.logger.log(
      `Grant ${grant.id} closed (${grant.revocationReason}); ${stranded.length} pre-authorized ask(s) returned to owner review`,
    );
  }

  private async ownedById(context: UserServiceContext, id: string): Promise<AskGrantEntity> {
    const entity = await this.grantRepository.findOne({
      where: { id, ownerUserId: context.userId },
    });
    if (entity == null) {
      throw new NotFoundException(`Grant ${id} not found`);
    }

    return entity;
  }
}

/**
 * A grant that is born expired is a data-entry error, not a posture — and the
 * DB CHECK would reject it as a 500. Caught here so the caller gets a 400 that
 * says what is wrong.
 */
function assertFutureExpiry(expiresAt: Date | null | undefined, now: Date = new Date()): void {
  if (expiresAt != null && expiresAt <= now) {
    throw new BadRequestException('A grant expiry must be in the future');
  }
}

/**
 * A declared disclosure ceiling must name a real rung.
 *
 * `scope` is jsonb, so nothing at the storage layer stops `maxDisclosure:
 * 'summry'` from being written — and `ceilingOf` in grantMatch deliberately
 * reads an unreadable ceiling as `none`, the STRICTEST rung, so a typo cannot
 * become the loosest reading of the owner's own restriction. That is the right
 * behaviour at READ time and a terrible experience at WRITE time: the owner
 * picks "summary", fat-fingers the API, and their grant silently answers
 * nothing forever with no indication why.
 *
 * So the two halves are paired on purpose: strict here (a 400 the caller can
 * act on), fail-closed there (a value already in the table can never widen).
 * Compared against the rung vocabulary EXACTLY rather than through
 * `canonicalDataClass` — this is a fixed enum the client picks from, not a
 * free-text label a human typed, and accepting `'Full '` here would make the
 * stored value depend on how it was spelled.
 */
function assertReadableCeiling(scope: AskGrantScope | null | undefined): void {
  const declared = scope?.maxDisclosure;
  if (declared == null) {
    return;
  }

  if (!(DISCLOSURE_RUNGS as readonly unknown[]).includes(declared)) {
    throw new BadRequestException(`scope.maxDisclosure must be one of: ${DISCLOSURE_RUNGS.join(', ')}`);
  }
}

/**
 * Fold a scope CHANGE onto the scope being replaced.
 *
 * ═══ WHY THIS IS A MERGE AND NOT AN ASSIGNMENT ═══
 *
 * `scope` carries several INDEPENDENT restrictions — `dataClasses`,
 * `maxDisclosure`, `notBefore`/`notAfter`, `purpose` — and the Grant Manager
 * edits them one at a time. This used to be `changes.scope ?? previous.scope`,
 * which replaced the object WHOLESALE, so an owner narrowing the class list of
 * a grant capped at "digest only" sent `{ dataClasses: [...] }` and silently
 * DELETED `maxDisclosure` along with it. The next ask under that grant
 * disclosed in full. Tightening one dimension must not be able to drop another:
 * a narrowing edit that widens the answer is the exact inversion of what the
 * owner asked for, and it is invisible in the UI because the field they touched
 * did narrow.
 *
 * The three cases are distinct instructions, not shades of one:
 *
 * - `undefined` — "leave the scope alone". Inherit it whole.
 * - `null` — "remove every scope restriction". Honoured as written; it is the
 *   only way to widen, and it is explicit.
 * - an object — "set these keys". Merged over the previous scope, so keys the
 *   caller did not mention survive.
 *
 * Shallow by design: every field of {@link AskGrantScope} is a leaf or a whole
 * list, and a deep merge of `dataClasses` would make "narrow this grant to
 * photos" mean "add photos to whatever it already covered" — a widening edit
 * wearing a narrowing's clothes.
 */
function mergeScope(
  previous: AskGrantScope | null,
  changes: AskGrantScope | null | undefined,
): AskGrantScope | null {
  if (changes === undefined) {
    return previous;
  }

  if (changes === null || previous == null) {
    return changes;
  }

  return { ...previous, ...changes };
}
