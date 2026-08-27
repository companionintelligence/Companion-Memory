import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { LoggerService } from '@ci/common/logging';

import { AskGrantEntity } from '../entities/AskGrantEntity';
import { isGrantActive } from '../grantMatch';
import { narrowestRung } from '../policy';
import { ceilingForShare } from '../searchCeiling';
import type { AskQuery, DisclosureRung } from '../types';

import { AskAuditService } from './AskAuditService';

/** The resource kind a share grant names. Mirrors the `ask_grants_resource_type_chk`. */
export const SAVED_SEARCH_RESOURCE = 'saved_search';

/** The `queryType` a share disclosure is audited under. Not an ask archetype — see {@link shareAuditQuery}. */
export const SHARE_QUERY_TYPE = 'saved_search';

/** What a reader is allowed to receive from one shared saved search, right now. */
export interface ShareAuthorization {
  /**
   * The grant that authorizes this read, or null when the reader IS the owner
   * (who needs no grant to read their own memory).
   */
  grantId: string | null;
  /** The ceiling to clamp the result set to; `undefined` = no source declares one. */
  ceiling: DisclosureRung | undefined;
}

/**
 * Consent for reading a SHARED SAVED SEARCH — the share link, brought under the
 * same consent layer as asks.
 *
 * ═══ WHY A SHARE MINTS A GRANT ═══
 *
 * `saved_searches.share_token` is a bearer capability: holding the string is the
 * whole of the authorization. That makes four things impossible, and all four
 * are things the ask path next door already does.
 *
 *   1. The owner cannot see WHO read their memory. Every holder of the link is
 *      the same anonymous principal.
 *   2. The owner cannot revoke ONE reader. `setSharing(false)` cuts off
 *      everyone, and rotating the token re-invites nobody.
 *   3. There is no ceiling. A shared search disclosed full result nodes or
 *      nothing; "you may see how many, not which" was inexpressible.
 *   4. Nothing is written down. `ci.ask_audit` is the owner's Disclosure
 *      History, and share reads were the one disclosure surface absent from it.
 *
 * So the token keeps the job it is good at — travelling in a URL — and is
 * exchanged, on first use by a signed-in reader, for a standing
 * `ci.ask_grants` row naming that reader and that saved search. That row is the
 * owner-visible, individually revocable handle the token could never be; it is
 * the same object the Grant Manager already lists and revokes.
 *
 * ═══ THE CEILING IS STAMPED WHEN THE GRANT IS MINTED ═══
 *
 * ...and then combined with the share's LIVE ceiling by
 * {@link narrowestRung}, never replaced by it. This is the rule
 * `20260821010000_add_ask_disclosure_ceiling` exists to enforce on the ask path,
 * and the bug it was written for is available here too: read the live share
 * ceiling alone and an owner who UNSHARES mid-session (`share_max_disclosure`
 * goes away with the row's posture) would have the reader's answer GROW. A
 * later change to the share can only ever tighten what a reader already holds.
 *
 * ═══ REVOCATION IS A STANDING DENIAL, NOT A GAP ═══
 *
 * See {@link authorize}. A grant revoked by the owner blocks that reader until
 * the owner says otherwise; it does not merely leave a hole for the next read
 * to mint a fresh grant into.
 *
 * CI-Server #1711 -> epic #1712.
 */
@Injectable()
export class SharedSearchConsentService {
  constructor(
    @InjectRepository(AskGrantEntity)
    private readonly grantRepository: Repository<AskGrantEntity>,
    private readonly auditService: AskAuditService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(SharedSearchConsentService.name);
  }

  /**
   * Decide whether `viewerUserId` may read `savedSearchId`, minting the standing
   * grant on first use.
   *
   * Returns `null` for a refusal, and the caller renders that as the SAME empty
   * result an unknown or revoked token produces. That is deliberate and matches
   * `PEER_ASK_PENDING`: distinguishing "the owner revoked you specifically" from
   * "this link does not exist" tells a reader something about the owner's
   * posture that they did not need to know in order to be refused.
   */
  async authorize(params: {
    ownerUserId: string;
    viewerUserId: string;
    savedSearchId: string;
    /** The share's declared ceiling, raw from the column. */
    declaredCeiling: unknown;
    /** The share's scheduled lapse, stamped onto a freshly minted grant. */
    shareExpiresAt?: Date | null;
    now?: Date;
  }): Promise<ShareAuthorization | null> {
    const now = params.now ?? new Date();
    const liveCeiling = ceilingForShare(params.declaredCeiling);

    // The owner reading their own shared search is not a disclosure. No grant is
    // minted, no ceiling applies, and nothing is audited — auditing it would
    // fill the owner's Disclosure History with their own previews.
    if (params.ownerUserId === params.viewerUserId) {
      return { grantId: null, ceiling: undefined };
    }

    const existing = await this.grantsFor(params.ownerUserId, params.viewerUserId, params.savedSearchId);

    // A grant the OWNER withdrew is a standing denial. Without this the revoke
    // is cosmetic: the row stops being active, `live` finds nothing, and the
    // next read mints a replacement — so "revoke Dana" would last exactly until
    // Dana refreshed. `superseded` is excluded on purpose; that reason marks a
    // row replaced by `GrantService.supersede`, which leaves a live successor.
    if (existing.some((grant) => grant.revocationReason === 'revoked')) {
      return null;
    }

    const live = existing.find((grant) => isGrantActive(grant, now));
    if (live) {
      return {
        grantId: live.id,
        // Stamped ∧ live. Neither source can erase the other; see the class note.
        ceiling: narrowestRung(ceilingForShare(live.scope?.maxDisclosure), liveCeiling),
      };
    }

    // A grant that LAPSED (expiresAt passed) is not a denial — the share simply
    // ran out for this reader. If the share itself is still live they get a new
    // one, which is the same reading `isGrantActive` gives an expired grant.
    const minted = await this.mint({
      ownerUserId: params.ownerUserId,
      viewerUserId: params.viewerUserId,
      savedSearchId: params.savedSearchId,
      ceiling: liveCeiling,
      expiresAt: params.shareExpiresAt ?? null,
      now,
    });

    return minted;
  }

