# Decision: should a housemate keep the widest ceiling by default?

> **This is a product and safety decision, not an engineering one.** It is threat-model §12 decision #1, restated here with the mechanism now built, the options costed, and a recommendation — so that somebody can actually make it.
>
> **Nothing in this document has been decided.** The code ships the status-quo default deliberately; see [What has already changed](#what-has-already-changed).

---

## The question in one line

When someone else on your own appliance asks your Companion a question, should they start with **full access to everything including health, financial, location and credential data** — or with something narrower?

## Why it was not a real question until now

It could not be answered, because it could not be acted on. `AskResolver.resolveTier` was a `return` statement:

```ts
if (ask.peerLinkId == null) {
  return 'household';
}
```

Every local asker resolved to `household`, and `TIER_CEILINGS.household` is `{'*': 'full'}` — the **widest ceiling on the ladder**, and the **only tier exempt from the sensitive-class floor** in `disclosureCeiling`. There was no column, no mutation and no UI that could store anything else. That is **G6** in [`asks-system-guide.md`](asks-system-guide.md) §9 and threat **T1** in [`asks-threat-model.md`](asks-threat-model.md).

## What has already changed

The **mechanism** landed; the **default** did not.

| | Before | Now |
|---|---|---|
| Can a housemate be demoted? | No — nothing could store a tier | Yes — `ci.household_tiers`, `setHouseholdTier` |
| What happens with no setting? | `household` | `household` — **unchanged** |
| Is the exemption pinned by a test? | **No** (threat-model D6: mutation-verified, 544 passed / 0 failed) | Yes — removing `tier !== 'household'` now fails 2 tests |

So every appliance that exists behaves exactly as it did. What changed is that the decision below is now a one-line change with an escape hatch behind it, rather than a rewrite.

---

## Who this actually affects

The threat model is blunt about it, and the sentence is worth reading twice:

> The model it was **not** built against is **asymmetric power between people who know each other.** … There is no concept in this codebase of an asker the owner is afraid of.

Three populations, and they want opposite defaults:

| | What `household = full` gives them | What it costs them |
|---|---|---|
| **A household of equals** — partners, flatmates who set this up together | The feature works instantly with no configuration. This is the F1–F5 use case and the reason the default exists | Nothing they would notice |
| **A household with one administrator** — one adult sets up the appliance for another, a parent for a teenager, an adult child for an aging parent | Convenience for the administrator | The administered person's health, financial, location and credential data is readable by the administrator, automatically, with no record they would think to look at |
| **A household where one person is afraid of another** | — | Everything. The person who shares the appliance is by construction the most privileged asker |

The second row is not an edge case. It is [F8](https://github.com/companionintelligence/CI-Engineering/blob/main/projects/decentralized-trust-graphs/USE-CASES.md) — *"did Dad take his meds / leave the house today?"* — which the use-case catalog calls **"the poster child for scoped grants."** It is a use case we want, and it is the same shape as the risk.

---

## The options

### A. Keep `household` as the default

**For.** The feature works out of the box. A household that set the appliance up together does not have to configure trust before they can ask each other anything. Nothing breaks.

**Against.** The default is the one most people will never change, and it is the widest possible one. "Shares the appliance" silently means "shares everything, including the categories every other tier refuses automatically."

**If chosen:** that sentence belongs in the product copy, not only in a code comment. Right now a user is never told.

### B. Default local askers to `family`

`family` is `{'*': 'full', location: 'redacted'}` and **is** exempt from the sensitive-class floor — so this narrows *location* only.

**For.** One line. Location is the class most associated with the coercion threat, and the one whose disclosure is hardest to notice after the fact.

**Against.** Mostly cosmetic. Health, financial and credential data still flow at `full`.

### C. Default local askers to `trusted`

`trusted` is `{'*': 'redacted', location: 'summary'}` and **is subject** to the sensitive-class floor — so health/financial/location/credentials go to `none`, which routes them to **owner review** rather than refusing them.

**For.** Sensitive data stops being auto-answered to anybody by default. The owner still sees the ask and can answer in one tap; nothing becomes impossible, it becomes *deliberate*. This is what "review is the floor" already means everywhere else in the feature.

**Against.** More taps on day one for a household of equals — until they promote each other, which is now possible. Some F-series use cases (F2 pediatrician notes, F5 vaccines) land in review instead of answering automatically.

### D. Ask at setup

Prompt once, per household member, when a second local account first appears.

**For.** Nobody gets a default they did not choose.

**Against.** A consent question at setup time is answered by whoever is doing the setup — which in the administered-household case is **the person the question is protecting against**. This option is worse than it looks for exactly the population that matters most.

---

## Recommendation

**C, with a promotion path**, and I hold this loosely — it is a judgement about people, not about code.

The argument is not that housemates are dangerous. It is that **`review` is already this feature's stated floor everywhere else**, and `household` is the one place that floor was silently removed. Restoring it makes the default consistent with the design rather than adding a new restriction: the disclosure still happens, the owner still says yes, they just get asked. And a household of equals can promote each other to `household` in one action — which they could not do before this work.

Option D should be rejected outright on the reasoning above, whatever else is chosen.

## What is still missing whichever way this goes

Fixing the default does **not** close T1. Three things it does not touch:

1. **No cooling period.** A tier can be raised and used immediately, so a moment of pressure converts directly into standing access.
2. **No demotion notice.** The demoted party is not told, which is right for safety and means the setting is invisible to the person it is about.
3. **No detection story.** Nothing notices a pattern of asks that looks like monitoring rather than asking. Threat-model §8 covers this; the relationship-fold disclosure view ([#2402](https://github.com/companionintelligence/CI-Server/pull/2402)) is the first surface that could carry one.

And the threat model's own §12 note stands: **if this ships to households where one adult administers the device for another, T1 needs review by somebody who works on intimate-partner abuse, not only an engineering review.** That is a resourcing decision and this document cannot make it either.

## Related

- [`asks-threat-model.md`](asks-threat-model.md) — T1, T6, D6, and §12
- [`asks-system-guide.md`](asks-system-guide.md) §2.5, §2.6, §9 (G6)
- [`USE-CASES.md`](https://github.com/companionintelligence/CI-Engineering/blob/main/projects/decentralized-trust-graphs/USE-CASES.md) §2.1 — F8 is the use case this decision most directly shapes

---

_Written 2026-08-26 alongside the `ci.household_tiers` mechanism. The mechanism is in `main`; the decision is not._
