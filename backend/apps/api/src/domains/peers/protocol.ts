import { z } from 'zod';

/**
 * The peer-ask wire protocol — the contract two Companion Memory boxes speak.
 *
 * Shape and vocabulary follow OID4VP/DCQL's "request specific claims, get a
 * selectively-disclosed response" model rather than a datastore query: the asker
 * names the ARCHETYPE and its constraints; the responder's box decides what (if
 * anything) that maps to in its own memory. The asker never expresses a query
 * over the responder's schema, so a peer can never probe storage layout.
 *
 * Transport is HTTP POST to the peer's `/agent/v1/ask`, authenticated with a
 * CI-Portal-issued OIDC token whose audience is the target peer. Discovery of
 * that endpoint (handle → memory endpoint + issuer) is CI-Portal's job; the
 * relationship itself is held only by the two boxes.
 */

/**
 * The three interpersonal archetypes this protocol carries. Each is a distinct
 * disclosure surface, so each is a distinct wire shape — a peer cannot smuggle a
 * retrieval through an availability request.
 *
 * - `relationship` — "do you know X?" → boolean (+ optional how, if permitted)
 * - `content`      — "have you seen / do you have X?" → existence or references
 * - `availability` — "free for lunch Friday at X?" → free/busy slots ONLY
 */
export const PEER_ASK_ARCHETYPES = ['relationship', 'content', 'availability'] as const;
export type PeerAskArchetype = (typeof PEER_ASK_ARCHETYPES)[number];

/** "Do you know X?" — X named as free text plus optional identifiers. */
export const relationshipAskSchema = z.object({
  archetype: z.literal('relationship'),
  /** The person being asked about, as the asker knows them. */
  subject: z.string().min(1).max(200),
  /** Optional normalized identifiers to disambiguate (email/phone). */
  identifiers: z.array(z.string().max(200)).max(5).optional(),
});

