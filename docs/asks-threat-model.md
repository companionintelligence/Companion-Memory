# Threat model: the Asks feature

> **Status:** first threat model for this feature. Written against `origin/main` at `fe5075a79`
> (2026-08-21). Every file:line below was read at that commit.
>
> **Scope:** the interpersonal ask feature — `backend/apps/api/src/domains/asks`,
> `backend/apps/api/src/domains/peers`, `AskResolver`, and `frontend/apps/web/src/pages/AsksPage`.
> Sibling docs: [`asks-system-guide.md`](asks-system-guide.md) (the reference document — how
> the feature works, and its current gap list), [`peer-federation.md`](peer-federation.md)
> (the cross-box design), [`saved-search-sharing.md`](saved-search-sharing.md) (the surface it
> inverts).
>
> **Δ 2026-08-23 — some "unreachable from the UI" observations below have moved on.**
> `updateAskGrant`, the `/asks` route, `askDisclosureHistory` and peer-link management have all
> since been wired; `createAskGrant` still has no caller. The document says so itself where it
> matters and asks you to re-check — do that against
> [`asks-system-guide.md` §9](asks-system-guide.md), which is verified at `8cd68dbe6`. **The
> threat analysis itself is unaffected:** every ceiling, tier, exemption and default it argues
> about is unchanged.
>
> **This document is not reassuring, and that is the point.** A threat model whose conclusion
> is "we are fine" has not been written, it has been performed. What follows names the
> things this feature is genuinely excellent at defending, and then names — with file and
> line — the things it does not defend at all, so that a person can read it and decide what
> to ship.

---

## 0. Summary for someone deciding whether to ship

The Asks feature has **world-class defences against one threat model and essentially none
against the one that actually hurts people.**

The model it was built against is *two rational parties trying to extract information
through side channels*. Against that adversary the code is better than most production
systems: the decision oracle is collapsed (`AskType.ts:193`), the timing oracle is pinned to
`createdAt` (`AskType.ts:228`), a refusal is worded identically to an empty result
(`protocol.ts:129`), counts are withheld from forms that do not itemize
(`AskAnswerType.ts:103`), an unreadable ceiling fails closed rather than open
(`grantMatch.ts:146`), and the deciding grant among several is chosen by strictness rather
than by heap order (`grantMatch.ts:106`). Each of those closed a real, reproduced leak.

The model it was **not** built against is **asymmetric power between people who know each
other.** Grepping the whole feature — `domains/asks`, `domains/peers`, `pages/AsksPage` —
for `coercion`, `abuse`, `stalking`, `intimate`, `duress` or `panic` returns exactly three
hits, all of them the phrase "abuse control" describing a rate limiter
(`rateLimit.ts:3`, `AskRateLimitService.ts:12`, `AskRateLimitService.spec.ts:42`). There is
no concept in this codebase of an asker the owner is afraid of.

That is the gap. It is a **design** gap, not a bug: the code does correctly and provably
what it was told to do. Six threats follow. Four are design gaps, two are code bugs, and
two of the six are inherent to the product concept and can only be mitigated.

| # | Threat | Class | Worst case today |
|---|---|---|---|
| T1 | Coercion / intimate-partner abuse | Design gap | The person who shares the appliance is by construction the most privileged asker, with no ceiling, no cooling period, and no way to demote them |
| T2 | Stalking via availability | Design gap (+ under-classification) | A `trusted` or `family` peer receives real calendar interval boundaries over 31-day windows, auto-answered, 14 400 times a day |
| T3 | Social engineering at the consent moment | Code bug + design gap | Unbounded asker-authored text renders directly above the Approve button |
| T4 | Prompt injection into the owner's archive | **Not present today** | Traced end to end; no LLM is on the ask path. Two named tripwires would create one |
| T5 | Cumulative disclosure | Design gap | Rate limits bound rate, not total. There is no disclosure budget of any kind |
| T6 | Vulnerable users and the default tier | Design gap | Defaults are good for peers and absent for housemates |

---

## 1. Assets, actors, boundaries

**Asset.** The owner's memory archive — in the real deployment this is on the order of
tens of gigabytes of a single person's life: mail, photos, calendar, location, receipts,
messages. The ask feature is a *query interface to that archive, operated by someone who
is not its owner.* That framing is the whole risk.

**Actors.**

| Actor | How they authenticate | Tier they receive |
|---|---|---|
| Local user on the same box | `JwtOrApiKeyAuthGuard` | `household` — unconditionally (`AskResolver.ts:744-750`) |
| Portal-brokered principal | `PortalTokenService.verifyAndProvision` (`JwtOrApiKeyAuthGuard.ts:35`) | `household` — a JIT-provisioned local account is indistinguishable from a housemate |
| Linked peer box | Portal OIDC token, attributed by `(iss,sub)` | The tier the owner assigned the link, default `peer` (`PeerLinkService.ts:65`) |
| Unlinked caller | Verified token, no link | Refused; rate-limited before the link lookup (`PeerAskController.ts:59-61`) |

**Boundaries.** Two: the process boundary (GraphQL, local users) and the box boundary
(`/agent/v1/ask`, peers). The consent engine is shared; only the transport and the identity
differ. That is a strength — there is one policy engine, not two.

**What actually crosses today.** Worth stating plainly, because it bounds the blast radius
of everything below:

- A `retrieval` answer carries `{id, type}` **references only** — no content, no signed
  URLs (`disclosure.ts:38-48`). Those ids are raw entity ids and are **not dereferenceable
  by the asker**: every `node(id)` branch resolves through a service scoped to the caller
  (`NodeResolver.ts:94+`, e.g. `FileService.ts:281-289`), so an asker holding the
  responder's file id gets `null`.
- The summary is templated, never generated (`disclosure.ts:120-135`).
- **The exception is availability**, which crosses as *real ISO instants of the owner's
  actual busy and free blocks* (`PeerAskService.ts:469`). It is, today, the
  highest-fidelity disclosure in the entire feature. See T2.

So "full disclosure" today means *counts, a templated sentence, and opaque ids*. That is a
real mitigation and it is **temporary by design**: `askBinding.ts:132-141` already flags
that a per-item label needs the backend to resolve the entity, and
`disclosure.ts:116-118` already flags that an LLM-synthesized summary is a follow-up.
Every ceiling decision below should be judged against the day those land, not against
today.

---

## 2. T1 — Coercion and intimate-partner abuse

### The threat

An abusive partner, parent, adult child or carer who shares the appliance uses the ask
surface as a supervision tool. They do not need to hack anything. They ask, and they are
standing there while the owner decides. Refusal is legible: the abuser knows they asked,
so a declined or unanswered ask is itself an act of defiance with consequences outside the
software.

