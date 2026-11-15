# Trust Tasks alongside the peer surface

[Trust Tasks](https://trusttasks.org) is a Trust Over IP (DTGWG) framework for *self-contained, transport-agnostic, JSON-based task documents*: one object carrying its own type, parties, freshness and proof, with a registry of task specifications and a small set of transport bindings. This box serves it as a **second front door to the ask pipeline** — `POST /agent/v1/trust-tasks` — next to `POST /agent/v1/ask`. Same four gates behind it, a different way to establish who is asking.

Implemented against the framework **Working Draft 0.7.0** (spec commit `bdf2cdd9256f`, 2026-10-27, whose header still reads Working Draft 0.7.0, last updated 2026-09-24; several rules cited below, among them the hold rule (§8.6), the rule that a decision is not a failure (§8) and carried protocols (§9.4), were merged after the 0.7.0 release commit `23b33b9e6f73`) and the registry's HTTPS binding **0.3**. Code: [`backend/apps/api/src/domains/trust-tasks/`](../backend/apps/api/src/domains/trust-tasks/). Design record: `CI-Engineering` ADR-0015 and `projects/decentralized-trust-graphs/TRUST-TASKS.md`.

## Status in one paragraph

**Receiving works; sending does not exist yet.** A peer that holds a linked `did:keri:D<x>` identity can send a signed `ask/request` or `ask/collect` document and get a signed `#response` (or, once admitted, a signed `trust-task-error`). The surface is **off by default** and has been exercised in-process and against the official library's proofs, **not between two real boxes**. There is no outbound client: `OutboundAskService` still sends asks the way it always has. The "KERI" here is Companion Memory's own self-certifying `did:keri:D<jwk-x>` convention — **not CESR, no KEL, no rotation** — exactly as [`peers/sovereignKeyId.ts`](../backend/apps/api/src/domains/peers/sovereignKeyId.ts) says of itself. Nothing in this document makes that stronger.

## Turning it on

**Do not turn it on until the security review named in CI-Engineering ADR-0015 is done.**

All three must hold. Otherwise the route answers `404` with `Cannot POST /agent/v1/trust-tasks` — Nest's own words for a route that does not exist, so a box with the feature off cannot be told from one without it. (`POST /agent/v1/ask` answers `503` when *its* feature is off; that route is a known, advertised endpoint. This one is new and does not announce itself.)

| Requirement | How |
|---|---|
| The `trust.tasks` feature | `ENABLE_TRUST_TASKS=true` (default **false**) |
| The `ask` feature, which owns the pipeline behind it | `ENABLE_ASK` (default true) |
| A usable Ed25519 `peers.signingKeyJwk` | every response is signed. Setting it also makes this box sign every outbound peer request: read the two paragraphs below first |

Unlike the OIDC door, this one needs neither `peers.audience` (the signed `recipient` is the audience binding) nor `peers.requireHttpSignature`. `peers.signingKeyJwk` has **no environment variable**: set it in a config file or in `NODE_CONFIG` (`{"peers":{"signingKeyJwk":"<the private JWK, as a JSON string>"}}`). With the feature on and no usable key, the box logs `trust tasks closed: peers.signingKeyJwk is absent or is not a usable Ed25519 private JWK` once at start-up and the route stays `404`. A default install, with the feature off, logs nothing.

**Setting the key changes what this box sends.** With `peers.signingKeyJwk` set, this box signs every outbound peer ask and collect (RFC 9421), not only its Trust Task responses. A peer that links you by your Portal identity verifies any signature it is offered, even when it does not require one, and then refuses the ask: with `401` unless its link to you records your public key, which only hand-written SQL can do today (see *Message signatures* in [`peer-federation.md`](peer-federation.md#message-signatures)), and with `503` if it has no `peers.memoryEndpoint`. A peer on Companion Memory v2026.11.4 or earlier also refuses an ask whose `kid` is your `did:key` or `did:keri:D<x>`, even with your key recorded, and, behind its own gateway, every signed ask (*Where peers can reach this box* in [`peer-federation.md`](peer-federation.md#where-peers-can-reach-this-box)). A peer that links you under `did:key` or `did:keri` needs the key in any case, with `kid` set to that identifier. Agree this with every Portal-linked peer before you turn the door on.

**Installed from Companion Hub?** Do not set `peers.signingKeyJwk` on such a box yet. The Hub's listing for Companion Memory has no field for it, or for `ENABLE_TRUST_TASKS` and the `CI_PEER_*` settings, and the Hub rebuilds the app's environment file from the listing on every install, start and update. The one Hub mechanism that both persists a value and reaches the API container is the app's compose override in the Hub's user-config folder. That is ordinary app configuration, not a secret store: the Hub's app-configuration API and its MCP tools return it, and Hub backups copy it. Treat a key already placed there as exposed: remove it, and ask every peer that linked this box by that key (its `did:key` or `did:keri:D<x>`, or a key recorded on a Portal link) to revoke the link. Without a key the door stays closed (`404`). *Where peers can reach this box* in [`peer-federation.md`](peer-federation.md#where-peers-can-reach-this-box) lists what else stands between a Hub-installed box and its peers.

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

See *Binding a link to the peer's identity* in [`peer-federation.md`](peer-federation.md) for what that pair means. An AID that spells a key nobody could be held to — a non-canonical encoding, a string that is not on the curve, or one of the eight small-order points, under which a signature can be forged without any private key — is **never admitted, even when linked**. (Since Companion-Memory#3388 the RFC 9421 door refuses the same small-order and non-canonical AIDs, through `peers/sovereignKeyId.ts` and `peers/ed25519Weak.ts`, so neither door admits an AID that a signature can be forged under. The one difference left is that this door also refuses an AID that is not a point on the curve; the RFC 9421 door accepts one, and it can never verify a signature.)

The Trust-Task base is `peers.memoryEndpoint`, so the URL peers post to is `<memoryEndpoint>/trust-tasks` (HTTPS binding §6.1); behind Companion Memory's own gateway that is `https://<host>/api/agent/v1/trust-tasks`. **This box's VID** — what peers put in `recipient` — is `did:keri:D<x>` where `<x>` is the JWK `x` of `peers.signingKeyJwk`. With the JWK in a file:

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

**Every ask document is single-use.** An `ask/request` or `ask/collect` document is executed once. The identical bytes arriving again (a retry, a replay) get `204` and an empty body, and nothing is executed or handed back — answering a duplicate from the record would give the owner-released answer to anyone holding the captured bytes. A producer that lost its response sends a **fresh** `ask/collect` document, which is the asker's poll. The same goes for a failure after the document was accepted: it is reported as *not retryable*, because the identical bytes would be absorbed; send a new document (the carried protocol's `askId` makes that safe). A discovery document changes nothing, and is answered again, with `200`, each time it arrives within its acceptance window.

| Specification | Type URI (private; not `trusttasks.org`) | Carries | `#response` | Largest document |
|---|---|---|---|---|
| `ask/request` 0.1 | `https://ci.computer/trust-tasks/spec/ask/request/0.1` | `POST /agent/v1/ask` | the `PeerAskResponse` | 16 KiB |
| `ask/collect` 0.1 | `https://ci.computer/trust-tasks/spec/ask/collect/0.1` | `GET /agent/v1/ask/:askId` | the `PeerAskResponse` | 4 KiB |
| `trust-task-discovery` 0.1–0.4 | `https://trusttasks.org/spec/trust-task-discovery/<v>` | which types this box acts on | `supportedTypes`, `frameworkVersion`, and — in 0.3 and 0.4 only — the acceptance window | 16 KiB |

Discovery is answered in the version it was asked: 0.1 states the framework as `0.7`, 0.2 onward as `0.7.0`; 0.1 and 0.2 have no window field. A Type URI is a **name** (SPEC §6.1); nothing here dereferences one, and the ci.computer URIs do not currently resolve. The schemas are embedded in the code. Published copies live in the CI-Engineering design record.

## How a request is checked

SPEC §7.2, in the order this box can afford to run it ([`consumer.ts`](../backend/apps/api/src/domains/trust-tasks/consumer.ts)) — cheap and certain first, the first real CPU only for a caller who names an identity this box already deals with:

| Step | SPEC §7.2 | What this box does |
|---|---|---|
| 1 | 1, 3 | Outer shape checked by hand (`document.ts`); `type` parsed by the §6.1 grammar (`typeUri.ts`); unknown → `unsupportedType`, known slug at another version → `unsupportedVersion`; a `#response` is not served; `http`, reserved-slug-under-a-private-authority and `trusttasks.org` look-alikes are malformed |
| 2 | §7.3 item 21 | The document is no larger than its specification allows (bytes as received) — before anything is hashed |
| 3 | 4, 13 | `expiresAt` inclusive → `expired`; `issuedAt` beyond skew in the future, or `expiresAt ≤ issuedAt` → `malformedRequest` (not `expired`); a document older than 300 s + 30 s skew → `expired`, whatever `expiresAt` it states; a document with no usable `issuedAt` → `malformedRequest`, whatever its specification says, so no document outlives the window |
| 4 | 5, 6 | `recipient` must equal this box's VID → `wrongRecipient`; `issuer`/`recipient` that disagree with a transport identity → `identityMismatch`. **This binding derives no transport identity, so that cannot fire here today** |
| 5 | 7, 8 | A proof needs an in-band `recipient` (so it cannot be replayed to another box); no proof where one is required → `proofRequired` |
| 6 | 10 | **Admission of the claimed identity, before its proof**: one indexed look-up of an active peer link; a string that is not shaped like an AID never reaches the database. A caller who names an unlinked AID costs one look-up. The canonicalization and signature check are reached only by a caller who names an identity this box already deals with, and AIDs are public, so that cost is bounded by the 16 KiB size check, not by the peer's budget |
| 7 | 7, 8 | `proof` verified over the object **as received**; only `eddsa-jcs-2022`; an unsupported suite is `proofInvalid`, never "treat as unsigned"; the method must be the issuer's own and authorized for the stated `proofPurpose`; the key must be a usable one. A proof-level `@context` must lead the document's |
| 8 | — | The per-peer budget, the same ones as the peer route (`ask/request`: 10/min; everything else: the 30/min poll bucket), spent now that the sender is proved and admitted |
| 9 | 2 | Payload validated against the closed zod schema — after admission, so a stranger never reaches schema validation |
| 10 | 11 | The duplicate guard (`StoreDuplicateGuard` over `ConsumptionStore.claimOnce`), **last**, so a document turned away at 8 or 9 is free to be sent again byte for byte. Identical document again → absorbed (`204`); a *different* document under an accepted `id` → `idConflict` |
| — | 9, 12 | `ceremony` is ignored and grants no authority. The ask pipeline re-evaluates grant and ceiling on every ask; nothing is queued or delayed by this layer |

**Authentication is not authorization** (§7.2 item 10). All this layer decides is *admission*: an active link names this AID, and the key the link records, if any, is the key the AID spells out. Whether the ask is permitted is `PeerAskService`'s identity → link → grant → ceiling, unchanged.

## Decisions that look wrong and are not

- **A stranger gets a bare `401 Invalid token`, never a Trust Task error document.** Every failure after the body parsed and before the sender is proved *and* admitted — a bad proof, an AID the owner never linked, a key that differs from the link's, a stale, oversized or misaddressed document, an unsupported type — is the identical `401`, the same single refusal `PeerAskController` gives. SPEC §7.2 says a consumer *SHOULD* answer a rejection with an error response; §12.6 and §8.2.1 say that is an oracle for an unknown sender, and the HTTPS binding itself lists "transport-level, no framework error document" as a status row. The reason goes to the operator's log. (The shared body parser answers a body that is not JSON, or larger than its 100 kb default, with its usual `400`/`413` before this controller runs, on this route as on every other.)
- **Once admitted, refusals are signed `trust-task-error` documents** (`message` looked up from the code alone; never the sender's text). Only four codes can still arise by then: `unavailable` (`503`, `retryable: true`; over the per-peer budget, with a `retryAfter` rounded up to the next second, or the store unreachable when the budget is consulted, with none. The budget and the duplicate record share one store and the budget is consulted first, so a failure that reaches only the duplicate record reads as a duplicate: see *What is not here*), `malformedRequest` (`400`; the payload, or the ask pipeline's own `400`), `idConflict` (`409`) and `internalError` (`500`).
- **A consent outcome is never an error.** A block grant, a human decline, an expiry and an unknown `askId` are all `200` + `pending` (SPEC §8: "a decision is not a failure"; the same rule as ADR-0001). The Asks family never emits `permissionDenied`.
- **The key the link records wins.** An AID whose link records a different key is not admitted, even though the proof verifies under the key the AID spells out.
- **Responses are held to their own schema.** A handler result outside `answered`/`pending` is a `500 internalError`, not a response.
- **`identifierScope` is `public`.** A peer link is keyed by the peer's AID, so the same VID is presented to every box the peer is linked to; SPEC §13.1 prefers pairwise identifiers and requires this to be stated.

## What is not here

- **No KEL, no CESR, no rotation, no witnesses.** A compromised key means re-linking under a new AID. The design record's ACDC/TEL grants are not implemented by this change.
- **No outbound client.** Sending a Trust Task ask to a peer, and using discovery to choose between the two doors, are follow-ups.
- **No `did:key`.** The door admits only `did:keri:D<x>`. A peer the owner linked under `did:key`, as [`peer-federation.md`](peer-federation.md) and `CI-Engineering` ADR-0016 Decision 3 describe for Local.Pub peers, gets `401` here, and the owner cannot add a `did:keri:D<x>` link for the same key while that link is live: one key has one live link across both spellings, and the second spelling is refused with `409`. Today a peer can use both doors only if both boxes use the `did:keri:D<x>` spelling, in the signer's `kid` and in the link. The `did:key` codec has been in the peers domain since Companion-Memory#3388 (`peers/didKeyId.ts`; the barrel exports `didKeyPublicJwk` and `isDidKeyId`). Serving `did:key` here also needs a `did:key` `VidResolver`, admission under issuer `did:key` in `TrustTasksService.admits`, that issuer in place of the hard-coded `did:keri` (`SOVEREIGN_ISSUER`) in `engine.ts` (`spend`, `handler`), and a provenance key for it.
- **Not implemented from the framework:** `ext`/`extCritical`, ceremonies, task control (§11), `trust-task-next-step`, streamed responses, and the TSP and DIDComm bindings. Documents using them are refused or ignored per §7.2.
- **Length bounds count UTF-16 code units** (as the existing wire contract does); JSON Schema `maxLength` counts code points. For text with characters outside the Basic Multilingual Plane the box is the stricter of the two.
- **A failed claim reads as a duplicate.** When the claim statement fails after admission and the per-peer budget have both passed (a timeout, pool exhaustion, a failover), `ConsumptionStore.claimOnce` reports a key already taken. Nothing executes, but the producer gets `204` (or `idConflict`, when the failure falls between the guard's two claims) instead of the `unavailable` (`503`) that HTTPS binding 0.3 §5.1 item 5 requires. A `204` tells the producer the task completed: its `ask/collect` then answers `pending`, and only a fresh `ask/request` with the same `askId`, which the ask pipeline treats idempotently, recovers.
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
