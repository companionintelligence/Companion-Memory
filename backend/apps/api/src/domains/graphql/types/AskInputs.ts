import { Field, GraphQLISODateTime, ID, InputType, Int, registerEnumType } from '@nestjs/graphql';

import { GrantModeEnum } from './AskType';

/**
 * The disclosure ladder, as the owner picks it — coarsest first, mirroring
 * `DISCLOSURE_RUNGS` in the asks domain.
 *
 * An ENUM rather than a String field, because this is the one input on a grant
 * whose misspelling is silent: `scope.maxDisclosure` is jsonb, and a value that
 * names no rung is read as `none` (fail-closed) rather than rejected. Making
 * the vocabulary part of the schema means a client cannot write one — the
 * server-side check in `GrantService` is the belt to this brace, for callers
 * that reach the service without passing through GraphQL.
 */
export enum DisclosureRungEnum {
  none = 'none',
  boolean = 'boolean',
  count = 'count',
  summary = 'summary',
  redacted = 'redacted',
  full = 'full',
}

registerEnumType(DisclosureRungEnum, { name: 'DisclosureRung' });

/**
 * The bounded, asker-supplied query. Phase 2 formalizes this as a DCQL subset.
 *
 * ═══ THE BOUNDS ARE REAL; THEY LIVE IN `asks/askInput.ts` ═══
 *
 * Every field here is `String`, so this declaration is where a reader looks for
 * the limits on the two most attacker-controlled values in the whole consent
 * surface — and would find none. `createAsk` runs `parseAskQueryInput` over
 * this object before anything is stored, matched against a grant, or shown to a
 * human, and that is where they are: a closed archetype vocabulary for
 * {@link queryType}, and normalization plus a hard cap for {@link prompt} and
 * {@link dataClass}. Off-contract input is a 400 — REJECTED, never truncated,
 * because a silently shortened prompt is a different question from the one the
 * asker wrote, shown to the owner as though it were theirs.
 *
 * WHY NOT AN ENUM AND A `@MaxLength` HERE, which would be stronger?
 *
 *  - the checked-in `__generated__/schema.graphql` is what the web app's
 *    codegen reads, so turning `queryType: String` into an enum desynchronizes
 *    a generated artifact this change does not own; and
 *  - a schema-level constraint binds the GraphQL layer ONLY. Every caller that
 *    reaches the resolver directly — including every unit test — would be
 *    unprotected, which also means no test could remove the control and watch
 *    something go red. A checked value binds all of them.
 */
@InputType()
export class AskActorInput {
  /**
   * The kind of actor. MATCHED ON; the label is not.
   *
   * A name is a claim the asker writes and a kind is a commitment they make —
   * admitting an agent because it called itself something reassuring would make
   * the delegation restriction decorative.
   */
  @Field(() => String)
  kind!: string;

  /** Shown to the owner at the consent moment. Truncated, never matched on. */
  @Field(() => String, { nullable: true })
  label?: string;
}

@InputType()
export class AskQueryInput {
  /**
   * The ask's ARCHETYPE — one of `ASK_ARCHETYPES`, and half the key every
   * standing grant is matched on.
   *
   * Not a free label. While it was one, the key a block grant is keyed on was
   * chosen by the ASKER: an owner who blocked one word was walked past by an
   * asker who typed another, and the evaluation fell through to the review
   * default. See `parseAskQueryType`.
   */
  @Field(() => String)
  queryType!: string;

  /** Coarse data class, e.g. `photos`. Normalized and length-capped on the way in. */
  @Field(() => String, { nullable: true })
  dataClass?: string;

  /**
   * What is making this ask — `person`, `first-party-agent`, or
   * `third-party-agent`, optionally with a display label.
   *
   * Optional, and its ABSENCE is meaningful rather than neutral: a grant that
   * restricts delegation is not satisfied by an ask that declines to say who is
   * acting, so an omitted actor routes to owner review instead of being
   * auto-answered. See `AskGrantScope.delegation`.
   *
   * An off-contract value parses to NO actor rather than to `person` — the
   * alternative would let an agent satisfy a `delegation: 'none'` grant by
   * sending something malformed, which is easier than sending something honest.
   */
  @Field(() => AskActorInput, { nullable: true })
  actor?: AskActorInput;

