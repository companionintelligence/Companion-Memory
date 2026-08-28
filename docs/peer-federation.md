# Peer federation: asking questions across Companion memories

> Two Companion Memory boxes exchanging questions, discovered through CI-Portal.
> Feature flag: **`ask`** — **on** by default since 2026-08-17 (commit `793e618c0`), so the
> local ask/grant GraphQL surface is live out of the box. The *inbound peer* route stays
> dark for a separate reason: it also requires `peers.audience`, and 503s until an operator
> binds one. Tracking: [CI-Server #1711](https://github.com/companionintelligence/CI-Server/issues/1711) → epic #1712.

Most questions between people are really queries against the other person's memory — *"do you have photos of us?"*, *"do you know anyone at Acme?"*, *"free for lunch Friday?"*. Today those run over the worst possible protocol: interrupt the human, wait, hope they remember, get an unsourced answer.

Peer federation replaces that with:

> **human intent → standardized ask → the other person's Companion → consent gate → truthful, filtered answer**

The human stays in the loop exactly where they add value (consent, redaction) and leaves it where they don't (searching, remembering, compiling). That is what makes automated personal assistants possible without handing an assistant a copy of everyone's data.

---

## The shape of it

```
   Asker's box                 CI-Portal                  Responder's box
  ┌───────────┐            ┌──────────────┐             ┌───────────────┐
  │ Companion │──resolve──▶│  directory   │             │   Companion   │
  │           │◀─endpoint──│ (phone book) │             │               │
  │           │            └──────────────┘             │               │
  │           │─────── POST /agent/v1/ask ─────────────▶│  consent gate │
  │           │◀────── filtered answer ─────────────────│  run-as-owner │
  └───────────┘                                         └───────────────┘
```

**CI-Portal is a phone book, not a social network.** It answers exactly one question — *"who is `@handle`, where does their Companion listen, and what OIDC identity will they present?"* It stores **no** relationships, grants, asks, or answers. Those live only on the two boxes involved, so the cloud plane never accumulates the social graph.

## The three archetypes

Each is a separate wire shape, so a peer cannot smuggle a retrieval through an availability request. The asker names an **archetype and its constraints** — never a query over the responder's schema — so a peer can't probe storage layout either.

| Question | Archetype | Answer form | What crosses the wire |
|---|---|---|---|
| "Do you know X?" | `relationship` | boolean | yes/no — **no item references** |
| "Have you seen X content?" | `content` | existence | count/summary — **no item references** |
| "Free for lunch Friday at X?" | `availability` | free/busy | **interval boundaries only** |

Shape and vocabulary follow OID4VP/DCQL's "request specific claims, get a selectively-disclosed response" model rather than a datastore query. See [`domains/peers/protocol.ts`](../backend/apps/api/src/domains/peers/protocol.ts).

## Availability, and why it can answer itself

`computeFreeBusy()` ([`domains/peers/availability.ts`](../backend/apps/api/src/domains/peers/availability.ts)) is a pure function with an explicit disclosure contract:

- Output contains **only interval boundaries**. Titles, descriptions, locations, attendees, and event ids never appear.
- Overlapping and adjacent busy blocks are **merged**, which destroys the "how many meetings" signal as well.
- `minMinutes` filters the returned free slots, so *"free for lunch?"* doesn't come back with a useless 5-minute gap.

Because the output is provably free/busy only, an availability ask is **safe to auto-answer under a standing grant** — no human interruption. That is the unlock for agent-to-agent scheduling: two assistants can find a lunch slot without either seeing the other's calendar.

> **That argument is about the SHAPE of one answer, not about a SERIES of them.** Repeated over weeks, auto-answered free/busy is a presence log, and at the `family` and `trusted` tiers what crosses is the owner's real interval boundaries. See [asks-threat-model.md § T2](asks-threat-model.md#3-t2--stalking-via-availability) before widening this path or relying on this paragraph as a safety argument.

## The inbound pipeline

`POST /agent/v1/ask` and `GET /agent/v1/ask/:askId` are the **only** routes
another Companion can reach.

```
verified (iss,sub) → peer link → known askId ?  replay, decide nothing
                                             :  ask record → grant evaluation
   → auto ?  execute run-as-owner + disclosure filter  :  owner's review inbox
```

### `askId` is a real idempotency key

It was documented as one and read by nothing, so a repeat minted a **second**
`ci.asks` row and was re-evaluated from scratch: an ask the owner had personally
approved landed back in review, and the approved answer never left their box.
`ci.peer_ask_correlations` now binds the asker's id to the ask it produced,
**scoped by peer link** — two peers may independently mint the same uuid, and
one must never collect the other's answer. A `request_digest` binds one key to
one question, so a key reused for a different ask is refused as malformed rather
than answered with the first question's answer.

### Collecting an answer a human approved

`GET /agent/v1/ask/:askId` is the return path. It is a **read**: it evaluates no
grant, runs no executor, creates no ask and writes no audit row — it can only
hand back a disclosure that already happened, and a replay is never wider than
the live answer was (no item references, and the cardinality rule the live path
applies).

**A poll, not a callback.** A callback inverts who has to be reachable: exactly
one direction of egress is required today (asker → responder), and
`checkEgressUrl` is built around that. A callback would make the *responder*
dial an address the *asker* supplied — a second and more directly
attacker-controlled SSRF sink, on the box that holds the data — and would make a
home appliance an inbound server for its peers.

**And not an oracle.** An unknown `askId` is not a 404; it is the ordinary
non-answer. A 404 would answer "has this peer ever asked me that?" for free, and
separate it from "asked, and refused". Its own rate-limit bucket (30/60s, versus
10/60s for asks) keeps collecting an answer from spending the budget that exists
to protect a human's review inbox.

Everything after the peer-link step is the machinery Phases 0–1 already built and tested. **Federation adds a transport and an identity, not a second policy engine.**

The route deliberately does **not** use `JwtOrApiKeyAuthGuard`: its portal path JIT-provisions a local user, which is exactly what must not happen for a peer. It calls `verifyClaims()` instead — verify, never provision.

## Security properties

| Property | How it holds |
|---|---|
| **No shadow accounts** | Inbound asks use `verifyClaims()`; a peer never mints a local user on a box it can merely reach. |
| **No cross-box account takeover** | Users bind on OIDC **`(issuer, subject)`**, never `email`. Email is re-assignable and not unique across issuers, so matching on it once a second issuer is trusted hands the account to whoever controls that address. Email survives only as a **one-time** link, gated on `email_verified`. |
| **Unlinked = refused** | An ask from an unknown or revoked peer is rejected without detail; a stranger can't distinguish "no such user here" from "you aren't linked". |
| **Revocation is immediate** | Only `status='active'` links match, so revoking takes effect on the very next ask. |
| **No existence oracle** | Declines and pending-review responses are shaped identically to "nothing found". |
| **Hostile input** | Bodies are zod-validated against the archetype union and rejected off-contract. Peer *responses* are equally untrusted — `PeerAskClient.normalize()` carries forward only recognized fields, folds anything that is not `answered` to `delivered`, and drops the peer's `reason` string outright rather than echoing an attacker-supplied string into the local UI. |
| **No enumeration** | Portal search returns only opt-in `discoverable` entries; resolution requires an exact handle. |
| **Bounded blast radius** | Every outbound call is timeout-bounded; a slow or hostile peer degrades to a non-answer rather than hanging the caller. |
| **A non-answer says nothing about why** | The wire carries `answered` or `pending`, and one constant reason. A block grant, an ask in the owner's review inbox, an ask that expired, and an `askId` this box has never seen are the SAME reply. `declined` vs `pending_review` was a one-bit read on the grant matrix, mappable at 10 probes a minute — the same oracle #2210/#2216 closed for a local asker, which this had been cited as the precedent for. The collapse is made at the **responder**: hiding it on receipt would bind only a well-behaved asker while the word stayed on the wire. |
| **No SSRF** | Every server-side fetch goes through `peerEgressFetch()`, which is the only dialer in the domain. Three guards, not one: (1) `checkEgressUrl()` on the URL — https only, no credentials, no non-standard ports, no private/loopback/link-local/CGNAT/metadata/documentation address, no `.local`/`.internal`/bare-label name — including IPv4-mapped IPv6 in **both** spellings, since `URL` normalizes `::ffff:10.0.0.1` to hex, and every decimal/octal/hex/short IPv4 spelling, which `URL` folds to a dotted quad; (2) the resolved address is checked **at connect time** through the dispatcher's `lookup`, so there is no rebind window (see below); (3) **redirects are refused, not followed** — a peer answering `307 Location: http://127.0.0.1:11434/api/pull` used to have this box re-issue the POST, body intact, inside its own network. |
| **Token can't be replayed at another box** | The peer surface verifies the token against **this box's own `peers.audience`**, not the broad first-party list. It refuses to accept anything until that is configured. |
| **A leaked token is not, by itself, enough** | Requests carry an **RFC 9421 HTTP message signature** over `@method`, `@target-uri` and an RFC 9530 `Content-Digest` of the body, with a nonce and a bounded window. See [Message signatures](#message-signatures) — this is what a bearer token structurally cannot give: binding to *this* request, and detectable replay. |
| **Inbound flooding is bounded** | `PeerRateLimitService` limits on the verified `(issuer, subject)` **before** the peer-link lookup, so an unknown caller is limited too. |
| **Timezone-independent availability** | All-day events expand on **UTC** day boundaries, so two boxes in different zones compute identical busy spans. |

## Data model

| Table | Holds |
|---|---|
| `ci.federated_identities` | `(issuer, subject) → user`, the binding key. `bind_method` records `sub` vs one-time `email_link`. |
| `ci.peer_links` | The local half of the trust graph: handle, endpoint, peer `(iss,sub)`, **the peer's Ed25519 public JWK + its RFC 7638 thumbprint**, trust tier, revocation, and `person_entity_id` — the person in *your* memory this peer is (what makes "do you know X?" resolvable). One live link per `(owner, key)`, so which link answers is never decided by heap order. |
| `ci.asks` | Gains `peer_link_id` + `direction`. `asker_user_id` is **nullable** with a CHECK that exactly one of `(asker_user_id, peer_link_id)` identifies the asker — an inbound ask has no local asker. |
| `ci.ask_grants` | Gains `grantee_peer_link_id` (exactly-one CHECK) so consent can address a peer, not just a household member. |
| `ci.ask_audit` | Records the peer **FK-lessly**, matching its durability contract: removing a peer must not erase the record of what was disclosed to them. |

## Configuration

```jsonc
// backend/apps/api/config/default.json
"peers": {
  "directoryUrl": "",      // CI-Portal peer-discovery base; empty disables discovery
  "memoryEndpoint": "",    // this box's own /agent/v1, published to the directory
  "handle": "",            // this box's Portal handle
  "audience": "",          // REQUIRED for inbound: the audience Portal mints for THIS box
  "timeoutMs": 10000       // bound on every outbound peer/directory call
}
```

Env: `CI_PEER_DIRECTORY_URL`, `CI_PEER_MEMORY_ENDPOINT`, `CI_PEER_HANDLE`, `CI_PEER_AUDIENCE`, `CI_PEER_TIMEOUT_MS`.
The inbound surface is additionally gated by the **`ask`** feature flag (`ENABLE_ASK`), which
now ships **`true`**. Turning it off makes `POST /agent/v1/ask` return 503 — indistinguishable
from a box with no peer surface at all.

> **`peers.audience` is not optional for inbound.** Without it, a token issued for *any* first-party client would verify here — including one minted for a different Companion. The peer route refuses every request until it is set, rather than falling back to the broad list.

## Known limitations

> **Δ 2026-08-23 — two entries below were stale and are corrected in place.** Peer links and
> peer grants both have write paths now, and the ask surface has a route. **Re-verified
> later the same day against `origin/main` at `b82014a1b`** (the earlier note cited
> `8cd68dbe6`, since superseded by the nav restructure): every correction below still
> holds, and Asks additionally gained a **Power Rail entry of its own** — gated on `ask`,
> deliberately the same flag as the route and the resolvers, so the rail row and the page
> it points at can never disagree (`layouts/Main/railDestinations.ts`). The full, current
> gap list — including three ways peer-link revocation is still incomplete — is
> [`asks-system-guide.md` §9](asks-system-guide.md).

- ~~**There is no way to create a peer link except by hand.**~~ **Fixed.** `PeerLinkResolver`
  ships `myPeerLinks` / `peerLink` / `createPeerLink` / `updatePeerLink` / `revokePeerLink`,
  and the `/asks` page's **People I'm linked to** tab drives all of them —
  linking a peer and setting a trust tier is the one journey that completes end to end
  through the UI. `createAskGrant` likewise accepts `granteePeerLinkId` now (resolved
  through an owner-scoped read before it is stored), so a **peer grant** is no longer
  SQL-only either. What is NOT fixed: `updatePeerLink` goes through
  `PeerLinkService.upsert`, which sets `revokedAt: null` unconditionally — so editing a link
  erases its revocation timestamp — a revoked link still supplies its original trust tier to
  asks already in the inbox, and `PeerLinkResolver` is not gated by the `ask` feature flag
  while all sixteen `AskResolver` operations are.
- ~~**The ask surface is not reachable in the shipped web app.**~~ **Fixed.** `App.tsx`
  registers `/asks` behind `isFeatureEnabled('ask')` — flag-gated routes here are never
  registered rather than blocked, because with the flag off every ask mutation returns
  `success: false` and the route would be a page of dead buttons. The page has six tabs
  (For you · Ask someone · Sent · Who can ask me what · People I'm linked to · What I've
  shared) and is screenshotted in [`asks-system-guide.md` §8](asks-system-guide.md). Two
  things on it still do not work: **no UI calls `createAskGrant`**, so an owner cannot create
  a standing grant through the product, and the composer cannot send **across boxes** — it
  says so itself, because `sendPeerAsk` needs a Portal-minted access token this box cannot
  issue.
- ~~**DNS rebinding** is not closed…~~ **Closed.** This used to say that pinning the resolved IP
  through the socket "is not something Node's `fetch` exposes". That was wrong, and the
  counter-example was already in-tree: `domains/embed`'s `UnfurlFetcher` pins addresses through
  an undici `Agent` whose `connect.lookup` refuses blocked answers. `peers/urlPolicy.ts` now uses
  the same mechanism — a name that resolves to a private address is refused at connect time, and
  a name that resolves to *both* a public and a private address is refused outright rather than
  raced. One thing the connect-time guard does **not** cover: `net.connect` skips `lookup`
  entirely for a literal IP, so `checkEgressUrl`'s literal-address checks are load-bearing, not
  redundant (pinned by a test that measures it).
- **Rate limits are per-process and in-memory.** Correct for a single-instance appliance; a shared store is needed before the ask path goes multi-instance.
- **The peer access token is supplied by the caller**, not minted here, until Portal token exchange lands.
- **Nothing in GraphQL drives the collect route.** `OutboundAskService.pollForAnswer` and
  `PeerAskClient.poll` are both here and both tested, but no mutation calls them, so
  collecting an approved answer today means driving `GET /agent/v1/ask/:askId` directly (as
  the federation harness does). A `pollPeerAsk` mutation belongs in `AskResolver`.
- **`SendPeerAskPayload.answer` is never populated.** The peer's answer IS persisted locally
  the moment it arrives, so it reads through `askAnswer(askId)` like any other — which is
  the only route that works for an answer collected later anyway — but the field on the
  send payload stays null.

## Sending an ask (outbound)

`OutboundAskService` + the `sendPeerAsk` GraphQL mutation are the outbound half. The two directions are deliberately separate services: **inbound** treats the ask as hostile and the local owner as authoritative; **outbound** treats the local user as authoritative and the **peer's response** as untrusted. Conflating them would blur which side of the trust boundary each piece of data came from.

Two details worth knowing:

- The local `Ask` row is written **before** the request leaves, so an outbound ask is auditable even when the peer never answers — a peer that goes silent still leaves a record that this box asked.
- A **fresh correlation id** is sent per ask, never the local row id, which would leak this box's identifiers to the peer. It is persisted before the request leaves too: the id is minted internally and returned to nobody, so without the row a send that comes back with no answer — the only case a poll exists for — could never be named again.
- The peer's answer is **persisted** when it arrives: a `ci.ask_answers` row with `answer_source: 'peer'`, the local ask driven to `answered`, and one audit row, all in one transaction. Nothing used to write any of it, so even an auto-answered federated ask left this box with no readable answer. The responder's `consent_basis` is deliberately NOT stored — it is their grant id, and "standing pre-authorization or human decision?" is exactly the distinction the collapsed wire status exists to stop crossing.
- An outbound ask that was **not** answered writes no audit row at all. It is not a terminal outcome — it can still be collected — and the previous behaviour (an `outcome: 'declined'` row beside an ask still sitting at `delivered`) both contradicted itself and would now double-count once the answer was collected.

An unknown handle and a revoked link are refused **identically**, so a caller cannot use the error to discover which handles the owner has ever been linked to.

### Purpose, and what it is for

`peerAskBodySchema` carries a body-level `purpose`, and `toAskQuery` writes it into `filters.purpose` on **every** archetype.

It did not, and that was a real (if fail-closed) defect: `scopeCoversQuery` reads `filters.purpose`, and nothing ever wrote one — `availability` folded its purpose into the *prompt* and the other two archetypes had no field at all. A purpose-limited grant therefore matched **no inbound peer ask, ever**. It failed closed, so nothing leaked; the feature was simply dead across boxes, silently, with no signal to the owner who set it.

Two different treatments, deliberately:

- **Stated intent is carried, shown, and never judged.** UMA-for-agents' recommendation #15 — carry a requester's purpose unread and let policy notice its *absence* rather than judge its truthfulness. This box cannot verify why anyone wants anything, so the review card attributes it (*"They say this is for: …"*) and says so plainly when none was stated.
- **A purpose-LIMITED grant is enforced**, because that is the owner writing down their own narrowing ("only for the wedding invites"). It can only ever refuse to match, never widen — and a grant that names a purpose is not satisfied by an ask that states none.

`canonicalPurpose` is its own function rather than a reuse of `canonicalDataClass`. Same normalizer today, different contract: a data class is a token from a closed vocabulary and may one day be aliased or singularized; a purpose is a short human phrase and must not be.

### Message signatures
<a id="message-signatures"></a>

The bearer token answers "who is asking". It cannot answer "is this the request they asked", and that gap is a property of bearer tokens rather than of the implementation:

- **A leaked token is a complete impersonation** for its whole lifetime — nothing binds it to the request it arrived on.
- **Nothing binds it to the body.** Anything on the path can rewrite the question and the token still verifies.
- **Replay is undetectable.** Only the `askId` idempotency key limits the damage, and it limits it per-key, not per-request.

UMA-for-agents makes retiring bearer RPTs its recommendation #4 for exactly this. Both peer routes now accept an RFC 9421 signature:

```
Content-Digest: sha-256=:<base64>:
Signature-Input: ci=("@method" "@target-uri" "content-digest");created=…;expires=…;keyid="<thumbprint>";alg="ed25519";nonce="…"
Signature: ci=:<base64>:
```

The profile is deliberately narrow — `ed25519` only, exactly five parameters, exactly one label — and `httpSignature.ts` **rejects** anything outside it rather than skipping past it. A permissive parser here accepts signatures that cover less than they appear to.

Details that are load-bearing rather than incidental:

- **The digest covers the raw bytes.** `BodyParserMiddleware` retains the unparsed body for `/agent/v1` only (a `verify` hook on express `json()`), because `JSON.stringify` of a parsed object is not guaranteed to reproduce what the sender sent. Re-serializing before digesting is the classic way to make a check pass over content nobody signed. Scoped to that one prefix so a second copy of every 10mb GraphQL body is not retained.
- **`@target-uri` is built from config, never from `Host`.** It is a *signed* component, so whatever this box reconstructs is what gets checked; letting a caller pick the authority half would let a signature minted for `evil.example` verify here. The origin comes from `peers.memoryEndpoint` and the path from the route — the same rule as UMA's "authorization inputs never come from transport headers". A box with no published endpoint refuses to verify at all rather than guessing.
- **The window is bounded at both ends.** `expires` is the *sender's* choice, so `MAX_SIGNATURE_LIFETIME_MS` (5 min) caps it — otherwise a peer signs one request with a year-long window and has a bearer token again. That bound is also what keeps the nonce cache finite.
- **The nonce cache is the replay defence**, checked *last* and only for an otherwise-valid signature: checking earlier would let an attacker burn a victim's nonce with a corrupted copy and deny the honest request behind it. Scoped per key thumbprint so one peer cannot burn another's. In-memory and per-process — the same caveat as the rate limiters (guide §9, G8).
- **The key and the token must agree.** A signature is accepted only when a live link holds that key *and* names the same `(issuer, subject)` the token asserts. Accepting any link that merely holds the key would let peer A's signature authorize a request carrying peer B's token.
- **One refusal for every failure.** Missing, malformed, unknown key, bad digest, replayed, wrong peer — all raise the identical 401. Which check failed is a fact about this box's configuration and the owner's links; the reason is logged where the operator sees it and the caller does not.

**Rollout is two switches, deliberately.** Setting `peers.signingKeyJwk` makes this box *sign*; setting `peers.requireHttpSignature` makes it *demand* signatures. An offered signature is always verified even when not required, which is what lets an operator confirm both sides interoperate before flipping the second switch. Generate a key with:

```bash
node -e "const {generateKeyPairSync}=require('node:crypto');console.log(JSON.stringify(generateKeyPairSync('ed25519').privateKey.export({format:'jwk'})))"
```

The peer records the **public** half on its `ci.peer_links` row (`peer_key_jwk` + `peer_key_thumbprint`); `publicKeyFromJwk` refuses a JWK carrying `d`, so a private key cannot be stored there and then used to "verify" its own signatures.

### What the owner sees

Verification outcomes are **persisted, not merely logged** — `ci.asks` gains `channel_key_thumbprint`, `channel_verified_at` and `channel_covered`, stamped as of arrival so a later key rotation cannot rewrite what signed a past request. `AskType.channel` exposes them, responder-only for the same reason `consentBasis` is: they describe what the *responder's* box checked, and handing them to the asker is a probe into this box's configuration.

The surfaces are a **lock** on every ask and disclosure row, opening a **signature detail modal**:

- `frontend/apps/web/src/pages/AsksPage/ConsentLock.tsx` — four states (`sealed` / `consented` / `pending` / `open`), each carried in text beside the icon.
- `.../ConsentDetailModal.tsx` — consent, channel and collection as three separate sections, with each covered component rendered beside *the thing it protects*.
- `.../consentProvenance.ts` — the pure vocabulary, unit-tested.

Two rules the components are built around, both in `consentProvenance.ts`:

- **Weakest wins.** A signature proves who asked, not that they were allowed to, so an undecided ask reads *Awaiting you* even when it arrived signed. The lock never rounds up.
- **The common case is not a warning.** Signing ships off and a local ask never crosses a network, so *Consented* is the honest reading of most disclosures and is rendered as a plain badge. A UI that painted the ordinary case as a problem would teach people to ignore it.

`ci.ask_audit` does **not** carry channel provenance, so a Disclosure History row says the channel was *not recorded* rather than rendering a null as "unsigned" — asserting a fact nobody checked. Carrying it into the audit is the follow-up.

Full protocol reference, with the verification-order chart and the threat table: [`CI-Engineering/projects/decentralized-trust-graphs/SIGNATURES.md`](https://github.com/companionintelligence/CI-Engineering/blob/main/projects/decentralized-trust-graphs/SIGNATURES.md). User-facing guide: [Asking Other Companions](https://docs.ci.computer/docs/companion-memory/asking-other-companions).

**Not yet:** the key is a *second factor*, not the identity. Downstream routing still resolves a link by `(issuer, subject)`. Making the thumbprint primary and the Portal token an optional attestation — UMA's `FLOW.md` result, that the owner's policy is identical under every identity regime — needs the thumbprint threaded through `PeerAskService`, and is the follow-up. Our consent code already agrees with that direction: nothing in `grantMatch.ts` or `policy.ts` mentions an issuer.

### The token

`sendPeerAsk` takes a `peerAccessToken` — a Portal-issued token whose audience is the **peer** box. It is a **non-nullable** field on `SendPeerAskInput`: until Portal token exchange (RFC 8693) lands, the *caller* must supply it, and this box never mints, exchanges or caches one. The peer verifies that binding on receipt, which is what stops a token for one box being replayed at another.

## Status

**Both directions work, including the return trip — given a link and a token.** A box can receive, gate, and answer a federated ask; can compose and send one; and can now collect an answer its peer's owner approved after the fact. Peer-link management and the ask UI's route both landed (see the Δ note under Known limitations). Still open: a `pollPeerAsk` mutation so a person can press the collect button, a UI entry point for `createAskGrant`, an MCP tool so assistants can drive asks directly, and Portal token exchange so the access token is minted rather than passed in — the last of which is what stops the composer sending an ask across boxes at all.

## See also

- **The reference document:** [`asks-system-guide.md`](asks-system-guide.md) — the consent
  model in full, the ask lifecycle with the tables written at each step, the deliberate
  privacy properties and their reasoning, how to run everything, and the current gap list.

- Design: [`CI-Engineering/projects/decentralized-trust-graphs/`](https://github.com/companionintelligence/CI-Engineering/tree/main/projects/decentralized-trust-graphs) (PRD · ARCHITECTURE · ROADMAP · USE-CASES · UX)
- The intra-box ask this inverts: [`saved-search-sharing.md`](saved-search-sharing.md)
