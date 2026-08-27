import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { UserEntity } from '@ci/domains/user';

import { defaultAskExpiry } from '../askDeadline';
import { assertAskTransition } from '../askStatus';
import { type AskAnswer } from '../entities/AskAnswerEntity';
import { type Ask, AskEntity } from '../entities/AskEntity';
import { narrowestRung } from '../policy';
import type { AskStatus, CreateAskDto, DisclosedAnswer, DisclosureRung, GrantDecision } from '../types';

import { AskAnswerService } from './AskAnswerService';
import { AskAuditService } from './AskAuditService';
import { GrantService } from './GrantService';

/**
 * The single failure a caller gets for an unroutable responder.
 *
 * "You cannot ask yourself" and "no such user" MUST be indistinguishable. They
 * used to differ badly: a self-ask raised this, while an unknown id fell through
 * to the `asks_responder_user_id_fkey` violation from Postgres — a 500 carrying
 * the constraint name. That turns `createAsk` into an account-enumeration
 * oracle usable by any signed-in user against arbitrary ids.
 */
const UNROUTABLE_RESPONDER = 'An ask must be directed at another user';

/**
 * What a lifecycle move may stamp alongside the new status.
 *
 * Both fields distinguish `undefined` ("leave it as it is") from `null`
 * ("clear it"), which is the whole reason they are not plain optionals with a
 * default — a transition that silently reset a consent stamp it was not asked
 * to touch is a consent bug, not a typing nicety.
 */
interface TransitionOptions {
  consentBasis?: string | null;
  disclosureCeiling?: DisclosureRung | null;
}

/**
 * Who a FEDERATED outcome happened with, for the audit row.
 *
 * ═══ THE REVIEW PATH USED TO LOSE THE PEER ═══
 *
 * Every terminal outcome this service records was built FROM THE ASK ALONE, and
 * `ci.asks` carries a peer LINK ID but not a handle. `PeerAskService` writes its
 * own audit row for the auto path and stamps both, so a standing grant that
 * auto-answered a peer was attributable — while the ask the OWNER PERSONALLY
 * APPROVED came through `completeWithAnswer` and landed with `peer_handle` NULL.
 * The one disclosure a human looked at and said yes to was the one their history
 * could not pin on anybody. `PeerAskService.persistDisclosure`'s docstring names
 * teaching `complete` to carry this as the follow-up; this is it.
 *
 * Only the HANDLE travels. The link id is read off the ask row instead, for the
 * same reason `consentBasis` is: `ci.asks.peer_link_id` IS the record of which
 * peer an ask belongs to, and a separately threaded copy is one more chance for
 * the two to name different peers for the same disclosure. The handle cannot
 * come from there — it lives in the peers domain (which depends on asks, not the
 * reverse) and is denormalized into the audit AS OF disclosure time, so a later
 * rename or re-link cannot rewrite history.
 */
interface PeerAttribution {
  /** The peer's handle when the disclosure happened. */
  peerHandle?: string | null;
}

/**
 * Owns the {@link AskEntity} lifecycle and the submit orchestration that ties
 * the ask, the consent grants, and the audit log together.
 *
 * Phase 0 delivery is intra-Hub and synchronous, so a created ask is immediately
 * marked `delivered`; {@link submit} then evaluates the responder's standing
 * grants and routes the ask (auto-answer / owner review / auto-deny). Every
 * transition is validated against the pure state machine
 * ({@link assertAskTransition}) so no illegal edge is ever persisted.
 *
 * NOTE: this service decides WHETHER an ask may be answered and records that it
 * was; it does not PRODUCE the answer. The run-as-owner executor and the
 * disclosure filter live in `AskResolver.disclose`, which both entry points —
 * the owner's `runAsk` and the standing-grant auto path in `createAsk` — call
 * before handing the finished disclosure back here through
 * {@link completeWithAnswer}. The `deny` (block) and owner-`decline` paths are
 * fully terminal here and are audited.
 */
@Injectable()
export class AskService {
  constructor(
    @InjectRepository(AskEntity)
    private readonly askRepository: Repository<AskEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    private readonly grantService: GrantService,
    private readonly auditService: AskAuditService,
    private readonly answerService: AskAnswerService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(AskService.name);
  }

