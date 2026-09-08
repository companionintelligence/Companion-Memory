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
| **No SSRF** | Every server-side fetch goes through `peerEgressFetch()`, which is the only dialer in the domain. Three guards, not one: (1) `checkEgressUrl()` on the URL — https only, no credentials, no non-standard ports, no private/loopback/link-local/CGNAT/metadata/documentation address, no `.local`/`.internal`/bare-label name — including IPv4-mapped IPv6 in **both** spellings, since `URL` normalizes `::ffff:10.0.0.1` to hex, and every decimal/octal/hex/short IPv4 spelling, which `URL` folds to a dotted quad; (2) the resolved address is checked **at connect time** through the dispatcher's `lookup`, so there is no rebind window (see below); (3) **redirects are refused, not followed** — a peer answering `307 Location: http://127.0.0.1:11434/api/pull` used to have this box re-issue the POST, body intact, inside its own network. CGNAT specifically is opt-in-permittable ([below](#peering-over-a-private-network-tailscale--cgnat)); everything else in that list is unconditional. |
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

### Peering over a private network (Tailscale / CGNAT)

`checkEgressUrl` (`domains/peers/urlPolicy.ts`) refuses CGNAT space
(`100.64.0.0/10`) by default, alongside RFC1918, loopback, and link-local —
correct for the general case, since a hostile directory entry pointing there
would have this box reach into whatever network it happens to sit on. The
appliance is also routinely run **on** a Tailscale tailnet, which lives in
that exact range, so the default posture makes it impossible to federate two
Companions an operator has deliberately linked over their own private mesh.
Confirmed live: a real cross-machine `sendPeerAsk` between two genuinely
separate appliances over Tailscale refused with *"Peer endpoint not
permitted"* before this setting existed.

```jsonc
// backend/apps/api/config/default.json
"peers": {
  // ...
  "allowCgnatEndpoints": false   // CI_PEER_ALLOW_CGNAT_ENDPOINTS
}
```

**Off by default, and off is byte-identical to before this setting existed** —
every existing test, and every deployment that has not set the env var, sees
no change at all. Set `CI_PEER_ALLOW_CGNAT_ENDPOINTS=true` only when you have
personally linked this box's peers over a private network you trust (a
Tailscale tailnet, most commonly). Turning it on is a statement that **you**
are vouching for that address space, not the platform — it stays loud about
it: the box logs a warning at boot while the flag is set, and again the first
time it actually lets a peer call through that would otherwise have been
refused.

What it does **not** do, on purpose:

- **RFC1918 (`10/8`, `172.16/12`, `192.168/16`) stays blocked regardless.**
  That space is where an appliance's own infrastructure typically lives — its
  Docker network, its Postgres, a cloud VPC's internal services — so folding
  it into the same switch would trade a narrow, tested federation scenario for
  a much larger SSRF surface against the box's own internals. A deployment
  that genuinely needs RFC1918 peer egress needs its own explicit flag, not
  this one.
- **Loopback (`127.0.0.0/8`), link-local (`169.254.0.0/16`, including cloud
  metadata) and `0.0.0.0/8` are never gated by this flag, at any setting.**
  Those guard against the box dialing *its own* services — a different
  mistake than "I run a private mesh" — and no operator intent reopens them.
- **The DNS-rebinding and redirect protections are unaffected.** The
  connect-time address pin (`peerEgressLookup`) and the zero-redirects rule in
  `peerEgressFetch` apply to a CGNAT peer exactly as they do to a public one —
  a CGNAT-looking hostname that resolves (or rebinds) to a blocked address is
  still refused, flag or no flag; only which addresses are considered *in
  range to try in the first place* changes.

## Federating two REAL boxes, end to end

Everything below was executed between two genuinely separate appliances — box A
("Alice", the responder) on a remote Tailscale node reached over real
Tailscale-issued TLS, box B ("Bob", the asker) on a laptop. The first run was on
2026-09-06 on `main` at `06b5dac91` and reached the inbound gate; **the run on
2026-09-07, on this branch, drove all four consent outcomes end to end.**

It is recorded here because the [federation harness](../backend/apps/api/scripts/federation-harness/README.md)
runs both boxes on one machine over loopback and therefore **cannot** exercise
`PeerAskClient`, `checkEgressUrl`, DNS resolution or TLS at all; its driver
calls `POST /agent/v1/ask` itself. These are the runs where the real outbound
client made the real call.