/** "Have you seen / do you have X content?" */
export const contentAskSchema = z.object({
  archetype: z.literal('content'),
  /** What the asker is looking for. */
  subject: z.string().min(1).max(500),
  /** Coarse class hint — 'photos' | 'documents' | 'messages' | 'events'. */
  dataClass: z.string().max(60).optional(),
  /** Optional ISO date window to bound the search. */
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

/**
 * "Free for lunch Friday?" — a free/busy question over a bounded window.
 * The response carries ONLY busy/free intervals; titles, attendees, and
 * locations of the responder's events are never disclosed by this archetype.
 */
export const availabilityAskSchema = z.object({
  archetype: z.literal('availability'),
  /** Window start (ISO 8601). */
  from: z.string().datetime(),
  /** Window end (ISO 8601). */
  to: z.string().datetime(),
  /** Optional minimum contiguous free minutes the asker needs (e.g. 60). */
  minMinutes: z
    .number()
    .int()
    .min(5)
    .max(24 * 60)
    .optional(),
  /** Optional human context shown to the responder ("lunch at Zuni"). */
  purpose: z.string().max(200).optional(),
});

/**
 * The shape of an asker-minted correlation id: 8–64 characters of word
 * characters, dot, colon or hyphen. Wide enough for a uuid, a urn and a
 * timestamped label; narrow enough to be a URL path segment without escaping,
 * which is what the collect route needs.
 */
export const PEER_ASK_ID_PATTERN = /^[\w.:-]{8,64}$/;

/**
 * What is making an ask, when the asker declares it.
 *
 * Optional on the wire, and its ABSENCE is meaningful: a grant that restricts
 * delegation (`AskGrantScope.delegation`) is not satisfied by an ask that
 * declines to say who is acting, so an omitted actor lands the ask in the
 * owner's review inbox rather than being auto-answered. Declaring `person`
 * dishonestly is a lie a peer can tell; declining to declare is not a way
 * around the restriction.
 *
 * `label` is shown to the owner at the consent moment and is NEVER matched on —
 * a name is a claim the asker writes, a kind is a commitment they make.
 */
export const askActorSchema = z.object({
  kind: z.enum(['person', 'first-party-agent', 'third-party-agent']),
  label: z.string().max(80).optional(),
});

export const peerAskBodySchema = z.object({
  /** What is making this ask. See {@link askActorSchema}. */
  actor: askActorSchema.optional(),
  /**
   * Correlation id minted by the asker, and a REAL idempotency key.
   *
   * It used to be documented as one and read by nothing: a re-ask minted a
   * fresh `ci.asks` row and was evaluated from scratch, so an ask the owner had
   * personally approved could never be collected — the approved answer sat on
   * the responder's box forever and the asker got queued a second time. It is
   * now persisted per peer link (`ci.peer_ask_correlations`), which is what
   * makes both halves of the return path work: a repeat POST replays the
   * recorded outcome instead of creating a second ask, and
   * `GET /agent/v1/ask/:askId` collects it without creating anything at all.
   *
   * The character class is {@link PEER_ASK_ID_PATTERN} rather than "any 8–64
   * characters", because the same id is now also a URL PATH SEGMENT on the poll
   * route. One definition, so the two routes cannot disagree about which ids
   * exist — a body-only bound would accept ids the collect route could never
   * name back.
   */
  askId: z.string().regex(PEER_ASK_ID_PATTERN),
  /** The asker's Portal handle, for display and peer-link matching. */
  askerHandle: z.string().min(1).max(120),
  /** Natural-language question, shown to the responder in their review inbox. */
  prompt: z.string().min(1).max(500),
  /**
   * WHY the asker wants this, in their own words.
   *
   * ═══ IT WAS ON THE GRANT AND NOT ON THE WIRE ═══
   *
   * `AskGrantScope.purpose` has always been matchable, and `scopeCoversQuery`
   * requires a purpose-limited grant to see the SAME purpose on the ask. But
   * `toAskQuery` never wrote one for any archetype — `availability` folded its
   * `purpose` into the prompt and the other two had no field at all — so a
   * purpose-limited grant matched NO inbound peer ask, ever. It failed closed
   * (the ask was downgraded to review, never widened), so nothing leaked; the
   * feature was simply dead across boxes, silently, with no signal to the owner
   * who set it.
   *
   * ═══ CARRIED WHETHER OR NOT ANY GRANT MATCHES ON IT ═══
   *
   * UMA-for-agents' recommendation #15 is *stated intent, never evaluated*:
   * carry the requester's purpose unread, and let policy notice its ABSENCE
   * rather than judge its truthfulness. That is right for the DEFAULT case and
   * is what happens here — the purpose is shown to the owner at the consent
   * moment for every ask that states one.
   *
   * A purpose-LIMITED grant is the exception, and deliberately so: that is an
   * owner writing down a restriction ("only for the wedding invites"), and an
   * owner's own narrowing is the one thing that should be enforced. It can only
   * ever refuse to match, never widen.
   */
  purpose: z.string().min(1).max(200).optional(),
  /** The structured request. */
  request: z.discriminatedUnion('archetype', [
    relationshipAskSchema,
    contentAskSchema,
    availabilityAskSchema,
  ]),
});

export type PeerAskBody = z.infer<typeof peerAskBodySchema>;

/** The archetype-discriminated request carried by an ask. */
export type PeerAskRequest = PeerAskBody['request'];
export type RelationshipAsk = z.infer<typeof relationshipAskSchema>;
export type ContentAsk = z.infer<typeof contentAskSchema>;
export type AvailabilityAsk = z.infer<typeof availabilityAskSchema>;

/** A free/busy interval — the ONLY calendar shape that crosses a peer boundary. */
export interface BusyInterval {
  /** ISO 8601. */
  start: string;
  /** ISO 8601. */
  end: string;
}

/**
 * The ONE word a non-answer is allowed to be, and the ONE sentence that may
 * accompany it.
 *
 * ═══ THE DECLINE ORACLE THAT SURVIVED THE BOX BOUNDARY ═══
 *
 * The wire used to carry `declined` for a block grant and `pending_review` for
 * an ask queued for a human, with `reason` spelling out which
 * ("Not permitted" / "Awaiting owner review"). Everything BELOW the status word
 * was already identical — no answer object, no counts, no grant id, no
 * data-class echo, the same HTTP status — but the word itself is a one-bit read
 * on the responder's grant matrix, and at the inbound limit of 10 asks a minute
 * the whole matrix is mappable by varying `queryType` and `dataClass`.
 *
 * #2210 and #2216 closed exactly this oracle for a LOCAL asker:
 * `CreateAskPayload.decision` became the constant `ASK_ACCEPTED`, and
 * `askerVisibleStatus` folds every non-`answered` status to `delivered`. The two
 * paths had made OPPOSITE decisions about the same question, and
 * `SendPeerAskPayload`'s docstring was already claiming the federated one
 * behaved like the local one ("a declined result is deliberately
 * indistinguishable from an unreachable peer"). This is what makes that true.
 *
 * WHY THE RESPONDER COLLAPSES IT, RATHER THAN THE ASKER'S BOX HIDING IT.
 * Collapsing on receipt would only bind a well-behaved asker: the raw word
 * would still be on the wire, and an asker box that simply declined to fold it
 * would keep the oracle. The distinction has to stop being SENT.
 *
 * WHAT THE ASKER LOSES, AND WHY IT NO LONGER MATTERS. The responder arguably
 * owed a peer a real answer to "should I wait?". That was the honest argument
 * for keeping `pending_review` — and it is answered instead by
 * {@link PeerAskResponse} being pollable: an asker that wants to know whether an
 * answer arrived asks again for the SAME `askId` and is told, rather than
 * inferring it from the responder's consent posture.
 */
export const PEER_ASK_PENDING = 'pending';

/** The only reason string a non-answer ever carries. Deliberately uninformative. */
export const PEER_ASK_NO_ANSWER_REASON = 'No answer is available';

/**
 * The peer's response.
 *
 * `status` is `answered` or {@link PEER_ASK_PENDING} — and NOTHING else. A
 * refusal, an ask sitting in the owner's review inbox, an ask that expired
 * unanswered, and an `askId` this box has never seen are all the same reply,
 * byte for byte. See {@link PEER_ASK_PENDING}.
 */
export interface PeerAskResponse {
  askId: string;
  status: 'answered' | typeof PEER_ASK_PENDING;
  /** Present only when status === 'answered'. */
  answer?: {
    /** Mirrors the disclosure form used locally. */
    form: 'boolean' | 'existence' | 'attribute' | 'retrieval' | 'identity' | 'availability';
    /** Templated, non-leaking summary for display. */
    summary: string;
    /** Item references (id + type) — retrieval form only, never raw content. */
    items?: { id: string; type: string }[];
    /** Count disclosed after the responder's redaction. */
    disclosedCount?: number;
    /** Count the responder withheld (never itemized). */
    withheldCount?: number;
    /** Free/busy intervals — availability form only. */
    busy?: BusyInterval[];
    free?: BusyInterval[];
  };
  /** Human-readable reason for a non-answer. Deliberately vague by design. */
  reason?: string;
}

/** A non-answer, in the only shape one is ever allowed to take. */
export function peerAskPending(askId: string): PeerAskResponse {
  return { askId, status: PEER_ASK_PENDING, reason: PEER_ASK_NO_ANSWER_REASON };
}

/**
 * What an OUTBOUND ask's own box is allowed to know about the reply.
 *
 * Deliberately NOT {@link PeerAskResponse}: this is the local side of the
 * boundary, so it speaks the LOCAL vocabulary — the same two words
 * `askerVisibleStatus` folds an ask's lifecycle down to, rather than a second,
 * parallel set that would then need its own mapping in every reader. `answered`
 * means an answer is waiting; `delivered` means the ask reached the peer and
 * nothing more is known.
 *
 * `reason` survives ONLY for a failure this box observed FIRST-HAND — an
 * endpoint the egress policy refused, a peer that did not respond, an HTTP
 * error. Those are facts about our own request, not about the responder's
 * consent posture. A reason the PEER supplied is dropped at
 * {@link PeerAskClient} rather than carried inward, because echoing an untrusted
 * string into the local UI is how the collapsed status would have been undone
 * one field along.
 */
export interface AskerVisiblePeerReply {
  askId: string;
  status: 'answered' | 'delivered';
  /** The disclosure-filtered answer, when the peer answered. */
  answer?: PeerAskResponse['answer'];
  /** Set only for locally-observed failures; never a reason the peer supplied. */
  reason?: string;
}

/** A peer as returned by CI-Portal discovery. */
export interface PeerDescriptor {
  handle: string;
  displayName?: string;
  /** Base URL of the peer's Companion (their `/agent/v1`). */
  memoryEndpoint: string;
  /** OIDC issuer that will sign this peer's outbound asks. */
  issuer?: string;
  /** OIDC subject of the peer's owning user. */
  subject?: string;
}