  /** Create an ask (asker = caller) and mark it delivered to the responder. */
  async create(context: UserServiceContext, data: CreateAskDto): Promise<Ask> {
    const direction = data.direction ?? 'local';
    const isInbound = direction === 'inbound';

    if (isInbound && !data.peerLinkId) {
      throw new BadRequestException('An inbound ask must carry its peer link');
    }

    // A local ask must be directed at someone else, and at someone who exists.
    // An inbound peer ask has no local asker at all, so the self-ask guard does
    // not apply to it — but its responder is the link owner, which we already
    // resolved from a live link.
    //
    // Both failures raise the IDENTICAL message (see {@link UNROUTABLE_RESPONDER}).
    // Checking existence here rather than letting the FK fire is the point: the
    // constraint violation names the responder column, which answers "does this
    // account exist?" for any id the caller cares to try.
    //
    // An OUTBOUND ask carries a null responder (the responder is the peer named
    // by the link), so there is no local account to look up and nothing to
    // enumerate.
    if (!isInbound) {
      const unroutable =
        data.responderUserId === context.userId ||
        (data.responderUserId != null && !(await this.userExists(data.responderUserId)));
      if (unroutable) {
        throw new BadRequestException(UNROUTABLE_RESPONDER);
      }
    }

    const record = this.askRepository.create({
      id: data.id ?? uuidv7(),
      askerUserId: isInbound ? null : context.userId,
      peerLinkId: data.peerLinkId ?? null,
      direction,
      responderUserId: data.responderUserId,
      query: data.query,
      status: assertAskTransition('sent', 'delivered'),
      consentBasis: null,
      // EVERY ask gets a deadline. `data.expiresAt ?? null` is what this used to
      // be, and no caller anywhere passed the field — so the column was NULL on
      // every row, the expiry sweep's `expires_at < now()` matched nothing, and
      // an ask the owner approved but never answered stayed answerable forever
      // (see {@link defaultAskExpiry} for why that is an authorization, not an
      // untidy row).
      //
      // A nullish value takes the default rather than meaning "no deadline":
      // the two readings are indistinguishable at this boundary — an omitted
      // field and an explicit `null` arrive identically from GraphQL — and only
      // one of them is safe. A caller that genuinely wants a different deadline
      // passes a Date.
      expiresAt: data.expiresAt ?? defaultAskExpiry(),
      // Channel provenance travels as one unit or not at all, matching
      // `asks_channel_paired_chk`. A partially-populated channel would claim a
      // verification nobody performed.
      channelKeyThumbprint: data.channel?.keyThumbprint ?? null,
      channelVerifiedAt: data.channel?.verifiedAt ?? null,
      channelCovered: data.channel?.covered ?? null,
    });

    const entity = await this.askRepository.save(record);

    return AskEntity.toEgressType(entity);
  }

  /**
   * Create an ask and apply the standing-grant decision:
   * - `deny` (a matching `block` grant) → immediately declined + audited;
   * - `auto` (a matching `auto` grant) → left `delivered` with the grant recorded
   *   as the consent basis AND the ceiling that grant imposed at that moment,
   *   which is the shape `isAnswerable` reads as "answerable without review".
   *   The caller answers it: `AskResolver.createAsk` runs the shared disclosure
   *   pipeline on an `auto` decision, so the owner's standing "yes, always" is
   *   honoured here the way it already was on the federated path. Returning the
   *   decision is what makes that possible — it is the only thing that
   *   distinguishes a pre-authorized ask from one waiting on a human;
   * - `review` (no matching grant, or a `review` grant) → moved to the owner's
   *   review inbox (`under_review`).
   *
   * Returns the resulting ask and the decision so the caller can surface it.
   */
  async submit(
    context: UserServiceContext,
    data: CreateAskDto,
  ): Promise<{ ask: Ask; decision: GrantDecision }> {
    const ask = await this.create(context, data);
    const evaluation = await this.grantService.evaluate(ask);

    if (evaluation.decision === 'deny') {
      const declined = await this.systemTransition(ask.id, 'declined', {
        consentBasis: evaluation.grantId ?? null,
      });
      await this.auditService.record({
        askId: ask.id,
        askerUserId: ask.askerUserId,
        responderUserId: ask.responderUserId,
        query: ask.query,
        consentBasis: evaluation.grantId ?? null,
        outcome: 'declined',
      });

      return { ask: declined, decision: 'deny' };
    }

    if (evaluation.decision === 'auto') {
      // The ceiling is stamped WITH the basis, at the instant consent applies.
      // Re-deriving it at answer time is how revoking a grant used to make the
      // answer bigger — see {@link AskEntity.disclosureCeiling}.
      const preAuthorized = await this.setConsentBasis(
        ask.id,
        evaluation.grantId ?? null,
        evaluation.maxDisclosure ?? null,
      );

      return { ask: preAuthorized, decision: 'auto' };
    }

    const inboxed = await this.systemTransition(ask.id, 'under_review');

    return { ask: inboxed, decision: 'review' };
  }

