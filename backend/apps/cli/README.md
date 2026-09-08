# `@ci/cli`

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

`ci` — the Companion Intelligence appliance at the command line. Twenty-eight
commands in three groups, over two protocols: the import spine and the
appliance-wide `stats`, `doctor` and `backfill` over REST; `peers`, `grants` and
`asks` over GraphQL.

**The reference is [`docs/cli/ci.md`](../../../docs/cli/ci.md)** — every command,
its flags, and why it behaves the way it does. This file is about the package.

## Running it

```bash
yarn workspace @ci/cli dev datasources
```

| | |
|---|---|
| `yarn dev <args>` | run from source via tsx; no build step |
| `yarn build` | bundle to `dist/ci.cjs` |
| `yarn test` | vitest, 200 tests |
| `yarn typecheck` | `tsc --noEmit` |

Lint and format are the repository's, from the root: this package is covered by
the root `eslint.config.mjs` (unlike `backend/apps/api`, which is listed in that
file's `ignores` and lints itself), so `make lint` reaches it with no per-package
config.

## What this package is for

It is a standalone HTTP client, and that is the whole design:

- **One runtime dependency, `commander`** — and the bundle inlines even that.
  `dist/ci.cjs` requires nothing but Node's built-ins, so it runs from anywhere
  `node` does: `npm i -g @ci/cli`, a vendored copy, a container with no npm.
- **No `@ci/be-api`, no NestJS.** It was `backend/apps/api/src/domains/import/cli`
  until this extraction, which meant getting the binary required compiling the
  entire NestJS application and its ~60 production dependencies — for a tool
  whose job is to send HTTP requests.
- **No `paths` aliases** in `tsconfig.json`, deliberately. An alias would be a
  way for an import back into the server to compile here and fail after install.

Two bins are declared. `ci` is the program. `ci-import` is the name it shipped
under while it was the import domain's command line and nothing else; it is kept
as an alias that prints a deprecation notice **to stderr** — so
`ci-import runs --json | jq` still parses — and then runs the same program.

## Known follow-up: `@ci/api-client`

`src/client.ts` (REST) and `src/graphqlClient.ts` (GraphQL) are hand-written,
and `src/wire.ts` restates the response bodies they read. Those three files
moved across as they were, which was the right size for one change but is not
where they belong: a shared **`@ci/api-client`** under `backend/packages/`,
generated from the OpenAPI and GraphQL schemas the appliance already publishes,
would replace all three and let the web app's existing graphql-codegen setup
generate the GraphQL half outright.

Until then `src/wire.ts` is the seam to watch. It names the route and the server
type behind every block so drift is one `grep` away, and its header states the
tradeoff in full.
