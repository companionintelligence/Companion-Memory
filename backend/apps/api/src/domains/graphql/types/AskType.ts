import { Field, GraphQLISODateTime, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';

import {
  isGrantActive,
  type Ask,
  type AskAudit,
  type AskGrant,
  type AskQuery,
  type DisclosureSummary,
  type GrantUsage,
  type AskBroadcast,
} from '@ci/domains/asks';

import { GlobalUID } from './GlobalUID';

export enum AskStatusEnum {
  sent = 'sent',
  delivered = 'delivered',
  under_review = 'under_review',
  answering = 'answering',
  answered = 'answered',
  declined = 'declined',
  expired = 'expired',
}
registerEnumType(AskStatusEnum, { name: 'AskStatus' });

export enum GrantModeEnum {
  auto = 'auto',
  review = 'review',
  block = 'block',
}
registerEnumType(GrantModeEnum, { name: 'GrantMode' });

export enum AskAuditOutcomeEnum {
  answered = 'answered',
  auto_answered = 'auto_answered',
  declined = 'declined',
  expired = 'expired',
}
registerEnumType(AskAuditOutcomeEnum, { name: 'AskAuditOutcome' });

/** What made an ask — a person, or software acting for them. */
@ObjectType()
export class AskActorType {
  @Field(() => String)
  kind!: string;

  /** Display only. Never matched on — see `actorSatisfiesDelegation`. */
  @Field(() => String, { nullable: true })
  label!: string | null;
}

/** The bounded, asker-supplied query carried by an ask. */
@ObjectType()
export class AskQueryType {
  @Field(() => String)
  queryType!: string;

  @Field(() => String, { nullable: true })
  dataClass!: string | null;

  @Field(() => String)
  prompt!: string;

  /**
   * What made this ask, when the asker declared it. Null means they did not —
   * which is itself the reason a delegation-restricted grant will not
   * auto-answer it.
   */
  @Field(() => AskActorType, { nullable: true })
  actor!: AskActorType | null;

  /**
   * The purpose the asker stated, lifted out of `filters` for display.
   *
   * A first-class field on the OUTPUT even though it lives in `filters` on the
   * way in: the consent surface renders it, and making every client reach into
   * an untyped bag for a consent-relevant fact is how it ends up unrendered.
   * Null means none was stated — which is itself an input to the decision.
   */
  @Field(() => String, { nullable: true })
  purpose!: string | null;

  static toType(query: AskQuery): AskQueryType {
    return {
      queryType: query.queryType,
      dataClass: query.dataClass ?? null,
      prompt: query.prompt,
      actor: query.actor ? { kind: query.actor.kind, label: query.actor.label ?? null } : null,
      // Only a string counts. `filters` is jsonb and a non-string there is not
      // a purpose somebody stated — rendering `[object Object]` beside "they
      // say this is for" would be worse than showing nothing.
      purpose: typeof query.filters?.purpose === 'string' ? query.filters.purpose : null,
    };
  }
}

/** An interpersonal ask directed at another user's memory. */
/**
 * HOW an ask arrived — the channel facts, beside the consent facts.
 *
 * Present only when the request carried a verified RFC 9421 signature. Its
 * ABSENCE is the answer for every other ask: an unsigned channel, which the
 * surfaces state plainly rather than leaving blank. An owner who cannot tell
 * "unsigned" from "not recorded" cannot use the distinction at all.
 */
@ObjectType()
export class AskChannelType {
  /** RFC 7638 thumbprint of the key that signed the request, as of arrival. */
  @Field(() => String)
  keyThumbprint!: string;

  /**
   * When THIS box verified the signature — not the sender's `created`, which is
   * their claim about when they signed it.
   */
  @Field(() => GraphQLISODateTime)
  verifiedAt!: Date;

  /** The signature base's covered components, as actually presented. */
  @Field(() => [String])
  covered!: string[];

  static toType(ask: Ask): AskChannelType | null {
    if (ask.channelKeyThumbprint == null || ask.channelVerifiedAt == null) {
      return null;
    }

    return {
      keyThumbprint: ask.channelKeyThumbprint,
      verifiedAt: ask.channelVerifiedAt,
      covered: ask.channelCovered ?? [],
    };
  }
}

@ObjectType()
export class AskType {
  @Field(() => ID)
  id!: string;

  /** Opaque user id of the asker. NULL for an inbound peer ask. */
  @Field(() => ID, { nullable: true })
  askerId!: string | null;

  /**
   * The peer this ask came from (inbound) or was sent to (outbound).
   *
   * Resolved by the caller, because `ci.asks` stores only the peer LINK ID and
   * the handle lives in the peers domain. Callers that do not resolve it get
   * null — which is the honest answer for a local ask, and for a federated one
   * whose link the viewer does not own.
   */
  @Field(() => String, { nullable: true })
  peerHandle!: string | null;

  /** 'local' | 'outbound' | 'inbound'. */
  @Field(() => String)
  direction!: string;

  /** Opaque user id of the responder (owner). */
  /** NULL for an OUTBOUND ask — the responder is the peer, not a local user. */
  @Field(() => ID, { nullable: true })
  responderId!: string | null;

  @Field(() => AskQueryType)
  query!: AskQueryType;

  /**
   * The ask's lifecycle state — FULL for the responder, collapsed for the
   * asker. See {@link askerVisibleStatus}.
   */
  @Field(() => AskStatusEnum)
  status!: AskStatusEnum;

  /**
   * The grant (or review) that authorized an answer, once decided.
   *
   * RESPONDER-ONLY. This is the id of one of the responder's own grant rows, and
   * handing it to the asker made `createAsk` a grant-matrix oracle: combined with
   * the returned decision it distinguishes auto from review from deny, at the
   * rate limit's 20 probes a minute, and on a block-grant auto-deny it separates
   * a standing block from a human refusal. The asker needs to know their ask was
   * accepted; they do not need the identifier of the rule that accepted it.
   */
  @Field(() => String, { nullable: true })
  consentBasis!: string | null;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  /**
   * When the ask was last touched — REAL for the responder, pinned to
   * `createdAt` for the asker. See {@link askerVisibleUpdatedAt}.
   */
  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;

  @Field(() => GraphQLISODateTime, { nullable: true })
  expiresAt!: Date | null;

  /**
   * How this ask arrived. RESPONDER-ONLY, for the same reason
   * {@link consentBasis} is: it describes what the RESPONDER's box checked and
   * accepted, and the asker — who signed the request themselves and already
   * knows — gains nothing from it but a probe into the responder's
   * configuration (is `requireHttpSignature` on? which of my keys does this box
   * hold?). Null means an unsigned channel.
   */
  @Field(() => AskChannelType, { nullable: true })
  channel!: AskChannelType | null;

  /**
   * Correlates asks the ASKER sent as one question to several people.
   *
   * ASKER-ONLY, and that is the mirror image of {@link consentBasis} being
   * responder-only. Who else was asked is a fact about the ASKER's
   * relationships — a responder learning it would be a third-party disclosure
   * nobody consented to, of the same shape as the peer handle and the decline
   * oracle this domain closes elsewhere.
   */
  @Field(() => ID, { nullable: true })
  broadcastId!: string | null;

  /**
   * `viewerUserId` decides whether the responder's private reasoning is
   * included. Callers that omit it get the safe projection — an omitted argument
   * must never be the disclosing case.
   *
   * `peerHandle` is likewise an argument rather than something read off the ask:
   * the ask carries a peer LINK ID, and turning that into a handle takes a read
   * of the peers domain that this pure projection cannot do. It was hard-coded
   * to `null` here while {@link AskAuditType} — the sibling projection over the
   * same federated event — carried it, so every federated ask rendered as though
   * it had come from nobody. Omitted still means null, so the safe projection is
   * still the default one.
   */
  static toType(ask: Ask, viewerUserId?: string, peerHandle?: string | null): AskType {
    const isResponder = viewerUserId != null && viewerUserId === ask.responderUserId;

    return {
      id: GlobalUID.encode('ask', ask.id),
      askerId: ask.askerUserId ? GlobalUID.encode('user', ask.askerUserId) : null,
      // Never a handle without a link to hang it on: a local ask has no peer, and
      // saying otherwise would put a name on a disclosure that never left the box.
      peerHandle: (ask.peerLinkId == null ? null : peerHandle) ?? null,
      direction: ask.direction,
      responderId: ask.responderUserId ? GlobalUID.encode('user', ask.responderUserId) : null,
      query: AskQueryType.toType(ask.query),
      status: isResponder ? (ask.status as AskStatusEnum) : askerVisibleStatus(ask.status),
      consentBasis: isResponder ? ask.consentBasis : null,
      createdAt: ask.createdAt,
      updatedAt: isResponder ? ask.updatedAt : askerVisibleUpdatedAt(ask),
      expiresAt: ask.expiresAt,
      channel: isResponder ? AskChannelType.toType(ask) : null,
      // The ONE field on this type that is asker-only rather than
      // responder-only. `isResponder` is not simply negated: a viewer who is
      // neither party gets null from both branches, which is the safe default
      // an omitted `viewerUserId` must always land on.
      broadcastId:
        viewerUserId != null && viewerUserId === ask.askerUserId ? ask.broadcastId : null,
    };
  }
}

/**
 * What the ASKER is allowed to know about an ask's lifecycle: whether an answer
 * is waiting, and nothing else.
 *
 * ═══ THE ORACLE #2210 MOVED INSTEAD OF CLOSING ═══
 *
 * `CreateAskPayload.decision` was collapsed to the constant `ASK_ACCEPTED`
 * because the raw `auto` | `review` | `deny` told the asker the responder's
 * standing-grant posture. The SAME information stayed reachable on the same
 * payload through `ask.status`, one field along — and reproduced exactly that
 * way against Postgres: a block grant returned `status: 'declined'`, an auto
 * grant `'delivered'`, and no matching grant `'under_review'`. Three probes,
 * three distinguishable answers, bounded only by the rate limit.
 *
 * Masking it on `CreateAskPayload` alone would have moved it a second time: the
 * asker is a participant, so `ask(id)` and `askOutbox` hand them the same row
 * one round-trip later. The cut is therefore made HERE, in the projection that
 * already knows who is looking and already withholds `consentBasis` from the
 * asker for exactly this reason — one place, every read path.
 *
 * The collapse follows {@link ASK_ACCEPTED}'s own argument to its conclusion:
 *
 * - `declined` → `delivered`. Whether a block grant refused the ask, or the
 *   owner declined it after reading it, or the owner simply has not got to it,
 *   are indistinguishable to the asker. `SendPeerAskPayload` already makes this
 *   trade across a box boundary ("a declined result is deliberately
 *   indistinguishable from an unreachable peer"); this makes it inside one.
 * - `under_review` / `answering` → `delivered`. That an ask reached a human, or
 *   that the human approved it, is the responder's business until an answer
 *   exists.
 * - `expired` → `delivered`. The asker already holds `expiresAt` and can read
 *   their own clock, so the state adds nothing — and leaving it visible would
 *   restore the deny/expire contrast by another name.
 * - `answered` survives, because it is the one thing the asker legitimately
 *   needs: there is an answer, go and read it. A blocked ask never acquires
 *   one, which is the same shape as a responder who never got around to it.
 *
 * Pure.
 */
export function askerVisibleStatus(status: string): AskStatusEnum {
  return status === 'answered' ? AskStatusEnum.answered : AskStatusEnum.delivered;
}

/**
 * What the ASKER is allowed to know about WHEN their ask was last touched:
 * nothing past the moment they sent it.
 *
 * ═══ THE TIMING CHANNEL #2216 LEFT OPEN ═══
 *
 * Collapsing `status` closed the state oracle and left the CLOCK. `updatedAt`
 * is an `@UpdateDateColumn` on `ci.asks`, so every responder-side write moves
 * it: the review transition, the owner's approve, the consent-basis stamp, the
 * decline. All three submit-time postures write at submit, so there is no
 * differential THERE — the leak is the later mutation. An asker polling `ask(id)`
 * watches a timestamp that only ever moves because a human on the other side
 * did something, and the SHAPE of the movement re-derives what `status` no
 * longer says: one move within seconds is the auto-deny, a move hours later is
 * a person reading the inbox, no move at all is an ask nobody has touched.
 * Bounded, like the status oracle before it, only by the rate limit.
 *
 * Pinning rather than nulling: `updatedAt` is non-null in the schema and the
 * asker legitimately has a timestamp for their own ask — the one they created.
 * A frozen `createdAt` is a truthful value that carries no responder activity,
 * and it keeps the field non-nullable for existing clients. The one event the
 * asker may legitimately observe, an answer arriving, still reaches them: the
 * `answered` status survives the status collapse and `AskAnswerType.createdAt`
 * carries its own timestamp.
 *
 * This applies to the OUTBOUND asker too, whose responder is a remote peer —
 * `isResponder` is false for them, exactly as {@link askerVisibleStatus}
 * already assumes.
 *
 * Pure.
 */
export function askerVisibleUpdatedAt(ask: Pick<Ask, 'createdAt'>): Date {
  return ask.createdAt;
}

/** A standing consent grant (the Grant Manager matrix). */
@ObjectType()
export class AskGrantType {
  @Field(() => ID)
  id!: string;

  /** Opaque user id of the grantee. NULL for a grant addressed to a peer. */
  @Field(() => ID, { nullable: true })
  granteeId!: string | null;

  /** Opaque id of the peer link this grant addresses, when it is a peer grant. */
  @Field(() => ID, { nullable: true })
  granteePeerLinkId!: string | null;

  @Field(() => String)
  queryType!: string;

  @Field(() => String, { nullable: true })
  dataClass!: string | null;

  @Field(() => GrantModeEnum)
  mode!: GrantModeEnum;

  @Field(() => String, { nullable: true })
  purpose!: string | null;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt!: Date;

  @Field(() => GraphQLISODateTime, { nullable: true })
  revokedAt!: Date | null;

  /** Scheduled lapse — the Grant Manager's "Expires {date}". */
  @Field(() => GraphQLISODateTime, { nullable: true })
  expiresAt!: Date | null;

  /** 'revoked' | 'superseded'; set only alongside `revokedAt`. */
  @Field(() => String, { nullable: true })
  revocationReason!: string | null;

  /** 1 for an original grant, incremented by each change. */
  @Field(() => Int)
  version!: number;

  /** The grant this one replaced, when it was written by a change. */
  @Field(() => ID, { nullable: true })
  supersedesGrantId!: string | null;

  /**
   * Whether the grant is in force right now. Computed rather than stored: a
   * client that reasons from `revokedAt == null` alone silently treats a lapsed
   * grant as live, which is the whole reason `expiresAt` exists.
   */
  @Field(() => Boolean)
  active!: boolean;

  /**
   * How many disclosures have cited this grant, and when the last one did.
   *
   * `useCount: 0` with a null `lastUsedAt` means DORMANT — the owner allowed
   * something and nothing ever came of it. That is a different state from
   * "revoked" and from "lapsed", and the matrix could not previously express
   * it: a grant firing daily and one that has never matched looked identical,
   * and they call for opposite actions.
   *
   * Read from `ci.ask_audit.consent_basis` — what a disclosure actually cited —
   * never from the grant's own row, which records what it permits and never
   * what it did.
   */
  @Field(() => Int)
  useCount!: number;

  @Field(() => GraphQLISODateTime, { nullable: true })
  lastUsedAt!: Date | null;

  static toType(grant: AskGrant, usage?: GrantUsage): AskGrantType {
    return {
      id: GlobalUID.encode('ask-grant', grant.id),
      granteeId: grant.granteeUserId ? GlobalUID.encode('user', grant.granteeUserId) : null,
      granteePeerLinkId: grant.granteePeerLinkId,
      queryType: grant.queryType,
      dataClass: grant.dataClass,
      mode: grant.mode as GrantModeEnum,
      purpose: grant.purpose,
      createdAt: grant.createdAt,
      updatedAt: grant.updatedAt,
      revokedAt: grant.revokedAt,
      expiresAt: grant.expiresAt,
      revocationReason: grant.revocationReason,
      version: grant.version,
      supersedesGrantId: grant.supersedesGrantId
        ? GlobalUID.encode('ask-grant', grant.supersedesGrantId)
        : null,
      active: isGrantActive(grant),
      useCount: usage?.useCount ?? 0,
      lastUsedAt: usage?.lastUsedAt ?? null,
    };
  }
}

/**
 * One relationship's disclosure record, folded.
 *
 * The unit an owner actually arrives with. A flat event list makes "what has
 * Ana been getting?" a scrolling-and-tallying exercise; this answers it.
 */
@ObjectType()
export class AskDisclosureSummaryType {
  /** Stable grouping key — `user:<id>`, `peer:<linkId>`, or `unattributed`. */
  @Field(() => String)
  key!: string;

  /** Opaque local asker id, when the counterparty is on this box. */
  @Field(() => ID, { nullable: true })
  askerId!: string | null;

  @Field(() => ID, { nullable: true })
  peerLinkId!: string | null;

  /** The peer's handle as of the most recent disclosure. Null for a local asker. */
  @Field(() => String, { nullable: true })
  peerHandle!: string | null;

  @Field(() => Int)
  total!: number;

  /**
   * Released by a standing grant with no human in the loop.
   *
   * Kept apart from {@link reviewed} on the wire, not merged into one
   * "answered" count, for the reason `DisclosureHistory` states: "a rule you
   * wrote once released this without asking you" is the outcome an owner needs
   * to notice, and a decision they made themselves is not.
   */
  @Field(() => Int)
  autoAnswered!: number;

  @Field(() => Int)
  reviewed!: number;

  @Field(() => Int)
  declined!: number;

  @Field(() => Int)
  expired!: number;

  /** Items that actually crossed, all time — magnitude, not ask count. */
  @Field(() => Int)
  itemsDisclosed!: number;

  @Field(() => Int)
  asksInWindow!: number;

  @Field(() => Int)
  itemsInWindow!: number;

  @Field(() => GraphQLISODateTime)
  firstAt!: Date;

  @Field(() => GraphQLISODateTime)
  lastAt!: Date;

  static toType(summary: DisclosureSummary): AskDisclosureSummaryType {
    return {
      key: summary.counterparty.key,
      askerId: summary.counterparty.askerUserId
        ? GlobalUID.encode('user', summary.counterparty.askerUserId)
        : null,
      peerLinkId: summary.counterparty.peerLinkId,
      peerHandle: summary.counterparty.peerHandle,
      total: summary.total,
      autoAnswered: summary.autoAnswered,
      reviewed: summary.reviewed,
      declined: summary.declined,
      expired: summary.expired,
      itemsDisclosed: summary.itemsDisclosed,
      asksInWindow: summary.asksInWindow,
      itemsInWindow: summary.itemsInWindow,
      firstAt: summary.firstAt,
      lastAt: summary.lastAt,
    };
  }
}

/**
 * A disclosure read, with whether it was complete.
 *
 * `truncated` is on the wire rather than inferred from `rows.length` because
 * the client cannot know the server's cap — and a completeness surface that
 * quietly shows part of the record is worse than one that admits it.
 */
@ObjectType()
export class AskDisclosureHistoryPayload {
  @Field(() => [AskAuditType])
  rows!: AskAuditType[];

  @Field(() => Boolean)
  truncated!: boolean;
}

@ObjectType()
export class AskDisclosureSummaryPayload {
  @Field(() => [AskDisclosureSummaryType])
  summaries!: AskDisclosureSummaryType[];

  /** True when the fold ran over a truncated read — so the totals are floors. */
  @Field(() => Boolean)
  truncated!: boolean;
}

/**
 * One question the asker put to several people, as the ASKER sees it.
 *
 * The counts fold each child through the same `askerVisibleStatus` an
 * individual ask goes through — so a broadcast reveals nothing per-recipient
 * that a single ask would not. `waiting` is every child that is not answered:
 * declined, expired, still in review and never-heard-from are one number, for
 * exactly the reason `PEER_ASK_PENDING` is one word.
 */
@ObjectType()
export class AskBroadcastType {
  @Field(() => ID)
  id!: string;

  @Field(() => AskQueryType)
  query!: AskQueryType;

  /** How many people were actually asked. */
  @Field(() => Int)
  recipients!: number;

  /** How many have an answer waiting. */
  @Field(() => Int)
  answered!: number;

  /**
   * Everyone else, as ONE number.
   *
   * Declined, expired, still in review and never-heard-from are deliberately
   * not separated: splitting them would hand the asker a per-recipient read on
   * each responder's consent posture, which is the oracle
   * `askerVisibleStatus` collapses for a single ask. A broadcast must not be a
   * cheaper way to run the same probe N times.
   */
  @Field(() => Int)
  waiting!: number;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime, { nullable: true })
  expiresAt!: Date | null;

  static toType(broadcast: AskBroadcast, asks: readonly Ask[]): AskBroadcastType {
    const answered = asks.filter((ask) => ask.status === 'answered').length;

    return {
      id: GlobalUID.encode('ask-broadcast', broadcast.id),
      query: AskQueryType.toType(broadcast.query),
      recipients: asks.length,
      answered,
      waiting: asks.length - answered,
      createdAt: broadcast.createdAt,
      expiresAt: broadcast.expiresAt,
    };
  }
}