  /**
   * Owner approves a pending ask → `answering` (the executor completes it).
   *
   * CONSENT IS GIVEN HERE, so the disclosure ceiling is captured here. The
   * answer path used to re-derive it from the live grants instead, which meant
   * revoking (or outliving) the grant that capped this ask REMOVED the cap
   * while leaving the ask answerable — the owner's `answering` decision is
   * deliberately not undone by revocation (#2211), so the ask ran on with only
   * the tier ceiling and disclosed MORE than it would have before the owner
   * withdrew anything.
   *
   * A `deny` at approval time stamps `none`: if a block grant covers this ask
   * now, the owner's tap must not be able to push anything past it. Everything
   * else stamps the deciding grant's own `maxDisclosure`, or NULL when no grant
   * capped it at all — see {@link AskEntity.disclosureCeiling} for why NULL is
   * a value and not a gap.
   *
   * Any ceiling ALREADY stamped on the ask survives as a floor
   * ({@link narrowestRung}), and that is the case that closes the loop:
   * `withdrawPreAuthorization` sends a revoked ask back to review with its
   * basis cleared but its ceiling intact, so approving it afterwards cannot
   * disclose more than it would have before the owner revoked anything. An
   * owner who genuinely means to widen does it by writing a new grant and
   * letting the asker ask again — never as a side effect of withdrawing one.
   */
  async approve(context: UserServiceContext, id: string): Promise<Ask> {
    const entity = await this.responderOwned(context, id);
    const evaluation = await this.grantService.evaluate(AskEntity.toEgressType(entity));
    const evaluated = evaluation.decision === 'deny' ? 'none' : evaluation.maxDisclosure;
    const ceiling = narrowestRung(entity.disclosureCeiling, evaluated) ?? null;

    return this.applyTransition(entity, 'answering', { disclosureCeiling: ceiling });
  }

  /**
   * Owner declines a pending ask → `declined`, and records the audit row.
   *
   * `peer` attributes the refusal when the ask came from a linked peer; see
   * {@link PeerAttribution} for why the handle has to be handed in and the link
   * id does not.
   */
  async decline(context: UserServiceContext, id: string, peer: PeerAttribution = {}): Promise<Ask> {
    const declined = await this.transition(context, id, 'declined');
    await this.auditService.record({
      askId: declined.id,
      askerUserId: declined.askerUserId,
      ...attributeToPeer(declined, peer),
      responderUserId: declined.responderUserId,
      query: declined.query,
      consentBasis: declined.consentBasis,
      outcome: 'declined',
    });

    return declined;
  }

  /**
   * Persist a disclosure and finalize its ask ATOMICALLY.
   *
   * The answer row and the audit row are one disclosure recorded twice; written
   * on separate connections they could disagree permanently. A crash between
   * them left an answer the asker could read with no audit row saying it
   * happened — and NOT a transient state: `AskAnswerService.create` is
   * insert-only, so the retry raises a conflict instead of writing the missing
   * audit. One transaction is what makes the two halves inseparable.
   *
   * The lifecycle gate still lives in {@link complete}, which runs INSIDE the
   * transaction — a refusal there rolls the answer back rather than leaving it
   * behind.
   *
   * `disclosure.peerHandle` is what makes this usable for a FEDERATED
   * disclosure; see {@link PeerAttribution}.
   */
  async completeWithAnswer(
    context: UserServiceContext,
    id: string,
    disclosure: {
      answer: DisclosedAnswer;
      /** References that actually crossed to the asker. */
      disclosedEntityIds: string[];
      /** Entities the answer was computed over (post-redaction, pre-ceiling). */
      backingEntityIds: string[];
      /** The peer this answer crossed to, when the ask is federated. */
      peerHandle?: string | null;
    },
  ): Promise<{ ask: Ask; answer: AskAnswer }> {
    return this.dataSource.transaction(async (manager) => {
      const answer = await this.answerService.create({ askId: id, answer: disclosure.answer }, manager);
      const ask = await this.complete(context, id, disclosure.disclosedEntityIds, {
        backingEntityIds: disclosure.backingEntityIds,
        // The MAGNITUDE has to travel separately from the references. Only the
        // `retrieval` form itemizes, so `disclosedEntityIds` is empty for a
        // `count` or `boolean` answer that nonetheless handed the asker a real
        // number — and the audit, deriving from the ids alone, recorded that as
        // an empty disclosure.
        disclosedCount: disclosure.answer.disclosedCount,
        peerHandle: disclosure.peerHandle,
        manager,
      });

      return { ask, answer };
    });
  }

