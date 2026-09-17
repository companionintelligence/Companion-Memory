import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, EntityManager, IsNull, LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import {
  type Ask,
  type AskAnswer,
  AskAnswerService,
  AskAuditService,
  AskEntity,
  AskExecutorService,
  AskService,
  applyDisclosureCeiling,
  assertAskTransition,
  buildDisclosedAnswer,
  disclosureCeiling,
  minRung,
  GrantService,
  type AskQuery,
  type DisclosedAnswer,
  type DisclosureRung,
  type AskChannelProvenance,
} from '@ci/domains/asks';
import { EventEntity, dropExistingOverrides, expandAll, resolveExpansionZone } from '@ci/domains/memory';

import {
  coarsenFreeBusy,
  computeFreeBusy,
  summarizeAvailability,
  type BusySource,
  type FreeBusy,
} from '../availability';
import { PeerAskCorrelationEntity } from '../entities/PeerAskCorrelationEntity';
import { type PeerLink } from '../entities/PeerLinkEntity';
import { type BusyInterval, type PeerAskBody, type PeerAskResponse, peerAskPending } from '../protocol';

import {
  type CorrelationRepository,
  findCorrelation,
  recordCorrelation,
  requestDigest,
} from './PeerAskCorrelationService';
import { PeerLinkService } from './PeerLinkService';

/**
 * Handles an INBOUND ask from a peer Companion.
 *
 * The pipeline is the one a local ask already runs, with two federation-specific
 * steps in front: attribute the caller to a known peer link, and translate the
 * wire archetype into the local ask vocabulary. Everything after that — consent
 * evaluation, run-as-owner execution, disclosure filtering, audit — is the
 * machinery Phases 0–1 built and tested. Federation adds a transport and an
 * identity, not a second policy engine.
 *
 *   verified (iss,sub) → peer link → ask record → grant eval
 *     → auto ? execute + disclose : queue for the owner's review inbox
 */