### Who it hurts

The person with less power in a relationship where both people are legitimate users of the
same machine. Disproportionately: survivors of intimate-partner abuse, elders under
coercive "care", teenagers, adults with disabilities whose carer administers the device.
This is the population for whom a personal-memory appliance is *most* dangerous and *least*
substitutable — leaving is not a click.

### What the code does today

**Every local asker is `household`, unconditionally.**

```ts
// backend/apps/api/src/domains/graphql/resolvers/AskResolver.ts:744
function resolveTier(ask: Ask, link: PeerLink | null): TrustTier {
  if (ask.peerLinkId == null) {
    return 'household';
  }
  return (link?.trustTier as TrustTier | undefined) ?? 'stranger';
}
```

**`household` has no ceiling in any branch.** `TIER_CEILINGS.household` is `{'*': 'full'}`
(`policy.ts:101`), so:

- a named class returns the `'*'` fallback → `full` (`policy.ts:164-166`);
- an *unnamed* class returns `strictestIn(table)`, which over a one-entry table is also
  `full` (`policy.ts:109-111, 156-158`);
- and the sensitive-class floor is skipped entirely:

```ts
// backend/apps/api/src/domains/asks/policy.ts:160
if (SENSITIVE_CLASSES.has(canonical) && tier !== 'household' && tier !== 'family') {
  return 'none';
}
```

`SENSITIVE_CLASSES` is `health, medical, financial, finance, secrets, credentials, location`
(`policy.ts:77-85`). For a housemate, none of them are sensitive. **The task brief describes
`household` as the one tier exempt from the floor; the code exempts `family` too.** That is
worth correcting in every downstream discussion: two tiers are exempt, and one of them can
be assigned to a remote box.

**There is no way to demote a housemate.** `PEER_TRUST_TIERS` deliberately excludes
`household` (`PeerLinkEntity.ts:34`, with a compile-time proof at `:51-59` that it stays
excluded), and a local asker has no peer link at all — so there is no row, no column and no
mutation that could store "this housemate is only `trusted`". The tier is a `return`
statement.

