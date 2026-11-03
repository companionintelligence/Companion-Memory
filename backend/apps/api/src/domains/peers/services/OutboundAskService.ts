import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';
import {
  type Ask,
  AskAnswerService,
  AskAuditService,
  AskEntity,
  AskService,
  assertAskTransition,
  type AnswerForm,
  type DisclosedAnswer,
} from '@ci/domains/asks';

import { type PeerLink } from '../entities/PeerLinkEntity';
import type { AskerVisiblePeerReply, PeerAskBody, PeerAskRequest } from '../protocol';

import { PeerAskClient } from './PeerAskClient';
import { PeerAskCorrelationService, requestDigest } from './PeerAskCorrelationService';
import { PeerLinkService } from './PeerLinkService';
import { PeerSignatureService } from './PeerSignatureService';

export interface SendAskDto {
  /** Portal handle of the peer to ask. */
  handle: string;
  prompt: string;
  request: PeerAskRequest;
}

export interface SendAskResult {
  ask: Ask;
  /**
   * What this box is allowed to know about the peer's reply — `answered` or
   * `delivered`, never the responder's consent posture. See
   * {@link AskerVisiblePeerReply}.
   */
  response: AskerVisiblePeerReply;
}

/**
 * The OUTBOUND half of a federated ask: composing a question, sending it to a
 * peer's Companion, collecting the answer, and recording what came back.
 *
 * This is the counterpart to {@link PeerAskService} (inbound). Keeping them
 * separate matters: the inbound path treats the ask as hostile and the local
 * owner as authoritative, while this path treats the local user as authoritative
 * and the PEER'S RESPONSE as untrusted. Conflating them would blur which side of
 * the boundary each piece of data came from.
 *
 * The local `Ask` row is written before the request leaves, so an outbound ask
 * is auditable even when the peer never answers — a peer that goes silent still
 * leaves a record that this box asked.
 *
 * ═══ THE ANSWER USED TO GO NOWHERE ═══
 *
 * `send` recorded an audit row and dropped the answer on the floor. Nothing
 * wrote `ci.ask_answers`, nothing moved the local ask off `delivered`, and the
 * only copy of what the peer said lived in the transient return value. So even
 * an ask the peer AUTO-answered left this box with no readable answer, and one
 * a human approved could not be collected at all — the synchronous reply was
 * the only channel that existed. Both halves are here now: {@link absorb}
 * persists an answer whenever one arrives, and {@link pollForAnswer} goes and
 * gets one that arrived later.
 */
@Injectable()
export class OutboundAskService {
  constructor(
    private readonly peerLinkService: PeerLinkService,
    private readonly askService: AskService,
    private readonly answerService: AskAnswerService,
    private readonly auditService: AskAuditService,
    private readonly correlationService: PeerAskCorrelationService,
    private readonly client: PeerAskClient,
    @InjectRepository(AskEntity)
    private readonly askRepository: Repository<AskEntity>,
    private readonly logger: LoggerService,
    @Optional()
    private readonly signatureService?: PeerSignatureService,
  ) {
    this.logger.setContext(OutboundAskService.name);
  }

  /**
   * Send an ask to a linked peer.
   *
   * `accessToken` must be a Portal-issued token whose audience is the PEER box
   * (the peer verifies that binding on receipt). Until Portal token exchange
   * lands, the caller supplies it; this service never mints or caches one.
   * For sovereign KERI peers, an outbound signature satisfies authentication.
   */
  async send(context: UserServiceContext, dto: SendAskDto, accessToken?: string): Promise<SendAskResult> {
    const link = await this.activeLink(context, dto.handle);

    const effectiveToken = accessToken?.trim() ?? '';
    if (!effectiveToken && !this.signatureService?.hasSigningKey) {
      throw new BadRequestException('A peer access token or signing key is required');
    }

    const ask = await this.askService.create(context, {
      responderUserId: null,
      peerLinkId: link.id,
      direction: 'outbound',
      query: {
        queryType: dto.request.archetype,
        dataClass: dto.request.archetype === 'content' ? dto.request.dataClass : undefined,
        prompt: dto.prompt,
      },
    });

    const body = this.toBody(link, dto);

    // Recorded BEFORE the request leaves. The correlation id is minted here and
    // returned to nobody, so without this row a send that comes back
    // `delivered` — the ONLY outcome a poll exists for — could never be named
    // again, and the answer the peer is about to approve would be as
    // unreachable as it was before the return path existed. Writing it after
    // the fetch would lose exactly the case where the fetch times out and the
    // peer processed the ask anyway.
    await this.correlationService.record({
      peerLinkId: link.id,
      correlationId: body.askId,
      askId: ask.id,
      requestDigest: requestDigest(body),
    });

    const response = await this.client.send(link, body, effectiveToken);

    await this.absorb(ask, link, response);

    return { ask, response };
  }