@Injectable()
export class PeerAskService {
  constructor(
    private readonly peerLinkService: PeerLinkService,
    private readonly askService: AskService,
    private readonly grantService: GrantService,
    private readonly executorService: AskExecutorService,
    private readonly answerService: AskAnswerService,
    private readonly auditService: AskAuditService,
    @InjectRepository(EventEntity)
    private readonly eventRepository: Repository<EventEntity>,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PeerAskService.name);
  }

  /**
   * Route and process an inbound peer ask. `peerIdentity` comes from a verified
   * Portal token; an unlinked or revoked peer is refused outright.
   */
  async handle(
    peerIdentity: { issuer: string; subject: string },
    body: PeerAskBody,
    /**
     * How the request arrived, when it arrived signed. Null means an unsigned
     * channel — a fact the owner's surfaces state plainly, not an absence.
     */
    channel: AskChannelProvenance | null = null,
  ): Promise<PeerAskResponse> {
    const link = await this.resolveLink(peerIdentity);
    const context: UserServiceContext = { userId: link.ownerUserId };

    // ═══ THE IDEMPOTENCY KEY, FINALLY READ ═══
    //
    // `askId` was documented as an idempotency key and read by nothing. A
    // repeat minted a SECOND `ci.asks` row and re-evaluated it from scratch,
    // with two consequences that made federated review a one-way trip:
    //
    //   - an ask the owner had PERSONALLY APPROVED could never be collected.
    //     The approved answer sat on this box; the peer asking again was queued
    //     in front of the owner a second time, forever;
    //   - a peer could re-run an evaluation against the owner's memory at will
    //     by resending, which is an execution amplifier a correlation id was
    //     supposed to prevent.
    //
    // A replay NEVER re-evaluates and NEVER executes. It hands back what was
    // already decided for THIS correlation id, or says nothing is available.
    const digest = requestDigest(body);
    const existing = await findCorrelation(this.correlations, link.id, body.askId);

    if (existing != null) {
      // One key, one question. Without this a peer could reuse a key for a
      // DIFFERENT ask and be handed the first one's answer — no new disclosure
      // (it already crossed to this same peer), but an answer to a question
      // nobody asked. Refused as `Malformed ask`, the same refusal an
      // off-contract body gets, so it adds no new distinguishable outcome.
      if (existing.requestDigest !== digest) {
        throw new BadRequestException('Malformed ask');
      }

      return this.replay(link, body.askId, existing.askId);
    }

    const query = toAskQuery(body);

    const ask = await this.askService.create(context, {
      responderUserId: link.ownerUserId,
      query,
      peerLinkId: link.id,
      direction: 'inbound',
      channel,
    });

    // Recorded BEFORE the ask is evaluated, so an ask that reaches the owner's
    // inbox is collectable the moment they approve it. Writing it after the
    // decision would leave every `pending` ask — the only ones a poll exists
    // for — unnameable until something else touched them. See
    // {@link PeerAskCorrelationEntity} for why this is not one transaction.
    await recordCorrelation(this.correlations, {
      peerLinkId: link.id,
      correlationId: body.askId,
      askId: ask.id,
      requestDigest: digest,
    });

    const decision = await this.grantService.evaluate(ask);

    if (decision.decision === 'deny') {
      // Persist the terminal state. Without this the ask stays `delivered`,
      // which `listInbox` surfaces as actionable — so the owner could later
      // "approve" an ask their own block grant already refused, and the block
      // would be silently overridden.
      const declined = await this.askService.systemTransition(ask.id, 'declined', {
        consentBasis: decision.grantId ?? null,
      });
      // The basis comes off the transitioned row — `systemTransition` above
      // stamped it, so the audit cites exactly what the ask now records.
      // `disclosedCount: 0` is stated rather than left to the fallback: the
      // fallback happens to agree here, and stating it is what keeps every
      // `recordAudit` call site honest about a field that silently defaults.
      await this.recordAudit(declined, link, 'declined', [], [], undefined, 0);

      // A decline is shaped exactly like "nothing found", and now says the same
      // WORD too — see {@link PEER_ASK_PENDING}. The refusal is recorded in
      // full on this box (`ci.asks.status = 'declined'`, an audit row naming
      // the block grant); what changes is that none of it is told to the peer.
      return peerAskPending(body.askId);
    }

    if (decision.decision !== 'auto') {
      // Needs the owner's eyes; move it into the review queue explicitly rather
      // than leaving it in the delivered limbo.
      await this.askService.systemTransition(ask.id, 'under_review');

      return peerAskPending(body.askId);
    }

    // Auto-authorized: record WHICH grant authorized it, so the answer and the
    // audit both carry a real consent basis rather than null — and the ceiling
    // that grant imposed AT THIS MOMENT, so a later revocation cannot widen a
    // re-run of the same ask (see {@link AskEntity.disclosureCeiling}).
    const authorized = await this.askService.setConsentBasis(
      ask.id,
      decision.grantId ?? null,
      decision.maxDisclosure ?? null,
    );

    // ═══ THE PULL-SIDE CONSENT CHECK, WHICH THIS PATH DID NOT HAVE ═══
    //
    // Retroactive revocation protects the local path from two directions:
    // GrantService PUSHES a revoked grant's pre-authorized asks back into the
    // owner's inbox, and `AskService.complete` PULLS the current grant state
    // before it discloses anything. The federated path had neither — it went
    // straight from `evaluate` to disclosure — so the only thing standing
    // between a revoked grant and a peer was the `evaluate` read, and any
    // divergence between "no matching live grant" and "the deciding grant is
    // still in force" failed OPEN.
    //
    // Two ordering traps, both load-bearing:
    //   1. It runs AFTER `setConsentBasis`. `isConsentStanding` reads
    //      `ask.consentBasis` and returns true vacuously when it is null, so
    //      the pre-stamp ask would sail through the check that exists to stop
    //      it.
    //   2. It runs BEFORE `answerFor`. The local path re-checks at `complete`,
    //      i.e. after the executor has already read the owner's memory; here
    //      the check is in front of every read, so a withdrawn consent means
    //      the owner's data is never touched at all rather than read and then
    //      discarded.
    //
    // The ask lands where a revoked pre-authorization lands on the local path —
    // basis cleared, back in front of the owner — and the peer is told the same
    // thing an unmatched ask, a blocked ask and an unknown ask are told. A
    // distinct "your grant was revoked" would hand the peer the owner's consent
    // posture as a side channel.
    if (!(await this.grantService.isConsentStanding(authorized))) {
      await this.askService.systemTransition(ask.id, 'under_review', { consentBasis: null });

      return peerAskPending(body.askId);
    }

    const answer = await this.answerFor(
      context,
      link,
      body,
      authorized,
      decision.grantId ?? null,
      decision.maxDisclosure,
    );

    return { askId: body.askId, status: 'answered', answer };
  }

  /**
   * THE RETURN PATH: hand back the answer to an ask this peer already sent.
   *
   * ═══ WHY A POLL AND NOT A CALLBACK ═══
   *
   * An approved answer never crossed back at all: the synchronous reply to
   * `POST /agent/v1/ask` was the only channel there was, so federated AUTO
   * worked end to end and federated REVIEW did not — the one disclosure a human
   * personally approved could not be delivered to the person who asked for it.
   *
   * A callback (responder POSTs the answer to the asker) was rejected on
   * reachability and on attack surface, not on effort:
   *
   *   - IT INVERTS WHO MUST BE REACHABLE. Today exactly one direction of egress
   *     is required — asker → responder — and `urlPolicy.checkEgressUrl` is
   *     built around that: `memory_endpoint` comes from a directory descriptor,
   *     so it is attacker-influenced and treated as an SSRF sink. A callback
   *     would require the RESPONDER to hold and dial an address supplied by the
   *     asker, i.e. a second, more directly attacker-controlled egress sink, on
   *     the box that holds the data.
   *   - IT MAKES A HOME APPLIANCE AN INBOUND SERVER FOR ITS PEERS. A box behind
   *     NAT can ask and receive answers today; under a callback it could only
   *     ask.
   *
   * The poll costs latency and nothing else. It is a READ: it never evaluates a
   * grant, never runs the executor, never writes an ask, never writes an audit
   * row. It can only hand back a disclosure that already happened.
   *
   * ═══ AND IT IS NOT A NEW ORACLE ═══
   *
   * Every non-answer is the same reply: an ask still in the owner's review
   * inbox, an ask a block grant refused, an ask that expired unanswered, a
   * correlation id this box has never seen, and a correlation id belonging to a
   * DIFFERENT peer are all {@link peerAskPending}. In particular this route
   * does not 404 on an unknown id — a 404 would answer "has this peer ever
   * asked me that?" for free.
   */
  async result(
    peerIdentity: { issuer: string; subject: string },
    correlationId: string,
  ): Promise<PeerAskResponse> {
    const link = await this.resolveLink(peerIdentity);
    // Scoped by peer link, so one peer can never collect another's answer even
    // if it guesses the correlation id.
    const existing = await findCorrelation(this.correlations, link.id, correlationId);

    if (existing == null) {
      return peerAskPending(correlationId);
    }

    return this.replay(link, correlationId, existing.askId);
  }

  /**
   * The correlation table, reached through the injected repository's manager
   * rather than through an injected repository of its own.
   *
   * Same reason `persistDisclosure` reaches its transaction that way: the
   * manager belongs to the connection, not to `EventEntity`, and this service
   * is constructed BY HAND in several places — the DB-backed lifecycle suites
   * and the disclosure-ceiling integration suite among them. Growing the
   * constructor for a dependency that is one `getRepository` call away breaks
   * those at a distance, and that arity has already been documented as
   * load-bearing once.
   */
  private get correlations(): CorrelationRepository {
    return this.eventRepository.manager.getRepository(PeerAskCorrelationEntity);
  }

  /**
   * The occurrences a peer's "are you free?" has to account for.
   *
   * `ci.events` holds series masters only (the Google connector fetches
   * `singleEvents=false` on purpose), so without this every occurrence after
   * the first read as free time and the box handed a peer a slot the owner has
   * stood in a standup for two years.
   *
   * Occurrences are computed, never stored, and only the two boundaries reach
   * `computeFreeBusy` — nothing new crosses the wire. Occurrences that already
   * exist as their own override row are dropped, including cancelled and
   * tombstoned ones, so an individually-deleted occurrence stays free.
   */
  private async expandRecurringForAvailability(
    userId: string,
    rows: readonly EventEntity[],
    from: Date,
    to: Date,
  ): Promise<BusySource[]> {
    const masters = rows.filter((row) => row.isRecurring);

    if (masters.length === 0) {
      return [];
    }

    const zone = await resolveExpansionZone(this.eventRepository, userId);
    const specs = expandAll(
      masters,
      { from, to },
      { fallbackTimeZone: zone.timeZone, fallbackTimeZoneSource: zone.source },
    );
    const kept = await dropExistingOverrides(this.eventRepository, userId, specs);
    const allDay = new Map(masters.map((master) => [master.id, master.isAllDay]));

    return kept.map((spec) => ({
      startTime: spec.startTime,
      endTime: spec.endTime,
      isAllDay: allDay.get(spec.seriesId) ?? false,
    }));
  }

  /**
   * Resolve a verified (issuer, subject) to the ONE peer link that may act on
   * it. Shared by every peer-facing entry point so the two refusals stay
   * identical — a stranger must not be able to distinguish "no such user on
   * this box" from "you are not linked to them".
   */
  private async resolveLink(peerIdentity: { issuer: string; subject: string }): Promise<PeerLink> {
    const links = await this.peerLinkService.findActiveByPeerIdentity(
      peerIdentity.issuer,
      peerIdentity.subject,
    );

    if (links.length === 0) {
      throw new ForbiddenException('No peer link');
    }

    // Multi-user household: refuse rather than answer as an arbitrary member.
    if (links.length > 1) {
      throw new ForbiddenException('Ambiguous peer link');
    }

    return links[0];
  }

  /**
   * Hand back the recorded outcome of an ask, computing nothing.
   *
   * Reached from two places with identical semantics: a repeat POST carrying a
   * known `askId`, and a poll naming one. Neither may re-run anything — the
   * whole point of the correlation is that the disclosure decision was taken
   * once.
   *
   * The status gate is `ask.status === 'answered'`, not "an answer row exists".
   * An answer row can exist for an ask that never reached a terminal answered
   * state, and `AskResolver.askAnswer` already refuses to read one on exactly
   * that ground; a peer must not be a weaker reader than the local asker.
   */
  private async replay(link: PeerLink, correlationId: string, askId: string): Promise<PeerAskResponse> {
    const ask = await this.askService.findById({ userId: link.ownerUserId }, askId);

    if (ask == null || ask.status !== 'answered') {
      return peerAskPending(correlationId);
    }

    const answer = await this.answerService.findByAskId(askId);

    if (answer == null) {
      return peerAskPending(correlationId);
    }

    return { askId: correlationId, status: 'answered', answer: toWireAnswer(answer) };
  }

  /** Execute an authorized ask and build its disclosure-filtered answer. */
  private async answerFor(
    context: UserServiceContext,
    link: PeerLink,
    body: PeerAskBody,
    ask: Ask,
    consentBasis: string | null,
    grantCeiling?: DisclosureRung,
  ): Promise<NonNullable<PeerAskResponse['answer']>> {
    const who = link.displayName ?? 'They';

    // ═══ THE CEILING IS COMPUTED BEFORE THE ARCHETYPE BRANCH, NOT AFTER ═══
    //
    // It used to be computed below, on the relationship/content path only, and
    // the availability branch returned before ever reaching it. Both ceilings —
    // the tier the owner assigned this peer AND the deciding grant's own
    // `maxDisclosure` — were therefore skipped entirely for the one archetype
    // that answers straight out of the owner's calendar. Reproduced against
    // Postgres: `trustTier: 'stranger'` (tier ceiling `boolean`) plus a grant
    // carrying `maxDisclosure: 'none'` still handed the peer the owner's real
    // busy interval and both free windows, while the CONTENT archetype under
    // the identical `none` ceiling correctly returned "Nothing was shared."
    //
    // Two independent ceilings, combined by taking the LESSER: a grant can
    // tighten the tier default but never loosen it, so neither a generous grant
    // nor a generous tier alone can widen what a peer receives.
    //
    // The class comes from the ASK's own query rather than being re-derived per
    // archetype (`archetype === 'content' ? request.dataClass : undefined`).
    // `toAskQuery` already set it — 'calendar' for availability, the requested
    // class for content, absent for relationship — and reading it from one
    // place is what stops a fourth archetype from quietly inheriting
    // `undefined` the way availability inherited "no ceiling at all".
    const tierCeiling = disclosureCeiling(link.trustTier, ask.query.dataClass);
    const ceiling = grantCeiling != null ? minRung(tierCeiling, grantCeiling) : tierCeiling;

    // Availability has its own executor: it never touches the search index and
    // returns interval boundaries only, which is what makes it safe to
    // auto-answer under a standing grant — but "interval boundaries only" is a
    // statement about the SHAPE of the disclosure, not its size, and it is not
    // a reason to skip the ceiling.
    if (body.request.archetype === 'availability') {
      const { from, to } = boundedWindow(body.request.from, body.request.to);

      // OVERLAP, not containment. Filtering on `startTime BETWEEN from AND to`
      // misses the case that matters most: a meeting that began before the
      // window and is still running inside it (09:00–17:00 asked over 12:00–13:00
      // would load nothing and report the owner free through a four-hour
      // meeting). An event overlaps the window when it starts before the window
      // ends AND has not already finished when the window opens. `endTime` is
      // nullable, so open-ended events are matched on start alone and given a
      // default duration by computeFreeBusy.
      const events = await this.eventRepository.find({
        where: [
          {
            userId: context.userId,
            // Events are tombstoned, not destroyed (`CalendarEventService.softDeleteFlag`),
            // so a raw repository read has to skip flagged rows itself. Without
            // this a deleted meeting still marks the owner busy to a peer.
            isDeleted: false,
            startTime: LessThanOrEqual(to),
            endTime: MoreThanOrEqual(from),
          },
          {
            userId: context.userId,
            isDeleted: false,
            startTime: Between(from, to),
            endTime: IsNull(),
          },
          // Third arm: recurring SERIES MASTERS, matched on start alone.
          //
          // `ci.events` stores one row per series, so a weekly standup whose
          // DTSTART was two years ago satisfies neither arm above and the box
          // answered a peer "free" through every occurrence after the first.
          // These rows are loaded for their RULE, not their own span — a master
          // that does not overlap the window contributes no busy time, because
          // `computeFreeBusy` clamps every span to the window and drops the
          // empties.
          {
            userId: context.userId,
            isDeleted: false,
            isRecurring: true,
            startTime: LessThanOrEqual(to),
          },
        ],
        // `id` is selected for the AUDIT, not for the answer — see the
        // backing-entity note below. `computeFreeBusy` ignores it, and no id
        // reaches the wire: the response carries interval boundaries only.
        //
        // The five recurrence columns are what `expandAll` reads; none of them
        // reaches the wire either.
        select: {
          id: true,
          startTime: true,
          endTime: true,
          isAllDay: true,
          isRecurring: true,
          recurrencePattern: true,
          metadata: true,
          sourceSystem: true,
          sourceId: true,
        },
        take: MAX_AVAILABILITY_EVENTS,
      });

      // Deliberately NOT routed through `CalendarEventService.findInRange`,
      // which does the same expansion for the calendar: that read also imposes
      // SCHEDULE_EVENT_TYPES and LIVE_EVENT_SQL, and adopting them here would
      // quietly change which of the owner's rows mark them busy to a peer. That
      // a photo row and a cancelled meeting both do so today is arguable, but
      // it is a separate change with its own review.
      //
      // The repositories are reached through the injected repository's manager
      // for the reason `correlations` gives: this service is hand-constructed by
      // several suites and its constructor arity is load-bearing at a distance.
      const occurrences = await this.expandRecurringForAvailability(context.userId, events, from, to);
      const freeBusy = computeFreeBusy(
        [...events, ...occurrences],
        { from, to },
        { minMinutes: body.request.minMinutes },
      );
      const answer = clampAvailability(freeBusy, ceiling, who);

      // The availability branch wrote NO `ci.ask_answers` row at all — the one
      // archetype with no ceiling was also the one with no record of what it
      // disclosed, so neither the owner's history nor an incident review could
      // reconstruct it. It is persisted under the `attribute` form (the
      // ask_answers CHECK admits the five local forms; `availability` is a WIRE
      // form, not a storage one) with the post-ceiling summary and no items,
      // which is exactly what crossed.
      //
      // DISCLOSED vs BACKING, for an archetype that itemizes nothing:
      // `disclosedEntities` stays empty and that is correct — free/busy crosses
      // as interval boundaries, never as entity references, so there is nothing
      // the peer received to list. `backingEntities` is the half that was
      // missing: the box read N of the owner's calendar events to compute this
      // answer, and recording none of them left the owner's history unable to
      // say WHICH meetings a peer's "are you free?" consulted. The content path
      // has always recorded its candidate set here; availability now does the
      // same. Backing entities are owner-only and are never disclosed.
      await this.persistDisclosure(
        context,
        link,
        ask,
        {
          form: 'attribute',
          items: [],
          // ═══ NOT `answer.free.length` — THAT IS THE POST-CLAMP ARRAY ═══
          //
          // `clampAvailability` empties both interval arrays at every rung
          // below `redacted`, so reading the count off the clamped result
          // recorded 0 for exactly the rungs where a number is the ONLY thing
          // that crossed. Reproduced across two boxes: the peer was told
          // "4 free slots" under a `count` ceiling and both `ci.ask_answers`
          // and `ci.ask_audit` said 0 — the same under-reporting the audit's
          // own `disclosed_count` column exists to prevent, arrived at by a
          // different route.
          //
          // The clamp reports the magnitude IT disclosed, which is the slot
          // count down to `count` and nothing at `boolean` (a yes/no carries no
          // cardinality, the same rule `carriesCount` applies below) and
          // nothing at `none`.
          disclosedCount: answer.disclosedCount,
          withheldCount: 0,
          summary: answer.summary,
          consentBasis,
        },
        [],
        events.map((event) => event.id),
      );

      return { form: 'availability', summary: answer.summary, busy: answer.busy, free: answer.free };
    }

    // relationship / content resolve through the shared run-as-owner executor
    // and the shared disclosure filter.
    const identifiers = await this.executorService.execute(ask);
    const matches = identifiers.map((identifier) => ({ id: identifier.id, type: identifier.type }));

    const built = buildDisclosedAnswer({
      // "Do you know X?" is a yes/no; "have you seen X?" is existence. Neither
      // returns item references — only an explicit retrieval ask would, and the
      // peer protocol does not expose one.
      form: body.request.archetype === 'relationship' ? 'boolean' : 'existence',
      matches,
      consentBasis,
      responderLabel: who,
    });

    // Phase 2 policy engine — the same `ceiling` the availability branch above
    // now uses, computed once at the top of this method.
    const disclosed = applyDisclosureCeiling(built, ceiling);

    // Same split the local path makes: `disclosed.items` is what actually
    // crossed to the peer (empty here — the peer protocol exposes no retrieval
    // archetype), while the match set is the owner's own record of what the
    // answer was computed over. Recording the matches as DISCLOSED made the
    // audit over-report every federated answer.
    await this.persistDisclosure(
      context,
      link,
      ask,
      disclosed,
      disclosed.items.map((item) => item.id),
      matches.map((match) => match.id),
    );

    // CARDINALITY IS ITSELF A DISCLOSURE. A boolean answer ("do you know X?")
    // must carry no count, or the archetype degrades into a keyword-frequency
    // oracle over the responder's whole corpus: an asker could re-ask with
    // varied terms and read the match count each time. Only the `existence`
    // form is permitted to say *how much*, because that is what it means.
    const carriesCount = disclosed.form === 'existence' || disclosed.form === 'retrieval';

    return {
      form: disclosed.form,
      summary: disclosed.summary,
      items: disclosed.items,
      disclosedCount: carriesCount ? disclosed.disclosedCount : undefined,
      withheldCount: carriesCount ? disclosed.withheldCount : undefined,
    };
  }

  /**
   * Persist a federated disclosure ATOMICALLY: the answer row, the ask's
   * TERMINAL status, and the audit row.
   *
   * ═══ THE FEDERATED PATH NEVER TERMINALIZED ITS ASK ═══
   *
   * `answerFor` used to write an answer and an audit row and stop there, which
   * left a fully answered inbound peer ask sitting at `delivered` with its
   * consent basis intact — the exact shape of "auto-answerable, not yet
   * answered". Three consequences, all reproduced:
   *
   *   - the owner could `decline` an ask that had already been answered,
   *     writing a second, contradicting audit row for one disclosure;
   *   - `approve` moved it to `answering`, from which the only legal edge is
   *     `answered` — and `complete` would then hit the insert-only guard in
   *     `AskAnswerService.create` and raise a conflict forever. Wedged;
   *   - `withdrawPreAuthorization` selects exactly `status = 'delivered'` with
   *     this grant as the basis, so REVOKING THE GRANT REWROTE A DISCLOSURE
   *     THAT HAD ALREADY HAPPENED — status back to `under_review`, basis
   *     nulled — and the owner's history then disagreed with the audit log
   *     about whether anything was ever sent. `answered` is terminal and
   *     outside that filter, which is what closes it.
   *
   * ═══ AND IT WROTE THE TWO ROWS UN-TRANSACTED ═══
   *
   * The local path wraps them (`AskService.completeWithAnswer`); this one did
   * not. A failure between the answer insert and the audit insert leaves a
   * `ci.ask_answers` row describing a disclosure with no audit row saying it
   * happened — and it is PERMANENT, not transient: `AskAnswerService.create` is
   * insert-only, so the retry raises a conflict instead of writing the missing
   * audit. The owner's disclosure history is then silently short one entry,
   * forever.
   *
   * WHY NOT `AskService.completeWithAnswer`, which already does all of this?
   * Because the audit row it writes is built from the ask alone and cannot
   * carry `peerLinkId` / `peerHandle`, and a federated disclosure whose audit
   * row cannot name the peer it went to is a worse defect than the one being
   * fixed. The lifecycle rule itself is NOT duplicated here — the transitions
   * go through the same pure `assertAskTransition` state machine the local path
   * uses. Teaching `complete` to carry peer attribution (and then calling it
   * from here) is the follow-up; it lives in `domains/asks`.
   */
  private async persistDisclosure(
    context: UserServiceContext,
    link: PeerLink,
    ask: Ask,
    answer: DisclosedAnswer,
    disclosedEntities: string[],
    backingEntities: string[],
  ): Promise<void> {
    // The transaction is opened through an injected repository's `manager`
    // rather than an injected `DataSource`, exactly as `GrantService.supersede`
    // does. Which repository it is reached through is irrelevant — the manager
    // belongs to the connection, not to `EventEntity` — and going this way
    // keeps the constructor arity stable for the callers that build this
    // service by hand.
    await this.eventRepository.manager.transaction(async (manager) => {
      await this.answerService.create({ askId: ask.id, answer }, manager);
      const terminal = await this.terminalize(manager, context, ask);
      await this.recordAudit(
        terminal,
        link,
        'auto_answered',
        disclosedEntities,
        backingEntities,
        manager,
        // THE MAGNITUDE, which this path used to drop. See {@link recordAudit}.
        answer.disclosedCount,
      );
    });
  }

  /**
   * Drive an auto-authorized inbound ask to `answered` inside the caller's
   * transaction.
   *
   * `delivered → answered` is not a legal edge, so this takes the same two
   * hops `AskService.complete` takes — `delivered → answering → answered` —
   * through the shared state machine rather than assigning the status
   * directly. Reading the row back inside the transaction (rather than trusting
   * the in-memory `ask` handed down from `handle`) is what makes the edge
   * assertion mean something: the row is the only thing that knows whether
   * something else moved this ask while the answer was being computed.
   *
   * Scoped by responder, matching `AskService.responderOwned` — an inbound peer
   * ask has no local asker, so the link owner is the only participant who can
   * own it.
   */
  private async terminalize(manager: EntityManager, context: UserServiceContext, ask: Ask): Promise<Ask> {
    const repository = manager.getRepository(AskEntity);
    const entity = await repository.findOne({
      where: { id: ask.id, responderUserId: context.userId },
    });

    if (entity == null) {
      throw new NotFoundException(`Ask ${ask.id} not found`);
    }

    if (entity.status === 'delivered') {
      entity.status = assertAskTransition(entity.status, 'answering');
    }

    entity.status = assertAskTransition(entity.status, 'answered');

    return AskEntity.toEgressType(await repository.save(entity));
  }

  /**
   * ═══ THE COUNT HAS TO BE PASSED, BECAUSE THE FALLBACK IS WRONG HERE ═══
   *
   * `ci.ask_audit.disclosed_count` exists precisely because
   * `disclosedEntities` is EMPTY for every form but `retrieval` — so deriving
   * the count from it "audited a real count/boolean disclosure as nothing was
   * shared" (`AskAuditService.record`). The local path forwards it
   * (`AskService.completeWithAnswer` → `complete`'s `disclosedCount`); this one
   * did not, so the fallback fired on every federated answer and the owner's
   * disclosure history under-reported a disclosure that had really been made.
   *
   * Reproduced against two real boxes: a peer was told "1 matching item" and
   * `ci.ask_audit.disclosed_count` recorded 0; an availability answer said
   * "4 free slots", `ci.ask_answers.disclosed_count` said 4, and the audit row
   * said 0.
   *
   * It is a REQUIRED parameter with no default on purpose. A defaulted one is
   * how this was lost the first time: `recordAudit` simply never mentioned the
   * field, and every call site inherited the wrong answer silently.
   */
  private async recordAudit(
    ask: Ask,
    link: PeerLink,
    outcome: 'auto_answered' | 'declined',
    disclosedEntities: string[],
    backingEntities: string[] = [],
    manager: EntityManager | undefined,
    disclosedCount: number,
  ): Promise<void> {
    await this.auditService.record(
      {
        askId: ask.id,
        askerUserId: ask.askerUserId,
        peerLinkId: link.id,
        peerHandle: link.peerHandle,
        responderUserId: ask.responderUserId,
        query: ask.query,
        // Read off the ask rather than passed in: after `terminalize` the row
        // IS the record of what authorized this disclosure, and a separately
        // threaded copy could disagree with it.
        consentBasis: ask.consentBasis,
        outcome,
        disclosedEntities,
        disclosedCount,
        backingEntities,
      },
      manager,
    );
  }
}

