# Trust Tasks alongside the peer surface

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

[Trust Tasks](https://trusttasks.org) is a Trust Over IP (DTGWG) framework for *self-contained, transport-agnostic, JSON-based task documents*: one object carrying its own type, parties, freshness and proof, with a registry of task specifications and a small set of transport bindings. This box serves it as a **second front door to the ask pipeline** — `POST /agent/v1/trust-tasks` — next to `POST /agent/v1/ask`. Same four gates behind it, a different way to establish who is asking.

Implemented against the framework **Working Draft 0.7.0** (spec commit `bdf2cdd9256f`, 2026-09-24) and the registry's HTTPS binding **0.3**. Code: [`backend/apps/api/src/domains/trust-tasks/`](../backend/apps/api/src/domains/trust-tasks/). Design record: `CI-Engineering` ADR-0015 and `projects/decentralized-trust-graphs/TRUST-TASKS.md`.

## Status in one paragraph

**Receiving works; sending does not exist yet.** A peer that holds a linked `did:keri:D<x>` identity can send a signed `ask/request` or `ask/collect` document and get a signed `#response` (or, once admitted, a signed `trust-task-error`). The surface is **off by default** and has been exercised in-process and against the official library's proofs, **not between two real boxes**. There is no outbound client: `OutboundAskService` still sends asks the way it always has. The "KERI" here is Companion Memory's own self-certifying `did:keri:D<jwk-x>` convention — **not CESR, no KEL, no rotation** — exactly as [`peers/sovereignKeyId.ts`](../backend/apps/api/src/domains/peers/sovereignKeyId.ts) says of itself. Nothing in this document makes that stronger.

## Turning it on

All three must hold. Otherwise the route answers `404` with `Cannot POST /agent/v1/trust-tasks` — Nest's own words for a route that does not exist, so a box with the feature off cannot be told from one without it. (`POST /agent/v1/ask` answers `503` when *its* feature is off; that route is a known, advertised endpoint. This one is new and does not announce itself.)

| Requirement | How |
|---|---|
| The `trust.tasks` feature | `ENABLE_TRUST_TASKS=true` (default **false**) |
| The `ask` feature, which owns the pipeline behind it | `ENABLE_ASK` (default true) |
| A usable Ed25519 `peers.signingKeyJwk` | every response is signed; the same key already signs outbound RFC 9421 requests |

Unlike the OIDC door, this one needs neither `peers.audience` (the signed `recipient` is the audience binding) nor `peers.requireHttpSignature`. `peers.signingKeyJwk` has **no environment variable**: set it in a config file or in `NODE_CONFIG` (`{"peers":{"signingKeyJwk":"<the private JWK, as a JSON string>"}}`). With the feature on and no usable key, the box logs `trust tasks closed: peers.signingKeyJwk is absent or is not a usable Ed25519 private JWK` once at start-up and the route stays `404`. A default install, with the feature off, logs nothing.

Per sender, the owner must also create an **active peer link** for the sender's AID. A sovereign peer is keyed `peerIssuer: "did:keri"`, `peerSubject: "did:keri:D<x>"` (the whole identifier, as the peer uses it in `issuer`):

```graphql
mutation { createPeerLink(input: {
  peerHandle: "alice@portal.example"
  memoryEndpoint: "https://alice.example/agent/v1"
  peerIssuer: "did:keri"
  peerSubject: "did:keri:D<alice x>"
  trustTier: peer
}) { success peerLink { id peerHandle trustTier } } }
```

```bash
ci peers add alice@portal.example https://alice.example/agent/v1 \
  --peer-issuer did:keri --peer-subject did:keri:D<alice x>
```

See *Binding a link to the peer's identity* in [`peer-federation.md`](peer-federation.md) for what that pair means. An AID that spells a key nobody could be held to — a non-canonical encoding, a string that is not on the curve, or one of the eight small-order points, under which a signature can be forged without any private key — is **never admitted, even when linked**. (`peers/sovereignKeyId.ts` checks only the AID's shape, so the RFC 9421 door still takes such an AID; that is a gap in the existing door this change does not touch.)