  /**
   * Collect an answer that arrived after the send returned — the asker's half
   * of the return path.
   *
   * A peer that queues an ask for its owner replies `delivered` and says
   * nothing more; when the owner approves it, the answer exists on THEIR box
   * and no channel used to bring it here. This is that channel. See
   * {@link PeerAskService.result} for why the asker polls rather than the
   * responder calling back.
   *
   * Idempotent, and terminal-safe: an ask already `answered` returns the stored
   * answer without a network call, because `AskAnswerService.create` is
   * insert-only and a second absorb would raise a permanent conflict.
   */
  async pollForAnswer(
    context: UserServiceContext,
    askId: string,
    accessToken?: string,
  ): Promise<SendAskResult> {
    const ask = await this.askService.findById(context, askId);

    if (ask == null || ask.direction !== 'outbound' || ask.askerUserId !== context.userId) {
      // Unknown and not-yours are reported identically — this must not become a
      // way to discover which ask ids exist on this box.
      throw new NotFoundException('No outbound ask with that id');
    }

    const effectiveToken = accessToken?.trim() ?? '';
    if (!effectiveToken && !this.signatureService?.hasSigningKey) {
      throw new BadRequestException('A peer access token or signing key is required');
    }

    if (ask.status === 'answered') {
      const stored = await this.answerService.findByAskId(ask.id);

      return {
        ask,
        response: {
          askId: ask.id,
          status: 'answered',
          answer:
            stored == null
              ? undefined
              : {
                  form: stored.form,
                  summary: stored.summary ?? '',
                  items: stored.disclosedEntities,
                  disclosedCount: stored.disclosedCount,
                  withheldCount: stored.withheldCount,
                },
        },
      };
    }

    const correlation = await this.correlationService.findByAskId(ask.id);

    if (correlation == null || ask.peerLinkId == null) {
      // An outbound ask sent before correlations were recorded. There is no id
      // to name it by on the peer's box, so it can never be collected — say so
      // in the vocabulary the caller already handles rather than inventing a
      // third outcome.
      return { ask, response: { askId: ask.id, status: 'delivered', reason: 'Not collectable' } };
    }

    const link = await this.peerLinkService.findById(context, ask.peerLinkId);

    if (link == null || link.status !== 'active') {
      // Revoking a peer link stops answers coming back as well as going out.
      return { ask, response: { askId: ask.id, status: 'delivered', reason: 'No active peer link' } };
    }

    const response = await this.client.poll(link, correlation.correlationId, effectiveToken);

    await this.absorb(ask, link, response);

    return { ask, response };
  }

  private async activeLink(context: UserServiceContext, handle: string): Promise<PeerLink> {
    const link = await this.peerLinkService.findByHandle(context, handle);

    if (link == null || link.status !== 'active') {
      // Unknown and revoked are reported identically — a caller cannot use this
      // to discover which handles the owner has ever been linked to.
      throw new NotFoundException('No active peer link for that handle');
    }

    return link;
  }

  private toBody(link: PeerLink, dto: SendAskDto): PeerAskBody {
    return {
      // A fresh correlation id per send — never the local row id, which would
      // leak this box's identifiers to the peer.
      askId: uuidv7(),
      askerHandle: config.peers?.handle ?? '',
      prompt: dto.prompt,
      request: dto.request,
    } as PeerAskBody;
  }

  /**
   * Fold the peer's reply into local state.
   *
   * The reply is untrusted (already reduced to the local vocabulary by
   * {@link PeerAskClient}), so only the STATUS drives the local lifecycle —
   * never anything the peer says about what it decided our policy was.
   *
   * ═══ NOTHING IS RECORDED UNTIL SOMETHING IS TERMINAL ═══
   *
   * This used to write an audit row on EVERY send, with `outcome: 'declined'`
   * for anything that was not answered. Two things were wrong with that, and
   * the return path makes both load-bearing:
   *
   *   - the ask itself stayed at `delivered` while its audit row said
   *     `declined`, so the owner's own records contradicted each other about an
   *     exchange that was still in progress;
   *   - an ask that is later collected would then carry TWO audit rows for one
   *     ask, breaking this table's "exactly one row per terminal outcome"
   *     contract and double-counting it in any history built over it.
   *
   * An unanswered outbound ask is not a terminal outcome — it is an ask that
   * can still be collected. It stays open, and if it never is,
   * `AskExpiryService` retires it and writes the `expired` row. The record that
   * this box ASKED is the `ci.asks` row, which is written before the request
   * leaves.
   */
  private async absorb(ask: Ask, link: PeerLink, reply: AskerVisiblePeerReply): Promise<void> {
    if (reply.status !== 'answered' || reply.answer == null) {
      return;
    }

    const answer = toStoredAnswer(reply.answer);

    // The same atomicity `AskService.completeWithAnswer` gives the local path,
    // for the same reason: `AskAnswerService.create` is insert-only, so a
    // failure between the answer insert and the audit insert is PERMANENT — the
    // retry raises a conflict instead of writing the missing audit row.
    await this.askRepository.manager.transaction(async (manager) => {
      await this.answerService.create({ askId: ask.id, answer, answerSource: 'peer' }, manager);
      await this.terminalize(manager, ask);
      await this.auditService.record(
        {
          askId: ask.id,
          askerUserId: ask.askerUserId,
          // ═══ STILL WRITE-ONLY, AND STILL THE RIGHT VALUE ═══
          //
          // NULL because the responder is the peer, not a local user. The only
          // reader of `ci.ask_audit` is `listForResponder`, which selects
          // `responder_user_id = <caller>`, so no outbound row can ever match.
          // The fix is a reader (`listForAsker` + a `myOutboundAskHistory`
          // query in `domains/asks` / `domains/graphql`), not a different value
          // here: writing the local caller in to make the row visible would
          // claim this box answered its own outbound ask, and the disclosure
          // history would then list asks we SENT among the ones we ANSWERED.
          responderUserId: null,
          peerLinkId: link.id,
          // Denormalized at send time, exactly as the inbound path does it: the
          // link can be revoked or re-pointed later, and a history row that can
          // only say "link-1" is not a history of anything a person can read.
          peerHandle: link.peerHandle,
          query: ask.query,
          // The RESPONDER's grant id is theirs, and it never crosses the wire —
          // handing it to an asker is the grant-matrix oracle #2210 closed.
          consentBasis: null,
          outcome: 'answered',
          // An outbound ask discloses nothing OF OURS; the entities in the reply
          // are the PEER's, and recording them here would imply we hold them.
          // Which is also why the count is 0 rather than the peer's number:
          // this table is a record of what THIS box disclosed.
          disclosedEntities: [],
          disclosedCount: 0,
        },
        manager,
      );
    });
  }

