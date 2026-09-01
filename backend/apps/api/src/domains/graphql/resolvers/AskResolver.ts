import { BadRequestException, ForbiddenException, NotFoundException, UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';

import { Context, type RequestContext, type UserServiceContext, toServiceContext } from '@ci/common/context';
import { FeatureService } from '@ci/common/feature';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { LoggerService } from '@ci/common/logging';
import {
  type Ask,
  type AskAnswer,
  AskAnswerService,
  AskAuditService,
  AskExecutorService,
  AskRateLimitService,
  AskService,
  AskBroadcastService,
  GrantService,
  HouseholdTierService,
  applyDisclosureCeiling,
  buildDisclosedAnswer,
  disclosureCeiling,
  inferAnswerForm,
  isAnswerable,
  narrowerForm,
  narrowestRung,
  parseAskQueryInput,
  parseGrantQueryType,
  type AnswerForm,
  type AskGrantScope,
  type DisclosedAnswer,
  type DisclosureRung,
  type GrantMode,
  type TrustTier,
  UNATTRIBUTED,
  type AuditFilter,
  type AskAuditOutcome,
  type AskDelegation,
} from '@ci/domains/asks';
import { OutboundAskService, type PeerAskRequest, type PeerLink, PeerLinkService } from '@ci/domains/peers';

import { AnswerFormEnum, AskAnswerType } from '../types/AskAnswerType';
import { AskDisclosureHistoryInput, AskDisclosureSummaryInput } from '../types/AskDisclosureInputs';
import {
  CreateAskGrantInput,
  CreateAskInput,
  SendPeerAskInput,
  UpdateAskGrantInput,
} from '../types/AskInputs';
import {
  ASK_ACCEPTED,
  AskGrantPayload,
  AskPayload,
  CreateAskPayload,
  RunAskPayload,
  SendPeerAskPayload,
} from '../types/AskPayloads';
import {
  AskAuditType,
  AskBroadcastType,
  AskDisclosureHistoryPayload,
  AskDisclosureSummaryPayload,
  AskDisclosureSummaryType,
  AskGrantType,
  AskType,
} from '../types/AskType';
import { CreateAskBroadcastInput } from '../types/CreateAskBroadcastInput';
import { GlobalUID } from '../types/GlobalUID';
import { HouseholdTierType, SetHouseholdTierInput } from '../types/HouseholdTierType';

/**
 * GraphQL surface for the interpersonal ask feature (epic #1712, Phase 0). Every
 * operation is signed-in-only ({@link JwtOrApiKeyAuthGuard}) and gated by the
 * `ask` feature flag — while the flag is off the surface behaves as if absent
 * (mutations return `{ success: false }`, queries return empty), mirroring how
 * the shared-search surface stays dark behind `shared.search`.
 *
 * The flag ships ON (`config/default.json`). This comment used to say "default
 * off", which had been false since the flag was set and is the more dangerous
 * direction for a consent surface to be wrong in: an operator reading it would
 * believe the ask endpoints were dark on a box where every one of them answers.
 * If the default changes, change it here too — a gate whose documentation
 * disagrees with its configuration is a gate nobody can reason about.
 *
 * The `answering`/answered completion of an ask is produced HERE, by
 * {@link disclose} — the run-as-owner executor plus the disclosure filter. Two
 * entry points reach it and they share the one method rather than each carrying
 * a copy: {@link runAsk}, when the owner taps "Answer now", and
 * {@link createAsk}, when the owner's standing grants already said yes.
 */
@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => AskType)
export class AskResolver {
  constructor(
    private readonly askService: AskService,
    private readonly grantService: GrantService,
    private readonly auditService: AskAuditService,
    private readonly rateLimitService: AskRateLimitService,
    private readonly executorService: AskExecutorService,
    private readonly answerService: AskAnswerService,
    private readonly peerLinkService: PeerLinkService,
    private readonly outboundAskService: OutboundAskService,
    private readonly householdTierService: HouseholdTierService,
    private readonly broadcastService: AskBroadcastService,
    private readonly featureService: FeatureService,
  ) {}

  /**
   * The auto-answer path's only output, and deliberately NOT a constructor
   * parameter.
   *
   * `LoggerService` is `Scope.TRANSIENT`, so injecting it would make this
   * resolver request-scoped-adjacent and — more to the point — would add a
   * tenth positional argument to a constructor that five test files hand-wire.
   * A logger is not a collaborator any of them assert on, and a missing one
   * would surface as a TypeError inside the very catch block that exists to
   * make failures harmless. Constructed here it is always present.
   */
  private readonly logger = contextLogger(AskResolver.name);

  /**
   * Submit an ask, and — when a standing `auto` grant already authorized it —
   * ANSWER it in the same call.
   *
   * ═══ A STANDING GRANT BOUGHT NOTHING LOCALLY ═══
   *
   * `submit` returns `auto` when the owner's grant matrix pre-authorized this
   * ask; it stamps the deciding grant as the consent basis and the ceiling that
   * grant imposed, and leaves the ask `delivered`. Nothing then produced an
   * answer, because {@link runAsk} was the only answer-producing call site in
   * the codebase and it is an OWNER mutation. So the pre-authorized ask landed
   * in the owner's review inbox with an "Answer now" button beside it — exactly
   * where an UNauthorized one lands — while the FEDERATED auto path
   * (`PeerAskService.handle`) answered end to end. The owner's standing "yes,
   * always" was, locally, a standing "ask me every time".
   *
   * ═══ THIS INCREASES DISCLOSURE, WHICH IS ITS PURPOSE, SO ═══
   *
   * The answer is produced by {@link disclose} — the same method `runAsk` uses,
   * not a copy of it. The archetype clamp, the tier ceiling with its
   * sensitive-class floor, and the narrower of the captured and live grant
   * ceilings all apply unchanged, and `AskService.complete` still re-checks that
   * the deciding grant is in force before it writes anything. Nothing here
   * relaxes any of them: no disclosure is possible that an owner tapping
   * "Answer now" on the same ask would not already have produced.
   *
   * WHO RUNS IT: the RESPONDER. The pipeline reads the responder's memory and
   * every write in it is responder-scoped, so the context is built from
   * `ask.responderUserId` and never from the caller — the caller here is the
   * ASKER.
   *
   * WHAT THE ASKER LEARNS: an auto-answered ask comes back `answered` instead of
   * `delivered`, and that IS a new signal — it is also the one signal
   * {@link askerVisibleStatus} deliberately preserves ("there is an answer, go
   * and read it"), and it is unavoidable: the answer exists, and `askAnswer`
   * would hand it to them on the next round trip anyway. Everything else the
   * asker sees is unchanged — the receipt is the same constant
   * {@link ASK_ACCEPTED} whatever the grant said, the answer itself is NOT
   * attached to this payload, and `updatedAt` stays pinned to `createdAt`. The
   * federated protocol makes exactly this trade in exactly this place: an
   * auto-answered peer ask returns `answered` synchronously while every other
   * outcome returns `pending`.
   */
  @Mutation(() => CreateAskPayload)
  async createAsk(
    @Context() context: RequestContext,
    @Args('input') input: CreateAskInput,
  ): Promise<CreateAskPayload> {
    if (!(await this.enabled())) {
      return { success: false };
    }

    const serviceContext = toServiceContext(context);
    await this.rateLimitService.consume(serviceContext.userId);
    const responderUserId = GlobalUID.parse('user', input.responderId);

    const { ask, decision } = await this.askService.submit(serviceContext, {
      responderUserId,
      // Bounded and normalized before it is stored, matched, or shown to
      // anybody. The two fields the asker fully controls used to arrive as bare
      // `String`s: an unbounded prompt, and a `queryType` that could be any word
      // at all — which is the key every block grant is matched on. See
      // `asks/askInput.ts`.
      query: parseAskQueryInput(input.query),
    });

    const answered = decision === 'auto' ? await this.autoAnswer(ask) : ask;

    // The grant decision is deliberately NOT returned — see {@link ASK_ACCEPTED}.
    // `submit` still needs to make it; the asker just does not get to read it.
    return {
      success: true,
      ask: AskType.toType(answered, serviceContext.userId),
      decision: ASK_ACCEPTED,
    };
  }