**The only private lever is a `block` grant, and it is unreachable from the UI.** A block
grant *is* genuinely private — the asker cannot distinguish `declined` from `pending`
(`AskType.ts:193-195`) or read the responder's clock (`AskType.ts:228-230`), and
`createAsk` returns the constant `ASK_ACCEPTED` (`AskResolver.ts:99`). That is exactly the
property a coerced owner needs. But `frontend/apps/web/src/pages/AsksPage/asksOperations.ts`
defines only `ASK_INBOX`, `ASK_OUTBOX`, `MY_ASK_GRANTS`, `APPROVE_ASK`, `DECLINE_ASK`,
`RUN_ASK`, `REVOKE_ASK_GRANT`. **There is no `CREATE_ASK_GRANT` document**, and
`GrantManager` prints "Changing a grant's mode isn't available yet" (`GrantManager.tsx:82`).
So the one safe control is API-only. *(Step 1 of this review is adding surface; re-check
this paragraph against the composer agent's PR before quoting it.)*

**Revocation is not private in the way that matters.** `GrantService.revoke` →
`withdrawPreAuthorization` (`GrantService.ts:299-321`) pushes pre-authorized asks back into
review and clears the basis. The *asker's* API view stays flat. But the abuser is in the
room: what changes is that answers stop arriving. Silence is the signal. Software cannot
make that invisible, and it should not pretend to.

**No cooling period, no re-consent, no expiry by default.** `AskGrantEntity.mode` defaults
to `review` (`AskGrantEntity.ts:47`) — good — but `expiresAt` is nullable with no default
and `CreateAskGrantInput` has no `expiresAt` field at all (`AskInputs.ts:122-126`, which
says so in a comment). A grant written under duress is permanent until someone remembers to
revoke it. `GrantManager` prints the caveat that no expiry date is on the wire
(`AsksPage.tsx:190`).

### Design gap or code bug

**Design gap.** And a *tested* one — `policy.spec.ts:37-38, 95, 112-113` assert the current
behaviour deliberately. This is a decision someone made, not an accident.

### Mutation evidence

I removed `tier !== 'household'` from `policy.ts:160` (leaving `family` exempt) and ran
`src/domains/asks` and `src/domains/graphql`: **544 passed, 10 skipped, 0 failed.** The
household half of the sensitive-class exemption is pinned by **nothing**. Two conclusions:
it is the fifth unpinned guarantee in this feature, and the cheapest mitigation below has
zero test blast radius.

(For contrast, removing the `family` exemption too *does* go red — `policy.spec.ts:105` and
the "per-class entry may only tighten" test both fail.)

### Proposals, cheapest first

| # | Change | Cost | Effect |
|---|---|---|---|
| 1 | **Stop exempting `household` from the sensitive-class floor.** Delete `tier !== 'household' &&` at `policy.ts:160`. Health, financial, location and credentials asks from a housemate route to owner review instead of auto-disclosing at `full`. | One line + one test | Removes the single widest automatic disclosure in the product. Zero current tests break; add one that fails when the clause returns |
| 2 | **Give `household` a real ceiling.** `household: { '*': 'full' }` → `{ '*': 'redacted', location: 'summary' }` or similar. A housemate stops receiving withheld-counts. | One line + `policy.spec.ts` | Makes "household" a tier rather than a bypass |
| 3 | **Default every new grant to an expiry.** Add `expiresAt` to `CreateAskGrantInput` (the comment at `AskInputs.ts:122` already says the wiring is one line) and default it to 30 days. | Small | A grant given under pressure lapses on its own. This is the single highest-value coercion mitigation because it needs no courage to trigger |
| 4 | **Make the block grant reachable, and name it in the owner's language.** A `CREATE_ASK_GRANT` document plus a "Never answer X about Y" control in `GrantManager`. | Medium | Turns the one already-private lever into one a frightened person can actually use |
| 5 | **Per-local-user tier.** A `ci.household_members` row (or a tier column on `ci.users`) so `resolveTier` reads a stored value instead of returning a constant, and a UI to set it. Note `PEER_TRUST_TIERS` must stay as it is — the fix is a *local* tier source, not widening the peer CHECK. | Large | The structural fix. Without it, propositions 1–4 are all patches on a `return 'household'` |
| 6 | **Quiet mode.** An owner-set posture in which every ask from a chosen person is auto-declined and the decline is indistinguishable from an ordinary non-answer, with no UI trace on the shared box. | Large, and needs a safety review, not just an engineering one | The only thing on this list that helps someone who cannot safely be seen to refuse |

### Inherent?

**Partly.** A shared appliance means a shared physical context, and no consent dialog can
defend against a person standing behind the owner. Software can reduce what a coerced tap
discloses (1, 2), reduce how long coercion persists (3), and make refusal cheap and private
(4, 6) — it cannot eliminate the threat. **The honest product statement is: the Asks
feature is not safe to enable by default on an appliance shared by people in an unequal
relationship, and we do not currently detect that situation or ask about it.**

---

## 3. T2 — Stalking via availability

### The threat

Free/busy, repeated, is a **presence log**. One answer is "are you free Friday?". Ninety
answers, one a day for three months, are: when you are home, when you leave, when you sleep,
which evenings changed after you started seeing someone, and which week you travelled.
Nothing in any single answer is sensitive. The series is.

### Who it hurts

Anyone whose location-in-time is the thing an adversary wants — an ex-partner, a stalker,
someone under surveillance by family. Also, more mundanely, anyone whose employer or
landlord is a `trusted` peer.

### What the code does today

Availability is the archetype the design deliberately made auto-answerable. From
[`peer-federation.md:54`](peer-federation.md): *"Because the output is provably free/busy
only, an availability ask is **safe to auto-answer under a standing grant** — no human
interruption."* `computeFreeBusy` earns that claim on the axis it is arguing about: output
is boundaries only, and overlapping blocks are merged so the meeting count is destroyed
(`availability.ts:17-34, 82-94`).

**The argument is about shape, and the risk is about series.** The code even says this to
itself, one level up: *"'interval boundaries only' is a statement about the SHAPE of the
disclosure, not its size"* (`PeerAskService.ts:379-381`). That sentence is correct and it
stops one step short — it is also not a statement about *frequency*.

**`calendar` is not in `SENSITIVE_CLASSES`; `location` is.** `toAskQuery` stamps
`dataClass: 'calendar'` on every availability ask (`PeerAskService.ts:851`), and
`SENSITIVE_CLASSES` (`policy.ts:77-85`) does not contain it. So availability takes the
tier's `'*'` fallback:

| Tier | Ceiling for `calendar` | What `clampAvailability` returns (`PeerAskService.ts:749-803`) |
|---|---|---|
| `household` | `full` | Real busy + free intervals |
| `family` | `full` | **Real busy + free intervals** |
| `trusted` | `redacted` | **Real busy + free intervals** — `redacted` and `full` are the same branch (`:758-765`) |
| `peer` | `summary` | Slot count + longest gap, no instants |
| `stranger` | `boolean` | "some free time" / "no free time" |

**So `redacted` is not a redaction for this archetype.** The one rung that sits between
"everything" and "a sentence" degrades to "everything". That is *documented* at
`PeerAskService.ts:731` — `full / redacted — the busy and free intervals, as computed` — so
it is deliberate; but it means the `trusted` tier, whose whole point in `TIER_CEILINGS` is
that it does not hand over item-level detail, hands over the owner's literal calendar
boundaries.

**Volume.** `boundedWindow` caps a window at 31 days (`PeerAskService.ts:809`) and
`MAX_AVAILABILITY_EVENTS` at 2000 rows (`:806`) — both real bounds on one ask. The inbound
limit is 10 asks per minute per `(issuer, subject)` (`PeerRateLimitService.ts:10-11`). That
is **14 400 availability asks a day**, each of which may cover a distinct 31-day window and
each of which is auto-answered with no human in the loop when a standing `auto` grant
exists. Replays are cheap and are correctly *not* re-executed (`PeerAskService.ts:95-108`),
but a fresh `askId` with a shifted window is a fresh execution every time.

**Nothing tells the owner it is happening.** Every availability answer *is* audited —
`persistDisclosure` now writes an `ask_answers` row and the backing event ids
(`PeerAskService.ts:421-467`), which was itself a fix. And `askDisclosureHistory` exists on
the API (`AskResolver.ts:586-595`). But **no frontend document queries it**: the only
mention of `AskAuditType` in `frontend/` is in generated `graphql.ts`. There is no
notification, no digest, no rate-of-asking signal. The owner cannot see the series that is
the entire threat.

### Design gap or code bug

**Design gap** on the classification and on the auto-answer decision. **Latent code bug**
in the `redacted` case, in the sense that a rung named "redacted" that redacts nothing is
the same class of defect `applyDisclosureCeiling` fixed for the item path
(`policy.ts:224-243`: *"A rung that clamps nothing is not a rung; it is a label the owner
can pick believing it does something."*) — the identical argument was not applied here.

### Mutation evidence

I changed `clampAvailability`'s `case 'redacted'` to drop the intervals and ran
`src/domains/peers`: **2 tests failed** —
`PeerAskService.handle › answers an availability ask from the calendar without touching the search index`
and `the audit records the MAGNITUDE that crossed › forwards it on the availability branch too`.
So the behaviour *is* pinned, but only **incidentally**: the shared `link()` fixture happens
to default to `trustTier: 'trusted'` (`PeerAskService.spec.ts:22`). The test that exists to
assert the ceiling deliberately — `still gives a trusted peer the actual intervals` at
`PeerAskService.spec.ts:519` — passes `trustTier: 'family'`, so **its title and its fixture
disagree**. Anyone reading the suite to learn what `trusted` receives is misled. Restored;
worktree verified clean.

### Is free/busy under-classified? Yes.

Argued directly, because the brief asks for a position rather than a survey:

1. **`location` is in `SENSITIVE_CLASSES` because knowing where someone is is dangerous.**
   Free/busy over a repeated window is a lower-resolution *encoding of the same fact*. If
   `location` is sensitive, a time series that reconstructs presence is sensitive by the
   same argument, one bit coarser.
2. **Merging destroys the meeting count, not the routine.** The property `computeFreeBusy`
   actually establishes is "you cannot tell how many meetings". Nobody stalking someone
   cares how many meetings. They care *when the pattern breaks*.
3. **It is the only archetype that discloses raw instants.** Every other answer path is
   counts, yes/no, opaque ids and templated sentences. Availability is the exception, and
   it is also the only one that is auto-answered by design. The most precise disclosure and
   the least supervised disclosure are the same one.
4. **The counter-argument is real and should be stated.** Auto-answered free/busy is the
   product unlock — two assistants finding a lunch slot without a human in the loop
   (`peer-federation.md:54`). Classifying `calendar` as sensitive caps it at `none` below
   `family` and retires that unlock outright. So the answer is *not* to add `calendar` to
   `SENSITIVE_CLASSES`. It is to bound the series instead of the shape.

### Proposals, cheapest first

| # | Change | Cost | Effect |
|---|---|---|---|
| 1 | **Make `redacted` mean something for availability.** Give `case 'redacted'` its own branch that returns busy intervals only, or free intervals rounded to the hour, rather than sharing `full`. | One branch + a test that asserts intervals at `full` and not at `redacted` | Restores the missing rung and demotes `trusted` out of full-fidelity |
| 2 | **Fix the misleading fixture.** `PeerAskService.spec.ts:519` should pass `trustTier: 'trusted'` to match its title, or be retitled. | Trivial | Stops the suite documenting the wrong thing |
| 3 | **Quantize the boundaries.** Round every returned instant outward to a 15- or 30-minute grid before it crosses. Lunch scheduling survives; "you left at 07:12 and returned at 19:48" does not. | Small, pure function | Kills the highest-resolution half of the signal at almost no product cost |
| 4 | **A separate, much tighter budget for availability.** Not 10/min. Something like *N distinct query-days per peer per rolling week*, counted over the union of requested windows, not over request count. | Medium — needs the durable counter from T5 | Directly bounds the series, which is the actual threat |
| 5 | **Surface the history.** Wire `askDisclosureHistory` into `AsksPage`, grouped by asker, with a rate line: "Devon has asked about your availability 47 times in 30 days." | Medium (frontend) | The single most valuable detection control in this document. A presence log is only invisible because nobody is shown it |
| 6 | **Break auto-answer on anomaly.** When one peer's availability rate exceeds a threshold, stop auto-answering and put the *pattern* in front of the owner once — not each ask. | Medium | Converts an invisible series into one legible decision |

### Inherent?

**Yes, partially, and it must be said.** A product whose selling point is "your assistant
can answer 'are you free Friday?' without waking you" has, by construction, granted a
counterparty a repeatable presence query. The residual risk cannot be removed while the
feature exists; it can be quantized (3), bounded (4) and made visible (5). **Anything that
claims to eliminate it is claiming to disable the feature.**

---

## 4. T3 — Social engineering and impersonation at the consent moment

### The threat

The consent card is the last line of defence, and the asker writes part of it. Free text
authored by the asker renders directly above the button that discloses. Classic content:
manufactured urgency ("Mum's in hospital, I need the photos from the folder now"), false
authority ("Automated integrity check — approving this confirms your backup"), or a claim
about the system itself ("Approving only shares a yes/no").

### Who it hurts

Everyone, and disproportionately anyone under time pressure, cognitively impaired, or
unfamiliar with the vocabulary of disclosure rungs.

### What the code does today

**The card renders the asker's prompt, then the Approve button.**

```tsx
// frontend/apps/web/src/pages/AsksPage/AskReviewCard.tsx:104
<p className="text-muted-foreground mt-1 text-sm">“{prompt}”</p>
...
// :174
<Button onClick={onApprove} disabled={busy}>{shareLabel}</Button>
```

The prompt comes straight from `ask.query.prompt` (`AsksPage.tsx:161`). React escapes it,
so this is **not** an XSS or markup-injection issue. It is a *persuasion* surface. Unicode
bidi controls, homoglyphs and confusable scripts pass through untouched.

**On the federated path the prompt is bounded to 500 characters** (`protocol.ts:104`).
**On the local path it is not bounded at all:**

```ts
// backend/apps/api/src/domains/graphql/types/AskInputs.ts:29-38
@InputType()
export class AskQueryInput {
  @Field(() => String) queryType!: string;
  @Field(() => String, { nullable: true }) dataClass?: string;
  @Field(() => String) prompt!: string;   // no @MaxLength, no validator
}
```

There is **no global `ValidationPipe`** (`main.ts` registers none), no class-validator
decorators on these inputs, and the GraphQL body limit is `10mb`
(`BodyParserMiddleware.ts:19, 92`). So a local asker may send a multi-megabyte `prompt`,
which is stored in `ci.asks.query` jsonb, rendered in the owner's inbox card as a single
`<p>`, replayed in every audit row, and handed to `websearch_to_tsquery`.

**The DCQL grammar that would have bounded it is not on the path.** `askGrammar.ts` defines
a strict, bounded, `.strict()` schema with `prompt: z.string().min(1).max(500)`
(`askGrammar.ts:101-110`) and a documented "everything here is hostile input" contract
(`:19-21`). It is exported from `domains/asks/index.ts:98-101` and **imported by nothing**.
`parseAskGrammar` has zero callers outside its own spec.

**What the card gets right, and it is a lot.** `askBinding.ts` is one of the most honest
files in the repo. `knownAskerLabel` refuses to invent a tier and returns only the two-value
fact the wire supports (`:71-73`). `partyLabel` never invents a name, and `idFragment`
deliberately keeps the leading `_`/`-` so a truncated id does not read as a person's name
(`:27-46`). `searchBreadthNote` states the *ceiling* on breadth rather than mirroring the
backend's hint table, and explains at `:94-120` exactly why a mirrored copy would be worse.
`AsksPage.tsx:33-51` refuses to render `AnswerCard` at all because the wire cannot say
whether a human reviewed the answer. This card is not naive. Its remaining weakness is
specifically that **it treats the asker's sentence as context rather than as a claim**.

**Impersonation is genuinely well handled at the identity layer.** `askerHandle` is on the
wire (`protocol.ts:102`) and is **read by nothing** on the responder side — attribution is
`(iss,sub)` → peer link → `link.peerHandle`, i.e. a value the *owner* wrote when they linked
(`PeerLinkService.ts:55-65`). A peer cannot self-assert a display name into the owner's UI.
That is the right design and it should be preserved explicitly, because the field's presence
invites a future "well, we may as well show it".

### Design gap or code bug

The unbounded local `prompt` is a **code bug** (a validation gap with a DoS and
UI-flooding edge). The absence of any framing or attestation on the consent card is a
**design gap**.

### Proposals, cheapest first

| # | Change | Cost | Effect |
|---|---|---|---|
| 1 | **Bound the local prompt.** Add `@MaxLength(500)` + `@IsString()` to `AskQueryInput` and a `ValidationPipe` on the ask mutations (or validate in `AskService.submit`), matching `protocol.ts:104` and `askGrammar.ts:104`. Pin with a test that sends 501 characters and expects a 400. | Small | Closes the 10 MB path. Three files already agree on 500; a fourth should not disagree |
| 2 | **Strip and neutralize the prompt at render.** Reject or strip Unicode bidi controls and zero-width characters; render in a `text-muted-foreground` block that is visually *quoted*, which the card already does (`:104`), and clamp to a few lines with an expander. | Small | Removes the "wall of text pushes the real scope off-screen" variant |
| 3 | **Label it as the asker's words, in the UI, not just in a code comment.** The prop is already documented as *"The question, in the asker's own words"* (`AskReviewCard.tsx:28`). Say that on screen: a small "Their words — not checked by your Companion" line above the quote. | Small | Turns an implicit frame into an explicit one. This is the cheapest control in the whole document |
| 4 | **Put the machine-derived facts *below* the human text and give them visual priority.** The card already renders `scopeSummary` + `searchBreadth` in a `bg-muted` block (`:112-115`); make that block, not the prompt, the visually dominant element. | Small (CSS + order) | The owner's eye should land on what the box knows, not on what the asker wrote |
| 5 | **Friction proportional to disclosure.** A `full`-rung retrieval approval gets a confirm step; a `boolean` does not. | Medium | Urgency-based social engineering works by making the tap feel cheap |
| 6 | **Never render `askerHandle`, and pin it.** A test asserting the field is not read by `PeerAskService` would keep the current, correct behaviour from eroding. | Trivial | Preserves the one impersonation defence that already works |

### Inherent?

**Partly.** The asker must be able to say what they want, or the feature is unusable — so
attacker-authored text next to a consent control is intrinsic. What is *not* intrinsic is
letting it be unbounded, unframed, or visually dominant over the facts the box derived
itself.

---

## 5. T4 — Prompt injection into the owner's archive

### The threat

If asker-supplied text reached a model running on the responder's box with retrieval over
the owner's memory, the asker would control tokens in a prompt executing against the whole
archive. Every disclosure control in this document is enforced *around* the query, not
inside a model's reasoning, so a model that can be steered is a complete bypass.

### The trace

I traced every path from asker-controlled input to any model on the responder's box.
**There is none today.** In full, so it can be re-checked:

1. **Asker-controlled fields.** Federated: `askId`, `askerHandle`, `prompt`, and the
   archetype body — `subject`, `dataClass`, `from`, `to`, `minMinutes`, `purpose`
   (`protocol.ts:31-111`). Local: `responderId`, `queryType`, `dataClass`, `prompt`
   (`AskInputs.ts:29-48`).
2. **Where they land.** `toAskQuery` maps them into `AskQuery`
   (`PeerAskService.ts:837-855`) which is stored in `ci.asks.query` jsonb
   (`AskService.ts:141`). `askerHandle` is dropped — no consumer.
3. **Consent.** `evaluateGrant` compares canonicalized strings only
   (`grantMatch.ts:32-74`, `canonical.ts`). No model.
4. **Execution.** `AskExecutorService.execute` is the only thing that touches the archive:

   ```ts
   // backend/apps/api/src/domains/asks/services/AskExecutorService.ts:65-73
   const base = {
     query: ask.query.prompt,
     mode: 'keyword' as const, // keyword only: deterministic, no embedding side effects
     maxResults: options.maxResults ?? 50,
   };
   ```

5. **`SearchService.search` dispatches strictly on the requested mode**
   (`SearchService.ts:98-119`); `'keyword'` → `keywordSearch`, which is a parameterized
   `tsquery` against `ci_search.vectors` (`:373-398`). No `EmbeddingGenerationService` call
   on that branch. The three modes that *do* embed — `semantic`, `boosted`, `hybrid` — and
   the `auto` selector that can choose them (`:203-225`) are never reached from an ask.
6. **Availability** never touches search at all: it reads `ci.events` directly and runs the
   pure `computeFreeBusy` (`PeerAskService.ts:393-418`).
7. **Answer synthesis is a `switch`,** not a generation (`disclosure.ts:120-135`,
   `countFreeSummary` at `:95-113`, `summarizeAvailability` at `availability.ts:119-137`).
8. **No cron, listener or downstream consumer sees ask text.** `domains/asks` and
   `domains/peers` import from `@ci/common/*`, `@ci/configuration`, `@ci/domains/asks`,
   `@ci/domains/auth`, `@ci/domains/memory`, `@ci/domains/search-next`, `@ci/domains/user` —
   and **not** from `@ci/domains/llm` or `@ci/domains/personalization`. Neither domain calls
   `emit(`. `AskEntity` / `AskAnswerEntity` are referenced nowhere outside
   `asks`, `peers` and `graphql`. `'ask'` is not in `INDEXABLE_ENTITIES`
   (`search-next/types.ts:1-26`), so ask text is never embedded into `ci_search.embeddings`
   and cannot be retrieved into any other prompt.

**Conclusion: I traced it and found none.** Asker text reaches Postgres full-text search
and the owner's screen. It reaches no model.

### Tripwires — the exact changes that would create this threat

This section exists so the "none" above has a shelf life.

1. **Changing `mode` in `AskExecutorService.ts:67`** from `'keyword'` to `'auto'`,
   `'semantic'`, `'boosted'` or `'hybrid'` sends the asker's prompt to
   `EmbeddingGenerationService.generateEmbeddingString` (`SearchService.ts:151, 315, 421`),
   i.e. to the embedding model on the owner's box. Embedding is not generation and is not
   directly steerable, but it is the first model in the chain and it changes the security
   argument. *Currently pinned:* `AskExecutorService.spec.ts:36, 48, 59` all assert
   `mode: 'keyword'`. **Keep those tests.**
2. **Replacing `buildSummary` with an LLM.** `disclosure.ts:116-118` says out loud that
   this is a planned follow-up: *"Replacing this with an LLM-synthesized natural-language
   answer (completing the answer-inference RAG path) is a follow-up."* That change would put
   the asker's `prompt` and the owner's matched content in one context window. **This is the
   single highest-risk planned change in the feature and it must not land without its own
   threat-model amendment.**
3. **Resolving item labels.** `askBinding.ts:132-141` notes a real label needs the backend
   to resolve the entity. If that resolution goes through a summarizer, same problem.
4. **Indexing asks.** Adding `'ask'` to `INDEXABLE_ENTITIES`, or writing ask prompts into
   `ci.notes` / `ci.messages` for any reason, makes asker text retrievable into *every*
   future prompt on the box — including ones with nothing to do with asks.

### Proposals

| # | Change | Cost | Effect |
|---|---|---|---|
| 1 | **Write the tripwires down where the code is,** as a comment on `AskExecutorService.execute` naming this document. | Trivial | The trace above is only useful if the next author finds it |
| 2 | **Add an architecture test** asserting `domains/asks` and `domains/peers` do not import `@ci/domains/llm` or `@ci/domains/personalization`. `.dependency-cruiser.mjs` already exists and already enforces domain rules. | Small | Turns "no path today" into "no path, enforced" |
| 3 | **Decide the RAG-summary question before building it.** If an LLM ever writes the answer, the asker's text must not enter its context — the model may see the *matched content* and a *structured, box-authored* description of the request, never the asker's sentence. | Design decision | The only shape of that feature that survives this threat model |

### Inherent?

**No.** This one is fully avoidable and is currently avoided. It becomes inherent only if
the product decides an ask must be answered in natural language.

---

## 6. T5 — Cumulative disclosure

### The threat

A patient asker with one narrow, legitimately-granted permission reconstructs a dataset by
asking many individually-legitimate questions. No single ask violates anything. The union
does. This is the classic statistical-disclosure problem, and it is the threat that
rate limits *look* like they address and do not.

### Who it hurts

Anyone with a long-lived `auto` grant. The damage is proportional to patience, so it hurts
most in exactly the relationships that last: family, ex-partners, employers.

### What the code does today

**Rate limits bound rate, and are per-process and in-memory.**

- Local: 20 asks per rolling minute per asker (`AskRateLimitService.ts:8-9`), state in a
  `Map` (`:19`).
- Inbound peer: 10 asks/min plus a separate 30 polls/min per `(issuer, subject)`
  (`PeerRateLimitService.ts:10-11, 29`), also a `Map` (`:46`). Both files say so: *"a shared
  store can back it when the ask path goes multi-instance"*.

So the ceiling is **28 800 local asks and 14 400 peer asks per day**, and it resets on
restart.

**There is no total.** Grepping `domains/asks` and `domains/peers` for `budget`, `quota`,
`cumulative` returns only the rate-limiter's own comments. `AskAuditService.listForResponder`
(`AskAuditService.ts:63-70`) reads every row with no aggregation. The audit **has the data
to compute a budget** — `disclosed_entities`, `disclosed_count`, `backing_entities`,
`consent_basis`, `peer_handle` (`AskAuditEntity.ts:18-80`) — and nothing consumes it.

**Each ask is broader than it reads.** `maxResults` is 50 per ask
(`AskExecutorService.ts:68`); an unknown or absent `dataClass` yields `includeTypes:
undefined`, i.e. an unfiltered search over every indexed type (`:89-92`, and the card says
so honestly at `askBinding.ts:121-129`); and `keywordSearch` rewrites the AND-joined
`websearch_to_tsquery` into an **OR** (`SearchService.ts:373-375`), so a six-word prompt
matches anything containing any one of the six terms.

**Grants are not consumed by use.** `isGrantActive` checks `revokedAt` and `expiresAt`
(`grantMatch.ts:189-195`) — there is no third dimension.

**Two real partial mitigations, worth crediting.** The replay/idempotency work means a
repeated `askId` never re-executes (`PeerAskService.ts:95-108`), so an asker cannot amplify
by resending. And the local `auto` path now requires **both** the grant and the ask to name
a data class (`grantMatch.ts:266-272`), which retired the "class-less auto grant plus
class-less ask = standing unreviewed keyword oracle over the whole corpus" case described at
`grantMatch.ts:240-245`. Cumulative disclosure through an `auto` grant is therefore confined
to a named class — but unbounded *within* it.

### Design gap or code bug

**Design gap**, and an acknowledged one: `AskRateLimitService.ts:12` calls itself *"a first
abuse control"*.

### Sketch: what a cumulative disclosure budget would look like

A budget must be **durable**, **per-relationship**, **denominated in disclosure rather than
in requests**, and **fail closed by downgrading, not by erroring** — an error is an oracle,
and this feature has spent a lot of effort not building oracles.

**Unit.** Not "asks". Something monotone in what was actually learned. The audit already
records the right number: `disclosed_count` is post-ceiling
(`AskResolver.ts:252-253` writes `answer.items`, not the candidate set — the pre-ceiling
count lives separately under `backingEntities`, a distinction the code fought for). Proposed
unit: **disclosure points**, charged per answered ask as
`w(rung) × max(1, disclosedCount)`, with `w(none)=0`, `w(boolean)=1`, `w(count)=2`,
`w(summary)=3`, `w(redacted)=5`, `w(full)=8`. Availability charges on **distinct query-days
covered**, not slots — the union of requested windows is the thing that reconstructs a
routine.

**Scope.** Keyed on `(responderUserId, granteeUserId | granteePeerLinkId, dataClass)`, over
a rolling 30-day window. Per-class matters: exhausting the photos budget must not stop
scheduling.

**Storage.** A table, not a `Map` — a budget that resets on deploy is not a budget.
`ci.ask_disclosure_budget(owner_user_id, grantee_key, data_class, window_start, spent)`,
incremented in the **same transaction** as the answer. `completeWithAnswer` already runs the
answer and audit in one transaction precisely so neither can exist without the other
(`AskService.ts:276+`, `AskResolver.ts:256-270`); the budget belongs inside that boundary
for the same reason.

**Enforcement — downgrade, do not refuse.**

- Under 60% of budget: no change.
- 60–100%: fold a `summary` ceiling into the existing combination. `narrowestRung`
  (`policy.ts:57-70`) already exists to combine independent ceilings and already documents
  that a source saying nothing must not erase one that does — a budget ceiling is a fourth
  source and slots in beside the tier, the grant, and the consent-time stamp with no new
  mechanism.
- Over budget: `auto` decisions become `review`. **Not `deny`** — the owner still decides,
  and the asker's view is unchanged, because a distinguishable "budget exhausted" is a
  precise readout of how much the owner has disclosed. Same argument as
  `PeerAskService.ts:196-200` for revoked grants.
- The owner sees the budget in the Grant Manager: *"Devon has used 340 of 500 photo
  disclosures this month"*, with a reset control.

**Why downgrade and not throttle.** Throttling produces a timing channel, and this codebase
has already closed one (`AskType.ts:201-212`). Downgrading changes the *content* of the
answer, which the asker cannot distinguish from the owner having less to share.

### Proposals, cheapest first

| # | Change | Cost | Effect |
|---|---|---|---|
| 1 | **Show the totals.** Wire `askDisclosureHistory` into `AsksPage` with a per-asker rollup. No enforcement, no schema. | Medium (frontend only) | The owner can see accumulation. Most cumulative-disclosure harm is invisible, not unstoppable |
| 2 | **Move the rate limiters to a durable store** so they survive restart and multi-instance. Both files already name this as the next step. | Medium | Makes the *existing* control real before adding a new one |
| 3 | **Grant-level use caps.** A `scope.maxAnswers` on `AskGrantEntity.scope`, checked in `isGrantActive`'s callers. Far simpler than a full budget and expressible in the owner's language ("50 answers, then ask me again"). | Medium | 80% of the value of the budget for 20% of the work |
| 4 | **The full budget above.** | Large | The complete answer |

### Inherent?

**Yes, in the mathematical sense.** Any system that answers truthfully leaks monotonically;
a sufficiently patient adversary with a standing permission reconstructs the underlying set.
It can be **priced** (a budget), **slowed** (rate limits), and **made visible** (history) —
never eliminated, short of not answering. **What is not acceptable is the current state,
where the total is neither bounded nor shown.**

---

## 7. T6 — Vulnerable users and the default tier

### The threat

Defaults are the product for most users. Whatever a person gets by doing nothing is what
most people will have forever — and the people least likely to change a default are exactly
those with the least capacity to reason about disclosure rungs: elders, people in crisis,
people who did not choose this appliance.

### What the code does today — the good half

The peer-facing defaults are genuinely conservative and each is deliberate:

- **Review is the floor.** No matching grant → `review`, never implicit access
  (`grantMatch.ts:13-19, 73`). `AskGrantEntity.mode` defaults to `'review'`
  (`AskGrantEntity.ts:47`); `GrantManager` renders `defaultMode="review"` (`AsksPage.tsx:186`).
- **A new peer link is `peer`,** ceiling `summary` (`PeerLinkService.ts:65`,
  `PeerLinkEntity.ts:100`, `policy.ts:104`).
- **A missing or revoked link is `stranger`,** not a wider fallback
  (`AskResolver.ts:749`), and an unknown tier falls back to `stranger` too
  (`policy.ts:152`).
- **Federation is off unless an operator binds `peers.audience`**
  (`PeerAskController.ts:35-37`), independently of the feature flag.
- **Blocks beat auto; nulls resolve toward denial on both sides**
  (`grantMatch.ts:39-47, 206-252`).

For an ordinary user linking an ordinary peer, the defaults are right.

### What the code does today — the bad half

- **The feature is on by default.** `config/default.json:219` sets `"ask": true`, and
  `configuration.ts:686-698` explains the reasoning: the consent gate, disclosure filter,
  tier ceilings and per-item redaction are all in place. That reasoning covers the
  *federated* surface, whose defaults are conservative. It does **not** cover the local
  surface, whose default tier is `household` = no ceiling at all (T1). **The local ask
  surface is live out of the box on every multi-account appliance.**
- **The safest tier is unreachable.** `stranger` — the right posture for "someone I have
  not decided about" — cannot be assigned to a local user, because local users have no tier
  to assign (T1).
- **The card cannot say what tier anyone is.** `knownAskerLabel` returns only
  "known contact" / "no standing grant" (`askBinding.ts:71-73`), correctly, because no tier
  reaches the client. So the owner approving an ask **cannot see whether this asker is
  capped at `full`, `summary` or `boolean`** — the single most decision-relevant fact about
  the ask is absent from the consent surface. That is not dishonesty; the client refuses to
  invent it. It is a missing field on the wire.
- **No expiry by default** (T1), and no expiry date shown even when one exists
  (`AsksPage.tsx:190`).
- **Nothing is worded for a person in difficulty.** The vocabulary is
  `none/boolean/count/summary/redacted/full` and `auto/review/block`. `answerFormLabel` and
  `askDecisionNote` (`askPresentation.ts`) do translate, and the downgrade row is
  deliberately as prominent as Approve (`AskReviewCard.tsx:51-58, 149-171`) — genuinely
  good. But there is no path anywhere that says "someone is pressuring me" or "make my box
  answer nothing to anyone for a while".

### Design gap or code bug

**Design gap** throughout.

### Proposals, cheapest first

| # | Change | Cost | Effect |
|---|---|---|---|
| 1 | **Put the tier on the wire and on the card.** Add `tier` to `AskType`, resolved by the same `resolveTier` the answer path uses, and render it in place of `knownAskerLabel`'s two-value fact. `askBinding.ts:62-73` already says this is what it wants. | Small | The owner can finally see how much this asker's approval costs |
| 2 | **Default new grants to 30 days** (same change as T1 #3). | Small | Consent decays unless renewed |
| 3 | **Reconsider the default for the local surface.** Either ship `ask: false` until `household` has a ceiling, or land T1 #1 and #2 first and keep it on. Shipping a no-ceiling tier on by default is the riskiest single line in the feature. | One line, large decision | See "Owner decisions" below |
| 4 | **A global pause.** One control: "Don't answer anyone for now." Every ask queues; nothing auto-answers; the asker's view is unchanged. | Small–medium | The control a person in crisis actually needs, and the only one on this list that requires no vocabulary |
| 5 | **Safety-reviewed onboarding.** When more than one account exists on a box, ask once, in plain language, whether asks between accounts should be allowed — and default to no. | Medium | Puts the T1 question to the person before the situation, not after |

### Inherent?

**No.** Defaults are a choice. Everything in this section is a decision that can be made
differently at low cost.

---

## 8. Cross-cutting: the feature has no detection story

Named separately because it is the multiplier on T1, T2 and T5.

Prevention in this feature is strong; **detection is absent**. There is:

- no notification when a standing grant auto-answers something;
- no periodic digest of what was disclosed;
- no UI for `askDisclosureHistory`, though the query exists (`AskResolver.ts:586-595`) and
  the audit rows are rich (`AskAuditEntity.ts:18-80`);
- no rate or anomaly signal anywhere.

The consequence: **the disclosures the owner never sees are exactly the ones a standing
grant released** — which is to say, the automated ones, which is to say, the ones an
adversary would prefer. An owner reviewing each ask sees each ask. An owner who wrote one
convenient `auto` grant sees nothing, forever.

Wiring `askDisclosureHistory` into `AsksPage` is the highest value-per-line change in this
entire document. It requires no schema, no policy decision and no new backend.

---

## 9. What is inherent, stated plainly

| Threat | Inherent? | The irreducible part |
|---|---|---|
| T1 Coercion | **Partly** | A shared appliance means shared physical context. No consent UI defends against a person in the room. Mitigable (ceilings, expiry, private block, quiet mode); not eliminable |
| T2 Stalking via availability | **Yes, partly** | "Answer 'are you free?' without waking me" *is* a repeatable presence query. Quantize, budget and surface it; you cannot remove it and keep the feature |
| T3 Social engineering | **Partly** | The asker must be able to say what they want. Bound it, frame it, subordinate it — it stays attacker-authored text beside a consent control |
| T4 Prompt injection | **No** | Fully avoidable, currently avoided. Becomes inherent only if answers are generated rather than templated |
| T5 Cumulative disclosure | **Yes** | Truthful answering leaks monotonically. Price it, slow it, show it — never zero |
| T6 Defaults | **No** | Entirely a choice |

---

## 10. Code defects found, with proposed fixes

Documented here per the working agreement for this PR; **none are implemented in it**.

| # | Location | Defect | Proposed fix |
|---|---|---|---|
| D1 | `backend/apps/api/src/domains/graphql/types/AskInputs.ts:37` | `AskQueryInput.prompt` has no length bound; there is no global `ValidationPipe` (`main.ts`), so the GraphQL body limit of `10mb` (`BodyParserMiddleware.ts:19`) is the only cap. The federated path bounds the same field to 500 (`protocol.ts:104`), as does `askGrammar.ts:104`. | `@MaxLength(500)` + `@IsString()` and a `ValidationPipe` on the ask mutations, or an explicit check in `AskService.submit`. Pin with a 501-character test expecting a 400 |
| D2 | `backend/apps/api/src/domains/peers/services/PeerAskService.ts` | ~~`clampAvailability` treats `redacted` identically to `full`, so the `trusted` tier's `redacted` ceiling discloses the owner's real calendar boundaries.~~ **FIXED** (CI-Server #2367). `redacted` has its own branch: the busy intervals are dropped entirely and the free slots are coarsened to a half-hour grid, shrinking inward so a coarsened slot is always a subset of a real one. The summary is recomputed from the coarsened set so it cannot state a count the arrays contradict, and `disclosedCount` reports the slots that survived quantization rather than the pre-clamp total. Pinned by five tests plus a ladder-monotonicity check that measures each rung's information content by differential (does the output distinguish two calendars differing in exactly one property) rather than by inspecting strings — all six fail when the fix is reverted |
| D3 | `backend/apps/api/src/domains/peers/services/PeerAskService.spec.ts` | ~~The test titled *"still gives a trusted peer the actual intervals"* passes `trustTier: 'family'`.~~ **FIXED** (CI-Server #2367). Retitled to name `family`, and a real `trusted` case added — which matters now that the two tiers genuinely differ, since `trusted`'s calendar ceiling is the `redacted` rung D2 was about. One further test (*"answers an availability ask from the calendar without touching the search index"*) was silently relying on the fixture's `trusted` default to assert unclamped intervals; it is now explicitly pinned to a `family` link, because it tests the SOURCE of an availability answer rather than its rung |
| D4 | `backend/apps/api/src/domains/asks/askGrammar.ts` (whole file) | The bounded, `.strict()`, "everything here is hostile input" DCQL grammar is exported (`asks/index.ts:98-101`) and called by nothing. `parseAskGrammar` has no non-test caller. The path that actually runs uses the unvalidated `AskQueryInput` | Either route `createAsk` through `parseAskGrammar`, or delete the module. A validation layer nothing calls is worse than none — it reads as protection that is not there |
| D5 | `backend/apps/api/src/domains/graphql/resolvers/AskResolver.ts:586-595` | `askDisclosureHistory` has no client. The owner's only window onto what was disclosed is unreachable | Add an `ASK_DISCLOSURE_HISTORY` document and a History tab on `AsksPage` |
| D6 | `backend/apps/api/src/domains/asks/policy.ts:160` | The `household` half of the sensitive-class exemption is pinned by no test — see the mutation evidence in T1 | ✅ **Fixed.** `policy.spec.ts` → "the household exemption (D6)". Re-running the same mutation (deleting `tier !== 'household'`) now fails **2 tests**, where this document measured 544 passed / 0 failed. The tests are written as a statement of the CURRENT decision, not of its correctness — see [`asks-household-default.md`](asks-household-default.md) |
| D7 | Test infrastructure (`domains/__tests__/support/databaseConnection.ts`) | `databaseAvailability` probes for a *listening port*, not for *applied migrations*. Pointing `ASKS_TEST_DATABASE_URL` at the dev Postgres on `localhost:5432` produces **20 hard failures** (`relation "ci.peer_links" does not exist`), not skips — see §11 | Probe for a sentinel relation (e.g. `to_regclass('ci.ask_grants')`) as well as connectivity, and skip with a reason that names the missing migration |

---

## 11. How this document was verified

- **Read at `fe5075a79`**, in a clean worktree, with `git fetch` current. Every file:line
  cited was read, not recalled.
- **Two mutation experiments**, both reverted, worktree verified clean afterwards:
  - `policy.ts:160`, removing `tier !== 'household'` → `src/domains/asks` +
    `src/domains/graphql`: **544 passed, 10 skipped, 0 failed.** The household exemption is
    unpinned.
  - `PeerAskService.ts:758`, splitting `redacted` out of the `full` branch →
    `src/domains/peers`: **2 failed**, both incidentally, via the fixture default at
    `PeerAskService.spec.ts:22`.
- **Unit suites are green on this branch** (jest, `yarn workspace @ci/be-api test <path>`):
  `src/domains/asks` — 244 passed, 8 skipped, 1 suite skipped;
  `src/domains/peers` — 123 passed, 10 skipped, 1 suite skipped;
  `src/domains/asks` + `src/domains/graphql` — 544 passed, 10 skipped, 2 suites skipped.
  The skipped suites are the DB-backed ones below.
- **The DB-backed suites did not run.** `GrantService.integration.spec.ts`,
  `AskDisclosureCeiling.integration.spec.ts` and `PeerAskLifecycle.integration.spec.ts`
  (20 tests) fail against the dev Postgres because it lacks the asks/peers migrations, and
  no migrated scratch database could be built on this machine (no local pgvector image; the
  registry was unreachable). See D7 — anyone pointing `ASKS_TEST_DATABASE_URL` at the dev
  DB will get 20 red tests unrelated to their change.
- **This PR contains no production code**, so it adds no control and has no mutation test of
  its own. Each proposal above names the test that would pin it.

---

## 12. Decisions the repo owner has to make

None of these are engineering calls.

1. **Should `household` keep the widest ceiling and the sensitive-class exemption?**
   Today a housemate can receive health, financial, location and credential disclosures at
   `full` with no floor, and cannot be demoted. Changing it is one line and breaks no test.
   Keeping it is defensible only if "shares the appliance" is deliberately defined as
   "shares everything" — and if so, that sentence belongs in the product copy, not only in
   a code comment.
2. **Is `household` the right name for "has a local account"?** Portal-brokered principals
   are JIT-provisioned as local users (`JwtOrApiKeyAuthGuard.ts:35`) and therefore receive
   `household`. Whether that is intended depends on Portal-side audience issuance, which is
   outside this repo.
3. **Should the local ask surface be on by default?** `config/default.json:219` says yes.
   The stated reasoning covers federation, not the local no-ceiling tier.
4. **Is free/busy sensitive?** Adding `calendar` to `SENSITIVE_CLASSES` retires the
   agent-to-agent scheduling unlock outright. The recommendation here is to bound the series
   (quantize + budget + visibility) instead — but that is a product judgement about how much
   presence signal a `trusted` peer may accumulate.
5. **Will answers ever be LLM-generated?** If yes, T4 changes from "not present" to
   "central", and the design constraint is fixed now: the asker's own text must never enter
   that context.
6. **Does this feature ship to households where one adult administers the device for
   another?** If yes, T1 needs a safety review by someone who works on intimate-partner
   abuse, not only an engineering review. That is a resourcing decision.
