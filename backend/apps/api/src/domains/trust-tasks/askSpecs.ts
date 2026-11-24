import { z, type ZodDiscriminatedUnionOption } from 'zod/v3';

import { PEER_ASK_ID_PATTERN, peerAskBodySchema } from '@ci/domains/peers';

import type { TaskSpecification } from './specs';

/**
 * The Trust Task specifications for Companion Asks: the protocol family that carries the peer-ask
 * wire contract (`peers/protocol.ts`, `docs/peer-federation.md`) as Trust Task documents (SPEC §9.4).
 *
 *   ask/request   the ask itself         → the `PeerAskBody` as `payload`, the `PeerAskResponse` as `#response`
 *   ask/collect   collect an answer      → `{ askId }`, answered with the same `PeerAskResponse`
 *
 * They are PRIVATE specifications (§6.5): the authority below is one this project controls and is not
 * `trusttasks.org`, so a Type URI here can never equal a registry one. The URIs are names. Nothing on
 * this box dereferences them, and the JSON Schemas are embedded at build time, which is exactly the
 * case §12.5 exempts from the schema-validation DoS concern.
 *
 * ═══ A DECISION IS NOT A FAILURE, AND ADR-0001 IS THE SAME RULE ═══
 *
 * §8 and §9.4 item 3: every answer the carried protocol can give, a negative one included, is the
 * OUTCOME and travels in the `#response`; an error response only reports that the task was not
 * performed. That is exactly ADR-0001: the asker sees `answered` or `pending` and nothing else, so a
 * block grant, a human decline, an expiry and an unknown `askId` are one reply. Mapping them to
 * `permissionDenied` would hand the asker the very oracle that ADR closes. The Asks family therefore
 * NEVER emits `permissionDenied` for a consent outcome, and the schema below has no field that could
 * carry one.
 *
 * ═══ THE PAYLOAD IS THE WIRE CONTRACT, CLOSED ═══
 *
 * The request payload is `peerAskBodySchema` with every object made strict (§7.3 item 7.4: state how
 * unrecognized members are treated — here, refused). One definition of the contract, not a second copy
 * to drift from it.
 */

/** Companion's own Type URI authority (§6.5). Never `trusttasks.org`. */
export const COMPANION_SPEC_ORIGIN = 'https://ci.computer/trust-tasks';
export const ASK_REQUEST_TYPE_URI = `${COMPANION_SPEC_ORIGIN}/spec/ask/request/0.1`;
export const ASK_COLLECT_TYPE_URI = `${COMPANION_SPEC_ORIGIN}/spec/ask/collect/0.1`;

type ArchetypeOption = ZodDiscriminatedUnionOption<'archetype'>;

const strictArchetypes = z.discriminatedUnion(
  'archetype',
  peerAskBodySchema.shape.request.options.map((option) => option.strict()) as unknown as [
    ArchetypeOption,
    ...ArchetypeOption[],
  ],
);

/** `ask/request` payload: the peer-ask body, closed at every level. */
export const askRequestPayloadSchema = peerAskBodySchema
  .extend({ actor: peerAskBodySchema.shape.actor.unwrap().strict().optional(), request: strictArchetypes })
  .strict();

/** `ask/collect` payload: the asker's own correlation id, bounded exactly as the poll route bounds it. */
export const askCollectPayloadSchema = z.object({ askId: z.string().regex(PEER_ASK_ID_PATTERN) }).strict();

const interval = z.object({ start: z.string().max(40), end: z.string().max(40) }).strict();

/**
 * The `#response` payload of both tasks: a `PeerAskResponse`. `status` is `answered` or `pending` and
 * NOTHING ELSE (ADR-0001); `reason` is the one deliberately uninformative sentence a non-answer carries.
 */
export const askResponsePayloadSchema = z
  .object({
    askId: z.string().regex(PEER_ASK_ID_PATTERN),
    status: z.enum(['answered', 'pending']),
    answer: z
      .object({
        form: z.enum(['boolean', 'existence', 'attribute', 'retrieval', 'identity', 'availability']),
        summary: z.string().max(2000),
        items: z
          .array(z.object({ id: z.string().max(200), type: z.string().max(100) }).strict())
          .max(1000)
          .optional(),
        disclosedCount: z.number().int().min(0).optional(),
        withheldCount: z.number().int().min(0).optional(),
        busy: z.array(interval).max(1000).optional(),
        free: z.array(interval).max(1000).optional(),
      })
      .strict()
      .optional(),
    reason: z.string().max(200).optional(),
  })
  .strict();

const CARRIED_PROTOCOL = {
  protocol: 'Companion Asks',
  version: '1',
  reference: 'https://github.com/companionintelligence/CI-Server/blob/main/docs/peer-federation.md',
} as const;