  /**
   * Answer a pre-authorized ask AS ITS RESPONDER, or leave it for review.
   *
   * Returns the answered ask on success and the UNTOUCHED one on any failure.
   * A throw here would be wrong twice over. Functionally: the ask is already
   * created, already carries its consent basis, and is already answerable by
   * `runAsk`, so the owner simply answers it themselves — strictly LESS
   * disclosure, with a human in the loop. And as a side channel: only the auto
   * path can fail this way, so an error the ASKER can observe is a probe for
   * "does a standing grant cover me?", which is the whole class of oracle
   * {@link ASK_ACCEPTED} and `askerVisibleStatus` exist to close. The failure is
   * logged where the owner's operator can see it and nowhere the asker can.
   */
  private async autoAnswer(ask: Ask): Promise<Ask> {
    // An OUTBOUND ask has no local responder — it is answered by the peer's box.
    // Belt and braces (`submit` is only reached from the local create path), but
    // the responder context below would otherwise be built from a null.
    if (ask.responderUserId == null) {
      return ask;
    }

    // The RESPONDER's context, never the caller's. See {@link disclose}.
    const responderContext: UserServiceContext = { userId: ask.responderUserId };

    try {
      // ═══ THE PULL-SIDE CONSENT CHECK RUNS BEFORE THE MEMORY READ ═══
      //
      // `AskService.complete` re-checks the standing grant too, and THAT check
      // is the authoritative one — it runs inside the same transaction that
      // writes the terminal status. But it runs after the executor has already
      // read the owner's memory. Checking here as well is the ordering
      // `PeerAskService` adopted for the federated path: a consent the owner
      // withdrew between `submit` and this line means their data is never
      // touched at all, rather than read and then discarded.
      //
      // Scoped to the auto path deliberately. `isConsentStanding` asks about a
      // STANDING-GRANT pre-authorization, and an ask the owner personally
      // approved (`answering`) has none to check — that human decision is not
      // undone by revoking an unrelated grant (#2211), which is why `runAsk`
      // does not take this branch.
      if (!(await this.grantService.isConsentStanding(ask))) {
        throw new BadRequestException(
          `Ask ${ask.id} was pre-authorized by a grant that is no longer in force; it needs owner review`,
        );
      }

      // Resolved AS THE RESPONDER, who owns the link on an inbound ask. A local
      // ask carries no link, resolves to null, and takes the `household` tier.
      const link = await this.resolvePeerLink(responderContext, ask);
      const { ask: completed } = await this.disclose(responderContext, ask, {
        tier: resolveTier(ask, link, await this.householdTierFor(responderContext, ask)),
        peerHandle: link?.peerHandle ?? null,
      });

      return completed;
    } catch (err) {
      this.logger.warn(
        `Auto-answer failed for ask ${ask.id}; left for owner review: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );

      // The ask keeps its `delivered` status and its consent basis, so the owner
      // still sees it and `runAsk` can still answer it.
      return ask;
    }
  }

  @Mutation(() => AskPayload)
  async approveAsk(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<AskPayload> {
    if (!(await this.enabled())) {
      return { success: false };
    }

    const serviceContext = toServiceContext(context);
    const id = GlobalUID.parse('ask', gid);
    const ask = await this.askService.approve(serviceContext, id);

    return { success: true, ask: await this.toAskType(serviceContext, ask) };
  }

  @Mutation(() => AskPayload)
  async declineAsk(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<AskPayload> {
    if (!(await this.enabled())) {
      return { success: false };
    }

    const serviceContext = toServiceContext(context);
    const id = GlobalUID.parse('ask', gid);
    // The peer, so a REFUSAL of a federated ask is attributable in the owner's
    // history too. `PeerAskService` already stamps it on the auto-decline a block
    // grant produces; a decline the owner made by hand used to land with
    // `peer_handle` NULL — the same asymmetry as the approved disclosure that
    // `runAsk` closes.
    //
    // Read BEFORE the transition, because `decline` writes the audit row itself.
    // An ask that resolves to nothing here yields no link and falls through to
    // `decline`, which raises the not-found; this lookup must not become a second
    // error path with its own wording.
    const existing = await this.askService.findById(serviceContext, id);
    const link = existing == null ? null : await this.resolvePeerLink(serviceContext, existing);
    const ask = await this.askService.decline(serviceContext, id, { peerHandle: link?.peerHandle ?? null });

    return { success: true, ask: AskType.toType(ask, serviceContext.userId, link?.peerHandle ?? null) };
  }

  /**
   * Run an answerable ask (owner-approved, or auto-authorized) as the responder,
   * producing the disclosure-filtered answer and finalizing the ask to
   * `answered`. Only the responder may run their own asks; the query executes in
   * the responder's memory scope. `redactItemIds` is the owner's "deny all but X"
   * set — matched entity ids to withhold (counted, never itemized to the asker).
   *
   * `disclosureForm` is the owner's choice of ANSWER SHAPE — "answer this as a
   * yes/no" — and can only ever narrow what the archetype already implies (see
   * {@link narrowerForm}). Without it the shape of the answer is decided by
   * `inferAnswerForm`, which reads the ASKER's `queryType`.
   *
   * The answer carries entity id+type REFERENCES and a templated summary only —
   * never raw node content or forwardable signed media URLs.
   */
  @Mutation(() => RunAskPayload)
  async runAsk(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
    @Args('redactItemIds', { type: () => [String], nullable: true }) redactItemIds?: string[],
    @Args('disclosureForm', { type: () => AnswerFormEnum, nullable: true })
    disclosureForm?: AnswerFormEnum,
  ): Promise<RunAskPayload> {
    if (!(await this.enabled())) {
      return { success: false };
    }

    const serviceContext = toServiceContext(context);
    const id = GlobalUID.parse('ask', gid);

    const ask = await this.askService.findById(serviceContext, id);
    if (ask == null) {
      throw new NotFoundException(`Ask ${gid} not found`);
    }

    // Only the responder (memory owner) may produce the answer for their ask.
    if (ask.responderUserId !== serviceContext.userId) {
      throw new ForbiddenException('Only the responder may run this ask');
    }

    // The lifecycle gate runs HERE, before any side effect. `complete()` below
    // enforces it too, but it used to be the ONLY enforcement — and it ran after
    // `answerService.create`, so a declined ask still persisted an answer the
    // asker could read, with no audit row, before the throw. Checking first also
    // means a declined or already-answered ask never runs the search at all.
    if (!isAnswerable(ask.status, ask.consentBasis)) {
      throw new BadRequestException(`Ask ${gid} is not ready to answer (status: ${ask.status})`);
    }

    // Resolved ONCE and shared by the two things that need it — the trust tier
    // that caps this answer, and the handle stamped into the audit row. A second
    // lookup is a second chance for them to name different peers for the same
    // disclosure.
    const link = await this.resolvePeerLink(serviceContext, ask);

    // Everything that makes an answer safe — the archetype clamp, the tier
    // ceiling with its sensitive-class floor, the narrower of the captured and
    // the live grant ceilings, the disclosed-vs-backing split, and the single
    // transaction that makes the answer and its audit row inseparable — lives
    // in {@link disclose}, because the AUTO path in {@link createAsk} needs
    // exactly the same steps and a second copy of them is a second place for
    // them to drift apart.
    const {
      ask: completed,
      answer,
      disclosed,
    } = await this.disclose(serviceContext, ask, {
      tier: resolveTier(ask, link, await this.householdTierFor(serviceContext, ask)),
      peerHandle: link?.peerHandle ?? null,
      redactItemIds,
      disclosureForm: disclosureForm as AnswerForm | undefined,
    });

    return {
      success: true,
      ask: AskType.toType(completed, serviceContext.userId, link?.peerHandle ?? null),
      // The responder just ran this — they get their own true numbers.
      answer: AskAnswerType.toType(answer, true),
      disclosedCount: disclosed.disclosedCount,
      withheldCount: disclosed.withheldCount,
    };
  }

  /**
   * Turn an ALREADY-AUTHORIZED ask into a disclosure: run as the owner, clamp,
   * persist. Shared by {@link runAsk} (the owner taps "Answer now") and by the
   * standing-grant auto path in {@link createAsk}.
   *
   * ═══ WHY THIS IS ONE METHOD AND NOT TWO COPIES ═══
   *
   * There were two ways an ask could become answerable — the owner approving it
   * (`answering`) and a standing `auto` grant pre-authorizing it (`delivered`
   * plus a consent basis) — and exactly ONE piece of code that produced an
   * answer, `runAsk`. So the second way did not work. Everything that makes an
   * answer safe lives in the handful of steps between the executor and the
   * persist, and copying them into the create path would have been a second
   * place for them to drift out of step with this one.
   *
   * ═══ THE FOUR LIMITS, EACH ABLE ONLY TO REDUCE ═══
   *
   *   1. the ARCHETYPE's natural form, narrowed by the owner's explicit choice
   *      ({@link narrowerForm}) — never widened by it, because the archetype is
   *      read off the ASKER's `queryType`;
   *   2. the TIER ceiling for the class ({@link disclosureCeiling}), which is
   *      also where the sensitive-class floor lives: `health`, `financial`,
   *      `location` and their siblings clamp to `none` for every tier below
   *      `family`, and an ask naming no class at all gets the tier's floor
   *      rather than its generous `'*'` fallback;
   *   3. the ceiling CAPTURED on the ask when consent was given;
   *   4. the ceiling the owner's grants impose RIGHT NOW.
   *
   * `context` MUST be the RESPONDER's: the query runs in their memory scope and
   * every write below is responder-scoped (`AskService.responderOwned`). The
   * auto path is reached from the ASKER's request, so it constructs one from
   * `ask.responderUserId` rather than passing the caller's — this method does
   * not decide who the caller is, so the caller must have decided already.
   */
  private async disclose(
    context: UserServiceContext,
    ask: Ask,
    options: {
      /**
       * The asker's relationship tier, which sets the tier ceiling. Handed in
       * because deriving it needs the peer link, which the caller has already
       * resolved for the audit's peer handle.
       */
      tier: TrustTier;
      peerHandle?: string | null;
      /** The owner's "deny all but X" set — matched ids to withhold. */
      redactItemIds?: string[];
      /** The owner's chosen answer SHAPE. Can only narrow the archetype's. */
      disclosureForm?: AnswerForm;
    },
  ): Promise<{ ask: Ask; answer: AskAnswer; disclosed: DisclosedAnswer }> {
    // The lifecycle gate runs HERE, before any side effect. `complete()` below
    // enforces it too, but it used to be the ONLY enforcement — and it ran after
    // `answerService.create`, so a declined ask still persisted an answer the
    // asker could read, with no audit row, before the throw. Checking first also
    // means a declined or already-answered ask never runs the search at all.
    if (!isAnswerable(ask.status, ask.consentBasis)) {
      throw new BadRequestException(`Ask ${ask.id} is not ready to answer (status: ${ask.status})`);
    }

    const identifiers = await this.executorService.execute(ask);
    const matches = identifiers.map((identifier) => ({ id: identifier.id, type: identifier.type }));

    const redacted = new Set(options.redactItemIds ?? []);
    // Entities the answer is COMPUTED OVER, post-redaction. Not a disclosure —
    // the ceiling below can (and usually does) reduce what actually reaches the
    // asker to a count or a yes/no. Audited under its own name; see below.
    const backingIds = matches.filter((match) => !redacted.has(match.id)).map((match) => match.id);

    // The form is the OWNER's to choose. `inferAnswerForm` reads the
    // asker-supplied `queryType`, so with no owner choice the asker decides how
    // much shape their answer has. `narrowerForm` keeps whichever of the two
    // sits lower on the disclosure ladder, so the owner can say "just yes or no"
    // to a retrieval ask but never the reverse.
    const inferred = inferAnswerForm(ask.query);
    const form = options.disclosureForm ? narrowerForm(options.disclosureForm, inferred) : inferred;

    const built = buildDisclosedAnswer({
      form,
      matches,
      redactedIds: options.redactItemIds,
      consentBasis: ask.consentBasis,
    });

    // Phase 2 policy engine. THREE independent limits are combined, each only
    // able to reduce: the tier ceiling (what this relationship may ever
    // receive), the deciding grant's own `maxDisclosure`, and the form above.
    // A grant authorizes an ask; a ceiling caps how much any answer to it may
    // reveal — enforced separately so a mis-scoped grant cannot leak more than
    // the relationship allows.
    //
    // The grant ceiling is what this path used to drop on the floor:
    // `evaluateGrant` computes it and `AskService.submit` reads the same
    // evaluation for the consent basis, but nothing carried it here, so a grant
    // reading "digest only" still disclosed in full.
    //
    // Combined with `narrowestRung`, not `minRung(a, b ?? a)`: "this source
    // imposes no ceiling" and "no ceiling applies" are different statements,
    // and collapsing them is the shape of the escalation documented on
    // {@link resolveGrantCeiling}.
    const tierCeiling = disclosureCeiling(options.tier, ask.query.dataClass);
    const grantCeiling = await this.resolveGrantCeiling(ask);
    const ceiling = narrowestRung(tierCeiling, grantCeiling) ?? tierCeiling;
    const disclosed = applyDisclosureCeiling(built, ceiling);

    // The audit records what was ACTUALLY disclosed — which for every form but
    // `retrieval` is nothing at all. Auditing `backingIds` here (as this did)
    // made the audit and `ci.ask_answers` disagree about the same event, with
    // the audit always claiming the larger, pre-ceiling number. The candidate
    // set is still kept, under `backingEntities`, where it does not masquerade
    // as a disclosure.
    const disclosedIds = disclosed.items.map((item) => item.id);

    // One transaction: an answer with no audit row is PERMANENT, because the
    // insert-only guard in `AskAnswerService.create` rejects the retry.
    const { ask: completed, answer } = await this.askService.completeWithAnswer(context, ask.id, {
      answer: disclosed,
      disclosedEntityIds: disclosedIds,
      backingEntityIds: backingIds,
      // WHO this crossed to. Null for a local ask, and null for a federated one
      // whose link has since been deleted — the audit still carries the link id
      // off the ask row either way. Without it, the disclosure the owner
      // personally approved was the only one their history could not attribute.
      peerHandle: options.peerHandle ?? null,
    });

    return { ask: completed, answer, disclosed };
  }

  /**
   * The peer an ask belongs to, or null when it is local.
   *
   * Owner-scoped through `findById`, and that scoping is load-bearing in both
   * directions: the local participant of a federated ask is always the link's
   * owner (the asker for an outbound ask, the responder for an inbound one), so
   * a legitimate viewer resolves their own link and anybody else resolves
   * nothing rather than learning a peer's handle.
   */
  /**
   * The owner's own verdict about a LOCAL asker, or undefined for a federated
   * ask (whose tier comes from the peer link instead).
   *
   * Returns undefined rather than the default so `resolveTier` keeps ONE place
   * where "the owner said nothing" becomes `household` — two defaults for the
   * same question is how they drift.
   */
  private async householdTierFor(context: UserServiceContext, ask: Ask): Promise<TrustTier | undefined> {
    if (ask.peerLinkId != null || ask.askerUserId == null) {
      return undefined;
    }

    return this.householdTierService.tierFor(context.userId, ask.askerUserId);
  }

  private async resolvePeerLink(context: UserServiceContext, ask: Ask): Promise<PeerLink | null> {
    if (ask.peerLinkId == null) {
      return null;
    }

    return this.peerLinkService.findById(context, ask.peerLinkId);
  }

  /**
   * Project asks for the caller, resolving `peerHandle` for the federated ones.
   *
   * `AskType.peerHandle` is declared on the type and was hard-coded to null on
   * every path, while the sibling {@link AskAuditType} projection carried it —
   * so a federated ask rendered in the owner's review queue as if it had come
   * from nobody. The handle is not on `ci.asks` (only the link id is), so it has
   * to be looked up.
   *
   * One lookup per DISTINCT peer rather than per row: an inbox is usually one or
   * two peers deep, and `findById` per ask is an N+1 on the review queue. A list
   * of purely local asks never reaches the lookup at all.
   */
  private async toAskTypes(context: UserServiceContext, asks: Ask[]): Promise<AskType[]> {
    const linkIds = [...new Set(asks.map((ask) => ask.peerLinkId).filter((id): id is string => id != null))];
    const links = await Promise.all(linkIds.map((linkId) => this.peerLinkService.findById(context, linkId)));
    const handles = new Map(
      links.filter((link): link is PeerLink => link != null).map((link) => [link.id, link.peerHandle]),
    );

    return asks.map((ask) =>
      AskType.toType(ask, context.userId, ask.peerLinkId == null ? null : handles.get(ask.peerLinkId)),
    );
  }

  /** {@link toAskTypes} for a single ask. */
  private async toAskType(context: UserServiceContext, ask: Ask): Promise<AskType> {
    const [projected] = await this.toAskTypes(context, [ask]);

    return projected;
  }

  /** One of the caller's own peer links, or a 404. Never another owner's. */
  private async requirePeerLink(context: UserServiceContext, id: string): Promise<PeerLink> {
    const link = await this.peerLinkService.findById(context, id);
    if (link == null) {
      throw new NotFoundException(`Peer link ${id} not found`);
    }

    return link;
  }

  /**
   * The disclosure ceiling the owner's standing grants impose on this ask —
   * the NARROWER of what they said when consent was given and what they say
   * now.
   *
   * ═══ CLOSING CONSENT USED TO MAKE THE ANSWER BIGGER ═══
   *
   * This method used to re-derive the ceiling from the live grants alone, and
   * that "drift window" its old comment described as harmless was an
   * escalation. Every SQL read path filters `revoked_at IS NULL`, so a revoked
   * or lapsed grant is not merely stale here — it is INVISIBLE. The
   * re-evaluation then found no grant, returned no ceiling, and the ask ran
   * under the tier ceiling alone.
   *
   * On an ask the owner had already approved that is not theoretical. Status
   * `answering` is deliberately exempt from retroactive withdrawal (#2211) —
   * a human said yes to this specific ask, and revoking an unrelated standing
   * grant must not undo that — so the ask stayed answerable while its cap
   * evaporated. Reproduced against Postgres: with the grant in force the asker
   * got `items: []` and "3 matching items."; with the grant REVOKED the same
   * ask disclosed all three entity references, readable through `askAnswer`.
   *
   * It also made Revoke strictly more dangerous than Block. A live `block`
   * grant maps to `none` below; a REVOKED grant mapped to nothing at all. The
   * owner's strongest "stop" and their most complete "stop" pointed in
   * opposite directions.
   *
   * ═══ WHY CAPTURE RATHER THAN LOOK BACK ═══
   *
   * The alternative was to keep re-deriving and teach the read path to include
   * revoked grants. That fails on the review path, which stores no consent
   * basis at all: there is no grant to look back at, and the ceiling the owner
   * approved under would still be unrecoverable. So the ceiling is stamped on
   * the ask at the moment consent is given ({@link AskService.approve} and the
   * auto path in `submit`) and read from there.
   *
   * The two sources are combined with {@link narrowestRung}, never with `??`.
   * A source that says nothing must not erase one that does — that is exactly
   * the bug — so:
   *
   * - a revoked or lapsed grant leaves the captured ceiling standing (it
   *   floors the answer at its last known value);
   * - a `deny` still maps to `none`, so a block written AFTER consent tightens
   *   the answer to nothing, as it always did;
   * - a grant SUPERSEDED by a more generous one cannot raise the captured cap
   *   either, which is the same monotonicity from the other direction.
   *
   * A NULL capture is honest rather than unknown: it means no grant capped
   * this ask when the owner consented, and the live evaluation is then the only
   * grant-side ceiling there is (the pre-existing behaviour, and correct).
   */
  private async resolveGrantCeiling(ask: Ask): Promise<DisclosureRung | undefined> {
    const evaluation = await this.grantService.evaluate(ask);
    const live = evaluation.decision === 'deny' ? 'none' : evaluation.maxDisclosure;

    return narrowestRung(ask.disclosureCeiling, live);
  }

  /** The disclosure-filtered answer for an ask (visible to asker or responder). */
  @Query(() => AskAnswerType, { nullable: true })
  async askAnswer(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<AskAnswerType | null> {
    if (!(await this.enabled())) {
      return null;
    }

    const serviceContext = toServiceContext(context);
    const id = GlobalUID.parse('ask', gid);
    // Enforce visibility via the parent ask (asker or responder only).
    const ask = await this.askService.findById(serviceContext, id);
    if (ask == null) {
      return null;
    }

    // Participation is not enough. An answer row can exist for an ask that never
    // reached a terminal answered state — that is exactly what the ordering bug
    // above produced — so the status is what decides whether it may be read.
    if (ask.status !== 'answered') {
      return null;
    }

    const answer = await this.answerService.findByAskId(id);

    return answer ? AskAnswerType.toType(answer, ask.responderUserId === serviceContext.userId) : null;
  }

  /**
   * Send an ask to a linked peer Companion — the OUTBOUND half of federation.
   *
   * The peer's box applies its owner's consent rules; this box learns only the
   * outcome. A declined result is indistinguishable from an unreachable peer.
   */
  @Mutation(() => SendPeerAskPayload)
  async sendPeerAsk(
    @Context() context: RequestContext,
    @Args('input') input: SendPeerAskInput,
  ): Promise<SendPeerAskPayload> {
    if (!(await this.enabled())) {
      return { success: false };
    }

    const serviceContext = toServiceContext(context);
    // Outbound asks consume the same per-user budget as local ones, so a
    // compromised client cannot use the peer path to bypass the limit.
    await this.rateLimitService.consume(serviceContext.userId);

    const request = toPeerAskRequest(input);

    const { ask, response } = await this.outboundAskService.send(
      serviceContext,
      { handle: input.handle, prompt: input.prompt, request },
      input.peerAccessToken,
    );

    return {
      success: true,
      // The handle is the one the caller addressed, so no lookup is needed to
      // say who this outbound ask went to.
      ask: AskType.toType(ask, undefined, input.handle),
      status: response.status,
      reason: response.reason,
    };
  }

  @Mutation(() => AskGrantPayload)
  async createAskGrant(
    @Context() context: RequestContext,
    @Args('input') input: CreateAskGrantInput,
  ): Promise<AskGrantPayload> {
    if (!(await this.enabled())) {
      return { success: false };
    }

    const serviceContext = toServiceContext(context);

    // Exactly one grantee kind, checked HERE rather than left to the DB. The
    // CHECK constraint `ask_grants_grantee_chk` is the right backstop and it
    // stays, but it surfaces as a 500 carrying a constraint name; a client can
    // only act on a 400 that names the two fields. `GrantService.create` repeats
    // the rule for callers that never pass through GraphQL.
    const hasUser = input.granteeId != null;
    const hasPeer = input.granteePeerLinkId != null;
    if (hasUser === hasPeer) {
      throw new BadRequestException('A grant must name exactly one of granteeId / granteePeerLinkId');
    }

    // A peer link id is resolved through the OWNER-SCOPED read before it is
    // stored, for two reasons: an id naming no link lands as a
    // `ask_grants_grantee_peer_link_id_fkey` violation (another 500), and an id
    // naming somebody else's link would otherwise be storable — an owner writing
    // consent against a relationship that is not theirs.
    const granteePeerLinkId = input.granteePeerLinkId
      ? (await this.requirePeerLink(serviceContext, input.granteePeerLinkId)).id
      : null;

    const grant = await this.grantService.create(serviceContext, {
      granteeUserId: input.granteeId ? GlobalUID.parse('user', input.granteeId) : null,
      granteePeerLinkId,
      // The SAME closed vocabulary the ask side is now held to. An owner who
      // writes `block` on a word no ask can ever carry has written nothing, and
      // the Grant Manager would show it back to them as live protection — so
      // constraining only the reading end would turn "I blocked this" and "this
      // is blocked" into two different statements. See `parseAskQueryType`.
      queryType: parseGrantQueryType(input.queryType),
      dataClass: input.dataClass ?? null,
      // `scope` used to be hard-coded to `{ dataClasses }` or null, which is why
      // `maxDisclosure` had three readers and no writer — the owner's disclosure
      // ceiling was unreachable from the API that creates grants. Built from
      // every scope dimension the input carries, and left NULL when it carries
      // none, so an unscoped grant still stores null rather than `{}`.
      scope: toGrantScope(input) ?? null,
      mode: input.mode as GrantMode,
      purpose: input.purpose ?? null,
    });

    return { success: true, grant: AskGrantType.toType(grant) };
  }

  @Mutation(() => AskGrantPayload)
  async revokeAskGrant(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<AskGrantPayload> {
    if (!(await this.enabled())) {
      return { success: false };
    }

    const serviceContext = toServiceContext(context);
    const id = GlobalUID.parse('ask-grant', gid);
    const grant = await this.grantService.revoke(serviceContext, id);

    return { success: true, grant: AskGrantType.toType(grant) };
  }

  /** The responder's review inbox (asks awaiting a decision). */
  @Query(() => [AskType])
  async askInbox(@Context() context: RequestContext): Promise<AskType[]> {
    if (!(await this.enabled())) {
      return [];
    }

    const serviceContext = toServiceContext(context);
    const rows = await this.askService.listInbox(serviceContext);

    return this.toAskTypes(serviceContext, rows);
  }

  /** The asker's outbox (asks I have sent). */
  @Query(() => [AskType])
  async askOutbox(@Context() context: RequestContext): Promise<AskType[]> {
    if (!(await this.enabled())) {
      return [];
    }

    const serviceContext = toServiceContext(context);
    const rows = await this.askService.listOutbox(serviceContext);

    return this.toAskTypes(serviceContext, rows);
  }

  @Query(() => AskType, { nullable: true })
  async ask(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<AskType | null> {
    if (!(await this.enabled())) {
      return null;
    }

    const serviceContext = toServiceContext(context);
    const id = GlobalUID.parse('ask', gid);
    const found = await this.askService.findById(serviceContext, id);

    return found ? this.toAskType(serviceContext, found) : null;
  }

  /**
   * Put ONE question to several people at once.
   *
   * Each recipient gets their own independent ask — their own grants decide it,
   * their own tier caps it, their own inbox reviews it. The broadcast is only
   * a correlation, so nothing about the group changes what any one of them
   * discloses. See {@link AskBroadcastService}.
   *
   * ═══ THE N DECISIONS DO NOT LEAVE THIS METHOD ═══
   *
   * `submit` makes one grant decision per recipient, and each is a read on that
   * responder's grant matrix. `createAsk` returns the constant
   * {@link ASK_ACCEPTED} for exactly this reason; a broadcast returning N
   * decisions would hand back N probes for the price of one request. They are
   * used here to run the auto-answer pipeline and then dropped.
   */
  @Mutation(() => AskBroadcastType)
  async createAskBroadcast(
    @Context() context: RequestContext,
    @Args('input') input: CreateAskBroadcastInput,
  ): Promise<AskBroadcastType> {
    if (!(await this.enabled())) {
      throw new BadRequestException('Asks are not enabled');
    }

    const serviceContext = toServiceContext(context);
    // Rate-limited as ONE ask, because it is one request — and then bounded
    // again by MAX_BROADCAST_RECIPIENTS, which is what actually stops one
    // request filling N inboxes. See that constant.
    await this.rateLimitService.consume(serviceContext.userId);

    const { broadcast, members } = await this.broadcastService.create(serviceContext, {
      responderUserIds: input.responderIds.map((id) => GlobalUID.parse('user', id)),
      query: parseAskQueryInput(input.query),
    });

    // Sequentially, for the same reason `create` submits sequentially: each
    // auto-answer runs a search in a responder's memory.
    const asks = [];
    for (const member of members) {
      asks.push(member.decision === 'auto' ? await this.autoAnswer(member.ask) : member.ask);
    }

    return AskBroadcastType.toType(broadcast, asks);
  }

  /** The caller's own broadcasts, newest first. Asker-scoped in the service. */
  @Query(() => [AskBroadcastType])
  async myAskBroadcasts(@Context() context: RequestContext): Promise<AskBroadcastType[]> {
    if (!(await this.enabled())) {
      return [];
    }

    const serviceContext = toServiceContext(context);
    const broadcasts = await this.broadcastService.listForAsker(serviceContext);
    // ONE read for every child ask, rather than a query per broadcast.
    const asks = await this.broadcastService.asksForBroadcasts(broadcasts.map((b) => b.id));

    return broadcasts.map((broadcast) => AskBroadcastType.toType(broadcast, asks.get(broadcast.id) ?? []));
  }

  /**
   * The tiers this owner has assigned to other LOCAL accounts.
   *
   * Only rows they have ACTIVELY SET. An account with no row is at the default,
   * and inventing a row for every local user would turn "I have not thought
   * about this" into "I decided household", which is a different statement.
   */
  @Query(() => [HouseholdTierType])
  async myHouseholdTiers(@Context() context: RequestContext): Promise<HouseholdTierType[]> {
    if (!(await this.enabled())) {
      return [];
    }

    const rows = await this.householdTierService.listForOwner(toServiceContext(context));

    return rows.map(HouseholdTierType.toType);
  }

  /**
   * Demote (or restore) another local account.
   *
   * The mutation G6 and threat T1 name as missing: until it existed, a
   * housemate was by construction the most privileged asker on the box, with
   * the widest ceiling, exempt from the sensitive-class floor, and no way to
   * change it.
   *
   * Owner-scoped in the service, so one member of a household cannot edit
   * another's posture — which is not a nicety, since in exactly the households
   * this feature is least safe in, that would be the whole attack.
   */
  @Mutation(() => HouseholdTierType)
  async setHouseholdTier(
    @Context() context: RequestContext,
    @Args('input') input: SetHouseholdTierInput,
  ): Promise<HouseholdTierType> {
    if (!(await this.enabled())) {
      throw new BadRequestException('Asks are not enabled');
    }

    const memberId = GlobalUID.parse('user', input.memberId);
    const row = await this.householdTierService.setTier(toServiceContext(context), memberId, input.trustTier);

    return HouseholdTierType.toType(row);
  }

  /** Standing grants owned by the caller (the Grant Manager). */
  @Query(() => [AskGrantType])
  async myAskGrants(@Context() context: RequestContext): Promise<AskGrantType[]> {
    if (!(await this.enabled())) {
      return [];
    }

    const serviceContext = toServiceContext(context);
    // ONE usage read for the whole list, joined in memory. A per-grant lookup
    // here would be an N+1 over the audit table, on the tab an owner opens to
    // scan every grant at once.
    const [rows, usage] = await Promise.all([
      this.grantService.listForOwner(serviceContext),
      this.auditService.usageByGrant(serviceContext),
    ]);

    return rows.map((row) => AskGrantType.toType(row, usage.get(row.id)));
  }

  /** The caller's disclosure history (asks they responded to), newest first. */
  @Query(() => AskDisclosureHistoryPayload)
  async askDisclosureHistory(
    @Context() context: RequestContext,
    @Args('input', { nullable: true }) input?: AskDisclosureHistoryInput,
  ): Promise<AskDisclosureHistoryPayload> {
    if (!(await this.enabled())) {
      return { rows: [], truncated: false };
    }

    const { rows, truncated } = await this.auditService.listForResponder(
      toServiceContext(context),
      toAuditFilter(input),
    );

    return { rows: rows.map(AskAuditType.toType), truncated };
  }

  /**
   * The same record, folded BY RELATIONSHIP — the unit an owner arrives with.
   *
   * Responder-scoped by exactly the same service call the flat history uses, so
   * there is one place where "whose disclosures are these" is decided. A second
   * scoping clause here would be a second place to get it wrong.
   */
  @Query(() => AskDisclosureSummaryPayload)
  async askDisclosureSummary(
    @Context() context: RequestContext,
    @Args('input', { nullable: true }) input?: AskDisclosureSummaryInput,
  ): Promise<AskDisclosureSummaryPayload> {
    if (!(await this.enabled())) {
      return { summaries: [], truncated: false };
    }

    const { summaries, truncated } = await this.auditService.summaryForResponder(toServiceContext(context), {
      windowMs: windowMsFrom(input?.windowDays),
    });

    return { summaries: summaries.map(AskDisclosureSummaryType.toType), truncated };
  }

  /**
   * CHANGE a standing grant — the Grant Manager matrix's core interaction
   * (`onChangeMode(grantId, mode)`), which until now had no backing mutation at
   * all. The only expressible "change" was `createAskGrant` a second time, which
   * left BOTH rows live and both matching the same asks.
   *
   * The change is applied as a supersede rather than an in-place update, so the
   * previous posture stays on the record; see `GrantService.supersede`. The
   * returned grant is the NEW row — its `supersedesGrantId` names the one it
   * replaced, and `myAskGrantHistory` shows both.
   *
   * This works on a PEER grant unchanged, and deliberately takes no grantee
   * input: `supersede` copies `granteePeerLinkId` (like `granteeUserId`) onto the
   * replacement, because the grantee is part of WHICH grant this is. That is also
   * what keeps the replacement on the right side of `ask_grants_grantee_chk` —
   * a change that let the caller name a grantee could turn a peer grant into a
   * user grant, or into a row naming both.
   */
  @Mutation(() => AskGrantPayload)
  async updateAskGrant(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
    @Args('input') input: UpdateAskGrantInput,
  ): Promise<AskGrantPayload> {
    if (!(await this.enabled())) {
      return { success: false };
    }

    const serviceContext = toServiceContext(context);
    const id = GlobalUID.parse('ask-grant', gid);

    // `clearExpiry` and `expiresAt` are contradictory instructions, and guessing
    // which one the caller meant is how a grant ends up permanent by accident.
    if (input.clearExpiry === true && input.expiresAt != null) {
      throw new BadRequestException('Pass either expiresAt or clearExpiry, not both');
    }

    const expiresAt = input.clearExpiry === true ? null : input.expiresAt;

    const grant = await this.grantService.supersede(serviceContext, id, {
      mode: input.mode as GrantMode | undefined,
      dataClass: input.dataClass,
      // An omitted scope dimension inherits the previous grant's value for THAT
      // dimension — `GrantService.supersede` merges rather than assigns, so
      // narrowing `dataClasses` no longer deletes `maxDisclosure`. `undefined`
      // here (neither dimension supplied) inherits the scope whole; an empty
      // `dataClasses` list is a real instruction ("no classes"), not an absence.
      scope: toGrantScope(input),
      purpose: input.purpose,
      expiresAt,
    });

    return { success: true, grant: AskGrantType.toType(grant) };
  }

  /**
   * Every grant the caller ever wrote, newest first — revoked, lapsed and
   * superseded included.
   *
   * Separate from {@link myAskGrants} (which stays active-only) because the two
   * answer different questions: that one is "what am I sharing?", this one is
   * "what have I ever shared, and what happened to it?". History is also what
   * lets a disclosure-history row resolve a `consentBasis` naming a grant that
   * has since been revoked — before this, every read path filtered revoked
   * grants out, so that basis resolved to nothing.
   */
  @Query(() => [AskGrantType])
  async myAskGrantHistory(@Context() context: RequestContext): Promise<AskGrantType[]> {
    if (!(await this.enabled())) {
      return [];
    }

    const serviceContext = toServiceContext(context);
    const [rows, usage] = await Promise.all([
      this.grantService.listHistoryForOwner(serviceContext),
      this.auditService.usageByGrant(serviceContext),
    ]);

    // Usage is carried on revoked and superseded rows too: "this fired 40 times
    // before I withdrew it" is exactly what a consent history is for.
    return rows.map((row) => AskGrantType.toType(row, usage.get(row.id)));
  }

  /**
   * One of the caller's own grants by id, in ANY lifecycle state — the lookup
   * behind "what was the basis for this disclosure?" when the grant behind it
   * has since been revoked.
   */
  @Query(() => AskGrantType, { nullable: true })
  async askGrant(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<AskGrantType | null> {
    if (!(await this.enabled())) {
      return null;
    }

    const serviceContext = toServiceContext(context);
    const id = GlobalUID.parse('ask-grant', gid);
    const grant = await this.grantService.findByIdForOwner(serviceContext, id);

    return grant ? AskGrantType.toType(grant) : null;
  }

  private async enabled(): Promise<boolean> {
    return this.featureService.isFeatureEnabled('ask');
  }
}

/**
 * The same predicate `AskService.complete` enforces: an ask is answerable once
 * the owner has approved it (`answering`), or when a standing grant already
 * authorized it (`delivered` carrying a consent basis). Kept in sync with
 * AskService.complete — both must agree or the gate is bypassable.
 */
/**
 * Build the grant's structured scope from the flat mutation input.
 *
 * Shared by create and update so the two cannot disagree about which input
 * fields are scope dimensions — they already had, which is how `maxDisclosure`
 * ended up with readers and no writer while `dataClasses` was wired on both.
 *
 * Returns `undefined`, never `{}`, when the input names no scope dimension at
 * all: the two callers read that absence differently and both readings are
 * load-bearing. `create` turns it into a NULL scope column (this grant has no
 * scope); `supersede` treats it as "leave the previous scope alone" and inherits
 * it whole. An empty object would tell create to store `{}` and tell supersede
 * to merge nothing — the same value meaning two different, wrong things.
 */
function toGrantScope(input: {
  dataClasses?: string[];
  maxDisclosure?: string;
  delegation?: string;
}): AskGrantScope | undefined {
  const scope: AskGrantScope = {
    // An empty `dataClasses` list is a real instruction ("no classes permitted"),
    // so the presence test is `!= null`, not truthiness.
    ...(input.dataClasses != null ? { dataClasses: input.dataClasses } : {}),
    ...(input.maxDisclosure != null ? { maxDisclosure: input.maxDisclosure as DisclosureRung } : {}),
    ...parseDelegation(input.delegation),
  };

  return Object.keys(scope).length > 0 ? scope : undefined;
}

/**
 * Parse the owner's delegation setting, REJECTING anything off-vocabulary.
 *
 * Same direction as `parseDisclosureRung` and for the same reason: this is the
 * WRITE boundary. `actorSatisfiesDelegation` fails closed when it READS an
 * unreadable value, which is right there — but silently storing a restriction
 * that will later be read as "deny everything" hands the owner a grant that
 * never fires and no explanation of why. A 400 they can act on is the honest
 * answer.
 *
 * Returns a spreadable object so an omitted value adds no key at all, keeping
 * `toGrantScope`'s "empty scope means undefined" contract intact.
 */
function parseDelegation(raw: string | undefined): { delegation?: AskDelegation } {
  if (raw == null) {
    return {};
  }

  const canonical = raw.trim().toLowerCase();
  const known: AskDelegation[] = ['none', 'first-party-only', 'any-agent'];

  if (!(known as string[]).includes(canonical)) {
    throw new BadRequestException(`delegation must be one of: ${known.join(', ')}`);
  }

  return { delegation: canonical as AskDelegation };
}

/** A {@link LoggerService} already tagged with its owner's name. */
function contextLogger(context: string): LoggerService {
  const logger = new LoggerService();
  logger.setContext(context);

  return logger;
}

/**
 * The asker's relationship tier, which sets the disclosure ceiling.
 *
 * A local ask comes from a member of the owner's own box (`household`). An ask
 * carrying a peer link is federated, so the tier is the one the owner assigned
 * that peer — and a link that has since been revoked or deleted resolves to
 * `stranger`, the strictest posture, rather than silently widening.
 *
 * Takes the already-resolved link rather than fetching one, so the tier and the
 * audit row's peer handle are decided from the SAME read.
 *
 * Pure.
 */
function resolveTier(ask: Ask, link: PeerLink | null, householdTier?: TrustTier): TrustTier {
  if (ask.peerLinkId == null) {
    // A LOCAL asker. This used to be a bare `return 'household'` — the widest
    // ceiling on the ladder and the only tier exempt from the sensitive-class
    // floor — with no column, mutation or UI that could say otherwise. That is
    // G6, and threat T1: the person who shares the appliance was by
    // construction the most privileged asker and could not be demoted.
    //
    // `householdTier` is the owner's own verdict about that account, and
    // omitting it still yields `household` so nothing changes for a box where
    // the owner has said nothing. See `HouseholdTierService`.
    return householdTier ?? 'household';
  }

  return (link?.trustTier as TrustTier | undefined) ?? 'stranger';
}

/**
 * Narrow the flat GraphQL input back to the discriminated protocol shape.
 *
 * Fields belonging to other archetypes are DROPPED rather than passed through,
 * so a caller cannot smuggle (say) a content `dataClass` into an availability
 * request and have the peer interpret it.
 */
function toPeerAskRequest(input: SendPeerAskInput): PeerAskRequest {
  switch (input.archetype) {
    case 'availability':
      if (!input.from || !input.to) {
        throw new BadRequestException('An availability ask requires from and to');
      }

      return {
        archetype: 'availability',
        from: input.from,
        to: input.to,
        minMinutes: input.minMinutes,
        purpose: input.purpose,
      } as PeerAskRequest;
    case 'relationship':
      if (!input.subject) {
        throw new BadRequestException('A relationship ask requires a subject');
      }

      return { archetype: 'relationship', subject: input.subject } as PeerAskRequest;
    case 'content':
      if (!input.subject) {
        throw new BadRequestException('A content ask requires a subject');
      }

      return {
        archetype: 'content',
        subject: input.subject,
        dataClass: input.dataClass,
        from: input.from,
        to: input.to,
      } as PeerAskRequest;
    default:
      throw new BadRequestException(`Unsupported ask archetype: ${input.archetype}`);
  }
}

/**
 * Translate the GraphQL filter into the service's, resolving the counterparty
 * key back into the column it came from.
 *
 * A key that names neither column narrows to NOTHING rather than to everything.
 * An unrecognized filter that silently widens the read is the shape of bug this
 * whole domain keeps closing — an omitted `dataClass` that read as a wildcard,
 * an unreadable ceiling that read as no ceiling. Same rule here.
 */
function toAuditFilter(input?: AskDisclosureHistoryInput): AuditFilter {
  const filter: AuditFilter = {
    from: input?.from ?? null,
    to: input?.to ?? null,
    limit: input?.limit ?? null,
    outcomes: parseOutcomes(input?.outcomes),
  };

  const key = input?.counterpartyKey?.trim();
  if (!key) {
    return filter;
  }

  if (key.startsWith('user:')) {
    return { ...filter, askerUserId: key.slice('user:'.length) };
  }

  if (key.startsWith('peer:')) {
    return { ...filter, peerLinkId: key.slice('peer:'.length) };
  }

  if (key === UNATTRIBUTED) {
    // Rows naming neither party. Expressed as explicit nulls so the service
    // filters on them rather than dropping the clause.
    return { ...filter, askerUserId: null, peerLinkId: null };
  }

  // A key we do not recognize. Narrow to nothing.
  return { ...filter, askerUserId: NO_SUCH_ID };
}

/**
 * A uuid that cannot match any row, for the unrecognized-key case.
 *
 * The nil uuid rather than a random one so the behaviour is deterministic, and
 * a uuid rather than a sentinel string because the column is typed and Postgres
 * would reject anything else with a 22P02 — a 500 where a clean empty result
 * belongs.
 */
const NO_SUCH_ID = '00000000-0000-0000-0000-000000000000';

/** Keep only outcomes the audit actually records; anything else is dropped. */
function parseOutcomes(outcomes?: readonly string[]): AskAuditOutcome[] | undefined {
  if (outcomes == null || outcomes.length === 0) {
    return undefined;
  }

  const known: AskAuditOutcome[] = ['answered', 'auto_answered', 'declined', 'expired'];
  const kept = outcomes.filter((o): o is AskAuditOutcome => (known as string[]).includes(o));

  // An all-unrecognized list must not read as "no filter" — that would WIDEN
  // the read on a typo. One impossible value keeps it narrow.
  return kept.length > 0 ? kept : ['__none__' as AskAuditOutcome];
}

/** Days -> ms, with anything unreadable falling back to the default window. */
function windowMsFrom(days?: number | null): number | undefined {
  if (days == null || !Number.isFinite(days) || days <= 0) {
    return undefined;
  }

  return Math.trunc(days) * 24 * 60 * 60 * 1000;
}