/**
 * Project a STORED answer row back onto the peer wire.
 *
 * ═══ A REPLAY MUST NEVER BE WIDER THAN THE LIVE ANSWER WAS ═══
 *
 * The stored row is not automatically peer-shaped. An owner-approved federated
 * ask is answered through `runAsk` → `AskService.completeWithAnswer`, i.e. by
 * the LOCAL pipeline, and the local pipeline has a `retrieval` form that
 * itemizes real entity references. The peer protocol deliberately exposes no
 * retrieval archetype — `answerFor` only ever builds `boolean` or `existence` —
 * so echoing `disclosed_entities` verbatim would hand a peer item references
 * that the inbound path is not even capable of producing. Hence: no items, ever.
 *
 * The cardinality rule is the one `answerFor` applies, spelled once and applied
 * in both places. A `boolean` answer ("do you know X?") must carry no count, or
 * the archetype degrades into a keyword-frequency oracle over the responder's
 * whole corpus; only `existence` and `retrieval` are permitted to say how much.
 *
 * ═══ WHAT A REPLAYED AVAILABILITY ANSWER LOSES, AND WHY THAT IS RIGHT ═══
 *
 * Free/busy boundaries are not stored: `persistDisclosure` writes availability
 * under the `attribute` form with the post-ceiling SUMMARY and no items,
 * because that is what the ask_answers CHECK admits and because interval
 * boundaries are not entity references. So a replayed availability answer
 * carries its summary and no intervals. A replay recomputing them would be a
 * fresh read of the owner's calendar under a consent decision taken minutes or
 * days ago — exactly the thing the correlation exists to prevent. Narrower on
 * replay is the safe direction.
 *
 * Pure.
 */