  /**
   * Write the disclosure to the owner's Disclosure History.
   *
   * One row per READ, not per reader and not per session. A share is a standing
   * authorization, so "Dana still has access" is a fact about the grant; what
   * the audit is for is the other half — that the access was USED, when, and how
   * much crossed. That is UMA's promised-versus-touched distinction, and an
   * aggregate ("14 reads, 213 items, most recently yesterday") is a query over
   * these rows rather than a reason not to write them.
   *
   * Skipped entirely for the owner's own reads (`grantId == null`).
   */
  async recordRead(params: {
    ownerUserId: string;
    viewerUserId: string;
    savedSearchId: string;
    savedSearchName?: string | null;
    grantId: string | null;
    /** Entity ids that actually crossed to the reader, post-ceiling. */
    disclosedEntityIds: readonly string[];
    /** Ids the read was computed over, pre-ceiling. Owner-visible only. */
    backingEntityIds: readonly string[];
  }): Promise<void> {
    if (params.grantId == null) {
      return;
    }

    await this.auditService.record({
      // A share read has no `ci.asks` row and deliberately does not create one:
      // that table models a REQUEST awaiting a decision, and a pre-authorized
      // read has no lifecycle to model. The audit is the durable disclosure
      // record and stands on its own — `ask_id` has been nullable since the
      // column was written.
      askId: null,
      askerUserId: params.viewerUserId,
      responderUserId: params.ownerUserId,
      query: shareAuditQuery(params.savedSearchId, params.savedSearchName),
      consentBasis: params.grantId,
      // `auto_answered` rather than `answered`: no human was in the loop for
      // this read, which is exactly what a standing grant means.
      outcome: 'auto_answered',
      disclosedEntities: [...params.disclosedEntityIds],
      disclosedCount: params.disclosedEntityIds.length,
      backingEntities: [...params.backingEntityIds],
    });
  }

  /** Live and revoked grants for one (owner, reader, saved search), newest first. */
  private async grantsFor(
    ownerUserId: string,
    viewerUserId: string,
    savedSearchId: string,
  ): Promise<AskGrantEntity[]> {
    return this.grantRepository.find({
      where: {
        ownerUserId,
        granteeUserId: viewerUserId,
        resourceType: SAVED_SEARCH_RESOURCE,
        resourceId: savedSearchId,
      },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Mint the standing grant, tolerating the race.
   *
   * Two concurrent first-reads of the same link both find nothing and both
   * insert. `ask_grants_live_resource_grantee_uniq` is what makes exactly one of
   * them win — the loser re-reads and uses the winner's row, so the two readers
   * share one grant rather than one silently acquiring a second, invisible one
   * the owner would have to revoke twice.
   */
  private async mint(params: {
    ownerUserId: string;
    viewerUserId: string;
    savedSearchId: string;
    ceiling: DisclosureRung | undefined;
    expiresAt: Date | null;
    now: Date;
  }): Promise<ShareAuthorization> {
    const record = this.grantRepository.create({
      id: uuidv7(),
      ownerUserId: params.ownerUserId,
      granteeUserId: params.viewerUserId,
      granteePeerLinkId: null,
      resourceType: SAVED_SEARCH_RESOURCE,
      resourceId: params.savedSearchId,
      // The grant vocabulary still wants a query type; a share is its own kind
      // of question and gets its own word rather than borrowing an archetype.
      queryType: SHARE_QUERY_TYPE,
      dataClass: null,
      scope: params.ceiling != null ? { maxDisclosure: params.ceiling } : null,
      // `auto`: the owner already consented by publishing the link. A share that
      // asks the owner per-reader is a different product decision and a
      // different PR — see the `review`-mode follow-up in the PR description.
      mode: 'auto',
      purpose: null,
      revokedAt: null,
      expiresAt: params.expiresAt,
      revocationReason: null,
      version: 1,
      supersedesGrantId: null,
    });

    try {
      const saved = await this.grantRepository.save(record);

      return { grantId: saved.id, ceiling: params.ceiling };
    } catch (error) {
      const winner = (
        await this.grantsFor(params.ownerUserId, params.viewerUserId, params.savedSearchId)
      ).find((grant) => isGrantActive(grant, params.now));

      if (!winner) {
        throw error;
      }

      this.logger.debug(`share grant race resolved to ${winner.id}`);

      return {
        grantId: winner.id,
        ceiling: narrowestRung(ceilingForShare(winner.scope?.maxDisclosure), params.ceiling),
      };
    }
  }
}

/**
 * The audited replay of a share read.
 *
 * `queryType` is {@link SHARE_QUERY_TYPE}, which is NOT one of `ASK_ARCHETYPES`.
 * That is intentional and is the point of the field here: a Disclosure History
 * row for a share must not read as though somebody asked the owner a question.
 * `filters` carries the resource so the row can be grouped by share without
 * joining the grant.
 */
export function shareAuditQuery(savedSearchId: string, savedSearchName?: string | null): AskQuery {
  return {
    queryType: SHARE_QUERY_TYPE,
    prompt: savedSearchName?.trim() || 'A shared saved search',
    filters: { resourceType: SAVED_SEARCH_RESOURCE, resourceId: savedSearchId },
  };
}
