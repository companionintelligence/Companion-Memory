# The two-box federation harness

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

Two full CI-Server boxes on one Mac, a local OIDC issuer standing in for
CI-Portal, and five real federated asks between them — narrated in plain
language so a human can watch consent actually work, and asserted so a
regression fails the run instead of scrolling past.

```bash
make fed-demo      # both boxes up, seeded, every scenario driven
make fed-status    # ports, endpoints, logs
make fed-down      # stop (add PURGE=1 to drop the databases too)
```

`make fed-demo` is idempotent. Run it twice; run it after a crash; run it after
a scenario has deliberately revoked half the grants. It re-seeds every time,
because that is the only honest way to make an append-only consent table
re-runnable (see [Idempotency](#idempotency-is-not-upsert)).

---

## What you are looking at

Two people. **Ada** on box A asks; **Devon** on box B answers. Devon has written
down, in advance, what Ada may ask about — that is the whole product.

| | The question Ada asks | What Devon's Companion does | What crosses |
|---|---|---|---|
| **a** | "anything about the design standup?" | a standing `auto` grant answers | a count. No item references, no titles. Devon is never interrupted |
| **b** | "do you have the quarterly review deck?" | nothing matches → **review is the floor** | "no answer is available". Devon approves it by hand, and **Ada collects it** with `GET /agent/v1/ask/:askId` |
| **c** | "have you got messages from Priya?" | a `block` grant refuses | the reply from (b), byte for byte — the refusal is not distinguishable from a wait |
| **d** | "free for lunch on the 15th?" | an `auto` grant **capped at `count`** | *how many* free slots. Never *when*. The box read three real meetings to say it |
| **e** | (a) again, after Devon taps Revoke | the pre-authorization is gone | it lands in front of Devon instead. **The answer does not get wider** |

Scenario (e) is the one to watch. A red team once proved that revoking a grant
made disclosure *grow*, because every SQL read filters `revoked_at IS NULL`, so
a revoked grant reads as "imposes no ceiling" rather than as "consent
withdrawn". The fix — capture the ceiling on `ci.asks.disclosure_ceiling` at
consent time and combine it with `narrowestRung` — must stay fixed. This
harness re-proves it across a real box boundary on every run.

A green run is **53 assertions passed, 0 failed**, and exits 0.

---

## Prerequisites

| | |
|---|---|
| Node | exactly `22.15.1` (`.nvmrc`) |
| Docker | colima, running (`colima start`) — not Docker Desktop |
| Postgres/MinIO images | `ci/database`, `ci/object-store`, `ci/setup-database`. `make build ENV=local` if absent |
| Yarn | the version in `package.json` → `packageManager` |

**Not** needed, and deliberately so: Caddy, Overmind, tmux, Ollama, a second
worktree, a CI-Portal deployment, or any network access. The ask pipeline runs
`SearchService` in `mode: 'keyword'` — no embedding call anywhere — so the whole
demo is Postgres, MinIO and four node processes (each box runs `web` + `worker`,
exactly as the Procfile does).

`.env` is created from `.env.default` on first `fed-up` if it does not exist,
exactly as `make init` does.

---

## What actually runs

```
  ┌──────────────────────────────┐
  │ local OIDC issuer :14000     │   idp.ts + INSECURE_TEST_KEY.ts
  │ /.well-known/jwks.json       │   RS256, fixture keypair
  └───────┬──────────────┬───────┘
          │ JWKS         │ JWKS
   ┌──────▼──────┐  ┌────▼────────┐
   │ box A :13030│  │ box B :13031│   web + worker each, one repo checkout
   │ pg :15432   │  │ pg :15433   │   two compose projects, two volume sets
   │ minio :19000│  │ minio :19001│
   └─────────────┘  └─────────────┘
        aud: …box-a      aud: …box-b
```

Both boxes trust the **same issuer** — that is the realistic shape, one Portal
serving many Companions. What separates them is the **audience**:
`PeerAskController` hands its own `peers.audience` to `verifyClaims` as the only
acceptable one, so a token minted for box A is rejected by box B even though the
signature and issuer are identical.

Each box gets its own compose project (`ci-server-fedharness-a` / `-b`), so its
own `db-data` and `object-data` volumes — the same isolation `scripts/dev-stack`
gives a worktree. Nothing is shared between the boxes except the checkout the
code is read from.

### Why not `make dev` twice

`scripts/dev-stack` genuinely does run isolated stacks, and two worktrees each
running `make dev` really would be two boxes. Three things ruled it out, none of
them "it does not work":

1. **It re-rolls ephemeral ports on every run** and offers no way to pin them —
   `composeEnv` spreads `process.env` and then overwrites all seven port
   variables. A peer link stores an endpoint; that endpoint cannot move between
   bring-ups.
2. **It is a foreground tmux supervisor** that also requires Caddy on `:443`
   with its admin API, Ollama on `:11434`, and will `ollama pull` several GB on
   a cold machine. A federated ask is an API-to-API event.
3. **It needs a second worktree** — a second checkout of this branch, kept in
   step by hand.

So the harness reuses dev-stack's primitives at the level that matters (the same
two compose files, `COMPOSE_PROJECT_NAME`-scoped volumes, the same
`DB_HOST_PORT`/`OBJECT_STORE_HOST_PORT` variables, the same
`yarn workspace @ci/be-api migrate`) and boots the API the way
`playwright.e2e.config.ts` already does: a plain node process with `PORT` and
`DATABASE_PORT` in its environment.

### The outbound half, and why the driver plays it

The driver POSTs to box B's `/agent/v1/ask` itself instead of going through box
A's `sendPeerAsk` → `OutboundAskService` → `PeerAskClient`. That is forced by a
guard, and the guard is right.

`PeerAskClient` runs every peer endpoint through `checkEgressUrl`
(`domains/peers/urlPolicy.ts`), which demands **https**, a port in `{'', '443'}`,
and a host that is not `localhost`, not `*.localhost`, not `*.local`, and not a
literal loopback or RFC1918 address. `http://127.0.0.1:13031` fails four of
those five. There is no bypass env var, and there should not be: `memory_endpoint`
comes from a directory descriptor, so it is attacker-influenced, and this is a
textbook SSRF sink.

**Nothing was weakened to make the demo run.** What the driver replaces is who
calls `fetch`. Everything that decides disclosure is real: a real RS256 token,
fetched and verified against a real remote JWKS with real issuer/audience/expiry
checks, the real controller gates, real `(issuer, subject)` → peer-link
attribution, the real grant evaluator, the real ceilings, the real audit writes.
`PeerAskClient` contributes a timeout and one audit row and no policy at all.

Closing it would mean giving each box a public-shaped hostname that resolves to
loopback (the DNS-rebinding gap `urlPolicy.ts` documents as a known limitation),
a Caddy route on `:443` per box, an internal-CA certificate, and
`NODE_EXTRA_CA_CERTS` on both processes. That is a real option and it is written
down here rather than done, because it buys coverage of a fetch wrapper at the
cost of `/etc/hosts` edits and a TLS setup that will rot.

---

## Idempotency is not upsert

`ci.ask_grants` is **append-only by design**: `revoke` stamps `revoked_at`,
`supersede` closes a row and writes a replacement, nothing is ever rewritten in
place, because consent history is evidence you may be asked to produce.

Scenarios (d) and (e) deliberately revoke grants. So "re-seed" cannot mean
"upsert by fixed id" — that would either resurrect a revoked grant (destroying
the evidence) or refuse to re-seed at all. The unit of idempotency is instead
**"an *active* grant with this posture exists"**: a re-seed after a revocation
writes a new row and leaves the revoked one exactly where the owner left it.
`ensureActiveGrant` spells the liveness predicate the same way `isGrantActive`
does, because a second, subtly different copy of it is how a revoked grant keeps
answering.

Peer links are different — they carry no history contract — so those are a plain
`ON CONFLICT (owner_user_id, peer_handle) DO UPDATE`, re-activated on every seed.

---

## Real data

```bash
yarn fed import-real-data --list                       # what is available
yarn fed import-real-data                              # box B only, no archive touched
yarn fed import-real-data --source goodreads --limit 200
```

**Box B** gets a second person from `CI-Test-Data-Person-1-John-Smith` — 101
calendar rows, ingested through `POST /v1/events`, the same route a capture
client uses. (`CI-Demo-Companions-John-Smith` was the other candidate and is not
usable: it is ten markdown *companion personas*, not a dataset.)

**Box A** gets a bounded subset of the owner's real archive. Verified end to
end: `--source apple --limit 1` stages the 1.8MB `calendar/liam.broza@gmail.com
.ics` into `.federation-harness/staging/`, `ci-import` uploads *that copy*, and
the run walks unpack → parse → media → push to `completed` with **1,143 real
calendar events** in box A's memory. The archive is byte-for-byte unchanged
afterwards.

This is the part to read carefully.

### The archive is read-only. Always.

`/Users/liam/devel/liam-test-data-export` is 308GB of irreplaceable personal
history. CI-Server's own `scripts/import-local-sources.sh` opens with the reason
this matters:

> THE INBOX CONSUMES WHAT IT IMPORTS, by rename.

A sibling repo's importer did exactly that to 2.8GB of this archive by
reclaiming its source directory. Six independent things stop it here:

1. **The archive is never named as an import target**, only as a copy source.
   `stageSource` does `readdir` / `stat` / `copyFile` and nothing else.
2. **Every file is copied first**, into `.federation-harness/staging/`, and the
   importer only ever sees the copy — and is handed the staged FILES one by one,
   never a directory.
3. **`ci-import inbox` is never used.** That is the command that consumes by
   rename. `ci-import import` does not, and it is the only one here — worth
   saying out loud because when you hand `import` a directory it refuses and
   *suggests the inbox in its error message*.
4. **Box A boots with `CI_IMPORT_ROOTS` pinned to the staging directory.** The
   appliance is not asked politely to stay out of the archive — it cannot
   resolve a path into it, because `importRoots.ts` refuses.
5. **`CI_IMPORT_INBOX_DIR` is pinned too**, at a harness-owned directory, even
   though nothing here uses the inbox. If the destructive path is ever taken by
   accident, it can only eat something disposable.
6. **`assertOutsideArchive` re-checks the resolved destination** through
   `realpath` on every run, because a symlink is how "outside" quietly stops
   being true.

The copy is recursive (the archive's sources are directories of directories) and
**doubly bounded**: a file count (`--limit`, default 200) and a byte ceiling
(`FED_MAX_STAGED_BYTES`, 512MB), either of which stops it. Symlinks are skipped
rather than followed.

---

## The fixture signing key

`INSECURE_TEST_KEY.ts` holds a checked-in RSA private key. It is public: anyone
who can read the repo can mint a token for any subject and any audience against
this issuer. It exists so a run is reproducible — a token minted on Tuesday
still verifies against Wednesday's JWKS — and it protects nothing. The file has a
loud header, `loadFixtureKey()` refuses to hand it out under
`NODE_ENV=production`, and the issuer binds loopback only.

Never put this issuer in a real box's `PORTAL_OIDC_ISSUER`.

---

## Findings this harness produced

These are things the run demonstrates end to end, not opinions. Four of the
seven have since been fixed *because* the run demonstrated them; those are
marked ✅ and the assertions that pinned the old behaviour have been replaced by
assertions that pin the new. The rest are still true and still pinned.

### 0. What this harness structurally cannot test — and what a real two-box run found

The driver POSTs to `/agent/v1/ask` itself (see
[The outbound half](#the-outbound-half-and-why-the-driver-plays-it)), so a green
run says **nothing** about `PeerAskClient`, `checkEgressUrl`, DNS, or TLS. Both
boxes also run on one machine, so the `consumption` store is the only piece of
per-box infrastructure that is genuinely shared.

A live run on 2026-09-06 between two real appliances — one remote Tailscale node
over real Tailscale TLS, one laptop, both on `main` at `06b5dac91` — closed that
gap and found two things this harness could not have:

**The inbound rate limiter 500'd every peer request on the default store.**
`PeerRateLimitService` built its `ConsumptionStore` key by joining
`(bucket, issuer, subject)` with NUL. That is free in the process-local `Map` the
budget used to live in, and impossible in the Postgres column it lives in now
(G8 / #2365): `invalid byte sequence for encoding "UTF8": 0x00`, raised inside
`PostgresConsumptionStore.takeWindow`. Because `consume` deliberately runs
**before** the peer-link lookup, that was a `500` on every inbound ask and every
collect for any box using `consumption.store: postgres` — the default in
`config/default.json`, with **no** entry in
`custom-environment-variables.json`, so it cannot even be switched to `memory`
from the environment. Every suite missed it because they all use
`InMemoryConsumptionStore`. Fixed, with a regression test that captures the key
and asserts no NUL.

**`peer_issuer` / `peer_subject` have no write path but this harness's SQL.**
See finding 5 below.

### 1. ✅ FIXED — the federated audit under-reported what crossed

`ci.ask_audit.disclosed_count` was added (migration `20260821013030`) precisely
because `disclosed_entities` is empty for every form but `retrieval`, so
deriving the count from it "audited a real count/boolean disclosure as nothing
was shared". The local path forwarded it —
`AskService.completeWithAnswer` passes `disclosure.answer.disclosedCount`. The
**federated** path did not: `PeerAskService.recordAudit` had no count parameter
at all, so the fallback fired.

Observed in scenario (a): the peer was told **"1 matching item"**, and Devon's
disclosure history recorded **0**. Same in (d): the peer was told **"4 free
slots"**, `ci.ask_answers.disclosed_count` said 4, and the audit row said 0.

`recordAudit` now takes `disclosedCount` as a REQUIRED parameter with no
default, which is the part that matters: a defaulted one is how it was lost the
first time — the method simply never mentioned the field and every call site
inherited the wrong answer in silence. (a) and (d) now assert that the answer
row and the audit row agree.

Fixing the audit exposed a SECOND under-report on the availability branch, which
the original finding had assumed away: `ci.ask_answers.disclosed_count` was
`clampAvailability(...).free.length`, and the clamp empties that array at every
rung below `redacted` — so the row said 0 for exactly the ceilings where a
number is the only thing that crosses. Both rows now carry 4. See
[Failure modes](#failure-modes-hit-while-building-this).

### 2. The review path loses peer attribution — `peer_handle = NULL`

When a standing grant auto-answers, `PeerAskService` writes the audit row itself
and stamps `peer_link_id` + `peer_handle` (scenario (a) records `ada`). When the
**owner personally approves** a federated ask, the answer goes through `runAsk`
→ `AskService.completeWithAnswer`, whose audit row is "built from the ask alone
and cannot carry peerLinkId / peerHandle" — `PeerAskService`'s own docstring
names this as the follow-up.

So the one disclosure a human looked at and approved is the one the owner's
history cannot attribute to anybody. Observed in scenario (b).

Still open, and it lives in `domains/asks`: teaching `complete` to carry peer
attribution is a change to the local path's audit shape, not to federation.

### 3. ✅ FIXED — an approved answer never crossed back

`POST /agent/v1/ask`'s synchronous reply was the only channel that existed.
There was no callback, no poll, no delivery route, and nothing read `askId` as
the idempotency key its docstring called it. A re-ask minted a **new** `ci.asks`
row and was re-evaluated from scratch — so it landed in review again, and
Devon's approved answer sat on Devon's box forever. Federated review was a
one-way trip. Observed in scenario (b).

Two pieces closed it:

**`ci.peer_ask_correlations`** (migration `20260821120000`) binds the asker's
`askId` to the local ask it produced, scoped by peer link — two peers may
independently mint the same uuid, and one must never collect the other's answer.
A repeat now REPLAYS the recorded outcome instead of creating a second ask, and
never re-evaluates or re-executes anything. A `request_digest` binds one key to
one question, so a key reused for a different ask is refused as malformed rather
than answered with the first question's answer.

**`GET /agent/v1/ask/:askId`** collects it. A poll rather than a callback,
because a callback inverts who has to be reachable: today exactly one direction
of egress is required (asker → responder) and `checkEgressUrl` is built around
that, whereas a callback would make the RESPONDER dial an address the ASKER
supplied — a second and more directly attacker-controlled SSRF sink, on the box
that holds the data — and would make a home appliance an inbound server for its
peers. The poll is a READ: no grant evaluation, no executor, no ask row, no
audit row. Its own rate-limit bucket (30/60s) keeps collecting an answer from
spending the ask budget that protects a human's review inbox.

It is not a new oracle. An ask in review, an ask a block refused, an ask that
expired, an id this box has never seen, and an id belonging to a *different*
peer are all the same reply — in particular an unknown id is **not** a 404,
which would answer "has this peer ever asked me that?" for free.

**What is left.** The responder half and the asker's client half are both here:
`OutboundAskService.pollForAnswer` drives `PeerAskClient.poll`, persists the
answer with `answerSource: 'peer'`, terminalizes the local ask and writes its
audit row. What is NOT here is the one GraphQL mutation that would let a person
press the button — `pollPeerAsk` belongs in `AskResolver`, which was out of
scope for this change. Scenario (b) drives the HTTP route directly, exactly as
the rest of the harness drives the ask route.

### 4. ✅ FIXED — the wire distinguished `declined` from `pending_review`

#2210 and #2216 closed this oracle for a **local** asker: `CreateAskPayload
.decision` is the constant `ASK_ACCEPTED`, `askerVisibleStatus` folds every
non-answered status to `delivered`, and `askerVisibleUpdatedAt` pins the clock
so responder activity is not readable through timestamps.

Across a box boundary it was still there. `PeerAskService` returned
`status: 'declined'` for a block and `status: 'pending_review'` for review, and
`SendPeerAskPayload` surfaced it verbatim — while `SendPeerAskPayload`'s own
docstring cited the federated path as the precedent for the local collapse.
Everything *below* the status word was identical, which scenario (c) asserts
field by field. But the word itself was a one-bit oracle, and the grant matrix
is mappable at 10 probes a minute.

The wire now carries `answered` or `pending`, and one constant reason. The
collapse is made at the RESPONDER rather than on receipt, because hiding it on
the asker's box would bind only a well-behaved asker while the word stayed on
the wire. `PeerAskClient` additionally folds the reply into the LOCAL vocabulary
(`answered` / `delivered` — the two words `askerVisibleStatus` already uses) and
drops the peer's `reason` string entirely; a reason this box observed itself
survives, because that is a fact about our own request. Scenario (c) now asserts
the two replies are identical byte for byte.

What the asker loses is a real answer to "should I wait?", which was the honest
argument for keeping `pending_review`. It is answered instead by the ask being
pollable — see finding 3.

### 5. ✅ PARTLY FIXED — peer grants and peer links have APIs now; the peer IDENTITY still does not

> **Δ 2026-09-06.** The first half of this finding is stale: `createAskGrant`
> now takes `granteePeerLinkId` (resolved through an owner-scoped read before it
> is stored — `AskResolver.ts:738-752`), and `PeerLinkResolver` ships the full
> `createPeerLink` / `updatePeerLink` / `revokePeerLink` set. What replaced it is
> narrower and worse: **neither peer-link mutation can set `peer_issuer` /
> `peer_subject`**, and those are the columns
> `PeerLinkService.findActiveByPeerIdentity` matches an inbound ask on. Outside
> tests, the only writers of `peerIssuer` in the repo are `seed.ts:181` and
> `index.ts:224,242` — i.e. **this harness**. So a link made the supported way is
> inert for inbound asks, and the SQL below is still the only way to bind one.
> See [`docs/peer-federation.md`](../../../../../docs/peer-federation.md)
> § *Federating two REAL boxes*.

The original finding, for the record: `createAskGrant` took only `granteeId` (a **user** global id) and hard-coded
`granteeUserId`, even though `GrantService.create`, the DTO and the DB CHECK all
support `granteePeerLinkId`. So a grant addressed to a peer is unreachable from
GraphQL — the harness writes them as SQL, and so must anyone else.
`PeerLinkService.upsert` has no caller outside its own tests, which
`docs/peer-federation.md` already records under Known limitations.

Revocation, by contrast, works fine on a peer grant: `revokeAskGrant` is by id
and owner-scoped, which is what scenarios (d) and (e) use.

### 6. A disclosure ceiling can be lowered through the API but never raised

`updateAskGrant` *merges* scope, and an omitted `maxDisclosure` inherits the
existing one, so no input removes a ceiling. That is the safe direction to be
missing — and it is why scenario (d)'s control has to revoke the capped grant
and write a fresh one to show the un-capped answer.

### 7. ✅ FIXED — `peer_links.trust_tier` had four values, `TrustTier` five

The CHECK admits `('family','trusted','peer','stranger')`. `household` is in the
TypeScript union but is the *local* tier — a peer can never be one. Writing it
landed a `23514`, not a validation error.

The **type** is what narrowed, not the CHECK, and deliberately: `household`
means "a member of the owner's own box" and carries the widest ceiling in
`TIER_CEILINGS` (`{'*': 'full'}`, the only tier exempt from the sensitive-class
floor), so widening the CHECK to five would have made that writable for a
REMOTE box. `PeerTrustTier` is now `Exclude<TrustTier, 'household'>` by
construction rather than a second hand-maintained list that happened to agree,
with a compile-time assertion in both directions so a sixth tier cannot drift
silently. `PeerLinkService.upsert` carries the runtime half — a `400` naming the
bad value instead of a `23514` surfaced as a bare 500.

## Failure modes hit while building this

Each of these cost real time and each is now handled.

**A global guard 404s any route param whose NAME ends in `id`.**
`IdFormatGuard` (`common/guards/`) throws `NotFoundException` for any route
parameter matching `/id$/i` whose value is not a uuid. Every local route it was
written for passes a local row id, so that is sound there — and wrong for
`GET /agent/v1/ask/:askId`, whose path segment is a correlation id minted by the
PEER and bounded by `PEER_ASK_ID_PATTERN`, not by uuid syntax. Every collect
returned `404 Not Found` while the repeat-POST replay worked perfectly beside
it, so the run read as "the answer is not there" rather than "the route is not
reachable" — the assertion that caught it says *the answer never crossed back*,
which was the exact defect being fixed. Only the stack trace in `box-b.log`
names the guard. The parameter is now called `:correlation`; relaxing a global
guard so one route may accept non-uuids would weaken it everywhere.

**The count an availability answer discloses is not `free.length`.**
`clampAvailability` empties BOTH interval arrays at every rung below `redacted`,
so reading the disclosed count off its RESULT records 0 for exactly the rungs
where a number is the only thing that crossed. Scenario (d) told the peer
"4 free slots" under a `count` ceiling while both `ci.ask_answers` and
`ci.ask_audit` recorded 0 — the same under-reporting as finding 1, arrived at by
a completely different route, and invisible until an assertion compared the two
rows to each other. The clamp now reports the magnitude it disclosed (the slot
count down to `count`, nothing at `boolean`, nothing at `none`), which is the
only place that knows.

**`CI_IMPORT_ROOTS` is JSON, not a path.** `custom-environment-variables.json`
declares it `"__format": "json"`, so node-config runs the value through JSON5
before the app sees it. A bare `/some/path` kills the boot with
`SyntaxError: __format parser error in CI_IMPORT_ROOTS: JSON5: invalid character
'p' at 1:2` — which names the character and not the variable, from inside
`json5/lib/parse.js`, with no stack frame in this repo. It is the only env var
in `apiEnv` that is not a plain string. `PORT` is `"__format": "json"` too, but a
port is a valid JSON number so it never bites.

**`up --wait` fails on a service that exits cleanly.** Compose treats a
completed service as a failure unless something in the model depends on it with
`service_completed_successfully` — which for `setup-database` is only
summary/hbpe, and the harness does not start those. Naming it in the same
`--wait` invocation fails the whole bring-up on its `exit(0)`. It gets its own
`up` and is polled instead.

**The keyword index arrives a minute after the events do.** `POST /v1/events`
returns as soon as the capture rows are written; materialization into
`ci.events` and the `index.vector_event` stage that writes `ci_search.vectors`
are pipeline slices driven by a periodic control tick. The first green run
reported **"0 matching items"** for every content ask — a perfectly plausible
answer, and completely wrong — because the seed waited 60s and the vectors
landed at 70. An availability answer over an empty calendar looks exactly like a
ceiling working, so both counts are now polled to a real threshold (240s) rather
than slept on, and the seed says out loud when the index is short.

**Nest answers `@Post` with 201, not 200.** Scenario (c) compares the refusal
against a pending reply field by field; the first version compared against a
*synthesized* pending reply and asserted 200, which failed on a difference that
did not exist. The comparison now uses the real reply captured in (b) — a
fixture cannot notice something the fixture author did not know.

**The inbound rate limit is 10 asks per 60 seconds**, per `(issuer, subject)`,
backed by `ConsumptionStore` since G8 / #2365, so it is shared across replicas and survives a restart (`PeerRateLimitService`) — it was in-memory per process when this line was written. A run spends 7. Two runs inside
one minute will 429, which the driver reports by name rather than letting it
surface as a mystery assertion failure. Restarting box B clears the window.

**`yarn workspace @ci/be-api dev` is the wrong entry point for a harness.** It
wraps the API in nodemon watching `src`, `config` *and* `../../../.env` — so the
harness creating `.env` on first run restarts the box it just started. The `exec`
script is the same ts-node invocation without the watcher.

**Signal the process group, not `yarn`.** The recorded PID is `yarn`, which
spawns node underneath; `SIGTERM` to `yarn` alone leaves node holding the port,
and the next `up` allocates an ephemeral one and quietly runs the whole demo
against a stale box.

**A web-only box queues an import forever, silently.** `ImportStageListener`
declares `role: 'worker'` on all four stage queues (unpack / parse / media /
push), so a box running only `CI_ROLE=web` accepts the upload, writes an
`ci_import.import_runs` row, and leaves it at **`queued`** with no error
anywhere — `ci-import --wait` simply never returns, which reads as a slow import
rather than an absent consumer. Each box now runs both roles, as the Procfile
does.

**The import domain's writable directories default to container paths.**
`uploadsDir` is `/var/lib/ci-import/uploads`, `scratchDir` is
`/var/tmp/ci-import`. A host-run API cannot create the first and the import dies
with `EACCES: permission denied, mkdir '/var/lib/ci-import'`, surfaced to the
CLI as a bare `500: Internal server error`. All three are pinned into
`.federation-harness/import/`.

**`ci-import import` takes archive FILES, not a directory** — and its refusal
suggests `ci-import inbox --start`, which is the command that consumes by
rename. The staged file paths are passed individually.

**A guard that runs before the thing it guards exists is worse than no guard.**
The first `assertOutsideArchive` called `realpath` on the staging directory
before creating it, so it threw ENOENT every time — it looked like it had run.
`mkdir` first, then resolve.

**Both boxes log a recurring `POST http://localhost:8002/functions/run HTTP
404`.** That is `hbpe-service`, which the harness deliberately does not start.
The job fails, retries, and affects nothing on the ask path. It is noise, not a
symptom.

**A `tailscale serve` on `:443` has previously broken Caddy route registration
on this machine.** It did not bite here — the harness registers no Caddy route
at all — but if you reach for the https variant described above, that is where
it will show up.

---

## A side benefit: a current-schema database for the DB-backed suites

The opt-in Postgres suites (`GrantService.integration.spec.ts`,
`PeerAskLifecycle.integration.spec.ts`, `AskDisclosureCeiling.integration.spec.ts`)
resolve their connection from `.env`, which hard-codes `DATABASE_PORT=5432` —
so on a machine with several worktree stacks they land on whichever one happens
to hold host 5432, usually on a schema no branch describes. They then fail with
things like `column AskGrantEntity.grantee_peer_link_id does not exist`, which
reads like a code bug.

A harness box is always migrated to *this* checkout's head, so it is a reliable
target:

```bash
PW=$(grep -E '^DATABASE_PASSWORD=' .env | cut -d= -f2-)
PEERS_TEST_DATABASE_URL="postgres://companion:${PW}@localhost:15432/companion" \
DATABASE_URL="postgres://companion:${PW}@localhost:15432/companion" \
  yarn workspace @ci/be-api test src/domains/peers src/domains/asks
# → 23 suites, 323 tests, all passing
```

Box A (`:15432`) is the better target: box B carries the fixture calendar.

---

## Files

| | |
|---|---|
| `index.ts` | CLI: `up` / `seed` / `run` / `demo` / `status` / `down` / `token` / `import-real-data` |
| `topology.ts` | the two boxes, ports, state file; **why not `make dev` twice** |
| `stack.ts` | compose, migrations, the API process, per-box environment |
| `idp.ts` | the loopback OIDC issuer; **why 90 lines is enough** |
| `INSECURE_TEST_KEY.ts` | the fixture keypair, and a loud warning |
| `seed.ts` | owners, peer links, grants, fixture calendar; **why idempotent ≠ upsert** |
| `scenarios.ts` | the five scenarios; **why the driver, not `sendPeerAsk`** |
| `realData.ts` | bounded, read-only loading from the owner's archive |

Runtime state — ports, PIDs, minted api keys, both boxes' logs, and the staging
copy — lives in `.federation-harness/` at the repo root and is gitignored.

## Related

- [`docs/peer-federation.md`](../../../../../docs/peer-federation.md) — the design
- [`domains/peers/`](../../src/domains/peers) — the inbound half
- [`domains/asks/`](../../src/domains/asks) — grants, ceilings, audit
- [`domains/peers/urlPolicy.ts`](../../src/domains/peers/urlPolicy.ts) — the egress guard