export function toWireAnswer(stored: AskAnswer): NonNullable<PeerAskResponse['answer']> {
  const carriesCount = stored.form === 'existence' || stored.form === 'retrieval';

  return {
    form: stored.form,
    summary: stored.summary ?? '',
    items: [],
    disclosedCount: carriesCount ? stored.disclosedCount : undefined,
    withheldCount: carriesCount ? stored.withheldCount : undefined,
  };
}

/**
 * Clamp a free/busy answer down to a disclosure rung.
 *
 * `applyDisclosureCeiling` cannot do this job: it operates on a
 * {@link DisclosedAnswer}, whose unit of disclosure is an ITEM REFERENCE, and
 * an availability answer discloses interval BOUNDARIES instead. So the ladder
 * is spelled out here in the same shape and the same order, and it degrades the
 * same way — each rung strictly removes what the one above it revealed:
 *
 *   full            — the busy and free intervals, as computed
 *   redacted        — free slots only, coarsened to a half-hour grid; the busy
 *                     intervals are dropped entirely. Where the `trusted` tier
 *                     lands, and where this used to return `full`'s answer
 *                     verbatim — see {@link coarsenFreeBusy} for the defect and
 *                     what `redacted` means for a calendar.
 *   summary         — the templated sentence only (slot count + longest gap),
 *                     no boundaries. This is where the tier defaults land for
 *                     the `peer` tier.
 *   count           — how many free slots, with no durations and no boundaries
 *   boolean         — "is there any free time at all", nothing else. Where the
 *                     `stranger` tier lands, and where the reproduced bypass
 *                     was handing over the owner's actual meeting times.
 *   none            — nothing, worded identically to a `none` answer on every
 *                     other archetype so a refusal is not distinguishable from
 *                     an empty calendar.
 *
 * The intervals are dropped BEFORE the summary is rewritten, because
 * `summarizeAvailability` reads them — a clamp that rewrote the sentence and
 * left the arrays populated would disclose everything it claimed to withhold.
 *
 * Pure.
 */