  /**
   * Finalize an answerable ask (owner-approved `answering`, or auto-authorized
   * `delivered` with a consent basis) into `answered`, recording the terminal
   * audit. Responder-scoped. An auto-authorized ask is first advanced
   * `delivered → answering` so the lifecycle is honored.
   *
   * `disclosedEntityIds` is what the ASKER received — for every form but
   * `retrieval` that is empty, because those answers itemize nothing.
   * `options.backingEntityIds` is the owner-only record of what the answer was
   * computed over; the two are separate fields precisely so the audit stops
   * claiming the candidate set was disclosed.
   *
   * `options.disclosedCount` is the MAGNITUDE that crossed, which for every
   * non-itemizing form is the only thing that did. Omitted, the audit falls
   * back to `disclosedEntityIds.length` — right for `retrieval`, and right for
   * the callers here that disclose nothing at all.
   *
   * `options.peerHandle` names the peer a FEDERATED disclosure crossed to; see
   * {@link PeerAttribution}.
   */
  async complete(
    context: UserServiceContext,
    id: string,
    disclosedEntityIds: string[],
    options: {
      backingEntityIds?: string[];
      disclosedCount?: number;
      peerHandle?: string | null;
      manager?: EntityManager;
    } = {},
  ): Promise<Ask> {
    const entity = await this.responderOwned(context, id, options.manager);

    const isAuto = entity.status === 'delivered' && entity.consentBasis != null;
    if (entity.status !== 'answering' && !isAuto) {
      throw new BadRequestException(`Ask ${id} is not ready to answer (status: ${entity.status})`);
    }

    // The consent basis was stamped at SUBMIT time and says nothing about now.
    // Re-check the standing grant at ANSWER time, or a grant the owner revoked
    // (or that lapsed) an hour ago still authorizes this disclosure.
    //
    // Scoped to the auto path on purpose: an ask in `answering` was approved by
    // the owner for that specific ask, and that human decision is not undone by
    // withdrawing an unrelated standing grant. Revocation of a STANDING
    // pre-authorization is the thing that has to be retroactive.
    if (isAuto && !(await this.grantService.isConsentStanding(AskEntity.toEgressType(entity)))) {
      throw new BadRequestException(
        `Ask ${id} was pre-authorized by a grant that is no longer in force; it needs owner review`,
      );
    }

    if (entity.status === 'delivered') {
      entity.status = assertAskTransition(entity.status, 'answering');
    }

    entity.status = assertAskTransition(entity.status, 'answered');
    const saved = await this.asks(options.manager).save(entity);

    await this.auditService.record(
      {
        askId: saved.id,
        askerUserId: saved.askerUserId,
        ...attributeToPeer(saved, { peerHandle: options.peerHandle }),
        responderUserId: saved.responderUserId,
        query: saved.query,
        consentBasis: saved.consentBasis,
        outcome: isAuto ? 'auto_answered' : 'answered',
        disclosedEntities: disclosedEntityIds,
        disclosedCount: options.disclosedCount,
        backingEntities: options.backingEntityIds ?? [],
      },
      options.manager,
    );

    return AskEntity.toEgressType(saved);
  }

  /** An ask is visible to its asker and its responder only. */
  async findById(context: UserServiceContext, id: string): Promise<Ask | null> {
    const entity = await this.forParticipant(context, id);

    return entity ? AskEntity.toEgressType(entity) : null;
  }

  /** The responder's review inbox: asks awaiting a decision, newest first. */
  async listInbox(context: UserServiceContext): Promise<Ask[]> {
    const rows = await this.askRepository.find({
      where: [
        { responderUserId: context.userId, status: 'delivered' },
        { responderUserId: context.userId, status: 'under_review' },
      ],
      order: { createdAt: 'DESC' },
    });

    return rows.map(AskEntity.toEgressType);
  }

  /** The asker's outbox: asks I have sent, newest first. */
  async listOutbox(context: UserServiceContext): Promise<Ask[]> {
    const rows = await this.askRepository.find({
      where: { askerUserId: context.userId },
      order: { createdAt: 'DESC' },
    });

    return rows.map(AskEntity.toEgressType);
  }

