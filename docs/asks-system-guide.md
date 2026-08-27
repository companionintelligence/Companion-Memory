# The Asks system — reference guide

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**
>
> **Read this before you change anything on the consent path.** It is the
> reference document for the interpersonal ask feature: what it is, what the
> consent model actually enforces, what the deliberately counter-intuitive
> behaviours are *for*, how to run it, and — at length, and without softening —
> what does not work yet.
>
> Verified against merged `origin/main` at **`8cd68dbe6`**. Every number in the
> "Verification" sections was measured on a real migrated Postgres (306+
> migrations applied), not inferred from the code.

**Sibling documents. Read them; this one does not repeat them.**

| Doc | What it holds that this one does not |
|---|---|
| [`asks-threat-model.md`](asks-threat-model.md) | The six named threats (coercion, stalking-via-availability, social engineering at the consent moment, prompt injection, cumulative disclosure, defaults), each with file:line evidence and mutation experiments. **Read before changing a ceiling.** |
| [`peer-federation.md`](peer-federation.md) | The cross-box design: Portal-as-phone-book, the three wire archetypes, the egress guard, the inbound pipeline. |
| [`saved-search-sharing.md`](saved-search-sharing.md) | The surface asks invert — the owner publishing a fixed query others run *as the owner*. |
| [`backend/apps/api/scripts/federation-harness/README.md`](../backend/apps/api/scripts/federation-harness/README.md) | The two-box harness: what each scenario proves, and a long list of failure modes hit while building it. |

---

## 1. What this is, and the product thesis

An **ask** is a question one person directs at another person's Companion
memory. Most questions between people are really queries against the other
person's archive — *"do you have photos of us from the lake trip?"*, *"do you
know anyone at Acme?"*, *"free for lunch Friday?"* — and today they run over the
worst available protocol: interrupt the human, wait, hope they remember, accept
an unsourced answer. Asks replace that with **human intent → a bounded,
structured ask → the other person's Companion → a consent gate → a truthful,
filtered answer**, keeping the human in the loop exactly where they add value
(deciding, redacting) and out of it where they do not (searching, remembering,
compiling). The whole thing rests on one inversion that has to be got right: an
appliance holding one person's entire life is being handed a query interface
**operated by somebody who is not its owner**. Everything below is the machinery
that makes that survivable — a standing-consent model the owner writes in
advance, a disclosure ladder that can only ever be walked downward, and an audit
that records both what crossed and what was read to produce it. It works two
ways: **locally**, between two accounts on one box, and **federated**, between
two peer-linked boxes discovered through CI-Portal.

---

## 2. The consent model

### 2.1 Grants: person × data-class × mode

A **grant** is a standing statement by the owner (the *responder*) about one
other party (the *grantee*): *"this person may ask me this kind of thing, and
here is what happens when they do."* Grants live in `ci.ask_grants`.

A grant names:

| Field | Meaning |
|---|---|
| `grantee_user_id` **xor** `grantee_peer_link_id` | Who it is about. A DB CHECK (`ask_grants_grantee_chk`) enforces exactly one; `AskResolver.createAskGrant` re-checks it in front of the write so the client gets a 400 instead of a constraint-name 500. |
| `query_type` | The archetype it covers, from the same closed vocabulary asks are held to. Constraining the *writing* end is what keeps "I blocked this" and "this is blocked" the same statement — a grant naming a word no ask can carry matches nothing while the Grant Manager shows it back as live protection. |
| `data_class` / `scope.dataClasses` | Which class(es) of data. |
| `mode` | `auto` \| `review` \| `block`. |
| `scope.maxDisclosure` | The grant's own **disclosure ceiling** (§2.4). |
| `scope.notBefore` / `notAfter` / `purpose` | Further narrowing dimensions. Every scope field only ever NARROWS; an absent field means "no restriction *from this dimension*", never "allow more". |
| `expires_at`, `revoked_at`, `revocation_reason`, `supersedes_grant_id` | Lifecycle (§2.7). |

### 2.2 Modes, and why `review` is the floor

`evaluateGrant` ([`domains/asks/grantMatch.ts`](../backend/apps/api/src/domains/asks/grantMatch.ts))
is a pure function over the owner's active grants for one grantee. It is
**deny-biased and review-by-default**:

1. a matching **`block`** grant always wins → `deny`;
2. else a matching **`auto`** grant → `auto`;
3. else a matching **`review`** grant → `review`;
4. else — **no matching grant at all** → `review`.

Step 4 is the load-bearing one. **An unmatched ask is never auto-answered.**
There is no implicit open access anywhere in the model; the absence of a
decision is a decision to ask the human.

Three details that are easy to get wrong when editing this function:

- **`block` beats `auto`** so a narrow block can always override a broad
  standing pre-authorization.
- **A null `data_class` reads in opposite directions on the two paths** — a
  wildcard for `block`, never a wildcard for `auto` — because both readings must
  resolve *toward denial*. An `auto` grant must additionally NAME the class it
  pre-authorizes (`autoGrantNamesQueryClass`); a class-less `auto` grant is not a
  wildcard, it is downgraded to `review`.
- **When several grants match, the strictest wins, ties broken by id.** This was
  once `matches.find(...)`, i.e. heap order: the same ask could be capped at
  `summary` before a `VACUUM` and disclosed in full after it. Grant ids are
  uuidv7, so the tiebreak resolves to the oldest matching grant, which is what
  makes `consent_basis` reproducible in the audit.

### 2.3 The disclosure ladder

How much an answer may reveal, coarsest first
([`domains/asks/policy.ts`](../backend/apps/api/src/domains/asks/policy.ts)):

```
none  <  boolean  <  count  <  summary  <  redacted  <  full
```

| Rung | What the asker receives |
|---|---|
| `none` | Nothing. `"Nothing was shared."` |
| `boolean` | Yes / no. |
| `count` | How many, no references. |
| `summary` | A **templated** sentence plus the count. Never generated by a model. |
| `redacted` | The item references the owner kept — and nothing about the rest. |
| `full` | Every matching item reference, **and** how many were held back. |

Every rung discloses strictly less than the one above, so "downgrade" is always
a safe direction to move. Two subtleties:

- **`full` and `redacted` differ only by the withheld count.** By the time the
  ceiling is applied, `buildDisclosedAnswer` has already dropped the ids the
  owner redacted, so the only thing left to clamp is `withheldCount`. This is
  not a nicety: `redacted` used to `return answer` unchanged alongside `full`,
  which made a grant capped at "share only what I kept" disclose exactly as much
  as one with no cap at all. The comment in `applyDisclosureCeiling` puts it
  well — *a rung that clamps nothing is not a rung; it is a label the owner can
  pick believing it does something.*
- **A withheld count is itself a signal**, so it is zeroed at every rung at or
  below `summary`. At `count` and below the asker learns only what the rung
  names.

Item references, where they cross at all, are `{id, type}` pairs — **never raw
content and never signed URLs** — and they are not dereferenceable by the asker:
every `node(id)` branch resolves through a caller-scoped service, so an asker
holding the responder's file id gets `null`.

### 2.4 Four ceilings, combined by taking the narrowest

The **effective** form of an answer is the most restrictive of:

1. the **owner's choice** at review time (the "answer with less" buttons);
2. the **grant's** ceiling (`scope.maxDisclosure`);
3. the **trust tier's** ceiling (§2.5);
4. the **archetype's inferred form** (`inferAnswerForm` — `relationship` yields a
   yes/no, `existence` a count, `attribute` a summary, and anything unrecognised
   falls through to `retrieval`, the only form that returns item references).

