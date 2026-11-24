/**
 * The interpersonal "ask" domain (CI-Server #1711 → epic #1712, Phase 0).
 *
 * An Ask is a question one person directs at another person's Companion memory.
 * It is the inverse of a shared saved search: instead of the owner publishing a
 * fixed query others run *as the owner*, the asker supplies a bounded query that
 * runs against the responder's memory and returns only what the responder allows.
 */

/** Lifecycle states of an Ask. See ARCHITECTURE.md §6 (ask lifecycle). */
export type AskStatus =
  'sent' | 'delivered' | 'under_review' | 'answering' | 'answered' | 'declined' | 'expired';

/** Terminal outcome recorded in the per-ask audit log. */
export type AskAuditOutcome = 'answered' | 'auto_answered' | 'declined' | 'expired';

/**
 * Three-state consent posture of a standing grant (the Grant Manager matrix):
 * `auto` answers without review, `review` routes to the owner's inbox (the
 * default), `block` denies outright.
 */
export type GrantMode = 'auto' | 'review' | 'block';

/**
 * The kinds of object a grant may name directly, rather than by class of
 * question. Pinned to the `ask_grants_resource_type_chk` CHECK.
 */
export type AskGrantResourceType = 'saved_search';

/** Outcome of evaluating an ask against the owner's standing grants. */
export type GrantDecision = 'auto' | 'review' | 'deny';

/**
 * Why a grant stopped being in force. Only ever set alongside `revokedAt`; a
 * grant that merely lapsed carries `expiresAt` and no reason, because lapsing is
 * not something the owner did.
 *
 * `superseded` marks a grant that was CHANGED: the replacement row points back
 * at it via `supersedesGrantId`. Keeping the two apart is the difference between
 * "they withdrew consent" and "they narrowed it" in the disclosure history.
 */
export type GrantRevocationReason = 'revoked' | 'superseded';

/**
 * Relationship tier of an asker, coarsest trust last. `household` is a member of
 * the owner's own box; the rest mirror `PeerTrustTier` in the peers domain
 * (declared here rather than imported because peers depends on asks, not the
 * reverse).
 */
export type TrustTier = (typeof TRUST_TIERS)[number];

/**
 * Every trust tier, coarsest trust LAST.
 *
 * A runtime list beside the type, because both write boundaries that accept a
 * tier (`HouseholdTierService.setTier`, `PeerLinkService`) need to validate one
 * that arrived as JSON — and a type alone stops nothing there. `PEER_TRUST_TIERS`
 * derives its own narrower list from this one by `Exclude`, so the two cannot
 * drift.
 */
export const TRUST_TIERS = ['household', 'family', 'trusted', 'peer', 'stranger'] as const;

/**
 * How much an answer may disclose, coarsest first. See {@link DISCLOSURE_RUNGS}
 * in policy.ts — the ladder the owner's review UI exposes as "share less".
 */
export type DisclosureRung = 'none' | 'boolean' | 'count' | 'summary' | 'redacted' | 'full';

/**
 * The shape of an answer, which drives disclosure minimization (see
 * {@link inferAnswerForm}). Only `retrieval` returns item references; the rest
 * disclose a yes-no / count / synthesized value only.
 */
export type AnswerForm = 'boolean' | 'existence' | 'attribute' | 'retrieval' | 'identity';

/** Where an answer originated relative to the recipient's memory. */
export type AnswerSource = 'self' | 'peer';

/** A disclosed entity reference — id + type only, NEVER raw content. */
export interface DisclosedItem {
  id: string;
  type: string;
}

/** The disclosure-filtered answer produced for an ask. */
export interface DisclosedAnswer {
  form: AnswerForm;
  /** Item references (retrieval form only); empty for other forms. */
  items: DisclosedItem[];
  /** Count of matched items disclosed after the owner's redaction. */
  disclosedCount: number;
  /** Count of matched items the owner withheld (never itemized to the asker). */
  withheldCount: number;
  /** Templated, non-leaking natural-language summary. */
  summary: string;
  consentBasis: string | null;
}

export interface CreateAskAnswerDto {
  id?: string;
  askId: string;
  answer: DisclosedAnswer;
  answerSource?: AnswerSource;
}

/**
 * The bounded, asker-supplied request. Phase 0 keeps this a light structured
 * shape; Phase 2 formalizes it as a DCQL subset (ROADMAP Epic 2). It is treated
 * as **hostile input** — validated and bounded before it ever executes in the
 * owner's scope (the security inversion vs today's owner-authored fixed query).
 */