  /**
   * Move an ask along the lifecycle as the RESPONDER. Only the responder may
   * drive review-side transitions; the transition is rejected unless the pure
   * state machine permits it.
   */
  async transition(
    context: UserServiceContext,
    id: string,
    to: AskStatus,
    options: TransitionOptions = {},
  ): Promise<Ask> {
    const entity = await this.responderOwned(context, id);

    return this.applyTransition(entity, to, options);
  }

  /**
   * System-initiated transition (auto-decision / expiry sweep), NOT owner-scoped.
   * Callers must ensure the action is genuinely system-initiated — it is only
   * used internally by {@link submit} and the expiry sweep, never from a request
   * handler on behalf of a user.
   */
  async systemTransition(id: string, to: AskStatus, options: TransitionOptions = {}): Promise<Ask> {
    const entity = await this.byId(id);

    return this.applyTransition(entity, to, options);
  }

  /**
   * Stamp the standing-grant authorization on an ask without changing its
   * status (system-only): the deciding grant AND the ceiling that grant imposed
   * at that moment.
   *
   * The two are written together on purpose. A basis with no ceiling is exactly
   * the shape the answer path had to reconstruct from live grants, and
   * reconstructing it is what let a revocation widen the answer.
   */
  async setConsentBasis(
    id: string,
    consentBasis: string | null,
    disclosureCeiling: DisclosureRung | null = null,
  ): Promise<Ask> {
    const entity = await this.byId(id);
    entity.consentBasis = consentBasis;
    entity.disclosureCeiling = disclosureCeiling;
    const saved = await this.askRepository.save(entity);

    return AskEntity.toEgressType(saved);
  }

  private async applyTransition(entity: AskEntity, to: AskStatus, options: TransitionOptions): Promise<Ask> {
    entity.status = assertAskTransition(entity.status, to);
    if (options.consentBasis !== undefined) {
      entity.consentBasis = options.consentBasis;
    }

    // `undefined` leaves the stamped ceiling alone; an explicit `null` clears
    // it. `withdrawPreAuthorization` deliberately passes NEITHER: a revoked ask
    // loses its consent basis (which is what makes it unanswerable) and KEEPS
    // its ceiling, so the value survives as a floor for whatever the owner
    // decides next. See {@link approve}.
    if (options.disclosureCeiling !== undefined) {
      entity.disclosureCeiling = options.disclosureCeiling;
    }

    const saved = await this.askRepository.save(entity);

    return AskEntity.toEgressType(saved);
  }

  private async forParticipant(context: UserServiceContext, id: string): Promise<AskEntity | null> {
    return this.askRepository.findOne({
      where: [
        { id, askerUserId: context.userId },
        { id, responderUserId: context.userId },
      ],
    });
  }

  private async responderOwned(
    context: UserServiceContext,
    id: string,
    manager?: EntityManager,
  ): Promise<AskEntity> {
    const entity = await this.asks(manager).findOne({
      where: { id, responderUserId: context.userId },
    });
    if (entity == null) {
      throw new NotFoundException(`Ask ${id} not found`);
    }

    return entity;
  }

  /** The transaction's ask repository when one is supplied, otherwise the injected one. */
  private asks(manager?: EntityManager): Repository<AskEntity> {
    return manager ? manager.getRepository(AskEntity) : this.askRepository;
  }

  /**
   * Does this local account exist? A bare existence probe — never surfaced to
   * the caller as its own outcome (see {@link UNROUTABLE_RESPONDER}).
   */
  private async userExists(userId: string): Promise<boolean> {
    return (await this.userRepository.countBy({ id: userId })) > 0;
  }

  private async byId(id: string): Promise<AskEntity> {
    const entity = await this.askRepository.findOne({ where: { id } });
    if (entity == null) {
      throw new NotFoundException(`Ask ${id} not found`);
    }

    return entity;
  }
}

/**
 * The peer fields for an audit row, derived from the ask plus the caller's
 * {@link PeerAttribution}.
 *
 * The link id comes from the ROW, and the handle is honoured ONLY when that row
 * really carries a link — so a caller cannot pin a purely local disclosure on a
 * peer by passing a handle, and a federated one is attributable by id even if
 * the handle could not be resolved (a peer link deleted between the answer and
 * the audit still leaves the id the history was written under).
 *
 * Pure.
 */
function attributeToPeer(
  ask: Pick<AskEntity, 'peerLinkId'>,
  peer: PeerAttribution,
): { peerLinkId: string | null; peerHandle: string | null } {
  const peerLinkId = ask.peerLinkId ?? null;

  return { peerLinkId, peerHandle: peerLinkId == null ? null : (peer.peerHandle ?? null) };
}
