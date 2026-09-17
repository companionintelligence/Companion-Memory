# ARCHITECTURE

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

This document states where code goes and why. It is the normative answer to
"which directory does this belong in", for both the JavaScript and the Python
stack, so the answer stops being folklore that lives in one file's header
comment.

It is deliberately not a design document. For what the system *does* —
domains, data model, data flows — read
[`docs/architecture/architecture.md`](docs/architecture/architecture.md) and
[`backend/apps/api/README.md`](backend/apps/api/README.md). For how to run it,
read [`README.md`](README.md). This file is about the shape of the repository.

Where the layout described here is a target rather than the current state, that
is said explicitly. A layout document that quietly describes an aspiration is
worse than no document, because it makes reviewers enforce a rule that the code
does not follow.

## The layer map

```
backend/apps/<name>        Deployable backend services
backend/packages/<name>    Shared backend libraries
frontend/apps/<name>       Shippable client applications
frontend/packages/<name>   Shared frontend libraries
infrastructure/<name>      Dockerfiles and entrypoints for non-application images
scripts/                   Repo automation (xtask, dev stack, publish, checks, backups)
docs/                      Documentation, runbooks, QA programme, ADRs
tests/                     Root-level Playwright end-to-end tests
```

Everything else at the root is repo-wide configuration: `Makefile` (still the
entry point for every workflow, though three of its targets are now one-line
delegations to `scripts/xtask/` — see [Build and run](#build-and-run)),
`Procfile` (the three host processes `make dev` runs),
`docker-compose.yml` plus its `.local`/`.staging`/`.production`/`.rocm`
overlays, `package.json` and `yarn.lock` for the JS workspace, `pyproject.toml`
and `uv.lock` for the Python workspace, the shared TypeScript presets, the
ESLint and lint-staged configs, and the Playwright configs.

The TypeScript presets are worth naming, because per-project configs used to
hand-copy the same options and drift — `target` was `ES2020` in one place and
`ES2023` in another for no reason anyone could name. `tsconfig.base.json` holds
the settings every project shares; `tsconfig.node.json` extends it with the
Node-side settings (CommonJS, decorator metadata for Nest) that the API,
`scripts/`, and future `backend/packages/*` all need. The root `tsconfig.json`
is not a preset — it type-checks the root-level Playwright and `scripts/` code
and explicitly excludes `backend` and `frontend`. Nothing ever ran it until the
root gained a `typecheck` script; its first run found a real error, which is why
its `target` is now `ES2022` and not `ES2020`.

Today those directories hold:

- `backend/apps/` — `api` (NestJS 11: REST, GraphQL, MCP, jobs, crons),
  `cli` (the `ci` command line — a bundled HTTP client, no NestJS), `hbpe` and
  `summary` (the two Python/FastAPI sidecars).
- `backend/packages/` — `telemetry` (`ci-telemetry`, Sentry wiring shared by
  both sidecars) and `tool-core` (`@ci/tool-core`, the tool/intent vocabulary,
  execution policy and registry, with no NestJS in it).
- `frontend/apps/` — `web` (React 19 / Vite SPA), `ios` and `android`
  (Capacitor shells around the web build, pointed at a remote appliance),
  `desktop` (Tauri local orchestrator), and `mobile`, which is a README
  pointing at `ios` and `android` after the combined Capacitor package was
  split.
- `frontend/packages/` — `common`, `shadcn`, `editor`, `capture`, `template`,
  and the three native plugins `capacitor-local-hub`, `capacitor-local-llm`,
  `capacitor-speech`.
- `infrastructure/` — `database`, `setup-database`, `object-store`, `gateway`,
  `setup-secrets`, `powersync`, `cloudflare`.

### The apps-vs-packages rule

**A deployable thing lives in `<stack>/apps/<name>`. Anything imported by more
than one deployable thing lives in `<stack>/packages/<name>`.** This holds for
both stacks; it is not a Python convention that the JS side happens to echo.

The test for "app" is whether the thing is built, shipped, or run on its own —
a container image, a store submission, an installer, a dev-server process. The
test for "package" is whether it has consumers inside the repo and no
deployment of its own. A package that only ever has one consumer is not yet a
package; leave it inside the app until the second consumer appears, then move
it. Splitting early buys nothing and costs a manifest, a lockfile entry and a
build edge.

The consequence worth stating: **an app never imports another app.** If two
services need the same code, that code moves down into `packages/`. This is why
`ci-telemetry` exists rather than one sidecar importing the other's module.

Both stacks now express this mechanically: the uv workspace members are
`backend/apps/{hbpe,summary}` and `backend/packages/*`, and the Yarn workspace
globs cover `backend/apps/*`, `backend/packages/*`, `frontend/apps/*` and
`frontend/packages/*`. A directory that is not matched by one of those globs is
invisible to `make test`, `make lint` and the dependency graph, which is the
practical reason the rule is worth obeying rather than a matter of taste.

## Naming

JavaScript workspaces are `@ci/`-scoped and private. Apps carry a stack prefix:

| Workspace | Package name |
|---|---|
| `backend/apps/api` | `@ci/be-api` |
| `backend/apps/cli` | `@ci/cli` |
| `backend/packages/tool-core` | `@ci/tool-core` |
| `frontend/apps/web` | `@ci/fe-web` |
| `frontend/apps/ios` | `@ci/fe-ios` |
| `frontend/apps/android` | `@ci/fe-android` |
| `frontend/apps/desktop` | `@ci/fe-desktop` |

Python distributions are named `ci-<name>` and their import package is
`ci.<name>`, a PEP 420 namespace package: `ci-hbpe`/`ci.hbpe`,
`ci-summary`/`ci.summary`, `ci-telemetry`/`ci.telemetry`. Because `ci` is a
namespace nobody owns, **no member may ship a `src/ci/__init__.py`** — adding
one makes every other `ci.*` package unimportable and the failure surfaces as
an unrelated `ImportError`. `scripts/check-ci-namespace.sh` enforces this from
both lint-staged and `make lint`.

Shared packages should carry the same stack prefix as apps do —
`@ci/fe-common`, `@ci/fe-shadcn`, and `@ci/be-*` for anything that lands under
`backend/packages/`. They currently do not: the existing frontend packages are
bare (`@ci/common`, `@ci/shadcn`, `@ci/editor`, `@ci/capture`, `@ci/template`,
`@ci/capacitor-*`). Renaming is mechanical but touches every import site, so
treat the prefix as the rule for **new** packages and rename opportunistically.

`@ci/tool-core` is a knowing exception and the rule is not softened for it: it
should be `@ci/be-tool-core`. The bare name was already written into
`backend/apps/api/tsconfig.json` as the package this repo intended to extract,
and was carried through unchanged rather than diverging from the name the
extraction was planned under. Rename it with the next opportunistic sweep; the
import surface is one specifier in ten files.

One trap, now mostly disarmed. Inside `backend/apps/api`, imports like
`@ci/domains/tools` or `@ci/common/logging` are path aliases into that app's own
`src/`, not workspace packages. That mapping used to be the wildcard
`"@ci/*": ["./src/*"]`, which shadowed the entire `@ci` scope inside the
project: any real workspace package published as `@ci/<something>` resolved to a
non-existent `./src/<something>` and failed with a module-not-found pointing at
the wrong thing. It is now enumerated to the five roots that actually exist
(`common`, `domains`, `application`, `configuration`, `instrument`), leaving the
rest of the scope free for genuine dependencies. Keep that list in sync with the
`moduleNameMapper` in `backend/apps/api/jest.config.mjs`, which mirrors it, and
do not add a workspace package whose name collides with one of those five.

## Module boundaries inside `backend/apps/api`

The API is one deployable, but internally it is 54 directories under
`src/domains/` — `auth`, `import`, `search-next`, `tools`, `mcp`, `peers`, and
so on — 53 of which carry an `index.ts` barrel. One of the 54, `__tests__`, is
shared test machinery rather than a domain; the boundary rules carve it out by
name, because the rule's capture group reads the first path segment and would
otherwise treat it as a domain that every spec reaches into.

[`backend/apps/api/.dependency-cruiser.mjs`](backend/apps/api/.dependency-cruiser.mjs)
holds four rules, all `severity: error`:

- **`no-circular`** — no import cycle anywhere under `src`.
- **`no-cross-domain-internals`** — a file in one domain may import another
  domain only through that domain's `index.ts` or `events.ts`. Reaching at a
  sibling's `services/`, `entities/` or `controllers/` is forbidden.
- **`no-intra-domain-via-barrel`** — inside a domain, import modules directly.
  Going out through your own `index.ts` and back in is what creates the cycles
  the first rule then reports.
- **`no-production-dev-deps`** — nothing under `src/` or `bin/` may import a
  devDependency. `bin/` is included because the production image installs
  production dependencies only and still runs `bin/` code during `yarn migrate`,
  so a devDependency there fails every app install at startup rather than
  merely annoying a linter.

The two directional rules are what make a domain refactorable: the barrel is
the contract, and everything behind it can move without a cross-repo import
sweep.

**The baseline is not clean.**
`backend/apps/api/.dependency-cruiser-known-violations.json` currently holds 42
grandfathered entries — 41 `no-cross-domain-internals` and 1 `no-circular` —
of which 15 come from spec files. `yarn workspace @ci/be-api depcheck` runs
with `--ignore-known`, so those 42 pass silently; only *new* violations fail.
Accepting a new baseline is `yarn workspace @ci/be-api depcheck:accept`, which
should be a deliberate, reviewed act, not a way to get a branch green. The
number above is the target to drive to zero, and it is the honest measure of
how far the barrel discipline actually reaches today.

Note also where that check runs: `depcheck` is a step in `ci.yml`, which is
dispatch-only (see [CI reality](#ci-reality)). It is not part of `make lint`
and not part of the pull-request gate.

## Three frontends over one core

The API exposes the same underlying capabilities through three surfaces:

- **REST and GraphQL** — the primary surface. NestJS controllers under
  `/api/*`, Apollo at `/graphql`. This is what the web SPA, the mobile shells
  and the browser extension talk to.
- **MCP** — `backend/apps/api/src/domains/mcp`, a `@Controller('mcp')` with a
  `POST` for requests and a `GET` for the event stream, so an external model
  host can discover and call the same capabilities.
- **CLI** — `backend/apps/cli` (`@ci/cli`), published as the `ci` bin. It was
  `backend/apps/api/src/domains/import/cli`, shipping as a bin from
  `@ci/be-api`, until it was extracted: a private package with ~60 production
  dependencies is not a way to distribute a command-line tool, and the tool had
  outgrown the domain it lived in anyway.

The capability core is `domains/tools`, and its framework-free half is now
`backend/packages/tool-core` (`@ci/tool-core`). Every tool is also an intent: a
tool class declares its `IntentDefinition` (dotted name, domain, privacy label,
natural-language phrases, parameters) inline beside its implementation, with no
separate catalog to drift. `ToolRegistryCore` holds every tool from every
provider and is the single execution entry point; `IntentCatalogService` is the
read API over the catalog; `@ci/tool-core`'s policy holds one implementation of
"may this caller run this intent, here?" (`capabilityAllows`, `resolveDispatch`,
`resolveToolGate`) that every dispatcher is meant to share.

**What is in the package and what is not.** The package holds the vocabulary
(`IntentDefinition`, `JSONSchema`, `ToolResult`, `ToolInvocationContext`), the
policy, the registry, and the shape of a `tool.invoked` ledger row. It imports
no `@nestjs/*` and has no runtime dependencies; its tsconfig turns decorator
support off so that stays true by construction. The 33 native tools stay in the
API — each is a thin wrapper over another domain's services — along with
`BaseTool`, `ci.pending_actions`, `IntentCatalogService` and every module,
controller and entity. `domains/tools` keeps re-export shims so its public
barrel exports the same names from the same place it always did, and
`registry/ToolRegistry.ts` is now a `@Injectable()` subclass that supplies the
core's three seams: a logger, a `ToolInvocationSink` (this appliance sends
`tool.invoked` on the `telemetry` queue) and a `ToolGate` (`PendingActionService`).

The package restates three types the API owns — `ApiKeyCapability`,
`RequestContext`, `PersonalizationDecision` — because each arrives with Nest
attached. That is a real cost, and it is paid with compile-time assertions in
`domains/tools/toolCoreContract.ts` and `domains/tools/policy/toolGate.ts`
rather than with a comment: one of the three is a security vocabulary, and two
copies of a security rule are two rules.

**The target** is that these three are thin transports over that core: a
transport parses its own protocol, resolves a caller, and hands the intent to
`ToolRegistry`. Adding a capability then means adding a tool, once, and all
three surfaces gain it.

**Today is partway there.** Three things are worth knowing before you plan work
against this:

1. MCP has two planes. Native intents execute through `ToolRegistry`, but a
   second plane synthesizes tools from the GraphQL schema
   (`mcp/services/GraphQLToolAdapter.ts`) and executes them through the GraphQL
   executor — that plane never touches `ToolRegistry`, and so does not share
   its policy or its invocation ledger.
2. The CLI is not a transport over the core at all. It is an HTTP client of the
   REST and GraphQL surfaces. Its own source says so, and argues the position:
   an HTTP client is entitled to the response body, not to the server's internal
   types. It has at least stopped contradicting itself — it lived inside
   `domains/import` and reached into three sibling domains for their types until
   it was extracted to `backend/apps/cli`, and now restates the response shapes
   it reads in `src/wire.ts`. The remaining copy is a known cost, and the
   follow-up that removes it is a shared `@ci/api-client` under
   `backend/packages/` generated from the published schemas.
3. `domains/tools` still sits *above* the domains, not below them.
   `ToolsModule` imports fifteen other domain modules to construct the native
   tools; that is a composition root, not a shared kernel, and one of those
   edges already had to be worked around by providing `PersonalizationService`
   directly rather than importing its module, because the module edge would have
   closed a cycle. What changed is that "the core" is no longer only that
   composition root: the rules underneath it — vocabulary, policy, registry —
   are `@ci/tool-core`, which sits below everything and depends on nothing, so a
   lower layer *can* now depend on them. The composition root above it is what
   still cannot be depended on.

Directionally: move CLI commands onto intents — `@ci/cli` can now depend on
`@ci/tool-core` for the vocabulary and the policy without acquiring NestJS, which
is what makes that move affordable — collapse the GraphQL MCP plane into the
registry so policy and ledgering apply uniformly, and keep new capabilities
arriving as tools rather than as one-off controllers.

Note also what the package is not yet: a shared library with a second consumer.
`@ci/be-api` is its only importer today. It is the one place in this repo where
the [apps-vs-packages rule](#the-apps-vs-packages-rule)'s "wait for the second
consumer" clause was knowingly spent in advance, because the second and third
consumers (MCP over a non-Nest host, the CLI) are the point of the extraction
rather than a hoped-for use — and because the boundary it draws is a security
boundary that was worth making unambiguous whether or not anyone else crosses
it.

## Build and run

`make` is still the entry point and `make help` still lists every target with
its description. What changed is what sits behind three of them — `build`, `dev`
and `test` are now one-line delegations to **xtask**,
a TypeScript program under `scripts/xtask/` run through `tsx`:

```make
build:
	@yarn tsx scripts/xtask/index.ts build --env $(ENV) --gpu $(GPU) $(if $(DRY_RUN),--dry-run) $(IMAGE)
```

The Makefile keeps the interface, xtask holds the logic, and the other
forty-odd targets are untouched.

Those three were ported for what they had grown into: GPU auto-detection, an
`ENV`-gated ordered set of images, a `ci.source-tree` comparison against the
images already on the box, a lockfile freshness gate. In a Make recipe each of
those is shell with `$$` on every variable and a process per line, with no way
to unit-test it and no way to ask what it would do without doing it. As a
program they get `--help` per subcommand, real argument validation, and a unit
suite (`scripts/xtask/**/*.test.ts`, run by `tsx --test`) over the parts worth
pinning: the build plan, GPU detection and the HBPE wheel-tag derivation, the
`REPO`/`PROJECT_NAME` formula, image tagging, the uv pin. The root
`package.json` now declares `test` and `typecheck` scripts, so that suite is
reached by `make test` (the root is a workspace, and `make test` is
`yarn workspaces foreach --all`) and the code is typechecked by `make
typecheck` / `yarn typecheck` — locally only; the CI lane that used to run
this on every PR (`pr-gate.yml`'s `Type check packages`) was deleted along
with the rest of that file, and it had no twin in `ci.yml`.

Where the logic lives:

```
scripts/xtask/index.ts         Subcommand dispatch, --help, signal handling
scripts/xtask/commands/*.ts    build, dev, test, lint, format, reset
scripts/xtask/lib/exec.ts      run() (fail-fast) and tryRun() (tolerant)
scripts/xtask/lib/gpu.ts       GPU detection, HBPE wheel tags and build args
scripts/xtask/lib/images.ts    Image repo names, TAG tagging, the ci.source-tree stamp
scripts/xtask/lib/identity.ts  REPO / PROJECT_NAME derivation
scripts/xtask/lib/uv.ts        The uv pin, read from pyproject.toml
```

**`health` was deliberately not ported**, and the reason is the rule to apply
before anyone ports a seventh target: **a prerequisite checker must not require
the prerequisites.** `health` is the thing that tells you node is missing or
yarn is the wrong version; routed through `yarn tsx` it fails on a checkout that
has not run `make install` with a raw yarn error instead of the diagnostic it
exists to print. It stays pure shell in the Makefile, and `xtask dev` shells out
to `make health` exactly as the original recipe's `$(MAKE) health` line did.

`distribute-license` and `clean-license` stayed shell for a different reason:
they are public targets with callers outside the Makefile —
`.github/workflows/e2e.yml`, `video/stage.sh`, `video/stage.real-corpus.sh` and
`video/README.md` all invoke `make distribute-license` — so they have to keep
existing, and `xtask build` calls back into them rather than carrying a second
copy of the copy loop. Four pins stay in the Makefile byte-identical on the same
principle: `FLASH_ATTN_VERSION`, `LLAMA_CPP_PYTHON_REF`,
`LLAMA_CPP_PYTHON_VERSION` and `AMDGPU_WHEEL_TARGETS` are `sed`'d out by name by
the three `backend/apps/hbpe/build-*-wheel.sh` scripts, so `lib/gpu.ts` reads
them back out of the Makefile's text instead of restating them.

The targets themselves:

**`make install`** — authenticates to the GitHub npm registry
(`scripts/gh-packages-auth.sh --install`) and syncs the Python workspace with
`uv sync --all-packages`. `make init` is the fuller first-checkout path:
corepack activation pinned to `packageManager`, the Yarn VSCode SDKs,
`yarn prepare`, `uv sync --all-packages`, and copying `.env.default` to `.env`.

**`make dev`** — runs `make health` first (node matching `.nvmrc`, yarn matching
`packageManager`, `uv` present; any mismatch exits 1), then hard-fails unless
`overmind` and `caddy` are installed with Caddy's admin API live on `:2019` and
`ollama` answering on `:11434`, pulling any missing Ollama model rather than
telling you to. It builds the local images only if one is missing, a sidecar
image's `ci.source-tree` label says it was built from other source, or
`REBUILD=1` is set, then hands off to `scripts/dev-stack/index.ts up`, which
allocates ports, brings up the Compose stack, runs migrations, registers a Caddy
route at `https://<project>.localhost`, and runs the `Procfile` under overmind.
The Procfile is three processes: `api` (`CI_ROLE=web`), `worker`
(`CI_ROLE=worker`), and `web` (the Vite dev server). Ctrl-C tears the route down.

Because ports are allocated per worktree, several worktrees can run full stacks
at once — which is the reason the dev stack is a supervisor script and not a
static compose invocation.

**`make build`** — `ENV=local|staging|production` (default `local`),
`GPU=cpu|cuda|rocm` (auto-detected). It validates both, reads the uv pin from
`required-version` in `pyproject.toml` and passes it to the Dockerfiles as
`UV_VERSION`, and runs `uv lock --check` before building anything, so a stale
resolution fails fast instead of being baked into an image. The API, gateway
and web images are built only when `ENV` is not `local` (locally those run as
host processes under overmind); the database, setup-database, object-store,
summary and HBPE images are always built, and setup-secrets only for
`production`.

Two things it could not do before. **`IMAGE=<name>`** builds exactly that one
image and ignores the `ENV` gate — one of `api`, `gateway`, `setup-database`,
`database`, `object-store`, `setup-secrets`, `summary`, `hbpe` — instead of the
old all-or-nothing recipe. **`DRY_RUN=1`** prints the exact `docker build`
command lines, every `--build-arg` and — on a CUDA or ROCm host — the composed
GHCR wheel-image tags
included, and returns without touching Docker or uv. Both are ordinary
arguments to the program underneath, so
`yarn tsx scripts/xtask/index.ts build hbpe --dry-run` is the same thing.

**`make test`** — `yarn workspaces foreach --all run test`, then `uv run pytest`.
The `foreach` only runs workspaces that declare a `test` script, so a new
workspace's tests are picked up without editing the Makefile — which is another
reason to keep new code inside a workspace glob. The repo root is one of those
workspaces now that it declares a `test` script, which is how the xtask suite
is reached.

**`make lint`** — `yarn lint` (oxlint then ESLint) and `yarn format:check`
(Prettier), then `uv run ruff check .`, `uv run ruff format --check .`,
`uv run mypy`, `uv lock --check`, `scripts/check-ci-namespace.sh` and
`scripts/check-capacitor-native-sync.mjs`. `make format` is the writing half.

### One lockfile per stack

There is exactly one `uv.lock`, at the repository root, covering every Python
member (`backend/apps/hbpe`, `backend/apps/summary`, `backend/packages/*`).
Never resolve a conflict in it by hand: `scripts/merge-uv-lock.sh` is registered
as a git merge driver by `yarn prepare` and keeps one side automatically; run
`uv lock` afterwards to reconcile. A forgotten relock is caught by
`uv lock --check` in both `make lint` and `make build`.

Ruff, mypy and pytest are configured once in the root `pyproject.toml` for the
whole workspace, so members declare no linters of their own. New members are
strict under mypy by default; the two services predating the workspace sit in
an explicitly-labelled quarantine that is meant to shrink, not to grow.

### The Yarn workspace, and what is deliberately outside it

The root globs are:

```
backend/apps/*
backend/packages/*
frontend/apps/*
frontend/packages/*
!frontend/apps/ios
!frontend/apps/android
!frontend/apps/desktop
```

The root install uses Yarn PnP (`nodeLinker: pnp`). The three exclusions are
not oversights, and they have two different reasons:

- **`ios` and `android`** — the Capacitor CLI, CocoaPods and Gradle all walk a
  real `node_modules` tree to discover plugin native code during `cap sync`.
  PnP produces no such tree. Each app overrides `nodeLinker: node-modules` in
  its own `.yarnrc.yml` so the tree is materialized *there only*, leaving the
  root install on PnP. Install and run from inside each app's directory; a root
  install will not materialize them, and "fixing" the exclusion breaks the
  native builds.
- **`desktop`** — a different problem with the same fix. `@tauri-apps/cli`
  ships prebuilt binaries as platform-specific `optionalDependencies`, a package
  shape with a history of PnP edge cases. Because the desktop app has no
  cross-workspace dependency on anything in the monorepo — it is a local
  orchestrator that starts the shipped Compose stack and shows the real web UI
  served by the `gateway` container — keeping it fully standalone, with its own
  `yarn.lock`, costs nothing.

`scripts/check-capacitor-native-sync.mjs` runs in `make lint` and in lint-staged
precisely because those three trees are outside the normal install: nothing else
would notice them drifting.

## CI reality

**Nothing in this repository gates a merge.** `main` carries no
`required_status_checks` block and `required_approving_review_count: 0`, so a
red check blocks nothing on its own. Treat every check here as advisory until
someone with admin adds contexts to branch protection.

Most workflows do not run automatically either. GitHub Actions was costing the
org roughly $563/month, almost all of it hosted compute for checks that run just
as well on hardware the org already owns, so the workflows were gated to manual
dispatch. Start one with:

```bash
gh workflow run <file> --ref <branch-or-tag>
```

`--ref` matters: the workflow file is read from that branch, so a workflow that
only exists on your branch must be dispatched against it.

Of the thirteen workflow files in `.github/workflows/`, all thirteen are
`workflow_dispatch`-only as of 2026-09-17: `ci.yml`, `codeql.yml`,
`consent-path-gate.yml`, `desktop-build.yml`, `desktop-e2e.yml`, `e2e.yml`,
`migration-integrity-check.yml`, `mobile-build.yml`, `publish.yml`,
`style-canon-lint.yml`, `benchmark-unit.yml`, `mobile-release.yml`,
`desktop-release.yml`. For those, an absent check means nobody dispatched it —
not that anything passed.

Until 2026-09-17, four of them had automatic triggers instead:

- **`pr-gate.yml`** — the one thing that ran on every pull request to `main`.
  Lint (four lanes) and typecheck (two lanes), and nothing else; the unit-test
  and Python lanes stayed on dispatch because they were the expensive half.
  **Deleted** 2026-09-17 to cut the GitHub Actions bill, along with the six
  required status checks its lint/typecheck jobs used to produce — nothing
  gates a merge now, automatically or by review.
- **`benchmark-unit.yml`** — pull request and push to `main`, path-filtered to
  `scripts/benchmark/**`. Ran pytest and, later, a pinned ruff. Gated to
  `workflow_dispatch`-only the same day.
- **`mobile-release.yml`** — push of an `ios-v*`, `android-v*` or
  `mobile-release-v*` tag; TestFlight and Play internal. Gated the same day —
  a tag push now only names the version, dispatch the workflow on it to
  actually submit.
- **`desktop-release.yml`** — push of a `desktop-v*` tag. Gated the same day,
  same story as above.

`codeql.yml` is gated for a different, older reason: the scan completes and the
SARIF upload is then rejected because this private repository has no GitHub
Code Security. Restore its push/PR triggers only after that is enabled.

Full table and per-workflow commands: [`docs/CI.md`](docs/CI.md). The release
QA programme, the measured defect baseline, and the proposal for the minimum
gate worth turning on: [`docs/qa/`](docs/qa/README.md).

## Adding something new

- **A new backend service** — `backend/apps/<name>`. Python: distribution
  `ci-<name>`, import package `ci.<name>`, add it to `[tool.uv.workspace]
  members` and to the mypy `packages` list, no `src/ci/__init__.py`. TypeScript:
  package name `@ci/be-<name>`; it is already covered by the `backend/apps/*`
  glob.
- **A new shared library** — `<stack>/packages/<name>`, only once it has a
  second consumer. Python members under `backend/packages/*` are already
  covered by the uv workspace glob and are checked strictly by mypy. A
  TypeScript member needs three things there, and the first is the one that
  bites:
  - **An entry in `[tool.uv.workspace] exclude` in the root `pyproject.toml`.**
    `backend/packages/` is a mixed-language directory and the uv `members` glob
    is `backend/packages/*`, so a member with no `pyproject.toml` does not get
    ignored — uv fails the whole workspace with `missing a pyproject.toml`. That
    takes out `uv sync --all-packages --locked`, and with it `make install`,
    `make lint` and `ci.yml`'s `python` lane, none of them anywhere near the
    JavaScript change that caused it.
  - A `tsconfig.json` with `composite: true` and a `references` entry from each
    consumer, or its sources are pulled into the consumer's own program and move
    where that consumer's `dist/` lands. `@ci/tool-core` is the worked example.
  - Three lines in any image that ships a consumer — see
    `backend/apps/api/Dockerfile`: the manifest before `yarn workspaces focus`,
    the sources into the builder, the built `dist` into the runtime stage.
- **A new capability in the API** — a tool in `domains/tools`, so all three
  surfaces get it, rather than a controller on one of them.
- **A new API domain** — a directory under `src/domains/` with an `index.ts`
  barrel that exports exactly what other domains may use, and nothing else.
  Run `yarn workspace @ci/be-api depcheck` before opening the PR; the
  pull-request gate does not run it for you.
- **A new database migration** — always via
  `yarn workspace @ci/be-api migrate:make <name>`, never by hand-writing the
  timestamp prefix. dbmate keys `schema_migrations` on that prefix and
  hand-picked round timestamps have collided across parallel branches.