### What an operator must configure

On the **sender**:

| | |
|---|---|
| `CI_PEER_ALLOW_CGNAT_ENDPOINTS=true` | only if the peer is on a tailnet — see [above](#peering-over-a-private-network-tailscale--cgnat) |
| a peer link naming the peer's `/agent/v1` base | `createPeerLink`, or the **People I'm linked to** tab |

On the **receiver**:

| | |
|---|---|
| `CI_PEER_AUDIENCE` | REQUIRED — without it every inbound ask is `503`, indistinguishable from no peer surface |
| `CI_PEER_MEMORY_ENDPOINT` | the box's own `/agent/v1`; also the `@target-uri` authority if signatures are on |
| `PORTAL_OIDC_ENABLED` / `PORTAL_OIDC_ISSUER` / `PORTAL_OIDC_JWKS_URI` | the trust anchor the peer's token is verified against |
| the `ask` feature flag | ships `true` |
| **`peer_links.peer_issuer` + `peer_subject`** | `createPeerLink` / `updatePeerLink`, or `ci-import peers add --peer-issuer … --peer-subject …` — see [below](#binding-a-link-to-the-peers-identity) |

Both boxes must agree on the issuer, and the receiver must be reachable at
`https` on port 443 or `''` (`checkEgressUrl` allows no other port).

### Confirmed working over the real network

Sender-side egress into CGNAT, and the whole inbound gate chain, are now proven
against a real box rather than a loopback stand-in. The two runs below differ
**only** in the flag, on identical code:

```
CI_PEER_ALLOW_CGNAT_ENDPOINTS=false → sendPeerAsk … reason: "Peer endpoint not permitted"
CI_PEER_ALLOW_CGNAT_ENDPOINTS=true  → sendPeerAsk … reason: "Peer error 403"
```

A `403` means the request **left the box**: real `PeerAskClient`, real
`checkEgressUrl`, real DNS to a `100.64.0.0/10` address, real TLS, and on the
receiver a real `jwtVerify` against a real remote JWKS with issuer, audience and
expiry all checked. The `403` is `PeerAskService.resolveLink` refusing an
identity it has no link for — the one step below.

### The exact values the two live boxes ran with

Reproduced verbatim from the 2026-09-07 run, so the table above has something
concrete under it. Nothing here is a default worth copying; the *shape* is.

**Bob — the asker.** No inbound surface, so no `PORTAL_OIDC_*` and no
`CI_PEER_AUDIENCE` of its own is load-bearing:

```bash
DATABASE_HOST=localhost   DATABASE_PORT=45432
PORT=47030                CI_ROLE=web
ENABLE_ASK=true
CI_PEER_HANDLE=bob
CI_PEER_MEMORY_ENDPOINT=http://127.0.0.1:47030/agent/v1
CI_PEER_TIMEOUT_MS=30000            # a tailnet round trip is not a loopback one
CI_PEER_DIRECTORY_URL=              # no directory; the link is written by hand
CI_PEER_ALLOW_CGNAT_ENDPOINTS=true  # Alice is on 100.64.0.0/10
```

`CI_PEER_ALLOW_CGNAT_ENDPOINTS` announces itself at boot, and an operator who
does not see this line has not set it:

```
[configuration] CI_PEER_ALLOW_CGNAT_ENDPOINTS is set — peer egress may now dial
addresses in 100.64.0.0/10 (CGNAT space, including Tailscale). …
```

**Alice — the responder.** The three `PORTAL_OIDC_*` values are the trust anchor
and `CI_PEER_AUDIENCE` is the one that turns a `503` into a real evaluation:

```bash
DATABASE_HOST=localhost   DATABASE_PORT=35267   # NOT 5432 — see the note below
PORT=3030                 CI_ROLE=web
PORTAL_OIDC_ENABLED=true
PORTAL_OIDC_ISSUER=http://127.0.0.1:14000
PORTAL_OIDC_JWKS_URI=http://127.0.0.1:14000/.well-known/jwks.json
PORTAL_OIDC_AUDIENCE=ci-server
CI_PEER_HANDLE=alice
CI_PEER_AUDIENCE=ci-server-box-a    # the ONLY `aud` an inbound token may carry
CI_PEER_MEMORY_ENDPOINT=https://beta-1.example.ts.net/agent/v1
```

The issuer on `127.0.0.1:14000` is the repo's own harness issuer, started on the
responder before the API:

```bash
yarn workspace @ci/be-api run exec -- \
  scripts/federation-harness/index.ts serve-idp 14000
```

It must be up **before** the API boots: `jose` re-fetches the JWKS on a cache
miss, so a box that starts against a dead issuer verifies nothing and says so
only at the first ask. It binds loopback only, on purpose — a JWKS is public, but
the fixture key that signs against it is not.

> **Resolve the database port explicitly.** A sibling worktree's compose project
> can hold host `5432` with a schema that has no `ci.peer_links` at all, and an
> unset `DATABASE_PORT` then attaches to the wrong box while looking healthy —
> which cost two earlier runs. Read it off the project you mean:
> `docker ps --filter label=com.docker.compose.project=<project>`.

### The four consent outcomes, driven live

Every row below was driven from Bob's real `sendPeerAsk` mutation over the real
network, and verified in the databases on **both** boxes rather than from the
response payload alone.

| | Bob asked | Alice's `ci.ask_audit` | what crossed |
|---|---|---|---|
| **auto** | `content` / `events` | `auto_answered`, `consent_basis` = the standing grant's id, `disclosed_count` 50 | `"50 matching items."` on the *synchronous* reply; Alice's `askInbox` never held the ask |
| **review** | the identical `content` / `events` ask, standing grant revoked | `answered`, `consent_basis` **null** (a human decided, not a grant), `disclosed_count` 50 | nothing synchronously (`delivered`); the answer after `approveAsk` + `runAsk`, collected on the poll route |
| **decline** | `content` / `messages` | `declined`, `disclosed_count` 0 | nothing — see below |
| **ceiling** | `availability` / `calendar` under a grant with `maxDisclosure: count` | `auto_answered`, `backing_entities` = **3 event ids**, `disclosed_count` 3 | `"…have 3 free slots in that window."`, `items: []` |

**auto and review are the same ask.** The second row was produced by revoking
the standing grant and re-sending byte-identical input; it stopped auto-answering
and appeared in Alice's `askInbox` instead. That is the grant deciding the
outcome, not the question.

**A decline is not distinguishable from a pending ask.** Three polls, one after
a real `declineAsk`, one on an ask Alice had simply not looked at, and one naming
a correlation id that never existed:

```
GET /agent/v1/ask/01a07a64-…   (declined)      → {"status":"pending","reason":"No answer is available"}  200
GET /agent/v1/ask/smoke-…      (under review)  → {"status":"pending","reason":"No answer is available"}  200
GET /agent/v1/ask/never-sent-… (never existed) → {"status":"pending","reason":"No answer is available"}  200
```

Byte-identical, including the status code. `askerVisibleStatus` collapses
everything except `answered` to `delivered`/`pending`, so "no" and "not yet" and
"who?" are one outcome on the wire. This is a privacy property, not a rough
edge: an asker who could tell them apart could probe for what a peer holds by
watching which questions get refused.

**The ceiling caps what crosses, and the audit records what was read.** Under
`maxDisclosure: count`, Alice's audit row carried the three concrete event ids
that backed the answer:

```json
["01a010f5-782f-74ba-ae29-aa618f37f779",
 "01a010f6-ea53-747f-9a77-98511f4002c8",
 "01a010f6-ead1-746e-82c5-cecdeca2f373"]
```

while Bob's stored answer carried `disclosed_entities: []` and a bare count. The
control run matters more than the numbers: revoking the capped grant, adding an
uncapped one, and re-sending the *same* ask changed the answer to

```
"…have 3 free slots in that window (longest 20460 min)."
```

Same three backing entities read either way — the grant's ceiling sits below the
`trusted` tier's, and the two are combined by taking the lesser, so removing it
let the tier's rung through and one more fact about Alice's calendar crossed.

### Binding a link to the peer's identity
<a id="binding-a-link-to-the-peers-identity"></a>

`PeerAskService.resolveLink` routes an inbound ask with
`PeerLinkService.findActiveByPeerIdentity(issuer, subject)`, reading
`peer_links.peer_issuer` / `peer_subject`. **This no longer needs SQL.**

```graphql
mutation { createPeerLink(input: {
  peerHandle: "alice@portal.example"
  memoryEndpoint: "https://alice.example/agent/v1"
  peerIssuer: "https://portal.example"      # iss of the token Alice will present
  peerSubject: "alice-box-a"                # its sub claim
  trustTier: peer
}) { success peerLink { id peerHandle trustTier } } }
```

```bash
ci-import peers add alice@portal.example https://alice.example/agent/v1 \
  --peer-issuer https://portal.example --peer-subject alice-box-a
# or, on a link that already exists:
ci-import peers update <id> --peer-issuer https://portal.example --peer-subject alice-box-a
```

Four things about this surface are deliberate:

- **Write-only.** `PeerLinkType` still does not project the pair, and
  `PeerLinkResolver.test.ts` pins that it never reaches JSON — from the read
  query *or* from the mutations that set it. An operator binding a link already
  holds the identity; reading it back would only let anything with a session
  enumerate every identity this box answers to.
- **Absent means unchanged.** Omitting either field on `updatePeerLink` leaves
  the stored value alone, exactly like `displayName` and `trustTier` — a rename
  must never silently unbind a federated peer. Correct a wrong binding by
  re-binding it, or revoke the link.
- **Both or neither, never blank.** `findActiveByPeerIdentity` filters on both
  columns, so half a pair can never match: it is inert while looking bound.
  `PeerLinkService.upsert` refuses it as a `400` in front of the write, and the
  CLI refuses it before the round trip.
- **One live link per (owner, identity).** `peer_links_owner_identity_live_uniq`
  — a second live link of the same owner naming the same `(iss, sub)` is a
  `409`. Scoped to the owner and partial on `revoked_at IS NULL`; see the
  migration for why global uniqueness would be *worse* rather than stricter, and
  `PeerLinkIdentityBinding.integration.spec.ts` for the proof.

Two members of the same box may still each link the same peer. That collision is
reachable on purpose: `findActiveByPeerIdentity` is box-wide, and `resolveLink`
refuses two matches as an *"Ambiguous peer link"* rather than answering as an
arbitrary member.

**Verified against a live box on 2026-09-07.** The binding above was written to
the responder with `updatePeerLink`, over HTTPS, using nothing but the API:

```json
{"data":{"updatePeerLink":{"success":true,
  "peerLink":{"peerHandle":"bob","trustTier":"trusted","status":"active"}}}}
```

and read back out of the responder's own database:

```
 peer_handle |      peer_issuer       | peer_subject | trust_tier | status
-------------+------------------------+--------------+------------+--------
 bob         | http://127.0.0.1:14000 | bob-box-b    | trusted    | active
```

The inbound ask that had been answering `403 No peer link` before this write
resolved a link on the next attempt. Note the payload: the mutation confirms the
write without echoing the pair, which is the write-only property above.

What a directory lookup would add is filling these in for you — `peers.directoryUrl`
exists precisely so a handle can resolve to an endpoint *and* an identity, and
`PeerDirectoryService` still does not populate a link. That is convenience now,
not a blocker.

### What a real operator still cannot do

Two gaps survived the 2026-09-07 run. Neither is a policy hole — both are
missing plumbing, and both were worked around by hand rather than fixed.

**1. There is no way to obtain a peer access token.**
`SendPeerAskInput.peerAccessToken` is non-nullable and documented as *"Supplied
by the caller until Portal token exchange lands; this box never mints or stores
it"* (`domains/graphql/types/AskInputs.ts`). CI-Portal has a peer **directory**
(`apps/hono-app/src/domains/peers/` — register / resolve / search) but **no
token-exchange endpoint and no peer audience minting**, so there is nothing for
an operator to call. Every ask above carried a token minted from the repo's own
fixture key.

For a test run the repo's loopback issuer
(`scripts/federation-harness/idp.ts`) is the documented stand-in; it is a real
RS256 issuer publishing a real JWKS, and pointing `PORTAL_OIDC_ISSUER` at it
changes *who* the box trusts without weakening any check — signature, issuer,
audience and expiry are all still verified on their merits. It must never be a
real box's issuer: **the signing key is checked in.**

**2. The asker's box cannot collect an answer it did not get synchronously.**
This is the sharper of the two, because it makes the `review` outcome a
dead end for the asker's *records*.

`OutboundAskService.pollForAnswer` is the asker's half of the return path — it
polls the peer, absorbs the answer and moves the local ask to `answered`. It is
written, documented and unit-tested, and **nothing calls it**: no GraphQL
mutation (`AskResolver` wires only `outboundAskService.send`), no REST route, no
`ci-import asks` subcommand. A repo-wide search finds two hits, its own
definition and its own docstring.

The consequence is visible in the run above. The reviewed ask was approved on
Alice and the answer *was* served over the real network —

```
GET /agent/v1/ask/<correlationId>   → 200
{"status":"answered","answer":{"form":"existence","summary":"50 matching items.",
 "items":[],"disclosedCount":50,"withheldCount":0}}
```

— but that request was issued by hand with `curl`. On Bob the row stayed
`delivered` with zero `ci.ask_answers` rows, because no product surface exists
to make Bob's own server perform that poll. Re-sending does not help:
`OutboundAskService.toBody` mints a **fresh correlation id per send**, so a
second `sendPeerAsk` is a new ask on the peer, not a collection of the old one.

Until `pollForAnswer` is exposed, `auto` is the only outcome an asker's appliance
records end to end on its own.

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
  SQL-only either. **Also fixed:** both mutations now set `peer_issuer` / `peer_subject`,
  which is what an inbound ask is actually matched on — see
  [Binding a link to the peer's identity](#binding-a-link-to-the-peers-identity). The web
  UI does not yet collect the pair, so that journey is API/CLI-only for now.
  What is NOT fixed: `updatePeerLink` goes through
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

**Both directions work, including the return trip — given a link and a token.** A box can receive, gate, and answer a federated ask; can compose and send one; and the responder serves an approved answer on the collect route. Peer-link management and the ask UI's route both landed (see the Δ note under Known limitations). The *asker's* half of that return trip exists as a service method with no caller — see the Δ below.

**Δ 2026-09-06 — measured between two real boxes, not the loopback harness.** Outbound egress into a tailnet works through the real `PeerAskClient`, and every inbound gate up to and including token verification passes over real TLS against a real remote JWKS. Two things stopped a complete round trip, both detailed under [Federating two REAL boxes](#federating-two-real-boxes-end-to-end). **The first is now fixed:** `peer_links.peer_issuer` / `peer_subject` are writable through `createPeerLink` / `updatePeerLink` and `ci-import peers add|update`, so a link created the supported way can match an inbound ask — see [Binding a link to the peer's identity](#binding-a-link-to-the-peers-identity). The second remains: the peer access token is still passed in by hand, because CI-Portal ships a peer directory but no token exchange. Also fixed on the way through: the inbound rate limiter built its `ConsumptionStore` key with NUL separators, which Postgres rejects — a `500` on **every** inbound ask and collect for any box on the default store, ahead of any policy.

**Δ 2026-09-07 — the full ask lifecycle now runs between the two real boxes, and all four consent outcomes were driven live.** `auto`, `review`, `decline` and a disclosure `ceiling` were each exercised from Bob's real `sendPeerAsk` over real TLS into a tailnet, and verified in the databases on **both** boxes — the tables and raw payloads are under [The four consent outcomes, driven live](#the-four-consent-outcomes-driven-live). The identity binding this needed was written through the real GraphQL API (`updatePeerLink` with `peerIssuer` / `peerSubject`), not by hand-written SQL. Two gaps remain and are now stated precisely, with what each one costs, under [What a real operator still cannot do](#what-a-real-operator-still-cannot-do): CI-Portal still has **no token minting endpoint**, so the peer access token was minted from the repo's checked-in fixture key; and `OutboundAskService.pollForAnswer` still has **no caller anywhere**, so the reviewed answer had to be collected by hand with `curl` and Bob's own row stayed `delivered`.

Still open: a `pollPeerAsk` mutation so a person can press the collect button, a UI entry point for `createAskGrant`, an MCP tool so assistants can drive asks directly, and Portal token exchange so the access token is minted rather than passed in — the last of which is what stops the composer sending an ask across boxes at all.

## See also

- **The reference document:** [`asks-system-guide.md`](asks-system-guide.md) — the consent
  model in full, the ask lifecycle with the tables written at each step, the deliberate
  privacy properties and their reasoning, how to run everything, and the current gap list.

- Design: [`CI-Engineering/projects/decentralized-trust-graphs/`](https://github.com/companionintelligence/CI-Engineering/tree/main/projects/decentralized-trust-graphs) (PRD · ARCHITECTURE · ROADMAP · USE-CASES · UX)
- The intra-box ask this inverts: [`saved-search-sharing.md`](saved-search-sharing.md)