export interface AskQuery {
  /** Coarse ask category; drives grant matching against `ask_grants.query_type`. */
  queryType: string;
  /** Optional finer data class, e.g. 'photos' | 'calendar' | 'location'. */
  dataClass?: string;
  /** The natural-language question as composed by the asker (shown back to both sides). */
  prompt: string;
  /**
   * True when characters that render as nothing (zero-width spaces, bidi
   * controls, soft hyphens) were stripped from the asker's prompt before it was
   * stored. The stored prompt no longer holds them, so this is the only record
   * the owner's review card has of that removal. Absent means none were
   * removed. It does NOT cover the other rewrites `normalizeText` makes: the
   * NFKC fold (fullwidth letters, ligatures, superscripts) and the whitespace
   * collapse also change the stored text and leave this unset.
   */
  promptHiddenCharactersRemoved?: boolean;
  /**
   * What is making this ask, when the asker declares it.
   *
   * A FIRST-CLASS FIELD rather than one more key in `filters`: it is matched by
   * the consent evaluator and rendered at the consent moment, and `filters` is
   * the bag of things that reach the executor. Burying a consent-relevant fact
   * among search parameters is how it ends up being treated as one.
   */
  actor?: AskActor;
  /** Optional structured filters mirroring the explorer capture (who / where / when). */
  filters?: Record<string, unknown>;
}

/**
 * Structured scope attached to a grant — the grant vocabulary (ROADMAP Epic 2).
 *
 * Modelled on DWN's `ProtocolsConfigure` `$actions` pattern (borrowed as a
 * pattern, not a dependency): a grant names WHO may ask WHAT, and how much of an
 * answer they may receive. Every field only ever NARROWS the grant — an absent
 * field means "no restriction from this dimension", never "allow more".
 */
export interface AskGrantScope {
  /** If set, the grant only covers asks whose `dataClass` is in this list. */
  dataClasses?: string[];
  /** If set, the grant only covers these ask archetypes. */
  archetypes?: string[];
  /**
   * Caps how much any answer under this grant may disclose. Combined with the
   * tier ceiling by taking the LESSER of the two, so a grant can tighten the
   * tier default but never loosen it.
   */
  maxDisclosure?: DisclosureRung;
  /** Inclusive ISO bounds; asks outside the window do not match. */
  notBefore?: string;
  notAfter?: string;
  /** Purpose the grant is limited to, matched against the ask's stated purpose. */
  purpose?: string;
  /**
   * Who may exercise this grant. Absent = no restriction from this dimension.
   * See {@link AskDelegation}.
   */
  delegation?: AskDelegation;
  [key: string]: unknown;
}

/** Result of {@link evaluateGrant}. */
export interface GrantEvaluation {
  decision: GrantDecision;
  /** The grant that decided the outcome, when one matched. */
  grantId?: string;
  /**
   * Ceiling the deciding grant imposes on any answer (its `scope.maxDisclosure`).
   * The caller combines this with the asker's tier ceiling by taking the LESSER
   * of the two, so neither can loosen the other.
   */
  maxDisclosure?: DisclosureRung;
}

/**
 * WHO may exercise a grant — the person, or something acting for them.
 *
 * Adapted from UMA-for-agents' recommendation #25, which adds a
 * `delegation: none | first-party-only | any-agent` field for exactly this
 * question. Until now a grant said WHO may ask and WHAT about, and had no way
 * to say whether "Bob" meant Bob or Bob's assistant. That stops being academic
 * the moment asks arrive from the Intent Catalog / MCP tool registry rather
 * than from a person at a keyboard.
 *
 *   none              — the person themselves, and nothing acting for them.
 *   first-party-only  — the grantee's own Companion may ask on their behalf.
 *   any-agent         — including a third-party agent they delegated to.
 *
 * Absent means no restriction from this dimension, which is the contract every
 * other {@link AskGrantScope} field holds. The safety is on the ASK side: an
 * ask that does not say who is acting cannot satisfy a grant that restricts it.
 * See `scopeCoversQuery`.
 */
export type AskDelegation = 'none' | 'first-party-only' | 'any-agent';

/** What is making an ask — a person, or software acting for them. */
export type AskActorKind = 'person' | 'first-party-agent' | 'third-party-agent';

