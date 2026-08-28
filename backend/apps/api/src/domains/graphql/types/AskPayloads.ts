import { Field, Int, ObjectType } from '@nestjs/graphql';

import { AskAnswerType } from './AskAnswerType';
import { AskGrantType, AskType } from './AskType';
import { MutationPayload } from './MutationPayload';

/**
 * The only value {@link CreateAskPayload.decision} ever carries.
 *
 * It used to be the responder's raw standing-grant decision — `auto` | `review`
 * | `deny` — handed synchronously to the ASKER. That is the responder's consent
 * posture, not the asker's business, and returning it made `createAsk` a probe
 * against the grant matrix: submit an ask, read back whether a standing
 * pre-authorization, a review default, or a block covers it. Bounded only by
 * the rate limit, an asker could map the whole matrix by varying queryType and
 * dataClass — without ever receiving an answer.
 *
 * The honest signal the asker actually needs is that the ask was accepted for
 * handling, which is what this says. Every downgrade of that signal is
 * deliberate:
 *
 * - `auto` vs `review` is the existence of a standing grant. Collapsed.
 * - `deny` vs `review` is the existence of a BLOCK, which is the most sensitive
 *   cell in the matrix and the one an asker most wants to find. Collapsed —
 *   mirroring {@link SendPeerAskPayload}, where a decline is indistinguishable
 *   from an unreachable peer. (That mirror was aspirational when it was
 *   written: the federated path still sent the raw word until the responder
 *   itself stopped emitting it. See `PEER_ASK_PENDING`.)
 *
 * Nothing is lost that the asker could not learn honestly: an auto-answered ask
 * simply has an answer waiting when they read it, and a blocked one never
 * acquires one — the same shape as a responder who never got around to it.
 *
 * COLLAPSING THIS FIELD WAS NOT ENOUGH ON ITS OWN. The identical three-way
 * signal stayed readable through `ask.status` on this very payload — `declined`
 * / `delivered` / `under_review` for deny / auto / review — so the oracle was
 * relocated, not closed. `AskType.toType` now collapses the status for the
 * asker too; see `askerVisibleStatus`.
 */
export const ASK_ACCEPTED = 'accepted';

@ObjectType()
export class CreateAskPayload extends MutationPayload {
  @Field(() => AskType, { nullable: true })
  ask?: AskType;

  /**
   * Acknowledgement only — always {@link ASK_ACCEPTED}. Deliberately NOT the
   * responder's `auto` | `review` | `deny` posture; see {@link ASK_ACCEPTED}.
   */
  @Field(() => String, { nullable: true })
  decision?: string;
}

@ObjectType()
export class AskPayload extends MutationPayload {
  @Field(() => AskType, { nullable: true })
  ask?: AskType;
}

@ObjectType()
export class RunAskPayload extends MutationPayload {
  @Field(() => AskType, { nullable: true })
  ask?: AskType;

  /** The disclosure-filtered answer produced for the ask (Phase 1). */
  @Field(() => AskAnswerType, { nullable: true })
  answer?: AskAnswerType;

  /** Convenience mirrors of the answer's counts. */
  @Field(() => Int, { nullable: true })
  disclosedCount?: number;

  @Field(() => Int, { nullable: true })
  withheldCount?: number;
}

@ObjectType()
export class AskGrantPayload extends MutationPayload {
  @Field(() => AskGrantType, { nullable: true })
  grant?: AskGrantType;
}

/**
 * Result of sending an outbound ask.
 *
 * ═══ THIS DOCSTRING USED TO BE A CLAIM, NOT A DESCRIPTION ═══
 *
 * It said a declined result was "deliberately indistinguishable from an
 * unreachable peer" while `status` carried the peer's raw word — `answered`,
 * `pending_review` or `declined` — straight through from
 * `PeerAskService.handle` to this field, with `reason` spelling out which
 * ("Not permitted" / "Awaiting owner review"). That is the responder's grant
 * posture, and it is the SAME oracle #2210 and #2216 closed for a local asker:
 * `CreateAskPayload.decision` became the constant {@link ASK_ACCEPTED} and
 * `askerVisibleStatus` folded every non-answered status to `delivered`. The two
 * paths had made opposite decisions about one question, and this side was the
 * one being cited as precedent by the other.
 *
 * The collapse now happens at the RESPONDER, not here — the distinction stops
 * being sent rather than stopping being displayed, because hiding it locally
 * would bind only a well-behaved asker box while the word stayed on the wire.
 * See `domains/peers/protocol.ts`, `PEER_ASK_PENDING`.
 *
 * So `status` is the LOCAL vocabulary, not a second parallel one: `answered`
 * (an answer is waiting) or `delivered` (the ask reached the peer, and nothing
 * more is known) — exactly the two words {@link askerVisibleStatus} folds an
 * ask's own lifecycle down to.
 *
 * `reason` survives ONLY for a failure this box observed first-hand: an
 * endpoint the egress policy refused, a peer that did not respond, an HTTP
 * error. A reason the PEER supplied is dropped at `PeerAskClient`, because
 * echoing an untrusted string here is how a collapsed status gets undone one
 * field along.
 */
@ObjectType()
export class SendPeerAskPayload extends MutationPayload {
  @Field(() => AskType, { nullable: true })
  ask?: AskType;

  /** `answered` or `delivered` — never the responder's consent posture. */
  @Field(() => String, { nullable: true })
  status?: string;

  /**
   * The disclosure-filtered answer, when the peer answered.
   *
   * NOT populated by `sendPeerAsk` today, even though the peer's answer is now
   * persisted locally the moment it arrives: the mutation returns `ask`,
   * `status` and `reason` only. Reading it goes through `askAnswer(askId)` like
   * any other answer — which is the more honest route anyway, since an answer
   * collected LATER by a poll can only ever be read that way. Populating this
   * field lives in `AskResolver`; see the PR body.
   */
  @Field(() => AskAnswerType, { nullable: true })
  answer?: AskAnswerType;

  /** Locally-observed failures only; never a reason the peer supplied. */
  @Field(() => String, { nullable: true })
  reason?: string;
}
