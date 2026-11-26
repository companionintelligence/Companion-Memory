# LemmaScript proofs

[LemmaScript](https://github.com/midspiral/LemmaScript) proves `//@` contracts written in
ordinary TypeScript. `lsc` translates each function marked `//@ verify` into Dafny, and Dafny
proves the contract. The annotated `.ts` file stays the production code: the annotations are
comments, and nothing here runs in the app.

This directory is a standalone npm project, outside the Yarn workspaces, the same way
`frontend/apps/ios` and `frontend/apps/android` are. `lemmascript` is pinned exactly and the
committed `package-lock.json` pins everything under it.

## What is proved

| File | Functions | Rules |
|---|---|---|
| `backend/apps/api/src/domains/asks/policy.ts` | `rungIndex`, `rungAtLeast`, `minRung`, `narrowestRung`, `narrowerForm`, `rungForForm`, `applyDisclosureCeiling`, `countOnlySummary` | The ladder is a total order. `minRung` and `narrowestRung` are meets: a source that names a ceiling always leaves one at or below it, so a revoked or absent source never widens the result. `narrowerForm` never takes the wider form. `applyDisclosureCeiling` lets through only what each rung allows, never more than the answer it was given, and the same or less at every lower rung. |
| `backend/apps/api/src/domains/asks/grantMatch.ts` | `decideGrant`, `strictestOf`, `grantMatchesQuery`, `classMatchesQuery`, `scopeCoversQuery`, `blockCoversQuery`, `autoGrantNamesQueryClass`, `actorSatisfiesDelegation` | A covering active block always decides `deny`. An `auto` decision names an active auto grant that covers the ask on every field, names the ask's class, and is the strictest such grant. A null data class is a wildcard for a block and never for auto. Anything else is review. |
| `backend/packages/tool-core/src/policy/capabilityPolicy.ts` | `removesData`, `capabilityAllows`, `capabilityRequiredFor` | `capabilityAllows` is monotone over read, write and full, and anything that removes data needs full. `capabilityRequiredFor` names the lowest level that is allowed. |

`evaluateGrant` is a shell around `decideGrant`: it canonicalizes the strings, decides each
grant's liveness against the clock, resolves each ceiling and fixes the id order, none of which
the prover can model (regex, `Date`, `localeCompare`). The property suites test that shell and
the proved functions against the real JavaScript (see below).

No proved function calls a function in another file, so the generated Dafny has no axioms.
Types come from `types.ts` and `core/types.ts` as datatypes. `LemmaScript-files.txt` lists the
proved files. If a proved function starts calling into another file, list that file too and
prove it; otherwise the call becomes an unproved axiom and `dafny audit` fails the check.

`lemmascript.json` sets `unread-annotations` to `error`, so a misspelt annotation stops the run
instead of proving nothing, and `dafny-library` to `local`, so `filter` and `every` use lsc's own
helpers, whose membership facts Dafny proves in the same run.

## Running it

You need Node 22 and Dafny 4.11.0. Dafny comes from the
[release zip](https://github.com/dafny-lang/dafny/releases/tag/v4.11.0): check its sha256
against the digest on the release page, unpack it, and put its `dafny/` directory on PATH (or
point `DAFNY` at the binary).

```bash
cd spec/lemmascript
npm ci --ignore-scripts
npm run check                                              # every listed file, about 20 s
npm run check -- backend/apps/api/src/domains/asks/policy.ts   # one file, repo-relative
```

`check.mjs` fails if Dafny or lsc is missing or the wrong version, if a proved file uses a
`//@` keyword outside its allowlist (no `assume`, `havoc`, `autohavoc`, `extern`, type
overrides or `skip`), if any proof fails or proves nothing, if `dafny audit` reports anything,
and if a generated `.dfy.gen` or `.dfy` differs from what git has. After changing a proved
function, run the check, review the regenerated files and commit them with the change.

## What the proofs assume

- Numbers are mathematical integers. There is no NaN, no Infinity, no -0 and no 2^53 limit.
- Strings are sequences of Unicode scalar values, and `<` on strings compares scalars. JavaScript
  compares UTF-16 code units, which orders an astral character below U+E000 to U+FFFF.
- A string-union type has only its listed members. At runtime a jsonb column can hold anything;
  the code's own fallbacks for that case are not covered.

The property suites (`policy.properties.spec.ts`, `grantMatch.properties.spec.ts` and
`tool-core`'s `capabilityPolicy.properties.test.ts`) check the same contracts against the real
code with seeded inputs, including the values the model leaves out.

## lsc 0.6.14 limits the code works around

- A string-union member named `none` (or `some`) is written as Option's `None` / `Some`. As a
  value that fails to resolve; as a `case` label it becomes a pattern that matches everything.
  The proved files compare with `=== 'none'` and never use the label; `check.mjs` refuses one.
- lsc does not translate a table built at load time (`reduce`), an object constant used as a
  table, an indexed access type such as `(typeof X)[number]`, a constant imported from another
  file, or a type from another file that a proved function only returns. So `rungIndex` spells
  out the ladder, `capability.ts` spells out the `ToolCapability` union, `capabilityPolicy.ts`
  compares with literals, and `GrantDecision` and `GrantEvaluation` live beside `evaluateGrant`.

For the same reasons `disclosureCeiling` (the tier table), `applySearchCeiling` (the share table)
and `clampAvailability` (dates) are tested but not proved.

## Changing a proof

A contract is a rule the owner agreed to. Do not weaken one, delete one, or add an escape hatch
to make a change pass: change the rule with the owner first. When a contract fails, find out
whether the code or the contract is wrong before touching either.