export interface AskActor {
  kind: AskActorKind;
  /**
   * Opaque label for the acting software, shown to the owner at the consent
   * moment. Never used for matching — {@link AskDelegation} matches on `kind`
   * alone, because a name is a claim the asker writes and a kind is a
   * commitment they make.
   */
  label?: string;
}

/** Whether an ask is local to this box, sent to a peer, or received from one. */
export type AskDirection = 'local' | 'outbound' | 'inbound';

/**
 * How an ask arrived, when it arrived signed.
 *
 * All three fields travel together or none do — a thumbprint with no timestamp
 * claims a verification that never happened, and a timestamp with no thumbprint
 * claims one by nobody (`asks_channel_paired_chk`).
 */
export interface AskChannelProvenance {
  /** RFC 7638 thumbprint of the key that signed the request, as of arrival. */
  keyThumbprint: string;
  /** When this box verified it. */
  verifiedAt: Date;
  /** The signature base's covered components, as actually presented. */
  covered: string[];
}

export interface CreateAskDto {
  id?: string;
  /** NULL for an OUTBOUND ask — the responder is the peer named by `peerLinkId`. */
  responderUserId: string | null;
  query: AskQuery;
  expiresAt?: Date | null;
  /**
   * Set for a federated ask. When `direction` is `inbound` the asker is the
   * peer (no local asker id); `outbound` records which peer we sent it to.
   */
  peerLinkId?: string | null;
  direction?: AskDirection;
  /** Correlates this ask with the others the asker sent as one question. */
  broadcastId?: string | null;
  /**
   * Set when the request that produced this ask carried a verified RFC 9421
   * signature. Omitted means it did not — an unsigned channel, which the ask
   * surfaces state plainly rather than hiding.
   */
  channel?: AskChannelProvenance | null;
}

export interface CreateAskGrantDto {
  id?: string;
  /** Exactly one of granteeUserId / granteePeerLinkId identifies the grantee. */
  granteeUserId?: string | null;
  /** Grant addressed to a linked peer Companion (federated asks). */
  granteePeerLinkId?: string | null;
  /**
   * The single object this grant covers. Both or neither — a resource id with
   * no type names nothing, a type with no id is a wildcard.
   */
  resourceType?: AskGrantResourceType | null;
  resourceId?: string | null;
  queryType: string;
  dataClass?: string | null;
  scope?: AskGrantScope | null;
  mode?: GrantMode;
  purpose?: string | null;
  /** Scheduled lapse; must be in the future. NULL/omitted = stands until revoked. */
  expiresAt?: Date | null;
}

/**
 * A change to a standing grant. Applied by SUPERSEDING (revoke + replacement
 * row), never by UPDATE — see {@link AskGrantEntity}. Every field is optional;
 * an omitted one is inherited from the grant being replaced. `expiresAt` is
 * `Date | null` rather than optional-only so a change can explicitly REMOVE an
 * expiry, which is a different intent from "leave it alone".
 */
export interface UpdateAskGrantDto {
  mode?: GrantMode;
  dataClass?: string | null;
  scope?: AskGrantScope | null;
  purpose?: string | null;
  expiresAt?: Date | null;
}

export interface RecordAskAuditDto {
  /**
   * The ask this outcome belongs to, or NULL for a disclosure with no ask
   * behind it — a read through a shared saved search, which is pre-authorized
   * and therefore has no request lifecycle to model. The column has been
   * nullable since it was written (`ON DELETE SET NULL`).
   */
  askId: string | null;
  /** NULL for an inbound peer ask — the asker is identified by `peerLinkId`. */
  askerUserId: string | null;
  peerLinkId?: string | null;
  peerHandle?: string | null;
  responderUserId: string | null;
  query: AskQuery;
  consentBasis?: string | null;
  outcome: AskAuditOutcome;
  /** Entity references the ASKER actually received. Empty for non-itemizing forms. */
  disclosedEntities?: string[];
  /**
   * How many items the asker received. Kept SEPARATE from
   * {@link disclosedEntities} because only the `retrieval` form itemizes — for
   * every other form the references are empty by construction while the count
   * is the actual disclosure. Omitted, it falls back to the itemized length,
   * which is the right answer for `retrieval` and for the terminal outcomes
   * (`declined` / `expired`) that disclose nothing.
   */
  disclosedCount?: number;
  /**
   * Entity ids the answer was computed over (post-redaction, PRE-ceiling).
   * Owner-visible accountability only — never disclosed to the asker.
   */
  backingEntities?: string[];
}