They are folded with `narrowestRung(a, b)`, whose entire contract is one
sentence: **nullish means "this SOURCE imposes no ceiling", not "no ceiling
applies"** — a source that says nothing must never erase one that does.
`undefined ?? live` is the shape of the bug it exists to make unwriteable.

The owner's choice is combined by `narrowerForm(chosen, inferred)`, so an owner
picking a *wider* form than the archetype implies is ignored — otherwise the
shape of the answer would be handed back to the asker's own `queryType` string.
A tie goes to the owner's choice, because `boolean` and `identity` sit on the
same rung but read differently to the asker.

### 2.5 Trust tiers

```ts
type TrustTier = 'household' | 'family' | 'trusted' | 'peer' | 'stranger';
```

`household` is **local-only** — a member of the owner's own box. The other four
are what `ci.peer_links.trust_tier` may hold; `PeerTrustTier` is
`Exclude<TrustTier, 'household'>` **by construction**, with compile-time
assertions in both directions, and `PeerLinkService.upsert` rejects a bad value
with a 400 rather than letting it surface as a bare `23514`.

`TIER_CEILINGS` (`policy.ts`), where `'*'` is the fallback for any unnamed class:

| Tier | Ceiling |
|---|---|
| `household` | `{ '*': 'full' }` |
| `family` | `{ '*': 'full', location: 'redacted' }` |
| `trusted` | `{ '*': 'redacted', location: 'summary' }` |
| `peer` | `{ '*': 'summary', photos: 'redacted', location: 'count' }` |
| `stranger` | `{ '*': 'boolean', location: 'none' }` |

A tier **never authorizes** anything. It is a ceiling only: an ask still needs a
matching grant to be answered at all.

Two rules in `disclosureCeiling` exist because `dataClass` is an **optional,
asker-supplied label** that does not actually confine what gets searched:

- **A class the ask does not name gets the tier's FLOOR, not its `'*'`
  fallback.** An omitted class is the broadest an ask can be — unfiltered across
  every indexed entity type — so handing it the fallback written for "some
  ordinary class" rewarded the omission.
- **A per-class entry may only TIGHTEN `'*'`,** and the function clamps rather
  than trusting the table. `peer` reads `{'*': 'summary', photos: 'redacted'}`
  and `redacted` sits *above* `summary`, so a peer who wrote
  `dataClass: 'photos'` used to receive item references where the same ask
  without the label received a sentence — a disclosure **upgrade** bought with an
  asker-supplied string.

New peer links default to `stranger` at the GraphQL layer
(`CreatePeerLinkInput`), deliberately narrower than `PeerLinkService.upsert`'s
own `peer` fallback: adding a person is not the same gesture as trusting them.

### 2.5b Delegation — may their AGENT ask?

`AskGrantScope.delegation` answers a question a grant previously could not: whether "Bob" means Bob, or something acting for him. Adapted from UMA-for-agents recommendation #25, and it stops being academic the moment asks arrive from the Intent Catalog / MCP tool registry rather than from a person at a keyboard.

| Setting | Admits |
|---|---|
| `none` | the person, and nothing acting for them |
| `first-party-only` | the person, or their own Companion acting for them |
| `any-agent` | including third-party software they delegated to |
| *(absent)* | no restriction from this dimension — the contract every scope field holds |

The safety is on the **ask** side, and it mirrors `autoGrantNamesQueryClass` exactly: `AskQuery.actor` is optional and asker-supplied, so "the owner restricted this to Bob himself" must not be enforced against a label Bob chooses whether to write. **An ask that declares no actor satisfies no delegation restriction** — omitting the field is not a narrowing, it is the broadest an ask can be. Such an ask is *downgraded to review*, not denied.

Two further asymmetries:

- **Matching is on `kind`, never on `label`.** A kind is a commitment the asker makes; a label is a name they write. Admitting an agent because it called itself *"Trusted First Party Assistant"* would make the restriction decorative — pinned by a test.
- **An off-contract actor parses to NO actor, never to `person`.** Defaulting would let an agent satisfy a `delegation: 'none'` grant by sending something *malformed*, which is strictly easier than sending something honest. An unreadable `delegation` value reads as the strictest setting, the same way `ceilingOf` treats an unreadable ceiling.

At the consent moment the review card gives the actor **its own line**, not a chip beside the name: *"Ana is asking"* and *"software Ana delegated to is asking"* are different decisions, and the second is the less familiar of the two. The label is attributed — *"calling itself …"* — rather than stated.

### 2.6 Sensitive classes

```ts
SENSITIVE_CLASSES = { health, medical, financial, finance, secrets, credentials, location }
```

For every tier **below `family`** a sensitive class is floored at `none`, which
routes it to owner review rather than letting it auto-answer.

**Two tiers are exempt: `household` and `family`.** This is deliberate and
tested, and it is the single widest automatic disclosure in the product. See
[`asks-threat-model.md` §2 (T1)](asks-threat-model.md) — and known gap **G6**
below, which is the concrete consequence.

### 2.7 Capture at consent time — the rule, and the bug it exists to prevent

`ci.asks.disclosure_ceiling` stores **the ceiling that was in force when consent
was given** — stamped at submit on the `auto` path, at `approve()` on the review
path, and **never re-derived**.

Why this column exists is the single most important thing in this document.

> **Revoking a grant used to make the answer BIGGER.**
>
> The answer path re-ran the grant evaluation to find its ceiling. But every SQL
> read path filters `revoked_at IS NULL`, so a revoked or lapsed grant is
> *invisible* — it reads as "imposes no ceiling" rather than as "consent
> withdrawn". Combined with `undefined ?? live`, withdrawing consent **deleted
> the cap** while leaving the ask answerable, and the disclosure grew. The
> owner's most protective gesture was the one that widened the answer.

The fix is two-part and both halves are load-bearing:

1. **Stamp the ceiling with the basis, at the instant consent applies** —
   `AskService.submit` for `auto`, `AskService.approve` for review. Migration
   `20260821010000_add_ask_disclosure_ceiling.sql`.
2. **Combine the stamp with the live evaluation by taking the narrowest**
   (`narrowestRung`), so a later revocation can only ever **tighten** an existing
   answer.

`NULL` in that column means *"no grant capped this ask when the owner
consented"* — a value, not a gap. The answer path falls back to the live
evaluation for it.

The loop closes at `withdrawPreAuthorization`, which sends a revoked ask back to
review with its `consent_basis` cleared **but its ceiling intact**: approving it
afterwards cannot disclose more than it would have before the revocation. An
owner who genuinely means to widen does it by writing a new grant and letting the
asker ask again — never as a side effect of withdrawing one.

A `deny` at approval time stamps `none`: if a block grant covers this ask *now*,
the owner's tap must not be able to push anything past it.

### 2.7b Dormant grants, and grants about to lapse

The matrix showed what an owner **allowed** and never whether anything came of it, so a grant firing daily and one that has never once matched looked identical — and they call for opposite actions. The dormant one is clutter to tidy up; the busy one is the thing to look at twice.

`AskGrantType.useCount` / `lastUsedAt` are folded from **`ci.ask_audit.consent_basis`** — the grant id a disclosure actually cited — never from the grant's own row, which records what it *permits* and never what it *did*. One usage read is joined onto the whole list in memory, rather than a lookup per grant: this is the tab an owner opens to scan everything at once, and a per-row query would be an N+1 over the audit.

Usage is carried on **revoked and superseded rows too**: *"this fired 40 times before I withdrew it"* is exactly what a consent history is for.