  /**
   * Drive an outbound ask to `answered` inside the caller's transaction.
   *
   * `delivered → answered` is not a legal edge, so this takes the same two hops
   * the local and inbound paths take, through the shared state machine rather
   * than assigning the status directly.
   *
   * Scoped by ASKER, not responder: an outbound ask carries a null responder
   * (the responder is the peer named by the link), so the local asker is the
   * only participant who can own it. This is why `AskService.complete` cannot
   * be reused here — it is `responderOwned` by construction and would find
   * nothing.
   *
   * Reading the row back inside the transaction rather than trusting the
   * in-memory `ask` is what makes the edge assertion mean something: the row is
   * the only thing that knows whether something else moved this ask while the
   * peer was being polled — two concurrent polls, most obviously.
   */
  private async terminalize(manager: EntityManager, ask: Ask): Promise<void> {
    const repository = manager.getRepository(AskEntity);
    // An outbound ask always has a local asker — `asks_asker_identified_chk`
    // requires one for every direction but `inbound` — so a null here is a
    // corrupted row, not a case to scope around. Refusing rather than dropping
    // the asker predicate is what keeps this from terminalizing SOMEONE ELSE'S
    // ask that happens to share an id.
    if (ask.askerUserId == null) {
      throw new NotFoundException(`Ask ${ask.id} not found`);
    }

    const entity = await repository.findOne({ where: { id: ask.id, askerUserId: ask.askerUserId } });

    if (entity == null) {
      throw new NotFoundException(`Ask ${ask.id} not found`);
    }

    if (entity.status === 'delivered') {
      entity.status = assertAskTransition(entity.status, 'answering');
    }

    entity.status = assertAskTransition(entity.status, 'answered');

    await repository.save(entity);
  }
}

/**
 * Project a peer's wire answer onto the local answer row.
 *
 * `availability` is a WIRE form, not a storage one — the `ci.ask_answers` CHECK
 * admits the five LOCAL forms only — so it is stored as `attribute` with the
 * summary and no items, exactly as {@link PeerAskService.persistDisclosure}
 * stores the responder's own copy. Recording it under a form the CHECK rejects
 * would fail the whole absorb and lose the answer entirely.
 *
 * PROVENANCE, and its deliberate limit. What is recorded is: `answerSource:
 * 'peer'` (this box did not compute it), the peer link and handle on the audit
 * row (WHO answered), and the peer's own disclosed/withheld split (HOW MUCH was
 * held back). `consentBasis` is NULL and must stay so — it is the responder's
 * grant id, and "was this a standing pre-authorization or a human decision?" is
 * the exact distinction {@link PEER_ASK_PENDING} exists to stop crossing. The
 * honest answer to "under what basis?" from the asker's side is "a peer
 * answered it", and that is what the row says.
 *
 * Pure.
 */
export function toStoredAnswer(answer: NonNullable<AskerVisiblePeerReply['answer']>): DisclosedAnswer {
  return {
    form: (answer.form === 'availability' ? 'attribute' : answer.form) as AnswerForm,
    items: answer.items ?? [],
    disclosedCount: answer.disclosedCount ?? 0,
    withheldCount: answer.withheldCount ?? 0,
    summary: answer.summary,
    consentBasis: null,
  };
}