  /**
   * The natural-language question, shown back to both sides. Never executed.
   *
   * Normalized with the same invisible-stripping normalizer the consent gate
   * uses, so a prompt cannot render one way to the human reading the review
   * inbox and compare another way to anything reading the stored jsonb.
   */
  @Field(() => String)
  prompt!: string;
}

@InputType()
export class CreateAskInput {
  /** Opaque user id of the responder (owner) the ask is directed at. */
  @Field(() => ID)
  responderId!: string;

  @Field(() => AskQueryInput)
  query!: AskQueryInput;
}

/**
 * A new standing grant.
 *
 * ═══ EXACTLY ONE GRANTEE, AND THE PEER HALF WAS UNREACHABLE ═══
 *
 * `ci.ask_grants` has admitted a PEER grantee since the peer-links migration —
 * `ask_grants_grantee_chk` requires exactly one of `grantee_user_id` /
 * `grantee_peer_link_id`, `CreateAskGrantDto` carries both, and
 * `GrantService.create` enforces the same rule. Only this input and the resolver
 * were missing, and `granteeId` being REQUIRED is what made a grant addressed to
 * a peer inexpressible: the federation harness had to write every one of them as
 * raw SQL, and so did anyone else.
 *
 * Both fields are therefore nullable at the schema level and the exactly-one-of
 * rule is enforced in the resolver, which is the only place that can turn it
 * into a 400 that names the two fields. GraphQL has no "one of these two"
 * construct to express it in the type itself (`@oneOf` is not in the version
 * this schema is built against), so a nullable pair plus a checked resolver is
 * the shape — not an oversight.
 */
@InputType()
export class CreateAskGrantInput {
  /**
   * Opaque user id of the grantee who may ask — a member of this box.
   *
   * Nullable, but not optional in practice: supply exactly one of this and
   * {@link granteePeerLinkId}.
   */
  @Field(() => ID, { nullable: true })
  granteeId?: string;

  /**
   * The linked peer Companion this grant addresses, for a FEDERATED grant.
   *
   * The raw `ci.peer_links.id`, matching what {@link AskGrantType
   * .granteePeerLinkId} emits — peer links have no global-id type of their own,
   * so encoding one here would make the value the API hands out un-resubmittable.
   */
  @Field(() => ID, { nullable: true })
  granteePeerLinkId?: string;

  /**
   * The archetype this grant covers — the SAME closed vocabulary an ask is held
   * to, checked by `parseGrantQueryType` in the resolver.
   *
   * Constraining the writing end is what keeps "I blocked this" and "this is
   * blocked" the same statement: a grant naming a word no ask can carry matches
   * nothing, while the Grant Manager shows it back to the owner as live
   * protection.
   */
  @Field(() => String)
  queryType!: string;

  @Field(() => String, { nullable: true })
  dataClass?: string;

  @Field(() => [String], { nullable: true })
  dataClasses?: string[];

  /**
   * The MOST any answer under this grant may disclose — the owner's "digest
   * only" / "yes or no" control.
   *
   * `scope.maxDisclosure` is read on three separate paths (the grant evaluator,
   * the local answer path, the federated one) and, until this field existed, was
   * written by NONE of them: there was no input, no resolver wiring, no default
   * and no seed, so every clamp built on it was dead code and "digest only" was
   * a posture the owner could not express at all. Omitted means the grant
   * imposes no ceiling of its own — the tier ceiling still applies, and the two
   * are combined by taking the lesser.
   */
  @Field(() => DisclosureRungEnum, { nullable: true })
  maxDisclosure?: DisclosureRungEnum;

  @Field(() => GrantModeEnum)
  mode!: GrantModeEnum;