export const askRequestSpec: TaskSpecification = {
  typeUri: ASK_REQUEST_TYPE_URI,
  slug: 'ask/request',
  version: '0.1',
  title: 'Companion ask — request',
  targetFrameworkVersion: '0.7.0',
  status: 'draft',
  // Both parties are named in the signed document: the issuer is the asker's box, the recipient the
  // responder's. `public`-scope identifiers: a peer link is keyed by the asker's AID, so the same VID
  // is presented to every box the asker is linked to (SPEC §13.1 item 1 — see docs/trust-tasks.md).
  parties: { issuer: 'REQUIRED', recipient: 'REQUIRED' },
  bearer: false,
  proof: { request: 'REQUIRED', response: 'REQUIRED' },
  issuedAt: 'REQUIRED',
  sideEffects: {
    level: 'mutating',
    rationale:
      'Records the ask, its correlation and an audit row on the responder, and may queue it for the owner’s review.',
  },
  exposure: {
    discloses: 'secret',
    ingests: 'personal',
    actsAsSubject: true,
    rationale:
      'An answer discloses owner memory (item references, counts, free/busy) up to the grant’s ceiling, and a standing grant answers in the owner’s name with no person in the loop. The prompt is free text the asker wrote and may name people.',
  },
  retention: {
    class: 'durable',
    rationale:
      'The responder keeps the ask and its audit row, which is the durable consent record (ADR-0002 of the Asks series).',
  },
  // Single-use. The ask is idempotent by `askId` in the carried protocol, but that is the PROTOCOL's key, and
  // a captured document must not be able to read an answer back: an identical document arriving again is
  // absorbed (an empty `204`), and the asker collects with a fresh `ask/collect` document.
  repeatSafe: false,
  outcome:
    "The responder's box has recorded the ask and either answered it under the owner's standing grants or queued it for the owner's review. The asker learns only that an answer exists (`answered`, with the disclosure-filtered answer) or that none is available (`pending`).",
  freeText: [
    {
      member: 'askerHandle',
      maxLength: 120,
      reader: 'the owner, in the review inbox',
      retained: true,
      trusted: false,
    },
    {
      member: 'prompt',
      maxLength: 500,
      reader: 'the owner, in the review inbox',
      retained: true,
      trusted: false,
    },
    {
      member: 'purpose',
      maxLength: 200,
      reader: 'the owner, at the consent moment',
      retained: true,
      trusted: false,
    },
    {
      member: 'actor.label',
      maxLength: 80,
      reader: 'the owner, at the consent moment; never matched on',
      retained: true,
      trusted: false,
    },
    {
      member: 'request.subject',
      maxLength: 500,
      reader: "this box's search, and the owner",
      retained: true,
      trusted: false,
    },
    {
      member: 'request.identifiers',
      maxLength: 200,
      reader: "this box's search, and the owner",
      retained: true,
      trusted: false,
    },
    {
      member: 'request.dataClass',
      maxLength: 60,
      reader: "this box's search; a hint, never a filter",
      retained: true,
      trusted: false,
    },
    {
      member: 'request.purpose',
      maxLength: 200,
      reader: 'the owner, at the consent moment',
      retained: true,
      trusted: false,
    },
  ],
  // The largest legitimate document is under 14 KiB even if every character were written as a six-byte
  // escape; the usual one is under 2 KiB.
  maxDocumentBytes: 16384,
  request: askRequestPayloadSchema,
  response: askResponsePayloadSchema,
  carries: { ...CARRIED_PROTOCOL, operation: 'ask' },
};

export const askCollectSpec: TaskSpecification = {
  typeUri: ASK_COLLECT_TYPE_URI,
  slug: 'ask/collect',
  version: '0.1',
  title: 'Companion ask — collect an answer',
  targetFrameworkVersion: '0.7.0',
  status: 'draft',
  parties: { issuer: 'REQUIRED', recipient: 'REQUIRED' },
  bearer: false,
  proof: { request: 'REQUIRED', response: 'REQUIRED' },
  issuedAt: 'REQUIRED',
  sideEffects: {
    level: 'none',
    rationale: 'A read: it evaluates no grant, runs no executor, and writes no audit row.',
  },
  exposure: {
    discloses: 'secret',
    ingests: 'metadata',
    actsAsSubject: false,
    rationale: 'Returns the answer the owner or a standing grant already released to this peer.',
  },
  retention: {
    class: 'exchange',
    rationale: 'The one-use record of the document lasts the acceptance window; nothing else is written.',
  },
  // Single-use, although it is a read: it discloses the answer, so a captured document must not be able to
  // fetch it again. The peer route's single-use nonce gives the same property. A producer that lost the
  // response sends a fresh `ask/collect` document, which is the asker's poll anyway.
  repeatSafe: false,
  outcome:
    "The asker learns whether an answer to a previously sent ask is now available, and receives it, filtered to the ceiling the owner's decision set.",
  // `askId` is constrained by a pattern; nothing in the request is free text.
  freeText: [],
  maxDocumentBytes: 4096,
  request: askCollectPayloadSchema,
  response: askResponsePayloadSchema,
  carries: { ...CARRIED_PROTOCOL, operation: 'collect' },
};

export const ASK_SPECS: readonly TaskSpecification[] = [askRequestSpec, askCollectSpec];