export function clampAvailability(
  freeBusy: FreeBusy,
  ceiling: DisclosureRung,
  who: string,
): { summary: string; busy: BusyInterval[]; free: BusyInterval[]; disclosedCount: number } {
  const hasFree = freeBusy.free.length > 0;
  const slots = freeBusy.free.length;

  switch (ceiling) {
    case 'full':
      return {
        summary: summarizeAvailability(freeBusy, who),
        busy: freeBusy.busy,
        free: freeBusy.free,
        disclosedCount: slots,
      };
    case 'redacted': {
      // Coarsened FIRST, then summarized from the coarsened set — the same
      // ordering rule the docstring states above. Summarizing the original and
      // returning the coarsened arrays would put a count in the sentence that
      // the arrays contradict, which is how a clamp leaks the thing it claims
      // to withhold.
      const coarse = coarsenFreeBusy(freeBusy);

      return {
        summary: summarizeAvailability(coarse, who),
        busy: coarse.busy,
        free: coarse.free,
        // NOT `slots`. Quantization drops slots too short to survive the grid,
        // and the audit records the magnitude that actually crossed.
        disclosedCount: coarse.free.length,
      };
    }

    case 'summary':
      // The sentence carries a slot count and a duration but no instants, which
      // is the same trade `summary` makes elsewhere: magnitude, not content. So
      // the MAGNITUDE still crossed, even though the arrays did not — which is
      // exactly why the count cannot be read off the returned arrays.
      return {
        summary: summarizeAvailability(freeBusy, who),
        busy: [],
        free: [],
        disclosedCount: slots,
      };
    case 'count':
      return {
        summary: hasFree
          ? `${who} have ${slots} free slot${slots === 1 ? '' : 's'} in that window.`
          : `${who} have no free time in that window.`,
        busy: [],
        free: [],
        disclosedCount: slots,
      };
    case 'boolean':
      return {
        summary: hasFree
          ? `${who} have some free time in that window.`
          : `${who} have no free time in that window.`,
        busy: [],
        free: [],
        // A yes/no carries no cardinality — the same rule `answerFor` applies
        // to a `boolean` disclosure form. Recording a number the peer was never
        // told would over-report this one as badly as `free.length` under-reports
        // the rungs above it.
        disclosedCount: 0,
      };
    case 'none':
    default:
      return { summary: 'Nothing was shared.', busy: [], free: [], disclosedCount: 0 };
  }
}