The Trust-Task base is `peers.memoryEndpoint`, so the URL peers post to is `<memoryEndpoint>/trust-tasks` (HTTPS binding §6.1). **This box's VID** — what peers put in `recipient` — is `did:keri:D<x>` where `<x>` is the JWK `x` of `peers.signingKeyJwk`. With the JWK in a file:

```bash
node -e "console.log('did:keri:D' + JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).x)" key.jwk
```

The VID is derived from the key itself, not from a `kid` label.

## What goes over the wire

A request is an ordinary Trust Task document, sent as `application/json`. There is **no bearer token and no transport identity**: the HTTPS binding gives no end-to-end guarantee (its §5), so the sender is established only by the proof inside the document, and `Authorization` is ignored. The proof is a W3C Data Integrity `eddsa-jcs-2022` proof: Ed25519 over `SHA-256(JCS(proof options)) ‖ SHA-256(JCS(document without proof))`.

```json
{
  "id": "urn:uuid:5b0a8c9e-2c1f-4f7e-9d2a-6f1e0a4b7c10",
  "type": "https://ci.computer/trust-tasks/spec/ask/request/0.1",
  "issuer": "did:keri:D<asker x>",
  "recipient": "did:keri:D<responder x>",
  "issuedAt": "2026-11-05T12:00:00Z",
  "payload": {
    "askId": "ask-2026-11-05-0001",
    "askerHandle": "alice",
    "prompt": "Are you free for lunch on Friday?",
    "request": { "archetype": "availability", "from": "2026-11-06T11:00:00Z", "to": "2026-11-06T14:00:00Z", "minMinutes": 60 }
  },
  "proof": {
    "type": "DataIntegrityProof",
    "cryptosuite": "eddsa-jcs-2022",
    "created": "2026-11-05T12:00:00Z",
    "verificationMethod": "did:keri:D<asker x>#D<asker x>",
    "proofPurpose": "authentication",
    "proofValue": "z…"
  }
}
```

The `payload` is **exactly the peer-ask body** (`peers/protocol.ts` → `peerAskBodySchema`), closed at every level. The reply is `…/ask/request/0.1#response`, issued by the box, addressed to the asker, on the request's thread, whose payload is a `PeerAskResponse`: `status` is `answered` or `pending` and **nothing else**.

**Every document is single-use.** A document is executed once. The identical bytes arriving again (a retry, a replay) get `204` and an empty body, and nothing is executed or handed back — answering a duplicate from the record would give the owner-released answer to anyone holding the captured bytes. A producer that lost its response sends a **fresh** `ask/collect` document, which is the asker's poll. The same goes for a failure after the document was accepted: it is reported as *not retryable*, because the identical bytes would be absorbed; send a new document (the carried protocol's `askId` makes that safe).

| Specification | Type URI (private; not `trusttasks.org`) | Carries | `#response` | Largest document |
|---|---|---|---|---|
| `ask/request` 0.1 | `https://ci.computer/trust-tasks/spec/ask/request/0.1` | `POST /agent/v1/ask` | the `PeerAskResponse` | 16 KiB |
| `ask/collect` 0.1 | `https://ci.computer/trust-tasks/spec/ask/collect/0.1` | `GET /agent/v1/ask/:askId` | the `PeerAskResponse` | 4 KiB |
| `trust-task-discovery` 0.1–0.4 | `https://trusttasks.org/spec/trust-task-discovery/<v>` | which types this box acts on | `supportedTypes`, `frameworkVersion`, and — in 0.3 and 0.4 only — the acceptance window | 16 KiB |

Discovery is answered in the version it was asked: 0.1 states the framework as `0.7`, 0.2 onward as `0.7.0`; 0.1 and 0.2 have no window field. A Type URI is a **name** (SPEC §6.1); nothing here dereferences one, and the ci.computer URIs do not currently resolve. The schemas are embedded in the code. Published copies live in the CI-Engineering design record.

## How a request is checked

SPEC §7.2, in the order this box can afford to run it ([`consumer.ts`](../backend/apps/api/src/domains/trust-tasks/consumer.ts)) — cheap and certain first, the first real CPU only for a caller this box already deals with:

| Step | SPEC §7.2 | What this box does |
|---|---|---|
| 1 | 1, 3 | Outer shape checked by hand (`document.ts`); `type` parsed by the §6.1 grammar (`typeUri.ts`); unknown → `unsupportedType`, known slug at another version → `unsupportedVersion`; a `#response` is not served; `http`, reserved-slug-under-a-private-authority and `trusttasks.org` look-alikes are malformed |
| 2 | §7.3 item 21 | The document is no larger than its specification allows (bytes as received) — before anything is hashed |
| 3 | 4, 13 | `expiresAt` inclusive → `expired`; `issuedAt` beyond skew in the future, or `expiresAt ≤ issuedAt` → `malformedRequest` (not `expired`); a document older than 300 s + 30 s skew → `expired`, whatever `expiresAt` it states |
| 4 | 5, 6 | `recipient` must equal this box's VID → `wrongRecipient`; `issuer`/`recipient` that disagree with a transport identity → `identityMismatch`. **This binding derives no transport identity, so that cannot fire here today** |
| 5 | 7, 8 | A proof needs an in-band `recipient` (so it cannot be replayed to another box); no proof where one is required → `proofRequired` |
| 6 | 10 | **Admission of the claimed identity, before its proof**: one indexed look-up of an active peer link; a string that is not shaped like an AID never reaches the database. A stranger costs a look-up, not a canonicalization of a document someone else chose |
| 7 | 7, 8 | `proof` verified over the object **as received**; only `eddsa-jcs-2022`; an unsupported suite is `proofInvalid`, never "treat as unsigned"; the method must be the issuer's own and authorized for the stated `proofPurpose`; the key must be a usable one. A proof-level `@context` must lead the document's |
| 8 | — | The per-peer budget, the same ones as the peer route (`ask/request`: 10/min; everything else: the 30/min poll bucket), spent now that the sender is proved and admitted |
| 9 | 2 | Payload validated against the closed zod schema — after admission, so a stranger never reaches schema validation |
| 10 | 11 | The duplicate guard (`StoreDuplicateGuard` over `ConsumptionStore.claimOnce`), **last**, so a document turned away at 8 or 9 is free to be sent again byte for byte. Identical document again → absorbed (`204`); a *different* document under an accepted `id` → `idConflict` |
| — | 9, 12 | `ceremony` is ignored and grants no authority. The ask pipeline re-evaluates grant and ceiling on every ask; nothing is queued or delayed by this layer |

**Authentication is not authorization** (§7.2 item 10). All this layer decides is *admission*: an active link names this AID, and the key the link records, if any, is the key the AID spells out. Whether the ask is permitted is `PeerAskService`'s identity → link → grant → ceiling, unchanged.

## Decisions that look wrong and are not

- **A stranger gets a bare `401 Invalid token`, never a Trust Task error document.** Every failure after the body parsed and before the sender is proved *and* admitted — a bad proof, an AID the owner never linked, a key that differs from the link's, a stale, oversized or misaddressed document, an unsupported type — is the identical `401`, the same single refusal `PeerAskController` gives. SPEC §7.2 says a consumer *SHOULD* answer a rejection with an error response; §12.6 and §8.2.1 say that is an oracle for an unknown sender, and the HTTPS binding itself lists "transport-level, no framework error document" as a status row. The reason goes to the operator's log. (The shared body parser answers a body that is not JSON, or larger than its 100 kb default, with its usual `400`/`413` before this controller runs, on this route as on every other.)
- **Once admitted, refusals are signed `trust-task-error` documents** (`message` looked up from the code alone; never the sender's text). Only four codes can still arise by then: `unavailable` (`503`; over the per-peer budget, with `retryable: true` and a `retryAfter` rounded up to the next second, or the duplicate record unreachable), `malformedRequest` (`400`; the payload, or the ask pipeline's own `400`), `idConflict` (`409`) and `internalError` (`500`).
- **A consent outcome is never an error.** A block grant, a human decline, an expiry and an unknown `askId` are all `200` + `pending` (SPEC §8: "a decision is not a failure"; the same rule as ADR-0001). The Asks family never emits `permissionDenied`.
- **The key the link records wins.** An AID whose link records a different key is not admitted, even though the proof verifies under the key the AID spells out.
- **Responses are held to their own schema.** A handler result outside `answered`/`pending` is a `500 internalError`, not a response.
- **`identifierScope` is `public`.** A peer link is keyed by the peer's AID, so the same VID is presented to every box the peer is linked to; SPEC §13.1 prefers pairwise identifiers and requires this to be stated.