  /**
   * Who may exercise this grant — `none` (the person only), `first-party-only`
   * (their own Companion may act for them), or `any-agent`.
   *
   * Absent = no restriction from this dimension, matching every other scope
   * field. Adapted from UMA-for-agents recommendation #25.
   */
  @Field(() => String, { nullable: true })
  delegation?: string;

  /** Optional DPV purpose URI (ECOSYSTEM.md Δ2). */
  @Field(() => String, { nullable: true })
  purpose?: string;

  // NOTE: no `expiresAt` here yet. `CreateAskGrantDto` and `GrantService.create`
  // both accept one, but wiring it through means editing `createAskGrant`'s body
  // in AskResolver, which is being changed concurrently — a field the resolver
  // silently drops would be worse than no field. Set an expiry with
  // `updateAskGrant` until that one line lands.
}

/**
 * A change to an existing standing grant — the Grant Manager matrix's
 * `onChangeMode(grantId, mode)`.
 *
 * Every field is optional and an omitted one is INHERITED from the grant being
 * replaced, so a mode flip does not have to restate the whole grant. Note that
 * the grantee and the query type are absent by design: those identify which
 * grant this is, and changing them would make it a different grant, so the
 * caller creates one instead.
 *
 * Applied as a supersede — the old grant is closed out and a new row replaces
 * it. `GrantService.supersede` explains why.
 */
@InputType()
export class UpdateAskGrantInput {
  @Field(() => GrantModeEnum, { nullable: true })
  mode?: GrantModeEnum;

  @Field(() => String, { nullable: true })
  dataClass?: string;

  @Field(() => [String], { nullable: true })
  dataClasses?: string[];

  /**
   * Tighten (or raise) the grant's own disclosure ceiling.
   *
   * Omitting it INHERITS the ceiling already on the grant. That is worth stating
   * because it did not use to: the scope object was assigned wholesale by
   * `supersede`, so narrowing `dataClasses` on a grant capped at `summary`
   * deleted the cap — a narrowing edit that WIDENED the answer. `GrantService`
   * now merges the two, so each scope dimension is edited on its own.
   */
  @Field(() => DisclosureRungEnum, { nullable: true })
  maxDisclosure?: DisclosureRungEnum;

  @Field(() => String, { nullable: true })
  purpose?: string;

  @Field(() => GraphQLISODateTime, { nullable: true })
  expiresAt?: Date;

  /**
   * Explicitly REMOVE the expiry, as distinct from leaving it alone. GraphQL
   * cannot tell an omitted nullable input field from one passed as null, so the
   * intent needs its own flag; without it, "make this grant permanent" is
   * inexpressible.
   */
  @Field(() => Boolean, { nullable: true })
  clearExpiry?: boolean;
}

/**
 * An outbound ask to a peer Companion.
 *
 * The archetype union is flattened for GraphQL (which has no input unions);
 * `OutboundAskService` narrows it back to the discriminated protocol shape, and
 * fields that do not belong to the chosen archetype are ignored rather than
 * silently widening the request.
 */
@InputType()
export class SendPeerAskInput {
  /** Portal handle of the linked peer to ask. */
  @Field(() => String)
  handle!: string;

  @Field(() => String)
  prompt!: string;

  /** One of: relationship | content | availability. */
  @Field(() => String)
  archetype!: string;

  /** relationship/content: who or what is being asked about. */
  @Field(() => String, { nullable: true })
  subject?: string;

  /** content: coarse data class, e.g. photos. */
  @Field(() => String, { nullable: true })
  dataClass?: string;

  /** availability (required) and content (optional): ISO window. */
  @Field(() => String, { nullable: true })
  from?: string;

  @Field(() => String, { nullable: true })
  to?: string;

  /** availability: minimum contiguous free minutes worth reporting. */
  @Field(() => Int, { nullable: true })
  minMinutes?: number;

  /** Shown to the responder for context; never used to widen scope. */
  @Field(() => String, { nullable: true })
  purpose?: string;

  /**
   * Portal-issued access token whose audience is the PEER box. Supplied by the
   * caller until Portal token exchange lands; this box never mints or stores it.
   */
  @Field(() => String)
  peerAccessToken!: string;
}