/** A disclosure-history entry (one terminal ask outcome). */
@ObjectType()
export class AskAuditType {
  @Field(() => ID)
  id!: string;

  @Field(() => ID, { nullable: true })
  askId!: string | null;

  /** Opaque user id of the asker. NULL when a peer asked. */
  @Field(() => ID, { nullable: true })
  askerId!: string | null;

  /** The peer's handle at disclosure time, for an inbound federated ask. */
  @Field(() => String, { nullable: true })
  peerHandle!: string | null;

  /** NULL for an OUTBOUND ask — the responder is the peer, not a local user. */
  @Field(() => ID, { nullable: true })
  responderId!: string | null;

  @Field(() => AskQueryType)
  query!: AskQueryType;

  @Field(() => String, { nullable: true })
  consentBasis!: string | null;

  @Field(() => AskAuditOutcomeEnum)
  outcome!: AskAuditOutcomeEnum;

  /**
   * HOW MUCH crossed to the asker.
   *
   * The history used to be able to show only WHICH references were disclosed,
   * and only the `retrieval` form has any — so a `count` or `existence` answer
   * that handed over a real magnitude rendered as an empty disclosure. This is
   * the owner's own receipt (`askDisclosureHistory` is responder-scoped), so it
   * carries the true number, unlike {@link AskAnswerType} which narrows it for
   * the asker.
   */
  @Field(() => Int)
  disclosedCount!: number;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  static toType(audit: AskAudit): AskAuditType {
    return {
      id: GlobalUID.encode('ask-audit', audit.id),
      askId: audit.askId ? GlobalUID.encode('ask', audit.askId) : null,
      askerId: audit.askerUserId ? GlobalUID.encode('user', audit.askerUserId) : null,
      peerHandle: audit.peerHandle,
      responderId: audit.responderUserId ? GlobalUID.encode('user', audit.responderUserId) : null,
      query: AskQueryType.toType(audit.query),
      consentBasis: audit.consentBasis,
      outcome: audit.outcome as AskAuditOutcomeEnum,
      disclosedCount: audit.disclosedCount,
      createdAt: audit.createdAt,
    };
  }
}
