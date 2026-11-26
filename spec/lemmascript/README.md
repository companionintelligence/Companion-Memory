# LemmaScript proofs

[LemmaScript](https://github.com/midspiral/LemmaScript) proves `//@` contracts written in
ordinary TypeScript. `lsc` translates each function marked `//@ verify` into Dafny, and Dafny
proves the contract. The annotated `.ts` file stays the production code: the annotations are
comments, and nothing here runs in the app.

This directory is a standalone npm project, outside the Yarn workspaces, so the root Yarn PnP
install stays as it is. It is the repo's one exception to using Yarn only, because
CI-Agent-Sync's `lemmascript` toolchain installs lsc with npm. `lemmascript` is pinned exactly,
and the committed `package-lock.json` pins everything it pulls in. Nothing here ships.

## What is proved

| File | Functions | Rules |
|---|---|---|
| `backend/apps/api/src/domains/asks/policy.ts` | `rungIndex`, `rungAtLeast`, `minRung`, `narrowestRung`, `narrowerForm`, `rungForForm`, `applyDisclosureCeiling`, `countOnlySummary` | The ladder is a total order. `minRung` and `narrowestRung` are meets: a source that names a ceiling always leaves one at or below it, so a revoked or absent source never widens the result. Each answer form sits on a fixed rung, and only retrieval reaches one that carries items. `narrowerForm` never takes the wider form. `applyDisclosureCeiling` lets through only what each rung allows, the summary text included (the count sentence at count, Yes or No at boolean, nothing at none). It passes no item, count or withheld count the answer did not carry, and a lower ceiling passes the same or less of each than a higher one. |
| `backend/apps/api/src/domains/asks/grantMatch.ts` | `decideGrant`, `strictestOf`, `grantMatchesQuery`, `classMatchesQuery`, `scopeCoversQuery`, `blockCoversQuery`, `autoGrantNamesQueryClass`, `actorSatisfiesDelegation` | A covering active block always decides `deny`. An `auto` decision names an active auto grant that covers the ask on every field and names the ask's class. A review that names a grant names the strictest matching review grant, or the strictest matching auto grant when no review grant matches. Strictest means the lowest ceiling, then the earliest in id order. A null data class is a wildcard for a block and never for auto. Anything else is review. |
| `backend/packages/tool-core/src/policy/capabilityPolicy.ts` | `removesData`, `capabilityAllows`, `capabilityRequiredFor` | `capabilityAllows` is monotone over read, write and full, and anything that removes data needs full. `capabilityRequiredFor` names the lowest level that is allowed. |

`evaluateGrant` is a shell around `decideGrant`: it canonicalizes the strings, decides each
grant's liveness against the clock, resolves each ceiling and fixes the id order, none of which
the prover can model (regex, `Date`, `localeCompare`). The property suites test that shell and
the proved functions against the real JavaScript (see below).

No proved function calls a function in another file, so the generated Dafny has no axioms. The
proofs also read types from other files: `asks/types.ts`, and tool-core's `capability.ts` and
`core/types.ts`, as datatypes. `LemmaScript-files.txt` lists the proved files. If a proved
function starts calling into another file, list that file too and prove it; otherwise the call
becomes an unproved axiom and `dafny audit` fails the check.

`lemmascript.json` sets `unread-annotations` to `error`, so a misspelt annotation stops the run
instead of proving nothing, `dafny-library` to `local`, so `filter` and `every` use lsc's own
helpers, whose membership facts Dafny proves in the same run, and `run-log` to `false`, so a run
leaves no `.lemmascript/` log behind.

## Running it

You need Node 22 and Dafny 4.11.0. Dafny comes from the
[release zip](https://github.com/dafny-lang/dafny/releases/tag/v4.11.0): check its sha256
against the digest on the release page, unpack it, and put its `dafny/` directory on PATH (or
point `DAFNY` at the binary).

```bash
cd spec/lemmascript
npm ci --ignore-scripts
npm run check                                                  # every listed file, about 20 s
npm run check -- backend/apps/api/src/domains/asks/policy.ts   # one or more files, repo-relative
```

`.agent-configs/specs.toml` registers each proof with this check. CI-Agent-Sync's
`agentctl spec check` looks for `lsc` in the repo root's `node_modules/.bin` and on PATH, not in
this directory, so until it reads an entry's `workdir`, put `spec/lemmascript/node_modules/.bin`
on PATH (with Dafny) before you run it.

## What the check refuses

`check.mjs` fails when:

- Dafny or lsc is missing or not the pinned version;
- `lemmascript.json` is not exactly the reviewed settings above (a `proof-dir`, for one, would
  move the generated files away from where the check reads them);
- `LemmaScript-files.txt` is empty, names a missing file, or has a timeout or flags column;
- a proved file uses a `//@` keyword outside its allowlist: no `assume`, `havoc`, `autohavoc`,
  `extern`, `requires`, type overrides or `skip`. `requires` is out because the proved
  functions are called from unverified code, so nothing checks a precondition, and one that no
  input meets would make every `ensures` vacuous;
- a file that a proved file imports by a relative path, directly or not, carries a `//@`
  annotation without being listed, since lsc reads type overrides from such files;
- any proof fails or proves nothing;
- a `.dfy` is not byte for byte the `.dfy.gen` lsc generated, or includes another file. lsc's own
  check accepts added lines in a `.dfy`, an `include` of a file holding an axiom among them;
- `dafny audit` reports anything;
- a generated `.dfy.gen` or `.dfy` differs from what git has.

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
  out the ladder, `capability.ts` spells out the `ToolCapability` union (the API's
  `toolCoreContract.ts` holds it equal to `TOOL_CAPABILITIES`), `capabilityPolicy.ts` compares
  with literals, and `GrantDecision` and `GrantEvaluation` live beside `evaluateGrant`.
- `lsc check` reads one file argument only, so `check.mjs` runs it once per selected file.

For the same reasons `disclosureCeiling` (the tier table), `applySearchCeiling` (the share table)
and `clampAvailability` (dates) are tested but not proved.

## Changing a proved function

1. Change the `.ts` file, contract and code together.
2. Regenerate its proof from this directory:
   `node_modules/.bin/lsc regen --backend=dafny --config=lemmascript.json ../../<repo-relative path>`.
   No proof here carries hand-written additions, so deleting the `.dfy` and running the check
   does the same.
3. Review the regenerated `.dfy.gen` and `.dfy`, stage them, and run `npm run check`. It fails
   while they differ from what git has.
4. Commit them with the change.

A contract is a rule the owner agreed to. Do not weaken one, delete one, or add an escape hatch
to make a change pass: change the rule with the owner first. When a contract fails, find out
whether the code or the contract is wrong before touching either.

## Not set up yet

- Nothing enforces review of the proof files: the repo has no CODEOWNERS file. Adding one for
  `spec/lemmascript/**`, `*.dfy`, `*.dfy.gen` and `.agent-configs/specs.toml` is the owner's
  call.
- `.github/dependabot.yml` has no version-update entry for this directory. An lsc upgrade can
  change every generated proof, so it is done by hand, with a regeneration of each listed file.
  Whether to add an entry is the owner's call.