Beside it, the Grant Manager now nudges about grants that will **lapse on their own** within 30 days. `grantsLapsingWithin` counts only grants that are live (by the server's own `active`, never re-derived) *and* carry an expiry *and* whose expiry is still ahead — a revoked grant cannot lapse, one with no expiry never will, and one already past has lapsed rather than being about to. The banner renders **only when there is something to say**: one that appears every time teaches people to look past it, and then the once it matters they look past it too.

### 2.8 Grants supersede; they are never updated

`ci.ask_grants` is **append-only by design**. `revoke` stamps `revoked_at` with
reason `revoked`; a change closes the old row with reason `superseded` and writes
a replacement carrying `supersedes_grant_id`. Nothing is rewritten in place,
because consent history is evidence you may be asked to produce, and because
"they withdrew consent" and "they narrowed it" are different facts.

`updateAskGrant` **merges** scope rather than assigning it wholesale. That
matters: assignment meant narrowing `dataClasses` on a grant capped at `summary`
*deleted the cap* — a narrowing edit that widened the answer, the same family of
bug as §2.7.

`myAskGrantHistory` reads the closed rows.

### 2.9 The audit

Every disclosure writes one `ci.ask_audit` row, in the **same transaction** as
the answer, so neither can exist without the other. It records:

| Column | Holds |
|---|---|
| `outcome` | `answered` \| `auto_answered` \| `declined` \| `expired` |
| `consent_basis` | The grant id that authorised it, if any |
| `disclosed_entities` | The references the asker actually received (empty for every non-`retrieval` form) |
| `disclosed_count` | **The magnitude that crossed.** Kept separate from the above because for a count/boolean answer the references are empty by construction while the number *is* the disclosure |
| `backing_entities` | The ids the answer was computed over, post-redaction, **pre-ceiling** — owner-visible accountability, never disclosed to the asker |
| `peer_link_id`, `peer_handle` | Recorded **FK-lessly**: removing a peer must not erase the record of what was disclosed to them |

`disclosed_count` has no default on `recordAudit`, deliberately: a defaulted
parameter is exactly how it was lost the first time — the method never mentioned
the field and every call site inherited the wrong answer in silence.

---

## 3. The lifecycle of an ask

### 3.1 Statuses and legal transitions

```mermaid
stateDiagram-v2
    [*] --> sent
    sent --> delivered
    delivered --> under_review : no matching grant, or a review grant
    delivered --> answering : the auto path, inside complete()
    delivered --> declined : a block grant — auto-deny, no owner review
    delivered --> expired
    under_review --> answering : owner approves
    under_review --> declined : owner declines
    under_review --> expired
    answering --> answered
    answering --> expired : the sweep's edge — see below
    answered --> [*]
    declined --> [*]
    expired --> [*]
```

`ASK_TRANSITIONS` in [`domains/asks/askStatus.ts`](../backend/apps/api/src/domains/asks/askStatus.ts)
is the authority; `assertAskTransition` throws on any other edge. Note that
`answering` has **no** `declined` edge — once the owner has approved, the ask
either answers or expires.

- `sent` never persists — `AskService.create` marks it `delivered` in the same
  call — which is why it carries no `expired` edge.
- `delivered → declined` is the **auto-deny** edge: a matching `block` grant
  refuses on delivery, with no owner review.
- `answering → expired` exists because `answering` was once the *one* state an
  ask could park in forever. `complete()` deliberately does **not** re-check the
  standing grant on the owner-approved path, so without that edge nothing could
  ever retire an approved-but-unanswered ask.
- **Answerability is not "status == answering".** `isAnswerable(status,
  consentBasis)` accepts `answering` **or** `delivered` carrying a consent basis.
  An auto-answered ask *arrives* at the answer step still `delivered` — the
  standing grant is what authorises it, and `complete()` walks it through
  `answering` to `answered` internally, in one call. `AskService.complete` and
  `AskResolver` enforce the same predicate; they must agree or the gate is
  bypassable.

An `AskExpiryCron` sweep runs every five minutes (`0 */5 * * * *`, explicitly
named so it dedupes across restarts) and does not stack overlapping runs.

### 3.2 A local ask, step by step

Two accounts on one box. Rate limit: **20 asks per rolling minute per asker**.

| Step | What happens | Tables written |
|---|---|---|
| 1. `createAsk` | Feature flag `ask` checked. `AskService.create` writes the row at `delivered`, `consent_basis = NULL`. | `ci.asks` |
| 2. Grant evaluation | `GrantService.evaluate` → `evaluateGrant` over the owner's active grants for this asker. | — |
| 3a. `deny` | Transition to `declined`; audit row `outcome: 'declined'`. | `ci.asks`, `ci.ask_audit` |
| 3b. `auto` | `setConsentBasis` stamps **both** `consent_basis` and `disclosure_ceiling`. Status stays `delivered` — that shape *is* "answerable without review". `AskResolver.createAsk` then runs the shared disclosure pipeline immediately. | `ci.asks` |
| 3c. `review` | Transition to `under_review`. It appears in the owner's **For you** inbox. | `ci.asks` |
| 4. Owner approves | `AskService.approve` → `answering`, capturing the ceiling as `narrowestRung(alreadyStamped, liveEvaluation)`. A `deny` now stamps `none`. | `ci.asks` |
| 4′. Owner declines | → `declined` + audit row. | `ci.asks`, `ci.ask_audit` |
| 5. `runAsk` / auto-answer | `AskExecutorService` runs the query **as the responder** (`{userId: responderUserId}`), keyword mode only. `buildDisclosedAnswer` applies the owner's redaction, then `applyDisclosureCeiling` clamps to the effective rung. | — |
| 6. `complete` | On the **auto** path only, re-checks `isConsentStanding` (§3.4). Transitions to `answered`; writes the answer row and the audit row in one transaction. | `ci.ask_answers`, `ci.ask_audit`, `ci.asks` |
| 7. Asker reads | `askAnswer(askId)`. | — |

Whatever the outcome, the asker sees `answered` or `delivered` and nothing else
(§4.1).

### 3.3 A federated ask, step by step

Two boxes, one Portal-shaped OIDC issuer. Only two routes are reachable from
another Companion: `POST /agent/v1/ask` and `GET /agent/v1/ask/:correlation`.
Rate limits: **10 asks/min** and a separate **30 polls/min**, both per verified
`(issuer, subject)` and both applied **before** the peer-link lookup, so an
unknown caller is limited too.

**Inbound (this box answers).**

| Step | What happens | Tables |
|---|---|---|
| 1 | `PeerAskController` verifies the token with `verifyClaims()` against **this box's own `peers.audience`** — never the broad first-party list, and deliberately **not** `JwtOrApiKeyAuthGuard`, whose Portal path JIT-provisions a local user. Verify, never provision. | — |
| 2 | Rate limit on `(iss,sub)`. | — |
| 3 | `findActiveByPeerIdentity(iss, sub)` — `status='active' AND revoked_at IS NULL`. No link → refused without detail. | — |
| 4 | Known `askId` for **this peer link**? Then **replay** the recorded outcome; decide nothing, execute nothing. A `request_digest` binds one key to one question, so a key reused for a different question is refused as malformed. | `ci.peer_ask_correlations` (read) |
| 5 | Otherwise mint the local ask (`direction: 'inbound'`, `asker_user_id` NULL, `peer_link_id` set) and correlate it. | `ci.asks`, `ci.peer_ask_correlations` |
| 6 | Grant evaluation, exactly as §3.2 — **federation adds a transport and an identity, not a second policy engine.** | — |
| 7a | `auto` → execute run-as-owner, apply the disclosure filter, persist. | `ci.ask_answers`, `ci.ask_audit`, `ci.asks` |
| 7b | anything else → the owner's review inbox; the wire reply is `pending` with one constant reason. | `ci.asks` |
| 8 | Later, the peer collects with `GET /agent/v1/ask/:correlation`. This is a **read**: no grant evaluation, no executor, no ask row, no audit row. A replay is never wider than the live answer was. | — |

**Availability** is the one archetype that never touches search: it reads
`ci.events` directly and runs the pure `computeFreeBusy`, whose output is
interval boundaries only, with overlapping and adjacent busy blocks merged (which
destroys the meeting-count signal as well as the titles). Windows are capped at
31 days and 2000 rows.

> `peer-federation.md` argues availability is safe to auto-answer because the
> output is provably free/busy only. **That argument is about the SHAPE of one
> answer, not about a SERIES of them.** Read
> [`asks-threat-model.md` §3 (T2)](asks-threat-model.md) before relying on it.

**Outbound (this box asks).** `sendPeerAsk` → `OutboundAskService` →
`PeerAskClient`. The local `ci.asks` row is written **before** the request
leaves, so an outbound ask is auditable even when the peer never answers, and a
**fresh correlation id** is sent per ask — never the local row id, which would
leak this box's identifiers. The peer's answer, when it arrives, is persisted as
a `ci.ask_answers` row with `answer_source: 'peer'` plus one audit row, in one
transaction. The responder's `consent_basis` is deliberately **not** stored: it
is their grant id, and "standing pre-authorization or human decision?" is exactly
the distinction the collapsed wire status exists to stop crossing. An outbound
ask that was **not** answered writes no audit row at all — it is not a terminal
outcome, it can still be collected.

Every server-side fetch goes through `peerEgressFetch()`, the only dialer in the
domain: https only, no credentials, no non-standard ports, no
private/loopback/link-local/CGNAT/metadata address in any spelling, the resolved
address re-checked **at connect time** through the dispatcher's `lookup` so there
is no rebind window, and **redirects refused rather than followed**.

### 3.4 Retroactive revocation works two ways

Both are needed; neither is sufficient alone.

- **PUSH.** `GrantService.revoke` / `supersede` → `withdrawPreAuthorization`
  finds every ask whose `consent_basis` is that grant, clears the basis and
  returns delivered-but-unanswered asks to review. Clearing the basis is what
  makes the *existing* gate — `isAnswerable(status, consentBasis)` — reject them.
- **PULL.** `AskService.complete` re-checks `isConsentStanding` at answer time,
  **on the auto path only**. Scoped that way on purpose: an ask in `answering`
  was approved by the owner *for that specific ask*, and that human decision is
  not undone by withdrawing an unrelated standing grant. Revocation of a standing
  *pre-authorization* is the thing that has to be retroactive.

---

## 4. The privacy properties that are deliberate

Each of these looks like a bug from one angle. Each closed a reproduced leak. If
you are about to "fix" one, the reasoning is here so you can argue with it
first.

### 4.1 The asker sees only `answered` or `delivered`

`askerVisibleStatus` folds `declined`, `under_review`, `answering` and `expired`
all to `delivered`. **A block grant, a human refusal, an ask nobody has read yet,
and an expired ask are indistinguishable.**

Why: the status field was a direct readout of the owner's grant matrix, and it
was reproduced that way against Postgres — a block grant returned `declined`, an
auto grant `delivered`, no matching grant `under_review`. Three probes, three
distinguishable answers, bounded only by the rate limit (20/min locally). The cut
is made in the projection that already knows who is looking, not on
`CreateAskPayload` alone, because the asker is a participant and `ask(id)` /
`askOutbox` would hand them the same row one round-trip later.

`answered` survives because it is the one thing the asker legitimately needs:
there is an answer, go and read it.

**In the UI this reads as "Waiting for them" on every non-answered ask** — see
the Sent screenshot in §7. That is the feature.

### 4.2 The clock is pinned too

Collapsing `status` closed the state oracle and left the **clock**. `updated_at`
is an `@UpdateDateColumn`, so every responder-side write moves it, and the
*shape* of the movement re-derives what `status` no longer says: a move within
seconds is the auto-deny, a move hours later is a person reading their inbox, no
move at all is an ask nobody has touched.

`askerVisibleUpdatedAt` returns `createdAt` — a truthful value that carries no
responder activity, and one that keeps the field non-nullable for existing
clients. The one event the asker may legitimately observe still reaches them:
`AskAnswerType.createdAt` carries its own timestamp.

### 4.3 `consentBasis` is withheld from the asker

`consentBasis: isResponder ? ask.consentBasis : null`. It is the id of one of the
responder's own grant rows; handing it over made `createAsk` a grant-matrix
oracle, and on an auto-deny it separated a standing block from a human refusal.
The asker needs to know their ask was accepted. They do not need the identifier
of the rule that accepted it. `createAsk` returns the constant `ASK_ACCEPTED`.

### 4.4 A decline is indistinguishable from an unreachable peer

On the wire, `answered` or `pending`, and **one constant reason string**. The
collapse is made at the **responder**, not on receipt: hiding it on the asker's
box would bind only a well-behaved asker while the word stayed on the wire.
`PeerAskClient.normalize()` additionally folds the reply into the local
vocabulary and **drops the peer's `reason` string outright** rather than echoing
attacker-supplied text into the local UI.

What the asker loses is a real answer to "should I wait?". That is answered
instead by the ask being pollable.

### 4.5 An unknown `askId` is not a 404

`GET /agent/v1/ask/:correlation` returns the ordinary non-answer for an id it has
never seen. A 404 would answer *"has this peer ever asked me that?"* for free,
and separate it from "asked, and refused". An id belonging to a *different* peer
gets the same reply — two peers may independently mint the same uuid, and one
must never collect the other's answer.

### 4.6 A poll, not a callback

A callback inverts who has to be reachable. Exactly one direction of egress is
required today (asker → responder) and `checkEgressUrl` is built around that. A
callback would make the **responder** dial an address the **asker** supplied — a
second, more directly attacker-controlled SSRF sink, on the box that holds the
data — and would make a home appliance an inbound server for its peers.

### 4.7 Zero redirect hops, DNS pinned at connect time

A peer answering `307 Location: http://127.0.0.1:11434/api/pull` used to have
this box re-issue the POST, body intact, inside its own network. Note that the
literal-address checks in `checkEgressUrl` are **not** redundant with the
connect-time guard: `net.connect` skips `lookup` entirely for a literal IP.

### 4.8 `askerHandle` is on the wire and read by nothing

Attribution is `(iss,sub)` → peer link → `link.peerHandle`, i.e. a value the
**owner** wrote when they linked. A peer cannot self-assert a display name into
the owner's UI. The field's presence invites a future "well, we may as well show
it"; do not.

### 4.9 Users bind on `(issuer, subject)`, never email

Email is re-assignable and not unique across issuers, so matching on it once a
second issuer is trusted hands the account to whoever controls that address.
Email survives only as a **one-time** link, gated on `email_verified`.

---

## 5. Truthful retrieval

This is part of the consent model, not an optimisation. A boolean answer
discloses only the word "Yes" — so the owner never sees what it matched, and a
false "Yes" is a false claim *about the owner*, made to someone whose opinion of
them matters.

`keywordSearch` deliberately rewrites `websearch_to_tsquery`'s AND-joined query
into an **OR**-joined one, which is a recall win for an owner searching their own
memory and a fabrication engine for an ask. Measured on the owner's real
**19,241-entity** archive, before the fix:

| Prompt | Matches | Answer |
|---|---|---|
| "Do you know Zerbcorpolis Fnargle?" (invented) | 1 | **"Yes."** |
| "Have you seen Quixtramble Vorbenhaus?" (invented) | **297** — every one of them on the word `seen` | "Yes." |
| "Do you know David Miller?" (not in the corpus; Steve Miller is) | 2 | **"Yes."** |

[`domains/search-next/promptQuery.ts`](../backend/apps/api/src/domains/search-next/promptQuery.ts)
rebuilds the prompt so two things must hold:

1. **A named thing is a constraint, not an alternative.** A run of consecutive
   capitalised words — or, when the archetype says the subject *is* a person, the
   whole residual prompt — becomes a **phrase** (`'david' <-> 'miller'`, exact
   adjacency) AND-ed with everything else.
2. **Ask scaffolding is not evidence.** Postgres's english dictionary drops
   "do"/"you"/"have" but **not** "know", "seen", "met", "told", "heard" — the
   exact words that turn an unanswerable question into 297 matches. They describe
   the speech act, never anything in memory, so they are removed before the query
   is built.

Ordering trap, called out in the source: frame removal happens **while the run is
being cut**, not as a post-filter. Deleting "Tell" from "Did Amanda Tell Brian"
as a post-filter splices "Amanda" and "Brian" into one phrase that names nobody.

After:

| Prompt | Before | After |
|---|---|---|
| every invented / absent name | 1–297 | **0** |
| "Do you know Liam Broza?" (real) | 4 | 2 |
| the same, on the calendar box | 221 | 31 |
| "photos" | 50 (silently capped) | 50 of 529, flagged `truncated: true` |

**Both rules are strictly subtractive: after ≤ before on all 54 measured cases.**
A prompt that reduces to nothing produces no groups, and the caller must read
that as *zero results* — never as "unfiltered".

`truncated` exists because the 50-result cap used to be silent, so a `count`
answer saturating there reported "50" for a corpus holding 607. The cap is a cost
bound, not a privacy control; the flag is what makes the difference visible.

There is deliberately **no LLM** on this path. See §4 of the threat model for the
full trace and the four tripwires that would create one.

---

## 6. Architecture

```mermaid
flowchart TD
    L["Local user<br/>(GraphQL)"] --> G
    P["Linked peer box<br/>POST /agent/v1/ask<br/>GET /agent/v1/ask/:correlation"] --> PC

    subgraph GQL["domains/graphql — the local surface"]
      G["AskResolver<br/>16 ops, all ask-flag-gated"]
      PL["PeerLinkResolver<br/>5 ops, NOT flag-gated"]
    end

    subgraph PEERS["domains/peers — transport + identity"]
      PC["PeerAskController<br/>verifyClaims, audience-pinned"]
      PS["PeerAskService (inbound)"]
      OS["OutboundAskService → PeerAskClient"]
      UP["urlPolicy / peerEgressFetch"]
      AV["availability.ts — computeFreeBusy"]
      PLS["PeerLinkService"]
      PC --> PS
      OS --> UP
    end

    subgraph ASKS["domains/asks — the policy"]
      GS["GrantService"]
      AS["AskService (lifecycle)"]
      EX["AskExecutorService"]
      AU["AskAuditService"]
      PU["policy · grantMatch · disclosure · askStatus (pure)"]
    end

    subgraph SN["domains/search-next"]
      PQ["promptQuery — phrases + frame stripping"]
      SS["SearchService.searchPrompt<br/>keyword mode only"]
    end

    G --> ASKS
    G --> OS
    PL --> PLS
    PS --> ASKS
    PS --> AV
    EX --> SS
    SS --> PQ

    ASKS -.->|"never imports"| X["domains/llm<br/>domains/personalization"]
```

### Where the boundaries are

- **`domains/asks` owns the policy.** Grants, ceilings, the ladder, the
  lifecycle, the audit. It is where a consent question is decided. Almost all of
  it (`policy.ts`, `grantMatch.ts`, `disclosure.ts`, `askStatus.ts`,
  `canonical.ts`) is **pure functions**, which is why the threat model can run
  mutation experiments against it cheaply.
- **`domains/peers` owns the transport and the identity.** It adds a wire
  format, an OIDC verification, a peer-link attribution and an egress guard —
  and **no second policy engine**. `peers` depends on `asks`, never the reverse
  (`TrustTier` is declared in `asks/types.ts` and mirrored, not imported, in
  peers).
- **Inbound and outbound are deliberately separate services.** Inbound treats
  the ask as hostile and the local owner as authoritative; outbound treats the
  local user as authoritative and the **peer's response** as untrusted.
  Conflating them would blur which side of the trust boundary each piece of data
  came from.
- **`domains/graphql` is the local surface.** `AskResolver` is the only place
  the local answer pipeline is assembled; `resolveTier` lives here, and it
  returns the constant `'household'` for every local asker (see G6).
- **`domains/search-next` is the only thing that touches the archive** on an ask,
  in `mode: 'keyword'`, with `subjectIsName` as the only other input that
  crosses. Neither `asks` nor `peers` imports `@ci/domains/llm` or
  `@ci/domains/personalization`, and `'ask'` is not in `INDEXABLE_ENTITIES`, so
  ask text is never embedded and cannot be retrieved into any other prompt.

### Tables

| Table | Holds |
|---|---|
| `ci.asks` | One ask. `+ peer_link_id`, `direction`, `consent_basis`, `disclosure_ceiling`. `asker_user_id` is nullable with a CHECK that exactly one of `(asker_user_id, peer_link_id)` identifies the asker |
| `ci.ask_grants` | Standing consent. Append-only; `+ grantee_peer_link_id` (exactly-one CHECK), lifecycle columns |
| `ci.ask_answers` | The disclosed answer, `answer_source` `self` \| `peer` |
| `ci.ask_audit` | What was disclosed, on what basis, and separately what was **read** |
| `ci.peer_links` | The local half of the trust graph: handle, endpoint, peer `(iss,sub)`, trust tier, revocation, `person_entity_id` |
| `ci.peer_ask_correlations` | Asker-minted `askId` → local ask, **scoped by peer link**, with a `request_digest` |
| `ci.federated_identities` | `(issuer, subject) → user`; `bind_method` records `sub` vs one-time `email_link` |

Migrations: `20260715070602_add_asks` … `20260821120000_add_peer_ask_correlations`.

### Configuration

```jsonc
// backend/apps/api/config/default.json
"features": { "ask": true },        // ENABLE_ASK — ships true
"peers": {
  "directoryUrl": "",   // CI_PEER_DIRECTORY_URL   — empty disables discovery
  "memoryEndpoint": "", // CI_PEER_MEMORY_ENDPOINT — this box's own /agent/v1
  "handle": "",         // CI_PEER_HANDLE
  "audience": "",       // CI_PEER_AUDIENCE — REQUIRED for inbound
  "timeoutMs": 10000    // CI_PEER_TIMEOUT_MS
}
```

**`peers.audience` is not optional for inbound.** Without it, a token issued for
*any* first-party client would verify here — including one minted for a different
Companion. The peer route refuses every request until it is set rather than
falling back to the broad list. With the `ask` flag off, `POST /agent/v1/ask`
returns 503, indistinguishable from a box with no peer surface at all.

---

## 7. Running it

### 7.1 The `/asks` page

`make dev`, then `https://<project>.localhost/asks`, or click **Asks** in the
Power Rail. The route is registered only when the `ask` flag is on — flag-gated
routes in this app are never registered rather than blocked, because with the
flag off every ask mutation returns `success: false` and a registered route
would be a page of dead buttons. The rail entry is gated on **the same `ask`
flag**, not a cosmetic `asks.page` of its own
(`layouts/Main/railDestinations.ts`), so the row and the page it points at
cannot disagree; a rail entry on a different flag is a link to a 404.
`ask` ships **`true`** in `backend/apps/api/config/default.json`.

Six tabs: **For you** · **Ask someone** · **Sent** · **Who can ask me what** ·
**People I'm linked to** · **What I've shared**.

### 7.2 The two-box federation harness

```bash
make fed-demo      # both boxes up, seeded, every scenario driven
make fed-status    # ports, endpoints, logs
make fed-down      # stop (PURGE=1 also drops the databases)
```

Two full CI-Server boxes on one Mac (`:13030` / `:13031`, each with its own
Postgres and MinIO and its own compose project), plus a loopback OIDC issuer on
`:14000` standing in for CI-Portal. Both boxes trust the **same issuer** — the
realistic shape — and are separated by **audience**, so a token minted for box A
is rejected by box B despite an identical signature and issuer.

Five scenarios: an auto-answered content ask; an ask nothing covers, approved by
hand and then **collected** by the asker; a blocked ask whose refusal is
byte-identical to the pending reply; a capped availability ask that returns *how
many* free slots and never *when*; and the ask from scenario (a) re-run after the
owner revokes — which lands in front of the owner, **and the answer does not get
wider**. That last one is §2.7 re-proved across a real box boundary on every run.

Nothing is weakened to make it run. The driver POSTs to box B directly rather
than going through `sendPeerAsk`, because `checkEgressUrl` correctly refuses
`http://127.0.0.1:13031`; what the driver replaces is *who calls fetch*.
Everything that decides disclosure is real.

**Measured on merged main: 52 passed, 1 failed.** The single failure is the
harness's **own** pinned known-gap assertion —

> `KNOWN GAP, pinned: an owner-approved federated disclosure records NO peer_handle`

— which now fails because **PR #2229 fixed the gap**. The harness is asserting a
bug that no longer exists; the assertion (and finding 2 in its README) needs
inverting. See T4 in §9.

The harness boxes are also the most reliable target for the DB-backed suites,
because a harness box is always migrated to *this* checkout's head:

```bash
PW=$(grep -E '^DATABASE_PASSWORD=' .env | cut -d= -f2-)
ASKS_TEST_DATABASE_URL="postgres://companion:${PW}@localhost:15432/companion" \
PEERS_TEST_DATABASE_URL="postgres://companion:${PW}@localhost:15432/companion" \
DATABASE_URL="postgres://companion:${PW}@localhost:15432/companion" \
  yarn workspace @ci/be-api test src/domains/asks src/domains/peers
```

### 7.3 The consent-path CI gate

`.github/workflows/consent-path-gate.yml`, plus
`.github/scripts/assert-consent-suites-ran.mjs`.

It exists because **nothing gates a merge on this repository**. `main`'s branch
protection still carries **no `required_status_checks` block at all** and
`required_approving_review_count: 0` (re-checked via
`gh api repos/companionintelligence/CI-Server/branches/main/protection` on
2026-08-23). Nine PRs of security-critical consent changes merged with zero
automated verification.

> **Δ 2026-08-23 — one clause here was stale within two days of being written.**
> It said "all workflows are `workflow_dispatch`-only, and the only check that
> reports on a PR is a red-by-baseline Xcode Cloud iOS build". Eight of the ten
> workflows are dispatch-only; `codeql.yml` (added the same day in
> [#2261](https://github.com/companionintelligence/CI-Server/pull/2261)) runs on
> `push` and `pull_request` against `main`, and `mobile-release.yml` runs on
> release tags. **This does not change the conclusion.** CodeQL is not a gate
> either: it is not in `required_status_checks`, and it fails on every run at the
> SARIF upload — `Code Security must be enabled for this repository to use code
> scanning` — so it is a *second* red-by-baseline check rather than a first real
> one. Xcode Cloud is still red on every PR (verified on #2263 and #2265).

Turning `ci.yml` back on would have made it *worse*, not better: its backend job
runs the suite with **no database**, every DB-backed suite is
`availability.available ? describe : describe.skip`, and jest exits **0**. The
gate therefore does two things `ci.yml` does not — it supplies a real migrated
Postgres (the appliance's own `ghcr.io/companionintelligence/companion/database`
image, pinned, because the migrations need TimescaleDB + PostGIS + pgvector and
PG18's native `uuidv7()`), and it **fails if any consent test skips**.

Two independent checks, both needed: **zero skips anywhere in scope** (catches a
new DB-backed suite nobody added to the manifest) and **a named manifest of five
required suites** (catches a suite that produced *no tests at all* — deleted,
renamed, or excluded by a path-filter typo, which is zero skips and therefore
invisible to the first check).

It ships **dispatch-only**. Making it a real merge gate needs the commented
`pull_request` block uncommented *and* the check named `consent-path` added to
main's branch protection — a repository-settings change, not a file change.

```bash
gh workflow run "Consent path gate" --ref <branch>
```

### 7.4 The DB env vars, and what happens when you get them wrong

| Suites | Variable |
|---|---|
| `src/domains/asks`, `graphql/resolvers/__tests__/Ask*` | `ASKS_TEST_DATABASE_URL` |
| `src/domains/peers` | `PEERS_TEST_DATABASE_URL` |
| `src/domains/search-next` | `SEARCH_NEXT_TEST_DATABASE_URL` |

Each falls back to `DATABASE_URL`, then the discrete `DATABASE_*` variables.

**The probe answers "is a port open", not "are the migrations applied", and that
split is deliberate:** *nothing is listening* is an absent database and must
**skip**; *something is listening but the schema is wrong* is a broken setup and
must **FAIL**, with a message naming the fix. So pointing any of these at a
Postgres without the asks/peers migrations does not skip legibly — it produces a
pile of hard failures like `relation "ci.peer_links" does not exist`, which read
exactly like a code bug in your change. `.env` hard-codes `DATABASE_PORT=5432`,
so on a machine with several worktree stacks the suites land on whichever one
happens to hold host 5432 — usually a schema no branch describes.

---

## 8. The surfaces

All captures are of merged `main`, dark theme (one light shot at the end).

### The page as it opens — `/asks`, the **For you** tab

![The /asks surface as it opens](images/asks/01-landing.png)

### The review inbox, two asks awaiting the owner

![Two asks awaiting review](images/asks/02-for-you-2.png)

Each card carries, in order: who is asking and the two-value fact the wire
supports (`no standing grant`); **the asker's own words, quoted**; what the box
derived itself (*"Would search: retrieval · photos"* and, honestly, *"'photos' is
a label on the request, not a guaranteed filter — unless your Companion
recognises it, this searches every kind of thing in your memory"*); the consent
state; and the downgrade row — **"Or answer with less — each of these caps the
answer, and can never widen it"** — rendered as prominently as Approve.

### The composer — **Ask someone**

![The ask composer](images/asks/03-ask-someone.png)

Recipient chips, a **closed** archetype list rather than a free-text
`queryType` box (a typo in a free-text field does not produce a narrower ask —
it falls through to `retrieval`, the **widest** one, silently), the ceiling in
plain language (*"They can answer at most yes or no."*), a wire-format preview of
exactly what the recipient will see, and the honest block:

> **People you are linked to but cannot ask from here** — *asking across boxes
> needs an access token from the Portal that your Companion cannot issue from
> this page yet.*

### The asker's view — **Sent**

![The Sent tab](images/asks/04-sent.png)

Note that every non-answered ask reads **"Waiting for them."** That is §4.1 made
visible: a block grant, a human refusal, and an unread ask are the same words.

### The grant matrix — **Who can ask me what**

![The grant matrix](images/asks/05-who-can-ask-me-what.png)

Per grantee, per `queryType · dataClass`: the mode (`Answers automatically` /
`Ask me first` / `Blocked`), `Revoke`, and an end-date control. Note the two
honest absences — the tier badge reads **"tier unknown"** because no tier reaches
the client (threat model T6), and there is no control anywhere on this page that
**creates** a grant (G2).

### Peer links — **People I'm linked to**

![Peer links and trust tiers](images/asks/06-people-i-m-linked-to.png)

The one journey that completes end to end through the UI. Each link's tier is
stated in the owner's language rather than in ladder vocabulary — *"Answers are
redacted at most — the items you keep, never the ones you hold back. Location,
health, finances and secrets are never disclosed at this tier."*

### The consent lock and signature detail

Every review card and every disclosure row carries a **lock**, and it is a button: `ConsentLock.tsx` renders one of four states — `sealed` (consent *and* a verified RFC 9421 signature), `consented` (consent, unsigned channel), `pending` (undecided), `open` (no basis recorded) — and opens `ConsentDetailModal.tsx`.

The modal separates what the lock compresses:

| Section | Answers |
|---|---|
| What authorized this | standing grant vs your own decision; the grant's posture; the ceiling that applied |
| How it reached you | signed or not; the key thumbprint; when *this box* verified it; each covered component beside what it protects |
| When and how it was collected | arrival time, path (local / inbound / outbound), who asked |

Two invariants live in `consentProvenance.ts` and are pinned by `consentProvenance.test.ts`:

- **Weakest wins** — `consentLockState` returns `pending` for an undecided ask *even when the signature verified*. A signature proves who asked, not that they were allowed to.
- **Unrecorded ≠ unsigned** — `ci.ask_audit` has no channel columns, so `DisclosureHistory` passes `channelRecorded: false` and the modal says so. Rendering a null as "arrived unsigned" would assert a fact nobody checked.

Protocol reference: [`SIGNATURES.md`](https://github.com/companionintelligence/CI-Engineering/blob/main/projects/decentralized-trust-graphs/SIGNATURES.md) in CI-Engineering.

### The disclosure history, by relationship

![Disclosure history folded by relationship](images/asks/disclosure-relationships.png)

`askDisclosureHistory` used to take **no arguments** — no filter, no window, no cap — and the page rendered every audit row this box held in one flat reverse-chronological list. A standing grant answering twice a day writes some seven hundred rows a year, so the surface whose stated purpose is *"you cannot withdraw consent you cannot see the consequences of"* was at its least usable exactly when it had most to say.

Pagination would not have fixed it, because **the unit was wrong**. Nobody arrives asking "what happened at 14:07 on Tuesday"; they arrive asking *"what has Ana been getting?"*. So the history now opens on the fold and the flat list is the drill-in.

| Layer | Query | Notes |
|---|---|---|
| Index | `askDisclosureSummary` | One row per counterparty. `disclosureSummary.ts` is the fold — pure, 21 tests |
| Drill-in | `askDisclosureHistory(input: { counterpartyKey })` | Not fetched at all until a relationship is opened |

Four properties worth keeping:

- **`autoAnswered` and `reviewed` never merge.** They differ by whether a human was in the loop, which is the entire question. `activityLine` leads with the automatic count because that is the one an owner might want to go and stop — a decision they made themselves, they remember making.
- **Magnitude, not ask count.** "14 asks" and "213 items" are different facts; only the second describes what the other person now holds.
- **The unattributed bucket is never merged into a person.** Rows whose counterparty was erased group under one key labelled as a bucket. Attributing an unattributable disclosure to somebody specific is the one error this surface must not make, since the owner may act on it by revoking them.

  ![The unattributed bucket](images/asks/disclosure-unattributed.png)

- **`truncated` is on the wire.** The read is capped at `MAX_AUDIT_ROWS` (5,000) — a cost bound, not a privacy control — and the fold says so, because the totals beside a capped read are floors. A completeness surface presenting a floor as a total is the failure the flag exists to prevent.

`accelerationNote` states a fact — *"90% of everything they have ever received arrived in this window"* — and stops there. There is **no enforced disclosure budget** yet ([#2364](https://github.com/companionintelligence/CI-Server/issues/2364)); a threshold rendered here would be a number with nothing behind it.

### The disclosure history — **What I've shared**

![The disclosure history](images/asks/07-what-i-ve-shared.png)

Declines included, and the provenance of each disclosure is stated in three
values, not two: *answered automatically under a standing grant*, *you reviewed
this and answered*, and *declined*.

### Light theme

![The /asks surface in light theme](images/asks/90-landing-light.png)

---

## 9. Known gaps

Stated plainly, unsoftened. **This section is the point of the document.** The
feature reads finished; it is not.

**G1 — Retrieval bypass (high).** Phrase binding fires only on a run of
**capitalised** words, or on the relationship/identity archetype — and the
**asker controls both**. Executed against the real corpus: `queryType: 'content'`
with the prompt `"do you know david miller"` returns **"Yes." unattended** on a
corpus containing only *Steve* Miller. Capitalised, the same ask correctly
returns nothing. Capitalisation is a hint the wire format does not promise, and
`NAME_SUBJECT_QUERY_TYPES` is a string the asker types.

**G2 — No grant-creation entry point (blocker).** `createAskGrant` is complete on
the wire — it takes `granteeId` or `granteePeerLinkId`, `maxDisclosure`, scope,
mode, purpose — and **no UI calls it**. There is no `CREATE_ASK_GRANT` document
in `asksOperations.ts`. An owner cannot create a standing grant through the
product. The Grant Manager can only edit and revoke grants that already exist,
which on a fresh box is none. (`createAskGrant` also has no `expiresAt` field
yet; set one with `updateAskGrant`.)

**G3 — Cross-box asks cannot be sent from the page (blocker).** The composer says
so itself: *"asking across boxes needs an access token from the Portal that your
Companion cannot issue from this page yet."* `sendPeerAsk` takes a
`peerAccessToken` as a **non-nullable** field — until Portal token exchange
(RFC 8693) lands, the caller must supply it, and this box never mints, exchanges
or caches one.

**G4 — Of eight user journeys, ONE completes through the UI:** link a peer and
set a trust tier. The **backend is proven correct for all eight** by driving the
real resolvers and services against real Postgres. **The gap is reachability, not
correctness.** Do not read the passing suites as "the feature works"; read them
as "the feature would work if it had a front door".

**G5 — Peer-link revocation is incomplete in three separate ways.**
(a) A revoked link still supplies its original **trust tier** to asks already in
the inbox — `resolveTier` reads `link?.trustTier` from an owner-scoped `findById`
that returns revoked rows. (b) `updatePeerLink` calls `PeerLinkService.upsert`,
which sets `revokedAt: null` unconditionally, so **editing a link erases its
revocation timestamp**. (c) `PeerLinkResolver`'s five operations are **not gated
by the `ask` feature flag**, while all sixteen of `AskResolver`'s are.

**G6 — A household `auto` grant on a sensitive class discloses full item
references with no human in the loop.** ⚠️ **Mechanism shipped; the DEFAULT is
unchanged and is a product decision** — see
[`asks-household-default.md`](asks-household-default.md). `ci.household_tiers`
now lets an owner demote another local account, `resolveTier` reads it, and the
Grant Manager's tier badge is a control for local grantees. The exemption is
also now pinned by a test (closing **D6**): removing `tier !== 'household'` from
`disclosureCeiling` fails 2 tests, where the threat model measured 544 passed /
0 failed. What has NOT changed: an owner who has said nothing still gets
`household`. Original text follows. `household` is exempt from the
sensitive-class floor and its ceiling is `{'*': 'full'}`. Every local asker is
`household` unconditionally — `resolveTier` is a `return` statement, there is no
column, no mutation and no UI that could store anything else — so there is no way
to demote a housemate. See threat model T1, which also records that the household
half of that exemption is pinned by **no test**.

**G7 — The first `make fed-demo` on cold state fails a JWKS race** before any
scenario runs. The second succeeds.

**G8 — Rate limits are per-process in-memory maps.** Multiple processes multiply
the effective limit, and a restart resets the window. Both files say so
themselves; a shared store is needed before the ask path goes multi-instance.

**G9 — Rate limits bound RATE, not TOTAL.** Nothing *enforces* a cumulative
disclosure budget. (The owner can now SEE consumption per relationship — see
"The disclosure history, by relationship" in §8 — but seeing is not a limit;
enforcement is [#2364](https://github.com/companionintelligence/CI-Server/issues/2364).)
Nothing tracks cumulative disclosure. A patient asker with a narrow, legitimately-granted permission can
reconstruct a great deal through many individually-legitimate asks. The ceiling
is 28,800 local asks and 14,400 peer asks per day. `ci.ask_audit` already holds
everything a budget would need (`disclosed_count`, `backing_entities`,
`consent_basis`) and **nothing consumes it**. Threat model T5 sketches what a
real budget would look like — durable, per-relationship, denominated in
disclosure rather than requests, and failing closed by **downgrading** rather
than erroring, because an error is an oracle.

---

## 10. Traps for the next engineer

**T1 — The false green.** `yarn workspace @ci/be-api test src/domains/asks
src/domains/peers` with the DB env vars unset **skips 73 tests and exits 0**.
The suites that evaporate are precisely the ones a reviewer would rely on:
retroactive revocation, lapsed grants, the supersede chain, the jsonb disclosure
ceiling, atomic answer+audit rollback, correlation idempotency, immediate peer
revocation. Nothing in the output says "the consent path was not checked". Always
run these with a migrated database, or run the gate. Verified: the gate's assert
script exits 1 on that run and names every skipped suite.

**T2 — Skip vs fail is deliberate, and the failure mode is loud.** Pointing
`ASKS_TEST_DATABASE_URL` at a Postgres *without* the migrations does not skip —
it produces hard failures that read like a bug in your change (§7.4). Check the
schema before you debug the code.

**T3 — Prettier's cheerful all-clear.** `prettier --check` prints **"All matched
files use Prettier code style!"** and exits **0** when every path you named is
covered by `.prettierignore` — measured with prettier 3.9.6:

```
$ prettier --check bad.ts gen.ts     # both in .prettierignore
Checking formatting...
All matched files use Prettier code style!   → exit 0

$ prettier --check gen.ts bad.ts     # only gen.ts ignored
[warn] bad.ts                                 → exit 1
```

A pass over a list of files is therefore not evidence that any of them were
checked. This repo's `.prettierignore` covers `**/__generated__/**`, the
Capacitor native output, and `frontend/apps/web/src/graphql/*.ts`. Two related
edges: Prettier never reads `.gitignore` (the ignore file says so itself), so
nested gitignores are invisible to it in the other direction — a Capacitor sync
can look exactly like a formatting regression — and `.prettierrc` here pins
`"parser": "typescript"` globally, so pointing `prettier --check` at a Markdown
file **errors** rather than checking it. Markdown is not in the repo's
`format`/`format:check` glob (`**/*.{ts,tsx,js,mjs}`) at all; do not add this
document to it.

**T4 — The harness asserts a bug that was fixed.** `make fed-demo` reports 52
passed / 1 failed on merged main, and the failure is scenario (b)'s pinned
`KNOWN GAP … records NO peer_handle`, which PR #2229 closed. Do not "fix" the
fix. Invert the assertion and update finding 2 in the harness README.

**T5 — jest and vitest, per workspace.** `@ci/be-api` runs **jest**
(`DOTENV_CONFIG_PATH=../../../.env jest`); `@ci/fe-web` runs **vitest**
(`vitest run`). A consent change usually touches both — `src/domains/asks` and
`src/pages/AsksPage` — and the runners take different flags, different filter
syntax and different config. Run them separately, from their own workspaces.

**T6 — Other doc claims that have gone stale.** Both siblings predate work that
has since landed; correct them rather than quoting them:
- `peer-federation.md` says the ask surface *"is not reachable in the shipped web
  app"* and that peer links can only be created *"by hand"*. Both are now false —
  `App.tsx` registers `/asks` behind the flag, and `PeerLinkResolver` ships
  `createPeerLink` / `updatePeerLink` / `revokePeerLink`. **Corrected in this
  PR.**
- The federation harness README's finding 5 (*"No API creates a peer grant"*) is
  also stale: `createAskGrant` now accepts `granteePeerLinkId` and resolves it
  through an owner-scoped read.
- `asks-threat-model.md` was written at `fe5075a79` and says the Grant Manager
  *"prints 'Changing a grant's mode isn't available yet'"*. `updateAskGrant` is
  wired now; the **creation** half (G2) is what is still missing. The threat
  model flags this itself and asks you to re-check.

**T7 — The tripwires that would create a prompt-injection surface.** There is no
LLM on the ask path today and that was traced end to end. Four changes would
create one: switching `AskExecutorService`'s `mode` off `'keyword'`; replacing
`buildSummary` with an LLM (which `disclosure.ts` already names as a planned
follow-up — **the single highest-risk planned change in the feature**); resolving
item labels through a summarizer; or adding `'ask'` to `INDEXABLE_ENTITIES`. If
answers are ever generated, the constraint is fixed now: the model may see the
matched content and a **box-authored** description of the request, never the
asker's sentence.

---

## 11. How this document was verified

- Read against merged `origin/main` at `8cd68dbe6`, in a clean worktree, with
  `git fetch` current.
- Unit and integration suites, run against a **migrated** Postgres:

  | Suite | Suites | Tests | Skipped |
  |---|---|---|---|
  | `be-api src/domains/asks` | 21 | 328 | 0 |
  | `be-api src/domains/peers` | 14 | 281 | 0 |
  | `be-api src/domains/graphql` | 38 | 344 | 0 |
  | `be-api src/domains/search-next` | 6 | 74 | 0 |
  | `fe-web src/pages/AsksPage` | 6 | 98 | 0 |

  With the DB env vars **unset**, the same runs skip **73** tests and jest exits
  **0** — the false green T1 describes and the gate exists to catch.
- `make fed-demo`: **52 passed, 1 failed**, the failure being the harness's own
  stale known-gap assertion (T4).
- Retrieval numbers measured on the owner's real **19,241-entity** archive; 54
  cases compared before/after, all subtractive.
- Screenshots are real captures of merged `main`, committed under
  [`docs/images/asks/`](images/asks/).
