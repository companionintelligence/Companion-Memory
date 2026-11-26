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
| `backend/packages/tool-core/src/policy/capabilityPolicy.ts` | `removesData`, `capabilityAllows`, `capabilityRequiredFor` | `capabilityAllows` is monotone over read, write and full, and anything that removes data needs full. `capabilityRequiredFor` names the lowest level that is allowed. |

No proved function calls a function in another file, so the generated Dafny has no axioms.
Types come from `core/types.ts` and `capability.ts` as datatypes. `LemmaScript-files.txt` lists the
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
npm run check                                              # every listed file
npm run check -- backend/packages/tool-core/src/policy/capabilityPolicy.ts   # one file
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
- A string-union type has only its listed members. At runtime a caller can pass any string;
  the code's own fallbacks for that case are not covered.

The property suite (`tool-core`'s `capabilityPolicy.properties.test.ts`) checks the same
contracts against the real code, including values the model leaves out.

## lsc 0.6.14 limits the code works around

- A string-union member named `none` (or `some`) is written as Option's `None` / `Some`. As a
  value that fails to resolve; as a `case` label it becomes a pattern that matches everything.
  Proved files compare with `=== 'none'` and never use the label; `check.mjs` refuses one.
- lsc does not translate an indexed access type such as `(typeof X)[number]` or a constant
  imported from another file. So `capability.ts` spells out the `ToolCapability` union and
  `capabilityPolicy.ts` compares with literals.

## Changing a proof

A contract is a rule the owner agreed to. Do not weaken one, delete one, or add an escape hatch
to make a change pass: change the rule with the owner first. When a contract fails, find out
whether the code or the contract is wrong before touching either.