/** Hard ceiling on rows an availability ask may load, whatever the window. */
const MAX_AVAILABILITY_EVENTS = 2000;

/** Longest window an availability ask may span (31 days). */
const MAX_AVAILABILITY_SPAN_MS = 31 * 24 * 60 * 60 * 1000;

/**
 * Validate and bound an asker-supplied availability window. The wire schema
 * only guarantees the strings parse as ISO datetimes — it cannot express
 * ordering or a maximum span, so a peer could otherwise ask for "1970 to 2100"
 * and make the responder load and merge their entire calendar on demand.
 */
export function boundedWindow(fromIso: string, toIso: string): { from: Date; to: Date } {
  const from = new Date(fromIso);
  const to = new Date(toIso);

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new BadRequestException('Invalid availability window');
  }

  if (to.getTime() <= from.getTime()) {
    throw new BadRequestException('Availability window must end after it starts');
  }

  if (to.getTime() - from.getTime() > MAX_AVAILABILITY_SPAN_MS) {
    throw new BadRequestException('Availability window is too long');
  }

  return { from, to };
}

/** Translate a wire archetype into the local ask query vocabulary. */
export function toAskQuery(body: PeerAskBody): AskQuery {
  // Carried on EVERY archetype: delegation is a property of who is asking, not
  // of what they are asking about, and an archetype that dropped it would be a
  // way around a `delegation` restriction rather than a gap in one.
  const actor = body.actor ? { actor: body.actor } : {};

  // WHY, carried on every archetype.
  //
  // `scopeCoversQuery` reads `filters.purpose`, and nothing ever wrote one:
  // availability folded its purpose into the PROMPT and the other two had no
  // field at all, so a purpose-limited grant matched no inbound peer ask ever.
  // The body-level `purpose` is preferred; availability's own is the fallback,
  // so a peer that predates the body field still binds correctly.
  const statedPurpose =
    body.purpose ?? (body.request.archetype === 'availability' ? body.request.purpose : undefined);
  const purpose = statedPurpose ? { purpose: statedPurpose } : {};

  switch (body.request.archetype) {
    case 'relationship':
      return {
        queryType: 'relationship',
        prompt: body.request.subject,
        filters: { ...purpose },
        ...actor,
      };
    case 'content':
      return {
        queryType: 'content',
        dataClass: body.request.dataClass,
        prompt: body.request.subject,
        filters: { from: body.request.from, to: body.request.to, ...purpose },
        ...actor,
      };
    case 'availability':
      return {
        queryType: 'availability',
        dataClass: 'calendar',
        prompt: body.request.purpose ?? body.prompt,
        filters: { from: body.request.from, to: body.request.to, ...purpose },
        ...actor,
      };
  }
}