## What is not here

- **No KEL, no CESR, no rotation, no witnesses.** A compromised key means re-linking under a new AID. The design record's ACDC/TEL grants are not implemented by this change.
- **No outbound client.** Sending a Trust Task ask to a peer, and using discovery to choose between the two doors, are follow-ups.
- **No `did:key`.** A `did:key` VID resolver would plug into `VidResolver`; it waits on `peers/didKeyId.ts`.
- **Not implemented from the framework:** `ext`/`extCritical`, ceremonies, task control (§11), `trust-task-next-step`, streamed responses, and the TSP and DIDComm bindings. Documents using them are refused or ignored per §7.2.
- **Length bounds count UTF-16 code units** (as the existing wire contract does); JSON Schema `maxLength` counts code points. For text with characters outside the Basic Multilingual Plane the box is the stricter of the two.
- **A store outage can read as a duplicate.** `ConsumptionStore.claimOnce` can only say "no" when it cannot reach its state, so the guard fails closed (nothing executes) but cannot say `unavailable`: the producer sees `204` and no answer. Sending a new document with the same `askId` is the remedy.
- **`idConflict` is said once.** The exact `(id, digest)` record is not released, so a conflicting document is told `idConflict` the first time; the same bytes again are absorbed (`204`).
- **`AskChannelProvenance.covered` carries a scheme token** (`trust-task:eddsa-jcs-2022`), not a list of signed HTTP components as the RFC 9421 door does. It is stored with the ask (`ci.asks.channel_covered`) and projected by the GraphQL `AskType` channel field, so a client that reads its entries as HTTP component names will meet a value it does not know. Follow-up: decide whether the field should name the signed members instead.
- **The framework's "held for approval" rule is not followed.** SPEC §8.6 says a task held for an approval *MUST* be answered with `trust-task-next-step`. An ask queued for the owner is such a hold, but saying so would tell the asker "held for a human" and so separate it from a refusal — the oracle ADR-0001 closes. The ask answers `pending`, the carried protocol's own answer (SPEC §9.4 item 3). Raised for the working group in the design record.

## Tests

`backend/apps/api/src/domains/trust-tasks/**/*.spec.ts` — 296 tests in 11 suites: the W3C `eddsa-jcs-2022` worked example byte for byte (including the published signed credential and its proof `@context`), RFC 8785's sorting and number tables, the eight small-order points and four non-canonical encodings, every §7.2 rejection, the order of admission, throttle and claim, the duplicate rules, the controller's refusals, and the bounds the specifications state (checked against what the schemas enforce, and the largest legitimate document against the size limit).

```bash
cd backend/apps/api && yarn test src/domains/trust-tasks
```

Three checks were run once from a scratch harness outside the repository, and are not part of the suite: proofs made by the official `@openvtc/trust-tasks-proof` library verify here and the reverse, with identical `proofValue`s for identical inputs; the published JSON Schemas (in the design record) agree with the zod schemas on 210 boundary samples; and this module's `did:keri:D<x>` parse never accepts what `peers/sovereignKeyId.ts` rejects.

## See also

- [`peer-federation.md`](peer-federation.md) — the pipeline this sits in front of, and *Message signatures* (the RFC 9421 door beside it)
- [`asks-system-guide.md`](asks-system-guide.md) — the consent model
- [`asks-threat-model.md`](asks-threat-model.md) — **read before changing any ceiling**
- Design: `CI-Engineering/adr/0015-trust-tasks-alongside-keri.md`, `CI-Engineering/projects/decentralized-trust-graphs/TRUST-TASKS.md`
- Framework: <https://trusttasks.org> · <https://github.com/trustoverip/dtgwg-trust-tasks-spec>
